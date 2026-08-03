import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
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
import { RolesGuard } from './common/guards/roles.guard';

@Module({
  imports: [
    // Rate limiting — 3 named tiers used via @Throttle({ <tier>: {} }) decorator
    // 'auth'    : 5  requests / 60s  — login, register, forgot-password
    // 'default' : 60 requests / 60s  — all authenticated API routes
    // 'webhooks': 300 requests / 60s — Meta WhatsApp + Twilio + Paystack webhooks (bursting allowed)
    ThrottlerModule.forRoot([
      { name: 'auth',     ttl: 60_000, limit: 5   },
      { name: 'default',  ttl: 60_000, limit: 60  },
      { name: 'webhooks', ttl: 60_000, limit: 300 },
    ]),
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
  providers: [
    VoiceStreamGateway,
    // Apply the default throttle tier globally to every route.
    // Individual routes override with @Throttle({ auth: {} }) or @SkipThrottle()
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
