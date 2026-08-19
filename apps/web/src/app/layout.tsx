"use client";
import './globals.css';
import React, { useEffect, useState, useRef } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  LayoutDashboard,
  MessageSquareText,
  MessageCircle,
  Users,
  BookOpen,
  Settings,
  Building2,
  Sparkles,
  LogOut,
  Calendar,
  PhoneCall,
  ChevronRight,
  Bell,
  Menu,
  X,
  GitFork,
  Sun,
  Moon
} from 'lucide-react';
import { io } from 'socket.io-client';

import { API_URL, clearSession, refreshSession } from '@/lib/api';
import { ToastProvider } from '@/components/ui/Toast';

/**
 * Routes reachable without a session.
 */
const PUBLIC_ROUTES = [
  '/login',
  '/register',
  '/forgot-password',
  '/reset-password',
  '/verify-email',
  '/setup-account',
  '/selfie',
  '/pay',
  '/billing/success',
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  const [user, setUser] = useState<{ fullName?: string; email?: string; role?: string; organizationName?: string } | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [notifications, setNotifications] = useState<any[]>([]);
  const [showNotifications, setShowNotifications] = useState(false);
  const didRedirect = useRef(false);

  const unreadCount = notifications.filter(n => !n.read).length;

  useEffect(() => {
    // Load theme preference
    const savedTheme = localStorage.getItem('ace_theme') as 'light' | 'dark' | null;
    if (savedTheme) {
      setTheme(savedTheme);
    } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
      setTheme('light');
    }
  }, []);

  const toggleTheme = () => {
    const nextTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(nextTheme);
    localStorage.setItem('ace_theme', nextTheme);
  };

  useEffect(() => {
    const token = localStorage.getItem('ace_token');
    if (!token) return;

    // Connect to the '/events' NAMESPACE, where AgentConsoleGateway actually lives.
    // This used to call io(API_URL), landing on the default '/' namespace — which has
    // no gateway at all — and then listen for 'new_message' / 'new_call', names the
    // server never emits (it emits 'new_message_received' and 'call_status_updated').
    // The bell icon could therefore never show a single notification.
    const socket = io(`${API_URL}/events`, {
      auth: { token },
      transports: ['websocket', 'polling'],
    });

    const push = (type: string, text: string) => {
      setNotifications(prev => [
        { type, text, timestamp: new Date().toISOString(), read: false },
        ...prev,
      ].slice(0, 20));
    };

    socket.on('new_message_received', (data: any) =>
      push('message', data?.message?.content ? `New message: ${String(data.message.content).slice(0, 60)}` : 'New message received'));
    socket.on('call_status_updated', (data: any) =>
      push('call', `Call ${data?.status ?? 'updated'}`));
    socket.on('conversation_takeover_updated', () =>
      push('handoff', 'A conversation was handed to an agent'));
    socket.on('new_ticket', (data: any) =>
      push('ticket', data?.subject ? `New ticket: ${data.subject}` : 'New support ticket'));
    socket.on('new_lead', () => push('lead', 'New lead captured'));
    socket.on('unauthorized', () => socket.disconnect());

    return () => { socket.disconnect(); };
  }, []);

  useEffect(() => {
    setMounted(true);
  }, []);

  /**
   * Re-read the stored identity on every navigation.
   *
   * This ran once on mount with an empty dependency array. The layout is not
   * remounted by client-side navigation, so after signing in — which writes
   * `ace_user` and then router.push('/') — the effect never ran again and the
   * sidebar kept showing the "My Organization" / "Administrator" placeholders until
   * the user happened to do a full page reload. Verified in the browser: the header
   * greeted "Browser QA Clinic" while the sidebar still said "My Organization".
   *
   * Also listens for `storage` so signing out in one tab updates the others.
   */
  useEffect(() => {
    const readUser = () => {
      try {
        const stored = localStorage.getItem('ace_user');
        setUser(stored ? JSON.parse(stored) : null);
      } catch {
        setUser(null);
      }
    };

    readUser();
    window.addEventListener('storage', readUser);
    return () => window.removeEventListener('storage', readUser);
  }, [pathname]);

  useEffect(() => {
    const checkAuth = async () => {
      const token = localStorage.getItem('ace_token');
      const refreshToken = localStorage.getItem('ace_refresh_token');
      const isPublic = PUBLIC_ROUTES.some(r => pathname === r || pathname.startsWith(r + '/'));

      if (!token && !isPublic) {
        if (refreshToken) {
          const refreshed = await refreshSession();
          if (refreshed) return;
        }
        if (!didRedirect.current) {
          didRedirect.current = true;
          router.replace('/login');
        }
      } else if (token && pathname === '/login') {
        router.replace('/');
      }
    };

    checkAuth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  const handleLogout = async () => {
    // Tell the server first so the token is actually revoked. Clearing localStorage
    // alone left the access AND refresh tokens valid for their full lifetime — a
    // token copied from a shared machine kept working after "signing out".
    const token = localStorage.getItem('ace_token');
    if (token) {
      try {
        await fetch(`${API_URL}/api/auth/logout`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch {
        // Network failure must not trap the user in a signed-in UI.
      }
    }
    clearSession();
    router.replace('/login');
  };

  const isAuthPage = PUBLIC_ROUTES.some(r => pathname === r || pathname?.startsWith(r + '/'));

  const initials = user?.fullName
    ? user.fullName.split(' ').map((n: string) => n[0]).join('').slice(0, 2).toUpperCase()
    : 'AD';

  return (
    <html lang="en" className={theme}>
      <head>
        <title>PLASCHEMA — Enrollee Helpline &amp; Management System</title>
        <meta name="description" content="Plateau State Contributory Healthcare Management Agency — Enrollee Services, Knowledge Base &amp; Communications" />
        {/*
          No webfont is fetched from a CDN.

          This used to load Inter from fonts.googleapis.com with a
          render-blocking stylesheet link. That put a third-party request on
          the critical path of every page: on a machine without internet — an
          offline demo, a locked-down corporate network, a Nigerian office on a
          dropped connection — the request hangs or resets and the page renders
          in a fallback face anyway, just later. It is also a privacy leak, as
          every visitor's IP reaches Google on every page load.

          The declaration below is unchanged from when the link tag was here,
          deliberately: it is what already rendered whenever the CDN was slow
          or blocked, so removing the request changes no metrics. A wider
          fallback chain was tried and rejected — it re-flowed the sidebar and
          truncated labels like "WhatsApp Broadcasts". To ship Inter itself,
          commit the woff2 files and load them with next/font/local —
          self-hosted, still no CDN.
        */}
      </head>
      <body className={`min-h-screen flex flex-col antialiased transition-colors duration-200 ${
        theme === 'dark' ? 'bg-[#0b0f19] text-slate-100' : 'bg-slate-50 text-slate-900'
      }`} style={{ fontFamily: "'Inter', sans-serif" }}>
        <ToastProvider>
        {!mounted ? (
          <div className="flex min-h-screen items-center justify-center">
            <div className="flex flex-col items-center gap-4">
              <div className="w-12 h-12 rounded-2xl flex items-center justify-center shadow-lg shadow-[#74BA03]/30 animate-pulse" style={{ background: 'linear-gradient(135deg, #558A02, #74BA03)' }}>
                <Sparkles className="w-6 h-6 text-white" />
              </div>
              <div className="w-6 h-6 rounded-full border-2 border-[#74BA03] border-t-transparent animate-spin" />
            </div>
          </div>
        ) : isAuthPage ? (
          <div className="w-full min-h-screen flex flex-col">
            {children}
          </div>
        ) : (
          <div className="flex h-screen overflow-hidden relative">
            {/* Ambient Background Glows */}
            <div className="absolute top-0 left-1/4 w-96 h-96 bg-[#74BA03]/10 dark:bg-[#558A02]/10 rounded-full blur-3xl pointer-events-none" />
            <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-[#558A02]/10 dark:bg-[#74BA03]/5 rounded-full blur-3xl pointer-events-none" />

            {/* Sidebar Mobile Overlay */}
            {sidebarOpen && (
              <div 
                className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-40 md:hidden" 
                onClick={() => setSidebarOpen(false)} 
              />
            )}

            {/* Sidebar */}
            <aside className={`fixed md:relative z-50 w-64 h-full flex-shrink-0 flex flex-col justify-between transition-all duration-300 ${
              theme === 'dark' 
                ? 'bg-[#0f172a]/95 border-r border-slate-800/80' 
                : 'bg-white/90 border-r border-slate-200/80 shadow-sm'
            } backdrop-blur-xl ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'} md:translate-x-0`}>
              <button 
                className="md:hidden absolute top-4 right-4 text-slate-400 hover:text-slate-200 z-50 p-1"
                onClick={() => setSidebarOpen(false)}
              >
                <X className="w-5 h-5" />
              </button>

              {/* Top section */}
              <div className="flex flex-col h-full">
                {/* Logo */}
                <div className={`flex items-center gap-3.5 px-6 py-5 border-b ${theme === 'dark' ? 'border-slate-800/80' : 'border-slate-200/80'}`}>
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center shadow-lg" style={{ background: 'linear-gradient(135deg, #558A02, #74BA03)' }}>
                    {/* Health cross icon */}
                    <svg className="w-6 h-6 text-white" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M19 3H5C3.9 3 3 3.9 3 5v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-2 10h-4v4h-2v-4H7v-2h4V7h2v4h4v2z"/>
                    </svg>
                  </div>
                  <div>
                    <h1 className={`font-bold text-base tracking-tight leading-tight ${theme === 'dark' ? 'text-white' : 'text-slate-900'}`}>PLASCHEMA</h1>
                    <p className="text-[11px] font-medium" style={{ color: '#74BA03' }}>Enrollee Helpline Portal</p>
                  </div>
                </div>

                {/* Org badge */}
                <div className={`mx-4 mt-4 mb-2 px-3.5 py-2.5 rounded-xl flex items-center justify-between border ${
                  theme === 'dark' 
                    ? 'bg-slate-800/40 border-slate-700/50' 
                    : 'bg-slate-100/80 border-slate-200'
                }`}>
                  <div className="flex items-center gap-2 overflow-hidden min-w-0">
                    <Building2 className="w-4 h-4 text-[#74BA03] flex-shrink-0" />
                    <span className={`text-xs font-semibold truncate ${theme === 'dark' ? 'text-slate-200' : 'text-slate-800'}`}>
                      {user?.organizationName || 'PLASCHEMA'}
                    </span>
                  </div>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 font-bold tracking-wider flex-shrink-0 ml-2 border border-emerald-500/20">LIVE</span>
                </div>

                {/* Nav */}
                <nav className="flex-1 px-3.5 py-3 space-y-1 overflow-y-auto">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-slate-500 px-3 py-1.5 mt-1">Helpline</p>
                  <SidebarLink href="/" icon={<LayoutDashboard className="w-4 h-4" />} label="Dashboard" pathname={pathname} theme={theme} onClick={() => setSidebarOpen(false)} />
                  <SidebarLink href="/crm" icon={<Users className="w-4 h-4" />} label="Enrollees & Contacts" pathname={pathname} theme={theme} onClick={() => setSidebarOpen(false)} />
                  <SidebarLink href="/agent-console" icon={<MessageSquareText className="w-4 h-4" />} label="Agent Console" pathname={pathname} theme={theme} onClick={() => setSidebarOpen(false)} />
                  <SidebarLink href="/conversations" icon={<MessageCircle className="w-4 h-4" />} label="Live Conversations" pathname={pathname} theme={theme} onClick={() => setSidebarOpen(false)} />
                  <SidebarLink href="/knowledge" icon={<BookOpen className="w-4 h-4" />} label="Knowledge & FAQs" pathname={pathname} theme={theme} onClick={() => setSidebarOpen(false)} />
                  <SidebarLink href="/workflows" icon={<GitFork className="w-4 h-4" />} label="Automation Workflows" pathname={pathname} theme={theme} onClick={() => setSidebarOpen(false)} />

                  <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-slate-500 px-3 py-1.5 mt-4">Channels</p>
                  <SidebarLink href="/broadcasts" icon={<MessageSquareText className="w-4 h-4" />} label="WhatsApp Broadcasts" pathname={pathname} theme={theme} onClick={() => setSidebarOpen(false)} />
                  <SidebarLink href="/telephony" icon={<PhoneCall className="w-4 h-4" />} label="Helpline & Telephony" pathname={pathname} theme={theme} onClick={() => setSidebarOpen(false)} />
                  <SidebarLink href="/scheduling" icon={<Calendar className="w-4 h-4" />} label="Appointments" pathname={pathname} theme={theme} onClick={() => setSidebarOpen(false)} />

                  <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-slate-500 px-3 py-1.5 mt-4">Administration</p>
                  <SidebarLink href="/billing" icon={<Sparkles className="w-4 h-4" />} label="Billing & Plans" pathname={pathname} theme={theme} onClick={() => setSidebarOpen(false)} />
                  <SidebarLink href="/white-label" icon={<Building2 className="w-4 h-4" />} label="Branding & White Label" pathname={pathname} theme={theme} onClick={() => setSidebarOpen(false)} />
                  <SidebarLink href="/settings" icon={<Settings className="w-4 h-4" />} label="System Settings" pathname={pathname} theme={theme} onClick={() => setSidebarOpen(false)} />
                </nav>

                {/* User footer */}
                <div className={`px-4 py-4 border-t ${theme === 'dark' ? 'border-slate-800/80 bg-slate-900/40' : 'border-slate-200/80 bg-slate-100/50'}`}>
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-xl text-white font-bold flex items-center justify-center text-xs shadow-md flex-shrink-0" style={{ background: 'linear-gradient(135deg, #558A02, #74BA03)' }}>
                      {initials}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className={`text-xs font-bold truncate ${theme === 'dark' ? 'text-slate-200' : 'text-slate-800'}`}>{user?.fullName || 'Administrator'}</p>
                      <p className="text-[10px] text-slate-400 truncate">{user?.email || ''}</p>
                    </div>
                    <button
                      onClick={handleLogout}
                      title="Sign out"
                      className="p-1.5 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-500/10 transition-colors flex-shrink-0"
                    >
                      <LogOut className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            </aside>

            {/* Main content */}
            <div className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
              {/* Top bar */}
              <header className={`h-16 flex-shrink-0 flex items-center justify-between px-6 border-b transition-colors duration-200 ${
                theme === 'dark' 
                  ? 'bg-[#0b0f19]/80 border-slate-800/80' 
                  : 'bg-white/80 border-slate-200/80'
              } backdrop-blur-xl z-20`}>
                <div className="flex items-center gap-2 text-sm text-slate-400">
                  <button 
                    className="md:hidden mr-2 p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800/50" 
                    onClick={() => setSidebarOpen(true)}
                  >
                    <Menu className="w-5 h-5" />
                  </button>
                  {/* Breadcrumb */}
                  <span className="font-semibold" style={{ color: '#74BA03' }}>PLASCHEMA</span>
                  <ChevronRight className="w-3.5 h-3.5 opacity-60" />
                  <span className={`font-semibold capitalize ${theme === 'dark' ? 'text-white' : 'text-slate-900'}`}>
                    {pathname === '/' ? 'Executive Dashboard' : pathname.slice(1).replace(/-/g, ' ')}
                  </span>
                </div>

                <div className="flex items-center gap-3">
                  {/* Theme Switcher Button */}
                  <button
                    onClick={toggleTheme}
                    className={`p-2 rounded-xl border transition-all flex items-center gap-2 text-xs font-semibold ${
                      theme === 'dark'
                        ? 'bg-slate-800/80 border-slate-700 text-[#74BA03] hover:bg-slate-700'
                        : 'bg-slate-100 border-slate-300 text-[#558A02] hover:bg-slate-200'
                    }`}
                    title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
                  >
                    {theme === 'dark' ? (
                      <>
                        <Sun className="w-4 h-4 text-[#74BA03]" />
                        <span className="hidden sm:inline text-slate-200">Light Mode</span>
                      </>
                    ) : (
                      <>
                        <Moon className="w-4 h-4 text-[#558A02]" />
                        <span className="hidden sm:inline text-slate-700">Dark Mode</span>
                      </>
                    )}
                  </button>

                  {/* Notifications Bell */}
                  <div className="relative">
                    <button 
                      className={`relative p-2 rounded-xl border transition-colors ${
                        theme === 'dark'
                          ? 'bg-slate-800/50 border-slate-700/60 text-slate-300 hover:text-white hover:bg-slate-800'
                          : 'bg-slate-100 border-slate-200 text-slate-600 hover:text-slate-900 hover:bg-slate-200/70'
                      }`}
                      onClick={() => setShowNotifications(!showNotifications)}
                    >
                      <Bell className="w-4 h-4" />
                      {unreadCount > 0 && <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-[#74BA03] ring-2 ring-[#558A02]" />}
                    </button>
                    {showNotifications && (
                      <div className={`absolute right-0 mt-2 w-80 border rounded-2xl shadow-2xl z-50 backdrop-blur-2xl ${
                        theme === 'dark' 
                          ? 'bg-slate-900/95 border-slate-700 text-slate-100' 
                          : 'bg-white/95 border-slate-200 text-slate-900 shadow-slate-200'
                      }`}>
                        <div className="p-4 border-b border-slate-700/50 flex justify-between items-center">
                          <span className="text-sm font-bold">Notifications</span>
                          <button onClick={() => setNotifications(prev => prev.map(n => ({...n, read: true})))} className="text-xs text-[#74BA03] hover:underline font-semibold">Mark all read</button>
                        </div>
                        <div className="max-h-72 overflow-y-auto">
                          {notifications.length === 0 ? (
                            <div className="p-6 text-sm text-slate-400 text-center">No new notifications</div>
                          ) : (
                            notifications.map((n, i) => (
                              <div key={i} className="p-3.5 border-b border-slate-700/30 flex items-start gap-3 hover:bg-[#74BA03]/5">
                                <div className="w-2 h-2 mt-1.5 rounded-full bg-[#74BA03] flex-shrink-0" style={{ opacity: n.read ? 0.3 : 1 }} />
                                <div>
                                  <div className="text-xs font-medium">{n.text}</div>
                                  <div className="text-[10px] text-slate-400 mt-1">{new Date(n.timestamp).toLocaleTimeString()}</div>
                                </div>
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="w-9 h-9 rounded-xl text-white font-bold flex items-center justify-center text-xs shadow-md" style={{ background: 'linear-gradient(135deg, #558A02, #74BA03)' }}>
                    {initials}
                  </div>
                </div>
              </header>

              <main className="flex-1 overflow-y-auto p-6 relative">
                {children}
              </main>
            </div>
          </div>
        )}
        </ToastProvider>
      </body>
    </html>
  );
}

function SidebarLink({ href, icon, label, pathname, theme, onClick }: { href: string; icon: React.ReactNode; label: string; pathname: string; theme: 'light' | 'dark'; onClick?: () => void }) {
  const isActive = pathname === href || (href !== '/' && pathname.startsWith(href));
  return (
    <Link
      href={href}
      onClick={onClick}
      className={`flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-semibold transition-all group ${
        isActive
          ? theme === 'dark'
            ? 'bg-[#74BA03]/20 text-[#74BA03] border border-[#74BA03]/30 shadow-md shadow-[#74BA03]/10'
            : 'bg-emerald-50 text-[#558A02] border border-[#74BA03]/30 shadow-sm'
          : theme === 'dark'
            ? 'text-slate-400 hover:text-slate-100 hover:bg-slate-800/40 border border-transparent'
            : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100 border border-transparent'
      }`}
    >
      <span className={`transition-transform duration-200 group-hover:scale-110 ${
        isActive 
          ? 'text-[#74BA03] dark:text-[#74BA03]' 
          : 'text-slate-400 group-hover:text-[#74BA03]'
      }`}>
        {icon}
      </span>
      <span className="truncate">{label}</span>
    </Link>
  );
}
