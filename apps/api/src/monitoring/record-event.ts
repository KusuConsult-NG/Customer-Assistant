/**
 * Record a SystemEvent from a shell script on the server (backup.sh), inside
 * the api container:
 *   node apps/api/dist/monitoring/record-event.js backup ok '{"offsite":true}'
 * Exits 0 even when it cannot record: a backup is never failed by its report.
 */
import { recordSystemEvent, type SystemEventKind } from './system-events';

async function main() {
  const [kind, status, json] = process.argv.slice(2);
  if (!['backup', 'external_check'].includes(kind) || !status) {
    console.error('usage: record-event.js backup|external_check <status> [json-detail]');
    process.exit(0);
  }
  let detail: Record<string, unknown> | undefined;
  try {
    detail = json ? JSON.parse(json) : undefined;
  } catch {
    detail = { raw: String(json).slice(0, 200) };
  }
  const ok = await recordSystemEvent(kind as SystemEventKind, status, detail);
  if (!ok) console.error('the event could not be recorded');
  const { prisma } = await import('@ace/database');
  await prisma.$disconnect().catch(() => undefined);
}

if (require.main === module) void main().then(() => process.exit(0));
