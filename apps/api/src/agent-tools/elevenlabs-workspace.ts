/**
 * Whose ElevenLabs workspace a tenant is operating in.
 *
 * ── The problem ─────────────────────────────────────────────────────────────
 *
 * An ElevenLabs workspace has no tenancy of its own. Everything inside one — the
 * agents, the phone numbers, the WhatsApp lines, and every conversation
 * transcript — belongs to whoever holds the key. So a platform that puts all its
 * tenants behind one shared `ELEVENLABS_API_KEY` has put all of their customers'
 * conversations in one bucket, and the only thing keeping them apart is our own
 * filtering code being right every single time.
 *
 * That filtering exists (see ElevenLabsNumbersService) and it is not nothing.
 * But it is a defence that has to be re-applied correctly at every new listing
 * endpoint anyone ever adds. A per-tenant workspace makes the boundary the
 * provider's problem instead of ours, which is the only version that stays true
 * when somebody forgets.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *
 * A tenant-scoped operation requires that tenant's own key. Falling back to the
 * shared one is permitted ONLY when ELEVENLABS_ALLOW_SHARED_WORKSPACE is set —
 * a deliberate switch for single-tenant deployments, demos and local
 * development, where "every tenant" is one tenant and the distinction is moot.
 *
 * Deliberately not inferred from NODE_ENV. A security boundary that changes
 * shape depending on an environment variable nobody set on purpose is one
 * nobody can reason about; this one is off unless somebody typed it.
 *
 * ── This is a breaking change, and that is the point ────────────────────────
 *
 * A deployment running today on ELEVENLABS_API_KEY alone will start refusing
 * tenant operations until either each tenant has a key or the flag is set. That
 * is the intended behaviour: silently continuing to share is the failure being
 * fixed. Nothing has ever served a real customer through this path, so the cost
 * of the break is a configuration line, not an outage.
 */
import { BadRequestException } from '@nestjs/common';

export type WorkspaceMode = 'dedicated' | 'shared';

export interface WorkspaceResolution {
  apiKey: string;
  mode: WorkspaceMode;
}

export function sharedWorkspaceAllowed(): boolean {
  const raw = (process.env.ELEVENLABS_ALLOW_SHARED_WORKSPACE ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

/**
 * Why a tenant cannot act, phrased for whoever has to fix it.
 *
 * Both halves are named because the reader is usually an operator who does not
 * know a shared-workspace mode exists, and the honest answer is that there are
 * two ways forward with very different consequences.
 */
export function sharedWorkspaceRefusal(organizationId: string): BadRequestException {
  return new BadRequestException(
    `This organization has no ElevenLabs API key of its own, so it would have to share a workspace with every other tenant — including their phone numbers, WhatsApp lines and conversation transcripts. ` +
      `Give it its own key (POST /api/agent-provisioning/credentials), or, if this deployment genuinely serves one tenant, set ELEVENLABS_ALLOW_SHARED_WORKSPACE=1. ` +
      `Organization: ${organizationId}.`
  );
}

/**
 * Where a tenant's own workspace should send its post-call webhook.
 *
 * Path-scoped because a dedicated workspace signs with its OWN secret, and the
 * signature has to be checked before the body is parsed — so the tenant has to
 * be identifiable from the URL alone. One source of truth for the path, because
 * it is quoted back to operators in the credentials status and a shape that
 * drifts from the route is a 404 nobody can diagnose from the dashboard.
 */
export function tenantWebhookPath(organizationId: string): string {
  return `/api/webhooks/elevenlabs/${organizationId}`;
}

/** The absolute URL for the same, using whatever base this deployment answers on. */
export function tenantWebhookUrl(organizationId: string): string {
  const base = (process.env.API_BASE_URL || process.env.API_URL || 'http://localhost:4000').replace(
    /\/+$/,
    ''
  );
  return `${base}${tenantWebhookPath(organizationId)}`;
}
