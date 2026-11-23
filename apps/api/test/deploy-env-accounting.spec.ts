/**
 * Every environment variable the API reads is declared in render.yaml.
 *
 * ── The bug this exists to catch ────────────────────────────────────────────
 *
 * `ENCRYPTION_KEY` was not in render.yaml.
 *
 * Nothing failed at boot, because it is optional there: the API starts, the
 * dashboard loads, and every screen works. What it silently costs is the one
 * thing it protects — storing a provider credential. EVERY tenant credential
 * (ElevenLabs workspace key, Twilio auth token, WhatsApp access token) is
 * AES-256-GCM encrypted with it, and `sealSecret` REFUSES to write when it is
 * unset rather than falling back to plaintext. So on Render,
 * `POST /api/agent-provisioning/credentials` threw, and the operator trying to
 * connect their ElevenLabs workspace could not save the key at all — with
 * nothing in the deploy config to suggest why.
 *
 * A missing optional var is invisible precisely because it is optional. The
 * deploy manifest is the only place it can be noticed, so this compares the
 * two lists.
 *
 * ── Why omissions are declared rather than inferred ─────────────────────────
 *
 * Some vars are left out ON PURPOSE, and the reason matters more than the
 * omission. `ELEVENLABS_ALLOW_SHARED_WORKSPACE` is the clearest: setting it on
 * a multi-tenant deployment puts every tenant's numbers, WhatsApp lines and
 * transcripts in one workspace. render.yaml carries a comment explaining that,
 * and this test keeps the decision explicit instead of letting a future
 * omission look the same as a deliberate one.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const RENDER_YAML = join(__dirname, '..', '..', '..', 'render.yaml');
const ENV_VALIDATION = join(__dirname, '..', 'src', 'config', 'env.validation.ts');

/**
 * Vars the API knows about that render.yaml deliberately does not declare.
 * Each needs a reason, because "not in the manifest" otherwise reads the same
 * whether it was a decision or an oversight.
 */
const DELIBERATELY_OMITTED: Record<string, string> = {
  AUDIOSOCKET_HOST: 'Single-server only: 0.0.0.0 inside the container (deploy/single-server/docker-compose.yml); the default 127.0.0.1 is right everywhere else.',
  // The single-server deployment (deploy/vps) sets these in its own generated
  // env file; on Render they must stay unset. A Render container's disk is
  // wiped by every deploy, so STORAGE_DIR there would lose every upload, and
  // the local voice line needs Asterisk on the same machine.
  STORAGE_DIR: 'Single-server only (deploy/vps/install.sh). On Render the disk is wiped by every deploy; files go to Supabase.',
  STORAGE_LINK_SECRET: 'Single-server only (deploy/vps/install.sh generates it). Render keeps files in Supabase, which signs its own links.',
  LOCAL_VOICE_PIPELINE: 'Single-server only: needs Asterisk on the same machine (deploy/vps).',
  AZURE_SPEECH_KEY: 'Single-server voice line only (deploy/vps/deploy.env).',
  AZURE_SPEECH_REGION: 'Single-server voice line only (deploy/vps/deploy.env).',
  ELEVENLABS_ALLOW_SHARED_WORKSPACE:
    'Single-tenant opt-in. Setting it here would put every tenant\'s numbers, ' +
    'WhatsApp lines and transcripts in one ElevenLabs workspace.',
  ELEVENLABS_SIGNATURE_HEADER:
    'Override for the post-call signature header name. The documented default ' +
    'is used unless a live delivery proves otherwise.',
  ELEVENLABS_CONVERSATION_START_WEBHOOK:
    'Opt-in for the conversation-initiation webhook. Left out of the manifest ' +
    'so it stays off by default until a workspace-level webhook is configured in ElevenLabs.',
  ALLOW_MISSING_BOOKING_CONSTRAINT:
    'Deliberate opt-out for a deployment that takes no bookings. Declaring it ' +
    'in the manifest invites someone to set it to get past a failing boot.',
  ALLOW_MISSING_ENUM_VALUES:
    'Same reason as the booking constraint: it exists to be set knowingly, not ' +
    'to be the obvious way past a boot that is refusing for a good reason. The ' +
    'preDeployCommand adds the values, so a correct deploy never needs it.',
};

function declaredInRender(): Set<string> {
  const yaml = readFileSync(RENDER_YAML, 'utf8');
  return new Set([...yaml.matchAll(/^\s*-\s*key:\s*([A-Z0-9_]+)\s*$/gm)].map((m) => m[1]));
}

function knownToTheApi(): string[] {
  const src = readFileSync(ENV_VALIDATION, 'utf8');
  return [...src.matchAll(/\{\s*key:\s*'([A-Z0-9_]+)'/g)].map((m) => m[1]);
}

describe('Deploy env accounting', () => {
  it('reads both lists, rather than silently comparing nothing', () => {
    // A matcher that finds no keys passes every assertion below.
    expect(knownToTheApi().length).toBeGreaterThan(20);
    expect(declaredInRender().size).toBeGreaterThan(20);
  });

  it('declares every variable the API reads, or says why not', () => {
    const declared = declaredInRender();
    const missing = knownToTheApi()
      .filter((key) => !declared.has(key) && !(key in DELIBERATELY_OMITTED));

    expect(missing).toEqual([]);
  });

  it('declares the key without which no tenant credential can be stored', () => {
    // Called out on its own because its absence is silent: the boot succeeds,
    // every screen works, and only saving a credential fails.
    expect(declaredInRender().has('ENCRYPTION_KEY')).toBe(true);
  });

  it('keeps no stale omission for a variable the API no longer reads', () => {
    const known = new Set(knownToTheApi());
    const declared = declaredInRender();
    const stale = Object.keys(DELIBERATELY_OMITTED)
      .filter((key) => !known.has(key) && !declared.has(key));

    expect(stale).toEqual([]);
  });

  it('never hands a secret a literal value in the manifest', () => {
    // A secret with `value:` is committed to the repository. Secrets carry
    // `sync: false`, which is Render's "set this in the dashboard".
    const yaml = readFileSync(RENDER_YAML, 'utf8');
    const offenders: string[] = [];
    const entries = [...yaml.matchAll(/-\s*key:\s*([A-Z0-9_]+)\s*\n\s*(value|sync|generateValue):\s*(.+)/g)];

    for (const [, key, field, raw] of entries) {
      const looksSecret = /(SECRET|TOKEN|KEY|PASSWORD|SID|DSN|URL)$/.test(key);
      const literal = field === 'value';
      // URLs and non-sensitive literals are fine; credentials are not.
      const sensitive = /(SECRET|TOKEN|PASSWORD|_KEY|KEY)$/.test(key);
      if (looksSecret && literal && sensitive && !/^\s*$/.test(raw)) {
        offenders.push(`${key}: ${raw.trim()}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
