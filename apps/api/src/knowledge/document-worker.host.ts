import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Worker } from 'bullmq';
import { startDocumentWorker } from './document.worker';
import { AceLogger } from '../config/logger';

const log = new AceLogger('DocumentWorkerHost');

/**
 * Hosts the BullMQ document-ingestion worker inside the API process.
 *
 * Why this exists: KnowledgeService enqueues 'process_document' jobs whenever
 * REDIS_URL is set — but no process ever consumed them (document.worker.ts was
 * never imported, and no deploy manifest started it separately), so configuring
 * Redis silently BROKE document indexing: uploads stayed PENDING forever.
 *
 * This host starts the worker when REDIS_URL is set and closes it gracefully on
 * shutdown. To scale ingestion independently later, run additional dedicated
 * worker processes that call startDocumentWorker() — BullMQ's Redis locking
 * makes concurrent consumers safe.
 */
@Injectable()
export class DocumentWorkerHost implements OnModuleInit, OnModuleDestroy {
  private worker: Worker | null = null;

  onModuleInit(): void {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      log.info('document_worker_skipped', {
        reason: 'REDIS_URL not set — uploads use the inline indexing fallback',
      });
      return;
    }

    try {
      this.worker = startDocumentWorker(redisUrl);
      log.info('document_worker_hosted', { event: 'worker_running_in_api_process' });
    } catch (err: any) {
      // Redis being down must not prevent the API from starting — uploads fall
      // back to inline indexing (KnowledgeService catch branch) until it's back.
      log.error('document_worker_start_failed', err);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) {
      await this.worker.close().catch(() => {});
      this.worker = null;
    }
  }
}
