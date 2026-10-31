import { prisma } from './index';

/**
 * Writing the audit record, in one place.
 *
 * ── Why this lives in the database package ──────────────────────────────────
 *
 * The same reason `secret-box.ts` and `credentials.ts` do: the column lives
 * here and more than one module writes it. Until now the only writer was a
 * private method on `PlatformService`, so the platform tier was audited and
 * nothing else was — and the second writer would have been a second
 * definition, which is how two callers end up disagreeing about what an audit
 * record contains.
 *
 * ── The contract ───────────────────────────────────────────────────────────
 *
 * THE WRITE IS AWAITED AND NOT SWALLOWED. An audit record that silently fails
 * to write is worse than no audit trail at all: the table looks complete and
 * is not, so an absence of evidence reads as evidence of absence. If this
 * throws, the action that was being audited should fail too — a change nobody
 * can account for afterwards is not a change worth making.
 *
 * `AuditLog` is append-only by construction. There is no update or delete
 * helper here and deliberately so, including for the platform tier, which
 * must not be able to edit the record of its own actions.
 *
 * NEVER PASS A SECRET. `previousValue` and `newValue` are stored verbatim and
 * are readable by anyone who can read the agency's trail, so they take the
 * shape of a change, never its contents: a key's prefix rather than the key, a
 * role name rather than a session, a reason rather than a record.
 */
export interface AuditEntryInput {
  /**
   * Who acted. A user id, `system:<name>` for an unattended writer, or
   * `public:<ip>` for an unauthenticated caller. Never null — a row that
   * cannot name an actor is not an audit record.
   */
  actor: string;
  /**
   * Dotted and namespaced by tier: `platform.*` for an action the operating
   * ministry took, `agency.*` for one an agency took inside its own tenancy.
   * The prefix is what lets a reader tell "we did this" from "this was done
   * to us" without resolving the actor at all.
   */
  action: string;
  targetType: string;
  targetId: string;
  /**
   * The agency the action concerns — NOT the actor's own agency. A ministry
   * operator suspending an agency records that agency, which is what makes
   * "who did this to us" answerable from inside it.
   *
   * Null means the action belongs to no single agency (granting platform
   * status, say). Agency-scoped reads must exclude those rather than treat a
   * null as a match.
   */
  organizationId?: string | null;
  previousValue?: unknown;
  newValue?: unknown;
  ipAddress?: string | null;
  requestId?: string | null;
}

/** The signed-in user behind a change, carried from the controller's `req.user`. */
export interface Actor {
  userId: string;
  ipAddress?: string | null;
}

export async function recordAudit(entry: AuditEntryInput): Promise<void> {
  await prisma.auditLog.create({
    data: {
      organizationId: entry.organizationId ?? null,
      actor: entry.actor,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      previousValue: (entry.previousValue ?? undefined) as never,
      newValue: (entry.newValue ?? undefined) as never,
      ipAddress: entry.ipAddress ?? null,
      requestId: entry.requestId ?? null,
    },
  });
}

/**
 * Who or what made a change, in the forms the `actor` column documents.
 *
 * A signed-in person is an `Actor`. An unattended writer is the string
 * `system:<name>` — the orchestrator and the hosted agent both cancel and
 * reschedule real appointments, and an audit trail that recorded only the
 * changes a human made would quietly imply the AI never touched anything.
 *
 * Using the vocabulary the schema already states, rather than a new one:
 * `resolveAuditActors` renders `system:*` as an automated process, so these
 * rows read correctly in an agency's own trail with no further work.
 */
export type AuditActor = Actor | `system:${string}`;

/**
 * An action an agency took inside its own tenancy.
 *
 * Namespaced `agency.*` so a reader can tell "we did this" from "this was
 * done to us" without resolving the actor at all — and so the platform tier
 * can redact the values of agency actions, which is what keeps a deleted
 * citizen's name out of the ministry's console.
 */
export async function recordAgencyAudit(
  actor: AuditActor,
  organizationId: string,
  entry: {
    action: string;
    targetType: string;
    targetId: string;
    previousValue?: unknown;
    newValue?: unknown;
  }
): Promise<void> {
  const isPerson = typeof actor !== 'string';
  await recordAudit({
    actor: isPerson ? actor.userId : actor,
    organizationId,
    ipAddress: isPerson ? actor.ipAddress ?? null : null,
    ...entry,
  });
}

/**
 * The same write, for a path that must not fail because of it.
 *
 * `recordAudit` deliberately does not swallow errors: a record that silently
 * fails to write makes the table look complete when it is not. That is right
 * for a dashboard request, where a failed audit should fail the action.
 *
 * It is wrong inside a live conversation. The orchestrator's contract is that
 * no tool intent throws to the caller, because an uncaught throw means the
 * citizen receives no reply at all — and refusing to cancel somebody's
 * appointment because the audit table was briefly unreachable is a worse
 * outcome than an incomplete trail. The same reasoning as `serviceHoursFrom`
 * falling back rather than throwing.
 *
 * So this logs loudly and continues. The log line is the backstop, and it
 * names the action and the target so the gap is recoverable by hand.
 */
export async function recordAgencyAuditBestEffort(
  actor: AuditActor,
  organizationId: string,
  entry: {
    action: string;
    targetType: string;
    targetId: string;
    previousValue?: unknown;
    newValue?: unknown;
  }
): Promise<void> {
  try {
    await recordAgencyAudit(actor, organizationId, entry);
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        service: 'AuditLog',
        event: 'audit_write_failed',
        organizationId,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        error: (err as any)?.message ?? String(err),
      })
    );
  }
}

/** An actor as a reader is allowed to see them. */
export interface ResolvedActor {
  /** What to show: a staff member's name, or a description of a non-person. */
  label: string;
  /**
   * True when the actor is a member of the agency doing the reading. False for
   * the operating ministry, for scripts, and for unauthenticated callers —
   * everything the agency cannot hold to account itself.
   */
  isOwnStaff: boolean;
}

/**
 * Turns the `actor` string into something a reader can act on, WITHOUT
 * crossing a tenant boundary to do it.
 *
 * The platform console renders `actor.slice(0, 8)` — a truncated uuid, which
 * answers "who did this" with a riddle. An agency reading its own trail needs
 * the name.
 *
 * But the actor may be a ministry operator, and naming them would hand one
 * tenant the identity of a person in another. So a staff member of the reading
 * agency is named, and anyone else is DESCRIBED by their role: the agency
 * learns that the ministry acted, which is the accountable fact, without
 * learning which official it was. That stays a question for the ministry's own
 * console, which does have the whole picture.
 *
 * Takes the lookup rather than reaching for a client, so the orchestrator's
 * suites — which replace `@ace/database` wholesale — are not broken by it.
 */
export async function resolveAuditActors(
  findStaff: (ids: string[]) => Promise<Array<{ id: string; fullName: string; email: string }>>,
  organizationId: string,
  actors: string[]
): Promise<Map<string, ResolvedActor>> {
  const out = new Map<string, ResolvedActor>();

  const userIds = actors.filter((a) => !a.includes(':'));
  const staff =
    userIds.length > 0 ? await findStaff(Array.from(new Set(userIds))) : [];
  const byId = new Map(staff.map((u) => [u.id, u]));

  for (const actor of actors) {
    if (out.has(actor)) continue;

    if (actor.startsWith('system:')) {
      out.set(actor, { label: `Automated process (${actor.slice(7)})`, isOwnStaff: false });
      continue;
    }
    if (actor.startsWith('public:')) {
      out.set(actor, { label: 'Unauthenticated request', isOwnStaff: false });
      continue;
    }

    const user = byId.get(actor);
    if (user) {
      out.set(actor, { label: `${user.fullName} (${user.email})`, isOwnStaff: true });
      continue;
    }

    // A real person, but not one of this agency's. Naming them would leak a
    // ministry official's identity into a tenant; saying nothing would leave
    // the agency unable to tell an outside action from one of its own.
    out.set(actor, { label: 'Platform operator (operating ministry)', isOwnStaff: false });
  }

  return out;
}
