/**
 * scripts/update-state-info-center.js
 *
 * 1. Updates the organization persona prompt and welcome message in Supabase
 *    to establish the agent as the official Plateau State Government Citizen Contact Centre.
 * 2. Removes obsolete/conflicting placeholder documents (e.g. ones claiming
 *    officials' names are not held).
 * 3. Ingests all 58 comprehensive MDA knowledge documents into the organization's
 *    knowledge base with full chunking (Current leadership, past leadership, mandates, services).
 */

const path = require('path');
const { leadershipLines } = require('./apply-verified-leadership');
const fs = require('fs');

require(path.join(__dirname, '..', 'apps', 'api', 'dist', 'config', 'load-env.js'));

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const CATALOG_PATH = path.join(__dirname, '..', 'data', 'plateau-mdas-knowledge-base.json');
const CHUNK_SIZE_CHARS = 1800;

function chunkText(text, chunkSize = CHUNK_SIZE_CHARS) {
  const overlap = Math.floor(chunkSize * 0.1);
  const chunks = [];
  for (let i = 0; i < text.length; ) {
    chunks.push(text.slice(i, Math.min(i + chunkSize, text.length)).trim());
    i += chunkSize - overlap;
  }
  return chunks.filter(Boolean);
}

function phoneProblem(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length < 11) return 'too short to be a Nigerian number';
  if (digits.length > 15) return 'too long for E.164';
  if (/0{5,}/.test(digits)) return 'a run of zeros';
  const tail = digits.slice(-7);
  if (new Set(tail).size <= 2) return 'repeated digits';
  return null;
}

function documentFor(m) {
  const name = String(m.name || '').trim();
  const abbr = String(m.abbreviation || '').trim();
  const title = abbr ? `${abbr} — ${name}` : name;

  const curLeader = m.currentLeadership || {};
  const pastLeadership = m.pastLeadership || [];
  const adminHistory = m.administrativeHistory || '';
  const mandate = m.mandate || '';
  const vision = m.vision || '';
  const mission = m.mission || '';
  const departments = m.departments || [];
  const citizenServices = m.citizenServices || [];
  const currentProjects = m.currentProjects || [];
  const parastatals = m.supervisedParastatals || [];
  const touristSites = m.touristSites || [];
  const facilities = m.facilities || [];
  const legalFramework = m.legalFramework || '';
  const alsoWritten = m.alsoWritten || [];

  const phones = [];
  const rawPhones = (m.contact && m.contact.phones) || [];
  for (const raw of rawPhones) {
    const trimmed = String(raw || '').trim();
    if (!trimmed || phoneProblem(trimmed)) continue;
    if (!phones.includes(trimmed)) phones.push(trimmed);
  }

  const rawLocation = String((m.contact && m.contact.office) || '').trim();
  const usableLocation = rawLocation && !/^no\.?\s*\d+[a-z]?$/i.test(rawLocation) ? rawLocation : '';

  const lines = [];
  lines.push(`# ${name}`);
  if (abbr) lines.push(`Also known as: ${abbr}`);
  if (alsoWritten.length) lines.push(`Alternative names: ${alsoWritten.join(', ')}`);
  lines.push('');

  // Leadership comes from the verified table (scripts/apply-verified-leadership.js):
  // a confirmed head with the date it was confirmed, or an honest "not confirmed".
  lines.push(...leadershipLines(curLeader));

  if (pastLeadership.length || adminHistory) {
    lines.push('## Past Leadership & Administrative History');
    for (const p of pastLeadership) {
      const pWho = [p.title, p.name].filter(Boolean).join(' ').trim();
      lines.push(`- **Former ${p.role || 'Leader'}**: ${pWho}${p.period ? ` (${p.period})` : ''}`);
    }
    if (adminHistory) {
      lines.push('');
      lines.push(adminHistory);
    }
    lines.push('');
  }

  if (mandate) {
    lines.push('## Mandate and Core Functions');
    lines.push(mandate);
    lines.push('');
    if (vision) {
      lines.push(`**Vision**: ${vision}`);
      lines.push('');
    }
    if (mission) {
      lines.push(`**Mission**: ${mission}`);
      lines.push('');
    }
  }

  if (departments.length) {
    lines.push('## Key Departments and Directorates');
    for (const d of departments) lines.push(`- ${d}`);
    lines.push('');
  }

  if (citizenServices.length) {
    lines.push('## Public Services and Citizen Assistance');
    for (const s of citizenServices) lines.push(`- ${s}`);
    lines.push('');
  }

  if (currentProjects.length) {
    lines.push('## Current Projects, Strategic Initiatives & Ongoing Activities');
    for (const p of currentProjects) lines.push(`- ${p}`);
    lines.push('');
  }

  if (parastatals.length) {
    lines.push('## Supervised Parastatals and Tertiary Institutions');
    for (const p of parastatals) lines.push(`- ${p}`);
    lines.push('');
  }
  if (touristSites.length) {
    lines.push('## Key State Tourist Destinations Managed');
    for (const t of touristSites) lines.push(`- ${t}`);
    lines.push('');
  }
  if (facilities.length) {
    lines.push('## Key State Facilities');
    for (const f of facilities) lines.push(`- ${f}`);
    lines.push('');
  }

  const contactLines = [];
  if (usableLocation) contactLines.push(`- Office: ${usableLocation}`);
  if (phones.length) contactLines.push(`- Phone: ${phones.join(', ')}`);
  if (m.contact && m.contact.email) contactLines.push(`- Email: ${String(m.contact.email).trim()}`);
  if (m.contact && m.contact.website) contactLines.push(`- Website: ${String(m.contact.website).trim()}`);
  if (contactLines.length) {
    lines.push('## How to Reach It');
    lines.push(...contactLines);
    lines.push('');
  }

  if (legalFramework) {
    lines.push('## Legal Framework and Enabling Law');
    lines.push(legalFramework);
    lines.push('');
  }

  lines.push('---');
  lines.push(
    `Source: Plateau State Government Official Portal, State Executive Council Gazettes, and Verified Directory, updated ` +
      `${new Date().toISOString().slice(0, 10)}.`
  );

  return { title, body: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() };
}

// Every name the persona states comes from the verified table (checked
// against published 2025-2026 sources). An office not in it is NOT named:
// the agent says the name is not confirmed and gives the office instead.
const VERIFIED = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'verified-leadership.json'), 'utf8'));
const PERSONA_LEADERSHIP = [
  ...VERIFIED.principalOfficers.map((o) => `- ${o.position}: ${o.name}${o.asOf ? ` (as of ${o.asOf})` : ''}.`),
  ...Object.entries(VERIFIED.leaders)
    .filter(([abbr]) => !['OSGS', 'OHCS'].includes(abbr)) // already among the principal officers
    .map(([abbr, l]) => `- ${l.position}${/^Commissioner|^Attorney-General/.test(l.position) ? '' : ` (${abbr})`}: ${l.name} (as of ${l.asOf}).`),
  '- For ANY office not listed here (a Deputy Speaker, a Permanent Secretary, an agency head), say plainly that the name is not confirmed in our records and give the office\'s contact details. NEVER guess or recall a name from memory.',
].join('\n');

const STATE_PERSONA_PROMPT = `You are {{representative_name}}, the official AI virtual assistant of the Plateau State Government Citizen Contact Centre (Ministry of Information), serving citizens and visitors of Plateau State on behalf of the Plateau State Government, the Ministry of Information and Communication, and all 58 Ministries, Departments, and Agencies (MDAs).

Core State Leadership (confirmed by published sources; generated from data/verified-leadership.json):
${PERSONA_LEADERSHIP}

Your core mandate is to serve as the State's central knowledge and public inquiry desk:
1. Follow the Standard Operating Script (Phases 1 to 10) in the system prompt, ONE question at a time. Speak ENGLISH ONLY for the whole call, whatever language the caller uses: never switch to Hausa, Pidgin, Yoruba, Igbo or a Plateau indigenous language.
2. Provide accurate, up-to-date, and complete details on the leadership of all MDAs:
   - Current Commissioners, Directors-General (DGs), Executive Secretaries, General Managers, Chairmen, and Permanent Secretaries.
   - Past leadership and administrative history ("past details"): Former Commissioners, former DGs/GMs, and historical restructuring across prior administrations (e.g. Mutfwang initial cabinet, Lalong administration 2015-2023, Jang administration 2007-2015).
3. Answer inquiries on statutory mandates, vision, mission, core responsibilities, departments, citizen assistance services (permits, health insurance, certificates, revenue/taxes, agricultural inputs, scholarships), physical office locations, and verified helplines.
4. Current Projects & Achievements of Governor Caleb Mutfwang ("The Time is Now" Administration, May 2023–Present): Answer inquiries thoroughly about Governor Mutfwang's projects and achievements across all 58 MDAs — including Transport (15 German-engineered Tin City Metro buses at ₦200 flat fare, Plateau Riders fleet upgrade, Jos–Bukuru commuter rail revival with NRC, Abuja–Jos commercial flights with ValueJet & Yakubu Gowon Airport upgrade), Roads & Urban Renewal (35+ Jos–Bukuru urban roads under Operation Zero Potholes, inter-LGA highways & bridges, RAAMP rural feeder roads, Jos Main Market reconstruction, Executive Order 003 urban renewal, JMDB e-Permits), Agriculture (200+ truckloads of subsidized fertilizer, 6,000+ hectares BARI resettlement farming in Bokkos/Mangu/Barkin Ladi/Riyom/Bassa, ASTC tractors revival, Irish potato tissue culture & cold storage, AfDB Special Agro-Industrial Processing Zone & Heipang Dry Port, new Ministry of Livestock Development), Healthcare (new Pharma-Grade Central Medical Warehouse under PSDMCMA, 100,000+ vulnerable citizens & retirees on free PLASCHEMA healthcare, Plateau Specialist Hospital & General Hospitals upgrades, 325 ward focal PHCs revitalization), ICT (PICTDA 2,500km broadband fibre with Solutron, Code Plateau 6.0, 3MTT, LGA CBT/Innovation hubs, PLAGIS digital e-C of O with 50% waiver, 08000000456 AI Contact Centre), Education & Youth (400+ UBEC/PSUBEB classrooms & smart schools, World Bank AGILE project, increased student bursaries & Law School grants, Zaria Road Stadium works), Civil Service & Governance (clearing of inherited salary/pension arrears, prompt salary payment before the 25th, ₦70,000 minimum wage implementation, PSIRS digital CBS growing IGR to ₦38B–₦62B+, October 2024 peaceful elections in all 17 LGAs), Security (600+ new Operation Rainbow operatives & Agro-Rangers, OPEP support, IDP safe resettlement), and Water/Environment/Tourism (Lamingo & Yakubu Gowon Dam water treatment overhaul, ACReSAL erosion control, PEPSA compactor fleet, Hill Station Hotel & Plateau Hotel PPP revitalization). NEVER give cop-out responses like "I currently don't have specific information on the current projects that [MDA] is working on" — use search-knowledge and state the verified projects clearly.
5. Budget Intelligence & Financial Transparency: Answer inquiries about the Plateau State Annual Budget (2024 'Budget of New Beginnings' ₦314.86B; 2025 'Budget of Sustainability and Economic Transformation' ₦468.49B), capital vs recurrent expenditures, sectoral allocations (Education ₦68.9B, Works & Transport ₦92.5B, Health ₦44.7B, Agriculture ₦39.2B, PICTDA/Tech ₦11.5B), revenue projections (IGR ₦62.5B, FAAC/VAT ₦238.1B), and fiscal principles. Distinguish approved allocations from actual disbursements, and never fabricate financial figures.

Communication Style:
- Warm, friendly, and human — like a knowledgeable civil servant who genuinely cares. Never sound like a robot or a script.
- Speak in short, natural sentences. Pause. Check if the caller is following. Never leave out details you have: give a long list in groups of three, asking whether to continue, until every item is given. In writing (WhatsApp), give the complete list at once.
- Use natural Nigerian expressions: "Ah, wonderful!", "You are very welcome!", "No problem at all".
- NEVER invent facts, prices, bank account details, or payment links. Only state facts documented in the verified records.
- NEVER use the <governor> voice tag in your replies: the Governor's voice is ONLY for the pre-configured opening welcome, after which you speak exclusively as {{representative_name}} in your own voice.
- When asked if you are an AI, answer honestly and warmly: "Yes, I'm {{representative_name}} — the Plateau State Ministry of Information Virtual Assistant. I'm here to help, and I can connect you to a human officer any time you need."`;

// Phase 1 of the Contact Centre script: opens with the Governor's voice
// (`<governor>...</governor>`, voiced by pAqGcXrGBThHKNv6yJnM) greeting the
// caller by time of day and welcoming them, then handing over to the virtual
// assistant (`KpLREcAbIIKFKpEkPEIR`), who says who it is and asks the caller's
// full name. By the agency's decision the Governor does NOT say his name or
// title — he greets and hands over. The greeting is said once, by him, so the
// assistant does not repeat it. `{greeting}` becomes "Good morning" / "Good
// afternoon" / "Good evening" at the time of each call (the conversation-start
// webhook fills both `{greeting}` and `{name}`), and "Hello" / "Nanpan" in the
// stored fallback copy.
// The `<break time="1.0s" />` is a one-second pause between the Governor's
// voice and the assistant's: without it the hand-over ran the two together.
// ElevenLabs reads the tag on the English model (eleven_turbo_v2) the agent
// uses; it is never spoken.
const STATE_WELCOME_MESSAGE = `<governor>{greeting}, and welcome to the Plateau State Government Citizen Contact Centre. Our virtual assistant, {name}, will help you now.</governor> <break time="1.0s" /> I'm {name}, the virtual assistant. To help us resolve your issue and follow up with you, this call is being recorded and your personal details will be logged into our citizen support system. May I have your full name?`;

async function main() {
  console.log('Connecting to database...');

  const org = await prisma.organization.findFirst({
    where: { slug: 'plaschema' },
    select: { id: true, name: true, slug: true },
  });

  if (!org) {
    throw new Error('Organization with slug "plaschema" not found.');
  }

  console.log(`Found target organization: "${org.name}" (${org.slug})`);

  // 1. Update organization persona and welcome message
  console.log('\n1. Updating AI Persona Prompt and Welcome Message...');
  await prisma.organization.update({
    where: { id: org.id },
    data: {
      name: 'Plateau State Government Citizen Contact Centre',
      welcomeMessage: STATE_WELCOME_MESSAGE,
      aiPersonaPrompt: STATE_PERSONA_PROMPT,
    },
  });
  console.log('   ✓ Updated AI persona prompt and welcome message successfully.');

  if (process.argv.includes('--prompt-only')) {
    console.log('   ✓ --prompt-only flag set; skipping knowledge document re-indexing.');
    return;
  }

  // 2. Remove obsolete / conflicting placeholder documents
  console.log('\n2. Cleaning up obsolete or conflicting placeholder documents...');
  const obsoleteDocs = await prisma.knowledgeDocument.findMany({
    where: {
      organizationId: org.id,
      OR: [
        { title: { contains: 'MDA Directory', mode: 'insensitive' } },
        { title: 'December_Tourism_Month_2026_Events_Lineup' },
      ],
    },
    select: { id: true, title: true },
  });

  for (const doc of obsoleteDocs) {
    await prisma.documentChunk.deleteMany({ where: { documentId: doc.id } });
    await prisma.knowledgeDocument.delete({ where: { id: doc.id } });
    console.log(`   ✓ Removed obsolete document: "${doc.title}"`);
  }

  // 3. Load catalog and seed all 58 comprehensive MDAs
  console.log('\n3. Loading 58 comprehensive MDAs into Knowledge Base...');
  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  console.log(`   Found ${catalog.length} MDAs in catalog.`);

  const existingDocs = await prisma.knowledgeDocument.findMany({
    where: { organizationId: org.id },
    select: { id: true, title: true },
  });
  const existingMap = new Map(existingDocs.map((d) => [d.title, d.id]));

  let createdCount = 0;
  let updatedCount = 0;
  let totalChunks = 0;
  let processed = 0;

  for (const mda of catalog) {
    const docData = documentFor(mda);
    const chunks = chunkText(docData.body);
    totalChunks += chunks.length;

    const existingId = existingMap.get(docData.title);

    const payload = {
      organizationId: org.id,
      title: docData.title,
      fileName: `${docData.title.replace(/[^A-Za-z0-9]+/g, '-').slice(0, 60)}.md`,
      mimeType: 'text/markdown',
      fileSize: Buffer.byteLength(docData.body, 'utf8'),
      storageUrl: 'https://plateaustate.gov.ng/mdas',
      status: 'INDEXED',
      chunkCount: chunks.length,
      errorMessage: null,
    };

    const doc = existingId
      ? await prisma.knowledgeDocument.update({ where: { id: existingId }, data: payload })
      : await prisma.knowledgeDocument.create({ data: payload });

    if (existingId) updatedCount++;
    else createdCount++;

    // Replace chunks cleanly with batch createMany
    await prisma.documentChunk.deleteMany({ where: { documentId: doc.id } });
    if (chunks.length > 0) {
      await prisma.documentChunk.createMany({
        data: chunks.map((content, chunkIndex) => ({
          organizationId: org.id,
          documentId: doc.id,
          chunkIndex,
          content,
        })),
      });
    }

    processed++;
    if (processed % 10 === 0 || processed === catalog.length) {
      console.log(`   [${processed}/${catalog.length}] MDAs processed...`);
    }
  }

  console.log(`   ✓ Knowledge base updated: ${createdCount} created, ${updatedCount} updated.`);
  console.log(`   ✓ Total chunks indexed: ${totalChunks}`);

  // 4. Also add a Master Leadership Directory Document for broad queries like "List all commissioners"
  console.log('\n4. Indexing Master Plateau State Executive Directory document...');
  const masterLines = [];
  masterLines.push('# Plateau State Government — Master Leadership Directory & Executive Council');
  masterLines.push(`Current heads of all 58 MDAs in Plateau State, each confirmed by a published source (checked ${VERIFIED.checkedOn}). Where a name is not confirmed, the record says so.`);
  masterLines.push('');
  masterLines.push('## Principal Officers of Plateau State Government (Executive & Legislative)');
  for (const o of VERIFIED.principalOfficers) {
    masterLines.push(`- **${o.position}**: ${o.name}${o.asOf ? ` (as of ${o.asOf})` : ''}`);
  }
  masterLines.push('');
  masterLines.push('## All 58 Ministries, Departments, and Agencies (MDAs)');
  for (const mda of catalog) {
    const leader = mda.currentLeadership || {};
    const who = [leader.title, leader.name].filter(Boolean).join(' ').trim();
    const head = who ? `${who}${leader.asOf ? ` (as of ${leader.asOf})` : ''}` : 'name not confirmed in our records';
    masterLines.push(`- **${mda.abbreviation ? `${mda.abbreviation} — ` : ''}${mda.name}**: ${leader.position || 'Head'}: ${head}`);
    if (mda.pastLeadership && mda.pastLeadership.length > 0) {
      const pastStr = mda.pastLeadership.map(p => `${p.role}: ${[p.title, p.name].filter(Boolean).join(' ')} (${p.period})`).join('; ');
      masterLines.push(`  - Former Leadership: ${pastStr}`);
    }
  }
  const masterBody = masterLines.join('\n');
  const masterChunks = chunkText(masterBody);

  const existingMaster = await prisma.knowledgeDocument.findFirst({
    where: { organizationId: org.id, title: 'Plateau State Executive Council & MDA Leadership Directory' },
    select: { id: true },
  });

  const masterDocPayload = {
    organizationId: org.id,
    title: 'Plateau State Executive Council & MDA Leadership Directory',
    fileName: 'plateau-state-mda-leadership-directory.md',
    mimeType: 'text/markdown',
    fileSize: Buffer.byteLength(masterBody, 'utf8'),
    storageUrl: 'https://plateaustate.gov.ng/government',
    status: 'INDEXED',
    chunkCount: masterChunks.length,
    errorMessage: null,
  };

  const masterDoc = existingMaster
    ? await prisma.knowledgeDocument.update({ where: { id: existingMaster.id }, data: masterDocPayload })
    : await prisma.knowledgeDocument.create({ data: masterDocPayload });

  await prisma.documentChunk.deleteMany({ where: { documentId: masterDoc.id } });
  if (masterChunks.length > 0) {
    await prisma.documentChunk.createMany({
      data: masterChunks.map((content, chunkIndex) => ({
        organizationId: org.id,
        documentId: masterDoc.id,
        chunkIndex,
        content,
      })),
    });
  }
  console.log('   ✓ Master Leadership Directory indexed successfully.');

  // 5. Index Plateau State Budget and Financial Intelligence
  console.log('\n5. Indexing Plateau State Budget and Financial Intelligence document...');
  const budgetDocPath = path.join(__dirname, '..', 'data', 'mda-knowledge', 'Plateau-State-Budget-and-Financial-Intelligence.md');
  if (fs.existsSync(budgetDocPath)) {
    const budgetBody = fs.readFileSync(budgetDocPath, 'utf8');
    const budgetChunks = chunkText(budgetBody);

    const existingBudgetDoc = await prisma.knowledgeDocument.findFirst({
      where: { organizationId: org.id, title: 'Plateau State Budget and Financial Intelligence' },
      select: { id: true },
    });

    const budgetDocPayload = {
      organizationId: org.id,
      title: 'Plateau State Budget and Financial Intelligence',
      fileName: 'Plateau-State-Budget-and-Financial-Intelligence.md',
      mimeType: 'text/markdown',
      fileSize: Buffer.byteLength(budgetBody, 'utf8'),
      storageUrl: 'https://plateaustate.gov.ng/budget',
      status: 'INDEXED',
      chunkCount: budgetChunks.length,
      errorMessage: null,
    };

    const budgetDoc = existingBudgetDoc
      ? await prisma.knowledgeDocument.update({ where: { id: existingBudgetDoc.id }, data: budgetDocPayload })
      : await prisma.knowledgeDocument.create({ data: budgetDocPayload });

    await prisma.documentChunk.deleteMany({ where: { documentId: budgetDoc.id } });
    if (budgetChunks.length > 0) {
      await prisma.documentChunk.createMany({
        data: budgetChunks.map((content, chunkIndex) => ({
          organizationId: org.id,
          documentId: budgetDoc.id,
          chunkIndex,
          content,
        })),
      });
    }
    console.log(`   ✓ Budget and Financial Intelligence indexed successfully (${budgetChunks.length} chunks).`);
  }

  // 6. Index Plateau State House of Assembly and Government Leadership
  console.log('\n6. Indexing Plateau State House of Assembly and Government Leadership document...');
  const assemblyDocPath = path.join(__dirname, '..', 'data', 'mda-knowledge', 'Plateau-State-House-of-Assembly-and-Government-Leadership.md');
  if (fs.existsSync(assemblyDocPath)) {
    const assemblyBody = fs.readFileSync(assemblyDocPath, 'utf8');
    const assemblyChunks = chunkText(assemblyBody);

    const existingAssemblyDoc = await prisma.knowledgeDocument.findFirst({
      where: { organizationId: org.id, title: 'Plateau State House of Assembly & Government Leadership Directory' },
      select: { id: true },
    });

    const assemblyDocPayload = {
      organizationId: org.id,
      title: 'Plateau State House of Assembly & Government Leadership Directory',
      fileName: 'Plateau-State-House-of-Assembly-and-Government-Leadership.md',
      mimeType: 'text/markdown',
      fileSize: Buffer.byteLength(assemblyBody, 'utf8'),
      storageUrl: 'https://plateaustate.gov.ng/house-of-assembly',
      status: 'INDEXED',
      chunkCount: assemblyChunks.length,
      errorMessage: null,
    };

    const assemblyDoc = existingAssemblyDoc
      ? await prisma.knowledgeDocument.update({ where: { id: existingAssemblyDoc.id }, data: assemblyDocPayload })
      : await prisma.knowledgeDocument.create({ data: assemblyDocPayload });

    await prisma.documentChunk.deleteMany({ where: { documentId: assemblyDoc.id } });
    if (assemblyChunks.length > 0) {
      await prisma.documentChunk.createMany({
        data: assemblyChunks.map((content, chunkIndex) => ({
          organizationId: org.id,
          documentId: assemblyDoc.id,
          chunkIndex,
          content,
        })),
      });
    }
    console.log(`   ✓ House of Assembly and Government Leadership indexed successfully (${assemblyChunks.length} chunks).`);
  }

  // 7. Index Plateau State Master Citizen Guide (17 LGAs, Traditional Rulers, PLASCHEMA Rates & Hospitals, Education, Projects)
  console.log('\n7. Indexing Plateau State Master Citizen Guide document...');
  const masterGuidePath = path.join(__dirname, '..', 'data', 'mda-knowledge', 'Plateau-State-Master-Citizen-Guide.md');
  if (fs.existsSync(masterGuidePath)) {
    const guideBody = fs.readFileSync(masterGuidePath, 'utf8');
    const guideChunks = chunkText(guideBody);

    const existingGuideDoc = await prisma.knowledgeDocument.findFirst({
      where: { organizationId: org.id, title: 'Plateau State Master Citizen Guide — LGAs, Hospitals, Education & Projects' },
      select: { id: true },
    });

    const guideDocPayload = {
      organizationId: org.id,
      title: 'Plateau State Master Citizen Guide — LGAs, Hospitals, Education & Projects',
      fileName: 'Plateau-State-Master-Citizen-Guide.md',
      mimeType: 'text/markdown',
      fileSize: Buffer.byteLength(guideBody, 'utf8'),
      storageUrl: 'https://plateaustate.gov.ng/guide',
      status: 'INDEXED',
      chunkCount: guideChunks.length,
      errorMessage: null,
    };

    const guideDoc = existingGuideDoc
      ? await prisma.knowledgeDocument.update({ where: { id: existingGuideDoc.id }, data: guideDocPayload })
      : await prisma.knowledgeDocument.create({ data: guideDocPayload });

    await prisma.documentChunk.deleteMany({ where: { documentId: guideDoc.id } });
    if (guideChunks.length > 0) {
      await prisma.documentChunk.createMany({
        data: guideChunks.map((content, chunkIndex) => ({
          organizationId: org.id,
          documentId: guideDoc.id,
          chunkIndex,
          content,
        })),
      });
    }
    console.log(`   ✓ Plateau State Master Citizen Guide indexed successfully (${guideChunks.length} chunks).`);
  }

  // 8. Index Plateau State Supplemental Services Guide (PSIRS, LGA Chairmen, Scholarships, Hospitals full list, FAQ)
  console.log('\n8. Indexing Plateau State Supplemental Services Guide...');
  const suppGuidePath = path.join(__dirname, '..', 'data', 'mda-knowledge', 'Plateau-State-Supplemental-Services-Guide.md');
  if (fs.existsSync(suppGuidePath)) {
    const suppBody = fs.readFileSync(suppGuidePath, 'utf8');
    const suppChunks = chunkText(suppBody);

    const existingSuppDoc = await prisma.knowledgeDocument.findFirst({
      where: { organizationId: org.id, title: 'Plateau State Supplemental Services & Contact Directory' },
      select: { id: true },
    });

    const suppDocPayload = {
      organizationId: org.id,
      title: 'Plateau State Supplemental Services & Contact Directory',
      fileName: 'Plateau-State-Supplemental-Services-Guide.md',
      mimeType: 'text/markdown',
      fileSize: Buffer.byteLength(suppBody, 'utf8'),
      storageUrl: 'https://plateaustate.gov.ng/services-directory',
      status: 'INDEXED',
      chunkCount: suppChunks.length,
      errorMessage: null,
    };

    const suppDoc = existingSuppDoc
      ? await prisma.knowledgeDocument.update({ where: { id: existingSuppDoc.id }, data: suppDocPayload })
      : await prisma.knowledgeDocument.create({ data: suppDocPayload });

    await prisma.documentChunk.deleteMany({ where: { documentId: suppDoc.id } });
    if (suppChunks.length > 0) {
      await prisma.documentChunk.createMany({
        data: suppChunks.map((content, chunkIndex) => ({
          organizationId: org.id,
          documentId: suppDoc.id,
          chunkIndex,
          content,
        })),
      });
    }
    console.log(`   ✓ Supplemental Services Guide indexed successfully (${suppChunks.length} chunks).`);
  } else {
    console.log('   ⚠ Supplemental Services Guide not found, skipping.');
  }

  // 9. Index Governor Caleb Mutfwang Comprehensive Projects & Achievements Scorecard
  console.log('\n9. Indexing Governor Caleb Mutfwang Comprehensive Projects & Achievements document...');
  const projectsGuidePath = path.join(__dirname, '..', 'data', 'mda-knowledge', 'Governor-Caleb-Mutfwang-Projects-and-Achievements.md');
  if (fs.existsSync(projectsGuidePath)) {
    const projectsBody = fs.readFileSync(projectsGuidePath, 'utf8');
    const projectsChunks = chunkText(projectsBody);

    const existingProjectsDoc = await prisma.knowledgeDocument.findFirst({
      where: { organizationId: org.id, title: 'Governor Caleb Mutfwang — Comprehensive Projects & Achievements Scorecard' },
      select: { id: true },
    });

    const projectsDocPayload = {
      organizationId: org.id,
      title: 'Governor Caleb Mutfwang — Comprehensive Projects & Achievements Scorecard',
      fileName: 'Governor-Caleb-Mutfwang-Projects-and-Achievements.md',
      mimeType: 'text/markdown',
      fileSize: Buffer.byteLength(projectsBody, 'utf8'),
      storageUrl: 'https://plateaustate.gov.ng/projects',
      status: 'INDEXED',
      chunkCount: projectsChunks.length,
      errorMessage: null,
    };

    const projectsDoc = existingProjectsDoc
      ? await prisma.knowledgeDocument.update({ where: { id: existingProjectsDoc.id }, data: projectsDocPayload })
      : await prisma.knowledgeDocument.create({ data: projectsDocPayload });

    await prisma.documentChunk.deleteMany({ where: { documentId: projectsDoc.id } });
    if (projectsChunks.length > 0) {
      await prisma.documentChunk.createMany({
        data: projectsChunks.map((content, chunkIndex) => ({
          organizationId: org.id,
          documentId: projectsDoc.id,
          chunkIndex,
          content,
        })),
      });
    }
    console.log(`   ✓ Governor Mutfwang Projects & Achievements indexed successfully (${projectsChunks.length} chunks).`);
  }

  // 10. Index the December Tourism Month 2026 events lineup
  console.log('\n10. Indexing December Tourism Month 2026 events lineup...');
  const tourismPath = path.join(__dirname, '..', 'data', 'mda-knowledge', 'December-Tourism-Month-2026-Events.md');
  if (fs.existsSync(tourismPath)) {
    const tourismBody = fs.readFileSync(tourismPath, 'utf8');
    const tourismChunks = chunkText(tourismBody);
    const tourismTitle = 'December Tourism Month 2026 — Plateau State Events Lineup';

    const existingTourismDoc = await prisma.knowledgeDocument.findFirst({
      where: { organizationId: org.id, title: tourismTitle },
      select: { id: true },
    });

    const tourismDocPayload = {
      organizationId: org.id,
      title: tourismTitle,
      fileName: 'December-Tourism-Month-2026-Events.md',
      mimeType: 'text/markdown',
      fileSize: Buffer.byteLength(tourismBody, 'utf8'),
      storageUrl: 'https://plateaustate.gov.ng/tourism',
      status: 'INDEXED',
      chunkCount: tourismChunks.length,
      errorMessage: null,
    };

    const tourismDoc = existingTourismDoc
      ? await prisma.knowledgeDocument.update({ where: { id: existingTourismDoc.id }, data: tourismDocPayload })
      : await prisma.knowledgeDocument.create({ data: tourismDocPayload });

    await prisma.documentChunk.deleteMany({ where: { documentId: tourismDoc.id } });
    if (tourismChunks.length > 0) {
      await prisma.documentChunk.createMany({
        data: tourismChunks.map((content, chunkIndex) => ({
          organizationId: org.id,
          documentId: tourismDoc.id,
          chunkIndex,
          content,
        })),
      });
    }
    console.log(`   ✓ December Tourism Month 2026 events indexed successfully (${tourismChunks.length} chunks).`);
  } else {
    console.log('   ⚠ December Tourism Month 2026 events lineup not found, skipping.');
  }

  console.log('\n======================================================');
  console.log('🎉 SUCCESS: Plateau State Government Citizen Contact Centre is live and fully synchronized!');
  console.log('======================================================\n');
}

module.exports = { STATE_PERSONA_PROMPT, STATE_WELCOME_MESSAGE, documentFor };

// Only when run as a script: loading this file to read its persona must not
// rewrite a database.
if (require.main === module) {
  main()
    .catch((err) => {
      console.error('Update failed:', err);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
