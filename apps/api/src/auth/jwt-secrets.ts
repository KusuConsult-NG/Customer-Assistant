/**
 * Single source of truth for JWT secrets.
 *
 * Previously three files each carried their own hardcoded fallback secret
 * ('super_secret_ace_platform_jwt_key_2026_change_in_prod'). Startup validation
 * makes the fallback unreachable in a normal boot, but any other entrypoint
 * (tests, scripts, a future worker) would silently sign tokens with a secret
 * that is public on GitHub. Now:
 *   - production: missing secret throws immediately (defense in depth behind
 *     env.validation.ts).
 *   - dev/test: a clearly-labeled deterministic value keeps local boots and the
 *     Jest suite working without env setup.
 */
function resolveSecret(envKey: string, devFallback: string): string {
  const value = process.env[envKey];
  if (value) return value;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      `${envKey} is not set. Refusing to sign/verify JWTs with a default secret in production.`
    );
  }
  return devFallback;
}

export function getJwtSecret(): string {
  return resolveSecret('JWT_SECRET', 'ace_dev_only_jwt_secret_do_not_use_in_prod');
}

export function getJwtRefreshSecret(): string {
  return resolveSecret('JWT_REFRESH_SECRET', 'ace_dev_only_refresh_secret_do_not_use_in_prod');
}
