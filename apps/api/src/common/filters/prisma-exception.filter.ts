import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';

/**
 * Translates database-layer failures into honest HTTP responses.
 *
 * Without this, every Prisma error reached the client as an opaque HTTP 500 with a
 * stack trace in the logs and no actionable information for the caller. Load testing
 * showed the most common one in practice is connection-pool exhaustion, which is a
 * TEMPORARY capacity condition, not a bug in the request — a 500 tells a client to
 * give up, when the correct answer is "retry shortly".
 *
 * Mappings:
 *   pool timeout / connection lost → 503 + Retry-After  (retryable)
 *   P2002 unique violation         → 409                (caller's data conflicts)
 *   P2025 record not found         → 404
 *   P2003 FK violation             → 400
 *   anything else                  → 500, message withheld
 */
@Catch()
export class PrismaExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('PrismaExceptionFilter');

  catch(exception: any, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();

    // Anything already expressed as an HTTP exception passes through untouched.
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return res.status(status).json(exception.getResponse());
    }

    const message: string = exception?.message ?? '';
    const code: string | undefined = exception?.code;

    // Framework errors that already carry an HTTP status but are NOT HttpException
    // instances — body-parser's 413 "request entity too large" and its 400 for
    // malformed JSON are the ones that matter here. Because this filter is
    // registered with a bare `@Catch()`, it intercepts those too; without this
    // branch it would relabel a legitimate 413 as an opaque 500 and tell the client
    // to give up on a request it could have fixed by sending less data.
    const carriedStatus = Number(exception?.status ?? exception?.statusCode);
    if (Number.isInteger(carriedStatus) && carriedStatus >= 400 && carriedStatus < 600) {
      const safeMessage =
        carriedStatus === HttpStatus.PAYLOAD_TOO_LARGE
          ? 'Request body is too large.'
          : carriedStatus < 500
            ? (message || 'Bad Request')
            : 'An unexpected error occurred.';
      if (carriedStatus >= 500) this.logger.error(`Upstream error ${carriedStatus}: ${message}`, exception?.stack);
      return res.status(carriedStatus).json({
        statusCode: carriedStatus,
        error: HttpStatus[carriedStatus] ?? 'Error',
        message: safeMessage,
      });
    }

    // ── Capacity: retryable ────────────────────────────────────────────────
    if (
      /Timed out fetching a new connection from the connection pool/i.test(message) ||
      code === 'P2024'
    ) {
      this.logger.warn('Database connection pool exhausted — returning 503');
      res.setHeader('Retry-After', '2');
      return res.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        statusCode: 503,
        error: 'Service Unavailable',
        message: 'The service is briefly at capacity. Please retry in a moment.',
      });
    }

    if (code === 'P1001' || code === 'P1002' || /Can't reach database server/i.test(message)) {
      this.logger.error('Database unreachable');
      res.setHeader('Retry-After', '5');
      return res.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        statusCode: 503,
        error: 'Service Unavailable',
        message: 'The service is temporarily unavailable. Please retry shortly.',
      });
    }

    // ── Constraint violations: the caller's data, not our bug ──────────────
    if (code === 'P2002') {
      const target = Array.isArray(exception?.meta?.target) ? exception.meta.target.join(', ') : 'value';
      return res.status(HttpStatus.CONFLICT).json({
        statusCode: 409,
        error: 'Conflict',
        message: `That ${target} is already in use.`,
      });
    }

    if (code === 'P2025') {
      return res.status(HttpStatus.NOT_FOUND).json({
        statusCode: 404,
        error: 'Not Found',
        message: 'The requested record does not exist.',
      });
    }

    if (code === 'P2003') {
      return res.status(HttpStatus.BAD_REQUEST).json({
        statusCode: 400,
        error: 'Bad Request',
        message: 'A referenced record does not exist.',
      });
    }

    // ── Everything else ────────────────────────────────────────────────────
    // Log fully server-side; tell the client nothing about our internals.
    this.logger.error(`Unhandled exception: ${message}`, exception?.stack);
    return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'An unexpected error occurred.',
    });
  }
}
