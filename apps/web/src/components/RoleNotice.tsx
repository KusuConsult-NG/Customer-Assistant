'use client';

import React, { useEffect, useState } from 'react';
import { ShieldAlert, Eye } from 'lucide-react';
import { canView, readOnlyNotice, SCREENS, storedRole, type Role } from '@/lib/roles';

/**
 * Says plainly what this member may do on this screen.
 *
 * Two states, both of which used to be silence:
 *
 *  - NOT FOR THIS ROLE. An admin-only screen reached directly by a front-desk
 *    officer rendered the full administration UI, and the officer found out by
 *    pressing a button and receiving a 403 with no explanation attached to it.
 *  - READ ONLY. A screen a member may look at but not change showed every
 *    button as though it would work.
 *
 * It is not a permission — the stored session is editable, so the screen still
 * calls the API and still shows whatever refusal comes back. This explains the
 * refusal before it happens instead of after.
 */
export function RoleNotice({ path, role: given }: { path: string; role?: Role }) {
  // Read AFTER mount, not as a default argument.
  //
  // `localStorage` does not exist while Next renders this on the server, so a
  // default argument evaluated there is always `undefined` — which this module
  // treats as "show everything", and the server's markup is what the browser
  // keeps. The notice therefore never appeared for anybody, which an e2e
  // caught and a unit test on the rules could not have.
  const [role, setRole] = useState<Role | undefined>(given);
  useEffect(() => {
    if (!given) setRole(storedRole());
  }, [given]);

  // Until the role is known, say nothing rather than flashing a refusal at
  // somebody who turns out to be an administrator.
  if (!role) return null;

  if (!canView(path, role)) {
    const who = role ? role.toLowerCase() : 'member';
    return (
      <div className="rounded-2xl border border-amber-300 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 p-5 flex items-start gap-3">
        <ShieldAlert className="w-5 h-5 text-amber-700 dark:text-amber-400 flex-shrink-0 mt-0.5" />
        <div className="text-sm text-amber-900 dark:text-amber-200">
          <p className="font-bold">{SCREENS[path]?.label ?? 'This screen'} is not available to you</p>
          <p className="mt-1">
            You are signed in as {who === 'member' ? 'a member' : `an agency ${who}`}. This screen is
            for owners and administrators of your agency — ask one of them to make the change, or to
            change your role if you need it.
          </p>
        </div>
      </div>
    );
  }

  const notice = readOnlyNotice(path, role);
  if (!notice) return null;

  return (
    <div className="rounded-2xl border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-800/60 p-4 flex items-start gap-3">
      <Eye className="w-4 h-4 text-slate-600 dark:text-slate-300 flex-shrink-0 mt-0.5" />
      <p className="text-xs text-slate-700 dark:text-slate-200">{notice}</p>
    </div>
  );
}

/**
 * Renders the screen, or the "not for this role" notice INSTEAD of it.
 *
 * Used by screens whose only purpose is changing something, where showing the
 * controls to somebody who cannot use them is the problem.
 */
export function RoleGate({
  path,
  children,
  role: given,
}: {
  path: string;
  children: React.ReactNode;
  role?: Role;
}) {
  const [role, setRole] = useState<Role | undefined>(given);
  useEffect(() => {
    if (!given) setRole(storedRole());
  }, [given]);

  if (role && !canView(path, role)) {
    return (
      <div className="p-6 space-y-6">
        <RoleNotice path={path} role={role} />
      </div>
    );
  }
  return <>{children}</>;
}

/**
 * Whether this member may open this screen, decided after mount.
 *
 * Three states, and 'unknown' matters: the role lives in localStorage, which
 * does not exist while the page is rendered on the server, so a screen that
 * decided immediately would either flash a refusal at an administrator or
 * (as the first version of this did) decide "allowed" on the server and keep
 * that markup forever.
 */
export function useScreenAccess(path: string): 'unknown' | 'allowed' | 'denied' {
  const [role, setRole] = useState<Role | undefined>(undefined);
  useEffect(() => setRole(storedRole()), []);
  if (!role) return 'unknown';
  return canView(path, role) ? 'allowed' : 'denied';
}
