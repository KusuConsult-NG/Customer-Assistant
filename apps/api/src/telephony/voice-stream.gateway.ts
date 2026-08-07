/**
 * VoiceStreamGateway — Agent Console Monitor
 *
 * This Socket.IO gateway now has a single responsibility: let browser-based
 * agent console clients monitor live calls in real-time.
 *
 * What changed:
 *   BEFORE: This gateway also processed Twilio audio — which was broken because
 *           Twilio speaks a raw WebSocket protocol, not Socket.IO.
 *   AFTER:  All Twilio audio processing lives in TwilioMediaStreamHandler (plain
 *           `ws`). That handler broadcasts events here via CallBroadcastService.
 *           This gateway only manages room joins/leaves and hands the Socket.IO
 *           server reference to CallBroadcastService.
 *
 * Agent console events it re-broadcasts (emitted by TwilioMediaStreamHandler):
 *   transcript_update    — live STT transcript (partial + final)
 *   audio_waveform_data  — real RMS amplitude for waveform visualisation
 *   ai_thinking          — LLM is processing
 *   ai_audio_response    — AI reply text (browser-only; audio goes to caller)
 *   stream_ended         — call finished + duration + summary
 */

import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { prisma } from '@ace/database';
import { CallBroadcastService } from './call-broadcast.service';
import { authenticateSocket, socketCorsOrigin, SocketIdentity } from '../events/socket-auth';
import { AceLogger } from '../config/logger';

@WebSocketGateway({
  cors:      { origin: socketCorsOrigin(), credentials: true },
  namespace: 'telephony',
})
export class VoiceStreamGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server!: Server;

  private logger = new AceLogger('VoiceStreamGateway');

  /** socket.id → verified identity, populated in handleConnection. */
  private identities = new Map<string, SocketIdentity>();

  constructor(
    private readonly broadcast: CallBroadcastService,
    private readonly jwtService: JwtService
  ) {}

  /** Inject the Socket.IO server into CallBroadcastService so TwilioMediaStreamHandler can use it. */
  afterInit(server: Server): void {
    this.broadcast.setServer(server);
    this.logger.info('voice_stream_gateway_init', {
      event: 'socket_io_server_registered_with_broadcast_service',
    });
  }

  async handleConnection(client: Socket): Promise<void> {
    const identity = await authenticateSocket(client, this.jwtService);

    if (!identity) {
      this.logger.warn('voice_stream_socket_rejected', { socketId: client.id, reason: 'unauthenticated' });
      client.emit('unauthorized', { message: 'A valid access token is required.' });
      client.disconnect(true);
      return;
    }

    this.identities.set(client.id, identity);
    this.logger.info('agent_console_socket_connected', {
      socketId: client.id,
      organizationId: identity.organizationId,
    });
  }

  handleDisconnect(client: Socket): void {
    this.identities.delete(client.id);
    this.logger.info('agent_console_socket_disconnected', { socketId: client.id });
  }

  /**
   * Agent joins the room for a specific call.
   * All events from TwilioMediaStreamHandler for this callSid are received here.
   */
  @SubscribeMessage('monitor_call')
  async handleMonitorCall(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { callSid: string },
  ) {
    const identity = this.identities.get(client.id);
    if (!identity) return { event: 'unauthorized' };

    // Verify the call belongs to the caller's organization before joining its room.
    // Previously any connected client could `monitor_call` any callSid and receive
    // the live transcript of a stranger's phone conversation.
    const callLog = await prisma.callLog.findFirst({
      where: { callSid: payload.callSid, organizationId: identity.organizationId },
      select: { id: true },
    });

    if (!callLog) {
      this.logger.warn('agent_monitor_call_denied', {
        socketId: client.id,
        callSid: payload.callSid,
        organizationId: identity.organizationId,
      });
      return { event: 'forbidden', callSid: payload.callSid };
    }

    client.join(`call_${payload.callSid}`);
    this.logger.info('agent_monitoring_call', { socketId: client.id, callSid: payload.callSid });
    return { event: 'monitoring_started', callSid: payload.callSid };
  }

  /**
   * Agent leaves the monitoring room (e.g. navigates away from call screen).
   */
  @SubscribeMessage('unmonitor_call')
  handleUnmonitorCall(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { callSid: string },
  ) {
    client.leave(`call_${payload.callSid}`);
    return { event: 'monitoring_stopped', callSid: payload.callSid };
  }
}
