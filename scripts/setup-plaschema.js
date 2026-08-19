#!/usr/bin/env node
/**
 * PLASCHEMA Setup Script
 *
 * This script:
 * 1. Updates the organization name, persona, and greeting for PLASCHEMA
 * 2. Seeds the FaqEntry table with PLASCHEMA-specific Q&As
 * 3. Loads all 5 knowledge base .md files as KnowledgeDocument records
 * 4. Syncs the updated ElevenLabs agent (persona = Sarah)
 */

const path = require('path');
require(path.join(__dirname, '..', 'apps', 'api', 'dist', 'config', 'load-env.js'));

const { PrismaClient } = require('@prisma/client');
const fs   = require('fs');

const prisma = new PrismaClient();
const KB_DIR = path.join(__dirname, 'plaschema-knowledge-base');

// ── PLASCHEMA system prompt ────────────────────────────────────────────────────
const PERSONA_PROMPT = `You are a dedicated and knowledgeable Enrollee Services Officer at PLASCHEMA — the Plateau State Contributory Healthcare Management Agency. You work on the PLASCHEMA Helpline (0700-700-1111) to assist enrollees, prospective enrollees, and healthcare providers.

Your responsibilities:
- Explain PLASCHEMA health plans: Formal Sector, Informal Sector, BHCPF, and Equity Program
- Help enrollees verify enrollment status and understand their benefits
- Guide people on how to enroll and make premium payments (Informal: ₦12,000/person or ₦50,000/family per year)
- Provide information on accredited healthcare facilities across all 17 LGAs of Plateau State
- Explain the referral process and emergency access rules
- Take complaints about facility refusals, drug stockouts, or illegal out-of-pocket demands
- Explain maternal and child health services, drug/medicine coverage, and emergency care access
- Direct urgent complaints to the PLASCHEMA quality control desk

Key contacts to share when relevant:
- PLASCHEMA Toll-free: 0700-700-1111 (24/7)
- Email: info@plaschema.pl.gov.ng
- Website: https://plaschema.pl.gov.ng
- Enrollment Portal: https://enrollments.plaschema.app
- Informal Sector Payment: https://enrollments.plaschema.app/pay/informal

Speak warmly, clearly, and patiently — like an experienced human government helpline officer who genuinely cares about the health of Plateau State citizens. Use simple, easy-to-understand English. Be empathetic, especially with sick patients or callers reporting hospital mistreatment. Never mention that you are an AI or a virtual system.`;

const WELCOME_MESSAGE = `Hello! Welcome to the PLASCHEMA Helpline — Plateau State Contributory Healthcare Management Agency. My name is {name}, how can I assist you with your health coverage today?`;

// ── PLASCHEMA FAQs ─────────────────────────────────────────────────────────────
const FAQS = [
  { q: 'What is PLASCHEMA?', a: 'PLASCHEMA stands for the Plateau State Contributory Healthcare Management Agency. It is the government agency that provides affordable and accessible health insurance coverage to all residents of Plateau State, Nigeria.', cat: 'General' },
  { q: 'Who can enroll in PLASCHEMA?', a: 'Any resident of Plateau State can enroll. There are plans for formal sector employees, informal sector workers (traders, artisans, farmers), vulnerable populations (BHCPF), the poorest households (Equity Program), and tertiary students (TISHIP).', cat: 'Enrollment' },
  { q: 'How do I enroll in PLASCHEMA?', a: 'To enroll: (1) Choose your plan — Formal, Informal, BHCPF, or Equity. (2) Fill the enrollment form online at https://enrollments.plaschema.app or visit any PLASCHEMA office. (3) Submit your documents: passport photo, valid ID, NIN, and birth certificates for children. (4) Pay your premium where applicable. (5) Complete biometric capture. (6) Receive your PLASCHEMA ID card and choose your Primary Healthcare Facility.', cat: 'Enrollment' },
  { q: 'How much does the informal sector plan cost?', a: 'The Informal Sector Plan costs ₦12,000 per individual per year or ₦50,000 per family of 6 per year (principal + spouse + up to 4 biological children under 18). Pay online at https://enrollments.plaschema.app/pay/informal.', cat: 'Payment' },
  { q: 'How do formal sector employees contribute?', a: 'Formal sector employees contribute 1.75% of their basic salary monthly, while their employer contributes 3.25% — totalling 5% of the basic salary. Contributions are deducted automatically from your payroll.', cat: 'Payment' },
  { q: 'What services does PLASCHEMA cover?', a: 'PLASCHEMA covers: outpatient consultations and treatment, inpatient hospital admissions, maternal health (antenatal, delivery, postnatal), child immunisations, essential medicines, diagnostic services (lab tests, X-rays, ultrasounds), emergency care at any accredited facility, and referrals to secondary and tertiary hospitals.', cat: 'Benefits' },
  { q: 'Does PLASCHEMA cover medications and drugs?', a: 'Yes. Essential and prescribed medicines are covered. For Formal and Informal Sector enrollees, drugs are dispensed at no cost at the hospital pharmacy. If the hospital pharmacy is out of stock, take your prescription and a copy of your PLASCHEMA ID to any accredited pharmacy. For BHCPF and Equity enrollees, only essential medicines on the approved formulary are covered. Where cost-sharing applies, enrollees pay only 10% of the drug cost.', cat: 'Benefits' },
  { q: 'Is emergency care covered?', a: 'Yes. In a genuine emergency, you can go directly to ANY PLASCHEMA-accredited hospital — you do NOT need a referral letter. Always present your PLASCHEMA ID card.', cat: 'Benefits' },
  { q: 'Does PLASCHEMA cover maternity and childbirth?', a: 'Yes. Antenatal care, normal delivery, caesarean section (where medically required), and postnatal care are all covered for enrolled mothers.', cat: 'Benefits' },
  { q: 'How do I find an accredited hospital near me?', a: 'Visit https://plaschema.pl.gov.ng/providers and filter by your Local Government Area (LGA) and facility type. You can also call 0700-700-1111 and a desk officer will help you locate the nearest accredited facility.', cat: 'Facilities' },
  { q: 'The hospital is demanding payment even though I have a PLASCHEMA card. What do I do?', a: 'This is a violation of your rights as a PLASCHEMA enrollee. Do not pay. Call 0700-700-1111 immediately. Note the facility name, location, staff name if possible, date and time, and the amount demanded. Email the details to info@plaschema.pl.gov.ng. This will be escalated to the Director of Health Services, Standards and Quality Control.', cat: 'Complaints' },
  { q: 'The hospital says the drugs are out of stock. What do I do?', a: 'Ask your doctor for a written prescription. Take the prescription plus a photocopy of your PLASCHEMA ID card to any PLASCHEMA-accredited pharmacy nearby to get your medicines. Also call 0700-700-1111 to report the stockout so PLASCHEMA can follow up with the facility.', cat: 'Complaints' },
  { q: 'How do I file a complaint with PLASCHEMA?', a: 'To file a complaint: Call 0700-700-1111 (available 24/7), email info@plaschema.pl.gov.ng or support@plaschema.pl.gov.ng, or visit PLASCHEMA headquarters in Jos, Plateau State. Have ready: your PLASCHEMA ID, the facility name and location, date of incident, and a clear description of what happened.', cat: 'Complaints' },
  { q: 'Can I go to any hospital, or must I use a specific one?', a: 'You must access care through your registered Primary Healthcare Facility (PHCP) first. Your PHCP doctor will issue a referral to a secondary or tertiary hospital if needed. Exception: In an emergency, go directly to the nearest PLASCHEMA-accredited hospital — no referral is needed.', cat: 'Facilities' },
  { q: 'How do I verify my PLASCHEMA enrollment status?', a: 'You can verify your enrollment by calling 0700-700-1111, checking the PLASCHEMABeneficiary+ portal at https://plaschema.pl.gov.ng, or visiting any PLASCHEMA office.', cat: 'Enrollment' },
  { q: 'I lost my PLASCHEMA ID card. What do I do?', a: 'Call 0700-700-1111 or visit any PLASCHEMA office with your identification documents (valid ID and NIN) to request a replacement ID card.', cat: 'Enrollment' },
  { q: 'What are the PLASCHEMA contact details?', a: 'PLASCHEMA contact details: Toll-free phone (24/7): 0700-700-1111, Email: info@plaschema.pl.gov.ng, Website: https://plaschema.pl.gov.ng, Enrollment portal: https://enrollments.plaschema.app, Address: Jos, Plateau State, Nigeria. Office hours: Monday to Friday, 8:00 AM – 4:00 PM.', cat: 'General' },
  { q: 'What is the Equity Program?', a: 'The Equity Program is a free healthcare plan funded by the Plateau State Government for the poorest and most vulnerable residents: pregnant women from the poorest households, children under 5 years, elderly persons above 65, and persons with disabilities. Eligibility is determined through government community targeting.', cat: 'Benefits' },
  { q: 'What is BHCPF?', a: 'BHCPF stands for Basic Healthcare Provision Fund. It is a free plan for vulnerable populations who cannot afford regular premiums. It covers basic outpatient services, essential medicines, maternal and child health, and referrals. Access is through designated Primary Healthcare Centres across all 17 LGAs.', cat: 'Benefits' },
  { q: 'How many healthcare facilities does PLASCHEMA have?', a: 'PLASCHEMA has over 400 accredited healthcare facilities across all 17 Local Government Areas of Plateau State, including hospitals, clinics, pharmacies, laboratories, and diagnostic centres.', cat: 'Facilities' },
];

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🏥  PLASCHEMA Setup — Starting...\n');

  // 1. Find the organization ──────────────────────────────────────────────────
  let org = await prisma.organization.findFirst({
    where: { OR: [{ slug: 'ace-demo' }, { slug: 'plaschema' }, { name: 'Kusu Consult' }, { name: 'PLASCHEMA' }] },
  });

  if (!org) {
    console.error('❌  No organization found. Run `npm run db:seed` first.');
    process.exit(1);
  }

  // 2. Update organization identity ──────────────────────────────────────────
  console.log(`📝  Step 1: Updating organization "${org.name}" → PLASCHEMA...`);
  org = await prisma.organization.update({
    where: { id: org.id },
    data: {
      name: 'PLASCHEMA',
      slug: 'plaschema',
      aiPersonaPrompt: PERSONA_PROMPT,
      welcomeMessage: WELCOME_MESSAGE,
      timezone: 'Africa/Lagos',
    },
  });
  console.log('✅  Organization updated.\n');

  // 3. Seed FAQ entries ──────────────────────────────────────────────────────
  console.log(`📝  Step 2: Seeding ${FAQS.length} PLASCHEMA FAQ entries...`);
  // Clear old FAQs for this org first to avoid duplicates on re-run
  await prisma.faqEntry.deleteMany({ where: { organizationId: org.id } });

  for (let i = 0; i < FAQS.length; i++) {
    const { q, a, cat } = FAQS[i];
    await prisma.faqEntry.create({
      data: {
        organizationId: org.id,
        question: q,
        answer: a,
        category: cat,
        isActive: true,
        sortOrder: i,
      },
    });
  }
  console.log(`✅  ${FAQS.length} FAQ entries seeded.\n`);

  // 4. Upload knowledge base documents ───────────────────────────────────────
  console.log('📚  Step 3: Loading knowledge base documents...');
  const kbFiles = fs.readdirSync(KB_DIR).filter(f => f.endsWith('.md')).sort();

  for (const file of kbFiles) {
    const content = fs.readFileSync(path.join(KB_DIR, file), 'utf8');
    const title   = file
      .replace(/^\d+-/, '')
      .replace(/-/g, ' ')
      .replace('.md', '')
      .replace(/\b\w/g, c => c.toUpperCase());

    const existing = await prisma.knowledgeDocument.findFirst({
      where: { organizationId: org.id, title },
    });

    if (existing) {
      await prisma.knowledgeDocument.update({
        where: { id: existing.id },
        data: { updatedAt: new Date() },
      });
      // Also upsert the main content chunk
      await prisma.documentChunk.deleteMany({ where: { documentId: existing.id } });
      await prisma.documentChunk.create({
        data: {
          documentId:     existing.id,
          organizationId: org.id,
          chunkIndex:     0,
          content,
        },
      });
      console.log(`  🔄  Updated: "${title}"`);
    } else {
      const doc = await prisma.knowledgeDocument.create({
        data: {
          organizationId: org.id,
          title,
          fileName:  file,
          fileSize:  Buffer.byteLength(content, 'utf8'),
          mimeType:  'text/markdown',
          storageUrl: `local://plaschema-knowledge-base/${file}`,
          status:    'INDEXED',
          chunkCount: 1,
        },
      });
      await prisma.documentChunk.create({
        data: {
          documentId:     doc.id,
          organizationId: org.id,
          chunkIndex:     0,
          content,
        },
      });
      console.log(`  ✅  Created: "${title}"`);
    }
  }
  console.log(`✅  ${kbFiles.length} knowledge base documents loaded.\n`);

  // 5. Sync ElevenLabs agent ─────────────────────────────────────────────────
  console.log('🤖  Step 4: Syncing PLASCHEMA agent to ElevenLabs (Sarah voice)...');
  process.env.ELEVENLABS_PERSONA = 'sarah';

  const { ElevenLabsAgentService } = require('../apps/api/dist/agent-tools/elevenlabs-agent.service');
  const { ElevenLabsApi }          = require('../apps/api/dist/agent-tools/elevenlabs-client');
  const service = new ElevenLabsAgentService(new ElevenLabsApi());
  const result  = await service.syncAgent(org.id);

  console.log(`✅  ElevenLabs agent synced: ${result.agentId}  (${Object.keys(result.toolIds).length} tools)\n`);

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  🎉  PLASCHEMA Setup Complete!');
  console.log('');
  console.log('  Organization : PLASCHEMA (Plateau State Contributory HMA)');
  console.log('  Voice Agent  : Sarah — PLASCHEMA Helpline Officer');
  console.log('  FAQs loaded  : ' + FAQS.length);
  console.log('  KB Documents : ' + kbFiles.length);
  console.log('  ElevenLabs   : agent_3801m0c9terzf58tskm00cp3d008');
  console.log('');
  console.log('  Login → http://localhost:3000');
  console.log('  Email  : admin@acedemo.com');
  console.log('  Password: Admin@2030!');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

main()
  .catch(err => { console.error('❌  Setup failed:', err.message || err); process.exit(1); })
  .finally(() => prisma.$disconnect());
