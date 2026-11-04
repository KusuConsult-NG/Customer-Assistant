/**
 * A console socket must stop receiving citizen data when access is revoked.
 *
 * `authenticateSocket` ran in `handleConnection` and NOWHERE else. A socket
 * then stays open as long as the tab does — hours — streaming every customer
 * message, call transcript and handoff event for that tenant. Nothing revisited
 * the decision, so four controls the product reports as immediate were not:
 *
 *   · deactivating an officer cut HTTP on the next request and left their open
 *     console receiving everything. The comment on `authenticateSocket`
 *     claimed exactly this was prevented;
 *   · logging out or changing a password bumps `tokenVersion`, killing every
 *     issued token, and did nothing to the socket already holding one;
 *   · suspending an agency refused every member's next request while their
 *     consoles kept streaming — and suspension was not even checked at connect;
 *   · the access token expired and the socket carried on, so the expiry bounded
 *     HTTP access only.
 *
 * These tests drive the real checks against real rows. The sweep is awaited
 * directly rather than waited on through its timer: what matters is the
 * DECISION, and a test that sleeps for an interval is a test that gets its
 * interval shortened until it is meaningless.
 */
import { randomBytes } from 'crypto';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@ace/database';
import {
  revalidateIdentity,
  socketRevalidator,
  REVOCATION_MESSAGES,
  SOCKET_REVALIDATE_INTERVAL_MS,
  type SocketIdentity,
  type SocketRevocation,
} from '../src/events/socket-auth';

describe('console socket revocation', () => {
  let orgId: string;
  let otherOrgId: string;

  jest.setTimeout(60000);

  const mkOrg = async (label: string) =>
    (await prisma.organization.create({
      data: { name: label, slug: `${label}-${randomBytes(4).toString('hex')}`, industry: 'GOVERNMENT' },
    })).id;

  beforeAll(async () => {
    orgId = await mkOrg('socketrevoke');
    otherOrgId = await mkOrg('socketrevoke-other');
  });

  afterAll(async () => {
    for (const id of [orgId, otherOrgId]) {
      await prisma.user.deleteMany({ where: { organizationId: id } });
      await prisma.organization.delete({ where: { id } }).catch(() => undefined);
    }
  });

  const makeOfficer = async (overrides: Record<string, unknown> = {}) => {
    const user = await prisma.user.create({
      data: {
        organizationId: orgId,
        email: `sock.${randomBytes(5).toString('hex')}@revoke.test`,
        fullName: 'Console Officer',
        role: 'AGENT',
        passwordHash: await bcrypt.hash('SocketPassw0rd!', 10),
        emailVerifiedAt: new Date(),
        ...overrides,
      },
    });
    const identity: SocketIdentity = {
      userId: user.id,
      organizationId: user.organizationId,
      role: user.role,
      tokenVersion: user.tokenVersion,
      // An hour out, so expiry is not what any of these tests trip over.
      tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
    return { user, identity };
  };

  it('lets a live officer stay connected', async () => {
    const { identity } = await makeOfficer();
    expect(await revalidateIdentity(identity)).toBeNull();
  });

  it('revokes a deactivated officer', async () => {
    const { user, identity } = await makeOfficer();
    await prisma.user.update({ where: { id: user.id }, data: { isActive: false } });
    // The console stops receiving citizen messages, rather than keeping them
    // until somebody closes the tab.
    expect(await revalidateIdentity(identity)).toBe('account_deactivated');
  });

  it('revokes a session that was signed out', async () => {
    const { user, identity } = await makeOfficer();
    // What logout and a password change both do.
    await prisma.user.update({ where: { id: user.id }, data: { tokenVersion: { increment: 1 } } });
    expect(await revalidateIdentity(identity)).toBe('session_signed_out');
  });

  it('revokes every socket in a suspended agency', async () => {
    const { identity } = await makeOfficer();
    await prisma.organization.update({
      where: { id: orgId },
      data: { suspendedAt: new Date(), suspendedReason: 'Audit in progress' },
    });
    try {
      expect(await revalidateIdentity(identity)).toBe('agency_suspended');
    } finally {
      await prisma.organization.update({
        where: { id: orgId },
        data: { suspendedAt: null, suspendedReason: null },
      });
    }
  });

  it('keeps a platform operator connected through a suspension', async () => {
    const { identity } = await makeOfficer({ isPlatformAdmin: true });
    await prisma.organization.update({
      where: { id: orgId },
      data: { suspendedAt: new Date(), suspendedReason: 'Audit in progress' },
    });
    try {
      // Operators are exempt, or a suspension could never be lifted — the same
      // exemption JwtStrategy makes.
      expect(await revalidateIdentity(identity)).toBeNull();
    } finally {
      await prisma.organization.update({
        where: { id: orgId },
        data: { suspendedAt: null, suspendedReason: null },
      });
    }
  });

  it('revokes an expired token, so the expiry bounds the socket too', async () => {
    const { identity } = await makeOfficer();
    const expired = { ...identity, tokenExpiresAt: Math.floor(Date.now() / 1000) - 1 };
    expect(await revalidateIdentity(expired)).toBe('token_expired');
    // Checked BEFORE the database: an expired token needs no query to refuse.
    expect(await revalidateIdentity(expired, Date.now())).toBe('token_expired');
  });

  it('revokes a deleted account', async () => {
    const { user, identity } = await makeOfficer();
    await prisma.user.delete({ where: { id: user.id } });
    expect(await revalidateIdentity(identity)).toBe('account_removed');
  });

  describe('the sweep', () => {
    it('disconnects exactly the sockets that lost access', async () => {
      const staying = await makeOfficer();
      const leaving = await makeOfficer();

      const revoked: Array<{ socketId: string; reason: SocketRevocation }> = [];
      const sink = (socketId: string, reason: SocketRevocation) => revoked.push({ socketId, reason });

      socketRevalidator.register('sock-staying', staying.identity, sink);
      socketRevalidator.register('sock-leaving', leaving.identity, sink);

      try {
        await prisma.user.update({ where: { id: leaving.user.id }, data: { isActive: false } });
        await socketRevalidator.sweep();

        expect(revoked).toEqual([{ socketId: 'sock-leaving', reason: 'account_deactivated' }]);

        // And it does not revoke twice: the entry is dropped when it fires, so
        // a second sweep does not re-emit for a socket already gone.
        await socketRevalidator.sweep();
        expect(revoked).toHaveLength(1);
      } finally {
        socketRevalidator.unregister('sock-staying');
        socketRevalidator.unregister('sock-leaving');
      }
    });

    it('leaves sockets alone when the database cannot answer', async () => {
      const { identity } = await makeOfficer();
      const revoked: string[] = [];
      socketRevalidator.register('sock-blip', identity, (socketId) => revoked.push(socketId));

      const spy = jest.spyOn(prisma.user, 'findUnique').mockRejectedValue(new Error('pool timeout'));
      try {
        await socketRevalidator.sweep();
        // A database blip must not disconnect every watching officer at once.
        // The socket is no more privileged for having survived one failed
        // check — the next sweep asks again.
        expect(revoked).toEqual([]);
      } finally {
        spy.mockRestore();
        socketRevalidator.unregister('sock-blip');
      }
    });

    it('stops sweeping once nothing is connected', async () => {
      const { identity } = await makeOfficer();
      socketRevalidator.register('sock-only', identity, () => undefined);
      socketRevalidator.unregister('sock-only');
      // Nothing to assert beyond it not throwing and not holding the process
      // open: the timer is unref'd and cleared when the last socket goes.
      await expect(socketRevalidator.sweep()).resolves.toBeUndefined();
    });

    it('sweeps well inside the shortest token lifetime', () => {
      // A minute. Long enough not to query per socket per second, short enough
      // that "revoked immediately" is true to within a minute rather than
      // within however long an officer leaves a tab open.
      expect(SOCKET_REVALIDATE_INTERVAL_MS).toBeLessThanOrEqual(60_000);
    });
  });

  it('gives every revocation a reason an officer can act on', () => {
    // A silent disconnect reads as a network fault, so the officer reconnects
    // and wonders why it keeps happening.
    for (const [reason, message] of Object.entries(REVOCATION_MESSAGES)) {
      expect(message.length).toBeGreaterThan(20);
      expect(message).not.toMatch(/error|failed|unauthorized/i);
      expect(reason).toMatch(/^[a-z_]+$/);
    }
  });
});
