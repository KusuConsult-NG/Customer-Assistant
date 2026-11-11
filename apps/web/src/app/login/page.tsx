"use client";
import React, { useState } from 'react';
import { api } from '@/lib/api';
import { Sparkles, Eye, EyeOff, ShieldCheck, Landmark } from 'lucide-react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // Two-step sign-in (PRD §17). The password step returns a short-lived
  // step token, never a session, when the account has MFA on or the agency
  // requires it.
  const [step, setStep] = useState<'password' | 'code' | 'enrol' | 'recovery'>('password');
  const [mfaToken, setMfaToken] = useState('');
  const [code, setCode] = useState('');
  const [enrolment, setEnrolment] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [pendingSession, setPendingSession] = useState<any>(null);
  const router = useRouter();

  const startSession = (res: any) => {
    const token = res.accessToken || res.token;
    if (!token) {
      setError('Login failed: Token not returned from server');
      return;
    }
    localStorage.setItem('ace_token', token);
    if (res.refreshToken) localStorage.setItem('ace_refresh_token', res.refreshToken);
    if (res.user) localStorage.setItem('ace_user', JSON.stringify(res.user));
    router.push('/');
  };

  const handleCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      if (step === 'code') {
        startSession(await api.auth.mfaVerify(mfaToken, code.trim()));
      } else {
        const res = await api.auth.mfaEnrolEnable(mfaToken, code.trim());
        setRecoveryCodes(res.recoveryCodes ?? []);
        setPendingSession(res);
        setStep('recovery');
      }
    } catch (err: any) {
      setError(err.message || 'That code did not work.');
    } finally {
      setLoading(false);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await api.auth.login(email, password);
      if (res.mfaRequired) {
        setMfaToken(res.mfaToken);
        setStep('code');
        return;
      }
      if (res.mfaSetupRequired) {
        setMfaToken(res.mfaToken);
        setEnrolment(await api.auth.mfaEnrolSetup(res.mfaToken));
        setStep('enrol');
        return;
      }
      const token = res.accessToken || res.token;
      if (token) {
        localStorage.setItem('ace_token', token);
        // Persist the refresh token so the session can be renewed instead of hard
        // expiring: the API has always returned one and the dashboard discarded it.
        if (res.refreshToken) {
          localStorage.setItem('ace_refresh_token', res.refreshToken);
        }
        if (res.user) {
          localStorage.setItem('ace_user', JSON.stringify(res.user));
        }
        router.push('/');
      } else {
        setError('Login failed: Token not returned from server');
      }
    } catch (err: any) {
      setError(err.message || 'Invalid credentials. Please check your email and password.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex h-screen w-full overflow-hidden bg-slate-50 dark:bg-slate-900">
      {/* Left Column: Branding */}
      <div className="hidden lg:flex w-1/2 flex-col justify-between p-12 relative overflow-hidden bg-gradient-to-br from-surface-card via-surface-border to-surface-card">
        <div className="absolute inset-0 bg-gradient-to-tr from-brand-500/20 via-transparent to-brand-600/20 opacity-40"></div>
        
        <div className="relative z-10 flex items-center gap-3">
          <div className="w-12 h-12 rounded-xl flex items-center justify-center shadow-lg" style={{ background: 'linear-gradient(135deg, #3b6102, #4d7d02)' }}>
            {/* A neutral mark. This was a medical cross, which is a claim
                about what the agency does — wrong for a lands registry or a
                revenue board, and the same reason the sidebar dropped it. */}
            <Landmark className="w-7 h-7 text-white" />
          </div>
          <div>
            <h1 className="font-bold text-2xl text-white">
              Customer Care Platform
            </h1>
            <p className="text-xs font-semibold text-brand-400">
              Plateau State Government
            </p>
          </div>
        </div>
        
        <div className="relative z-10">
          <h2 className="text-4xl font-bold text-white mb-6 leading-tight">
            State Customer Care <br/><span className="text-brand-400">&amp; Citizen Services Portal</span>
          </h2>
          <p className="text-slate-300 text-base max-w-md">
            One place for citizens to reach any ministry, department or agency of the State — on WhatsApp, by phone, in the language they speak.
          </p>

          <div className="mt-8 p-4 rounded-2xl bg-brand-500/10 border border-brand-500/20 max-w-md">
            <div className="flex items-center gap-2 text-brand-400 text-sm font-semibold mb-1">
              <ShieldCheck className="w-4 h-4" /> Official Government Service
            </div>
            <p className="text-xs text-slate-300">
              Authorized desk officer and admin access for helpline operations, citizen records, case handling, and inquiries.
            </p>
          </div>
        </div>
        
        <div className="relative z-10 text-sm text-slate-400">
          © 2026 Plateau State Government. All rights reserved.
        </div>
      </div>
      
      {/* Right Column: Form */}
      <div className="w-full lg:w-1/2 flex items-center justify-center p-8">
        <div className="w-full max-w-md space-y-8">
          <div className="text-center lg:text-left">
            <h2 className="text-3xl font-bold text-slate-900 dark:text-white mb-2">Welcome Back</h2>
            <p className="text-slate-600 dark:text-slate-400">Sign in to your account</p>
          </div>

          {error && (
            <div className="p-4 rounded-xl bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 text-red-600 dark:text-red-400 text-sm">
              {error}
            </div>
          )}

          {step === 'recovery' && (
            <div className="space-y-4">
              <h3 className="text-base font-bold text-slate-900 dark:text-white">Save your recovery codes</h3>
              <p className="text-sm text-slate-600 dark:text-slate-300">
                Each code signs you in once if you lose your phone. They are shown only now — write them down or store them safely.
              </p>
              <ul className="grid grid-cols-2 gap-2 font-mono text-sm" aria-label="Recovery codes">
                {recoveryCodes.map((c) => <li key={c} className="px-3 py-2 rounded-lg bg-slate-100 dark:bg-slate-800">{c}</li>)}
              </ul>
              <button
                type="button"
                onClick={() => startSession(pendingSession)}
                className="w-full py-3.5 px-4 rounded-xl text-white font-semibold bg-[#3b6102] hover:bg-[#2f4e02]"
              >
                I have saved them — continue
              </button>
            </div>
          )}

          {(step === 'code' || step === 'enrol') && (
            <form onSubmit={handleCode} className="space-y-5">
              {step === 'enrol' && enrolment && (
                <div className="space-y-2 text-sm text-slate-700 dark:text-slate-300">
                  <p className="font-semibold text-slate-900 dark:text-white">Your agency requires two-step sign-in for administrators.</p>
                  <p>
                    In an authenticator app (Google Authenticator, Microsoft Authenticator, Authy), add an account with this
                    setup key, then enter the 6-digit code it shows.
                  </p>
                  <p className="font-mono text-base break-all px-3 py-2 rounded-lg bg-slate-100 dark:bg-slate-800 select-all" aria-label="Setup key">
                    {enrolment.secret}
                  </p>
                  <a href={enrolment.otpauthUrl} className="text-xs text-blue-700 dark:text-blue-400 underline">Open in an authenticator app on this device</a>
                </div>
              )}
              {step === 'code' && (
                <p className="text-sm text-slate-700 dark:text-slate-300">
                  Enter the 6-digit code from your authenticator app, or one of your recovery codes.
                </p>
              )}
              <div className="space-y-2">
                <label htmlFor="mfa-code" className="text-sm font-medium text-slate-700 dark:text-slate-300">Code</label>
                <input
                  id="mfa-code"
                  autoFocus
                  required
                  autoComplete="one-time-code"
                  inputMode={step === 'enrol' ? 'numeric' : 'text'}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  className="w-full px-4 py-3 rounded-xl bg-slate-100 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-white tracking-widest font-mono focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                  placeholder="123456"
                />
              </div>
              <button
                type="submit"
                disabled={loading}
                className="w-full py-3.5 px-4 rounded-xl text-white font-semibold bg-[#3b6102] hover:bg-[#2f4e02] disabled:opacity-50"
              >
                {loading ? 'Checking…' : step === 'enrol' ? 'Turn on and sign in' : 'Verify and sign in'}
              </button>
              <button type="button" onClick={() => { setStep('password'); setCode(''); setMfaToken(''); }} className="w-full text-xs text-slate-500 underline">
                Start again
              </button>
            </form>
          )}

          {step === 'password' && (
          <form onSubmit={handleLogin} className="space-y-6">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Email address</label>
              <input
                type="email"
                required
                value={email}
                onChange={e => setEmail(e.target.value)}
                className="w-full px-4 py-3 rounded-xl bg-slate-100 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all"
                placeholder="you@yourcompany.com"
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Password</label>
                <Link href="/forgot-password" className="text-xs text-blue-600 dark:text-blue-400 hover:underline">
                  Forgot password?
                </Link>
              </div>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  required
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className="w-full px-4 py-3 pr-12 rounded-xl bg-slate-100 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all"
                  placeholder="••••••••"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white p-1 transition-colors"
                  title={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3.5 px-4 rounded-xl text-white font-semibold shadow-lg transition-all disabled:opacity-50 flex items-center justify-center gap-2"
              style={{ background: 'linear-gradient(135deg, #3b6102, #4d7d02)' }}
            >
              {loading ? (
                <>
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                  Signing in...
                </>
              ) : (
                'Sign In'
              )}
            </button>
          </form>
          )}

          <div className="text-center text-sm text-slate-600 dark:text-slate-400">
            Citizen Care Portal &bull; Plateau State Government
          </div>
        </div>
      </div>
    </div>
  );
}
