"use client";
import React, { useEffect, useState, useCallback } from 'react';
import { API_URL } from '@/lib/api';
import {
  CreditCard, CheckCircle2, AlertCircle, Loader2, Zap,
  TrendingUp, Star, Shield, ArrowUpRight, Receipt, Clock,
  Users, MessageSquare, Phone, BarChart3
} from 'lucide-react';

type Plan = {
  name: string;
  price: number;
  color: string;
  accentColor: string;
  badge: string;
  features: string[];
  isCustom?: boolean;
};

const PLANS: Plan[] = [
  {
    name: 'Starter',
    price: 50000,
    color: 'border-slate-200 dark:border-slate-700',
    accentColor: 'text-slate-700 dark:text-slate-300',
    badge: '',
    features: [
      '1 WhatsApp number',
      '1,500 AI messages/month',
      '300 voice minutes/month',
      '5 team members',
      'Basic CRM & Knowledge Base',
      'Email support',
    ],
    isCustom: false,
  },
  {
    name: 'Professional',
    price: 150000,
    color: 'border-blue-500/40',
    accentColor: 'text-blue-600 dark:text-blue-400',
    badge: 'Most Popular',
    features: [
      '3 WhatsApp numbers',
      '7,500 AI messages/month',
      '1,500 voice minutes/month',
      '15 team members',
      'Full CRM + Scheduling + Workflows',
      'Knowledge Base (100 docs)',
      'Analytics dashboard',
      'Priority support',
    ],
    isCustom: false,
  },
  {
    name: 'Business',
    price: 350000,
    color: 'border-purple-200 dark:border-purple-500/30',
    accentColor: 'text-purple-600 dark:text-purple-400',
    badge: 'Best Value',
    features: [
      '10 WhatsApp numbers',
      '25,000 AI messages/month',
      '5,000 voice minutes/month',
      '50 team members',
      'White-label branding',
      'Custom AI persona & RAG',
      'API & Webhooks access',
    ],
    isCustom: false,
  },
  {
    name: 'Enterprise',
    price: 1000000,
    color: 'border-amber-200 dark:border-amber-500/30',
    accentColor: 'text-amber-600 dark:text-amber-400',
    badge: 'Enterprise',
    features: [
      'Unlimited WhatsApp numbers',
      'Unlimited AI tokens & messages',
      'Unlimited voice AI minutes',
      'Unlimited team members',
      'Dedicated MTN/Airtel SIP trunks',
      'On-premise / Isolated DB deployment',
      '24/7 Phone & WhatsApp support',
      'Custom integration engineering',
    ],
    isCustom: false,
  },
];

export default function BillingPage() {
  const [subscription, setSubscription] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [upgrading, setUpgrading] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);

  const token = typeof window !== 'undefined' ? localStorage.getItem('ace_token') : '';
  const authHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const showToast = (msg: string, type: 'success' | 'error' = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const fetchSubscription = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/billing/subscription`, { headers: authHeaders });
      if (res.ok) setSubscription(await res.json());
    } catch {}
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchSubscription(); }, [fetchSubscription]);

  const handleUpgrade = async (planName: string) => {
    setUpgrading(planName);
    try {
      const res = await fetch(`${API_URL}/api/billing/checkout`, {
        method: 'POST', headers: authHeaders,
        body: JSON.stringify({ plan: planName.toUpperCase() }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.authorizationUrl || data.checkoutUrl) {
          window.open(data.authorizationUrl || data.checkoutUrl, '_blank');
        } else {
          showToast('Checkout initiated! Check your email.');
        }
      } else {
        showToast('Could not initiate checkout. Try again.', 'error');
      }
    } catch { showToast('Network error. Try again.', 'error'); }
    finally { setUpgrading(null); }
  };

  const currentPlan = subscription?.plan || 'STARTER';
  const usagePercent = (used: number, limit: number) => Math.min(100, Math.round((used / limit) * 100));

  return (
    <div className="max-w-6xl space-y-8">
      {/* Toast */}
      {toast && (
        <div className={`fixed top-5 right-5 z-50 flex items-center gap-3 px-4 py-3 rounded-xl shadow-2xl border text-sm font-medium ${
          toast.type === 'success' ? 'bg-emerald-900/80 border-emerald-200 dark:border-emerald-500/30 text-emerald-700 dark:text-emerald-300' : 'bg-red-900/80 border-red-200 dark:border-red-500/30 text-red-700 dark:text-red-300'
        }`}>
          {toast.type === 'success' ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
          <CreditCard className="w-6 h-6 text-blue-600 dark:text-blue-400" /> Billing & Plans
        </h1>
        <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">Manage your subscription and usage.</p>
      </div>

      {subscription && ['PAST_DUE', 'CANCELLED'].includes(subscription.status) && (
        <div className="bg-red-100 dark:bg-red-500/20 border border-red-500 text-red-600 dark:text-red-400 p-4 rounded-xl flex items-center gap-3">
          <AlertCircle className="w-5 h-5 flex-shrink-0" />
          <span className="font-semibold text-sm">Your subscription is inactive. Renew now to restore access to all features.</span>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-20"><Loader2 className="w-8 h-8 text-blue-600 dark:text-blue-400 animate-spin" /></div>
      ) : (
        <>
          {/* Current plan summary */}
          {subscription ? (
            <div className="rounded-2xl bg-gradient-to-br from-blue-600/20 to-purple-600/10 border border-blue-200 dark:border-blue-500/30 p-6 flex flex-col sm:flex-row gap-6 items-start sm:items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="w-14 h-14 rounded-2xl bg-blue-600/30 flex items-center justify-center">
                  <Star className="w-7 h-7 text-blue-600 dark:text-blue-400" />
                </div>
                <div>
                  <p className="text-xs text-slate-600 dark:text-slate-400 uppercase tracking-wider font-semibold">Current Plan</p>
                  <h2 className="text-2xl font-bold text-slate-900 dark:text-white">{currentPlan}</h2>
                  <p className="text-sm text-slate-600 dark:text-slate-400 mt-0.5">
                    {subscription.status === 'ACTIVE' ? (
                      <span className="text-emerald-600 dark:text-emerald-400 flex items-center gap-1"><CheckCircle2 className="w-3.5 h-3.5" /> Active</span>
                    ) : (
                      <span className="text-amber-600 dark:text-amber-400">Status: {subscription.status}</span>
                    )}
                  </p>
                </div>
              </div>
              {subscription.currentPeriodEnd && (
                <div className="text-right">
                  <p className="text-xs text-slate-500 dark:text-slate-400">Renews on</p>
                  <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">
                    {new Date(subscription.currentPeriodEnd).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
                  </p>
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-2xl bg-amber-500/[0.06] border border-amber-200 dark:border-amber-500/20 p-5 flex items-center gap-4">
              <AlertCircle className="w-8 h-8 text-amber-600 dark:text-amber-400 flex-shrink-0" />
              <div>
                <h3 className="font-semibold text-amber-700 dark:text-amber-300">No active subscription</h3>
                <p className="text-sm text-slate-600 dark:text-slate-400 mt-0.5">Choose a plan below to unlock all features.</p>
              </div>
            </div>
          )}

          {/* Usage bars */}
          {subscription && (
            <div className="rounded-2xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 shadow-sm border border-slate-200 dark:border-slate-800 p-6">
              <h3 className="font-semibold text-slate-900 dark:text-white mb-5">This Month's Usage</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {[
                  { label: 'AI Messages (WhatsApp)', icon: <MessageSquare className="w-4 h-4 text-blue-600 dark:text-blue-400" />, used: subscription.whatsappMessagesUsed || 0, limit: subscription.whatsappMessagesIncluded || 1500 },
                  { label: 'Voice Minutes', icon: <Phone className="w-4 h-4 text-purple-600 dark:text-purple-400" />, used: subscription.callMinutesUsed || 0, limit: subscription.callMinutesIncluded || 300 },
                ].map(u => {
                  const pct = usagePercent(u.used, u.limit);
                  return (
                    <div key={u.label}>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs text-slate-600 dark:text-slate-400 flex items-center gap-1.5">{u.icon}{u.label}</span>
                        <span className="text-xs font-mono text-slate-700 dark:text-slate-300">{u.used} / {u.limit}</span>
                      </div>
                      <div className="w-full h-2 bg-white/[0.06] rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${pct > 85 ? 'bg-red-500' : pct > 60 ? 'bg-amber-500' : 'bg-blue-500'}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">{pct}% used</p>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Plan comparison */}
          <div>
            <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-5">Choose Your Plan</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
              {PLANS.map(plan => {
                const isCurrent = currentPlan.toUpperCase() === plan.name.toUpperCase();
                return (
                  <div
                    key={plan.name}
                    className={`relative rounded-2xl border p-6 flex flex-col justify-between transition-all ${plan.color} ${
                      isCurrent ? 'bg-blue-500/[0.08]' : 'bg-white dark:bg-slate-900/80 hover:bg-slate-50 dark:bg-slate-800/60'
                    }`}
                  >
                    {plan.badge && (
                      <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                        <span className={`px-3 py-1 rounded-full text-[10px] font-bold text-slate-900 dark:text-white shadow-lg ${
                          plan.name === 'Custom' ? 'bg-amber-600 shadow-amber-500/30' : 'bg-blue-600 shadow-blue-500/30'
                        }`}>
                          {plan.badge}
                        </span>
                      </div>
                    )}
                    <div className="mb-5">
                      <h4 className={`text-lg font-bold ${plan.accentColor}`}>{plan.name}</h4>
                      <div className="flex items-baseline gap-1 mt-1">
                        {plan.isCustom ? (
                          <span className="text-2xl font-bold text-amber-600 dark:text-amber-400">Custom Quote</span>
                        ) : (
                          <>
                            <span className="text-3xl font-bold text-slate-900 dark:text-white">₦{plan.price.toLocaleString()}</span>
                            <span className="text-slate-500 dark:text-slate-400 text-sm">/mo</span>
                          </>
                        )}
                      </div>
                    </div>
                    <ul className="space-y-2.5 flex-1 mb-6">
                      {plan.features.map(f => (
                        <li key={f} className="flex items-center gap-2.5 text-xs text-slate-700 dark:text-slate-300">
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
                          {f}
                        </li>
                      ))}
                    </ul>
                    {isCurrent ? (
                      <div className="w-full py-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 text-center text-xs font-semibold text-slate-600 dark:text-slate-400">
                        Current Plan
                      </div>
                    ) : (
                      <button
                        onClick={() => handleUpgrade(plan.name)}
                        disabled={upgrading === plan.name}
                        className={`w-full py-2.5 rounded-xl text-xs font-semibold transition-all flex items-center justify-center gap-2 ${
                          plan.name === 'Professional'
                            ? 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-500/20'
                            : plan.name === 'Business' || plan.name === 'Enterprise'
                            ? 'bg-purple-600/80 hover:bg-purple-600 text-white shadow-lg shadow-purple-500/20'
                            : 'bg-white/[0.06] hover:bg-white/[0.1] text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700'
                        } disabled:opacity-50`}
                      >
                        {upgrading === plan.name ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowUpRight className="w-4 h-4" />}
                        {upgrading === plan.name ? 'Processing...' : `Upgrade to ${plan.name}`}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Invoice history */}
          <div className="rounded-2xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 shadow-sm border border-slate-200 dark:border-slate-800 p-6">
            <h3 className="font-semibold text-slate-900 dark:text-white mb-4 flex items-center gap-2">
              <Receipt className="w-4 h-4 text-slate-600 dark:text-slate-400" /> Payment History
            </h3>
            {(subscription?.invoices || []).length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 text-slate-500 dark:text-slate-400">
                <Clock className="w-10 h-10 mb-3 opacity-20" />
                <p className="text-slate-500 dark:text-slate-400 text-sm">No payment history yet.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {(subscription?.invoices || []).map((inv: any, i: number) => (
                  <div key={i} className="flex items-center justify-between p-3 rounded-xl hover:bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 shadow-sm transition-all">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg bg-emerald-50 dark:bg-emerald-500/10 flex items-center justify-center">
                        <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                      </div>
                      <div>
                        <p className="text-sm font-medium text-slate-800 dark:text-slate-200">{inv.description || 'Subscription Payment'}</p>
                        <p className="text-xs text-slate-500 dark:text-slate-400">{new Date(inv.date).toLocaleDateString()}</p>
                      </div>
                    </div>
                    <span className="text-sm font-bold text-emerald-600 dark:text-emerald-400">₦{inv.amount?.toLocaleString()}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
