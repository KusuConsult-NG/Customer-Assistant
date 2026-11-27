# CLAUDE.md — Engineering & Operational Rules

This project is the live **Plateau State Government Citizen Contact Centre** (`https://contact.plateaustate.gov.ng`, toll-free `+2348000000456`).

Read and obey **`AGENTS.md`** in full before making any code, infrastructure, or documentation change. All rules in `AGENTS.md` apply equally to Claude Code, Google Antigravity, and human engineers.

## Quick Mandatory Checklist Before Every Change

- [ ] **Branch isolation:** Work on a dedicated branch (`stabilisation/*` or `fix/*`); never push untested edits directly to `main` or modify production while another agent is active.
- [ ] **No banned providers:** Never introduce Microsoft Azure, Africa's Talking, DigitalOcean, Render, or Supabase.
- [ ] **Preserve production data & assets:** Never delete citizen records, recordings (`/data/files`), transcripts, tickets, the 200 Plateau State personas, 82 indexed documents (369 chunks), or 545 tracked projects.
- [ ] **Protect voice invariants:**
  - Keep `GROUP_COUNT(inbound) > 30` and `LOCAL_VOICE_MAX_CALLS=30`.
  - Keep Spitch punctuation stripping (no spoken `"full stop"` / `"comma"`).
  - Keep `SpitchTts` semaphore + circuit breaker (`spitchCircuitState()` fast-fail in `LocalVoiceService.register()`).
  - Never cache citizen PII in `tts-cache` (`isCacheable()`).
  - Keep `LOCAL_VOICE_ACK_AFTER_MS=0` in production and avoid filler lookup-bridge prompts.
- [ ] **Protect Docker builds & secrets:** Never commit `server.env`, `bridge.env`, or credentials. Keep `deploy/single-server/backups` and `deploy/single-server/server.env` in `.dockerignore`.
- [ ] **Verify before claiming done:** Run `npm --workspace=@ace/api run build`, Jest regression tests, and confirm **100% green GitHub Actions CI** before recommending deployment or live test calls.
- [ ] **Honest reporting:** Never fabricate test outputs, load numbers, or vendor SLA claims. Distinguish directly verified facts from items requiring user or vendor confirmation (see `docs/reliability/USER_ACTIONS_REQUIRED.md`).
