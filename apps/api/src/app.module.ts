import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AuthModule } from './auth/auth.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { CrmModule } from './crm/crm.module';
import { TelephonyModule } from './telephony/telephony.module';
import { WhatsappModule } from './whatsapp/whatsapp.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { SchedulingModule } from './scheduling/scheduling.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { BillingModule } from './billing/billing.module';
import { EventsModule } from './events/events.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { WidgetModule } from './widget/widget.module';
import { WorkflowsModule } from './workflows/workflows.module';
import { RedisThrottlerStorage } from './config/redis-throttler-storage';
import { WorkflowTriggerModule } from './workflows/workflow-trigger.module';
import { OnboardingModule } from './onboarding/onboarding.module';

@Module({
  imports: [
    // Rate limiting.
    //
    // IMPORTANT: ThrottlerGuard applies EVERY configured throttler to EVERY route
    // (they are ANDed, not selected by decorator). Registering several named tiers
    // here therefore imposes the *strictest* tier on the whole API — a previous
    // 3-tier config silently capped every endpoint at 5 requests/minute.
    //
    // So there is exactly one tier. Routes that need a different budget override it
    // per-controller/handler with @Throttle({ default: { limit, ttl } }), and webhooks
    // opt out entirely with @SkipThrottle().
    // Storage: Redis-backed when REDIS_URL is set, so counters survive restarts
    // and are shared across pods (in-memory storage silently multiplies the
    // limit by the replica count). Fails open if Redis is down.
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: 60_000, limit: 120 }],
      ...(process.env.REDIS_URL
        ? { storage: new RedisThrottlerStorage(process.env.REDIS_URL) }
        : {}),
    }),
    // Global: lets any module fire workflow triggers without a circular import.
    WorkflowTriggerModule,
    // Global: WhatsApp inbound and the workflow engine both attach selfies.
    OnboardingModule,
    AuthModule,
    OrganizationsModule,
    CrmModule,
    TelephonyModule,
    WhatsappModule,
    KnowledgeModule,
    SchedulingModule,
    AnalyticsModule,
    BillingModule,
    EventsModule,
    WebhooksModule,
    WidgetModule,
    WorkflowsModule,
  ],
  controllers: [AppController],
  providers: [
    // Apply the default throttle tier globally to every route.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    //
    // RolesGuard is deliberately NOT registered globally. Nest runs guards in the
    // order global → controller → route, so a global RolesGuard executes BEFORE the
    // controller's JwtAuthGuard has populated request.user — which made every
    // @Roles()-decorated endpoint reject with 403 unconditionally. It is now applied
    // per-controller *after* JwtAuthGuard: @UseGuards(JwtAuthGuard, RolesGuard).
    //
    // VoiceStreamGateway is likewise not listed here — TelephonyModule already
    // provides it, and declaring it twice bound the same Socket.IO namespace twice.
  ],
})
export class AppModule {}
