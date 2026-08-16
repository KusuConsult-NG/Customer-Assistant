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

const WELCOME_MESSAGE =
  'Hi! 👋 Welcome to GateKipa. I can answer your questions about tracking your subscriptions and stopping unwanted recurring charges. How can I help?';

const PERSONA_PROMPT =
  'You are the AI customer assistant for GateKipa, a Nigerian fintech platform by Westgate Stratagem Limited (founder: Eric Martyns, launched in Jos, Plateau State) that helps individuals and businesses stop unwanted subscription deductions. Speak clear, friendly Nigerian English. Only state facts you have been given about GateKipa: users track all their subscriptions in one app; each subscription gets its own separate virtual card instead of one card used everywhere; users define payment rules upfront and transactions outside those conditions are automatically blocked; controls include time-based restrictions and geographic limits on where payments can originate; businesses can manage subscriptions across teams, vendors, and operational expenses; it is free to use; it is available for Android. NEVER invent prices, features, launch dates, or partnerships — if you do not know, say so and offer to connect the visitor with the GateKipa team.';

const FAQS = [
  {
    question: 'What is GateKipa?',
    answer:
      'GateKipa is a Nigerian fintech platform that helps individuals and businesses take control of recurring payments and subscription charges. You track all your subscriptions from one app and pay each one with its own virtual card under rules you define — so you stop paying for services you no longer use.',
    category: 'About',
    sortOrder: 1,
  },
  {
    question: 'How does GateKipa stop silent subscription deductions?',
    answer:
      'Instead of using one card everywhere, you create a separate virtual card for each subscription and define the rules upfront — payments only go through when they meet your conditions, and any transaction outside them is automatically blocked before it happens. You can also add time-based restrictions (limit transactions to certain hours) and geographic controls on where payments can originate.',
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
    question: 'Does GateKipa work for businesses?',
    answer:
      'Yes — GateKipa gives businesses tools to manage subscriptions across teams, vendors, and operational expenses, cutting the inefficiencies of untracked corporate spending.',
    category: 'Product',
    sortOrder: 5,
  },
  {
    question: 'Who is behind GateKipa?',
    answer:
      'GateKipa was built by Westgate Stratagem Limited, founded by Eric Martyns, and launched at the A+ MSME Hub in Jos, Plateau State, Nigeria.',
    category: 'About',
    sortOrder: 6,
  },
  {
    question: 'Can I speak to a human?',
    answer:
      'Of course — just say "I want to speak to a human agent" at any point and I will connect you with a member of the GateKipa team.',
    category: 'Support',
    sortOrder: 7,
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
        welcomeMessage: WELCOME_MESSAGE,
        aiPersonaPrompt: PERSONA_PROMPT,
      },
    });
    console.log(`✅ Created organization: ${org.name} (${org.id})`);
  } else {
    // The persona and welcome message follow this file on re-runs so fact
    // corrections here actually land. Trade-off, stated plainly: dashboard
    // edits to these two fields are overwritten by re-running this seed.
    if (org.aiPersonaPrompt !== PERSONA_PROMPT || org.welcomeMessage !== WELCOME_MESSAGE) {
      org = await prisma.organization.update({
        where: { id: org.id },
        data: { aiPersonaPrompt: PERSONA_PROMPT, welcomeMessage: WELCOME_MESSAGE },
      });
      console.log(`✅ Updated organization persona/welcome: ${org.name} (${org.id})`);
    } else {
      console.log(`✅ Using existing organization: ${org.name} (${org.id})`);
    }
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
    } else if (
      existing.answer !== faq.answer ||
      existing.category !== faq.category ||
      existing.sortOrder !== faq.sortOrder
    ) {
      // Keep re-runs in sync with this file — an answer corrected here must
      // reach a database that was seeded from an older version.
      await prisma.faqEntry.update({
        where: { id: existing.id },
        data: { answer: faq.answer, category: faq.category, sortOrder: faq.sortOrder },
      });
      console.log(`  ~ FAQ updated: ${faq.question}`);
    } else {
      console.log(`  . FAQ exists: ${faq.question}`);
    }
  }

  // ── 3b. Voice and WhatsApp channels ─────────────────────────────────────────
  //
  // Created ONLY when real credentials are present. A config row is what makes
  // the dashboard show a channel as connected and what the webhook handlers
  // resolve a tenant from — writing one with placeholder values would light up
  // "Voice: connected" for a number that rings nowhere, which is the failure
  // this codebase exists to not repeat. No credentials means no row, and the
  // channel honestly reports itself as unconfigured.

  // Voice. TWILIO_PHONE_NUMBER is the number customers dial.
  // GATEKIPA_FORWARDING_NUMBER is where "let me speak to a human" transfers
  // the live call — without it the AI does not claim a transfer, it files a
  // ticket and says someone will call back.
  const twilioSid = process.env.TWILIO_ACCOUNT_SID;
  const twilioToken = process.env.TWILIO_AUTH_TOKEN;
  const twilioNumber = process.env.TWILIO_PHONE_NUMBER;
  const forwardingNumber = process.env.GATEKIPA_FORWARDING_NUMBER || null;

  if (twilioSid && twilioToken && twilioNumber) {
    const existing = await prisma.telephonyConfig.findFirst({
      where: { organizationId: org.id, phoneNumber: twilioNumber },
    });
    if (existing) {
      await prisma.telephonyConfig.update({
        where: { id: existing.id },
        data: { accountSid: twilioSid, authToken: twilioToken, forwardingNumber },
      });
      console.log(`  ~ Voice updated: ${twilioNumber}${forwardingNumber ? ` → human on ${forwardingNumber}` : ''}`);
    } else {
      await prisma.telephonyConfig.create({
        data: {
          organizationId: org.id,
          provider: 'TWILIO',
          accountSid: twilioSid,
          authToken: twilioToken,
          phoneNumber: twilioNumber,
          forwardingNumber,
          isDefault: true,
        },
      });
      console.log(`  + Voice connected: ${twilioNumber}${forwardingNumber ? ` → human on ${forwardingNumber}` : ''}`);
    }
    if (!forwardingNumber) {
      console.log('    ⚠ No GATEKIPA_FORWARDING_NUMBER — a caller asking for a human gets a ticket and a callback promise, not a transfer.');
    }
  } else {
    console.log('  . Voice not configured (needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER)');
  }

  // WhatsApp. The verify token must match what is entered in the Meta
  // Developer Console, and the app secret the API validates signatures with
  // is WHATSAPP_APP_SECRET in the API's own environment, not stored here.
  const waPhoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const waToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const waBusinessId = process.env.WHATSAPP_BUSINESS_ID;
  const waDisplay = process.env.WHATSAPP_DISPLAY_NUMBER || twilioNumber || '';
  const waVerify = process.env.WHATSAPP_VERIFY_TOKEN;

  if (waPhoneId && waToken && waBusinessId && waVerify) {
    const existing = await prisma.whatsAppConfig.findFirst({
      where: { organizationId: org.id, phoneNumberId: waPhoneId },
    });
    const data = {
      accessToken: waToken,
      whatsappBusinessId: waBusinessId,
      displayPhoneNumber: waDisplay,
      webhookVerifyToken: waVerify,
      isActive: true,
    };
    if (existing) {
      await prisma.whatsAppConfig.update({ where: { id: existing.id }, data });
      console.log(`  ~ WhatsApp updated: phone_number_id ${waPhoneId}`);
    } else {
      await prisma.whatsAppConfig.create({
        data: { organizationId: org.id, phoneNumberId: waPhoneId, ...data },
      });
      console.log(`  + WhatsApp connected: phone_number_id ${waPhoneId}`);
    }
  } else {
    console.log('  . WhatsApp not configured (needs WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN, WHATSAPP_BUSINESS_ID, WHATSAPP_VERIFY_TOKEN)');
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

  // ── 6. The webhook URLs the providers need ──────────────────────────────────
  // A config row alone routes nothing: the provider has to be told where to
  // send traffic. These are the exact values to paste into each console.
  console.log('\n────────────────────────────────────────────────────────────');
  console.log('Provider webhooks — set these in each console:');
  console.log('────────────────────────────────────────────────────────────');
  if (twilioSid && twilioToken && twilioNumber) {
    console.log(`Twilio → Phone Numbers → ${twilioNumber} → "A call comes in":`);
    console.log(`  ${apiUrl}/api/telephony/inbound/twilio    (HTTP POST)`);
    console.log(`Twilio → same number → "Call status changes":`);
    console.log(`  ${apiUrl}/api/telephony/status/twilio     (HTTP POST)`);
  } else {
    console.log('Twilio: skipped — voice is not configured.');
  }
  if (waPhoneId && waToken && waBusinessId && waVerify) {
    console.log(`Meta → WhatsApp → Configuration → Callback URL:`);
    console.log(`  ${apiUrl}/api/whatsapp/webhook`);
    console.log(`  Verify token: the value of WHATSAPP_VERIFY_TOKEN (it must match exactly)`);
    console.log(`  Subscribe to the "messages" field.`);
  } else {
    console.log('Meta WhatsApp: skipped — WhatsApp is not configured.');
  }
  console.log('\nThe API must be publicly reachable at the URL above — a provider');
  console.log('cannot reach localhost. Set ACE_API_URL to the deployed API.');
}

main()
  .catch((err) => {
    console.error('❌ GateKipa seed failed:', err.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
