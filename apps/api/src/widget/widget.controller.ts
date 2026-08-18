import { All, Controller, Res } from '@nestjs/common';
import { Response } from 'express';
import { SkipThrottle } from '@nestjs/throttler';

/**
 * The embedded web chat widget, retired.
 *
 * Customers reach this platform by phone and WhatsApp. Web is the staff
 * dashboard. A third customer-facing channel meant a third place for the AI to
 * say something wrong, with its own tenant-resolution rules and its own
 * unauthenticated, model-billing endpoint — and it was the only channel the
 * hosted-agent work was never going to cover.
 *
 * ── Why this answers instead of simply being deleted ────────────────────────
 *
 * The embed snippet is a <script> tag on tenants' own websites, which we cannot
 * reach in to remove. Deleting the routes would make those pages 404 against
 * this API — ambiguous, because a 404 also describes an outage, a bad URL, or a
 * misconfigured proxy. Somebody would spend an afternoon on it.
 *
 * 410 Gone says exactly one thing and says it permanently, and the body names
 * the replacement. Paired with the inert public/widget.js, an old embed now
 * renders nothing and explains itself in the console rather than showing a
 * visitor a chat window that never answers.
 *
 * ── What was kept ───────────────────────────────────────────────────────────
 *
 * Everything already said. ChannelType.WEBCHAT stays in the enum and existing
 * WEBCHAT conversations and messages stay in the database: they are the record
 * of what this business told its customers, and retiring a channel is not a
 * reason to destroy it. The dashboard still renders those threads.
 *
 * ── Safe to delete outright once ────────────────────────────────────────────
 *
 * no tenant site still carries the snippet. Until then this file is the thing
 * telling them why it stopped.
 */
@Controller('api/widget')
export class WidgetController {
  /**
   * @SkipThrottle — a retired endpoint does no work and touches no database.
   * Rate limiting it would only add storage lookups to a request whose entire
   * job is to answer "gone" as cheaply as possible, and a stale embed on a busy
   * site can call it a lot.
   */
  @SkipThrottle()
  @All('*')
  retired(@Res() res: Response) {
    res.status(410).json({
      error: 'gone',
      message:
        'The embedded web chat widget has been retired. This platform serves customers on WhatsApp and by phone; the web app is the staff dashboard. Remove the widget script tag from your site.',
      retired: true,
    });
  }
}
