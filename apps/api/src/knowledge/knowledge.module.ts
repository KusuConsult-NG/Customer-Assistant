import { Module } from '@nestjs/common';
import { KnowledgeService } from './knowledge.service';
import { KnowledgeController } from './knowledge.controller';
import { FaqService } from './faq.service';
import { FaqController } from './faq.controller';
import { DocumentWorkerHost } from './document-worker.host';

@Module({
  // DocumentWorkerHost starts the BullMQ ingestion worker in-process when
  // REDIS_URL is set — without it, enqueued uploads are never consumed.
  providers: [KnowledgeService, FaqService, DocumentWorkerHost],
  controllers: [KnowledgeController, FaqController],
  exports: [KnowledgeService, FaqService],
})
export class KnowledgeModule {}
