import { JwtService } from '@nestjs/jwt';
import { Socket } from 'socket.io';
import { prisma } from '@ace/database';

export interface SocketIdentity {
  userId: string;
  organizationId: string;
  role: string;
  /** JWT `exp`, in seconds. Enforced for the LIFE of the socket — see the revalidator. */
  tokenExpiresAt?: number;
  /** The version the token carried, re-compared on every sweep. */
  tokenVersion: number;
}

/**
 * Authenticates a Socket.IO connection from its JWT.
 *
 * Both gateways were previously wide open: `cors: { origin: '*' }`, no handshake
 * check, and a `join_organization` handler that joined whatever organizationId the
 * client asked for. Anyone who could reach the server could subscribe to
 * `org_<uuid>` and receive every customer message, call transcript and handoff event
 * for that tenant in real time — and emit `agent_whisper` / `agent_takeover` into it.
 *
 * The identity is derived from the signed token, never from the message payload.
 */
export async function authenticateSocket(
  socket: Socket,
  jwtService: JwtService
): Promise<SocketIdentity | null> {
  const raw =
    (socket.handshake.auth?.token as string | undefined) ??
    (socket.handshake.headers?.authorization as string | undefined)?.replace(/^Bearer\s+/i, '') ??
    (socket.handshake.query?.token as string | undefined);

  if (!raw) return null;

  let payload: any;
  try {
    payload = jwtService.verify(raw);
  } catch {
    return null;
  }

  if (!payload?.userId || !payload?.organizationId) return null;

  // Same checks as JwtStrategy: a revoked or deactivated account must not be able to
  // hold a long-lived socket open past the point its HTTP access was cut off.
  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    select: { id: true, organizationId: true, role: true, isActive: true, tokenVersion: true },
  });

  if (!user || !user.isActive) return null;
  if ((payload.tokenVersion ?? 0) !== user.tokenVersion) return null;

  // A suspended agency stops answering citizens on its members' next HTTP
  // request, because `JwtStrategy` checks this. The socket path did not check
  // it at all, so a suspended agency's console carried on receiving every
  // message, transcript and handoff event in real time.
  const org = await prisma.organization.findUnique({
    where: { id: user.organizationId },
    select: { suspendedAt: true },
  });
  if (!org) return null;
  if (org.suspendedAt && !(await isPlatformOperator(user.id))) return null;

  return {
    userId: user.id,
    organizationId: user.organizationId,
    role: user.role,
    tokenExpiresAt: typeof payload.exp === 'number' ? payload.exp : undefined,
    tokenVersion: user.tokenVersion,
  };
}

/** Operators are exempt from suspension, or a suspension could never be lifted. */
async function isPlatformOperator(userId: string): Promise<boolean> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { isPlatformAdmin: true },
  });
  return !!row?.isPlatformAdmin;
}

/**
 * Why a connected socket is re-checked, and not only authenticated once.
 *
 * `authenticateSocket` runs in `handleConnection` and nowhere else. A socket
 * then stays open for as long as the tab does — hours — streaming every
 * customer message, call transcript and handoff event for that tenant. Nothing
 * revisited the decision, so:
 *
 *   · DEACTIVATING an officer cut their HTTP access on the next request, and
 *     left their open console receiving everything. The comment on
 *     `authenticateSocket` claimed precisely this was prevented.
 *   · LOGGING OUT, or changing a password, bumps `tokenVersion` and kills every
 *     issued token — and did nothing to the socket already holding one.
 *   · SUSPENDING an agency refused every member's next request while their
 *     consoles kept streaming.
 *   · The access token EXPIRED and the socket carried on regardless, so the
 *     expiry bounded HTTP access only.
 *
 * Each of those is a control the product reports as immediate. So the sweep
 * re-runs the same checks on every connected socket and disconnects the ones
 * that no longer pass, with a reason the console can show rather than a silent
 * drop that reads as a network fault.
 *
 * One implementation, shared by both gateways: a second copy is a second thing
 * that can silently stop revoking.
 */
export const SOCKET_REVALIDATE_INTERVAL_MS = 60_000;

export type SocketRevocation =
  | 'token_expired'
  | 'session_signed_out'
  | 'account_deactivated'
  | 'agency_suspended'
  | 'account_removed';

export const REVOCATION_MESSAGES: Record<SocketRevocation, string> = {
  token_expired: 'Your session has expired. Sign in again to continue monitoring.',
  session_signed_out: 'This session was signed out. Sign in again to continue monitoring.',
  account_deactivated: 'Your account has been deactivated. Contact your agency administrator.',
  agency_suspended: 'This agency has been suspended. Contact the Ministry of Information.',
  account_removed: 'This account no longer exists.',
};

/** Re-runs the connect-time checks. Returns null while the socket may stay. */
export async function revalidateIdentity(
  identity: SocketIdentity,
  now: number = Date.now()
): Promise<SocketRevocation | null> {
  if (identity.tokenExpiresAt !== undefined && identity.tokenExpiresAt * 1000 <= now) {
    return 'token_expired';
  }

  const user = await prisma.user.findUnique({
    where: { id: identity.userId },
    select: { isActive: true, tokenVersion: true, organizationId: true, isPlatformAdmin: true },
  });
  if (!user) return 'account_removed';
  if (!user.isActive) return 'account_deactivated';
  if (user.tokenVersion !== identity.tokenVersion) return 'session_signed_out';

  const org = await prisma.organization.findUnique({
    where: { id: user.organizationId },
    select: { suspendedAt: true },
  });
  if (!org) return 'account_removed';
  if (org.suspendedAt && !user.isPlatformAdmin) return 'agency_suspended';

  return null;
}

type RevocationSink = (socketId: string, reason: SocketRevocation) => void;

/**
 * One timer for every gateway, rather than one per gateway per socket.
 *
 * Deliberately a module singleton and not a Nest provider: the two gateways
 * live in different modules (`EventsModule`, `TelephonyModule`), and exporting
 * a provider between them for this would reintroduce the module cycle the
 * telephony module already works around. `prisma` is imported directly here
 * for the same reason.
 */
class SocketRevalidator {
  private readonly tracked = new Map<string, { identity: SocketIdentity; revoke: RevocationSink }>();
  private timer: NodeJS.Timeout | null = null;

  register(socketId: string, identity: SocketIdentity, revoke: RevocationSink): void {
    this.tracked.set(socketId, { identity, revoke });
    this.start();
  }

  unregister(socketId: string): void {
    this.tracked.delete(socketId);
    if (this.tracked.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Exposed for the suite: one sweep, awaited, with no timer involved. */
  async sweep(now: number = Date.now()): Promise<void> {
    for (const [socketId, entry] of [...this.tracked]) {
      let reason: SocketRevocation | null = null;
      try {
        reason = await revalidateIdentity(entry.identity, now);
      } catch {
        // A database blip must not disconnect every watching officer. The next
        // sweep tries again; the socket is no more privileged for having
        // survived one failed check.
        continue;
      }
      if (reason) {
        this.tracked.delete(socketId);
        entry.revoke(socketId, reason);
      }
    }
  }

  private start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.sweep();
    }, SOCKET_REVALIDATE_INTERVAL_MS);
    // Never hold the process open on this alone.
    this.timer.unref?.();
  }
}

export const socketRevalidator = new SocketRevalidator();

/**
 * Allowed WebSocket origins.
 *
 * Socket.IO's CORS check is the only thing standing between a token in a browser and
 * a cross-site page opening a socket with it, so `origin: '*'` is not appropriate for
 * an authenticated namespace. Defaults to the dashboard origin.
 */
export function socketCorsOrigin(): string | string[] | boolean {
  const configured = process.env.CORS_ORIGIN || process.env.WEB_BASE_URL;
  if (!configured || configured === '*') {
    // Development convenience only; production sets CORS_ORIGIN.
    return process.env.NODE_ENV === 'production' ? false : true;
  }
  return configured.split(',').map((o) => o.trim()).filter(Boolean);
}
