import { Module } from '@nestjs/common';
import { SchedulingService } from './scheduling.service';
import { SchedulingController } from './scheduling.controller';
import { AppointmentReminderService } from './appointment-reminder.service';

@Module({
  providers: [SchedulingService, AppointmentReminderService],
  controllers: [SchedulingController],
  exports: [SchedulingService],
})
export class SchedulingModule {}
