import { Module } from '@nestjs/common';
import { AgentConsoleGateway } from './agent-console.gateway';
import { ConversationsController } from './conversations.controller';

@Module({
  controllers: [ConversationsController],
  providers: [AgentConsoleGateway],
  exports: [AgentConsoleGateway],
})
export class EventsModule {}
