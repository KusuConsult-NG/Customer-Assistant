-- Workflow execution history.
--
-- The workflow engine previously matched workflows and ran nothing, so there was
-- nothing to record. With a real executor, execution history is required: without it
-- "did my automation run?" is unanswerable and a failed action vanishes silently.

DO $$ BEGIN
  CREATE TYPE "WorkflowRunStatus" AS ENUM ('QUEUED','RUNNING','SUCCEEDED','FAILED','DEAD_LETTER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "WorkflowStepStatus" AS ENUM ('SUCCEEDED','FAILED','SKIPPED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "workflow_runs" (
  "id"             TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "workflowId"     TEXT NOT NULL,
  "triggerType"    TEXT NOT NULL,
  "status"         "WorkflowRunStatus" NOT NULL DEFAULT 'QUEUED',
  "payload"        JSONB NOT NULL,
  "attempt"        INTEGER NOT NULL DEFAULT 0,
  "error"          TEXT,
  "ranInline"      BOOLEAN NOT NULL DEFAULT false,
  "queuedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt"      TIMESTAMP(3),
  "finishedAt"     TIMESTAMP(3),
  CONSTRAINT "workflow_runs_workflowId_fkey"
    FOREIGN KEY ("workflowId") REFERENCES "workflows"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "workflow_runs_organizationId_queuedAt_idx" ON "workflow_runs" ("organizationId", "queuedAt");
CREATE INDEX IF NOT EXISTS "workflow_runs_workflowId_queuedAt_idx"     ON "workflow_runs" ("workflowId", "queuedAt");
CREATE INDEX IF NOT EXISTS "workflow_runs_status_idx"                  ON "workflow_runs" ("status");

CREATE TABLE IF NOT EXISTS "workflow_run_steps" (
  "id"         TEXT PRIMARY KEY,
  "runId"      TEXT NOT NULL,
  "nodeId"     TEXT NOT NULL,
  "kind"       TEXT NOT NULL,
  "action"     TEXT,
  "status"     "WorkflowStepStatus" NOT NULL,
  "input"      JSONB,
  "output"     JSONB,
  "error"      TEXT,
  "startedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  CONSTRAINT "workflow_run_steps_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "workflow_runs"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "workflow_run_steps_runId_startedAt_idx" ON "workflow_run_steps" ("runId", "startedAt");
