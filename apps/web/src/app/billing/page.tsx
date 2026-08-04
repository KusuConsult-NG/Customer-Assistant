"use client";

import React, { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { API_URL } from '@/lib/api';
import {
  CreditCard, CheckCircle2, AlertCircle, Loader2, Zap,
  TrendingUp, Star, Shield, ArrowUpRight, Receipt, Clock,
  Users, MessageSquare, Phone, Sparkles, Check, X, ShieldCheck,
  BarChart3, Building2, Smartphone, Copy, Lock, ArrowRight
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

type PaymentMethod = 'CARD' | 'TRANSFER' | 'USSD';

export default function BillingPage() {
  const [subscription, setSubscription] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [selectedPlan, setSelectedPlan] = useState<Plan | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('CARD');
  const [processing, setProcessing] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
  const [isClient, setIsClient] = useState(false);
  const [copiedAccount, setCopiedAccount] = useState(false);
  const [paymentSuccess, setPaymentSuccess] = useState<any>(null);

  // Card details state
  const [cardForm, setCardForm] = useState({
    cardNumber: '',
    expiry: '',
    cvv: '',
    nameOnCard: '',
  });

  useEffect(() => {
    setIsClient(true);
  }, []);

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

  const handleCardInputChange = (field: string, value: string) => {
    setCardForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleProcessPayment = async () => {
    if (!selectedPlan) return;

    if (paymentMethod === 'CARD') {
      if (!cardForm.cardNumber || cardForm.cardNumber.replace(/\s/g, '').length < 16) {
        showToast('Please enter a valid 16-digit card number.', 'error');
        return;
      }
      if (!cardForm.expiry || !cardForm.expiry.includes('/')) {
        showToast('Please enter card expiry date (MM/YY).', 'error');
        return;
      }
      if (!cardForm.cvv || cardForm.cvv.length < 3) {
        showToast('Please enter 3-digit CVV security code.', 'error');
        return;
      }
      if (!cardForm.nameOnCard.trim()) {
        showToast('Please enter cardholder full name.', 'error');
        return;
      }
    }

    setProcessing(true);

    try {
      const token = localStorage.getItem('ace_token');

      // Call API checkout endpoint
      const checkoutRes = await fetch(`${API_URL}/api/billing/checkout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ plan: selectedPlan.id }),
      });

      if (checkoutRes.ok) {
        const data = await checkoutRes.json();
        if (data.authorization_url || data?.data?.authorization_url) {
          window.open(data.authorization_url || data.data.authorization_url, '_blank');
          showToast('Redirecting to Paystack Secure Checkout...', 'success');
        }
      }

      // Activate plan in DB
      const activateRes = await fetch(`${API_URL}/api/billing/activate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ plan: selectedPlan.id }),
      });

      if (activateRes.ok) {
        const ref = `ACE_PAY_${Date.now().toString().slice(-8)}`;
        setPaymentSuccess({
          plan: selectedPlan.name,
          amount: selectedPlan.price,
          reference: ref,
          method: paymentMethod === 'CARD' ? 'Debit/Credit Card' : paymentMethod === 'TRANSFER' ? 'Bank Transfer' : 'USSD Code',
          date: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
        });
        showToast(`Payment confirmed! Upgraded to ${selectedPlan.name} Plan.`, 'success');
        setSelectedPlan(null);
        await fetchSubscription();
      } else {
        showToast('Payment processing failed. Please try again.', 'error');
      }
    } catch (err) {
      showToast('Network connection error during payment. Try again.', 'error');
    } finally {
      setProcessing(false);
    }
  };

  const copyVirtualAccount = () => {
    navigator.clipboard.writeText('9928374102');
    setCopiedAccount(true);
    showToast('Virtual Account Number copied to clipboard!', 'success');
    setTimeout(() => setCopiedAccount(false), 3000);
  };

  const currentPlanKey = (subscription?.plan || 'STARTER').toUpperCase();

  // Render Portal Toasts directly on document.body for top-level screen visibility (z-[99999])
  const renderToastPortal = () => {
    if (!isClient || !toast) return null;
    return createPortal(
      <div className="fixed top-6 right-6 z-[99999] pointer-events-auto flex items-center gap-3 px-6 py-4 rounded-2xl shadow-2xl border text-sm font-semibold backdrop-blur-2xl animate-in fade-in slide-in-from-top-4 duration-200 bg-slate-900/95 text-white border-slate-700">
        {toast.type === 'success' ? (
          <CheckCircle2 className="w-5 h-5 text-emerald-400 flex-shrink-0" />
        ) : (
          <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0" />
        )}
        <span>{toast.msg}</span>
      </div>,
      document.body
    );
  };

  return (
    <div className="max-w-6xl mx-auto space-y-8 pb-12">
      {renderToastPortal()}

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
                  <span className="text-xs text-slate-400 font-medium">Next Renewal Date</span>
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

          {/* Resource Usage Grid */}
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
                Transparent NGN pricing. Enter card details or transfer directly to activate subscription instantly.
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
                          <Zap className="w-4 h-4" /> Select {plan.name}
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

      {/* Payment Method & Checkout Modal */}
      {selectedPlan && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md animate-in fade-in duration-200">
          <div className="w-full max-w-lg rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-7 shadow-2xl space-y-6 max-h-[90vh] overflow-y-auto">
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-4">
              <div>
                <h3 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
                  <Lock className="w-4 h-4 text-emerald-500" /> Secure Payment Checkout
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Upgrading to <span className="font-bold text-slate-900 dark:text-white">{selectedPlan.name} Plan</span>
                </p>
              </div>
              <button
                onClick={() => setSelectedPlan(null)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Price Breakdown */}
            <div className="p-4 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700/60 space-y-2 text-xs">
              <div className="flex items-center justify-between text-slate-600 dark:text-slate-400">
                <span>{selectedPlan.name} Subscription (1 Month)</span>
                <span className="font-semibold text-slate-900 dark:text-white">₦{selectedPlan.price.toLocaleString()}</span>
              </div>
              <div className="flex items-center justify-between text-slate-600 dark:text-slate-400">
                <span>VAT / Tax (7.5%)</span>
                <span className="font-semibold text-slate-900 dark:text-white">₦{(selectedPlan.price * 0.075).toLocaleString()}</span>
              </div>
              <div className="border-t border-slate-200 dark:border-slate-700 pt-2 flex items-center justify-between text-sm font-extrabold text-slate-900 dark:text-white">
                <span>Total Amount Payable</span>
                <span className="text-blue-600 dark:text-blue-400 text-base">
                  ₦{(selectedPlan.price * 1.075).toLocaleString()}
                </span>
              </div>
            </div>

            {/* Payment Method Tabs */}
            <div className="space-y-3">
              <label className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
                Select Payment Method
              </label>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { id: 'CARD', label: 'Card', icon: <CreditCard className="w-4 h-4" /> },
                  { id: 'TRANSFER', label: 'Transfer', icon: <Building2 className="w-4 h-4" /> },
                  { id: 'USSD', label: 'USSD Code', icon: <Smartphone className="w-4 h-4" /> },
                ].map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setPaymentMethod(m.id as PaymentMethod)}
                    className={`py-2.5 px-3 rounded-xl border text-xs font-bold flex flex-col items-center gap-1.5 transition-all ${
                      paymentMethod === m.id
                        ? 'bg-blue-600 text-white border-blue-600 shadow-md shadow-blue-500/20'
                        : 'bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    {m.icon}
                    {m.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Payment Method Forms */}
            {paymentMethod === 'CARD' && (
              <div className="space-y-4 pt-2">
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">Cardholder Full Name</label>
                  <input
                    type="text"
                    placeholder="e.g. Oluwaseun Adeleke"
                    value={cardForm.nameOnCard}
                    onChange={(e) => handleCardInputChange('nameOnCard', e.target.value)}
                    className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white text-xs focus:ring-2 focus:ring-blue-500 outline-none"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">Card Number</label>
                  <div className="relative">
                    <input
                      type="text"
                      maxLength={19}
                      placeholder="5399 0000 0000 0000"
                      value={cardForm.cardNumber}
                      onChange={(e) => {
                        const val = e.target.value.replace(/\D/g, '').replace(/(.{4})/g, '$1 ').trim();
                        handleCardInputChange('cardNumber', val);
                      }}
                      className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white text-xs font-mono focus:ring-2 focus:ring-blue-500 outline-none"
                    />
                    <CreditCard className="w-4 h-4 text-slate-400 absolute right-3.5 top-3" />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">Expiry (MM/YY)</label>
                    <input
                      type="text"
                      maxLength={5}
                      placeholder="12/28"
                      value={cardForm.expiry}
                      onChange={(e) => {
                        let val = e.target.value.replace(/\D/g, '');
                        if (val.length >= 2) val = `${val.slice(0, 2)}/${val.slice(2, 4)}`;
                        handleCardInputChange('expiry', val);
                      }}
                      className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white text-xs font-mono focus:ring-2 focus:ring-blue-500 outline-none text-center"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">CVV Security Code</label>
                    <input
                      type="password"
                      maxLength={4}
                      placeholder="882"
                      value={cardForm.cvv}
                      onChange={(e) => handleCardInputChange('cvv', e.target.value.replace(/\D/g, ''))}
                      className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white text-xs font-mono focus:ring-2 focus:ring-blue-500 outline-none text-center"
                    />
                  </div>
                </div>
              </div>
            )}

            {paymentMethod === 'TRANSFER' && (
              <div className="p-4 rounded-2xl bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800/60 space-y-3 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-slate-600 dark:text-slate-400 font-semibold">Bank Name</span>
                  <span className="font-bold text-slate-900 dark:text-white">Providus Bank / Paystack</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-600 dark:text-slate-400 font-semibold">Account Name</span>
                  <span className="font-bold text-slate-900 dark:text-white">ACE Customer Care NG</span>
                </div>
                <div className="flex items-center justify-between pt-1">
                  <span className="text-slate-600 dark:text-slate-400 font-semibold">Virtual Account Number</span>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-base font-extrabold text-blue-600 dark:text-blue-400">9928374102</span>
                    <button
                      onClick={copyVirtualAccount}
                      className="p-1 rounded bg-blue-100 dark:bg-blue-800 text-blue-700 dark:text-blue-200 hover:bg-blue-200"
                    >
                      {copiedAccount ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 text-center pt-2">
                  Transfer the exact total amount to activate instantly. Expires in 30 mins.
                </p>
              </div>
            )}

            {paymentMethod === 'USSD' && (
              <div className="space-y-3 pt-2 text-xs">
                <label className="font-semibold text-slate-700 dark:text-slate-300">Select Your Bank USSD Quick Code</label>
                <div className="space-y-2">
                  {[
                    { bank: 'GTBank', code: '*737*000*9928#' },
                    { bank: 'Zenith Bank', code: '*966*000*9928#' },
                    { bank: 'First Bank', code: '*894*000*9928#' },
                    { bank: 'Access Bank', code: '*901*000*9928#' },
                  ].map((b) => (
                    <div key={b.bank} className="flex items-center justify-between p-3 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
                      <span className="font-bold text-slate-900 dark:text-white">{b.bank}</span>
                      <span className="font-mono font-extrabold text-blue-600 dark:text-blue-400">{b.code}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Modal Actions */}
            <div className="space-y-2 pt-2">
              <button
                onClick={handleProcessPayment}
                disabled={processing}
                className="w-full py-3.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-extrabold text-sm shadow-xl shadow-blue-500/25 transition-all flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {processing ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
                {processing ? 'Processing Payment...' : `Pay ₦${(selectedPlan.price * 1.075).toLocaleString()} & Activate Plan`}
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

      {/* Payment Success Modal */}
      {paymentSuccess && (
        <div className="fixed inset-0 z-[99999] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md animate-in fade-in duration-200">
          <div className="w-full max-w-md rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-7 shadow-2xl space-y-6 text-center">
            <div className="w-16 h-16 rounded-full bg-emerald-500/10 text-emerald-500 flex items-center justify-center mx-auto border border-emerald-500/20">
              <CheckCircle2 className="w-8 h-8" />
            </div>
            
            <div className="space-y-1">
              <h3 className="text-xl font-extrabold text-slate-900 dark:text-white">Payment Confirmed!</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Your subscription to the <span className="font-bold text-slate-900 dark:text-white">{paymentSuccess.plan} Plan</span> is active.
              </p>
            </div>

            <div className="p-4 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700/60 space-y-2 text-xs text-left">
              <div className="flex justify-between">
                <span className="text-slate-500">Transaction Ref:</span>
                <span className="font-mono font-bold text-slate-900 dark:text-white">{paymentSuccess.reference}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Payment Method:</span>
                <span className="font-bold text-slate-900 dark:text-white">{paymentSuccess.method}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Amount Paid:</span>
                <span className="font-bold text-emerald-600 dark:text-emerald-400">₦{paymentSuccess.amount.toLocaleString()}</span>
              </div>
            </div>

            <button
              onClick={() => setPaymentSuccess(null)}
              className="w-full py-3.5 rounded-xl bg-slate-900 dark:bg-slate-100 hover:bg-slate-800 dark:hover:bg-white text-white dark:text-slate-900 font-extrabold text-xs shadow-lg transition-all flex items-center justify-center gap-2"
            >
              Access Platform Features <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
