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
import { Logger, OnModuleInit } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { authenticateSocket, socketCorsOrigin, SocketIdentity } from './socket-auth';
import {
  ElevenLabsLiveService,
  LiveConversation,
} from '../agent-tools/elevenlabs-live.service';

/**
 * Real-time channel for the agent console.
 *
 * Every connection is authenticated in handleConnection and pinned to the
 * organization named in its JWT. Clients no longer choose their own room.
 */
@WebSocketGateway({
  cors: { origin: socketCorsOrigin(), credentials: true },
  namespace: 'events',
})
export class AgentConsoleGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit
{
  @WebSocketServer()
  server!: Server;

  private logger = new Logger('AgentConsoleGateway');

  /** socket.id → verified identity. */
  private identities = new Map<string, SocketIdentity>();

  constructor(
    private readonly jwtService: JwtService,
    private readonly live: ElevenLabsLiveService
  ) {}

  onModuleInit() {
    // The live poller pushes snapshots through here. Registered this way round
    // because the service must not import the gateway: a two-way import is a
    // cycle Nest resolves by handing one side `undefined` at runtime.
    this.live.attach({
      emitLiveConversations: (organizationId, conversations) =>
        this.notifyLiveConversations(organizationId, conversations),
      emitConversationEnded: (organizationId, conversationId) =>
        this.notifyLiveConversationEnded(organizationId, conversationId),
    });
  }

  async handleConnection(client: Socket) {
    const identity = await authenticateSocket(client, this.jwtService);

    if (!identity) {
      this.logger.warn(`Rejected unauthenticated agent-console socket ${client.id}`);
      client.emit('unauthorized', { message: 'A valid access token is required.' });
      client.disconnect(true);
      return;
    }

    this.identities.set(client.id, identity);

    // Join the caller's own organization room immediately. There is no client-driven
    // room selection any more: `join_organization` used to accept an arbitrary
    // organizationId from the message body and join it without checking.
    client.join(orgRoom(identity.organizationId));

    // Registering interest is what starts the ElevenLabs poller for this
    // tenant. A tenant with nobody at the console generates no provider traffic.
    this.live.watch(identity.organizationId);

    this.logger.log(
      `Agent console connected: socket=${client.id} user=${identity.userId} org=${identity.organizationId}`
    );
  }

  handleDisconnect(client: Socket) {
    const identity = this.identities.get(client.id);
    // Only for a socket that actually registered — an unauthenticated socket
    // was disconnected before watch() was called, and decrementing for it would
    // leave the counter below zero and stop polling for real viewers.
    if (identity) this.live.unwatch(identity.organizationId);

    this.identities.delete(client.id);
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  /**
   * Kept for client compatibility. It acknowledges the room the socket is already in
   * and ignores any organizationId the client supplies.
   */
  @SubscribeMessage('join_organization')
  handleJoinOrg(@ConnectedSocket() client: Socket) {
    const identity = this.identities.get(client.id);
    if (!identity) return { status: 'unauthorized' };
    return { status: 'joined', room: orgRoom(identity.organizationId) };
  }

  @SubscribeMessage('agent_whisper')
  handleWhisper(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { conversationId: string; whisperText: string }
  ) {
    const identity = this.identities.get(client.id);
    if (!identity) return { success: false, error: 'unauthorized' };

    this.server.to(orgRoom(identity.organizationId)).emit('ai_whisper_received', {
      conversationId: payload.conversationId,
      whisperText: payload.whisperText,
      organizationId: identity.organizationId,
      fromUserId: identity.userId,
    });
    return { success: true };
  }

  @SubscribeMessage('agent_takeover')
  handleTakeover(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { conversationId: string }
  ) {
    const identity = this.identities.get(client.id);
    if (!identity) return { success: false, error: 'unauthorized' };

    // Broadcast only. Persisting the handoff is the job of
    // PATCH /api/conversations/:id/handoff, which verifies the conversation belongs
    // to this organization — a socket event must not be able to mutate the database
    // for a conversation id it merely names.
    this.server.to(orgRoom(identity.organizationId)).emit('conversation_takeover_updated', {
      conversationId: payload.conversationId,
      isHumanHandoffActive: true,
      assignedUserId: identity.userId,
    });
    return { success: true };
  }

  // ─── Server-side broadcast helpers ────────────────────────────────────────

  notifyNewMessage(organizationId: string, messageData: any) {
    this.server?.to(orgRoom(organizationId)).emit('new_message_received', messageData);
  }

  notifyCallUpdate(organizationId: string, callData: any) {
    this.server?.to(orgRoom(organizationId)).emit('call_status_updated', callData);
  }

  notifyHandoffChanged(organizationId: string, conversation: any) {
    this.server?.to(orgRoom(organizationId)).emit('conversation_takeover_updated', {
      conversationId: conversation.id,
      isHumanHandoffActive: conversation.isHumanHandoffActive,
      assignedUserId: conversation.assignedUserId,
    });
  }

  notifyTicketCreated(organizationId: string, ticket: any) {
    this.server?.to(orgRoom(organizationId)).emit('new_ticket', ticket);
  }

  notifyLeadCaptured(organizationId: string, lead: any) {
    this.server?.to(orgRoom(organizationId)).emit('new_lead', lead);
  }

  /**
   * What the agent is saying right now, as a full snapshot.
   *
   * Snapshots rather than deltas: the source is a poller, the fan-out spans
   * pods, and a console can connect mid-call. Under those three conditions a
   * duplicate or out-of-order delta produces a garbled transcript, while a
   * duplicate snapshot produces nothing at all.
   */
  notifyLiveConversations(organizationId: string, conversations: LiveConversation[]) {
    this.server?.to(orgRoom(organizationId)).emit('live_conversations', {
      organizationId,
      conversations,
      // Wall-clock of the poll, so a client can show how stale its view is
      // instead of implying it is real-time.
      polledAt: new Date().toISOString(),
    });
  }

  notifyLiveConversationEnded(organizationId: string, conversationId: string) {
    this.server?.to(orgRoom(organizationId)).emit('live_conversation_ended', { conversationId });
  }
}

function orgRoom(organizationId: string): string {
  return `org_${organizationId}`;
}
