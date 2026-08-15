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
  organizationName: string;
  organizationLogoUrl: string | null;
  purpose: string | null;
  expiresAt: string;
  maxBytes: number;
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
      // Denied, unavailable, or an in-app browser that blocks it. The file input
      // still works, so this is a downgrade rather than a dead end.
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

  const upload = async () => {
    if (!preview) return;
    setStage('uploading');
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/public/selfie/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: preview }),
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

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xl overflow-hidden">
        {/* Header */}
        <div className="px-6 pt-6 pb-4 text-center border-b border-slate-100 dark:border-slate-800">
          {info?.organizationLogoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={info.organizationLogoUrl} alt="" className="h-8 mx-auto mb-3 object-contain" />
          ) : null}
          <h1 className="text-lg font-bold text-slate-900 dark:text-white">
            {stage === 'done' ? 'All done' : 'Take a quick selfie'}
          </h1>
          {info && stage !== 'done' && (
            <p className="text-xs text-slate-600 dark:text-slate-400 mt-1">
              {info.firstName ? `Hi ${info.firstName} — ` : ''}
              {info.organizationName} needs a photo of you
              {info.purpose ? ` for ${info.purpose}` : ''}.
            </p>
          )}
        </div>

        <div className="p-6 space-y-4">
          {stage === 'loading' && (
            <div className="h-56 rounded-2xl bg-slate-100 dark:bg-slate-800 animate-pulse" />
          )}

          {stage === 'invalid' && (
            <div className="text-center space-y-3 py-6">
              <div className="w-12 h-12 rounded-full bg-red-100 dark:bg-red-500/15 text-red-600 dark:text-red-400 flex items-center justify-center mx-auto text-2xl">
                !
              </div>
              <p className="text-sm text-slate-700 dark:text-slate-300">{error}</p>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Reply to the chat you received this from and we will send a new link.
              </p>
            </div>
          )}

          {stage === 'done' && (
            <div className="text-center space-y-3 py-6">
              <div className="w-12 h-12 rounded-full bg-emerald-100 dark:bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 flex items-center justify-center mx-auto text-2xl">
                ✓
              </div>
              <p className="text-sm text-slate-700 dark:text-slate-300">
                Thank you — we have received your photo.
              </p>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                You can close this page. A member of the team will continue from here.
              </p>
            </div>
          )}

          {(stage === 'ready' || stage === 'captured' || stage === 'uploading') && (
            <>
              <div className="relative rounded-2xl overflow-hidden bg-slate-900 aspect-[3/4]">
                {preview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={preview} alt="Your photo" className="w-full h-full object-cover" />
                ) : (
                  <video
                    ref={videoRef}
                    playsInline
                    muted
                    autoPlay
                    // Mirrored so it behaves like a mirror, which is what people expect.
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
                      className="w-full py-3 rounded-2xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm"
                    >
                      Take photo
                    </button>
                  )}
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="w-full py-3 rounded-2xl bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-semibold text-sm"
                  >
                    {cameraError ? 'Take photo' : 'Choose from your phone'}
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
                    className="flex-1 py-3 rounded-2xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm disabled:opacity-60"
                  >
                    {stage === 'uploading' ? 'Sending…' : 'Send photo'}
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {/* Anti-phishing footer. Anyone can send a link; say plainly what we never ask for. */}
        {stage !== 'done' && stage !== 'invalid' && (
          <div className="px-6 pb-6">
            <p className="text-[10px] leading-relaxed text-slate-500 dark:text-slate-400 text-center">
              We will never ask for your PIN, password, or card details on this page.
              {info ? ` This link expires on ${new Date(info.expiresAt).toLocaleString()}.` : ''}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
