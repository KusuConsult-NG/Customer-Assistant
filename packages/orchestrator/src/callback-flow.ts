/**
 * Asking to be rung back, and being told when.
 *
 * ── Why this is a flow and not a reply ──────────────────────────────────────
 *
 * "Call me back" used to reach nothing at all: there was no intent for it, so
 * it fell through to RAG, and the citizen got a knowledge-base answer about
 * something else. The nearest thing the platform could do was raise a ticket,
 * which nobody promised anyone a time for.
 *
 * A callback is a COMMITMENT, and the only thing that makes it one is that a
 * time was said out loud. So this collects two things — why, and when — and
 * the time the citizen picks is stored verbatim alongside the deadline it
 * computes to. An officer picking the record up says the same words back.
 *
 * ── Why the read-back stays ─────────────────────────────────────────────────
 *
 * `FlowDefinition.summarise` is optional and booking omits it, because there
 * the last answer IS the decision. Here it is not: the reason was typed freely
 * several turns earlier and it is what the officer will ring about. Reading it
 * back is the citizen's only chance to correct it before somebody calls them
 * about the wrong thing.
 */
import type { FlowDefinition } from './flows';
import { t } from './languages';

export const CALLBACK_FLOW_NAME = 'request-callback';

/**
 * The windows a citizen may choose, in the order they are offered.
 *
 * `minutes` is how long from now the promise falls due. These are deliberately
 * coarse — a citizen asked for a precise minute would be given a precision the
 * agency cannot keep, and a missed exact time reads as a broken promise where
 * a missed window reads as a busy office.
 *
 * Exported because `completeCallback` turns the stored index into `dueAt`, and
 * a second copy of these numbers there would drift from what was offered.
 */
export const CALLBACK_WINDOWS = [
  { key: 'callback_window_hour', minutes: 60 },
  { key: 'callback_window_today', minutes: 4 * 60 },
  { key: 'callback_window_tomorrow', minutes: 24 * 60 },
] as const;

export function callbackWindowsAsText(lang: Parameters<typeof t>[0]): string {
  return CALLBACK_WINDOWS.map((w, i) => `${i + 1} — ${t(lang, w.key as any)}`).join('\n');
}

/** The chosen window, or null when nothing valid was stored. */
export function chosenWindow(collected: Record<string, string>) {
  const i = Number.parseInt(collected.when ?? '', 10);
  if (!Number.isFinite(i) || i < 1 || i > CALLBACK_WINDOWS.length) return null;
  return { index: i, ...CALLBACK_WINDOWS[i - 1] };
}

export const CALLBACK_FLOW: FlowDefinition = {
  name: CALLBACK_FLOW_NAME,
  title: 'Callback request',

  slots: [
    {
      name: 'reason',
      label: 'What it is about',
      aliases: ['reason', 'about', 'regarding', 'subject', 'issue'],
      prompt: (_c, lang) => t(lang, 'callback_reason_ask'),
      accept: (text, _c, lang) => {
        const value = text.trim();
        // One or two characters is a stray keypress, not a reason. An officer
        // ringing back with "k" as the subject has to ask from scratch, which
        // is the call the citizen was trying to avoid.
        if (value.length < 3) return { error: t(lang, 'callback_reason_short') };
        return { value };
      },
    },
    {
      name: 'when',
      label: 'When to call',
      aliases: ['when', 'time', 'window'],
      // A bare digit identifies nothing on its own — it is a valid answer to
      // this slot AND to any other numbered list the citizen may be correcting.
      identifies: () => false,
      prompt: (_c, lang) =>
        t(lang, 'callback_when_ask', { options: callbackWindowsAsText(lang) }),
      accept: (text, _c, lang) => {
        const digits = text.trim().match(/^\s*([1-9]\d*)/);
        const i = digits ? Number.parseInt(digits[1], 10) : NaN;
        if (!Number.isFinite(i) || i < 1 || i > CALLBACK_WINDOWS.length) {
          return {
            error: t(lang, 'callback_when_unclear', { options: callbackWindowsAsText(lang) }),
          };
        }
        return { value: String(i) };
      },
      // Staff see the window, not the index it is stored as.
      display: (c) => {
        const w = chosenWindow(c);
        return w ? t('en', w.key as any) : '';
      },
    },
  ],

  summarise: (c, lang) => {
    const w = chosenWindow(c);
    if (!w) return t(lang, 'lost_track');
    return t(lang, 'callback_summary', {
      reason: c.reason ?? '',
      when: t(lang, w.key as any),
    });
  },
};
