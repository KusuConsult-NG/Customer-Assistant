"use client";

import React, { useEffect, useState, useCallback } from 'react';
import { API_URL } from '@/lib/api';
import {
  CreditCard, CheckCircle2, AlertCircle, Loader2, Zap,
  TrendingUp, Star, Shield, ArrowUpRight, Receipt, Clock,
  Users, MessageSquare, Phone, Sparkles, Check, X, ShieldCheck, BarChart3
} from 'lucide-react';

type Plan = {
  id: string;
  name: string;
  price: number;
  badge?: string;
  popular?: boolean;
  messages: string;
  calls: string;
  team: string;
  features: string[];
  gradient: string;
  buttonClass: string;
};

const PLANS: Plan[] = [
  {
    id: 'STARTER',
    name: 'Starter',
    price: 50000,
    messages: '2,000 AI Messages/mo',
    calls: '500 Voice Minutes/mo',
    team: '5 Team Members',
    gradient: 'from-slate-500/10 to-slate-600/5 border-slate-200 dark:border-slate-800',
    buttonClass: 'bg-slate-900 hover:bg-slate-800 dark:bg-slate-800 dark:hover:bg-slate-700 text-white',
    features: [
      '1 WhatsApp Business Number',
      '2,000 AI WhatsApp Messages',
      '500 Voice AI Call Minutes',
      '5 Team Agent Seats',
      'CRM Contacts & Leads Pipeline',
      'Knowledge Base (25 Docs)',
      'Standard Email & Webchat Support',
    ],
  },
  {
    id: 'PROFESSIONAL',
    name: 'Professional',
    price: 150000,
    badge: 'Most Popular',
    popular: true,
    messages: '10,000 AI Messages/mo',
    calls: '2,500 Voice Minutes/mo',
    team: '15 Team Members',
    gradient: 'from-blue-600/15 via-indigo-600/10 to-transparent border-blue-500/40 dark:border-blue-500/50 shadow-blue-500/10 shadow-lg',
    buttonClass: 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-500/25',
    features: [
      '3 WhatsApp Business Numbers',
      '10,000 AI WhatsApp Messages',
      '2,500 Voice AI Call Minutes',
      '15 Team Agent Seats',
      'Full CRM + Kanban + Quotations',
      'Knowledge Base (100 Docs & Web Crawler)',
      'Scheduling & Table Reservations',
      'Workflows Automation Engine',
      'Priority Support (2hr SLA)',
    ],
  },
  {
    id: 'BUSINESS',
    name: 'Business',
    price: 350000,
    badge: 'Best Value',
    messages: '50,000 AI Messages/mo',
    calls: '10,000 Voice Minutes/mo',
    team: '50 Team Members',
    gradient: 'from-purple-600/15 via-pink-600/10 to-transparent border-purple-300 dark:border-purple-500/40',
    buttonClass: 'bg-purple-600 hover:bg-purple-500 text-white shadow-lg shadow-purple-500/25',
    features: [
      '10 WhatsApp Business Numbers',
      '50,000 AI WhatsApp Messages',
      '10,000 Voice AI Call Minutes',
      '50 Team Agent Seats',
      'White-Label Custom Branding & Domain',
      'Custom AI Persona & Qdrant Vector RAG',
      'API & Webhook Subscriptions',
      'Dedicated Account Manager',
    ],
  },
  {
    id: 'ENTERPRISE',
    name: 'Enterprise',
    price: 1000000,
    badge: 'Enterprise',
    messages: 'Unlimited Messages',
    calls: 'Unlimited Minutes',
    team: 'Unlimited Members',
    gradient: 'from-amber-500/15 via-orange-500/10 to-transparent border-amber-300 dark:border-amber-500/40',
    buttonClass: 'bg-amber-600 hover:bg-amber-500 text-white shadow-lg shadow-amber-500/25',
    features: [
      'Unlimited WhatsApp Numbers',
      'Unlimited AI Messages & Tokens',
      'Unlimited Voice AI Minutes',
      'Unlimited Team Members',
      'MTN / Airtel Direct SIP Trunks',
      'Isolated VPC / Database Deployment',
      '24/7 VIP Phone & WhatsApp Support',
      'Custom API & ERP Integration',
    ],
  },
];

export default function BillingPage() {
  const [subscription, setSubscription] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [selectedPlan, setSelectedPlan] = useState<Plan | null>(null);
  const [processing, setProcessing] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);

  const showToast = (msg: string, type: 'success' | 'error' = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  };

  const fetchSubscription = useCallback(async () => {
    try {
      const token = typeof window !== 'undefined' ? localStorage.getItem('ace_token') : '';
      const res = await fetch(`${API_URL}/api/billing/subscription`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setSubscription(data);
      }
    } catch (err) {
      console.error('Failed to load subscription details', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSubscription();
  }, [fetchSubscription]);

  const handleActivatePlan = async (planId: string) => {
    setProcessing(true);
    try {
      const token = localStorage.getItem('ace_token');

      // First attempt Paystack Checkout
      const checkoutRes = await fetch(`${API_URL}/api/billing/checkout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ plan: planId }),
      });

      if (checkoutRes.ok) {
        const data = await checkoutRes.json();
        if (data.authorization_url || data.authorizationUrl) {
          window.open(data.authorization_url || data.authorizationUrl, '_blank');
          showToast('Opening Paystack secure payment gateway...', 'success');
          setSelectedPlan(null);
          return;
        }
      }

      // Fallback: Sandbox / Direct Activation
      const activateRes = await fetch(`${API_URL}/api/billing/activate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ plan: planId }),
      });

      if (activateRes.ok) {
        showToast(`Successfully upgraded to ${planId} Plan!`, 'success');
        setSelectedPlan(null);
        await fetchSubscription();
      } else {
        showToast('Could not process subscription upgrade. Please try again.', 'error');
      }
    } catch (err) {
      showToast('Network error during checkout. Please try again.', 'error');
    } finally {
      setProcessing(false);
    }
  };

  const currentPlanKey = (subscription?.plan || 'STARTER').toUpperCase();

  return (
    <div className="max-w-6xl mx-auto space-y-8 pb-12">
      {/* Sleek Floating Toast Notification */}
      {toast && (
        <div className={`fixed top-20 right-6 z-[100] flex items-center gap-3 px-5 py-3.5 rounded-2xl shadow-2xl border text-sm font-semibold backdrop-blur-xl animate-in fade-in slide-in-from-top-4 duration-200 ${
          toast.type === 'success'
            ? 'bg-emerald-950/90 text-emerald-200 border-emerald-500/40 shadow-emerald-500/10'
            : 'bg-red-950/90 text-red-200 border-red-500/40 shadow-red-500/10'
        }`}>
          {toast.type === 'success' ? (
            <CheckCircle2 className="w-5 h-5 text-emerald-400 flex-shrink-0" />
          ) : (
            <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0" />
          )}
          <span>{toast.msg}</span>
        </div>
      )}

      {/* Header Banner */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800/80 pb-6">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="p-2.5 rounded-xl bg-blue-600/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">
              <CreditCard className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-2xl font-extrabold text-slate-900 dark:text-white tracking-tight">
                Billing & Subscription Plans
              </h1>
              <p className="text-sm text-slate-600 dark:text-slate-400 mt-0.5">
                Scale your AI Customer Care operations with high-throughput WhatsApp and Voice AI infrastructure.
              </p>
            </div>
          </div>
        </div>

        {subscription?.status && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500 dark:text-slate-400 font-medium">Status:</span>
            <span className={`px-3 py-1 rounded-full text-xs font-bold border flex items-center gap-1.5 ${
              subscription.status === 'ACTIVE'
                ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/30'
                : subscription.status === 'TRIAL'
                ? 'bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-500/30'
                : 'bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-400 border-red-200 dark:border-red-500/30'
            }`}>
              <span className={`w-2 h-2 rounded-full ${subscription.status === 'ACTIVE' ? 'bg-emerald-500' : 'bg-amber-500'}`} />
              {subscription.status}
            </span>
          </div>
        )}
      </div>

      {loading ? (
        <div className="flex flex-col items-center justify-center py-24 space-y-4">
          <Loader2 className="w-10 h-10 text-blue-600 dark:text-blue-400 animate-spin" />
          <p className="text-sm text-slate-500 dark:text-slate-400 font-medium">Loading subscription and usage data...</p>
        </div>
      ) : (
        <>
          {/* Current Subscription Card */}
          <div className="relative overflow-hidden rounded-3xl bg-gradient-to-r from-slate-900 via-indigo-950 to-slate-900 text-white p-8 shadow-2xl border border-white/10">
            <div className="absolute top-0 right-0 w-96 h-96 bg-blue-500/10 rounded-full blur-3xl -mr-20 -mt-20 pointer-events-none" />
            
            <div className="relative z-10 flex flex-col lg:flex-row lg:items-center justify-between gap-6">
              <div className="space-y-3">
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/10 border border-white/15 text-xs font-semibold text-blue-300">
                  <Star className="w-3.5 h-3.5 fill-blue-400 text-blue-400" /> Active Subscription
                </div>
                <h2 className="text-3xl font-extrabold tracking-tight text-white flex items-center gap-3">
                  {currentPlanKey} PLAN
                  <span className="text-sm font-semibold text-slate-300 bg-white/10 px-3 py-1 rounded-lg border border-white/10">
                    ₦{(subscription?.monthlyPriceNgn || 50000).toLocaleString()} / month
                  </span>
                </h2>
                <p className="text-sm text-slate-300 max-w-xl">
                  Your organization is powered by enterprise-grade NestJS microservices and vector RAG search.
                </p>
              </div>

              <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 bg-white/5 p-4 rounded-2xl border border-white/10 backdrop-blur-md">
                <div className="space-y-0.5">
                  <span className="text-xs text-slate-400 font-medium">Next Billing Date</span>
                  <p className="text-base font-bold text-white">
                    {subscription?.renewalDate
                      ? new Date(subscription.renewalDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
                      : '30 Days from today'}
                  </p>
                </div>
                <button
                  onClick={() => setSelectedPlan(PLANS.find(p => p.id === 'PROFESSIONAL') || PLANS[1])}
                  className="px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs shadow-lg shadow-blue-500/30 transition-all flex items-center gap-2 whitespace-nowrap"
                >
                  <Sparkles className="w-4 h-4" /> Change Plan
                </button>
              </div>
            </div>
          </div>

          {/* Usage Meters Section */}
          <div className="rounded-3xl bg-white dark:bg-slate-900/80 border border-slate-200/80 dark:border-slate-800 p-7 shadow-sm space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
                  <BarChart3 className="w-5 h-5 text-blue-600 dark:text-blue-400" /> Monthly Resource Usage
                </h3>
                <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">
                  Real-time consumption counters aggregated across your active channels.
                </p>
              </div>
              <span className="text-xs font-semibold text-slate-600 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 px-3 py-1 rounded-full border border-slate-200 dark:border-slate-700">
                Resets monthly
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* WhatsApp Messages Meter */}
              <div className="p-6 rounded-2xl bg-slate-50/80 dark:bg-slate-800/40 border border-slate-200/80 dark:border-slate-700/60 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 flex items-center justify-center border border-emerald-500/20">
                      <MessageSquare className="w-5 h-5" />
                    </div>
                    <div>
                      <h4 className="text-sm font-bold text-slate-900 dark:text-white">AI Messages (WhatsApp)</h4>
                      <p className="text-xs text-slate-600 dark:text-slate-400">Automated AI customer replies</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <span className="text-base font-extrabold text-slate-900 dark:text-white">
                      {(subscription?.whatsappMessagesUsed || 0).toLocaleString()}
                    </span>
                    <span className="text-xs text-slate-600 dark:text-slate-400 font-medium"> / {(subscription?.whatsappMessagesIncluded || 2000).toLocaleString()}</span>
                  </div>
                </div>

                {(() => {
                  const used = subscription?.whatsappMessagesUsed || 0;
                  const limit = subscription?.whatsappMessagesIncluded || 2000;
                  const pct = Math.min(100, Math.round((used / limit) * 100));
                  return (
                    <div className="space-y-2">
                      <div className="w-full h-3 bg-slate-200 dark:bg-slate-700/60 rounded-full overflow-hidden p-0.5">
                        <div
                          className={`h-full rounded-full transition-all duration-500 ${
                            pct > 90 ? 'bg-red-500' : pct > 75 ? 'bg-amber-500' : 'bg-emerald-500'
                          }`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <div className="flex items-center justify-between text-xs font-semibold">
                        <span className="text-slate-600 dark:text-slate-400">{pct}% consumed</span>
                        <span className="text-emerald-600 dark:text-emerald-400">{(limit - used).toLocaleString()} remaining</span>
                      </div>
                    </div>
                  );
                })()}
              </div>

              {/* Voice Minutes Meter */}
              <div className="p-6 rounded-2xl bg-slate-50/80 dark:bg-slate-800/40 border border-slate-200/80 dark:border-slate-700/60 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-purple-500/10 text-purple-600 dark:text-purple-400 flex items-center justify-center border border-purple-500/20">
                      <Phone className="w-5 h-5" />
                    </div>
                    <div>
                      <h4 className="text-sm font-bold text-slate-900 dark:text-white">Voice AI Minutes</h4>
                      <p className="text-xs text-slate-600 dark:text-slate-400">Deepgram STT & ElevenLabs TTS calls</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <span className="text-base font-extrabold text-slate-900 dark:text-white">
                      {(subscription?.callMinutesUsed || 0).toLocaleString()}
                    </span>
                    <span className="text-xs text-slate-600 dark:text-slate-400 font-medium"> / {(subscription?.callMinutesIncluded || 500).toLocaleString()} mins</span>
                  </div>
                </div>

                {(() => {
                  const used = subscription?.callMinutesUsed || 0;
                  const limit = subscription?.callMinutesIncluded || 500;
                  const pct = Math.min(100, Math.round((used / limit) * 100));
                  return (
                    <div className="space-y-2">
                      <div className="w-full h-3 bg-slate-200 dark:bg-slate-700/60 rounded-full overflow-hidden p-0.5">
                        <div
                          className={`h-full rounded-full transition-all duration-500 ${
                            pct > 90 ? 'bg-red-500' : pct > 75 ? 'bg-amber-500' : 'bg-purple-500'
                          }`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <div className="flex items-center justify-between text-xs font-semibold">
                        <span className="text-slate-600 dark:text-slate-400">{pct}% consumed</span>
                        <span className="text-purple-600 dark:text-purple-400">{(limit - used).toLocaleString()} mins remaining</span>
                      </div>
                    </div>
                  );
                })()}
              </div>
            </div>
          </div>

          {/* Pricing Plans Grid */}
          <div className="space-y-6">
            <div className="text-center max-w-2xl mx-auto space-y-2">
              <h2 className="text-2xl font-extrabold text-slate-900 dark:text-white tracking-tight">
                Select Your Subscription Plan
              </h2>
              <p className="text-sm text-slate-600 dark:text-slate-400">
                Transparent NGN pricing. Upgrade or switch plans anytime with instant automated activation.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
              {PLANS.map((plan) => {
                const isCurrent = currentPlanKey === plan.id;
                return (
                  <div
                    key={plan.id}
                    className={`relative rounded-3xl border p-6 flex flex-col justify-between transition-all duration-300 bg-white dark:bg-slate-900/90 shadow-lg ${
                      isCurrent
                        ? 'border-blue-500 ring-2 ring-blue-500/30 shadow-blue-500/10'
                        : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
                    }`}
                  >
                    {plan.badge && (
                      <div className="absolute -top-3.5 left-1/2 -translate-x-1/2">
                        <span className="px-3.5 py-1 rounded-full text-[10px] font-extrabold uppercase tracking-wider text-white bg-blue-600 shadow-md shadow-blue-500/30 border border-blue-400/30">
                          {plan.badge}
                        </span>
                      </div>
                    )}

                    <div className="space-y-4">
                      <div>
                        <h3 className="text-xl font-bold text-slate-900 dark:text-white">{plan.name}</h3>
                        <div className="flex items-baseline gap-1 mt-2">
                          <span className="text-3xl font-extrabold text-slate-900 dark:text-white">
                            ₦{plan.price.toLocaleString()}
                          </span>
                          <span className="text-xs text-slate-600 dark:text-slate-400 font-semibold">/month</span>
                        </div>
                      </div>

                      <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700/50 space-y-1 text-xs">
                        <p className="font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
                          <MessageSquare className="w-3.5 h-3.5 text-blue-500" /> {plan.messages}
                        </p>
                        <p className="font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
                          <Phone className="w-3.5 h-3.5 text-purple-500" /> {plan.calls}
                        </p>
                        <p className="font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
                          <Users className="w-3.5 h-3.5 text-indigo-500" /> {plan.team}
                        </p>
                      </div>

                      <div className="space-y-2.5 pt-2">
                        {plan.features.map((feature, i) => (
                          <div key={i} className="flex items-start gap-2 text-xs text-slate-700 dark:text-slate-300">
                            <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" />
                            <span>{feature}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="pt-6">
                      {isCurrent ? (
                        <div className="w-full py-3 rounded-xl bg-slate-100 dark:bg-slate-800 text-center text-xs font-bold text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700">
                          Current Active Plan
                        </div>
                      ) : (
                        <button
                          onClick={() => setSelectedPlan(plan)}
                          className={`w-full py-3 rounded-xl text-xs font-extrabold transition-all flex items-center justify-center gap-2 ${plan.buttonClass}`}
                        >
                          <Zap className="w-4 h-4" /> Upgrade to {plan.name}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Payment History Table */}
          <div className="rounded-3xl bg-white dark:bg-slate-900/80 border border-slate-200/80 dark:border-slate-800 p-7 shadow-sm space-y-4">
            <h3 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <Receipt className="w-5 h-5 text-blue-600 dark:text-blue-400" /> Payment & Invoicing History
            </h3>
            
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 uppercase tracking-wider font-semibold">
                    <th className="py-3 px-4">Date</th>
                    <th className="py-3 px-4">Description</th>
                    <th className="py-3 px-4">Reference</th>
                    <th className="py-3 px-4">Amount</th>
                    <th className="py-3 px-4 text-right">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60 font-medium">
                  <tr>
                    <td className="py-3.5 px-4 text-slate-900 dark:text-slate-100">
                      {new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                    </td>
                    <td className="py-3.5 px-4 text-slate-900 dark:text-slate-100 font-bold">
                      {currentPlanKey} Plan Subscription
                    </td>
                    <td className="py-3.5 px-4 font-mono text-slate-500">ACE_REF_{Date.now().toString().slice(-8)}</td>
                    <td className="py-3.5 px-4 font-bold text-slate-900 dark:text-white">
                      ₦{(subscription?.monthlyPriceNgn || 50000).toLocaleString()}
                    </td>
                    <td className="py-3.5 px-4 text-right">
                      <span className="px-2.5 py-1 rounded-full text-[10px] font-bold bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-500/20">
                        PAID & CONFIRMED
                      </span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* Plan Upgrade Checkout Modal */}
      {selectedPlan && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-slate-950/70 backdrop-blur-md animate-in fade-in duration-200">
          <div className="w-full max-w-md rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-7 shadow-2xl space-y-6">
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-4">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-xl bg-blue-600/10 text-blue-600 dark:text-blue-400">
                  <CreditCard className="w-5 h-5" />
                </div>
                <h3 className="text-lg font-bold text-slate-900 dark:text-white">
                  Upgrade to {selectedPlan.name}
                </h3>
              </div>
              <button
                onClick={() => setSelectedPlan(null)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3 bg-slate-50 dark:bg-slate-800/50 p-4 rounded-2xl border border-slate-200/80 dark:border-slate-700/50 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-slate-600 dark:text-slate-400 font-semibold">Selected Plan</span>
                <span className="font-bold text-slate-900 dark:text-white">{selectedPlan.name}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-600 dark:text-slate-400 font-semibold">Monthly Billing</span>
                <span className="font-bold text-slate-900 dark:text-white">₦{selectedPlan.price.toLocaleString()}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-600 dark:text-slate-400 font-semibold">AI Messages Included</span>
                <span className="font-bold text-emerald-600 dark:text-emerald-400">{selectedPlan.messages}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-600 dark:text-slate-400 font-semibold">Voice AI Minutes Included</span>
                <span className="font-bold text-purple-600 dark:text-purple-400">{selectedPlan.calls}</span>
              </div>
            </div>

            <div className="space-y-3">
              <button
                onClick={() => handleActivatePlan(selectedPlan.id)}
                disabled={processing}
                className="w-full py-3.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-extrabold text-sm shadow-lg shadow-blue-500/25 transition-all flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {processing ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
                {processing ? 'Processing Checkout...' : 'Confirm & Activate Upgrade'}
              </button>

              <button
                onClick={() => setSelectedPlan(null)}
                className="w-full py-2.5 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 font-semibold text-xs transition-all"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
