"use client";
import React, { useState } from 'react';
import { Sparkles, Eye, EyeOff } from 'lucide-react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

export default function RegisterPage() {
  const [showPassword, setShowPassword] = useState(false);
  const [formData, setFormData] = useState({
    orgName: '',
    fullName: '',
    email: '',
    password: '',
    confirmPassword: '',
    industry: 'OTHER',
    country: 'Nigeria',
  });
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const router = useRouter();

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (formData.password !== formData.confirmPassword) {
      setStatus('error');
      setMessage('Passwords do not match');
      return;
    }
    if (formData.password.length < 8) {
      setStatus('error');
      setMessage('Password must be at least 8 characters long');
      return;
    }

    setStatus('loading');
    setMessage('');
    try {
      const res = await fetch(`${API_URL}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          organizationName: formData.orgName,
          industry: formData.industry,
          country: formData.country,
          adminFullName: formData.fullName,
          adminEmail: formData.email,
          adminPassword: formData.password,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setStatus('success');
        setMessage('Registration successful! Check your email to verify your account.');
        setTimeout(() => {
          router.push('/login');
        }, 3000);
      } else {
        setStatus('error');
        setMessage(data.message || 'Registration failed.');
      }
    } catch (err: any) {
      setStatus('error');
      setMessage(err.message || 'An error occurred during registration.');
    }
  };

  return (
    <div className="flex min-h-screen w-full bg-[#0a0f1e]">
      <div className="hidden lg:flex w-1/2 flex-col justify-between p-12 relative overflow-hidden bg-gradient-to-br from-[#0a0f1e] via-[#1a2b4c] to-[#0a0f1e] sticky top-0 h-screen">
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
            Start Your Journey <br/><span className="text-blue-400">with ACE Today</span>
          </h2>
          <ul className="space-y-4 text-gray-300 text-lg">
            <li className="flex items-center gap-3">
              <span className="w-6 h-6 rounded-full bg-blue-500/20 text-blue-400 flex items-center justify-center text-sm font-bold">✓</span>
              Unify your CRM, Communications, and AI
            </li>
            <li className="flex items-center gap-3">
              <span className="w-6 h-6 rounded-full bg-blue-500/20 text-blue-400 flex items-center justify-center text-sm font-bold">✓</span>
              Intelligent WhatsApp integration
            </li>
            <li className="flex items-center gap-3">
              <span className="w-6 h-6 rounded-full bg-blue-500/20 text-blue-400 flex items-center justify-center text-sm font-bold">✓</span>
              Smart voice routing and transcriptions
            </li>
          </ul>
        </div>
        
        <div className="relative z-10 text-sm text-gray-500">
          © 2024 ACE Platform. All rights reserved.
        </div>
      </div>
      
      <div className="w-full lg:w-1/2 flex flex-col justify-center items-center p-6 md:p-12 min-h-screen">
        <div className="w-full max-w-md space-y-6 py-6">
          <div className="text-center lg:text-left">
            <h2 className="text-3xl font-bold text-white mb-2">Create Account</h2>
            <p className="text-gray-400">Join thousands of businesses growing with ACE</p>
          </div>

          {status === 'success' && (
            <div className="p-4 rounded-xl bg-green-500/10 border border-green-500/20 text-green-400 text-sm">
              {message}
            </div>
          )}

          {status === 'error' && (
            <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
              {message}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-gray-300">Organization Name *</label>
              <input
                type="text"
                name="orgName"
                required
                value={formData.orgName}
                onChange={handleInputChange}
                className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all"
                placeholder="Acme Corp"
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-gray-300">Your Full Name *</label>
              <input
                type="text"
                name="fullName"
                required
                value={formData.fullName}
                onChange={handleInputChange}
                className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all"
                placeholder="Jane Doe"
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-gray-300">Work Email *</label>
              <input
                type="email"
                name="email"
                required
                value={formData.email}
                onChange={handleInputChange}
                className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all"
                placeholder="jane@example.com"
              />
            </div>
            
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium text-gray-300">Industry</label>
                <select
                  name="industry"
                  value={formData.industry}
                  onChange={handleInputChange}
                  className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all appearance-none"
                >
                  <option className="bg-[#0d1225] text-white" value="HOSPITALITY">Hospitality</option>
                  <option className="bg-[#0d1225] text-white" value="HEALTHCARE">Healthcare</option>
                  <option className="bg-[#0d1225] text-white" value="RETAIL">Retail</option>
                  <option className="bg-[#0d1225] text-white" value="FINANCE">Finance</option>
                  <option className="bg-[#0d1225] text-white" value="EDUCATION">Education</option>
                  <option className="bg-[#0d1225] text-white" value="REAL_ESTATE">Real Estate</option>
                  <option className="bg-[#0d1225] text-white" value="OTHER">Other</option>
                </select>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-gray-300">Country</label>
                <input
                  type="text"
                  name="country"
                  value={formData.country}
                  onChange={handleInputChange}
                  className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all"
                />
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-gray-300">Password *</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  name="password"
                  required
                  minLength={8}
                  value={formData.password}
                  onChange={handleInputChange}
                  className="w-full px-4 py-3 pr-12 rounded-xl bg-white/5 border border-white/10 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all"
                  placeholder="Min 8 characters"
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

            <div className="space-y-2">
              <label className="text-sm font-medium text-gray-300">Confirm Password *</label>
              <input
                type="password"
                name="confirmPassword"
                required
                value={formData.confirmPassword}
                onChange={handleInputChange}
                className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all"
                placeholder="Confirm password"
              />
            </div>

            <button
              type="submit"
              disabled={status === 'loading'}
              className="w-full py-3 mt-4 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-medium transition-all disabled:opacity-50 flex justify-center items-center"
            >
              {status === 'loading' ? (
                <div className="w-5 h-5 border-2 border-white/20 border-t-white rounded-full animate-spin"></div>
              ) : (
                'Create Account'
              )}
            </button>
          </form>
          
          <div className="mt-8 pt-6 border-t border-white/10 text-center">
             <div className="text-sm text-gray-500">
               Already have an account?{' '}
               <Link href="/login" className="text-blue-400 hover:text-blue-300 font-medium">Sign in</Link>
             </div>
          </div>
        </div>
      </div>
    </div>
  );
}
