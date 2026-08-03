/**
 * CallBroadcastService
 *
 * A shared singleton that decouples the Twilio Media Stream handler (plain `ws`)
 * from the Socket.IO agent-console gateway.
 *
 * Why a shared service:
 *   - TwilioMediaStreamHandler processes audio on a raw WebSocket connection.
 *   - VoiceStreamGateway holds the Socket.IO server that pushes live events
 *     to the agent console browser tab.
 *   - Neither can directly import the other without circular dependencies.
 *   - This service is the bridge: the gateway calls setServer() once on init,
 *     and the handler calls emit() to broadcast to any room.
 */

import { Injectable } from '@nestjs/common';
import { Server } from 'socket.io';

@Injectable()
export class CallBroadcastService {
  private server: Server | null = null;

  /** Called by VoiceStreamGateway.afterInit() once Socket.IO is ready. */
  setServer(server: Server): void {
    this.server = server;
  }

  /**
   * Broadcast any event to all agent-console clients monitoring a call.
   * Silently no-ops if the server is not yet initialised.
   */
  emit(callSid: string, event: string, data: unknown): void {
    try {
      this.server?.to(`call_${callSid}`).emit(event, data);
    } catch {
      // Never crash the call because a broadcast failed
    }
  }
}
