import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { AceLogger } from '../../config/logger';

export interface QueueJob<T = any> {
  id: string;
  name: string;
  data: T;
  attempts: number;
  maxAttempts: number;
  timestamp: Date;
}

@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private logger = new AceLogger('QueueService');
  private queues: Map<string, QueueJob[]> = new Map();

  onModuleInit() {
    this.queues.set('voice-outbound', []);
    this.queues.set('whatsapp-outbound', []);
    this.queues.set('vector-indexing', []);
    this.queues.set('workflow-execution', []);
    this.queues.set('analytics-aggregation', []);
    this.logger.info('queue_clusters_initialized', { queues: Array.from(this.queues.keys()) });
  }

  onModuleDestroy() {
    this.queues.clear();
  }

  /** Add job to queue */
  async addJob<T = any>(queueName: string, jobName: string, data: T, maxAttempts = 3): Promise<QueueJob<T>> {
    const queue = this.queues.get(queueName) || [];
    const job: QueueJob<T> = {
      id: `job_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      name: jobName,
      data,
      attempts: 0,
      maxAttempts,
      timestamp: new Date(),
    };

    queue.push(job);
    this.queues.set(queueName, queue);
    this.logger.info('job_added_to_queue', { queueName, jobName, jobId: job.id });
    return job;
  }

  /** Process next job in queue */
  async popJob<T = any>(queueName: string): Promise<QueueJob<T> | null> {
    const queue = this.queues.get(queueName);
    if (!queue || queue.length === 0) return null;
    return (queue.shift() as QueueJob<T>) || null;
  }

  /** Get queue depth metrics */
  getQueueMetrics(): Record<string, number> {
    const metrics: Record<string, number> = {};
    this.queues.forEach((jobs, name) => {
      metrics[name] = jobs.length;
    });
    return metrics;
  }
}
