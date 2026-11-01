import { test, expect, Page } from '@playwright/test';

/**
 * The scheduling screen's actions, in a real browser.
 *
 * ── The defect this exists to prevent coming back ───────────────────────────
 *
 * "Cancel Booking", "Reschedule Slot", "Cancel Reservation" and "Mark
 * Completed" each showed a toast — *"Booking for Jane Citizen cancelled."* —
 * closed the panel, and MADE NO REQUEST AT ALL. The citizen's appointment was
 * untouched; the officer was told it was cancelled. Seven endpoints existed for
 * these actions and the page called none of them.
 *
 * So the assertions here are about the REQUEST, not the toast. A test that only
 * checked for the confirmation message would have passed against the broken
 * page — which is precisely how this survived.
 */

const API_URL = process.env.PLAYWRIGHT_API_URL || 'http://localhost:4000';

let cachedAuth: Promise<{ token: string; user: any }> | null = null;

function getAuth(): Promise<{ token: string; user: any }> {
  if (!cachedAuth) {
    cachedAuth = (async () => {
      const login = await fetch(`${API_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'admin@acedemo.com', password: 'Admin@2030!' }),
      });
      if (!login.ok) throw new Error(`E2E login failed: ${login.status} ${await login.text()}`);
      const data: any = await login.json();
      return { token: data.accessToken, user: data.user };
    })();
  }
  return cachedAuth;
}

const CONTACT = { id: 'contact_e2e', fullName: 'Jane Citizen', phoneNumber: '+2348012349100' };

/** A booking as the API returns it: nested contact, serviceName, staffName. */
const BOOKING = {
  id: 'bk_e2e',
  contactId: CONTACT.id,
  contact: CONTACT,
  serviceName: 'Biometrics capture',
  startTime: '2027-03-02T10:00:00.000Z',
  endTime: '2027-03-02T10:30:00.000Z',
  staffName: 'Desk 3',
  notes: null,
  status: 'CONFIRMED',
};

const RESERVATION = {
  id: 'rs_e2e',
  contactId: CONTACT.id,
  contact: CONTACT,
  partySize: 3,
  reservationTime: '2027-03-03T09:00:00.000Z',
  tableOrRoomNumber: 'Room 2',
  specialRequests: 'Wheelchair access',
  status: 'CONFIRMED',
};

type Sent = Record<string, any>;

async function openPage(
  page: Page,
  opts: { bookings?: any[]; reservations?: any[]; refunds?: any[]; failWith?: { status: number; message: string } } = {}
): Promise<Sent> {
  const { token, user } = await getAuth();
  const sent: Sent = {};

  await page.addInitScript(
    ([t, u]) => {
      window.localStorage.setItem('ace_token', t as string);
      window.localStorage.setItem('ace_user', JSON.stringify(u));
    },
    [token, user]
  );

  const json = (body: any, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

  await page.route('**/api/scheduling/bookings', r => {
    if (r.request().method() === 'POST') {
      sent.create = r.request().postDataJSON();
      if (opts.failWith) return r.fulfill(json({ message: opts.failWith.message }, opts.failWith.status));
      return r.fulfill(json({ ...BOOKING, id: 'bk_new' }, 201));
    }
    return r.fulfill(json(opts.bookings ?? [BOOKING]));
  });
  await page.route('**/api/scheduling/reservations', r => {
    if (r.request().method() === 'POST') {
      sent.createReservation = r.request().postDataJSON();
      return r.fulfill(json({ ...RESERVATION, id: 'rs_new' }, 201));
    }
    return r.fulfill(json(opts.reservations ?? [RESERVATION]));
  });
  await page.route('**/api/scheduling/refund-requests', r => r.fulfill(json(opts.refunds ?? [])));
  await page.route('**/api/crm/contacts**', r => r.fulfill(json({ data: [CONTACT] })));

  await page.route('**/api/scheduling/bookings/*/cancel', r => {
    sent.cancelBooking = r.request().postDataJSON() ?? {};
    if (opts.failWith) return r.fulfill(json({ message: opts.failWith.message }, opts.failWith.status));
    return r.fulfill(json({ ...BOOKING, status: 'CANCELLED' }));
  });
  await page.route('**/api/scheduling/bookings/*/reschedule', r => {
    sent.rescheduleBooking = r.request().postDataJSON();
    if (opts.failWith) return r.fulfill(json({ message: opts.failWith.message }, opts.failWith.status));
    return r.fulfill(json({ ...BOOKING, status: 'RESCHEDULED' }));
  });
  await page.route('**/api/scheduling/bookings/*/refund-request', r => {
    sent.refundBooking = r.request().postDataJSON();
    return r.fulfill(json({ ticketNumber: 'REF-BK-0001' }, 201));
  });
  await page.route('**/api/scheduling/bookings/*/status', r => {
    sent.statusBooking = r.request().postDataJSON();
    if (opts.failWith) return r.fulfill(json({ message: opts.failWith.message }, opts.failWith.status));
    return r.fulfill(json({ ...BOOKING, status: 'COMPLETED' }));
  });
  await page.route('**/api/scheduling/reservations/*/cancel', r => {
    sent.cancelReservation = r.request().postDataJSON() ?? {};
    return r.fulfill(json({ ...RESERVATION, status: 'CANCELLED' }));
  });
  await page.route('**/api/scheduling/reservations/*/reschedule', r => {
    sent.rescheduleReservation = r.request().postDataJSON();
    return r.fulfill(json({ ...RESERVATION, status: 'RESCHEDULED' }));
  });

  await page.goto('/scheduling');
  await expect(page.locator('h1').filter({ hasText: 'Appointments' })).toBeVisible({ timeout: 15000 });
  return sent;
}

/**
 * Open the detail panel for the fixture booking.
 *
 * By the row's accessible name, not `getByText('Biometrics capture')`: that
 * text matches both the cell and its row, and `.first()` then resolves to the
 * row element, whose click point can land outside any cell.
 */
const openBooking = async (page: Page) => {
  await page.getByRole('row', { name: /Biometrics capture/ }).getByText('Inspect Details').click();
  await expect(page.getByText('Booking Inspector')).toBeVisible();
};

test.describe('Scheduling — cancelling actually cancels', () => {
  test('sends a cancel request, and does not claim one without it', async ({ page }) => {
    const sent = await openPage(page);
    await openBooking(page);

    await page.getByRole('button', { name: 'Cancel Booking' }).click();
    await page.getByLabel(/^Reason/).fill('Citizen could not attend');

    // Nothing has been sent yet — the dialog is the confirmation step.
    expect(sent.cancelBooking).toBeUndefined();

    await page.getByRole('button', { name: /Cancel this booking/i }).click();

    // THE assertion: a request left the browser, carrying the reason.
    await expect.poll(() => sent.cancelBooking?.reason).toBe('Citizen could not attend');
  });

  test('says nothing was cancelled when the server refuses', async ({ page }) => {
    await openPage(page, { failWith: { status: 403, message: 'Your role cannot change appointments.' } });
    await openBooking(page);

    await page.getByRole('button', { name: 'Cancel Booking' }).click();
    await page.getByRole('button', { name: /Cancel this booking/i }).click();

    // The server's own words, not "Failed", and no success toast.
    await expect(page.getByText('Your role cannot change appointments.')).toBeVisible();
    await expect(page.getByText(/cancelled\./i)).toHaveCount(0);
  });
});

test.describe('Scheduling — rescheduling asks for a time', () => {
  test('sends the new time as an ISO instant', async ({ page }) => {
    const sent = await openPage(page);
    await openBooking(page);

    await page.getByRole('button', { name: 'Reschedule', exact: true }).click();

    // The old button claimed to have "sent a reschedule link" — neither a
    // reschedule nor a link. A new time is asked for, and pre-filled from the
    // appointment being moved.
    const field = page.getByLabel('New date & time');
    await expect(field).not.toHaveValue('');
    await field.fill('2027-03-05T14:30');
    await page.getByRole('button', { name: /Move it/i }).click();

    await expect.poll(() => sent.rescheduleBooking?.newStartTime).toBeTruthy();
    expect(new Date(sent.rescheduleBooking.newStartTime).toISOString()).toBe(sent.rescheduleBooking.newStartTime);
    expect(sent.rescheduleBooking.newStartTime).toContain('2027-03-05');
  });

  test('uses the reservation field name for a reservation', async ({ page }) => {
    const sent = await openPage(page);

    await page.getByRole('button', { name: /Reservations \(/ }).click();
    await page.getByRole('row', { name: /Room 2/ }).getByText('Inspect Details').click();
    await expect(page.getByText('Reservation Inspector')).toBeVisible();

    await page.getByRole('button', { name: 'Reschedule', exact: true }).click();
    await page.getByLabel('New date & time').fill('2027-03-06T11:00');
    await page.getByRole('button', { name: /Move it/i }).click();

    // `newReservationTime`, not `newStartTime` — two endpoints, two names.
    await expect.poll(() => sent.rescheduleReservation?.newReservationTime).toBeTruthy();
    expect(sent.rescheduleReservation.newStartTime).toBeUndefined();
  });
});

test.describe('Scheduling — a refund does two things', () => {
  test('states both of them before doing either, and requires a reason', async ({ page }) => {
    const sent = await openPage(page);
    await openBooking(page);

    await page.getByRole('button', { name: /Raise a refund request/i }).click();

    // The officer is cancelling the appointment as well as raising a ticket.
    await expect(page.getByText(/cancels the booking/i)).toBeVisible();
    await expect(page.getByText(/high-priority ticket/i)).toBeVisible();

    await page.getByRole('button', { name: /Raise the refund ticket/i }).click();
    await expect(page.getByText(/needs a reason/i)).toBeVisible();
    expect(sent.refundBooking).toBeUndefined();

    await page.getByLabel(/^Reason/).fill('Paid twice at the counter');
    await page.getByRole('button', { name: /Raise the refund ticket/i }).click();

    await expect.poll(() => sent.refundBooking?.reason).toBe('Paid twice at the counter');
  });

  test('shows the refund queue it files into', async ({ page }) => {
    await openPage(page, {
      refunds: [{ id: 't1', ticketNumber: 'REF-BK-0001', subject: 'Refund: Biometrics capture', contactName: 'Jane Citizen', status: 'OPEN', createdAt: '2027-01-01T09:00:00.000Z' }],
    });

    // The queue was fetched on every page load and rendered nowhere.
    await page.getByRole('button', { name: /Refunds \(1\)/ }).click();
    await expect(page.getByText('REF-BK-0001')).toBeVisible();
  });
});

test.describe('Scheduling — the list shows what the API returns', () => {
  test('renders the citizen, service and staff from the real field names', async ({ page }) => {
    await openPage(page);

    // The interfaces declared contactName/service/staff; the API returns
    // contact.fullName/serviceName/staffName, so every one of these cells was
    // blank.
    await expect(page.getByText('Jane Citizen').first()).toBeVisible();
    await expect(page.getByText('Biometrics capture').first()).toBeVisible();
    await expect(page.getByText('Desk 3').first()).toBeVisible();
  });

  test('offers no actions on a booking that is already closed', async ({ page }) => {
    await openPage(page, { bookings: [{ ...BOOKING, status: 'CANCELLED' }] });
    await openBooking(page);

    // A cancelled appointment cannot be cancelled again, and a button that
    // would 400 is worse than no button.
    await expect(page.getByRole('button', { name: 'Cancel Booking' })).toHaveCount(0);
    await expect(page.getByText(/nothing left to\s+change/i)).toBeVisible();
  });
});

test.describe('Scheduling — when the list cannot be loaded', () => {
  test('says so, instead of reporting an empty diary', async ({ page }) => {
    const { token, user } = await getAuth();
    await page.addInitScript(
      ([t, u]) => {
        window.localStorage.setItem('ace_token', t as string);
        window.localStorage.setItem('ace_user', JSON.stringify(u));
      },
      [token, user]
    );
    await page.route('**/api/scheduling/bookings', r =>
      r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'Database unavailable' }) })
    );
    await page.route('**/api/scheduling/reservations', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/scheduling/refund-requests', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/crm/contacts**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) }));

    await page.goto('/scheduling');
    await expect(page.locator('h1').filter({ hasText: 'Appointments' })).toBeVisible({ timeout: 15000 });

    // "No bookings recorded yet. Click Create Booking above to add one." is a
    // statement about the agency's diary, and nothing is known about it — an
    // officer reading that creates a booking that may already exist.
    await expect(page.getByText('Database unavailable')).toBeVisible();
    await expect(page.getByText(/No bookings recorded yet/i)).toHaveCount(0);
    // And the empty state does not contradict the banner above it.
    await expect(page.getByText(/not the same as having no bookings/i)).toBeVisible();
  });

  test('hides the refund queue from a role that cannot read it', async ({ page }) => {
    const { token, user } = await getAuth();
    await page.addInitScript(
      ([t, u]) => {
        window.localStorage.setItem('ace_token', t as string);
        window.localStorage.setItem('ace_user', JSON.stringify(u));
      },
      [token, user]
    );
    await page.route('**/api/scheduling/bookings', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/scheduling/reservations', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/crm/contacts**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) }));
    // The queue is OWNER/ADMIN; an AGENT gets a 403.
    await page.route('**/api/scheduling/refund-requests', r =>
      r.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ message: 'Forbidden' }) })
    );

    await page.goto('/scheduling');
    await expect(page.locator('h1').filter({ hasText: 'Appointments' })).toBeVisible({ timeout: 15000 });

    // A tab that answers 403 is not an error worth shouting about — it is a
    // tab that does not belong to this role.
    await expect(page.getByRole('button', { name: /Refunds \(/ })).toHaveCount(0);
    await expect(page.getByText(/Could not load/i)).toHaveCount(0);
  });
});

test.describe('Scheduling — creating one', () => {
  test('posts a contact id, not a typed name', async ({ page }) => {
    const sent = await openPage(page);

    await page.getByRole('button', { name: /Create Booking/i }).click();
    await page.getByLabel('Citizen').selectOption(CONTACT.id);
    await page.getByLabel('Date & Time').fill('2027-04-01T09:30');
    await page.getByRole('button', { name: /Confirm & Create Booking/i }).click();

    // `{contactName, service, staff}` was a 500 every time, silently.
    await expect.poll(() => sent.create?.contactId).toBe(CONTACT.id);
    expect(sent.create.serviceName).toBeTruthy();
    expect(sent.create.contactName).toBeUndefined();
    expect(sent.create.service).toBeUndefined();
  });

  test("shows the server's reason when the slot is taken", async ({ page }) => {
    await openPage(page, {
      failWith: { status: 409, message: 'That slot is already taken by Corporate Partnership Meeting. Please choose another time.' },
    });

    await page.getByRole('button', { name: /Create Booking/i }).click();
    await page.getByLabel('Citizen').selectOption(CONTACT.id);
    await page.getByLabel('Date & Time').fill('2027-04-01T09:30');
    await page.getByRole('button', { name: /Confirm & Create Booking/i }).click();

    // Which appointment holds the slot is the whole answer an officer needs.
    await expect(page.getByText(/already taken by Corporate Partnership Meeting/i)).toBeVisible();
  });
});
