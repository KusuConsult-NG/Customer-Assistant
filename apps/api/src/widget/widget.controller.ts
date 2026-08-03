import { Controller, Get, Post, Body, Query } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { WidgetService } from './widget.service';

@Controller('api/widget')
@SkipThrottle()
export class WidgetController {
  constructor(private widgetService: WidgetService) {}

  @Get('config')
  async getConfig(@Query('apiKey') apiKey: string) {
    return this.widgetService.getWidgetConfig(apiKey || '');
  }

  @Post('chat')
  async processChat(
    @Body() body: {
      apiKey?: string;
      sessionId: string;
      message: string;
      customerName?: string;
      customerEmail?: string;
      customerPhone?: string;
    }
  ) {
    return this.widgetService.processWidgetChat(body);
  }

  @Get('history')
  async getHistory(@Query('apiKey') apiKey: string, @Query('sessionId') sessionId: string) {
    return this.widgetService.getSessionHistory(apiKey || '', sessionId || '');
  }
}
