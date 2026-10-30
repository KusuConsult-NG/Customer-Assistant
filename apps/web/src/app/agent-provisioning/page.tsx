'use client';

/**
 * Connecting this agency's agent to the lines citizens actually reach it on.
 *
 * Every operation here existed as an API endpoint before it existed as a
 * screen, and the gap was the problem. The two with real-world consequence —
 * importing a phone number and pausing a WhatsApp line — are guarded
 * server-side by a confirmation flag precisely so they cannot happen by
 * accident, and until now the only way to reach them was a hand-written HTTP
 * request. An operation that has to be deliberate, reachable only by curl, is
 * an operation that gets done from a half-remembered command at the worst
 * possible hour.
 *
 * Two rules this page keeps:
 *
 *   - A CONFIRMATION FLAG IS NOT SENT ON A BUTTON CLICK. `confirmVoiceCutover`
 *     and `confirmAffectsEveryConversation` exist to make somebody stop and
 *     read. A client that filled them in automatically would satisfy the
 *     server and defeat the point entirely, so each has its own tick box here
 *     stating what changes, and the action stays disabled until it is ticked.
 *
 *   - THE SERVER'S OWN WORDING IS SHOWN VERBATIM. Releasing a number returns a
 *     note about re-pointing the Twilio webhook; pausing returns one saying
 *     messages still arrive with nobody to answer them. Those are the parts an
 *     operator has to act on, and a friendlier re-write in the browser is a
 *     second description of one state — which drifts from the first.
 *
 * Reads are open to any member: knowing which number the agent answers is what
 * a support officer needs when a citizen says the line behaved oddly. Writes
 * are OWNER/ADMIN and the API enforces that; this page states the limit up
 * front rather than leaving someone to discover it by clicking.
 */

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { copyToClipboard } from '@/lib/clipboard';
import {
  Bot, Phone, MessageSquare, KeyRound, AlertTriangle, CheckCircle2, Loader2,
  RefreshCw, Copy, Info, Link2, Unlink, PauseCircle, PlayCircle, ShieldAlert,
} from 'lucide-react';

type AgentStatus = {
  configured: boolean;
  agentId: string | null;
  remoteAgentFound: boolean;
  drift: string[];
  toolCount: number;
  expectedToolCount: number;
};

type SyncStep = { target: string; action: 'created' | 'updated' | 'unchanged'; id?: string };
type SyncReport = { agentId: string; baseUrl: string; steps: SyncStep[]; agentKey?: string };

type ImportedNumber = {
  phoneNumberId: string;
  phoneNumber: string;
  label: string;
  assignedAgentId: string | null;
  isOurs: boolean;
};

type WhatsAppAccount = {
  phoneNumberId: string;
  phoneNumber: string;
  phoneNumberName: string;
  businessAccountName: string;
  assignedAgentId: string | null;
  isOurs: boolean;
  isTokenExpired: boolean;
  /** null when the workspace did not report it — shown as its own state. */
  messagingEnabled: boolean | null;
};

const msg = (e: unknown) => String((e as any)?.message ?? e);

const card = 'rounded-2xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden';
const btn = 'inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed';
const btnPrimary = `${btn} bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-500/20`;
const btnQuiet = `${btn} bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-700`;
const btnDanger = `${btn} bg-red-600 hover:bg-red-500 text-white shadow-lg shadow-red-500/20`;

function Section({ icon, title, description, children }: {
  icon: React.ReactNode; title: string; description: string; children: React.ReactNode;
}) {
  return (
    <div className={card}>
      <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-start gap-3">
        <div className="mt-0.5 text-blue-600 dark:text-blue-400">{icon}</div>
        <div>
          <h2 className="font-semibold text-slate-900 dark:text-white">{title}</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">{description}</p>
        </div>
      </div>
      <div className="p-6 space-y-4">{children}</div>
    </div>
  );
}

function Note({ kind, children }: { kind: 'info' | 'warn' | 'ok' | 'bad'; children: React.ReactNode }) {
  const tone = {
    info: 'bg-blue-500/[0.06] border-blue-200 dark:border-blue-500/20 text-blue-700 dark:text-blue-300',
    warn: 'bg-amber-500/[0.06] border-amber-200 dark:border-amber-500/20 text-amber-700 dark:text-amber-300',
    ok: 'bg-emerald-500/[0.06] border-emerald-200 dark:border-emerald-500/20 text-emerald-700 dark:text-emerald-300',
    bad: 'bg-red-500/[0.06] border-red-200 dark:border-red-500/20 text-red-700 dark:text-red-300',
  }[kind];
  const Icon = { info: Info, warn: AlertTriangle, ok: CheckCircle2, bad: AlertTriangle }[kind];
  return (
    <div className={`flex gap-2.5 p-4 rounded-xl border ${tone}`}>
      <Icon className="w-4 h-4 flex-shrink-0 mt-0.5" />
      <div className="text-xs leading-relaxed break-words space-y-1">{children}</div>
    </div>
  );
}

function Badge({ tone, children }: { tone: 'ok' | 'warn' | 'bad' | 'mute'; children: React.ReactNode }) {
  const cls = {
    ok: 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/20',
    warn: 'bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-200 dark:border-amber-500/20',
    bad: 'bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-400 border-red-200 dark:border-red-500/20',
    mute: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700',
  }[tone];
  return <span className={`text-[10px] px-2 py-0.5 rounded-lg font-bold border tracking-wider ${cls}`}>{children}</span>;
}

/** A tick box that has to be read before the action it guards becomes possible. */
function Gate({ checked, onChange, children }: {
  checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode;
}) {
  return (
    <label className="flex gap-2.5 items-start cursor-pointer select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 w-4 h-4 rounded accent-blue-600 flex-shrink-0"
      />
      <span className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed">{children}</span>
    </label>
  );
}

export default function AgentProvisioningPage() {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [numbers, setNumbers] = useState<ImportedNumber[]>([]);
  const [numbersError, setNumbersError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<WhatsAppAccount[]>([]);
  const [whatsappError, setWhatsappError] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [report, setReport] = useState<SyncReport | null>(null);
  const [mintedKey, setMintedKey] = useState<string | null>(null);

  const [cutoverOpen, setCutoverOpen] = useState(false);
  const [cutoverAck, setCutoverAck] = useState(false);
  const [label, setLabel] = useState('');
  const [enableSms, setEnableSms] = useState(false);

  const [releaseOpen, setReleaseOpen] = useState(false);
  const [pauseOpen, setPauseOpen] = useState(false);
  const [pauseAck, setPauseAck] = useState(false);

  const [role, setRole] = useState<string | undefined>(undefined);
  useEffect(() => {
    try { setRole(JSON.parse(localStorage.getItem('ace_user') || '{}').role); } catch { /* signed out */ }
  }, []);
  const canWrite = role === 'OWNER' || role === 'ADMIN';

  /**
   * All three in parallel and independently settled.
   *
   * The number and WhatsApp listings both refuse outright for an agency with
   * no agent yet — that is the NORMAL first state, not a failure, and one
   * rejected promise must not blank the two sections that did load.
   */
  const load = useCallback(async (showSpinner = true) => {
    if (showSpinner) setLoading(true);
    const [s, n, w] = await Promise.allSettled([
      api.agentProvisioning.getStatus(),
      api.agentProvisioning.listNumbers(),
      api.agentProvisioning.listWhatsApp(),
    ]);

    if (s.status === 'fulfilled') { setStatus(s.value); setStatusError(null); }
    else { setStatus(null); setStatusError(msg(s.reason)); }

    if (n.status === 'fulfilled') { setNumbers(n.value ?? []); setNumbersError(null); }
    else { setNumbers([]); setNumbersError(msg(n.reason)); }

    if (w.status === 'fulfilled') { setAccounts(w.value ?? []); setWhatsappError(null); }
    else { setAccounts([]); setWhatsappError(msg(w.reason)); }

    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const run = async (key: string, fn: () => Promise<any>, after?: (result: any) => void) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const result = await fn();
      after?.(result);
      await load(false);
    } catch (e: unknown) {
      setError(msg(e));
    } finally {
      setBusy(null);
    }
  };

  const copy = async (text: string) => {
    const ok = await copyToClipboard(text);
    setNotice(ok ? 'Copied to clipboard.' : 'Could not copy — select the text and copy it manually.');
  };

  const imported = numbers[0] ?? null;
  const attached = accounts.find((a) => a.isOurs) ?? null;
  const unclaimed = accounts.filter((a) => !a.isOurs);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2 className="w-8 h-8 text-blue-600 dark:text-blue-400 animate-spin" />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white">Agent Provisioning</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            The hosted agent, and the phone and WhatsApp lines it answers.
          </p>
        </div>
        <button onClick={() => load()} className={btnQuiet} disabled={busy !== null}>
          <RefreshCw className="w-4 h-4" /> Refresh
        </button>
      </div>

      {!canWrite && (
        <Note kind="info">
          <p>
            You are signed in as {role || 'a member'}, so you can see how this agency&rsquo;s agent is
            connected but not change it. Provisioning, importing a number and attaching a WhatsApp
            line are restricted to an OWNER or ADMIN.
          </p>
        </Note>
      )}

      {error && <Note kind="bad"><p>{error}</p></Note>}
      {notice && <Note kind="info"><p>{notice}</p></Note>}

      {/* The key is displayed once and cannot be recovered, so it gets the top
          of the page and an explicit acknowledgement rather than a toast. */}
      {mintedKey && (
        <div className="rounded-2xl border-2 border-amber-400 dark:border-amber-500/50 bg-amber-50 dark:bg-amber-500/[0.07] p-6 space-y-3">
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-5 h-5 text-amber-600 dark:text-amber-400" />
            <h2 className="font-bold text-amber-900 dark:text-amber-200">Agent key — shown once</h2>
          </div>
          <p className="text-xs text-amber-800 dark:text-amber-300/90 leading-relaxed">
            This is the only time this key is displayed. Only a SHA-256 hash of it is kept here, and
            the usable copy lives as a secret inside your ElevenLabs workspace — nothing on this
            platform can show it again. Save it now; if it is lost, rotate the key and replace it
            wherever it is configured.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs font-mono bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 px-3 py-2.5 rounded-lg border border-amber-200 dark:border-amber-500/30 break-all">
              {mintedKey}
            </code>
            <button onClick={() => copy(mintedKey)} className={btnQuiet}>
              <Copy className="w-3.5 h-3.5" /> Copy
            </button>
          </div>
          <button onClick={() => setMintedKey(null)} className={btnPrimary}>
            I have saved this key
          </button>
        </div>
      )}

      {/* ── The agent ─────────────────────────────────────────────────────── */}
      <Section
        icon={<Bot className="w-5 h-5" />}
        title="The agent"
        description="Provisioning is generated from this platform's own tool catalogue and prompt, never hand-maintained. Syncing is idempotent and resumable; it reports what it changed."
      >
        {statusError ? (
          <Note kind="warn"><p>{statusError}</p></Note>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600 dark:text-slate-400">
              {status?.agentId ? (
                <>
                  <Badge tone={status.remoteAgentFound ? 'ok' : 'bad'}>
                    {status.remoteAgentFound ? 'PROVISIONED' : 'MISSING IN WORKSPACE'}
                  </Badge>
                  <span>
                    Agent <code className="font-mono text-slate-700 dark:text-slate-300">{status.agentId}</code>
                  </span>
                  <span>{status.toolCount} of {status.expectedToolCount} tools attached</span>
                </>
              ) : (
                <Badge tone="mute">NOT PROVISIONED</Badge>
              )}
            </div>

            {status?.configured && (status?.drift ?? []).length === 0 && status.remoteAgentFound && (
              <Note kind="ok"><p>The remote agent matches this platform.</p></Note>
            )}

            {(status?.drift ?? []).map((d, i) => (
              <Note key={i} kind="warn"><p>{d}</p></Note>
            ))}

            <div className="flex flex-wrap gap-2 pt-1">
              {!status?.configured ? (
                <button
                  onClick={() => run('create', () => api.agentProvisioning.create(), (r: SyncReport) => {
                    setReport(r);
                    if (r.agentKey) setMintedKey(r.agentKey);
                  })}
                  disabled={busy !== null}
                  className={btnPrimary}
                >
                  {busy === 'create' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Bot className="w-4 h-4" />}
                  Create the agent
                </button>
              ) : (
                <button
                  onClick={() => run('sync', () => api.agentProvisioning.sync(), (r: SyncReport) => {
                    setReport(r);
                    if (r.agentKey) setMintedKey(r.agentKey);
                  })}
                  disabled={busy !== null}
                  className={btnPrimary}
                >
                  {busy === 'sync' ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                  Sync configuration
                </button>
              )}

              {status?.configured && (
                <button
                  onClick={() => run('rotate', () => api.agentProvisioning.rotateKey(), (r: { agentKey: string }) => setMintedKey(r.agentKey))}
                  disabled={busy !== null}
                  className={btnQuiet}
                >
                  {busy === 'rotate' ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />}
                  Rotate agent key
                </button>
              )}
            </div>

            <p className="text-xs text-slate-500 dark:text-slate-400">
              Rotation updates the workspace secret before revoking the old key, so a call in
              progress keeps working.
            </p>

            {report && (
              <div className="rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden">
                <div className="px-4 py-2 bg-slate-50 dark:bg-slate-800/60 text-xs font-semibold text-slate-700 dark:text-slate-300">
                  Last sync — tools point at <code className="font-mono">{report.baseUrl}</code>
                </div>
                <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                  {report.steps.map((s, i) => (
                    <li key={i} className="px-4 py-2 flex items-center justify-between gap-3 text-xs">
                      <span className="text-slate-700 dark:text-slate-300 font-mono truncate">{s.target}</span>
                      <Badge tone={s.action === 'unchanged' ? 'mute' : 'ok'}>{s.action.toUpperCase()}</Badge>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </Section>

      {/* ── Voice ─────────────────────────────────────────────────────────── */}
      <Section
        icon={<Phone className="w-5 h-5" />}
        title="Voice number"
        description="Importing this agency's Twilio number is the voice cutover: from that moment the agent answers it instead of this platform's own call handler."
      >
        {numbersError ? (
          <Note kind="info"><p>{numbersError}</p></Note>
        ) : imported ? (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <Badge tone="ok">ANSWERED BY THE AGENT</Badge>
              <span className="text-sm font-semibold text-slate-900 dark:text-white">{imported.phoneNumber}</span>
              <span className="text-xs text-slate-500 dark:text-slate-400">{imported.label}</span>
            </div>

            {!releaseOpen ? (
              <button onClick={() => setReleaseOpen(true)} disabled={busy !== null} className={btnQuiet}>
                <Unlink className="w-4 h-4" /> Release this number
              </button>
            ) : (
              <div className="rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-500/[0.06] p-4 space-y-3">
                <p className="text-xs text-amber-800 dark:text-amber-300 leading-relaxed">
                  Releasing removes the number from ElevenLabs, so the agent stops answering it.
                  That is only half of going back: calls will not reach this platform again until
                  you also re-point the number&rsquo;s voice webhook in the Twilio console, which
                  cannot be done from here.
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => run('release', () => api.agentProvisioning.releaseNumber(), (r: { note: string }) => {
                      setNotice(r.note);
                      setReleaseOpen(false);
                    })}
                    disabled={busy !== null}
                    className={btnDanger}
                  >
                    {busy === 'release' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Unlink className="w-4 h-4" />}
                    Release the number
                  </button>
                  <button onClick={() => setReleaseOpen(false)} className={btnQuiet}>Cancel</button>
                </div>
              </div>
            )}
          </>
        ) : !cutoverOpen ? (
          <>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              No number has been handed to the agent. Calls are answered by this platform&rsquo;s own
              call handler.
            </p>
            <button onClick={() => setCutoverOpen(true)} disabled={busy !== null} className={btnPrimary}>
              <Link2 className="w-4 h-4" /> Import the Twilio number…
            </button>
          </>
        ) : (
          <div className="rounded-xl border border-amber-300 dark:border-amber-500/40 bg-amber-500/[0.07] p-4 space-y-4">
            <p className="text-xs font-bold text-amber-900 dark:text-amber-200 uppercase tracking-wider">
              This changes who talks to your citizens
            </p>
            <p className="text-xs text-amber-800 dark:text-amber-300 leading-relaxed">
              ElevenLabs is given this agency&rsquo;s Twilio credentials so it can answer the number
              itself. From then on the hosted agent picks up every call, not this platform&rsquo;s
              call handler. It is reversible — releasing the number brings it back — but it is not a
              settings tweak, and the voice path has never completed a real call under either engine.
            </p>

            <div>
              <label className="text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5 block uppercase tracking-wider">
                Label (optional)
              </label>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Defaults to the agency name plus “main line”"
                className="w-full px-4 py-2.5 rounded-xl bg-white dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40"
              />
            </div>

            <Gate checked={enableSms} onChange={setEnableSms}>
              Also route this number&rsquo;s inbound SMS to ElevenLabs. Off by default, and against
              the upstream default: this platform consumes no inbound SMS, so turning it on changes
              your Twilio configuration for nothing you asked for.
            </Gate>

            <Gate checked={cutoverAck} onChange={setCutoverAck}>
              I understand that the hosted agent will answer{' '}
              <strong>every call to this number</strong> from now on, in place of this platform.
            </Gate>

            <div className="flex gap-2">
              <button
                onClick={() => run('import', () => api.agentProvisioning.importNumber({
                  // Reachable only behind the tick box above. The flag exists
                  // to make somebody read; sending it on a bare click would
                  // satisfy the server and defeat the whole point of it.
                  confirmVoiceCutover: true,
                  enableSms,
                  ...(label.trim() ? { label: label.trim() } : {}),
                }), () => {
                  setCutoverOpen(false);
                  setCutoverAck(false);
                })}
                disabled={!cutoverAck || busy !== null}
                className={btnDanger}
              >
                {busy === 'import' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Phone className="w-4 h-4" />}
                Import and cut over
              </button>
              <button
                onClick={() => { setCutoverOpen(false); setCutoverAck(false); }}
                className={btnQuiet}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </Section>

      {/* ── WhatsApp ──────────────────────────────────────────────────────── */}
      <Section
        icon={<MessageSquare className="w-5 h-5" />}
        title="WhatsApp line"
        description="Connecting a line happens in the ElevenLabs dashboard — Meta's signup needs a human, so no API can do it. What this screen does is point an already-connected line at this agency's agent."
      >
        {whatsappError ? (
          <Note kind="info"><p>{whatsappError}</p></Note>
        ) : accounts.length === 0 ? (
          <Note kind="info">
            <p>
              No WhatsApp line is connected to this workspace yet. Connect one in the ElevenLabs
              dashboard through Meta&rsquo;s embedded signup, then it will appear here to be
              attached.
            </p>
          </Note>
        ) : (
          <div className="space-y-3">
            {[...(attached ? [attached] : []), ...unclaimed].map((a) => (
              <div
                key={a.phoneNumberId}
                className="rounded-xl border border-slate-200 dark:border-slate-700 p-4 space-y-3"
              >
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className="text-sm font-semibold text-slate-900 dark:text-white">{a.phoneNumber}</span>
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    {a.phoneNumberName} · {a.businessAccountName}
                  </span>
                  {a.isOurs ? (
                    a.messagingEnabled === false ? <Badge tone="bad">PAUSED</Badge>
                      : a.messagingEnabled === true ? <Badge tone="ok">ANSWERING</Badge>
                      : <Badge tone="warn">PAUSE STATE NOT REPORTED</Badge>
                  ) : (
                    <Badge tone="mute">UNCLAIMED</Badge>
                  )}
                  {a.isTokenExpired && <Badge tone="bad">META TOKEN EXPIRED</Badge>}
                </div>

                {a.isTokenExpired && (
                  <Note kind="warn">
                    <p>
                      This line&rsquo;s Meta access token has expired, so it can neither send nor
                      receive — quietly. Reconnect it in the ElevenLabs dashboard; attaching an agent
                      to it would report success and then answer nothing.
                    </p>
                  </Note>
                )}

                {a.isOurs && a.messagingEnabled === false && (
                  <Note kind="warn">
                    <p>
                      The agent is not replying on this line. Messages from citizens still arrive and
                      nothing answers them, so somebody has to.
                    </p>
                  </Note>
                )}

                <div className="flex flex-wrap gap-2">
                  {!a.isOurs ? (
                    <button
                      onClick={() => run(`attach:${a.phoneNumberId}`, () => api.agentProvisioning.attachWhatsApp(a.phoneNumberId))}
                      disabled={busy !== null || a.isTokenExpired}
                      className={btnPrimary}
                    >
                      {busy === `attach:${a.phoneNumberId}` ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />}
                      Attach to this agency&rsquo;s agent
                    </button>
                  ) : (
                    <>
                      {a.messagingEnabled === false ? (
                        <button
                          onClick={() => run('resume', () => api.agentProvisioning.pauseWhatsApp({ paused: false }), (r: { note: string }) => setNotice(r.note))}
                          disabled={busy !== null}
                          className={btnPrimary}
                        >
                          {busy === 'resume' ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlayCircle className="w-4 h-4" />}
                          Let the agent answer again
                        </button>
                      ) : (
                        <button onClick={() => setPauseOpen(true)} disabled={busy !== null} className={btnQuiet}>
                          <PauseCircle className="w-4 h-4" /> Pause the whole line…
                        </button>
                      )}
                      <button
                        onClick={() => run('detach', () => api.agentProvisioning.detachWhatsApp())}
                        disabled={busy !== null}
                        className={btnQuiet}
                      >
                        {busy === 'detach' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Unlink className="w-4 h-4" />}
                        Detach
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}

            {pauseOpen && attached && (
              <div className="rounded-xl border border-red-300 dark:border-red-500/40 bg-red-500/[0.06] p-4 space-y-4">
                <p className="text-xs font-bold text-red-800 dark:text-red-300 uppercase tracking-wider">
                  This is an outage, not a handoff
                </p>
                <p className="text-xs text-red-700 dark:text-red-300/90 leading-relaxed">
                  ElevenLabs offers no way to stop one conversation, so the only lever is the whole
                  line. Pausing stops the agent replying to <strong>every citizen</strong> messaging{' '}
                  {attached.phoneNumber}, not just the thread you are looking at. Their messages
                  still arrive; nobody answers them until a person does, or until the line is
                  resumed.
                </p>
                <Gate checked={pauseAck} onChange={setPauseAck}>
                  I understand this silences the agent for every conversation on this number.
                </Gate>
                <div className="flex gap-2">
                  <button
                    onClick={() => run('pause', () => api.agentProvisioning.pauseWhatsApp({
                      paused: true,
                      confirmAffectsEveryConversation: true,
                    }), (r: { note: string }) => {
                      setNotice(r.note);
                      setPauseOpen(false);
                      setPauseAck(false);
                    })}
                    disabled={!pauseAck || busy !== null}
                    className={btnDanger}
                  >
                    {busy === 'pause' ? <Loader2 className="w-4 h-4 animate-spin" /> : <PauseCircle className="w-4 h-4" />}
                    Pause the line
                  </button>
                  <button onClick={() => { setPauseOpen(false); setPauseAck(false); }} className={btnQuiet}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </Section>
    </div>
  );
}
