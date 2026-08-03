import { Controller, Get, Post, Delete, Body, Param, Query, Req, UseGuards } from '@nestjs/common';
import { KnowledgeService } from './knowledge.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser } from '@ace/shared-types';

@Controller('api/knowledge')
@UseGuards(JwtAuthGuard)
export class KnowledgeController {
  constructor(private knowledgeService: KnowledgeService) {}

  @Get('documents')
  async getDocuments(@Req() req: { user: AuthUser }) {
    return this.knowledgeService.getDocuments(req.user.organizationId);
  }

  @Post('documents')
  async uploadDocument(
    @Req() req: { user: AuthUser },
    @Body()
    body: {
      title: string;
      fileName: string;
      fileSize: number;
      mimeType: string;
      fileBufferBase64: string; // Base64-encoded file content sent from frontend
    }
  ) {
    // Decode base64 back to Buffer for Supabase Storage upload
    const fileBuffer = Buffer.from(body.fileBufferBase64, 'base64');
    return this.knowledgeService.uploadAndIndexDocument(req.user.organizationId, {
      title: body.title,
      fileName: body.fileName,
      fileSize: body.fileSize,
      mimeType: body.mimeType,
      fileBuffer,
    });
  }

  @Get('search')
  async searchPlayground(@Req() req: { user: AuthUser }, @Query('q') query: string) {
    return this.knowledgeService.searchPlayground(req.user.organizationId, query || '');
  }

  @Post('crawl-website')
  async crawlWebsite(@Req() req: { user: AuthUser }, @Body() body: { url: string }) {
    return this.knowledgeService.crawlAndIndexWebsite(req.user.organizationId, body.url);
  }

  @Delete('documents/:id')
  async deleteDocument(@Req() req: { user: AuthUser }, @Param('id') id: string) {
    return this.knowledgeService.deleteDocument(req.user.organizationId, id);
  }
}

