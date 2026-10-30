# Provenance

This codebase is a repurposing of **Customer Care Agent** — a commercial
multi-tenant customer-experience product whose flagship tenant was PLASCHEMA,
the Plateau State Contributory Healthcare Management Agency.

It is being rebuilt as a **State-wide citizen customer care platform**, operated
by the Ministry of Information, with every ministry, department and agency as
an isolated tenant of one deployment.

## What was removed, and why

| Removed | Reason |
|---|---|
| Subscription billing (plans, checkout, usage limits, subscription guard) | The State is not a paying SaaS customer of itself. |
| Citizen premium collection (`/api/public/pay/*`, the Paystack path, the `Payment` model) | Out of scope: this platform answers citizens, it does not collect revenue. |
| Health-scheme identity in citizen-facing output | A hardcoded scheme name, two premium amounts and one helpline were being read aloud and texted to the citizens of every agency. |
| Dated QA and certification artefacts | See below. |

## On the removed certification documents

Fourteen QA and certification artefacts were removed in the first subtraction
commit. They described the old single-agency deployment, and several made
claims that were **not true of the code they described** — two separate
documents certified the system as production ready with "0 remaining P0/P1
defects" at a time when an unauthenticated endpoint could activate health
coverage for any enrollee on any tenant, for any amount, for free.

Upstream, one of those documents was formally withdrawn in place so the record
of what had been asserted would survive. That withdrawal covered one file; four
others carrying the same class of claim were left untouched, and a second
document certifying the system outright was never withdrawn at all.

Carrying them into this repository would be worse than deleting them: a reader
here would reasonably take them as describing *this* system, which has not been
assessed at all.

They are removed rather than re-withdrawn because:

- the **upstream repository retains them**, including the formal withdrawal
  notice, so the record of what was claimed is not destroyed; and
- they remain in this repository's **git history** at and before the first
  subtraction commit.

**Nothing in this repository certifies this system as production ready.** No
such assessment has been carried out against the repurposed codebase.

## Known gaps carried over

These were true of the upstream system and remain true here:

- The voice path has **never completed a real call end to end** under either
  conversation engine.
- The hosted agent layer (`apps/api/src/agent-tools`) is built and tested but
  **has never served a real customer**.
- Outbound WhatsApp notices are blocked on provider template approval.
- Calendar synchronisation is not implemented.
- SMS, email and social channels exist in the data model only.

## Still to do for the State-wide model

- ~~A platform administration tier.~~ **Built** — `apps/api/src/platform`, see
  the section in `CLAUDE.md`. State-wide overview, per-agency comparative
  reporting, agency provisioning, suspension and reinstatement, and a
  cross-agency audit trail, with a console at `/platform` in the dashboard. It
  reports metrics and configuration only, never citizen content.
- ~~Per-agency service hours.~~ **Done.** `Organization.openingHour`,
  `closingHour` and `serviceDays` drive appointment search for both engines,
  editable under Settings → General. Defaults reproduce the old Mon–Fri
  08:00–18:00 exactly, so no existing agency changed behaviour.
- ~~De-scheme the agent prompt.~~ **Done.** `SYSTEM_PROMPT` went from 443 lines
  to 61: the health plans, the accredited-facility directory and the scheme
  pronunciation rule are gone, and it now states that the agency's own
  instructions are the only source for services, eligibility, fees and
  locations — and to refuse rather than infer when they do not cover a
  question. The dashboard shell, the digital ID card, the spoken registration
  confirmations and the issued reference prefix are all driven by the agency's
  own record.

- **Per-agency service locations.** `service-locations.ts` (was
  `plaschema-facilities.ts`) still holds ONE agency's accredited health
  facilities in platform code. It is labelled as that agency's seed data and
  no longer defines the State's geography — LGAs moved to `state-geography.ts`
  as first-class State data — but the honest shape is a per-agency table of
  offices each ministry maintains itself.

- **Generalise the registration flow.** `enrollment-flow.ts` still offers the
  health scheme's four plans (Formal, Informal, Equity, BHCPF) and picks from
  that agency's facility list. The mechanics are generic; the content is not.
  This needs per-agency configurable forms, which is a build rather than a
  rename. `ENROLLMENT_FLOW_NAME` stays `'plaschema-enrollment'` deliberately —
  it is written into `Conversation.flowState`, so renaming it would strand
  every citizen part-way through a form.
