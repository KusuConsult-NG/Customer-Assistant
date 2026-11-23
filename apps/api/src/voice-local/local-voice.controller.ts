import { Body, Controller, ForbiddenException, Get, Header, HttpCode, Param, Post, Query } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { LocalVoiceService } from './local-voice.service';

/**
 * Called by Asterisk's CURL() on the same server, never by a browser. Plain
 * text replies because the dialplan reads them with CUT(): `ok <uuid>`,
 * `fallback <reason>`, or an outcome word. Authenticated by the shared
 * LOCAL_VOICE_SECRET that only the API and the bridge's config hold.
 *
 * A wrong secret is 403 — and the dialplan treats anything but `ok` as
 * fallback, so even a misconfigured secret costs the caller nothing: they get
 * the ElevenLabs agent, exactly as before this existed.
 */
@SkipThrottle()
@Controller('api/voice-local')
export class LocalVoiceController {
  constructor(private readonly voice: LocalVoiceService) {}

  @Post('register')
  @HttpCode(200)
  @Header('Content-Type', 'text/plain')
  async register(@Body() body: { secret?: string; from?: string; to?: string }): Promise<string> {
    if (!this.voice.secretMatches(body?.secret)) throw new ForbiddenException('fallback bad-secret');
    return this.voice.register(body?.from ?? '', body?.to ?? '');
  }

  @Get('outcome/:uuid')
  @Header('Content-Type', 'text/plain')
  outcome(@Param('uuid') uuid: string, @Query('secret') secret: string): string {
    if (!this.voice.secretMatches(secret)) throw new ForbiddenException('fallback bad-secret');
    return this.voice.outcomeOf(uuid);
  }
}
