/*
 * Customer Care Agent — embedded web chat widget. RETIRED.
 *
 * This file is still served, and still does nothing, on purpose.
 *
 * The snippet that loads it is a <script> tag on tenants' own websites. We
 * cannot reach in and remove those, so this URL will keep being requested by
 * pages nobody has edited yet — possibly for years. What that request gets back
 * decides what a visitor sees:
 *
 *   - a 404, and the browser logs a network error the site owner will read as
 *     an outage on our side
 *   - the old script, and a visitor gets a chat window that accepts a message
 *     and never answers, because the API behind it now returns 410
 *   - this, and the page is exactly as it was before the tag was added
 *
 * The third is the only one that is honest to both parties. It renders no
 * launcher, no bubble and no panel, and prints one line to the console saying
 * what happened and what to do about it.
 *
 * Customers now reach this platform on WhatsApp and by phone. The web app is
 * the staff dashboard.
 *
 * Safe to delete once no tenant site still carries the snippet — until then,
 * this file is the thing telling them it stopped.
 */
(function () {
  // console.info, not warn or error: nothing is broken, and a red line in a
  // site owner's console is a support ticket about a decision we already made.
  console.info(
    '[Customer Care Agent] The embedded chat widget has been retired — this script now does nothing. ' +
      'Customers are served on WhatsApp and by phone. You can safely remove the widget script tag from this page.'
  );
})();
