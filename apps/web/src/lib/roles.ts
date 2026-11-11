/**
 * What each role can actually do with each screen.
 *
 * ── What was wrong ──────────────────────────────────────────────────────────
 *
 * Every signed-in member saw the identical sidebar: all fifteen screens,
 * including System Settings, Branding & White Label, Agent Provisioning,
 * Automation Workflows and WhatsApp Broadcasts. Only two pages adapted to the
 * role at all (`agent-provisioning` and part of `settings`).
 *
 * So a front-desk officer (AGENT) or a read-only member (VIEWER) was shown the
 * agency's whole administration surface, clicked a button on it, and got a 403
 * from the API — the server-side rules are correct and have tests, and the
 * dashboard simply did not reflect them. That is the same shape as a form that
 * saves and changes nothing: the control should not have been offered.
 *
 * ── What this is and is not ─────────────────────────────────────────────────
 *
 * It is NOT a permission. `ace_user` lives in localStorage and anybody can
 * edit it, exactly as `isPlatformAdmin` can be, so every one of these screens
 * still calls the API and still renders whatever refusal comes back. This
 * decides what to OFFER; the server decides what happens. The platform console
 * already works this way and an e2e asserts the refusal survives a forged
 * flag.
 *
 * The role names and the write rules mirror the controllers' own `@Roles`
 * decorators — scheduling, callbacks and conversations admit AGENT because
 * front-desk work is theirs, while CRM, knowledge, catalogue, workflows,
 * broadcasts, telephony configuration and provisioning are OWNER/ADMIN.
 */
export type Role = 'OWNER' | 'ADMIN' | 'AGENT' | 'VIEWER';

const ALL: Role[] = ['OWNER', 'ADMIN', 'AGENT', 'VIEWER'];
const ADMINS: Role[] = ['OWNER', 'ADMIN'];
const DESK: Role[] = ['OWNER', 'ADMIN', 'AGENT'];

/**
 * Who a screen is for.
 *
 * `view` is who may reach it at all; `write` is who may change anything on it.
 * A screen whose only purpose is changing something has the same list for
 * both, and is therefore hidden from everyone else rather than shown as a
 * wall of disabled controls.
 */
export const SCREENS: Record<string, { view: Role[]; write: Role[]; label: string }> = {
  '/':                    { view: ALL,    write: ALL,    label: 'Dashboard' },
  '/analytics':           { view: ALL,    write: ALL,    label: 'Analytics' },
  '/crm':                 { view: ALL,    write: ADMINS, label: 'Citizens & Contacts' },
  '/agent-console':       { view: ALL,    write: DESK,   label: 'Agent Console' },
  '/conversations':       { view: ALL,    write: DESK,   label: 'Live Conversations' },
  '/knowledge':           { view: ALL,    write: ADMINS, label: 'Knowledge & FAQs' },
  '/workflows':           { view: ADMINS, write: ADMINS, label: 'Automation Workflows' },
  '/broadcasts':          { view: ADMINS, write: ADMINS, label: 'WhatsApp Broadcasts' },
  '/telephony':           { view: ALL,    write: DESK,   label: 'Telephone Service' },
  '/scheduling':          { view: ALL,    write: DESK,   label: 'Appointments' },
  '/callbacks':           { view: ALL,    write: DESK,   label: 'Callback Queue' },
  '/agent-provisioning':  { view: ADMINS, write: ADMINS, label: 'Agent Provisioning' },
  '/services':            { view: ALL,    write: ADMINS, label: 'Services & Locations' },
  '/budget':              { view: ALL,    write: ADMINS, label: 'Budget & Projects' },
  '/cases':               { view: ALL,    write: DESK,   label: 'Cases' },
  '/white-label':         { view: ADMINS, write: ADMINS, label: 'Branding & White Label' },
  '/settings':            { view: ALL,    write: ADMINS, label: 'System Settings' },
};

/** The signed-in member's role, as the stored session reports it. */
export function storedRole(): Role | undefined {
  try {
    const role = JSON.parse(localStorage.getItem('ace_user') || '{}')?.role;
    return ALL.includes(role) ? role : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Can this role open this screen?
 *
 * An UNKNOWN role (an older stored session, a member record the dashboard has
 * not re-read) is treated as able to view. Hiding a screen from somebody who
 * is entitled to it is worse than showing one the API will refuse: the refusal
 * explains itself, a missing link does not.
 */
export function canView(path: string, role: Role | undefined = storedRole()): boolean {
  const screen = SCREENS[path];
  if (!screen) return true;
  if (!role) return true;
  return screen.view.includes(role);
}

/** Can this role change anything on this screen? */
export function canWrite(path: string, role: Role | undefined = storedRole()): boolean {
  const screen = SCREENS[path];
  if (!screen) return true;
  if (!role) return true;
  return screen.write.includes(role);
}

/** Plain words for a member who may look but not change. */
export function readOnlyNotice(path: string, role: Role | undefined = storedRole()): string | null {
  if (canWrite(path, role)) return null;
  const screen = SCREENS[path];
  const who = role ? `a ${role.toLowerCase()}` : 'a member';
  return (
    `You are signed in as ${who}, so this screen is read-only for you. ` +
    `Changes here are made by an owner or administrator of your agency.`
  );
}
