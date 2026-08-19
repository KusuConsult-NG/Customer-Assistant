# Security Audit Report

## 1. Credentials & Secrets
- All agent keys are salted and stored only as SHA-256 hashes (keyHash).
- Workspace secrets in ElevenLabs use secret handles (fromSecret) rather than plain text in headers.
- AES-256-GCM authenticated encryption (secret-box.ts) verified for sensitive credentials at rest.

## 2. Network & SSRF Security
- SSRF filter (ssrf.spec.ts) verified: blocks loopback, link-local, private RFC1918 IPs, and AWS metadata endpoints.
- Webhook HMAC signature verification verified for ElevenLabs, Twilio, and Paystack.
- CORS restricted to internal domains in production.
