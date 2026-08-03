import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';

@WebSocketGateway({
  cors: {
    origin: '*',
  },
  namespace: 'events',
})
export class AgentConsoleGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private logger = new Logger('AgentConsoleGateway');

  handleConnection(client: Socket) {
    this.logger.log(`Client connected to Agent Console Gateway: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  @SubscribeMessage('join_organization')
  handleJoinOrg(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { organizationId: string; userId: string }
  ) {
    client.join(`org_${payload.organizationId}`);
    this.logger.log(`User ${payload.userId} joined room org_${payload.organizationId}`);
    return { status: 'joined', room: `org_${payload.organizationId}` };
  }

  @SubscribeMessage('agent_whisper')
  handleWhisper(
    @MessageBody() payload: { conversationId: string; whisperText: string; organizationId: string }
  ) {
    this.logger.log(`Agent whisper on conversation ${payload.conversationId}: ${payload.whisperText}`);
    this.server.to(`org_${payload.organizationId}`).emit('ai_whisper_received', payload);
    return { success: true };
  }

  @SubscribeMessage('agent_takeover')
  handleTakeover(
    @MessageBody() payload: { conversationId: string; agentId: string; organizationId: string }
  ) {
    this.logger.log(`Agent ${payload.agentId} took over conversation ${payload.conversationId}`);
    this.server.to(`org_${payload.organizationId}`).emit('conversation_takeover_updated', {
      conversationId: payload.conversationId,
      isHumanHandoffActive: true,
      assignedUserId: payload.agentId,
    });
    return { success: true };
  }

  notifyNewMessage(organizationId: string, messageData: any) {
    this.server.to(`org_${organizationId}`).emit('new_message_received', messageData);
  }

  notifyCallUpdate(organizationId: string, callData: any) {
    this.server.to(`org_${organizationId}`).emit('call_status_updated', callData);
  }
}
