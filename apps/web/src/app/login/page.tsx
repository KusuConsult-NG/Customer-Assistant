"use client";
import React, { useState } from 'react';
import { api } from '@/lib/api';
import { Sparkles, Building2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
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
      setError(err.message || 'Invalid credentials');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex h-screen w-full overflow-hidden bg-[#0a0f1e]">
      <div className="hidden lg:flex w-1/2 flex-col justify-between p-12 relative overflow-hidden bg-gradient-to-br from-[#0a0f1e] via-[#1a2b4c] to-[#0a0f1e]">
        <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-20 mix-blend-soft-light"></div>
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
        </div>
        
        <div className="relative z-10 text-sm text-gray-500">
          © 2024 ACE Platform. All rights reserved.
        </div>
      </div>
      
      <div className="w-full lg:w-1/2 flex items-center justify-center p-8">
        <div className="w-full max-w-md space-y-8">
          <div className="text-center lg:text-left">
            <h2 className="text-3xl font-bold text-white mb-2">Welcome Back</h2>
            <p className="text-gray-400">Sign in to your ACE Demo account</p>
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
              <label className="text-sm font-medium text-gray-300">Password</label>
              <input
                type="password"
                required
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all"
                placeholder="••••••••"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-medium transition-all disabled:opacity-50"
            >
              {loading ? 'Signing in...' : 'Sign in'}
            </button>
          </form>
          
          <div className="mt-8 pt-6 border-t border-white/10 text-center">
             <div className="flex items-center justify-center gap-2 text-sm text-gray-400 mb-4">
                <Building2 className="w-4 h-4" />
                <span>Demo Account: admin@acedemo.com / Admin@2030!</span>
             </div>
             <div className="text-center space-y-2 mt-4">
               <Link href="/forgot-password" className="text-sm text-gray-400 hover:text-blue-400 transition-colors">
                 Forgot your password?
               </Link>
               <div className="text-sm text-gray-500">
                 Don't have an account?{' '}
                 <Link href="/register" className="text-blue-400 hover:text-blue-300 font-medium">Create one free</Link>
               </div>
             </div>
          </div>
        </div>
      </div>
    </div>
  );
}
