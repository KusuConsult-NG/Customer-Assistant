import { JwtService } from '@nestjs/jwt';
import { Socket } from 'socket.io';
import { prisma } from '@ace/database';

export interface SocketIdentity {
  userId: string;
  organizationId: string;
  role: string;
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

  return {
    userId: user.id,
    organizationId: user.organizationId,
    role: user.role,
  };
}

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
