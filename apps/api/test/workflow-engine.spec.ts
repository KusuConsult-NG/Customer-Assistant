/**
 * The automation engine actually runs.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * The workflow engine is the one subsystem in the repo with no test of its
 * own. It is also the one most able to look like it works while doing
 * nothing: a workflow is a row of JSON, a run is another row, and a dashboard
 * that lists runs is satisfied by a run that executed no steps at all. The
 * previous node shape was purely presentational — `{label, detail, color}` —
 * which is exactly how "matched workflows and ran nothing" shipped.
 *
 * So these assert on EFFECTS: the ticket exists, the contact carries the tag,
 * the handoff flag moved. Not on a run being recorded.
 *
 * The claim test is the other half. Runs are taken with a conditional
 * `updateMany`, and the worker and the inline sweeper both poll — without the
 * claim every step executes twice, which for CREATE_TICKET means two tickets
 * for one citizen and for SEND_WHATSAPP means two messages.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { prisma } from '@ace/database';
import { AppModule } from '../src/app.module';
import { WorkflowTriggerService } from '../src/workflows/workflow-trigger.service';
import { WorkflowExecutorService } from '../src/workflows/workflow-executor.service';
import { createTenant, dropTenant, TestTenant } from './support/tenant';

describe('Workflow engine', () => {
  let app: INestApplication;
  let agency: TestTenant;
  let trigger: WorkflowTriggerService;
  let executor: WorkflowExecutorService;
  let contactId: string;

  jest.setTimeout(120000);

  const phone = () => `+23470${String(Date.now()).slice(-8)}`;

  /** Wait for the run the trigger started, rather than guessing a delay. */
  async function runFor(workflowId: string, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = await prisma.workflowRun.findFirst({
        where: { workflowId },
        orderBy: { queuedAt: 'desc' },
        include: { steps: true },
      });
      if (run && ['SUCCEEDED', 'FAILED'].includes(run.status)) return run;
      await new Promise((r) => setTimeout(r, 250));
    }
    return prisma.workflowRun.findFirst({
      where: { workflowId },
      orderBy: { queuedAt: 'desc' },
      include: { steps: true },
    });
  }

  async function makeWorkflow(nodes: any[], edges: any[], triggerEvent: string) {
    return prisma.workflow.create({
      data: {
        organizationId: agency.orgId,
        name: `spec-${triggerEvent}-${Date.now()}`,
        triggerType: triggerEvent,
        isActive: true,
        nodes: nodes as any,
        edges: edges as any,
      },
    });
  }

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_at_least_32_chars_long';
    process.env.JWT_REFRESH_SECRET ??= 'test_jwt_refresh_secret_at_least_32_chars';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();

    agency = await createTenant(app, 'wf-agency', { role: 'OWNER' });
    trigger = app.get(WorkflowTriggerService);
    executor = app.get(WorkflowExecutorService);

    const contact = await prisma.contact.create({
      data: { organizationId: agency.orgId, phoneNumber: phone(), fullName: 'Workflow Citizen' },
    });
    contactId = contact.id;
  });

  afterAll(async () => {
    await dropTenant(agency?.orgId);
    await app?.close();
  });

  it('runs a workflow when its domain event fires, and the action really happens', async () => {
    const wf = await makeWorkflow(
      [
        { id: 'n1', kind: 'TRIGGER', label: 'Ticket raised' },
        {
          id: 'n2',
          kind: 'ACTION',
          action: 'TAG_CONTACT',
          config: { tags: ['automation-proof'] },
        },
      ],
      [{ from: 'n1', to: 'n2' }],
      'TICKET_CREATED',
    );

    await trigger.emit(agency.orgId, 'TICKET_CREATED', { contactId });

    const run = await runFor(wf.id);
    expect(run).toBeTruthy();
    expect(run!.status).toBe('SUCCEEDED');
    // The EFFECT, not the run record: a run that executed nothing also
    // "succeeds".
    const after = await prisma.contact.findUnique({ where: { id: contactId } });
    expect(after?.tags ?? []).toContain('automation-proof');
  });

  it('follows the branch a condition selects, and not the other one', async () => {
    const wf = await makeWorkflow(
      [
        { id: 't', kind: 'TRIGGER', label: 'Ticket raised' },
        { id: 'c', kind: 'CONDITION', field: 'priority', operator: 'EQUALS', value: 'URGENT' },
        { id: 'yes', kind: 'ACTION', action: 'TAG_CONTACT', config: { tags: ['was-urgent'] } },
        { id: 'no', kind: 'ACTION', action: 'TAG_CONTACT', config: { tags: ['was-not-urgent'] } },
      ],
      [
        { from: 't', to: 'c' },
        { from: 'c', to: 'yes', branch: 'true' },
        { from: 'c', to: 'no', branch: 'false' },
      ],
      'TICKET_CREATED',
    );

    await trigger.emit(agency.orgId, 'TICKET_CREATED', { contactId, priority: 'URGENT' });
    const run = await runFor(wf.id);
    expect(run!.status).toBe('SUCCEEDED');

    const after = await prisma.contact.findUnique({ where: { id: contactId } });
    expect(after?.tags ?? []).toContain('was-urgent');
    expect(after?.tags ?? []).not.toContain('was-not-urgent');
  });

  it('does not run a workflow belonging to another agency', async () => {
    const other = await createTenant(app, 'wf-other', { role: 'OWNER' });
    try {
      const wf = await prisma.workflow.create({
        data: {
          organizationId: other.orgId,
          name: `spec-other-${Date.now()}`,
          triggerType: 'TICKET_CREATED',
          isActive: true,
          nodes: [
            { id: 'n1', kind: 'TRIGGER' },
            { id: 'n2', kind: 'ACTION', action: 'TAG_CONTACT', config: { tags: ['leaked'] } },
          ] as any,
          edges: [{ from: 'n1', to: 'n2' }] as any,
        },
      });

      await trigger.emit(agency.orgId, 'TICKET_CREATED', { contactId });
      await new Promise((r) => setTimeout(r, 1500));

      const runs = await prisma.workflowRun.count({ where: { workflowId: wf.id } });
      expect(runs).toBe(0);

      const after = await prisma.contact.findUnique({ where: { id: contactId } });
      expect(after?.tags ?? []).not.toContain('leaked');
    } finally {
      await dropTenant(other.orgId);
    }
  });

  it('leaves an inactive workflow alone', async () => {
    const wf = await makeWorkflow(
      [
        { id: 'n1', kind: 'TRIGGER' },
        { id: 'n2', kind: 'ACTION', action: 'TAG_CONTACT', config: { tags: ['should-not-apply'] } },
      ],
      [{ from: 'n1', to: 'n2' }],
      'LEAD_CREATED',
    );
    await prisma.workflow.update({ where: { id: wf.id }, data: { isActive: false } });

    await trigger.emit(agency.orgId, 'LEAD_CREATED', { contactId });
    await new Promise((r) => setTimeout(r, 1500));

    expect(await prisma.workflowRun.count({ where: { workflowId: wf.id } })).toBe(0);
  });

  it('executes a run once even when two workers claim it together', async () => {
    // Keep the claim. Without it the BullMQ worker and the inline sweeper both
    // execute every step: two tickets for one citizen, two messages for one
    // reply.
    const wf = await makeWorkflow(
      [
        { id: 'n1', kind: 'TRIGGER' },
        {
          id: 'n2',
          kind: 'ACTION',
          action: 'CREATE_TICKET',
          config: { subject: 'claim-race-proof', description: 'raised by the engine', priority: 'LOW' },
        },
      ],
      [{ from: 'n1', to: 'n2' }],
      'CONTACT_CREATED',
    );

    const run = await prisma.workflowRun.create({
      data: {
        organizationId: agency.orgId,
        workflowId: wf.id,
        status: 'QUEUED',
        triggerType: 'CONTACT_CREATED',
        payload: { contactId } as any,
      },
    });

    await Promise.all([executor.run(run.id), executor.run(run.id)]);

    const tickets = await prisma.ticket.count({
      where: { organizationId: agency.orgId, subject: { contains: 'claim-race-proof' } },
    });
    expect(tickets).toBe(1);
  });

  it('records a node it cannot resolve as unconfigured rather than guessing', async () => {
    // A legacy presentational node has no action to run. Inventing a plausible
    // one is how an automation quietly does the wrong thing to a citizen.
    const wf = await makeWorkflow(
      [
        { id: 'n1', kind: 'TRIGGER' },
        { id: 'n2', label: 'Send AI Automated Response', detail: 'RAG Knowledge Lookup', color: 'from-purple-500' },
      ],
      [{ from: 'n1', to: 'n2' }],
      'DEAL_STAGE_CHANGED',
    );

    await trigger.emit(agency.orgId, 'DEAL_STAGE_CHANGED', { contactId });
    const run = await runFor(wf.id);

    expect(run).toBeTruthy();
    // It FAILS the run and names the node, rather than skipping quietly or
    // inventing a SEND_WHATSAPP with content nobody wrote. A workflow that
    // silently does nothing is indistinguishable from one that works.
    expect(run!.status).toBe('FAILED');
    expect(run!.error ?? '').toMatch(/not configured/i);

    const steps = (run as any).steps ?? [];
    const offending = steps.find((s: any) => /not configured/i.test(s.error ?? ''));
    expect(offending).toBeTruthy();
    expect(offending.status).toBe('FAILED');
  });
});
