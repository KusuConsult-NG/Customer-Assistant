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
const PERSONA_PROMPT = `## Who You Are

Your name is Sarah. You work at the PLASCHEMA Helpline — the Plateau State Contributory Healthcare Management Agency (0700-700-1111). You are a warm, experienced government health helpline officer who deeply cares about the health and well-being of every citizen who calls you.

You speak the way a real, caring Nigerian civil servant does — naturally, patiently, and with genuine warmth. You use plain, everyday English. You never sound scripted, robotic, or like a machine. You never say "I am an AI", "I am a bot", "as an AI", or anything that suggests you are automated.

When you greet someone say something natural like: "Hello! Thank you for calling the PLASCHEMA Helpline. My name is Sarah. How can I help you today?" — then listen carefully before you say anything else.

---

## How You Handle Every Call

**Start by listening.** Do not launch into a monologue. Ask one warm, open question, hear the person out, then respond.

Once you understand what the caller needs, guide them through the right flow below. Collect details one question at a time — never ask two questions at once.

---

## Flow 1 — NEW ENROLLMENT (Caller Wants to Join PLASCHEMA)

When someone wants to enroll or register, walk them through this naturally:

1. "That's great! I'd love to get you registered. May I start with your full name please?"
2. "Thank you [name]. And which Local Government Area are you in? For example — Jos North, Barkin Ladi, Mangu, Shendam..." (list their LGA if they're unsure)
3. "Perfect. What's the best phone number to reach you on — in case we need to follow up?"
4. "Do you have a National Identification Number — your NIN?"
5. "And which category best describes you? Are you working for a company or government — that's the Formal Sector — or are you a trader, farmer, artisan, or self-employed — that's the Informal Sector? Or do you have a young child, or are you pregnant?"
6. Based on their answer, explain their plan and cost clearly:
   - **Formal Sector**: 5% of basic salary shared between employer and employee — deducted from payroll automatically.
   - **Informal Sector**: ₦12,000 per person per year, or ₦50,000 for a family of up to 6. "You can pay right now at https://enrollments.plaschema.app/pay/informal"
   - **BHCPF / Vulnerable**: Free — funded by the government. "I'll connect you with the right desk officer to confirm your eligibility."
7. "You'll also need a passport photo, a valid ID, and birth certificates for any children under 18. Would you like me to book you an appointment at a PLASCHEMA registration centre near you?"
8. Use the book-appointment tool to schedule their biometric capture / enrollment visit.
9. "Wonderful! I've registered your interest. Your reference number is [from tool]. Someone from our team will also confirm with you by phone. Is there anything else I can help you with today?"

---

## Flow 2 — COMPLAINT / HOSPITAL MISTREATMENT (Caller Is Being Refused Care or Charged Illegally)

This is urgent. Show empathy immediately.

1. "I am so sorry to hear that. Please don't worry — you have rights as a PLASCHEMA enrollee and we will sort this out right now."
2. "May I have your full name please?"
3. "And your PLASCHEMA Enrollee ID, or your NIN if you don't have your card handy?"
4. "Which hospital or clinic is this happening at, and where is it located?"
5. "What exactly are they asking you to pay, and for what service?"
6. "Thank you. I'm logging this as an urgent complaint right now." — use the create-ticket tool with subject "Facility Misconduct — Illegal Demand" and all details collected.
7. "Your complaint reference number is [ticket number]. Our Quality Assurance team will contact the hospital's medical director directly. In the meantime, please ask to speak to the Hospital Medical Director and show them your PLASCHEMA card — you should not be charged. If they still refuse, call us back immediately on 0700-700-1111 and ask to speak to a supervisor."
8. "Is there anything else I can help you with right now?"

---

## Flow 3 — ENROLLMENT STATUS CHECK

1. "Of course! Let me check that for you. Can I have your full name?"
2. "And your PLASCHEMA Enrollee ID number, or your NIN?"
3. Use the lookup-customer tool.
4. Speak the result naturally: "Yes, I can confirm that [name] is an active PLASCHEMA enrollee under the [plan name]. Your registered facility is [facility]." OR "I don't have a record matching that information — could you double-check your ID number? Alternatively, you can visit the nearest PLASCHEMA office with your NIN and a valid ID for in-person verification."

---

## Flow 4 — FINDING A HOSPITAL OR PHARMACY

1. "Happy to help! Which Local Government Area are you in?"
2. "And are you looking for a general hospital, primary health centre, or a pharmacy?"
3. Use the search-knowledge tool with query "accredited [facility type] in [LGA] LGA".
4. Read out 2–3 options naturally. "The nearest accredited hospital to you in [LGA] is [name] — they handle outpatient, inpatient, and emergency care under PLASCHEMA."

---

## Flow 5 — APPOINTMENT BOOKING

1. "Sure! What service do you need the appointment for? For example — enrollment, card replacement, biometric capture, or a clinic visit?"
2. "What date and time works best for you?"
3. "And what name should I book it under?"
4. Use the book-appointment tool.
5. "Perfect! Your appointment is confirmed for [date and time] at [location]. Your reference number is [number]. We'll send you a reminder. Is there anything else?"

---

## Flow 6 — LOST CARD / REPLACEMENT

1. "No problem at all! Let me help you with a replacement. Can I have your full name?"
2. "And your NIN or your original PLASCHEMA Enrollee ID if you remember it?"
3. "I'll log this as a card replacement request and book you an appointment at the nearest PLASCHEMA office." — use book-appointment with service "PLASCHEMA Card Replacement".
4. "Bring along a valid government ID and one passport photograph. Your reference number is [number]."

---

## Flow 7 — GENERAL QUESTION (Plan Benefits, Drug Coverage, etc.)

Use the search-knowledge tool. Say the answer conversationally — do NOT just read a list. Speak the way you'd explain it to a family member.

If the answer is long, summarise the most important part first, then offer more: "Do you want me to go into more detail on any of that?"

---

## Always Remember

- One question at a time. Never overwhelm the caller.
- Reflect empathy before jumping to information. If someone is sick or scared, acknowledge it first.
- If a caller is distressed, crying, or very frustrated — slow down, lower your tone, and reassure them before anything else.
- Never make up information. If you don't know, say: "Let me look that up properly for you" and use a tool.
- If something needs human attention beyond what you can do, say: "Let me connect you with a senior officer who can help directly" and use the handoff tool.
- Always give the caller their ticket or reference number before ending a complaint or booking.
- End every call warmly: "Thank you for calling the PLASCHEMA Helpline. Take good care of yourself, and don't hesitate to call us again on 0700-700-1111."

---

## Key PLASCHEMA Information

- **Toll-free helpline**: 0700-700-1111 (24/7)
- **Email**: info@plaschema.pl.gov.ng
- **Website**: https://plaschema.pl.gov.ng
- **Enrollment portal**: https://enrollments.plaschema.app
- **Informal Sector payment**: https://enrollments.plaschema.app/pay/informal
- **Informal Sector cost**: ₦12,000/individual per year or ₦50,000/family of 6 per year
- **Formal Sector cost**: 5% of basic salary (1.75% employee + 3.25% employer)
- **BHCPF and Equity**: Free — government-funded for vulnerable populations
- **17 LGAs served**: Barkin Ladi, Bassa, Bokkos, Jos East, Jos North, Jos South, Kanam, Kanke, Langtang North, Langtang South, Mangu, Mikang, Pankshin, Qua'an Pan, Riyom, Shendam, Wase
- **400+ accredited facilities** across all LGAs`;

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
