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
  Code
} from 'lucide-react';
import { io } from 'socket.io-client';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [user, setUser] = useState<{ fullName?: string; email?: string; role?: string; organizationName?: string } | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [notifications, setNotifications] = useState<any[]>([]);
  const [showNotifications, setShowNotifications] = useState(false);
  const didRedirect = useRef(false);

  const unreadCount = notifications.filter(n => !n.read).length;

  useEffect(() => {
    const token = localStorage.getItem('ace_token');
    if (token) {
      const socket = io(process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000', {
        auth: { token }
      });
      const handleEvent = (type: string) => (data: any) => {
        setNotifications(prev => {
          const newNotifs = [{ type, text: data?.text || `New ${type.replace('new_', '')}`, timestamp: new Date().toISOString(), read: false }, ...prev];
          return newNotifs.slice(0, 20);
        });
      };
      socket.on('new_message', handleEvent('new_message'));
      socket.on('new_ticket', handleEvent('new_ticket'));
      socket.on('new_call', handleEvent('new_call'));
      socket.on('new_lead', handleEvent('new_lead'));
      return () => { socket.disconnect(); };
    }
  }, []);

  useEffect(() => {
    setMounted(true);
    // Load user info
    try {
      const stored = localStorage.getItem('ace_user');
      if (stored) setUser(JSON.parse(stored));
    } catch {}

    // Auth check & auto-login for demo environment
    const token = localStorage.getItem('ace_token');
    if (!token && pathname !== '/login' && !pathname.startsWith('/register') && !pathname.startsWith('/forgot-password') && !pathname.startsWith('/verify-email') && !pathname.startsWith('/setup-account')) {
      if (!didRedirect.current) {
        didRedirect.current = true;
        router.replace('/login');
      }
    } else if (token && pathname === '/login') {
      router.replace('/');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // ← intentionally empty: only run on mount

  const handleLogout = () => {
    localStorage.removeItem('ace_token');
    localStorage.removeItem('ace_user');
    router.replace('/login');
  };

  const isAuthPage = pathname === '/login' || 
    pathname?.startsWith('/register') || 
    pathname?.startsWith('/forgot-password') || 
    pathname?.startsWith('/verify-email') || 
    pathname?.startsWith('/setup-account') ||
    pathname?.startsWith('/widget');

  const initials = user?.fullName
    ? user.fullName.split(' ').map((n: string) => n[0]).join('').slice(0, 2).toUpperCase()
    : 'AD';

  return (
    <html lang="en" className="dark">
      <head>
        <title>ACE Platform — AI-Powered Customer Experience</title>
        <meta name="description" content="Unify your CRM, Knowledge Base, and Omnichannel Communications" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet" />
      </head>
      <body className="bg-[#080c18] text-gray-100 min-h-screen flex flex-col antialiased" style={{ fontFamily: "'Inter', sans-serif" }}>
        {!mounted ? (
          <div className="flex min-h-screen items-center justify-center bg-[#080c18]">
            <div className="flex flex-col items-center gap-4">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-blue-500 to-blue-600 flex items-center justify-center">
                <Sparkles className="w-6 h-6 text-white" />
              </div>
              <div className="w-6 h-6 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
            </div>
          </div>
        ) : isAuthPage ? (
          <div className="w-full min-h-screen flex flex-col">
            {children}
          </div>
        ) : (
          <div className="flex h-screen overflow-hidden">
            {/* Sidebar */}
            {sidebarOpen && (
              <div 
                className="fixed inset-0 bg-black/50 z-20 md:hidden" 
                onClick={() => setSidebarOpen(false)} 
              />
            )}
            <aside className={`fixed md:relative z-30 w-64 h-full flex-shrink-0 flex flex-col justify-between border-r border-white/[0.06] bg-[#0d1225] transition-transform duration-300 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'} md:translate-x-0`}>
              <button 
                className="md:hidden absolute top-4 right-4 text-gray-400 hover:text-white z-50"
                onClick={() => setSidebarOpen(false)}
              >
                <X className="w-5 h-5" />
              </button>
              {/* Top section */}
              <div className="flex flex-col h-full">
                {/* Logo */}
                <div className="flex items-center gap-3 px-5 py-5 border-b border-white/[0.06]">
                  <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-blue-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-blue-500/25">
                    <Sparkles className="w-5 h-5 text-white" />
                  </div>
                  <div>
                    <h1 className="font-bold text-base leading-tight text-white">ACE Platform</h1>
                    <p className="text-[10px] text-gray-500">AI Customer Experience</p>
                  </div>
                </div>

                {/* Org badge */}
                <div className="mx-4 mt-4 mb-2 px-3 py-2 rounded-xl bg-white/[0.04] border border-white/[0.07] flex items-center justify-between">
                  <div className="flex items-center gap-2 overflow-hidden min-w-0">
                    <Building2 className="w-3.5 h-3.5 text-blue-400 flex-shrink-0" />
                    <span className="text-xs font-semibold truncate text-gray-200">
                      {user?.organizationName || 'My Organization'}
                    </span>
                  </div>
                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 font-bold tracking-wider flex-shrink-0 ml-2">LIVE</span>
                </div>

                {/* Nav */}
                <nav className="flex-1 px-3 py-2 space-y-0.5 overflow-y-auto">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-gray-600 px-3 py-2 mt-1">Main</p>
                  <SidebarLink href="/" icon={<LayoutDashboard className="w-4 h-4" />} label="Dashboard" pathname={pathname} />
                  <SidebarLink href="/crm" icon={<Users className="w-4 h-4" />} label="CRM" pathname={pathname} />
                  <SidebarLink href="/agent-console" icon={<MessageSquareText className="w-4 h-4" />} label="Agent Console" pathname={pathname} />
                  <SidebarLink href="/conversations" icon={<MessageCircle className="w-4 h-4" />} label="Conversations" pathname={pathname} />
                  <SidebarLink href="/knowledge" icon={<BookOpen className="w-4 h-4" />} label="Knowledge Base" pathname={pathname} />

                  <p className="text-[10px] font-bold uppercase tracking-widest text-gray-600 px-3 py-2 mt-3">Channels</p>
                  <SidebarLink href="/broadcasts" icon={<MessageSquareText className="w-4 h-4" />} label="WhatsApp Broadcasts" pathname={pathname} />
                  <SidebarLink href="/telephony" icon={<PhoneCall className="w-4 h-4" />} label="Voice & Telephony" pathname={pathname} />
                  <SidebarLink href="/scheduling" icon={<Calendar className="w-4 h-4" />} label="Scheduling" pathname={pathname} />
                  <SidebarLink href="/widget" icon={<Code className="w-4 h-4" />} label="Web Chat & Voice Widget" pathname={pathname} />

                  <p className="text-[10px] font-bold uppercase tracking-widest text-gray-600 px-3 py-2 mt-3">Account</p>
                  <SidebarLink href="/billing" icon={<Sparkles className="w-4 h-4" />} label="Billing" pathname={pathname} />
                  <SidebarLink href="/white-label" icon={<Building2 className="w-4 h-4" />} label="White Label" pathname={pathname} />
                  <SidebarLink href="/settings" icon={<Settings className="w-4 h-4" />} label="Settings" pathname={pathname} />
                </nav>

                {/* User footer */}
                <div className="px-4 py-4 border-t border-white/[0.06]">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 text-white font-bold flex items-center justify-center text-xs flex-shrink-0">
                      {initials}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold text-gray-200 truncate">{user?.fullName || 'Administrator'}</p>
                      <p className="text-[10px] text-gray-500 truncate">{user?.email || 'admin@acedemo.com'}</p>
                    </div>
                    <button
                      onClick={handleLogout}
                      title="Sign out"
                      className="text-gray-500 hover:text-red-400 transition-colors flex-shrink-0"
                    >
                      <LogOut className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            </aside>

            {/* Main content */}
            <div className="flex-1 flex flex-col min-w-0 overflow-hidden bg-[#080c18]">
              {/* Top bar */}
              <header className="h-14 flex-shrink-0 flex items-center justify-between px-6 border-b border-white/[0.06] bg-[#080c18]">
                <div className="flex items-center gap-2 text-sm text-gray-400">
                  <button className="md:hidden mr-2 text-gray-400 hover:text-white" onClick={() => setSidebarOpen(true)}>
                    <Menu className="w-5 h-5" />
                  </button>
                  {/* Breadcrumb */}
                  <span>ACE</span>
                  <ChevronRight className="w-3.5 h-3.5" />
                  <span className="text-white font-medium capitalize">{pathname.slice(1) || 'Dashboard'}</span>
                </div>
                <div className="flex items-center gap-3">
                  <div className="relative">
                    <button 
                      className="relative w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-white hover:bg-white/5 transition-colors"
                      onClick={() => setShowNotifications(!showNotifications)}
                    >
                      <Bell className="w-4 h-4" />
                      {unreadCount > 0 && <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-red-500" />}
                    </button>
                    {showNotifications && (
                      <div className="absolute right-0 mt-2 w-72 bg-[#0d1225] border border-white/[0.06] rounded-xl shadow-xl z-50">
                        <div className="p-3 border-b border-white/[0.06] flex justify-between items-center">
                          <span className="text-sm font-semibold text-white">Notifications</span>
                          <button onClick={() => setNotifications(prev => prev.map(n => ({...n, read: true})))} className="text-xs text-blue-400 hover:text-blue-300">Mark all read</button>
                        </div>
                        <div className="max-h-64 overflow-y-auto">
                          {notifications.length === 0 ? (
                            <div className="p-4 text-sm text-gray-500 text-center">No notifications</div>
                          ) : (
                            notifications.map((n, i) => (
                              <div key={i} className={`p-3 border-b border-white/[0.06] flex items-start gap-2 ${!n.read ? 'bg-white/[0.02]' : ''}`}>
                                <div className="w-2 h-2 mt-1.5 rounded-full bg-blue-500 flex-shrink-0" style={{ opacity: n.read ? 0 : 1 }} />
                                <div>
                                  <div className="text-xs text-gray-200">{n.text}</div>
                                  <div className="text-[10px] text-gray-500 mt-1">{new Date(n.timestamp).toLocaleTimeString()}</div>
                                </div>
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 text-white font-bold flex items-center justify-center text-xs">
                    {initials}
                  </div>
                </div>
              </header>

              <main className="flex-1 overflow-y-auto p-6">
                {children}
              </main>
            </div>
          </div>
        )}
      </body>
    </html>
  );
}

function SidebarLink({ href, icon, label, pathname }: { href: string; icon: React.ReactNode; label: string; pathname: string }) {
  const isActive = pathname === href || (href !== '/' && pathname.startsWith(href));
  return (
    <Link
      href={href}
      className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all group ${
        isActive
          ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20'
          : 'text-gray-400 hover:text-gray-100 hover:bg-white/[0.04] border border-transparent'
      }`}
    >
      <span className={`${isActive ? 'text-blue-400' : 'text-gray-500 group-hover:text-gray-300'} transition-colors`}>
        {icon}
      </span>
      <span>{label}</span>
      {isActive && <span className="ml-auto w-1.5 h-1.5 rounded-full bg-blue-400" />}
    </Link>
  );
}
