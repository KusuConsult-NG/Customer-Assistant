"use client";

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { API_URL } from '@/lib/api';

/**
 * Customer-facing selfie upload.
 *
 * Reached from a one-time link sent over WhatsApp or after a phone call, by someone
 * who has no account here and is probably on a phone. So:
 *
 *  - No auth, no nav, no app chrome. The token in the URL is the whole credential.
 *  - Live camera via getUserMedia with the front camera, and a file-input fallback
 *    with capture="user" for browsers that refuse camera access (iOS in-app browsers
 *    routinely do).
 *  - The image is downscaled in the browser before upload. A modern phone camera
 *    produces 4-12MB per shot; sending that raw over a rural mobile connection is how
 *    an upload "just spins" and the onboarding step never completes.
 *  - Every failure states what went wrong and leaves the retake button available.
 */

type Stage = 'loading' | 'invalid' | 'ready' | 'captured' | 'uploading' | 'done';

interface LinkInfo {
  firstName: string;
  fullName?: string;
  organizationName: string;
  organizationLogoUrl: string | null;
  purpose: string | null;
  planType?: string;
  isFamilyPlan?: boolean;
  expiresAt: string;
  maxBytes: number;
}

interface Dependent {
  fullName: string;
  relationship: string;
  dob?: string;
}

/** Longest edge of the uploaded image. Plenty for a face; a fraction of the bytes. */
const MAX_EDGE = 1280;
const JPEG_QUALITY = 0.85;

export default function SelfieUploadPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token;

  const [stage, setStage] = useState<Stage>('loading');
  const [info, setInfo] = useState<LinkInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);

  // Family Dependents state
  const [showDependents, setShowDependents] = useState(false);
  const [dependents, setDependents] = useState<Dependent[]>([]);
  const [newDepName, setNewDepName] = useState('');
  const [newDepRel, setNewDepRel] = useState('Spouse');

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // ── Validate the link before showing a camera ─────────────────────────────
  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        const res = await fetch(`${API_URL}/api/public/selfie/${token}`);
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(body.message || 'This link is not valid.');
          setStage('invalid');
          return;
        }
        setInfo(body);
        if (body.isFamilyPlan) {
          setShowDependents(true);
        }
        setStage('ready');
      } catch {
        setError('We could not reach the server. Check your connection and try again.');
        setStage('invalid');
      }
    })();
  }, [token]);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const startCamera = useCallback(async () => {
    setCameraError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 1280 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
    } catch {
      setCameraError('We could not open your camera. Use the button below to take a photo instead.');
    }
  }, []);

  useEffect(() => {
    if (stage === 'ready') void startCamera();
    return () => stopCamera();
  }, [stage, startCamera, stopCamera]);

  /** Draws to a canvas at a bounded size and returns a JPEG data URL. */
  const toScaledJpeg = (source: HTMLVideoElement | HTMLImageElement, sw: number, sh: number): string => {
    const scale = Math.min(1, MAX_EDGE / Math.max(sw, sh));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(sw * scale);
    canvas.height = Math.round(sh * scale);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  };

  const capture = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) {
      setCameraError('The camera is not ready yet. Give it a moment and try again.');
      return;
    }
    setPreview(toScaledJpeg(video, video.videoWidth, video.videoHeight));
    stopCamera();
    setStage('captured');
  };

  const onFilePicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('Please choose a photo.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        setPreview(toScaledJpeg(img, img.naturalWidth, img.naturalHeight));
        stopCamera();
        setStage('captured');
        setError(null);
      };
      img.onerror = () => setError('We could not read that image. Please try another photo.');
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  };

  const retake = () => {
    setPreview(null);
    setError(null);
    setStage('ready');
  };

  const addDependent = () => {
    if (!newDepName.trim()) return;
    if (dependents.length >= 5) {
      setError('Family plans cover a maximum of 5 dependents (Spouse + 4 children).');
      return;
    }
    setDependents([...dependents, { fullName: newDepName.trim(), relationship: newDepRel }]);
    setNewDepName('');
  };

  const removeDependent = (idx: number) => {
    setDependents(dependents.filter((_, i) => i !== idx));
  };

  const upload = async () => {
    if (!preview) return;
    setStage('uploading');
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/public/selfie/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageBase64: preview,
          dependents: dependents.length > 0 ? dependents : undefined,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.message || 'The upload failed. Please try again.');
        setStage('captured');
        return;
      }
      setStage('done');
    } catch {
      setError('The upload failed. Check your connection and try again.');
      setStage('captured');
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xl overflow-hidden">
        {/* Header */}
        <div className="px-6 pt-6 pb-4 text-center border-b border-slate-100 dark:border-slate-800">
          <div className="inline-flex items-center justify-center w-10 h-10 rounded-2xl bg-[#74BA03]/15 text-[#558A02] dark:text-[#74BA03] font-black text-base mb-2 border border-[#74BA03]/30">
            PLS
          </div>
          <h1 className="text-lg font-bold text-slate-900 dark:text-white">
            {stage === 'done' ? 'Enrollment Received' : 'PLASCHEMA Photo & Verification'}
          </h1>
          {info && stage !== 'done' && (
            <p className="text-xs text-slate-600 dark:text-slate-400 mt-1">
              {info.firstName ? `Hello ${info.firstName} — ` : ''}
              Please take a clear selfie photo for your official PLASCHEMA Digital ID Card.
            </p>
          )}
        </div>

        <div className="p-6 space-y-4">
          {stage === 'loading' && (
            <div className="h-56 rounded-2xl bg-slate-100 dark:bg-slate-800 animate-pulse" />
          )}

          {stage === 'invalid' && (
            <div className="text-center space-y-3 py-6">
              <div className="w-12 h-12 rounded-full bg-red-100 dark:bg-red-500/15 text-red-600 dark:text-red-400 flex items-center justify-center mx-auto text-2xl font-bold">
                !
              </div>
              <p className="text-sm text-slate-700 dark:text-slate-300 font-semibold">{error}</p>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Call the PLASCHEMA Helpline on <strong>0700-700-1111</strong> or WhatsApp us to get a new link.
              </p>
            </div>
          )}

          {stage === 'done' && (
            <div className="text-center space-y-4 py-4">
              <div className="w-14 h-14 rounded-full bg-emerald-100 dark:bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 flex items-center justify-center mx-auto text-2xl font-bold border border-emerald-300 dark:border-emerald-500/30">
                ✓
              </div>
              <div>
                <h3 className="font-bold text-slate-900 dark:text-white text-base">Photo &amp; Details Submitted!</h3>
                <p className="text-xs text-slate-600 dark:text-slate-400 mt-1">
                  Your photo has been attached to your enrollment file. You can now complete your premium payment online.
                </p>
              </div>

              <div className="p-4 rounded-2xl bg-[#74BA03]/10 border border-[#74BA03]/30 text-left space-y-2">
                <div className="text-xs font-bold text-slate-900 dark:text-white flex items-center justify-between">
                  <span>Informal Sector Premium</span>
                  <span className="text-[#558A02] dark:text-[#74BA03] font-black">₦12,000 / ₦50,000</span>
                </div>
                <p className="text-[11px] text-slate-600 dark:text-slate-400">
                  Instant activation upon online payment with immediate digital card issuance.
                </p>
                <a
                  href="/pay/informal"
                  className="block text-center w-full py-2.5 px-4 rounded-xl text-white font-bold text-xs shadow-md bg-[#558A02] hover:bg-[#74BA03] transition-all"
                >
                  Pay Premium Online Now →
                </a>
              </div>

              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                Emergency or inquiries? Call PLASCHEMA on <strong>0700-700-1111</strong>.
              </p>
            </div>
          )}

          {(stage === 'ready' || stage === 'captured' || stage === 'uploading') && (
            <>
              <div className="relative rounded-2xl overflow-hidden bg-slate-900 aspect-[3/4] shadow-inner">
                {preview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={preview} alt="Your photo" className="w-full h-full object-cover" />
                ) : (
                  <video
                    ref={videoRef}
                    playsInline
                    muted
                    autoPlay
                    className="w-full h-full object-cover scale-x-[-1]"
                  />
                )}
              </div>

              {cameraError && !preview && (
                <p className="text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 rounded-xl p-3">
                  {cameraError}
                </p>
              )}

              {error && (
                <p className="text-xs text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 rounded-xl p-3">
                  {error}
                </p>
              )}

              {stage === 'ready' && (
                <div className="space-y-2">
                  {!cameraError && (
                    <button
                      onClick={capture}
                      className="w-full py-3 rounded-2xl text-white font-bold text-sm shadow-md bg-[#558A02] hover:bg-[#74BA03] transition-all"
                    >
                      Snap Photo
                    </button>
                  )}
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="w-full py-3 rounded-2xl bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-semibold text-sm hover:bg-slate-200 dark:hover:bg-slate-700 transition-all"
                  >
                    {cameraError ? 'Snap Photo' : 'Upload From Phone'}
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    capture="user"
                    onChange={onFilePicked}
                    className="hidden"
                  />
                </div>
              )}

              {(stage === 'captured' || stage === 'uploading') && (
                <div className="space-y-3">
                  {/* Family Dependents Section */}
                  <div className="p-3.5 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-slate-900 dark:text-white">
                        Family Dependents ({dependents.length}/5)
                      </span>
                      <button
                        type="button"
                        onClick={() => setShowDependents(!showDependents)}
                        className="text-[11px] font-semibold text-[#558A02] dark:text-[#74BA03]"
                      >
                        {showDependents ? 'Hide' : '+ Add Family Member'}
                      </button>
                    </div>

                    {showDependents && (
                      <div className="space-y-2 pt-1">
                        <div className="flex gap-1.5">
                          <input
                            type="text"
                            placeholder="Full name (e.g. Mary Pam)"
                            value={newDepName}
                            onChange={(e) => setNewDepName(e.target.value)}
                            className="flex-1 px-3 py-1.5 rounded-xl text-xs bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-white placeholder-slate-400"
                          />
                          <select
                            value={newDepRel}
                            onChange={(e) => setNewDepRel(e.target.value)}
                            className="px-2 py-1.5 rounded-xl text-xs bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-white"
                          >
                            <option value="Spouse">Spouse</option>
                            <option value="Child">Child</option>
                            <option value="Ward">Ward</option>
                          </select>
                          <button
                            type="button"
                            onClick={addDependent}
                            className="px-3 py-1.5 rounded-xl bg-[#558A02] text-white text-xs font-bold"
                          >
                            Add
                          </button>
                        </div>

                        {dependents.map((dep, i) => (
                          <div
                            key={i}
                            className="flex items-center justify-between px-2.5 py-1 rounded-lg bg-white dark:bg-slate-900 text-xs border border-slate-200 dark:border-slate-800"
                          >
                            <span className="font-medium text-slate-800 dark:text-slate-200">
                              {dep.fullName} <span className="text-slate-400">({dep.relationship})</span>
                            </span>
                            <button
                              type="button"
                              onClick={() => removeDependent(i)}
                              className="text-red-500 font-bold hover:text-red-600"
                            >
                              ✕
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="flex gap-2">
                    <button
                      onClick={retake}
                      disabled={stage === 'uploading'}
                      className="flex-1 py-3 rounded-2xl bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-semibold text-sm disabled:opacity-50"
                    >
                      Retake
                    </button>
                    <button
                      onClick={upload}
                      disabled={stage === 'uploading'}
                      className="flex-1 py-3 rounded-2xl text-white font-bold text-sm shadow-md bg-[#558A02] hover:bg-[#74BA03] transition-all disabled:opacity-60"
                    >
                      {stage === 'uploading' ? 'Sending…' : 'Submit Photo & Enrol'}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {stage !== 'done' && stage !== 'invalid' && (
          <div className="px-6 pb-6">
            <p className="text-[10px] leading-relaxed text-slate-500 dark:text-slate-400 text-center">
              Plateau State Contributory Healthcare Management Agency (PLASCHEMA).
              {info ? ` This photo link expires on ${new Date(info.expiresAt).toLocaleDateString()}.` : ''}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
