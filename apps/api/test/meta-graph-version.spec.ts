/**
 * No WhatsApp CALLING request may carry a hardcoded Graph API version.
 *
 * ── The bug this exists to catch ────────────────────────────────────────────
 *
 * A Graph version decides which EDGES exist, not merely which fields. Two
 * call sites were pinned to `v21.0` — October 2024, long before the WhatsApp
 * Calling API existed:
 *
 *   - `POST /{phone-number-id}/settings`, which switches calling on
 *   - `POST /{phone-number-id}/calls`, which ACCEPTS and TERMINATES a call
 *
 * The second is the entire primary path. Everything upstream could be
 * perfect — calling enabled at Meta, a TURN relay allocating, ICE and DTLS
 * and SRTP all working, a correct SDP answer built — and the request that
 * accepts the call would still be refused, because the `/calls` edge does not
 * exist in v21.0. The call could never be answered, on any configuration.
 *
 * It also fails with Meta's most misleading error — "Object with ID '<id>'
 * does not exist, cannot be loaded due to missing permissions, or does not
 * support this operation" — which names three unrelated faults in one
 * sentence. The reported symptom was "Meta says my phone number ID does not
 * exist", so the search went to a stale id, a wrong business account and a
 * mislabelled display number. The id was right. The version was never a
 * visible suspect, because `v21.0` IS a valid version: verified against the
 * live Graph API, `v99.0` and `vZZ` answer "Unknown path components" while
 * v21.0 through v27.0 are all parsed and fail only on auth.
 *
 * A hardcoded version on a calling edge is therefore not a style issue. It is
 * a failure nothing upstream can report, so it is checked in the source.
 *
 * MESSAGING is deliberately exempt. `packages/whatsapp-sdk` sends over v22.0
 * and that works; moving every working Graph call to fix the broken ones would
 * trade a known failure for an unknown set.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { metaGraphVersion, metaGraphUrl, interpretMetaRefusal } from '../src/common/meta-graph';

const SRC = join(__dirname, '..', 'src');

/** The edges that only exist in a Graph version new enough for calling. */
const CALLING_EDGES = ['/calls', '/settings'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

describe('Meta Graph API version', () => {
  const files = sourceFiles(SRC);

  it('reads the source at all, so a matcher that finds nothing cannot pass', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.endsWith('whatsapp-call-answer.service.ts'))).toBe(true);
    // And there ARE Graph calls to check.
    const graphLines = files
      .flatMap((f) => readFileSync(f, 'utf8').split('\n'))
      .filter((l) => l.includes('graph.facebook.com'));
    expect(graphLines.length).toBeGreaterThan(5);
  });

  it('builds every calling-edge URL from metaGraphUrl, not by hand', () => {
    // The rule is "came from the helper", NOT "contains no literal version".
    //
    // The first version of this test checked for a literal `v21.0` in the URL,
    // and the mutation test exposed the gap: restoring
    // `graph.facebook.com/${GRAPH_VERSION}/…/calls` is an INTERPOLATION, so
    // the regex matched nothing and this assertion passed against the exact
    // bug it was written for. It was the companion assertion below that
    // caught the regression, by luck of the constant's name. A check that
    // passes against its own bug is worse than no check, so the rule is now
    // the positive one.
    const offenders: string[] = [];

    for (const file of files) {
      if (file.includes('.spec.')) continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        // Only calling edges are in scope — messaging stays on its own version.
        if (!CALLING_EDGES.some((edge) => line.includes(edge))) return;
        if (!line.includes('graph.facebook.com')) return;
        offenders.push(`${file.replace(SRC, 'src')}:${i + 1}  ${line.trim()}`);
      });
    }

    // A hand-built `graph.facebook.com` URL on a calling edge pins a version
    // somewhere nobody will look again. `metaGraphUrl()` takes the path only.
    expect(offenders).toEqual([]);
  });

  it('keeps no local GRAPH_VERSION constant for a calling path', () => {
    // The call-answer service held its own `const GRAPH_VERSION = 'v21.0'`, so
    // the settings fix did not reach the edge that answers the call. A second
    // copy is a second thing that can disagree about which version this
    // deployment speaks.
    const withOwnConstant = files
      .filter((f) => !f.includes('.spec.') && !f.endsWith('meta-graph.ts'))
      .filter((f) => /^\s*(const|let)\s+GRAPH_VERSION\s*=/m.test(readFileSync(f, 'utf8')))
      .map((f) => f.replace(SRC, 'src'));

    expect(withOwnConstant).toEqual([]);
  });

  describe('metaGraphVersion', () => {
    const saved = process.env.META_GRAPH_VERSION;
    afterEach(() => {
      if (saved === undefined) delete process.env.META_GRAPH_VERSION;
      else process.env.META_GRAPH_VERSION = saved;
    });

    it('defaults to a version that postdates the Calling API', () => {
      delete process.env.META_GRAPH_VERSION;
      const v = metaGraphVersion();
      expect(v).toMatch(/^v\d+\.\d+$/);
      // v21.0 (Oct 2024) and earlier do not carry the calling edges.
      expect(Number(v.slice(1).split('.')[0])).toBeGreaterThan(21);
    });

    it('takes an override, so a version can be tried without a deploy', () => {
      process.env.META_GRAPH_VERSION = 'v27.0';
      expect(metaGraphVersion()).toBe('v27.0');
      expect(metaGraphUrl('123/calls')).toBe('https://graph.facebook.com/v27.0/123/calls');
    });

    it('ignores a malformed override rather than putting it in the path', () => {
      // Graph reads an unparseable segment as part of the PATH, so `v24`
      // becomes a request for an object named "v24" and comes back as
      // "Unknown path components" — which reads as our URL being malformed
      // rather than the version being wrong.
      for (const bad of ['v24', '24.0', 'latest', 'v24.0/../v21.0', '']) {
        process.env.META_GRAPH_VERSION = bad;
        expect(metaGraphVersion()).toMatch(/^v\d+\.\d+$/);
        expect(metaGraphVersion()).not.toBe(bad);
      }
    });

    it('does not double a slash when the path carries one', () => {
      process.env.META_GRAPH_VERSION = 'v24.0';
      expect(metaGraphUrl('/123/calls')).toBe('https://graph.facebook.com/v24.0/123/calls');
    });
  });

  describe('interpretMetaRefusal', () => {
    it('names all three faults Meta conflates, and the version among them', () => {
      const reading = interpretMetaRefusal(
        "Unsupported post request. Object with ID '1342529695620296' does not exist, cannot be " +
          'loaded due to missing permissions, or does not support this operation.',
        'v21.0'
      );
      expect(reading).toMatch(/Phone Number ID is wrong/i);
      expect(reading).toMatch(/cannot see that number/i);
      expect(reading).toContain('v21.0');
      expect(reading).toMatch(/META_GRAPH_VERSION/);
    });

    it('adds nothing to a refusal that already speaks for itself', () => {
      // Appending three guesses to "Session has expired" is how a useful
      // error becomes noise, and how the next real one gets ignored.
      expect(interpretMetaRefusal('Error validating access token: Session has expired.', 'v24.0')).toBeNull();
      expect(interpretMetaRefusal(undefined, 'v24.0')).toBeNull();
      expect(interpretMetaRefusal('', 'v24.0')).toBeNull();
    });
  });
});

/**
 * "Calling APIs cannot be enabled for this phone number."
 *
 * ── Why this needs its own reading ──────────────────────────────────────────
 *
 * Reported from Meta Business Manager's OWN toggle as error 2593145
 * (`useSetWhatsappBusinessPhoneNumberCallingConfigMutation`), and documented
 * as 138015 on the Graph API. It is Meta refusing the NUMBER, not the
 * request — nothing in this codebase causes it and nothing here fixes it.
 *
 * Two eligibility rules are known to produce it, and neither is guessable
 * from the message:
 *
 *  1. The number's daily messaging limit must be 2,000 unique recipients or
 *     above. New portfolios start at 250, and the limit rises by completing
 *     Meta's scaling path — it CANNOT be bought, so no payment unblocks it.
 *  2. Meta lists Nigeria among the countries where BUSINESS-INITIATED calling
 *     is unavailable. Whether user-initiated is also excluded could not be
 *     established here, and it decides whether this deployment can support
 *     WhatsApp voice calling at all.
 *
 * Without this branch the message fell through to the generic three-fault
 * reading, which says "your Phone Number ID might be wrong" — sending
 * somebody back to re-checking an id that is fine. That had already happened
 * once in this project.
 */
describe('a number Meta will not enable calling on', () => {
  const META_BUSINESS_MANAGER_ERROR =
    'GraphQL operation responded with error 2593145: Calling APIs cannot be enabled for this phone ' +
    'number. (Operation: useSetWhatsappBusinessPhoneNumberCallingConfigMutation)';

  it('is read as an ELIGIBILITY refusal, not as a wrong id', () => {
    const reading = interpretMetaRefusal(META_BUSINESS_MANAGER_ERROR, 'v24.0');
    expect(reading).toBeTruthy();
    // The thing that actually has to change.
    expect(reading).toMatch(/2,000 unique recipients/);
    expect(reading).toMatch(/cannot be purchased|cannot be bought/i);
    // And the regional rule, which may be a hard stop.
    expect(reading).toMatch(/Nigeria/);
    // NOT the id advice, which is what sent the last search the wrong way.
    expect(reading).not.toMatch(/Show this account's lines/);
  });

  it('recognises the documented Graph error number as well as the UI one', () => {
    for (const err of [
      '(#138015) Calling cannot be enabled',
      'Calling APIs cannot be enabled for this phone number.',
      'error 2593145',
    ]) {
      expect(interpretMetaRefusal(err, 'v24.0')).toMatch(/2,000 unique recipients/);
    }
  });

  it('says plainly that nothing in this platform causes it', () => {
    // The single most expensive wrong turn here is looking for the bug in our
    // own code when the provider has refused the number.
    const reading = interpretMetaRefusal(META_BUSINESS_MANAGER_ERROR, 'v24.0');
    expect(reading).toMatch(/nothing in this platform causes this/i);
  });

  it('still reads the three-fault message as before', () => {
    // The new branch runs first, so it must not swallow the other one.
    const reading = interpretMetaRefusal(
      "Object with ID '123' does not exist, cannot be loaded due to missing permissions, or does " +
        'not support this operation.',
      'v21.0'
    );
    expect(reading).toMatch(/Phone Number ID is wrong/i);
    expect(reading).not.toMatch(/2,000 unique recipients/);
  });
});
