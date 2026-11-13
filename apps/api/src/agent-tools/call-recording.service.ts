import { BadRequestException, ForbiddenException, HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { AuthUser } from '@ace/shared-types';
import { CALL_RECORDED_EVENT } from '../common/call-case-link';
import { mayHearCall } from '../common/case-visibility';
import { prisma } from '@ace/database';
import { ElevenLabsApi } from './elevenlabs-client';
import {
  elevenLabsConversationFrom,
  elevenLabsRecordingRef,
  isErasedCall,
} from '../common/call-recording';

/** How far either side of a call's start a conversation may begin and still be it. */
const MATCH_WINDOW_SECS = 10 * 60;
/** A recording is a few MB; anything far larger is not a phone call. */
const MAX_BYTES = 60 * 1024 * 1024;

export interface Recording {
  audio: Buffer;
  contentType: string;
}

/**
 * A call's audio, fetched from the ElevenLabs workspace that holds it.
 *
 * See common/call-recording.ts for why there was never anything to play. Two
 * paths reach the audio:
 * - a call ingested from now on carries `elevenlabs:<conversation id>`;
 * - a call ingested earlier carries nothing, so the conversation is FOUND —
 *   the agency's agent, conversations started within ten minutes of the call,
 *   matched on the carrier's call SID — and the reference is saved, so the
 *   search happens once per call.
 *
 * Scoped like everything else here: the call is read by id AND organization,
 * the workspace key is that agency's own (see elevenlabs-client.ts), and the
 * conversation list is filtered to that agency's agent. An erased call is
 * refused before anything is fetched, even though ElevenLabs may still hold
 * its audio.
 */
@Injectable()
export class CallRecordingService {
  private readonly log = new Logger(CallRecordingService.name);

  constructor(private readonly api: ElevenLabsApi) {}

  async fetch(user: AuthUser, callLogId: string): Promise<Recording> {
    const organizationId = user.organizationId;
    const call = await prisma.callLog.findFirst({
      where: { id: callLogId, organizationId },
      select: { id: true, callSid: true, fromNumber: true, recordingUrl: true, startedAt: true },
    });
    if (!call) throw new NotFoundException('No such call.');
    if (isErasedCall(call)) throw new NotFoundException('This call was erased at the citizen’s request; there is nothing to play.');
    await this.assertMayHear(user, call.id);

    const config = await prisma.hostedAgentConfig.findUnique({
      where: { organizationId },
      select: { agentId: true, apiKey: true },
    });
    if (!config?.agentId) {
      throw new NotFoundException('No recording is held for this call: this agency has no voice agent recording its calls.');
    }
    let key: string;
    try {
      key = this.api.keyFor(organizationId, config.apiKey);
    } catch (err) {
      // The shared refusal is worded for the Agent Provisioning screen ("on this
      // page"); here the officer is on the call list or a case.
      if (err instanceof HttpException) {
        throw new BadRequestException(
          'Recordings cannot be played yet: this agency’s ElevenLabs workspace is not connected. An administrator ' +
            'adds its API key at Agent Provisioning → Credentials.'
        );
      }
      throw err;
    }
    const client: any = this.api.for(key);

    let conversationId = elevenLabsConversationFrom(call.recordingUrl);
    if (!conversationId) {
      const found = await this.findConversation(client, config.agentId, call);
      if (found?.hasAudio === false) {
        throw new NotFoundException('No recording is held for this call: ElevenLabs kept no audio for it.');
      }
      conversationId = found?.id ?? null;
      if (!conversationId) {
        throw new NotFoundException(
          'No recording is held for this call. The voice agent has no conversation matching it — it may have been ' +
            'answered another way, or the recording has passed the workspace’s retention period.'
        );
      }
      await prisma.callLog.update({
        where: { id: call.id },
        data: { recordingUrl: elevenLabsRecordingRef(conversationId) },
      });
    }

    let stream: ReadableStream<Uint8Array>;
    try {
      stream = await client.conversationalAi.conversations.audio.get(conversationId);
    } catch (err) {
      if (this.api.isNotFound(err)) {
        throw new NotFoundException(
          'No recording is held for this call: ElevenLabs has no audio for it (it may have passed the retention period).'
        );
      }
      return this.api.fail('fetching the call recording', err);
    }
    const audio = await this.collect(stream);
    if (!audio.length) throw new NotFoundException('No recording is held for this call: ElevenLabs returned no audio.');
    this.log.log(`call_recording_served org=${organizationId} call=${call.id} bytes=${audio.length}`);
    return { audio, contentType: 'audio/mpeg' };
  }

  /**
   * A voice identifies somebody even when a transcript does not. So a call
   * attached to a case that withholds its reporter (anonymous) or restricts who
   * sees it (sensitive) is played only to those the case itself would show it
   * to — the same rule CasesService applies to the case. A liaison never hears
   * the State's own call record.
   */
  private async assertMayHear(user: AuthUser, callLogId: string) {
    const links = await prisma.caseEvent.findMany({
      where: { organizationId: user.organizationId, type: CALL_RECORDED_EVENT, body: { startsWith: `Call recorded: ${callLogId}` } },
      select: { ticket: { select: { isAnonymous: true, isSensitive: true, assignedUserId: true } } },
    });
    for (const { ticket } of links) {
      if (ticket && !mayHearCall(user, ticket)) {
        throw new ForbiddenException('This call belongs to a confidential report. Only an administrator, or the officer assigned to it, can play it.');
      }
    }
  }

  /** The agency agent's conversation for this call, matched on the carrier's call SID. */
  private async findConversation(
    client: any,
    agentId: string,
    call: { callSid: string; startedAt: Date }
  ): Promise<{ id: string; hasAudio?: boolean } | null> {
    const at = Math.floor(call.startedAt.getTime() / 1000);
    let cursor: string | undefined;
    for (let page = 0; page < 3; page++) {
      const res: any = await client.conversationalAi.conversations.list({
        agentId,
        pageSize: 30,
        callStartAfterUnix: at - MATCH_WINDOW_SECS,
        callStartBeforeUnix: at + MATCH_WINDOW_SECS,
        ...(cursor ? { cursor } : {}),
      });
      for (const summary of res?.conversations ?? []) {
        // A call stored without a carrier SID is keyed on the conversation id.
        if (summary?.conversationId === call.callSid) return { id: summary.conversationId };
        const full: any = await client.conversationalAi.conversations.get(summary.conversationId);
        if (full?.metadata?.phoneCall?.callSid === call.callSid) {
          return { id: summary.conversationId, hasAudio: full.hasAudio };
        }
      }
      if (!res?.hasMore || !res?.nextCursor) break;
      cursor = res.nextCursor;
    }
    return null;
  }

  private async collect(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
    const reader = stream.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new NotFoundException('This recording is too large to play here.');
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }
}
