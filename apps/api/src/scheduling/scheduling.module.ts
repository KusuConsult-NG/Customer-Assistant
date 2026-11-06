import { Module } from '@nestjs/common';
import { SchedulingService } from './scheduling.service';
import { SchedulingController } from './scheduling.controller';
import { AppointmentReminderService } from './appointment-reminder.service';
import { WebhooksModule } from '../webhooks/webhooks.module';

@Module({
  // For `appointment.booked`. WebhooksModule is a leaf — one provider over
  // Prisma — so importing it adds no cycle.
  imports: [WebhooksModule],
  providers: [SchedulingService, AppointmentReminderService],
  controllers: [SchedulingController],
  exports: [SchedulingService],
})
export class SchedulingModule {}
