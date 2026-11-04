import { Module } from '@nestjs/common';
import { DiagnosticsController } from './diagnostics.controller';
import { ProviderHealthService } from './provider-health.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [DiagnosticsController],
  providers: [ProviderHealthService],
  exports: [ProviderHealthService],
})
export class DiagnosticsModule {}
