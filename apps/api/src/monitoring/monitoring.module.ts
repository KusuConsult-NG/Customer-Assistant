import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DiagnosticsModule } from '../diagnostics/diagnostics.module';
import { AgentToolsModule } from '../agent-tools/agent-tools.module';
import { MonitoringController } from './monitoring.controller';
import { MonitoringService } from './monitoring.service';

@Module({
  imports: [AuthModule, DiagnosticsModule, AgentToolsModule],
  controllers: [MonitoringController],
  providers: [MonitoringService],
})
export class MonitoringModule {}
