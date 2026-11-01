"use client";

import React, { useEffect, useState, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { Loader2, CheckCircle2, XCircle } from 'lucide-react';

import { API_URL } from '@/lib/api';

function VerifyEmailContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token');
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');
  const [resendStatus, setResendStatus] = useState('');
  const [resending, setResending] = useState(false);
  const router = useRouter();

  /**
   * Ask for another verification link.
   *
   * `POST /api/auth/resend-verification` has always existed and nothing called
   * it, so a link that expired — 24 hours is easy to miss — left the person
   * with no way forward but to ask somebody with database access.
   *
   * The endpoint answers the SAME message whether or not the address exists, on
   * purpose: it must not become a way to discover who has an account. So this
   * screen repeats what the server said rather than claiming an email was sent.
   */
  const resend = async () => {
    if (!email.trim()) {
      setResendStatus('Enter the email address you registered with.');
      return;
    }
    setResending(true);
    setResendStatus('');
    try {
      const res = await fetch(`${API_URL}/api/auth/resend-verification`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setResendStatus(
          (Array.isArray(body?.message) ? body.message.join(' ') : body?.message) ||
          'Could not request a new link. Try again shortly.'
        );
        return;
      }
      // The server's own words — deliberately non-committal about whether the
      // address exists.
      setResendStatus(body?.message || 'If an account exists, a verification email has been sent.');
    } catch {
      setResendStatus('Could not reach the server. Try again shortly.');
    } finally {
      setResending(false);
    }
  };

  useEffect(() => {
    if (!token) {
      setStatus('error');
      setMessage('No verification token provided.');
      return;
    }
    const verify = async () => {
      try {
        // POST with the token in the body. This used to issue a GET, which the API
        // had no route for at all — every verification link returned 404 and no
        // account could ever be verified.
        const res = await fetch(`${API_URL}/api/auth/verify-email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        if (res.ok) {
          setStatus('success');
          setMessage('Email verified!');
        } else {
          const err = await res.json().catch(() => ({}));
          setStatus('error');
          setMessage(err.message || 'Verification failed or expired');
        }
      } catch (err) {
        setStatus('error');
        setMessage('Network error during verification.');
      }
    };

    verify();
  }, [token]);

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-50 dark:bg-slate-900/90 border border-slate-200 dark:border-slate-800 shadow-sm flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-8 rounded-2xl shadow-2xl text-center space-y-6">
        {status === 'loading' && (
          <div className="space-y-4">
            <Loader2 className="w-12 h-12 text-blue-600 dark:text-blue-400 animate-spin mx-auto" />
            <h1 className="text-xl font-bold text-slate-900 dark:text-white">Verifying...</h1>
            <p className="text-slate-600 dark:text-slate-400 text-sm">Please wait while we verify your email.</p>
          </div>
        )}
        {status === 'success' && (
          <div className="space-y-4">
            <CheckCircle2 className="w-12 h-12 text-emerald-600 dark:text-emerald-400 mx-auto" />
            <h1 className="text-xl font-bold text-slate-900 dark:text-white">{message}</h1>
            <button
              onClick={() => router.push('/login')}
              className="w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold transition-all shadow-lg shadow-blue-500/20"
            >
              Go to Login
            </button>
          </div>
        )}
        {status === 'error' && (
          <div className="space-y-4">
            <XCircle className="w-12 h-12 text-red-600 dark:text-red-400 mx-auto" />
            <h1 className="text-xl font-bold text-slate-900 dark:text-white">Verification Failed</h1>
            <p className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-500/10 p-3 rounded-xl border border-red-200 dark:border-red-500/20">{message}</p>

            {/* A link expires after 24 hours. Without this the only way on was
                to ask somebody with database access. */}
            <div className="space-y-3 text-left pt-2 border-t border-slate-200 dark:border-slate-800">
              <label htmlFor="resend-email" className="text-xs font-semibold text-slate-600 dark:text-slate-400 block">
                Send me a new link
              </label>
              <input
                id="resend-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@agency.gov.ng"
                className="w-full px-4 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white text-sm focus:outline-none focus:border-blue-500"
              />
              <button
                onClick={resend}
                disabled={resending}
                className="w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm transition-all disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {resending && <Loader2 className="w-4 h-4 animate-spin" />}
                {resending ? 'Sending…' : 'Send a new verification link'}
              </button>
              {resendStatus && (
                <p className="text-xs text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-800/60 p-3 rounded-xl border border-slate-200 dark:border-slate-700">
                  {resendStatus}
                </p>
              )}
            </div>

            <button
              onClick={() => router.push('/login')}
              className="w-full py-3 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white hover:bg-slate-100 dark:bg-slate-800 font-semibold transition-all"
            >
              Back to Login
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <VerifyEmailContent />
    </Suspense>
  );
}
