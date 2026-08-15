/**
 * GateKipa demo seed — sets up the demo tenant whose widget is embedded on
 * https://gatekipa.com.
 *
 * Creates (idempotently, keyed on slug `gatekipa`):
 *   - the GateKipa organization with a grounded persona + welcome message
 *   - a dashboard owner login for the demo
 *   - FAQ entries answering the questions a gatekipa.com visitor actually asks
 *   - a live widget API key (printed ONCE, on creation only — it is stored
 *     as a SHA-256 hash and can never be recovered; re-running the seed
 *     mints a NEW key instead)
 *   - the ready-to-paste embed snippet for gatekipa.com
 *
 * Content policy: every product claim in the persona and FAQs is limited to
 * what GateKipa has publicly said about itself (subscription tracking, free
 * to use, Android app, built by Westgate Stratagem Limited, Jos). Nothing is
 * invented — the AI's persona prompt also forbids inventing prices/features.
 *
 * Usage:
 *   DATABASE_URL=... DIRECT_URL=... node prisma/seed-gatekipa.js
 * Optional env for the printed snippet:
 *   ACE_WEB_URL   e.g. https://ace-web.onrender.com   (serves widget.js)
 *   ACE_API_URL   e.g. https://ace-api.onrender.com   (the API base)
 */

const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

const DEMO_OWNER_EMAIL = 'demo@gatekipa.com';
const DEMO_OWNER_PASSWORD = 'GateKipa#Demo2026';

const FAQS = [
  {
    question: 'What is GateKipa?',
    answer:
      'GateKipa is a Nigerian fintech platform that helps individuals and businesses take control of recurring payments and subscription charges. It lets you see and track all your subscriptions from one app, so you stop paying for services you no longer use.',
    category: 'About',
    sortOrder: 1,
  },
  {
    question: 'How does GateKipa stop silent subscription deductions?',
    answer:
      'GateKipa gives you one view of all your active subscriptions, so recurring charges are never invisible. When you spot a service you no longer use, you can act on it before it keeps deducting — that "financial leakage" from forgotten subscriptions is exactly what GateKipa exists to end.',
    category: 'Product',
    sortOrder: 2,
  },
  {
    question: 'How much does GateKipa cost?',
    answer: 'GateKipa is free to use.',
    category: 'Pricing',
    sortOrder: 3,
  },
  {
    question: 'Where can I download the app?',
    answer:
      'GateKipa is available as a mobile app for Android. Visit gatekipa.com for the download link.',
    category: 'Product',
    sortOrder: 4,
  },
  {
    question: 'Who is behind GateKipa?',
    answer:
      'GateKipa was built by Westgate Stratagem Limited and launched in Jos, Plateau State, Nigeria.',
    category: 'About',
    sortOrder: 5,
  },
  {
    question: 'Can I speak to a human?',
    answer:
      'Of course — just say "I want to speak to a human agent" at any point and I will connect you with a member of the GateKipa team.',
    category: 'Support',
    sortOrder: 6,
  },
];

async function main() {
  console.log('🌱 Seeding the GateKipa demo tenant...\n');

  // ── 1. Organization ─────────────────────────────────────────────────────────
  let org = await prisma.organization.findFirst({ where: { slug: 'gatekipa' } });
  if (!org) {
    org = await prisma.organization.create({
      data: {
        name: 'GateKipa',
        slug: 'gatekipa',
        // IndustryType has no fintech value; OTHER is the honest fit.
        industry: 'OTHER',
        country: 'Nigeria',
        timezone: 'Africa/Lagos',
        welcomeMessage:
          'Hi! 👋 Welcome to GateKipa. I can answer your questions about tracking your subscriptions and stopping unwanted recurring charges. How can I help?',
        aiPersonaPrompt:
          'You are the AI customer assistant for GateKipa, a Nigerian fintech platform by Westgate Stratagem Limited that helps individuals and businesses track recurring payments and stop unwanted subscription deductions. Speak clear, friendly Nigerian English. Only state facts you have been given about GateKipa: it tracks all of a user\'s subscriptions in one app, it is free to use, and it is available for Android. NEVER invent prices, features, launch dates, or partnerships — if you do not know, say so and offer to connect the visitor with the GateKipa team.',
      },
    });
    console.log(`✅ Created organization: ${org.name} (${org.id})`);
  } else {
    console.log(`✅ Using existing organization: ${org.name} (${org.id})`);
  }

  // ── 2. Dashboard owner login ────────────────────────────────────────────────
  let owner = await prisma.user.findUnique({ where: { email: DEMO_OWNER_EMAIL } });
  if (!owner) {
    owner = await prisma.user.create({
      data: {
        organizationId: org.id,
        email: DEMO_OWNER_EMAIL,
        passwordHash: await bcrypt.hash(DEMO_OWNER_PASSWORD, 12),
        fullName: 'GateKipa Demo Owner',
        role: 'OWNER',
        isActive: true,
        // Pre-verified so the demo login works even when email delivery
        // (RESEND_API_KEY) is configured and verification is enforced.
        emailVerifiedAt: new Date(),
      },
    });
    console.log(`  + Owner login: ${DEMO_OWNER_EMAIL} / ${DEMO_OWNER_PASSWORD}`);
  } else {
    console.log(`  . Owner already exists: ${DEMO_OWNER_EMAIL}`);
  }

  // ── 3. FAQ knowledge ────────────────────────────────────────────────────────
  for (const faq of FAQS) {
    const existing = await prisma.faqEntry.findFirst({
      where: { organizationId: org.id, question: faq.question },
    });
    if (!existing) {
      await prisma.faqEntry.create({ data: { organizationId: org.id, ...faq } });
      console.log(`  + FAQ: ${faq.question}`);
    } else {
      console.log(`  . FAQ exists: ${faq.question}`);
    }
  }

  // ── 4. Widget API key ───────────────────────────────────────────────────────
  // Same format the dashboard mints (organizations.service.regenerateApiKey):
  // raw `ace_live_pk_<32 hex>`, stored as sha256, prefix kept for display.
  const KEY_NAME = 'gatekipa.com widget embed';
  const existingKey = await prisma.apiKey.findFirst({
    where: { organizationId: org.id, keyName: KEY_NAME },
  });

  let rawKey = null;
  if (!existingKey) {
    rawKey = `ace_live_pk_${crypto.randomBytes(16).toString('hex')}`;
    await prisma.apiKey.create({
      data: {
        organizationId: org.id,
        keyName: KEY_NAME,
        keyHash: crypto.createHash('sha256').update(rawKey).digest('hex'),
        keyPrefix: rawKey.slice(0, 16),
      },
    });
    console.log(`  + Widget API key minted (${rawKey.slice(0, 16)}…)`);
  } else {
    console.log(
      `  . Widget key already exists (${existingKey.keyPrefix}…). The raw key is only shown at creation — ` +
        'delete the ApiKey row and re-run this seed to mint a fresh one.'
    );
  }

  // ── 5. Embed snippet ────────────────────────────────────────────────────────
  const webUrl = (process.env.ACE_WEB_URL || 'https://<your-ace-dashboard-domain>').replace(/\/+$/, '');
  const apiUrl = (process.env.ACE_API_URL || 'https://<your-ace-api-domain>').replace(/\/+$/, '');

  console.log('\n────────────────────────────────────────────────────────────');
  console.log('Paste this before </body> on gatekipa.com:');
  console.log('────────────────────────────────────────────────────────────');
  console.log(`<script
  src="${webUrl}/widget.js"
  data-api-key="${rawKey || '<key shown when first minted>'}"
  data-api-url="${apiUrl}"
  async></script>`);
  console.log('────────────────────────────────────────────────────────────');
  if (rawKey) {
    console.log('⚠  The key above is shown ONCE. Store it now — only its hash is kept.');
  }
  console.log(`Dashboard login: ${DEMO_OWNER_EMAIL} (password printed on first run)`);
}

main()
  .catch((err) => {
    console.error('❌ GateKipa seed failed:', err.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
