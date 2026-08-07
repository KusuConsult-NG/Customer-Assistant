import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { WidgetService } from './widget.service';
import { WidgetChatDto } from './widget.dto';

/**
 * Public, unauthenticated endpoints hit directly by the embedded widget script.
 *
 * These are rate limited, not exempt.
 *
 * `@SkipThrottle()` used to be applied to the whole controller. /chat is
 * unauthenticated and calls OpenAI on every request, so an unthrottled endpoint
 * let anyone with the public embed key run up the tenant's model bill (and ours)
 * as fast as they could issue requests. 30 messages/minute per IP is far above
 * what a human typing in a chat window produces.
 */
@Controller('api/widget')
export class WidgetController {
  constructor(private widgetService: WidgetService) {}

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('config')
  async getConfig(@Query('apiKey') apiKey: string, @Query('orgId') orgId?: string) {
    return this.widgetService.getWidgetConfig(apiKey || orgId || '');
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('chat')
  async processChat(@Body() body: WidgetChatDto) {
    return this.widgetService.processWidgetChat({
      ...body,
      apiKey: body.apiKey || body.orgId,
    });
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('history')
  async getHistory(
    @Query('apiKey') apiKey: string,
    @Query('sessionId') sessionId: string,
    @Query('orgId') orgId?: string
  ) {
    return this.widgetService.getSessionHistory(apiKey || orgId || '', sessionId || '');
  }
}
