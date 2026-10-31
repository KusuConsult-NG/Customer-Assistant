import { AuthUser } from '@ace/shared-types';
import type { Actor } from '@ace/database';

/**
 * Who is making a change, for the audit record.
 *
 * `ip` is optional in the parameter type and present at runtime — Express
 * populates it — so a route declared as `{ user: AuthUser }` satisfies this
 * without every one of them having to redeclare a field it does not
 * otherwise use.
 *
 * Shared rather than redefined per controller: five modules now write audit
 * records, and an actor assembled slightly differently in each is how a trail
 * ends up with rows nobody can join together.
 */
export const actorFrom = (req: { user: AuthUser; ip?: string }): Actor => ({
  userId: req.user.userId,
  ipAddress: req.ip ?? null,
});
