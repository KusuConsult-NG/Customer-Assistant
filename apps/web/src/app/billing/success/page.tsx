"use client";
import React, { useEffect, Suspense } from 'react';
import { Check, ArrowRight } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';

function BillingSuccessContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const reference = searchParams.get('reference');

  useEffect(() => {
    const timer = setTimeout(() => {
      router.push('/billing');
    }, 5000);
    return () => clearTimeout(timer);
  }, [router]);

  return (
    <div className="flex h-screen w-full flex-col items-center justify-center bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-sm p-6 text-center">
      <div className="w-full max-w-md bg-slate-100 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800 p-8 rounded-3xl shadow-2xl backdrop-blur-md flex flex-col items-center">
        <div className="w-20 h-20 bg-green-100 dark:bg-green-500/20 rounded-full flex items-center justify-center mb-6 animate-pulse">
          <div className="w-14 h-14 bg-green-500 rounded-full flex items-center justify-center shadow-lg shadow-green-500/40">
            <Check className="w-8 h-8 text-slate-900 dark:text-white stroke-[3]" />
          </div>
        </div>
        
        <h1 className="text-3xl font-bold text-slate-900 dark:text-white mb-3">Payment Successful!</h1>
        <p className="text-slate-600 dark:text-slate-400 mb-2 text-lg">Your plan has been upgraded.</p>
        
        {reference && (
          <p className="text-xs text-slate-500 dark:text-slate-400 mb-8 font-mono bg-black/20 px-3 py-1.5 rounded-lg border border-white/5">
            Ref: {reference}
          </p>
        )}

        <div className="flex flex-col gap-3 w-full">
          <Link 
            href="/billing"
            className="w-full py-3.5 bg-slate-100 dark:bg-slate-800 hover:bg-white/15 border border-slate-200 dark:border-slate-800 rounded-xl text-slate-900 dark:text-white font-medium flex items-center justify-center gap-2 transition-colors"
          >
            Go to Billing <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
        
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-6">Redirecting automatically in a few seconds...</p>
      </div>
    </div>
  );
}

export default function BillingSuccessPage() {
  return (
    <Suspense fallback={
      <div className="flex h-screen items-center justify-center bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-sm">
        <div className="w-8 h-8 rounded-full border-2 border-green-500 border-t-transparent animate-spin" />
      </div>
    }>
      <BillingSuccessContent />
    </Suspense>
  );
}
