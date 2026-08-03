import { Module } from '@nestjs/common';
import { KnowledgeService } from './knowledge.service';
import { KnowledgeController } from './knowledge.controller';
import { FaqService } from './faq.service';
import { FaqController } from './faq.controller';

@Module({
  providers: [KnowledgeService, FaqService],
  controllers: [KnowledgeController, FaqController],
  exports: [KnowledgeService, FaqService],
})
export class KnowledgeModule {}
