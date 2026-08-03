/**
 * ACE Platform — Structured JSON Logger
 *
 * A production-grade logger that emits structured JSON logs with:
 *  - correlationId: traces a single request across all services
 *  - organizationId: identifies the tenant
 *  - timestamp: ISO 8601
 *  - latencyMs: elapsed execution time
 *  - level: info | warn | error | debug
 *
 * In development, logs are pretty-printed for readability.
 * In production, logs are compact JSON lines for log aggregators
 * (e.g. Datadog, Loki, CloudWatch).
 *
 * Usage:
 *   import { AceLogger } from '../config/logger';
 *   const log = new AceLogger('WhatsappService');
 *   const timer = log.startTimer();
 *   // ... do work ...
 *   log.info('webhook_processed', { organizationId, conversationId }, timer);
 */

export interface LogContext {
  correlationId?: string;
  organizationId?: string;
  conversationId?: string;
  callSid?: string;
  fromNumber?: string;
  event?: string;
  [key: string]: any;
}

export class AceLogger {
  private readonly isProd = process.env.NODE_ENV === 'production';

  constructor(private readonly service: string) {}

  /** Returns a high-resolution timer handle. Pass to log methods to include latencyMs. */
  startTimer(): () => number {
    const start = Date.now();
    return () => Date.now() - start;
  }

  info(message: string, context: LogContext = {}, elapsed?: () => number): void {
    this.emit('info', message, context, elapsed);
  }

  warn(message: string, context: LogContext = {}, elapsed?: () => number): void {
    this.emit('warn', message, context, elapsed);
  }

  error(message: string, error?: Error, context: LogContext = {}): void {
    const entry = this.buildEntry('error', message, context);
    if (error) {
      entry.error = {
        name: error.name,
        message: error.message,
        stack: error.stack?.split('\n').slice(0, 8).join('\n'),
      };
    }
    this.write(entry);
  }

  debug(message: string, context: LogContext = {}): void {
    if (this.isProd) return; // suppress debug in production
    this.emit('debug', message, context);
  }

  private emit(level: string, message: string, context: LogContext, elapsed?: () => number): void {
    const entry = this.buildEntry(level, message, context);
    if (elapsed) entry.latencyMs = elapsed();
    this.write(entry);
  }

  private buildEntry(level: string, message: string, context: LogContext): Record<string, any> {
    return {
      level,
      timestamp: new Date().toISOString(),
      service: this.service,
      message,
      ...context,
    };
  }

  private write(entry: Record<string, any>): void {
    if (this.isProd) {
      process.stdout.write(JSON.stringify(entry) + '\n');
    } else {
      // Pretty-print in dev
      const color = entry.level === 'error' ? '\x1b[31m' : entry.level === 'warn' ? '\x1b[33m' : '\x1b[36m';
      const reset = '\x1b[0m';
      const latency = entry.latencyMs !== undefined ? ` [${entry.latencyMs}ms]` : '';
      const orgId = entry.organizationId ? ` org=${entry.organizationId.slice(0, 8)}` : '';
      const corrId = entry.correlationId ? ` corr=${entry.correlationId.slice(0, 8)}` : '';
      console.log(`${color}[${entry.level.toUpperCase()}]${reset} ${entry.service}: ${entry.message}${orgId}${corrId}${latency}`);
      if (entry.error) {
        console.error(entry.error.stack);
      }
    }
  }
}

/**
 * Generates a short correlation ID for a single request lifecycle.
 * Format: 8 random hex chars (sufficient for log correlation within a session).
 */
export function generateCorrelationId(): string {
  return Math.random().toString(16).slice(2, 10);
}
