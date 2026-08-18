import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { AgentToolsModule } from '../agent-tools/agent-tools.module';
import { AgentConsoleGateway } from './agent-console.gateway';
import { ConversationsController } from './conversations.controller';

@Module({
  // AuthModule exports JwtModule's JwtService, which the gateway uses to verify the
  // handshake token. WhatsappModule provides the outbound send path so an agent's
  // reply actually reaches the customer instead of only being written to the DB.
  // AgentToolsModule provides the live poller the console subscribes to.
  imports: [AuthModule, WhatsappModule, AgentToolsModule],
  controllers: [ConversationsController],
  providers: [AgentConsoleGateway],
  exports: [AgentConsoleGateway],
})
export class EventsModule {}
