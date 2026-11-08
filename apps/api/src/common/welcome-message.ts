/**
 * What a caller hears first, on EITHER voice channel.
 *
 * ── The bug this exists to catch ────────────────────────────────────────────
 *
 * The Twilio media-stream handler greets the caller: it reads
 * `Organization.welcomeMessage`, falls back to a default, and streams it as
 * the first thing that happens on the call.
 *
 * The WhatsApp call bridge did not. `say()` was reachable only from a final
 * Deepgram transcript, so a citizen who called the agency on WhatsApp had the
 * call ACCEPTED and then heard nothing at all until they spoke first. Most
 * people, hearing silence on a connected call, say "hello?" — which is then
 * transcribed and answered, so this was not a total failure. It was worse than
 * that: it was a product whose first impression is dead air, with nothing
 * logged, no error anywhere, and a `CallLog` reporting the call as answered.
 *
 * The two channels are deliberately the same function rather than two copies
 * of the same literal, because the previous arrangement already proves what
 * two copies do: one of them greets and the other does not, and nothing
 * compares them.
 */
import { prisma } from '@ace/database';

/**
 * The fallback when an agency has configured nothing.
 *
 * Deliberately channel-neutral — "calling" is true of a WhatsApp call and a
 * phone call alike.
 */
export const DEFAULT_WELCOME_MESSAGE = 'Hello! Thank you for calling. How can I help you today?';

/**
 * The agency's greeting, or the default.
 *
 * NEVER THROWS and never returns empty. This runs on a live, already-answered
 * call: a database blip must cost the agency's wording, not the greeting
 * itself, because the alternative is the silence this function exists to
 * remove.
 */
export async function welcomeMessageFor(organizationId: string | null | undefined): Promise<string> {
  if (!organizationId) return DEFAULT_WELCOME_MESSAGE;
  try {
    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { welcomeMessage: true },
    });
    const configured = org?.welcomeMessage?.trim();
    return configured || DEFAULT_WELCOME_MESSAGE;
  } catch {
    return DEFAULT_WELCOME_MESSAGE;
  }
}
