"use client";
import React, { useState } from 'react';
import { Sparkles, Eye, EyeOff } from 'lucide-react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

import { API_URL } from '@/lib/api';

/**
 * Must match the IndustryType enum in packages/shared-types (and the Prisma enum).
 * The previous list offered HOSPITALITY / HEALTHCARE / RETAIL / FINANCE / EDUCATION,
 * none of which exist server-side, so the API rejected them.
 */
const INDUSTRY_OPTIONS = [
  { value: 'HOSPITAL', label: 'Hospital' },
  { value: 'CLINIC', label: 'Clinic' },
  { value: 'HOTEL', label: 'Hotel' },
  { value: 'RESTAURANT', label: 'Restaurant' },
  { value: 'SCHOOL', label: 'School' },
  { value: 'UNIVERSITY', label: 'University' },
  { value: 'CHURCH', label: 'Church' },
  { value: 'LAW_FIRM', label: 'Law Firm' },
  { value: 'REAL_ESTATE', label: 'Real Estate' },
  { value: 'LOGISTICS', label: 'Logistics' },
  { value: 'BANK', label: 'Bank' },
  { value: 'INSURANCE', label: 'Insurance' },
  { value: 'GOVERNMENT', label: 'Government' },
  { value: 'SALON_SPA', label: 'Salon & Spa' },
  { value: 'SME', label: 'Small / Medium Business' },
  { value: 'ENTERPRISE', label: 'Enterprise' },
  { value: 'OTHER', label: 'Other' },
];

export default function RegisterPage() {
  const [showPassword, setShowPassword] = useState(false);
  const [formData, setFormData] = useState({
    orgName: '',
    fullName: '',
    email: '',
    password: '',
    confirmPassword: '',
    industry: 'SME',
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
      // Field names must match the API's RegisterDto exactly.
      //
      // This form used to post adminFullName / adminEmail / adminPassword. The API
      // reads fullName / email / password, so every one of them arrived as undefined
      // and registration failed with an opaque 500 from inside bcrypt — sign-up was
      // completely broken. `industry` likewise sent values (HOSPITALITY, HEALTHCARE,
      // RETAIL, FINANCE) that are not members of the IndustryType enum.
      const res = await fetch(`${API_URL}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          organizationName: formData.orgName,
          industry: formData.industry,
          country: formData.country,
          fullName: formData.fullName,
          email: formData.email,
          password: formData.password,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setStatus('success');
        setMessage(data.message || 'Registration successful! Check your email to verify your account.');
        setTimeout(() => {
          router.push('/login');
        }, 3000);
      } else {
        setStatus('error');
        // class-validator returns `message` as a string[] on 400.
        setMessage(
          Array.isArray(data.message) ? data.message.join(' ') : (data.message || 'Registration failed.')
        );
      }
    } catch (err: any) {
      setStatus('error');
      setMessage(err.message || 'An error occurred during registration.');
    }
  };

  return (
    <div className="flex min-h-screen w-full bg-slate-50 dark:bg-slate-900">
      <div className="hidden lg:flex w-1/2 flex-col justify-between p-12 relative overflow-hidden bg-gradient-to-br from-[#0c1a05] via-[#1a3308] to-[#0c1a05] sticky top-0 h-screen">
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
            Plateau State <br/><span style={{ color: '#74BA03' }}>Enrollee Helpline Portal</span>
          </h2>
          <ul className="space-y-4 text-slate-300 text-base">
            <li className="flex items-center gap-3">
              <span className="w-6 h-6 rounded-full bg-[#74BA03]/20 text-[#74BA03] flex items-center justify-center text-sm font-bold">✓</span>
              400+ accredited healthcare facilities across all 17 LGAs
            </li>
            <li className="flex items-center gap-3">
              <span className="w-6 h-6 rounded-full bg-[#74BA03]/20 text-[#74BA03] flex items-center justify-center text-sm font-bold">✓</span>
              24/7 AI-powered voice helpline on 0700-700-1111
            </li>
            <li className="flex items-center gap-3">
              <span className="w-6 h-6 rounded-full bg-[#74BA03]/20 text-[#74BA03] flex items-center justify-center text-sm font-bold">✓</span>
              Comprehensive beneficiary &amp; facility grievance management
            </li>
          </ul>
        </div>
        
        <div className="relative z-10 text-sm text-slate-400">
          © 2026 PLASCHEMA. All rights reserved.
        </div>
      </div>
      
      <div className="w-full lg:w-1/2 flex flex-col justify-center items-center p-6 md:p-12 min-h-screen">
        <div className="w-full max-w-md space-y-6 py-6">
          <div className="text-center lg:text-left">
            <h2 className="text-3xl font-bold text-slate-900 dark:text-white mb-2">Create Account</h2>
            <p className="text-slate-600 dark:text-slate-400">Join thousands of businesses growing with Customer Care Agent</p>
          </div>

          {status === 'success' && (
            <div className="p-4 rounded-xl bg-green-50 dark:bg-green-500/10 border border-green-200 dark:border-green-500/20 text-green-600 dark:text-green-400 text-sm">
              {message}
            </div>
          )}

          {status === 'error' && (
            <div className="p-4 rounded-xl bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 text-red-600 dark:text-red-400 text-sm">
              {message}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Organization Name *</label>
              <input
                type="text"
                name="orgName"
                required
                value={formData.orgName}
                onChange={handleInputChange}
                className="w-full px-4 py-3 rounded-xl bg-slate-100 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all"
                placeholder="Acme Corp"
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Your Full Name *</label>
              <input
                type="text"
                name="fullName"
                required
                value={formData.fullName}
                onChange={handleInputChange}
                className="w-full px-4 py-3 rounded-xl bg-slate-100 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all"
                placeholder="Jane Doe"
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Work Email *</label>
              <input
                type="email"
                name="email"
                required
                value={formData.email}
                onChange={handleInputChange}
                className="w-full px-4 py-3 rounded-xl bg-slate-100 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all"
                placeholder="jane@example.com"
              />
            </div>
            
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Industry</label>
                <select
                  name="industry"
                  value={formData.industry}
                  onChange={handleInputChange}
                  className="w-full px-4 py-3 rounded-xl bg-slate-100 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all appearance-none"
                >
                  {INDUSTRY_OPTIONS.map(opt => (
                    <option
                      key={opt.value}
                      className="bg-white dark:bg-slate-900 text-slate-900 dark:text-white"
                      value={opt.value}
                    >
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Country</label>
                <input
                  type="text"
                  name="country"
                  value={formData.country}
                  onChange={handleInputChange}
                  className="w-full px-4 py-3 rounded-xl bg-slate-100 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all"
                />
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Password *</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  name="password"
                  required
                  minLength={8}
                  value={formData.password}
                  onChange={handleInputChange}
                  className="w-full px-4 py-3 pr-12 rounded-xl bg-slate-100 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all"
                  placeholder="Min 8 characters"
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

            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Confirm Password *</label>
              <input
                type="password"
                name="confirmPassword"
                required
                value={formData.confirmPassword}
                onChange={handleInputChange}
                className="w-full px-4 py-3 rounded-xl bg-slate-100 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all"
                placeholder="Confirm password"
              />
            </div>

            <button
              type="submit"
              disabled={status === 'loading'}
              className="w-full py-3 mt-4 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-medium transition-all disabled:opacity-50 flex justify-center items-center"
            >
              {status === 'loading' ? (
                <div className="w-5 h-5 border-2 border-slate-200 dark:border-slate-700 border-t-white rounded-full animate-spin"></div>
              ) : (
                'Create Account'
              )}
            </button>
          </form>
          
          <div className="mt-8 pt-6 border-t border-slate-200 dark:border-slate-800 text-center">
             <div className="text-sm text-slate-500 dark:text-slate-400">
               Already have an account?{' '}
               <Link href="/login" className="text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:text-blue-300 font-medium">Sign in</Link>
             </div>
          </div>
        </div>
      </div>
    </div>
  );
}
