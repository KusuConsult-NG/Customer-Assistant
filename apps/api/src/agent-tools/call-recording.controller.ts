import { Controller, Get, Header, Param, ParseUUIDPipe, Req, StreamableFile, UseGuards } from '@nestjs/common';
import { AuthUser } from '@ace/shared-types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CallRecordingService } from './call-recording.service';

/**
 * Playing a call back. Same audience as the call list and its transcripts
 * (`GET /api/telephony/calls`): any member of the agency. The browser cannot
 * open the audio itself — it is fetched with the agency's ElevenLabs key — so
 * the dashboard fetches this with its token and plays the bytes.
 */
@Controller('api/calls')
@UseGuards(JwtAuthGuard)
export class CallRecordingController {
  constructor(private readonly recordings: CallRecordingService) {}

  @Get(':id/recording')
  @Header('Cache-Control', 'private, no-store')
  async recording(@Req() req: { user: AuthUser }, @Param('id', ParseUUIDPipe) id: string): Promise<StreamableFile> {
    const { audio, contentType } = await this.recordings.fetch(req.user, id);
    return new StreamableFile(audio, { type: contentType, length: audio.length });
  }
}
