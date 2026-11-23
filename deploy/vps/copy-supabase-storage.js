#!/usr/bin/env node
// Copy every object in the platform's Supabase Storage buckets into STORAGE_DIR,
// in the layout the `local` storage driver reads (apps/api/src/common/object-storage.ts):
//   <STORAGE_DIR>/<bucket>/<org>/<file>  +  <file>.meta.json {mimeType, fileName}
//
//   node copy-supabase-storage.js            report: what would be copied
//   node copy-supabase-storage.js --apply    copy (skips files already copied with the same size)
//
// Reads SOURCE_SUPABASE_URL, SOURCE_SUPABASE_SERVICE_ROLE_KEY and STORAGE_DIR
// from the environment. Never deletes anything on either side.
const fs = require('fs');
const path = require('path');

const BUCKETS = ['knowledge-documents', 'onboarding-selfies'];
const SAFE = /^[A-Za-z0-9._-]+$/;
const apply = process.argv.includes('--apply');
const base = (process.env.SOURCE_SUPABASE_URL || '').replace(/\/+$/, '');
const key = process.env.SOURCE_SUPABASE_SERVICE_ROLE_KEY || '';
const root = process.env.STORAGE_DIR || '';
if (!base || !key || !root) {
  console.error('Set SOURCE_SUPABASE_URL, SOURCE_SUPABASE_SERVICE_ROLE_KEY and STORAGE_DIR.');
  process.exit(2);
}
const headers = { Authorization: `Bearer ${key}`, apikey: key };

async function list(bucket, prefix) {
  const out = [];
  for (let offset = 0; ; offset += 100) {
    const res = await fetch(`${base}/storage/v1/object/list/${bucket}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix, limit: 100, offset, sortBy: { column: 'name', order: 'asc' } }),
    });
    if (!res.ok) throw new Error(`list ${bucket}/${prefix}: HTTP ${res.status} ${await res.text()}`);
    const page = await res.json();
    out.push(...page);
    if (page.length < 100) return out;
  }
}

(async () => {
  let total = 0, copied = 0, skipped = 0, bytes = 0;
  const problems = [];
  for (const bucket of BUCKETS) {
    // Top level: one folder per agency (id null = folder), files beneath.
    for (const folder of await list(bucket, '')) {
      if (folder.id) { problems.push(`${bucket}/${folder.name}: a file at the top level; nothing refers to it this way`); continue; }
      for (const obj of await list(bucket, folder.name)) {
        if (!obj.id) { problems.push(`${bucket}/${folder.name}/${obj.name}/: nested folder, not copied`); continue; }
        total++;
        const rel = `${folder.name}/${obj.name}`;
        if (!SAFE.test(folder.name) || !SAFE.test(obj.name)) { problems.push(`${bucket}/${rel}: name the local driver cannot serve`); continue; }
        const size = Number(obj.metadata?.size ?? 0);
        const target = path.join(root, bucket, folder.name, obj.name);
        if (fs.existsSync(target) && fs.statSync(target).size === size) { skipped++; continue; }
        bytes += size;
        if (!apply) { console.log(`  would copy ${bucket}/${rel} (${size} bytes)`); continue; }
        const res = await fetch(`${base}/storage/v1/object/${bucket}/${rel}`, { headers });
        if (!res.ok) { problems.push(`${bucket}/${rel}: download HTTP ${res.status}`); continue; }
        const buf = Buffer.from(await res.arrayBuffer());
        if (size && buf.length !== size) { problems.push(`${bucket}/${rel}: got ${buf.length} bytes, expected ${size}`); continue; }
        // Citizens' photographs and agency documents: owner and group only,
        // whatever umask the shell running this happens to have.
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o750 });
        fs.writeFileSync(`${target}.tmp`, buf, { mode: 0o640 });
        fs.renameSync(`${target}.tmp`, target);
        const fileName = obj.name.replace(/^\d+_/, '');
        fs.writeFileSync(`${target}.meta.json`, JSON.stringify({ mimeType: obj.metadata?.mimetype || 'application/octet-stream', fileName }), { mode: 0o640 });
        copied++;
      }
    }
  }
  console.log(`\n${apply ? 'Copied' : 'Would copy'} ${apply ? copied : total - skipped} of ${total} files (${(bytes / 1024).toFixed(0)} KB); ${skipped} already here.`);
  for (const p of problems) console.log(`  PROBLEM ${p}`);
  if (!apply) console.log('\nNothing was written. Re-run with --apply to copy.');
  process.exit(problems.length ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(1); });
