"use client";
import React, { useState } from 'react';
import { api } from '@/lib/api';
import { Sparkles, Eye, EyeOff, ShieldCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await api.auth.login(email, password);
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
      <div className="hidden lg:flex w-1/2 flex-col justify-between p-12 relative overflow-hidden bg-gradient-to-br from-[#0c1a05] via-[#1a3308] to-[#0c1a05]">
        <div className="absolute inset-0 bg-gradient-to-tr from-[#74BA03]/20 via-transparent to-[#558A02]/20 opacity-40"></div>
        
        <div className="relative z-10 flex items-center gap-3">
          <div className="w-12 h-12 rounded-xl flex items-center justify-center shadow-lg" style={{ background: 'linear-gradient(135deg, #558A02, #74BA03)' }}>
            <svg className="w-7 h-7 text-white" fill="currentColor" viewBox="0 0 24 24">
              <path d="M19 3H5C3.9 3 3 3.9 3 5v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-2 10h-4v4h-2v-4H7v-2h4V7h2v4h4v2z"/>
            </svg>
          </div>
          <div>
            <h1 className="font-bold text-2xl text-white">
              PLASCHEMA
            </h1>
            <p className="text-xs font-semibold" style={{ color: '#74BA03' }}>
              Plateau State Contributory Healthcare Management Agency
            </p>
          </div>
        </div>
        
        <div className="relative z-10">
          <h2 className="text-4xl font-bold text-white mb-6 leading-tight">
            Universal Healthcare Helpline <br/><span style={{ color: '#74BA03' }}>&amp; Enrollee Management Portal</span>
          </h2>
          <p className="text-slate-300 text-base max-w-md">
            Delivering accessible, affordable, and quality healthcare coverage for every citizen across all 17 LGAs of Plateau State.
          </p>

          <div className="mt-8 p-4 rounded-2xl bg-[#74BA03]/10 border border-[#74BA03]/20 max-w-md">
            <div className="flex items-center gap-2 text-[#74BA03] text-sm font-semibold mb-1">
              <ShieldCheck className="w-4 h-4" /> Official Government Helpline
            </div>
            <p className="text-xs text-slate-300">
              Authorized desk officer and admin access for helpline operations, beneficiary support, provider oversight, and inquiries.
            </p>
          </div>
        </div>
        
        <div className="relative z-10 text-sm text-slate-400">
          © 2026 PLASCHEMA. All rights reserved.
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
              style={{ background: 'linear-gradient(135deg, #558A02, #74BA03)' }}
            >
              {loading ? (
                <>
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                  Signing in...
                </>
              ) : (
                'Sign In to PLASCHEMA Portal'
              )}
            </button>
          </form>

          <div className="text-center text-sm text-slate-600 dark:text-slate-400">
            Helpline Enrollee Portal &bull; Plateau State Contributory Healthcare
          </div>
        </div>
      </div>
    </div>
  );
}
