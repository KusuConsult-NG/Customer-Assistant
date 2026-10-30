import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { AuthUser } from '@ace/shared-types';

/**
 * The only guard in this codebase that permits a request to see across agencies.
 *
 * Everything else here is built on one rule — every query is scoped by
 * `organizationId`, and there is no automatic tenant filter — so this guard is
 * the single deliberate exception, and it is written to be hard to widen by
 * accident:
 *
 *   - It reads `isPlatformAdmin`, which is a separate column from `role` and is
 *     therefore not writable by the tenant-facing role endpoint. See the note on
 *     `User.isPlatformAdmin` in schema.prisma.
 *   - It is strict about `=== true`. A guard that treats any truthy value as a
 *     pass is one `select` omission away from reading `undefined` and, in a
 *     future refactor, something truthy that is not the flag.
 *   - It must ALWAYS be listed after `JwtAuthGuard`. Nest runs guards
 *     global → controller → route, so on its own it would execute before
 *     authentication and see no user at all. It refuses rather than allowing in
 *     that case, which is the opposite of how SubscriptionGuard failed open in
 *     the code this was repurposed from.
 *
 * It grants visibility of metrics and configuration, never of what a citizen
 * said. See the privacy note in platform.service.ts.
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const user = context.switchToHttp().getRequest().user as AuthUser | undefined;

    if (user?.isPlatformAdmin !== true) {
      // Deliberately the same message whether the caller is unauthenticated, an
      // ordinary agency user, or an agency OWNER: the reply should not confirm
      // that a platform tier exists to someone who may not operate it.
      throw new ForbiddenException('Insufficient permissions');
    }

    return true;
  }
}
