/**
 * Update the live PLASCHEMA agent's system prompt in place.
 *
 * Scope is deliberately minimal: GET the agent, replace ONLY
 * conversation_config.agent.prompt.prompt with the pre-generated text in
 * plaschema-agent-prompt.txt, PATCH the FULL conversation_config back, verify.
 * Tool ids, voice, timezone, language model, first message and dynamic
 * variables are preserved byte-for-byte from the GET — sending the whole
 * object back makes that true regardless of the API's merge semantics.
 *
 * Why this exists: the live agent was synced with a prompt instructing it to
 * claim to be human when asked ("No, I'm Sarah — one of the team"). That is a
 * regulatory violation (and a Meta policy one on WhatsApp). The corrected
 * prompt was generated from the merged catalog by the maintainer session and
 * shipped alongside this script; this script only carries it.
 *
 * Run:  ELEVENLABS_API_KEY=... node scripts/sync-payload/apply-prompt-update.js
 * The key is read from env and never printed or written anywhere.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) { console.error('ELEVENLABS_API_KEY not set'); process.exit(1); }

const BASE = 'https://api.elevenlabs.io';
const HERE = __dirname;

function api(method, urlPath, bodyFile) {
  const args = ['-sS', '-X', method, `${BASE}${urlPath}`,
    '-H', `xi-api-key: ${KEY}`, '-H', 'Content-Type: application/json',
    '-w', '\n%{http_code}'];
  if (bodyFile) args.push('--data-binary', `@${bodyFile}`);
  const out = execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const idx = out.lastIndexOf('\n');
  const status = parseInt(out.slice(idx + 1), 10);
  const body = out.slice(0, idx);
  if (status < 200 || status >= 300) {
    throw new Error(`${method} ${urlPath} -> HTTP ${status}: ${body.slice(0, 400)}`);
  }
  return JSON.parse(body);
}

(async () => {
  // 1. Find the PLASCHEMA agent — and refuse ambiguity rather than guessing.
  const list = api('GET', '/v1/convai/agents?page_size=30');
  const agents = (list.agents || []).filter((a) => /plaschema/i.test(a.name || ''));
  if (agents.length !== 1) {
    console.error(`Expected exactly one PLASCHEMA agent, found ${agents.length}:`,
      (list.agents || []).map((a) => a.name).join(' | '));
    process.exit(1);
  }
  const agentId = agents[0].agent_id;
  console.log(`agent: ${agents[0].name} (${agentId})`);

  // 2. Full backup of the current state, BEFORE anything changes.
  const current = api('GET', `/v1/convai/agents/${agentId}`);
  const backupPath = path.join(HERE, `backup-${agentId}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(current, null, 2));
  console.log(`backup written: ${backupPath}`);

  const cc = current.conversation_config;
  if (!cc?.agent?.prompt) { console.error('Unexpected agent shape — no conversation_config.agent.prompt'); process.exit(1); }
  const toolIdsBefore = JSON.stringify(cc.agent.prompt.tool_ids ?? null);
  const oldPrompt = cc.agent.prompt.prompt || '';
  console.log(`old prompt: ${oldPrompt.length} chars; deny-AI text present: ${oldPrompt.includes('Never say "I am an AI"') || /No, I'm \w+ — one of the team/.test(oldPrompt)}`);

  // 3. Swap ONLY the prompt text.
  const newPrompt = fs.readFileSync(path.join(HERE, 'plaschema-agent-prompt.txt'), 'utf8');
  if (!newPrompt.includes('say plainly and warmly that you are an AI assistant') ||
      !newPrompt.includes('## Languages')) {
    console.error('Payload failed its own gates — refusing to apply'); process.exit(1);
  }

  // …and that it still matches the catalog it was generated from.
  //
  // This file is a SNAPSHOT. Every change to SYSTEM_PROMPT since it was written
  // is a change this script would silently undo on the live agent — including
  // the guardrails that are the whole reason it exists. Checked against the
  // built catalog rather than trusted, because the failure is invisible: the
  // script reports SYNC OK and the agent goes back to an older set of rules.
  const catalogPath = path.join(HERE, '..', '..', 'apps/api/dist/agent-tools/agent-tool-catalog.js');
  if (!fs.existsSync(catalogPath)) {
    console.error(
      'Cannot verify the payload against the catalog: apps/api is not built.\n' +
      'Run `npx turbo run build --filter=@ace/api...` first — pushing an unverified ' +
      'prompt to a live agent is exactly what this script exists to undo.'
    );
    process.exit(1);
  }
  const { SYSTEM_PROMPT } = require(catalogPath);
  if (!newPrompt.includes(SYSTEM_PROMPT)) {
    console.error(
      'The payload no longer contains the current SYSTEM_PROMPT — it is stale.\n' +
      'Regenerate it with `node scripts/generate-agent-config.js` before applying, ' +
      'or this push would revert the agent to an older set of rules.'
    );
    process.exit(1);
  }
  console.log('payload verified against the built catalog');

  cc.agent.prompt.prompt = newPrompt;

  const patchBody = path.join(HERE, 'patch-body.json');
  fs.writeFileSync(patchBody, JSON.stringify({ conversation_config: cc }));
  api('PATCH', `/v1/convai/agents/${agentId}`, patchBody);
  fs.unlinkSync(patchBody);
  console.log('PATCH accepted');

  // 4. Verify from a fresh GET — never from the intention.
  const after = api('GET', `/v1/convai/agents/${agentId}`);
  const ap = after.conversation_config?.agent?.prompt ?? {};
  const toolIdsAfter = JSON.stringify(ap.tool_ids ?? null);
  const ok =
    (ap.prompt || '').includes('say plainly and warmly that you are an AI assistant') &&
    (ap.prompt || '').includes('## Languages') &&
    !(ap.prompt || '').includes('Never say "I am an AI"') &&
    toolIdsAfter === toolIdsBefore;
  console.log(`verified: prompt updated=${ok}, tool_ids unchanged=${toolIdsAfter === toolIdsBefore}`);
  if (!ok) { console.error('VERIFICATION FAILED — the backup file holds the pre-change state'); process.exit(1); }
  console.log('SYNC OK');
})();
