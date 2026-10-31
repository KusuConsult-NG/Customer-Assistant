import { existsSync } from 'node:fs';
import { defineConfig, devices, chromium } from '@playwright/test';

/**
 * Where to find a Chromium this suite can actually launch.
 *
 * `@playwright/test` is declared as a range, so `npm install` can move it to a
 * version pinning a browser revision that was never downloaded — and then every
 * spec fails with `Executable doesn't exist at .../chromium_headless_shell-<rev>`,
 * which reads exactly like a broken suite and is really a missing download.
 * Worse, `verify-all.sh` then SKIPS the browser layer, so the whole UI tier goes
 * unverified on a report that looks clean.
 *
 * So: use the pinned build when it is there (CI runs `playwright install`, and
 * that is the browser the version was tested against). Otherwise fall back to a
 * Chromium the container already has at a fixed path. `PLAYWRIGHT_CHROMIUM_PATH`
 * overrides both.
 *
 * Returning `undefined` is the normal case and changes nothing.
 */
function containerChromium(): string | undefined {
  const override = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  if (override) return override;

  // The pinned revision is present — nothing to work around.
  try {
    if (existsSync(chromium.executablePath())) return undefined;
  } catch {
    // Older/newer APIs may throw rather than report a path; fall through to the
    // search, which is what we would do anyway.
  }

  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers'].filter(Boolean) as string[];
  for (const root of roots) {
    const candidate = `${root.replace(/\/+$/, '')}/chromium`;
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const executablePath = containerChromium();

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  expect: {
    timeout: 5000
  },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['html', { open: 'never' }], ['list']],
  use: {
    baseURL: process.env.PLAYWRIGHT_TEST_BASE_URL || 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // See containerChromium() above. Passing a full Chrome binary also opts
    // out of the headless-shell build, which is the one that goes missing.
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
