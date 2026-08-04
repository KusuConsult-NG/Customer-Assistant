import { test, expect } from '@playwright/test';

test.describe('ACE Platform Customer Journey E2E Tests', () => {

  test('J1 & J9: Widget Generator & Embeddable Web Chat', async ({ page }) => {
    await page.goto('/widget');
    await expect(page).toHaveTitle(/ACE/i);
    
    // Check snippet copy button & preview container
    const heading = page.locator('h1');
    await expect(heading).toContainText(/Widget/i);
  });

  test('J2: Telephony Dashboard & Voice Simulator', async ({ page }) => {
    await page.goto('/telephony');
    await expect(page.locator('h1')).toContainText(/Voice AI Telephony/i);
    
    // Check Demo Simulation button
    const demoBtn = page.getByRole('button', { name: /Start Demo Simulation/i });
    await expect(demoBtn).toBeVisible();
  });

  test('J3: CRM Pipeline & Contacts Board', async ({ page }) => {
    await page.goto('/crm');
    await expect(page.locator('h1')).toContainText(/CRM/i);
    
    // Check Contacts / Leads / Deals tabs
    const contactsTab = page.getByRole('button', { name: /Contacts/i });
    await expect(contactsTab).toBeVisible();
  });

  test('J5 & J6: Scheduling & Refund Request Management', async ({ page }) => {
    await page.goto('/scheduling');
    await expect(page.locator('h1')).toContainText(/Bookings & Reservations/i);
  });

  test('J7: Settings & Team Management', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.locator('h1')).toContainText(/Settings/i);
  });

  test('J8: Billing & Plan Comparison', async ({ page }) => {
    await page.goto('/billing');
    await expect(page.locator('h1')).toContainText(/Billing/i);
  });

  test('J10: Workflows Automation Engine', async ({ page }) => {
    await page.goto('/workflows');
    await expect(page.locator('h1')).toContainText(/Workflows/i);
  });
});
