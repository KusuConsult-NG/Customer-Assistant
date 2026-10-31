import { Controller, Get, Logger, Res } from '@nestjs/common';
import type { Response } from 'express';
import { prisma } from '@ace/database';

/**
 * Liveness and readiness are different questions, and answering them with one
 * endpoint gets both wrong.
 *
 * ── What was here ───────────────────────────────────────────────────────────
 *
 * A single `/api/health` returning `{status:'ok'}` unconditionally — it
 * touched nothing. `kubernetes/deployment.yaml` used it for the readinessProbe
 * AND the livenessProbe, and `render.yaml` as its healthCheckPath.
 *
 * So readiness lied. With PostgreSQL unreachable the pod still reported ready,
 * the Service kept routing to it, and every request failed — instead of the
 * load balancer holding traffic off until a pod could actually serve.
 *
 * ── Why not simply make that one endpoint check the database ────────────────
 *
 * Because it is also the liveness probe, and a liveness probe that fails on a
 * dependency restarts the pod. Restarting the API does not fix PostgreSQL; it
 * would thrash every pod in the deployment for the duration of a database
 * incident, turning a recoverable outage into a crash loop across the fleet.
 *
 * Liveness stays shallow: is this process still able to answer at all.
 * Readiness is deep: can it serve a request right now.
 */
@Controller()
export class AppController {
  private readonly log = new Logger('Health');

  /**
   * LIVENESS. Deliberately touches nothing.
   *
   * The only correct reason to fail this is "this process is wedged", because
   * the only remedy it triggers is a restart.
   */
  @Get('api/health')
  health() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  /**
   * READINESS. 200 only while this pod can actually serve.
   *
   * PostgreSQL is required: every authenticated request re-reads the user, so
   * without it the API can answer nothing useful and should be taken out of
   * rotation rather than handed traffic.
   *
   * Redis is NOT required — it enables BullMQ ingestion, cross-pod Socket.IO
   * and Redis-backed rate limiting, and the platform degrades honestly without
   * it. Reporting a pod unready for a missing optional dependency would take
   * the whole deployment out of rotation over a feature that is designed to
   * cope.
   */
  @Get('api/health/ready')
  async ready(@Res() res: Response) {
    const checks: Record<string, string> = {};
    let serveable = true;

    try {
      // Cheap on purpose: this is polled every few seconds per pod.
      await prisma.$queryRawUnsafe('SELECT 1');
      checks.database = 'ok';
    } catch (err: any) {
      // NOT the driver's message. Probes are unauthenticated, so anything
      // returned here is public — and a PostgreSQL connection error commonly
      // embeds the whole DSN, credentials included. My own test for this
      // caught the first version handing `postgresql://user:password@host`
      // to anyone who curled the endpoint.
      //
      // The probe consumer only needs the status code; a human debugging
      // needs the detail, and gets it from the log.
      this.log.error(`readiness_database_unavailable: ${err?.message ?? err}`);
      checks.database = 'unavailable';
      serveable = false;
    }

    checks.redis = process.env.REDIS_URL ? 'configured' : 'not configured (optional)';

    res
      .status(serveable ? 200 : 503)
      .json({ status: serveable ? 'ready' : 'not ready', checks, timestamp: new Date().toISOString() });
  }
}
