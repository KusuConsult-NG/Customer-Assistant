/**
 * The dashboard sends fields the API accepts.
 *
 * ── The bug this exists to catch ────────────────────────────────────────────
 *
 * Creating a booking posted `{contactName, service, staff}` where the endpoint
 * reads `{contactId, serviceName, staffName}`. It returned 500 every time, and
 * the screen checked `if (res.ok)` with no else, so nothing was shown — a
 * button that silently never worked. Nothing in the test suite could see it:
 * the API suite exercised the endpoint with correct field names, and the
 * browser suite did not exist yet.
 *
 * A field name is a contract between two codebases with no shared type, and
 * this is what checks it.
 *
 * ── Why the first version of this was worthless ────────────────────────────
 *
 * It required the body to sit in a literal `apiFetch(`url`, { … })`. Pages that
 * route their writes through a helper — `send(label, url, init, onDone)` — were
 * invisible, so it compared ZERO of the scheduling mutations and reported
 * "0 problems". Reintroducing the exact `contactName` bug did not make it fail.
 *
 * So it now reads the whole enclosing CALL EXPRESSION: the URL and the body
 * only have to appear in the same call, not in adjacent arguments. And it
 * asserts how many bodies it compared, because a parser that silently matches
 * nothing passes every time.
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const API_SRC = join(__dirname, '..', 'src');
const WEB_SRC = join(__dirname, '..', '..', 'web', 'src');

function walk(dir: string, match: (n: string) => boolean): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, match));
    else if (match(e.name)) out.push(p);
  }
  return out;
}

/** Walk braces from `from` (which must be a `{`) to its match. */
function matchBrace(src: string, from: number): number {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/**
 * Top-level `key:` names inside a brace span, ignoring nested objects.
 *
 * The `[?!]?` is load-bearing. Without it `language?: string` did not match, so
 * every OPTIONAL field was missing from what a route "accepts" — and the first
 * run of this spec reported fourteen endpoints as silently discarding fields
 * they read perfectly well. A checker that invents violations is worse than no
 * checker: it trains you to ignore it.
 */
function topLevelKeys(objectBody: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  for (const tok of objectBody.matchAll(/[{}[\]]|(\w+)\s*[?!]?\s*:/g)) {
    if (tok[0] === '{' || tok[0] === '[') depth++;
    else if (tok[0] === '}' || tok[0] === ']') depth--;
    else if (depth === 0 && tok[1]) keys.push(tok[1]);
  }
  return keys;
}

// ── What each route accepts ───────────────────────────────────────────────

/** `class FooDto { bar?: string }` → the property names. */
function collectDtos(): Map<string, string[]> {
  const dtos = new Map<string, string[]>();
  for (const file of walk(API_SRC, (n) => n.endsWith('.ts'))) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/export class (\w*Dto)\s*\{/g)) {
      const open = src.indexOf('{', m.index!);
      const close = matchBrace(src, open);
      if (close === -1) continue;
      const body = src.slice(open + 1, close);
      // Strip decorators so `@IsString()` does not read as a property.
      const cleaned = body.replace(/@\w+\([^)]*\)/g, '');
      dtos.set(m[1], [...cleaned.matchAll(/^\s*(?:readonly\s+)?(\w+)\s*[?!]?\s*:/gm)].map((x) => x[1]));
    }
  }
  return dtos;
}

interface Route { method: string; path: string; accepts: string[] | null; file: string }

function collectRoutes(dtos: Map<string, string[]>): Route[] {
  const routes: Route[] = [];
  for (const file of walk(API_SRC, (n) => n.endsWith('.controller.ts'))) {
    const src = readFileSync(file, 'utf8');
    const lines = src.split('\n');
    let prefix = '';
    for (let i = 0; i < lines.length; i++) {
      const c = lines[i].match(/^@Controller\((?:'([^']*)'|"([^"]*)")?\)/);
      if (c) { prefix = c[1] ?? c[2] ?? ''; continue; }
      const m = lines[i].match(/^\s*@(Get|Post|Put|Patch|Delete)\((?:'([^']*)'|"([^"]*)")?\)/);
      if (!m) continue;

      const block = lines.slice(i, i + 50).join('\n');
      let accepts: string[] | null = null;
      const bi = block.indexOf('@Body()');
      if (bi !== -1) {
        const after = block.slice(bi);
        const dto = after.match(/^@Body\(\)\s*\w+\s*:\s*(\w+Dto)/);
        if (dto) {
          accepts = dtos.get(dto[1]) ?? null;
        } else {
          const brace = after.indexOf('{');
          if (brace !== -1) {
            const close = matchBrace(after, brace);
            if (close !== -1) accepts = topLevelKeys(after.slice(brace + 1, close));
          }
        }
      }
      routes.push({
        method: m[1].toUpperCase(),
        path: '/' + [prefix, m[2] ?? m[3] ?? ''].filter(Boolean).join('/'),
        accepts,
        file: file.slice(file.indexOf('apps/')),
      });
    }
  }
  return routes;
}

// ── What the dashboard sends ──────────────────────────────────────────────

interface Sent { method: string; path: string; keys: string[]; file: string; line: number }

/**
 * Find the call expression that contains `urlIndex`, by scanning back to the
 * unmatched `(` that opened it. This is what lets a helper-wrapped write be
 * seen: the URL and the body are in the same call, several arguments apart.
 */
function enclosingCall(src: string, urlIndex: number): string | null {
  let depth = 0;
  for (let i = urlIndex; i >= 0; i--) {
    const ch = src[i];
    if (ch === ')') depth++;
    else if (ch === '(') {
      if (depth === 0) {
        // Found the opening paren; now walk forward to its match.
        let d = 0;
        for (let j = i; j < src.length; j++) {
          if (src[j] === '(') d++;
          else if (src[j] === ')') { d--; if (d === 0) return src.slice(i, j + 1); }
        }
        return null;
      }
      depth--;
    }
  }
  return null;
}

function collectSent(): Sent[] {
  const sent: Sent[] = [];
  for (const file of walk(WEB_SRC, (n) => /\.tsx?$/.test(n))) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/`([^`]*\/api\/[^`]*)`/g)) {
      const call = enclosingCall(src, m.index!);
      if (!call) continue;
      const method = (call.match(/method:\s*'(\w+)'/) || [, 'GET'])[1].toUpperCase();
      if (method === 'GET') continue;
      const si = call.indexOf('JSON.stringify(');
      if (si === -1) continue;
      const ob = call.indexOf('{', si);
      if (ob === -1) continue;
      const close = matchBrace(call, ob);
      if (close === -1) continue;
      sent.push({
        method,
        // Interpolations are collapsed BEFORE the query string is stripped: a
        // path like `/api/scheduling/${kind === 'booking' ? 'bookings' : …}/…`
        // contains a `?` inside the expression, and stripping from the first
        // `?` truncated the route to nothing recognisable.
        path: normalisePath('/api/' + m[1].split('/api/')[1]),
        keys: topLevelKeys(call.slice(ob + 1, close)),
        file: file.slice(file.indexOf('apps/')),
        line: src.slice(0, m.index!).split('\n').length,
      });
    }
  }
  return sent;
}

/** Collapse `${…}` to `:p`, then drop any query string. */
function normalisePath(raw: string): string {
  return raw.replace(/\$\{[^}]*\}/g, ':p').replace(/\?.*$/, '');
}

/**
 * Does a route path serve what the dashboard built?
 *
 * An interpolated segment on the CALLER's side may stand for a literal on the
 * route's side: the page writes
 * `/api/scheduling/${kind === 'booking' ? 'bookings' : 'reservations'}/${id}/cancel`,
 * which is one call expression serving two routes. Requiring literal equality
 * reported all six of those as posting to routes that do not exist.
 *
 * Segment COUNT and every literal that is present still have to line up, which
 * is what stops this from matching anything.
 */
function serves(routePath: string, sentPath: string): boolean {
  const r = routePath.split('/').filter(Boolean);
  const c = sentPath.split('/').filter(Boolean);
  if (r.length !== c.length) return false;
  return r.every((rs, i) => {
    const cs = c[i];
    return cs === ':p' || rs.startsWith(':') || rs === cs;
  });
}

describe('Payload contract: what the dashboard sends, what the API accepts', () => {
  const dtos = collectDtos();
  const routes = collectRoutes(dtos);
  const sent = collectSent();

  // One call expression can serve several routes (the ternary above), so the
  // accepted set is the UNION of every route it could reach — the caller sends
  // whichever shape the branch picked.
  const paired = sent
    .map((s) => {
      const matches = routes.filter((r) => r.method === s.method && serves(r.path, s.path));
      if (matches.length === 0) return null;
      const readable = matches.filter((m) => Array.isArray(m.accepts) && m.accepts.length > 0);
      return {
        s,
        r: {
          method: s.method,
          path: matches.map((m) => m.path).join(' | '),
          accepts: readable.length === matches.length
            ? [...new Set(readable.flatMap((m) => m.accepts!))]
            : null,
          file: matches[0].file,
        } as Route,
      };
    })
    .filter((x): x is { s: Sent; r: Route } => x !== null);
  // An EMPTY accepted set is a parse failure, not an endpoint that reads
  // nothing: no controller takes a body and uses none of it. Comparing against
  // an empty set would report every field as unread.
  const comparable = paired.filter((x) => Array.isArray(x.r.accepts) && x.r.accepts!.length > 0);
  const unreadable = paired.filter((x) => !Array.isArray(x.r.accepts) || x.r.accepts!.length === 0);

  it('parsed both sides, rather than silently matching nothing', () => {
    // The first version of this spec compared ZERO bodies and reported no
    // problems. These floors are what make a pass mean something.
    expect(routes.length).toBeGreaterThan(100);
    expect(dtos.size).toBeGreaterThan(0);
    expect(sent.length).toBeGreaterThan(20);
    expect(comparable.length).toBeGreaterThan(20);
  });

  it('could read the accepted fields for every route the dashboard writes to', () => {
    // Anything here is a signature shape the parser does not understand, and
    // its payload is therefore UNCHECKED. Listing them keeps that visible
    // instead of letting the suite look complete.
    const gaps = unreadable.map((x) => `${x.s.method} ${x.r.path}   (${x.r.file})`);
    expect([...new Set(gaps)]).toEqual([]);
  });

  it('sends no field the endpoint does not read', () => {
    const problems = comparable
      .flatMap(({ s, r }) => {
        const unknown = s.keys.filter((k) => !r.accepts!.includes(k));
        return unknown.length
          ? [`${s.file}:${s.line}  ${s.method} ${r.path}\n     sends ${s.keys.join(', ')}\n     accepts ${r.accepts!.join(', ')}\n     NOT READ: ${unknown.join(', ')}`]
          : [];
      });

    // A field the endpoint does not read is either a 500 (a required column
    // left undefined) or a value silently discarded. Both look like a button
    // that does nothing.
    expect(problems).toEqual([]);
  });

  it('posts to routes that exist', () => {
    const orphans = sent
      .filter((s) => !routes.some((r) => r.method === s.method && serves(r.path, s.path)))
      .map((s) => `${s.file}:${s.line}  ${s.method} ${s.path}`);

    expect(orphans).toEqual([]);
  });
});
