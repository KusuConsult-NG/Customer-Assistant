/**
 * The Graph API version the WhatsApp CALLING paths use, in one place.
 *
 * ── The bug this exists to catch ────────────────────────────────────────────
 *
 * A Graph version decides which EDGES exist, not merely which fields. Two
 * separate call sites were pinned to `v21.0` — October 2024, long before the
 * WhatsApp Calling API existed:
 *
 *   - `POST /{phone-number-id}/settings`, which switches calling on
 *   - `POST /{phone-number-id}/calls`, which ACCEPTS and TERMINATES a call
 *
 * The second is the whole primary path. Everything upstream of it could be
 * perfect — calling enabled at Meta, a TURN relay allocating, ICE and DTLS
 * and SRTP all working, a correct SDP answer built — and the request that
 * accepts the call would still be refused, because the `/calls` edge does not
 * exist in v21.0. The call could never be answered.
 *
 * And it fails with Meta's single most misleading error:
 *
 *   Unsupported post request. Object with ID '<id>' does not exist, cannot be
 *   loaded due to missing permissions, or does not support this operation.
 *
 * Three unrelated faults in one sentence, of which the phone number id is the
 * only one most people read. The reported symptom was "Meta says my phone
 * number ID does not exist", and that sent the search to a stale id, a wrong
 * business account and a mislabelled display number — while the id was right
 * and the version was never a visible suspect at all.
 *
 * Verified against the live Graph API rather than assumed: `v99.0` and `vZZ`
 * answer "Unknown path components", while v21.0 through v27.0 are all parsed
 * as versions and fail only on auth. So v21.0 is a VALID version, just an old
 * one — which is exactly why nothing ever complained about the URL.
 *
 * ── Why this is not applied to the messaging paths ──────────────────────────
 *
 * `packages/whatsapp-sdk` sends messages over v22.0 and downloads media over
 * v22.0, and both work. A newer version can change or drop fields, so moving
 * every working Graph call to fix the broken ones would trade a known failure
 * for an unknown set. Messaging is deliberately left where it is.
 */

/** The default. Attested for `calling: {status: ENABLED}` and for `/calls`. */
const DEFAULT_GRAPH_VERSION = 'v24.0';

/**
 * `META_GRAPH_VERSION` overrides it, so a version can be tried without a
 * deploy.
 *
 * VALIDATED rather than interpolated raw. Graph reads an unparseable segment
 * as part of the PATH, so a typo like `v24` becomes a request for an object
 * named "v24" and comes back as "Unknown path components" — which reads as our
 * URL being malformed rather than the version being wrong, and sends whoever
 * is debugging it somewhere else again.
 */
export function metaGraphVersion(): string {
  const configured = process.env.META_GRAPH_VERSION?.trim();
  if (!configured) return DEFAULT_GRAPH_VERSION;
  return /^v\d+\.\d+$/.test(configured) ? configured : DEFAULT_GRAPH_VERSION;
}

/** A Graph URL for a calling path, on the configured version. */
export function metaGraphUrl(path: string): string {
  return `https://graph.facebook.com/${metaGraphVersion()}/${path.replace(/^\/+/, '')}`;
}

/**
 * Meta's "does not exist, cannot be loaded due to missing permissions, or
 * does not support this operation" names three faults and distinguishes none
 * of them, so the quote alone sends an operator to the wrong place.
 *
 * Returns the reading, or null when Meta said something that speaks for
 * itself. Never REPLACES Meta's words — it is added to them, because an
 * interpretation that hides the provider's own answer is how a useful error
 * becomes a worse one.
 */
export function interpretMetaRefusal(error: string | undefined, graphVersion: string): string | null {
  if (!error) return null;

  // ── "Calling APIs cannot be enabled for this phone number" ───────────────
  //
  // A DIFFERENT refusal, and it means something far more specific than the
  // three-fault message below — so it must be read first, or it gets the
  // generic "your id might be wrong" answer and sends somebody back to
  // checking an id that is fine.
  //
  // This is Meta refusing the number itself, not the request. Seen as error
  // 2593145 from Meta Business Manager's own mutation
  // (`useSetWhatsappBusinessPhoneNumberCallingConfigMutation`) and documented
  // as 138015 on the Graph API. Nothing in this codebase can cause it or fix
  // it, and two eligibility rules are known to produce it:
  //
  //  1. THE MESSAGING LIMIT. Meta's call-settings documentation requires the
  //     number's daily limit to be 2,000 unique recipients or above. New
  //     business portfolios start at 250. It is raised by completing Meta's
  //     scaling path — business verification and sustained use — and CANNOT
  //     be bought, so there is no purchase that unblocks this.
  //
  //  2. THE COUNTRY. Meta's Cloud API calling documentation lists Nigeria
  //     among the countries where BUSINESS-INITIATED calling is unavailable.
  //     Whether user-initiated (a citizen calling in) is also excluded is not
  //     something this codebase can establish, and secondary sources
  //     disagree — so it is named as a question for Meta rather than stated
  //     as fact. It matters enormously here: if inbound is excluded too, no
  //     amount of code makes WhatsApp voice calling work for this deployment.
  if (/calling\s+apis?\s+cannot\s+be\s+enabled|\b2593145\b|\b138015\b/i.test(error)) {
    return (
      'Meta is refusing the NUMBER, not the request — nothing in this platform causes this and no ' +
      'change here fixes it. Two eligibility rules are known to produce it. ' +
      "(1) MESSAGING LIMIT: Meta requires this number's daily limit to be 2,000 unique recipients " +
      'or above before calling can be switched on. New portfolios start at 250. It is raised by ' +
      "completing Meta's scaling path — business verification and sustained use — and cannot be " +
      'purchased, so no plan or payment unblocks it. Check the limit on the number in WhatsApp ' +
      'Manager. ' +
      '(2) COUNTRY: Meta lists Nigeria among the countries where BUSINESS-INITIATED calling is ' +
      'unavailable. Whether calls FROM citizens are also excluded is not documented clearly enough ' +
      'to state here — ask Meta support, quoting this error, because if inbound is excluded for ' +
      'Nigeria then WhatsApp voice calling cannot work for this deployment at all and the phone ' +
      'line is the route to use.'
    );
  }

  if (!/does not exist|cannot be loaded due to missing permissions|does not support this operation/i.test(error)) {
    return null;
  }
  return (
    `That one Meta message covers three different faults, and only the first is about the id. ` +
    `(1) The Phone Number ID is wrong — compare it against "Show this account's lines". ` +
    `(2) The stored token cannot see that number, which Meta reports as "does not exist" rather ` +
    `than as a permission error — the token may belong to a different WhatsApp Business Account, ` +
    `or lack whatsapp_business_management. ` +
    `(3) Graph ${graphVersion} does not carry this edge for this number. Set ` +
    `META_GRAPH_VERSION to a newer version and try again.`
  );
}
