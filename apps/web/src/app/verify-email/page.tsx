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
  const router = useRouter();

  useEffect(() => {
    if (!token) {
      setStatus('error');
      setMessage('No verification token provided.');
      return;
    }
    const verify = async () => {
      try {
        const res = await fetch(`${API_URL}/api/auth/verify-email?token=${token}`);
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
            <Loader2 className="w-12 h-12 text-blue-400 animate-spin mx-auto" />
            <h2 className="text-xl font-bold text-slate-900 dark:text-white">Verifying...</h2>
            <p className="text-slate-600 dark:text-slate-400 text-sm">Please wait while we verify your email.</p>
          </div>
        )}
        {status === 'success' && (
          <div className="space-y-4">
            <CheckCircle2 className="w-12 h-12 text-emerald-400 mx-auto" />
            <h2 className="text-xl font-bold text-slate-900 dark:text-white">{message}</h2>
            <button
              onClick={() => router.push('/login')}
              className="w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-slate-900 dark:text-white font-semibold transition-all shadow-lg shadow-blue-500/20"
            >
              Go to Login
            </button>
          </div>
        )}
        {status === 'error' && (
          <div className="space-y-4">
            <XCircle className="w-12 h-12 text-red-400 mx-auto" />
            <h2 className="text-xl font-bold text-slate-900 dark:text-white">Verification Failed</h2>
            <p className="text-sm text-red-400 bg-red-500/10 p-3 rounded-xl border border-red-500/20">{message}</p>
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
