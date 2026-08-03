"use client";
import React, { useState } from 'react';
import { api } from '@/lib/api';
import { Sparkles, Eye, EyeOff, ShieldCheck, ArrowRight } from 'lucide-react';
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

  const handleFillDemoCreds = () => {
    setEmail('admin@acedemo.com');
    setPassword('Password123!');
    setError('');
  };

  return (
    <div className="flex h-screen w-full overflow-hidden bg-[#0a0f1e]">
      {/* Left Column: Branding */}
      <div className="hidden lg:flex w-1/2 flex-col justify-between p-12 relative overflow-hidden bg-gradient-to-br from-[#0a0f1e] via-[#1a2b4c] to-[#0a0f1e]">
        <div className="absolute inset-0 bg-gradient-to-tr from-blue-900/20 via-transparent to-purple-900/20 opacity-40"></div>
        
        <div className="relative z-10 flex items-center gap-3">
          <div className="w-12 h-12 rounded-xl bg-gradient-to-tr from-blue-500 to-blue-600 flex items-center justify-center shadow-lg shadow-blue-500/20">
            <Sparkles className="w-7 h-7 text-white" />
          </div>
          <h1 className="font-bold text-2xl bg-gradient-to-r from-white via-gray-200 to-gray-400 bg-clip-text text-transparent">
            ACE Platform
          </h1>
        </div>
        
        <div className="relative z-10">
          <h2 className="text-5xl font-bold text-white mb-6 leading-tight">
            AI-Powered Customer Experience <br/><span className="text-blue-400">for Nigerian Businesses</span>
          </h2>
          <p className="text-gray-400 text-lg max-w-md">
            Unify your CRM, Knowledge Base, and Omnichannel Communications in one premium dashboard.
          </p>

          <div className="mt-8 p-4 rounded-2xl bg-blue-500/10 border border-blue-500/20 max-w-md">
            <div className="flex items-center gap-2 text-blue-400 text-sm font-semibold mb-1">
              <ShieldCheck className="w-4 h-4" /> Demo Credentials Ready
            </div>
            <p className="text-xs text-gray-300">
              Click <span className="font-bold text-white font-mono">admin@acedemo.com</span> to pre-fill admin login credentials automatically.
            </p>
          </div>
        </div>
        
        <div className="relative z-10 text-sm text-gray-500">
          © 2026 ACE Platform. All rights reserved.
        </div>
      </div>
      
      {/* Right Column: Form */}
      <div className="w-full lg:w-1/2 flex items-center justify-center p-8">
        <div className="w-full max-w-md space-y-8">
          <div className="text-center lg:text-left">
            <h2 className="text-3xl font-bold text-white mb-2">Welcome Back</h2>
            <p className="text-gray-400">Sign in to your ACE account</p>
          </div>

          {/* Quick Demo Pre-fill Card */}
          <div className="p-3.5 rounded-xl bg-white/[0.03] border border-white/[0.08] flex items-center justify-between">
            <div className="text-xs">
              <p className="text-gray-400">Testing Demo Account?</p>
              <p className="text-white font-mono font-medium">admin@acedemo.com</p>
            </div>
            <button
              type="button"
              onClick={handleFillDemoCreds}
              className="px-3 py-1.5 rounded-lg bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 text-xs font-semibold transition-all border border-blue-500/20 flex items-center gap-1"
            >
              Auto-fill <ArrowRight className="w-3 h-3" />
            </button>
          </div>

          {error && (
            <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
              {error}
            </div>
          )}

          <form onSubmit={handleLogin} className="space-y-6">
            <div className="space-y-2">
              <label className="text-sm font-medium text-gray-300">Email address</label>
              <input
                type="email"
                required
                value={email}
                onChange={e => setEmail(e.target.value)}
                className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all"
                placeholder="admin@acedemo.com"
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-gray-300">Password</label>
                <Link href="/forgot-password" className="text-xs text-blue-400 hover:underline">
                  Forgot password?
                </Link>
              </div>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  required
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className="w-full px-4 py-3 pr-12 rounded-xl bg-white/5 border border-white/10 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all"
                  placeholder="••••••••"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white p-1 transition-colors"
                  title={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3.5 px-4 rounded-xl bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400 text-white font-semibold shadow-lg shadow-blue-500/25 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
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

          <div className="text-center text-sm text-gray-400">
            Don't have an account yet?{' '}
            <Link href="/register" className="text-blue-400 hover:underline font-semibold">
              Create Organization Account
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
