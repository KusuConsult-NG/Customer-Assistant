import { Controller, Get, Post, Delete, Body, Param, Query, Req, UseGuards } from '@nestjs/common';
import { KnowledgeService } from './knowledge.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthUser } from '@ace/shared-types';
import { CrawlWebsiteDto, UploadDocumentDto } from './knowledge.dto';

// RolesGuard follows JwtAuthGuard: guards execute in the order given, and RolesGuard
// needs request.user. Registering it globally (as before) ran it first, so every
// @Roles() route here returned 403 no matter who called it.
@Controller('api/knowledge')
@UseGuards(JwtAuthGuard, RolesGuard)
export class KnowledgeController {
  constructor(private knowledgeService: KnowledgeService) {}

  @Get('documents')
  async getDocuments(@Req() req: { user: AuthUser }) {
    return this.knowledgeService.getDocuments(req.user.organizationId);
  }

  @Roles('OWNER', 'ADMIN')
  @Post('documents')
  async uploadDocument(@Req() req: { user: AuthUser }, @Body() body: UploadDocumentDto) {
    // Decode base64 back to Buffer for Supabase Storage upload.
    const fileBuffer = Buffer.from(body.fileBufferBase64, 'base64');

    // Trust the decoded length, not the client-supplied fileSize: the size limit is
    // meaningless if the caller can simply declare a small number alongside a
    // 200 MB payload.
    return this.knowledgeService.uploadAndIndexDocument(req.user.organizationId, {
      title: body.title,
      fileName: body.fileName,
      fileSize: fileBuffer.byteLength,
      mimeType: body.mimeType,
      fileBuffer,
    });
  }

  /**
   * Short-lived signed download URL for an uploaded document.
   *
   * KnowledgeService.getDocumentDownloadUrl already existed but nothing routed to it,
   * so an uploaded file could be stored and never retrieved again through the API.
   */
  @Get('documents/:id/download')
  async downloadDocument(@Req() req: { user: AuthUser }, @Param('id') id: string) {
    const url = await this.knowledgeService.getDocumentDownloadUrl(req.user.organizationId, id);
    return { url, expiresInSeconds: 3600 };
  }

  @Get('search')
  async searchPlayground(@Req() req: { user: AuthUser }, @Query('q') query: string) {
    return this.knowledgeService.searchPlayground(req.user.organizationId, query || '');
  }

  @Roles('OWNER', 'ADMIN')
  @Post('crawl-website')
  async crawlWebsite(@Req() req: { user: AuthUser }, @Body() body: CrawlWebsiteDto) {
    return this.knowledgeService.crawlAndIndexWebsite(req.user.organizationId, body.url);
  }

  @Roles('OWNER', 'ADMIN')
  @Delete('documents/:id')
  async deleteDocument(@Req() req: { user: AuthUser }, @Param('id') id: string) {
    return this.knowledgeService.deleteDocument(req.user.organizationId, id);
  }
}

