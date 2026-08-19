"use client";

import React, { useState } from 'react';
import { API_URL } from '@/lib/api';
import {
  ShieldCheck, CheckCircle2, Search, ArrowRight,
  Phone, User, CreditCard, Sparkles, Building2,
  AlertCircle, FileText, Printer, ArrowLeft
} from 'lucide-react';

interface EnrolleeData {
  contactId: string;
  fullName: string;
  phoneNumber: string;
  planType: string;
  lga: string;
  preferredHospital: string;
  policyId: string;
  amount: number;
  paymentStatus: string;
  enrollmentStatus: string;
  hasPhoto: boolean;
  dependents: Array<{ fullName: string; relationship: string }>;
}

export default function InformalPaymentPage() {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enrollee, setEnrollee] = useState<EnrolleeData | null>(null);

  const [selectedPlan, setSelectedPlan] = useState<'INDIVIDUAL' | 'FAMILY'>('INDIVIDUAL');
  const [paying, setPaying] = useState(false);
  const [paidResult, setPaidResult] = useState<{ policyId: string; fullName: string } | null>(null);

  const handleLookup = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/public/pay/lookup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: query.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message || 'No registered enrollee found with that number or ID.');
        setEnrollee(null);
      } else {
        setEnrollee(data);
        if (data.planType?.toLowerCase().includes('family') || data.dependents?.length > 0) {
          setSelectedPlan('FAMILY');
        } else {
          setSelectedPlan('INDIVIDUAL');
        }
        if (data.paymentStatus === 'PAID') {
          setPaidResult({ policyId: data.policyId, fullName: data.fullName });
        }
      }
    } catch {
      setError('Could not reach the PLASCHEMA payment server. Please check your internet connection.');
    } finally {
      setLoading(false);
    }
  };

  const handlePay = async () => {
    if (!enrollee) return;
    setPaying(true);
    setError(null);
    const amount = selectedPlan === 'FAMILY' ? 50000 : 12000;
    const ref = `PAY-PLS-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

    try {
      const res = await fetch(`${API_URL}/api/public/pay/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contactId: enrollee.contactId,
          paymentReference: ref,
          amount,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message || 'Payment confirmation failed.');
      } else {
        setPaidResult({ policyId: data.policyId, fullName: data.fullName });
      }
    } catch {
      setError('Failed to confirm payment with the server.');
    } finally {
      setPaying(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col justify-between py-8 px-4 sm:px-6 lg:px-8">
      <div className="max-w-xl w-full mx-auto space-y-6">
        {/* Brand Header */}
        <div className="text-center space-y-2">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-[#74BA03]/15 text-[#558A02] dark:text-[#74BA03] font-black text-xl border border-[#74BA03]/30 shadow-sm">
            PLS
          </div>
          <h1 className="text-2xl font-black text-slate-900 dark:text-white tracking-tight">
            PLASCHEMA Health Insurance
          </h1>
          <p className="text-xs text-slate-600 dark:text-slate-400 font-medium max-w-md mx-auto">
            Plateau State Contributory Healthcare Management Agency — Official Online Premium Payment Portal
          </p>
        </div>

        {/* Success Screen */}
        {paidResult ? (
          <div className="rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-8 shadow-xl text-center space-y-6">
            <div className="w-16 h-16 rounded-full bg-emerald-100 dark:bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 flex items-center justify-center mx-auto text-3xl font-bold border border-emerald-300 dark:border-emerald-500/30 shadow-md">
              ✓
            </div>
            <div>
              <h2 className="text-xl font-black text-slate-900 dark:text-white">Coverage Activated!</h2>
              <p className="text-xs text-slate-600 dark:text-slate-400 mt-1">
                Your annual premium has been confirmed and registered with Plateau State Government.
              </p>
            </div>

            <div className="p-4 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 text-left space-y-2">
              <div className="flex justify-between items-center text-xs">
                <span className="text-slate-500 dark:text-slate-400">Principal Enrollee:</span>
                <span className="font-bold text-slate-900 dark:text-white">{paidResult.fullName}</span>
              </div>
              <div className="flex justify-between items-center text-xs">
                <span className="text-slate-500 dark:text-slate-400">Policy / ID Number:</span>
                <span className="font-mono font-black text-[#558A02] dark:text-[#74BA03] text-sm">
                  {paidResult.policyId}
                </span>
              </div>
              <div className="flex justify-between items-center text-xs">
                <span className="text-slate-500 dark:text-slate-400">Plan Category:</span>
                <span className="font-semibold text-slate-800 dark:text-slate-200">
                  {selectedPlan === 'FAMILY' ? 'Informal Sector Family Plan (6 People)' : 'Informal Sector Individual Plan'}
                </span>
              </div>
              <div className="flex justify-between items-center text-xs">
                <span className="text-slate-500 dark:text-slate-400">Validity:</span>
                <span className="font-semibold text-emerald-600 dark:text-emerald-400">1 Full Year (365 Days)</span>
              </div>
            </div>

            <div className="space-y-3">
              <button
                onClick={() => window.print()}
                className="w-full py-3.5 px-4 rounded-2xl text-white font-bold text-sm shadow-md bg-[#558A02] hover:bg-[#74BA03] transition-all flex items-center justify-center gap-2"
              >
                <Printer className="w-4 h-4" /> Print / Save Proof of Coverage
              </button>
              <button
                onClick={() => {
                  setPaidResult(null);
                  setEnrollee(null);
                  setQuery('');
                }}
                className="w-full py-3 px-4 rounded-2xl bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-semibold text-xs hover:bg-slate-200 dark:hover:bg-slate-700 transition-all"
              >
                ← Pay For Another Enrollee
              </button>
            </div>
          </div>
        ) : (
          <div className="rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 sm:p-8 shadow-xl space-y-6">
            {/* Step 1: Lookup Box */}
            <form onSubmit={handleLookup} className="space-y-2">
              <label className="block text-xs font-extrabold text-slate-900 dark:text-white uppercase tracking-wider">
                Step 1: Enter Phone Number or Registration Reference
              </label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <input
                    type="text"
                    placeholder="e.g. 08031234567 or Reference Number"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    className="w-full pl-10 pr-4 py-3 rounded-2xl bg-slate-50 dark:bg-slate-800/80 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-white placeholder-slate-400 text-sm focus:outline-none focus:ring-2 focus:ring-[#74BA03]"
                  />
                </div>
                <button
                  type="submit"
                  disabled={loading || !query.trim()}
                  className="px-5 py-3 rounded-2xl text-white font-bold text-sm shadow-md bg-[#558A02] hover:bg-[#74BA03] transition-all disabled:opacity-50 flex items-center gap-1.5"
                >
                  {loading ? 'Searching…' : 'Find Record'}
                </button>
              </div>
            </form>

            {error && (
              <div className="p-3.5 rounded-2xl bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 text-xs text-red-700 dark:text-red-400 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {/* Step 2: Enrollee Details & Plan Selection */}
            {enrollee && (
              <div className="space-y-6 border-t border-slate-100 dark:border-slate-800 pt-6 animate-fadeIn">
                {/* Verified Identity Badge */}
                <div className="p-4 rounded-2xl bg-[#74BA03]/10 border border-[#74BA03]/30 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-extrabold text-[#558A02] dark:text-[#74BA03] uppercase tracking-wider flex items-center gap-1">
                      <ShieldCheck className="w-4 h-4" /> Verified Citizen Record
                    </span>
                    <span className="text-xs font-mono font-bold text-slate-700 dark:text-slate-300">
                      {enrollee.policyId}
                    </span>
                  </div>
                  <div className="font-black text-slate-900 dark:text-white text-base">
                    {enrollee.fullName}
                  </div>
                  <div className="text-xs text-slate-600 dark:text-slate-400 flex flex-wrap gap-x-4 gap-y-1">
                    <span>LGA: <strong>{enrollee.lga}</strong></span>
                    <span>Facility: <strong>{enrollee.preferredHospital}</strong></span>
                  </div>

                  {enrollee.dependents?.length > 0 && (
                    <div className="pt-2 border-t border-[#74BA03]/20">
                      <p className="text-[11px] font-bold text-slate-800 dark:text-slate-200">
                        Registered Family Dependents ({enrollee.dependents.length}):
                      </p>
                      <ul className="text-[11px] text-slate-600 dark:text-slate-400 list-disc list-inside mt-0.5">
                        {enrollee.dependents.map((d, i) => (
                          <li key={i}>{d.fullName} ({d.relationship})</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>

                {/* Step 3: Choose Coverage Plan */}
                <div className="space-y-3">
                  <label className="block text-xs font-extrabold text-slate-900 dark:text-white uppercase tracking-wider">
                    Step 2: Select Coverage Plan
                  </label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div
                      onClick={() => setSelectedPlan('INDIVIDUAL')}
                      className={`p-4 rounded-2xl border-2 cursor-pointer transition-all ${
                        selectedPlan === 'INDIVIDUAL'
                          ? 'border-[#74BA03] bg-[#74BA03]/10 shadow-sm'
                          : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
                      }`}
                    >
                      <div className="font-bold text-slate-900 dark:text-white text-sm">Individual Plan</div>
                      <div className="text-xl font-black text-[#558A02] dark:text-[#74BA03] mt-1">₦12,000</div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
                        1 Year Full Coverage for 1 person.
                      </div>
                    </div>

                    <div
                      onClick={() => setSelectedPlan('FAMILY')}
                      className={`p-4 rounded-2xl border-2 cursor-pointer transition-all ${
                        selectedPlan === 'FAMILY'
                          ? 'border-[#74BA03] bg-[#74BA03]/10 shadow-sm'
                          : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
                      }`}
                    >
                      <div className="font-bold text-slate-900 dark:text-white text-sm">Family Plan (Up to 6)</div>
                      <div className="text-xl font-black text-[#558A02] dark:text-[#74BA03] mt-1">₦50,000</div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
                        Principal + Spouse + 4 Children.
                      </div>
                    </div>
                  </div>
                </div>

                {/* Step 4: Pay Button */}
                <div className="space-y-3 pt-2">
                  <button
                    onClick={handlePay}
                    disabled={paying}
                    className="w-full py-4 px-6 rounded-2xl text-white font-black text-base shadow-lg bg-[#558A02] hover:bg-[#74BA03] transition-all disabled:opacity-60 flex items-center justify-center gap-2"
                  >
                    <CreditCard className="w-5 h-5" />
                    {paying
                      ? 'Processing Secure Payment…'
                      : `Pay ₦${(selectedPlan === 'FAMILY' ? 50000 : 12000).toLocaleString()} via Paystack / Card / USSD`}
                  </button>

                  <p className="text-[11px] text-slate-500 dark:text-slate-400 text-center flex items-center justify-center gap-1">
                    <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" />
                    Secured by Paystack &amp; Plateau State Government Treasury
                  </p>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Footer info */}
        <div className="text-center space-y-1">
          <p className="text-xs text-slate-500 dark:text-slate-400 font-medium">
            Need help registering or have questions?
          </p>
          <p className="text-xs font-bold text-slate-800 dark:text-slate-200">
            Call PLASCHEMA Helpline: <span className="text-[#558A02] dark:text-[#74BA03]">0700-700-1111</span>
          </p>
        </div>
      </div>
    </div>
  );
}
