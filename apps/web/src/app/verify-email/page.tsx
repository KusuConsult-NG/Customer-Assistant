"use client";

import React, { useEffect, useState, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { Loader2, CheckCircle2, XCircle } from 'lucide-react';

function VerifyEmailContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get('token');
  
  const [status, setStatus] = useState<'verifying' | 'success' | 'error'>('verifying');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!token) {
      setStatus('error');
      setMessage('Invalid or missing verification token.');
      return;
    }

    const verify = async () => {
      try {
        const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
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
    <div className="min-h-screen bg-[#0a0f1e] flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-[#0d1225] border border-white/10 p-8 rounded-2xl shadow-2xl text-center space-y-6">
        {status === 'verifying' && (
          <div className="space-y-4">
            <Loader2 className="w-12 h-12 text-blue-400 animate-spin mx-auto" />
            <h2 className="text-xl font-bold text-white">Verifying...</h2>
            <p className="text-gray-400 text-sm">Please wait while we verify your email.</p>
          </div>
        )}
        {status === 'success' && (
          <div className="space-y-4">
            <CheckCircle2 className="w-12 h-12 text-emerald-400 mx-auto" />
            <h2 className="text-xl font-bold text-white">{message}</h2>
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
            <XCircle className="w-12 h-12 text-red-400 mx-auto" />
            <h2 className="text-xl font-bold text-white">Verification Failed</h2>
            <p className="text-sm text-red-400 bg-red-500/10 p-3 rounded-xl border border-red-500/20">{message}</p>
            <button
              onClick={() => router.push('/login')}
              className="w-full py-3 rounded-xl bg-white/[0.04] border border-white/[0.08] text-white hover:bg-white/10 font-semibold transition-all"
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
