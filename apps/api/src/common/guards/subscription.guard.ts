import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SKIP_SUBSCRIPTION_CHECK_KEY } from '../decorators/skip-subscription-check.decorator';
import { prisma } from '@ace/database';

@Injectable()
export class SubscriptionGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const skip = this.reflector.getAllAndOverride<boolean>(
      SKIP_SUBSCRIPTION_CHECK_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (skip) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user || !user.organizationId) {
      return true;
    }

    const org = await prisma.organization.findUnique({
      where: { id: user.organizationId },
      select: { subscriptionStatus: true },
    });

    if (org && (org.subscriptionStatus === 'CANCELLED' || org.subscriptionStatus === 'PAST_DUE')) {
      throw new ForbiddenException('Your subscription is inactive. Please renew at /billing.');
    }

    return true;
  }
}
