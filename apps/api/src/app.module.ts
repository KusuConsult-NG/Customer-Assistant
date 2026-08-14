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
import { VoiceStreamGateway } from './telephony/voice-stream.gateway';
import { RedisThrottlerStorage } from './config/redis-throttler-storage';

@Module({
  imports: [
    // Rate limiting.
    //
    // IMPORTANT: with @nestjs/throttler, EVERY named throttler passed to forRoot
    // applies to EVERY route simultaneously — named tiers are NOT opt-in via
    // @Throttle({ tier: {} }). The previous config declared an 'auth' tier of
    // 5 req/60s which therefore capped every endpoint in the API at 5 requests
    // per minute per IP (the dashboard polls every 8s → constant 429s).
    //
    // Correct model:
    //   - ONE global 'default' tier: 60 req / 60s per IP per route.
    //   - Stricter auth limit via @Throttle({ default: { limit: 5, ttl: 60_000 } })
    //     on AuthController (see auth.controller.ts).
    //   - Webhooks opt out entirely with @SkipThrottle() — they are protected by
    //     HMAC signature verification, and throttling them loses messages.
    //
    // Storage: Redis-backed when REDIS_URL is set, so counters survive restarts
    // and are shared across pods (in-memory storage silently multiplies the
    // limit by the replica count). Fails open if Redis is down.
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: 60_000, limit: 60 }],
      ...(process.env.REDIS_URL
        ? { storage: new RedisThrottlerStorage(process.env.REDIS_URL) }
        : {}),
    }),
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
    VoiceStreamGateway,
    // Apply default throttle tier globally to every route.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // NOTE: RolesGuard must NOT be registered globally. Global guards run BEFORE
    // controller-level guards, and req.user is only attached when the
    // controller-level JwtAuthGuard (passport) runs — so a global RolesGuard
    // sees user === undefined and returns 403 for EVERY @Roles() route, even for
    // a valid OWNER token. RolesGuard is instead bound per-controller, always
    // AFTER JwtAuthGuard: @UseGuards(JwtAuthGuard, RolesGuard).
  ],
})
export class AppModule {}
