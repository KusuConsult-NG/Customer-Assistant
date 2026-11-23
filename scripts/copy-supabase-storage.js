#!/usr/bin/env node
/**
 * Copy every uploaded file out of Supabase Storage onto this server's disk.
 *
 *   node scripts/copy-supabase-storage.js          # report what would be copied
 *   node scripts/copy-supabase-storage.js --apply  # copy it
 *
 * Reads from SOURCE_SUPABASE_URL / SOURCE_SUPABASE_SERVICE_ROLE_KEY (the OLD
 * project — named differently from SUPABASE_URL on purpose, so setting them
 * cannot switch where the API stores new uploads) and writes into STORAGE_DIR
 * in exactly the layout the API uses, through the API's own writeLocalObject.
 *
 * Read-only on Supabase: nothing there is changed or deleted. Safe to re-run:
 * a file already on disk at the same size is skipped, so a run interrupted
 * half-way is finished by running it again.
 *
 * It ends by checking every database row that points at a stored file — each
 * knowledge document and each selfie — and lists any that still has no file
 * here, because "copied 412 files" says nothing about whether the 413th, the
 * one a document needs, was among them.
 */

const path = require('path');
require(path.join(__dirname, '..', 'apps', 'api', 'dist', 'config', 'load-env.js'));
const storage = require(path.join(__dirname, '..', 'apps', 'api', 'dist', 'common', 'object-storage.js'));

const apply = process.argv.includes('--apply');
const url = (process.env.SOURCE_SUPABASE_URL || '').replace(/\/+$/, '');
const key = process.env.SOURCE_SUPABASE_SERVICE_ROLE_KEY || '';
const BUCKETS = [storage.KNOWLEDGE_BUCKET, storage.SELFIE_BUCKET];

function fail(msg) {
  console.error(`\n${msg}\n`);
  process.exit(2);
}

if (!url || !key) fail('SOURCE_SUPABASE_URL and SOURCE_SUPABASE_SERVICE_ROLE_KEY must both be set (the old project).');
if (!process.env.STORAGE_DIR) fail('STORAGE_DIR is not set: there is nowhere on this server to copy the files to.');

const headers = { Authorization: `Bearer ${key}`, apikey: key };

/** Every object in a bucket, depth first. Folders come back with a null id. */
async function listAll(bucket, prefix = '') {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const res = await fetch(`${url}/storage/v1/object/list/${bucket}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } }),
    });
    if (res.status === 400 || res.status === 404) {
      const body = await res.text();
      if (/not found/i.test(body)) return out; // the bucket was never created: nothing to copy
      throw new Error(`listing ${bucket}/${prefix}: HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    if (!res.ok) throw new Error(`listing ${bucket}/${prefix}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const page = await res.json();
    for (const entry of page) {
      const full = `${prefix}${entry.name}`;
      if (entry.id === null || entry.id === undefined) out.push(...(await listAll(bucket, `${full}/`)));
      else out.push({ path: full, size: entry.metadata?.size ?? null, mimeType: entry.metadata?.mimetype || 'application/octet-stream' });
    }
    if (page.length < 1000) return out;
  }
}

async function download(bucket, objectPath) {
  const res = await fetch(`${url}/storage/v1/object/${bucket}/${objectPath.split('/').map(encodeURIComponent).join('/')}`, {
    headers,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  console.log(`\nCopying uploaded files from ${url} to ${process.env.STORAGE_DIR}${apply ? '' : '  (REPORT ONLY — add --apply to copy)'}\n`);
  let failures = 0;

  for (const bucket of BUCKETS) {
    const objects = await listAll(bucket);
    let present = 0;
    let copied = 0;
    let wouldCopy = 0;
    for (const o of objects) {
      const have = storage.localObjectSize(bucket, o.path);
      if (have !== null && (o.size === null || have === o.size)) {
        present++;
        continue;
      }
      if (!apply) {
        wouldCopy++;
        continue;
      }
      try {
        const bytes = await download(bucket, o.path);
        if (o.size !== null && bytes.length !== o.size) {
          throw new Error(`received ${bytes.length} bytes, Supabase lists ${o.size}`);
        }
        storage.writeLocalObject(bucket, o.path, bytes, o.mimeType);
        copied++;
      } catch (e) {
        failures++;
        console.log(`  FAILED  ${bucket}/${o.path}: ${e.message}`);
      }
    }
    console.log(
      `${bucket}: ${objects.length} in Supabase, ${present} already here` +
        (apply ? `, ${copied} copied` : `, ${wouldCopy} to copy`)
    );
  }

  // Every row that names a stored file must now have it. Before the rows
  // themselves have been moved (the report run) there is nothing to check.
  const { prisma } = require('@ace/database');
  let docs;
  let selfies;
  try {
    docs = await prisma.knowledgeDocument.findMany({ select: { id: true, storageUrl: true } });
    selfies = await prisma.selfieRequest.findMany({ where: { storagePath: { not: null } }, select: { id: true, storagePath: true } });
  } catch (e) {
    await prisma.$disconnect().catch(() => {});
    console.log(`\nDatabase rows not checked (${String(e.message).split('\n')[0].slice(0, 160)}).`);
    if (!apply) console.log('\nNothing was copied. Run again with --apply.');
    process.exit(failures > 0 ? 1 : 0);
  }
  const refs = [
    ...docs
      .filter((d) => d.storageUrl && !/^https?:\/\//i.test(d.storageUrl))
      .map((d) => ({ what: 'knowledge document', id: d.id, bucket: storage.KNOWLEDGE_BUCKET, p: d.storageUrl })),
    ...selfies.map((s) => ({ what: 'selfie', id: s.id, bucket: storage.SELFIE_BUCKET, p: s.storagePath })),
  ];
  const missing = refs.filter((r) => storage.localObjectSize(r.bucket, r.p) === null);
  await prisma.$disconnect();

  console.log(`\nRows that point at a stored file: ${refs.length}; with the file on this server: ${refs.length - missing.length}`);
  for (const m of missing.slice(0, 25)) console.log(`  MISSING ${m.what} ${m.id}`);
  if (missing.length > 25) console.log(`  … and ${missing.length - 25} more`);
  if (missing.length && apply) {
    console.log(
      '\nA row whose file is missing was not in Supabase either (an upload the old fallback wrote to a\n' +
        'container disk, since wiped). Those documents must be uploaded again; their rows are unchanged.'
    );
  }
  if (!apply) console.log('\nNothing was copied. Run again with --apply.');
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(`\n${e.message}\n`);
  process.exit(1);
});
