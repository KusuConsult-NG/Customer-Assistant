import { test, expect, Page } from '@playwright/test';

/**
 * Knowledge → the two controls that had no UI.
 *
 * `POST /api/knowledge/reindex` and `PATCH /api/knowledge/faqs/reorder` both
 * shipped with the knowledge module and neither was reachable from a screen.
 * The API suite covers what they do; what a browser adds is whether an
 * operator can tell what they are FOR.
 *
 * Reordering especially. `sortOrder` decides which answer a citizen gets when
 * two FAQs match their question equally well, and a list of up/down arrows
 * with no explanation looks like cosmetic tidying. If the page does not say
 * that order decides ties, the control is there and the reason is not.
 *
 * Responses are intercepted: these assertions are about the rendering and the
 * request that goes out, and the real endpoints need Qdrant and an embedding
 * key to say anything other than "unavailable".
 */

const API_URL = process.env.PLAYWRIGHT_API_URL || 'http://localhost:4000';

let cachedAuth: Promise<{ token: string; user: any }> | null = null;
function getAuth() {
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

const FAQS = [
  { id: 'faq-a', question: 'What are the opening hours on a public holiday?', answer: 'Closed.', category: 'Hours', sortOrder: 0 },
  { id: 'faq-b', question: 'What are the opening hours?', answer: '8am to 6pm.', category: 'Hours', sortOrder: 1 },
  { id: 'faq-c', question: 'Where is the office?', answer: 'Jos North.', category: 'Location', sortOrder: 2 },
];

type Sent = { reorder?: string[]; reindexed?: boolean };

async function openKnowledge(
  page: Page,
  opts: { faqs?: any[]; reindex?: { status: number; body: any } } = {}
): Promise<Sent> {
  const { token, user } = await getAuth();
  const sent: Sent = {};
  let faqs = opts.faqs ?? FAQS;

  await page.addInitScript(
    ([t, u]) => {
      window.localStorage.setItem('ace_token', t as string);
      window.localStorage.setItem('ace_user', JSON.stringify(u));
    },
    [token, user]
  );

  const json = (body: any, status = 200) => ({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });

  // Documents are not the subject here; an empty list keeps the tab quiet.
  await page.route('**/api/knowledge/documents', (r) => r.fulfill(json([])));

  await page.route('**/api/knowledge/faqs/reorder', (r) => {
    const ids: string[] = r.request().postDataJSON().ids;
    sent.reorder = ids;
    // Apply it, so the refetch that follows returns the new order rather than
    // snapping the list back and making the test pass for the wrong reason.
    faqs = ids.map((id, i) => ({ ...faqs.find((f) => f.id === id)!, sortOrder: i }));
    return r.fulfill(json({ success: true, ordered: ids.length }));
  });

  await page.route('**/api/knowledge/faqs', (r) => r.fulfill(json(faqs)));

  await page.route('**/api/knowledge/reindex', (r) => {
    sent.reindexed = true;
    const o = opts.reindex ?? {
      status: 200,
      body: {
        totalDocs: 4,
        totalChunks: 128,
        vectorised: true,
        message: 'Successfully vectorised 128 chunks from 4 documents into Qdrant.',
      },
    };
    return r.fulfill(json(o.body, o.status));
  });

  await page.goto('/knowledge');
  await expect(page.getByRole('button', { name: /Rebuild search index/i })).toBeVisible({ timeout: 15000 });
  return sent;
}

const faqTab = (page: Page) => page.getByRole('button', { name: /Custom FAQ Rules/ });

test.describe('Knowledge — rebuilding the search index', () => {
  test('says why anyone would rebuild it', async ({ page }) => {
    await openKnowledge(page);

    // Without this, "Rebuild search index" is a button with no occasion.
    await expect(
      page.getByText(/document stored while the vector index was unreachable/i)
    ).toBeVisible();
  });

  test('reports the server’s own counts rather than a bare success', async ({ page }) => {
    const sent = await openKnowledge(page);

    await page.getByRole('button', { name: /Rebuild search index/i }).click();

    await expect.poll(() => sent.reindexed).toBe(true);
    await expect(page.getByText(/128 chunks from 4 documents/)).toBeVisible();
  });

  test('shows a failure as a failure, with what to check', async ({ page }) => {
    await openKnowledge(page, {
      reindex: {
        status: 503,
        body: {
          message:
            'Re-indexing failed: connect ECONNREFUSED. Ensure OPENAI_API_KEY has active credits and Qdrant is running at http://localhost:6333.',
        },
      },
    });

    await page.getByRole('button', { name: /Rebuild search index/i }).click();

    // Verbatim: the URL it actually tried is the part an operator acts on.
    await expect(page.getByText(/Qdrant is running at http:\/\/localhost:6333/)).toBeVisible();
  });

  test('does not call an empty index a success', async ({ page }) => {
    await openKnowledge(page, {
      reindex: {
        status: 200,
        body: { totalDocs: 0, totalChunks: 0, vectorised: false, message: 'No chunks found to index.' },
      },
    });

    await page.getByRole('button', { name: /Rebuild search index/i }).click();

    // Nothing was indexed, so a green tick would say the opposite of the truth.
    await expect(page.getByText('No chunks found to index.')).toBeVisible();
    await expect(page.locator('.text-emerald-700, .dark\\:text-emerald-300').filter({ hasText: 'No chunks found' })).toHaveCount(0);
  });
});

test.describe('Knowledge — FAQ order', () => {
  test('says that order decides which answer a citizen gets', async ({ page }) => {
    await openKnowledge(page);
    await faqTab(page).click();

    // The whole reason the control exists. A list of arrows without this reads
    // as cosmetic tidying.
    await expect(page.getByText(/Order decides ties/i)).toBeVisible();
    await expect(page.getByText(/whichever is higher in this list/i)).toBeVisible();
  });

  test('sends the whole list in the new order', async ({ page }) => {
    const sent = await openKnowledge(page);
    await faqTab(page).click();

    await page.getByRole('button', { name: 'Move "Where is the office?" up' }).click();

    // The API refuses a partial order, because sortOrder is a position and a
    // subset leaves two entries in the same place.
    await expect.poll(() => sent.reorder).toEqual(['faq-a', 'faq-c', 'faq-b']);
  });

  test('shows the new position after the move', async ({ page }) => {
    await openKnowledge(page);
    await faqTab(page).click();

    await page.getByRole('button', { name: 'Move "Where is the office?" up' }).click();

    // Position 2 of 3 now, where it was 3.
    const moved = page.locator('div').filter({ hasText: 'Q: Where is the office?' }).last();
    await expect(moved).toContainText('2');
  });

  test('offers no move beyond the ends of the list', async ({ page }) => {
    await openKnowledge(page);
    await faqTab(page).click();

    await expect(
      page.getByRole('button', { name: 'Move "What are the opening hours on a public holiday?" up' })
    ).toBeDisabled();
    await expect(
      page.getByRole('button', { name: 'Move "Where is the office?" down' })
    ).toBeDisabled();
  });

  test('says nothing about order when there is only one FAQ to order', async ({ page }) => {
    await openKnowledge(page, { faqs: [FAQS[0]] });
    await faqTab(page).click();

    // One entry cannot tie with anything, so the explanation would be noise.
    await expect(page.getByText(/Order decides ties/i)).toHaveCount(0);
  });
});
