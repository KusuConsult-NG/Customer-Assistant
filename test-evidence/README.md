# Test evidence

Screen captures taken against the running stack (API on :4000, web on :3000)
with the seeded demo agency, at the commit that added them.

`index.html` is a contact sheet of all 35 captures. Every dashboard screen
appears twice — once in each theme — because several defects found during this
work were visible in only one of them (the Conversations panes stayed white in
dark mode, with dark-mode text on them, so citizen names rendered at 1.1:1).

Captured at 1440px wide. They were 2× for legibility and are stored re-encoded,
because 17.5MB of PNG in a source tree is paid for by every clone forever.

## What these are not

Proof that a real phone rang. They are not, and nothing here claims it. This
container has no carrier credentials and no egress to `api.twilio.com`, so the
dial attempt ends in `ENOTFOUND` — which the callback queue screenshot shows,
recorded in the carrier's own words rather than hidden behind a generic error.

The behaviour these support is proven by the suites, not by the pictures:

| What | Where |
|---|---|
| Inbound call, signed webhook → media stream → DB | `apps/api/test/`, and the call driver described in the commit |
| Callback promise, dispatch, claim, honest failure | `apps/api/test/callbacks.spec.ts`, `packages/orchestrator/test/callback-flow.spec.ts` |
| Automation actually firing | `apps/api/test/workflow-engine.spec.ts` |
| Every screen readable in both themes | `apps/web/e2e/contrast.spec.ts` |
| Every button issuing a real request | `apps/web/e2e/scheduling-actions.spec.ts` and the rest of `apps/web/e2e/` |

A screenshot shows a page rendered. It cannot show that a button sent a
request — which is the exact defect this codebase already shipped once, where
four scheduling buttons said "cancelled." and made no request at all. That is
why the browser suite asserts on the REQUEST, and why these are evidence
alongside it rather than instead of it.
