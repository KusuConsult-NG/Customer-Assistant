/**
 * The mocks have to cover what the orchestrator actually imports.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * These suites replace `@ace/database` wholesale, listing the real modules to
 * pull in by hand. When the orchestrator starts importing something from a
 * module nobody added to that list, the import is simply `undefined` — and the
 * orchestrator catches the resulting TypeError and falls back, so the failure
 * arrives as "expected FLOW_COLLECTING, received BOOK_APPOINTMENT" in a dozen
 * booking tests at once. Nothing says "missing import".
 *
 * That has now happened twice. `serviceHoursFrom` was the first (its note is
 * in CLAUDE.md); `ensureContactForPhone` moving to its own module was the
 * second. Both times the cost was in reading flow logic that was perfectly
 * fine.
 *
 * So this compares the two lists directly and names the gap.
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..', 'src');
const TEST_DIR = __dirname;
const DB_SRC = join(__dirname, '..', '..', 'database', 'src');

/** Every name the orchestrator imports from `@ace/database`. */
function orchestratorImports(): string[] {
  const src = readFileSync(join(SRC, 'index.ts'), 'utf8');
  // `[^}]*`, not `[\s\S]*?`: a lazy match still happily runs from an EARLIER
  // import's opening brace to this one's closing brace, and then reports that
  // import's names as missing here.
  const m = src.match(/import\s*\{([^}]*)\}\s*from\s*'@ace\/database'/);
  if (!m) throw new Error("packages/orchestrator/src/index.ts no longer imports from '@ace/database'");
  return m[1]
    .split(',')
    .map((part) => part.trim().split(/\s+as\s+/)[0].trim())
    .filter(Boolean);
}

/** The names a database module exports. */
function exportsOf(moduleFile: string): string[] {
  let src: string;
  try {
    src = readFileSync(join(DB_SRC, `${moduleFile}.ts`), 'utf8');
  } catch {
    return [];
  }
  const names = new Set<string>();
  for (const re of [
    /export\s+(?:async\s+)?function\s+(\w+)/g,
    /export\s+(?:const|let|class|type|interface|enum)\s+(\w+)/g,
  ]) {
    let hit: RegExpExecArray | null;
    while ((hit = re.exec(src))) names.add(hit[1]);
  }
  return [...names];
}

/** What one spec's `jest.mock('@ace/database', …)` factory provides. */
function mockProvides(specFile: string): { found: boolean; names: Set<string> } {
  const src = readFileSync(join(TEST_DIR, specFile), 'utf8');
  const factory = src.match(/jest\.mock\('@ace\/database',\s*\(\)\s*=>\s*\(\{([\s\S]*?)\}\)\);/);
  if (!factory) return { found: false, names: new Set() };

  const names = new Set<string>();
  const body = factory[1];

  // ...jest.requireActual('../../database/src/<module>')
  const spread = /requireActual\('\.\.\/\.\.\/database\/src\/([\w-]+)'\)/g;
  let hit: RegExpExecArray | null;
  while ((hit = spread.exec(body))) for (const name of exportsOf(hit[1])) names.add(name);

  // explicit keys: `prisma: mockPrisma`, `upsertEnrollee: jest.fn()`
  const key = /^\s*(\w+)\s*:/gm;
  while ((hit = key.exec(body))) names.add(hit[1]);

  return { found: true, names };
}

describe('every suite that replaces @ace/database', () => {
  const imported = orchestratorImports();

  const specs = readdirSync(TEST_DIR)
    .filter((f) => f.endsWith('.spec.ts'))
    .filter((f) => mockProvides(f).found);

  it('is actually looking at some suites', () => {
    // A matcher that silently matches nothing passes forever.
    expect(specs.length).toBeGreaterThan(3);
    expect(imported.length).toBeGreaterThan(10);
  });

  it.each(specs)('%s provides everything the orchestrator imports', (spec) => {
    const { names } = mockProvides(spec);
    const missing = imported.filter((name) => !names.has(name));

    // The message is the point: a bare "expected [] " would leave the next
    // person reading flow logic again.
    expect({ spec, missing }).toEqual({ spec, missing: [] });
  });
});
