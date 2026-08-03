import { Controller, Get, Post, Patch, Delete, Param, Body, UseGuards, Req } from '@nestjs/common';
import { FaqService } from './faq.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser } from '@ace/shared-types';

@Controller('api/knowledge/faqs')
@UseGuards(JwtAuthGuard)
export class FaqController {
  constructor(private faqService: FaqService) {}

  @Get()
  async getFaqs(@Req() req: { user: AuthUser }) {
    return this.faqService.getFaqs(req.user.organizationId);
  }

  @Post()
  async createFaq(
    @Req() req: { user: AuthUser },
    @Body() body: { question: string; answer: string; category?: string }
  ) {
    return this.faqService.createFaq(req.user.organizationId, body);
  }

  @Patch('reorder')
  async reorderFaqs(
    @Req() req: { user: AuthUser },
    @Body() body: { ids: string[] }
  ) {
    return this.faqService.reorderFaqs(req.user.organizationId, body.ids);
  }

  @Patch(':id')
  async updateFaq(
    @Req() req: { user: AuthUser },
    @Param('id') id: string,
    @Body() body: { question?: string; answer?: string; category?: string }
  ) {
    return this.faqService.updateFaq(req.user.organizationId, id, body);
  }

  @Delete(':id')
  async deleteFaq(
    @Req() req: { user: AuthUser },
    @Param('id') id: string
  ) {
    return this.faqService.deleteFaq(req.user.organizationId, id);
  }
}
