/**
 * Load .env from the monorepo root, wherever the process was started from.
 *
 * `import 'dotenv/config'` only ever looks in process.cwd(). That is the repo
 * root when you run `node apps/api/dist/main.js`, but it is `apps/api` under
 * `turbo run dev` and under `cd apps/api && npx jest` — both documented ways to
 * run this app. In those the root .env was silently skipped and every required
 * variable read as missing, so the API refused to boot and told the operator to
 * fix a .env file that was already correct.
 *
 * So: walk up from the working directory, then from this file, and load the
 * first .env in each chain. dotenv never overwrites an existing value, which
 * keeps both established rules intact — a real environment variable always wins
 * over a file, and the .env nearest the working directory wins over the root.
 */
import { existsSync } from 'fs';
import { dirname, join, parse } from 'path';
import { config } from 'dotenv';

function ancestorsOf(start: string): string[] {
  const chain: string[] = [];
  const { root } = parse(start);
  let dir = start;
  while (true) {
    chain.push(dir);
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return chain;
}

export function loadEnvFromNearestFile(): string[] {
  const loaded: string[] = [];
  const seen = new Set<string>();

  // Working directory first (a per-app .env is the more specific choice), then
  // this file's location so it works no matter where the process was launched.
  for (const start of [process.cwd(), __dirname]) {
    for (const dir of ancestorsOf(start)) {
      const candidate = join(dir, '.env');
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      if (!existsSync(candidate)) continue;
      config({ path: candidate });
      loaded.push(candidate);
      break; // nearest .env in this chain only
    }
  }

  return loaded;
}

loadEnvFromNearestFile();
