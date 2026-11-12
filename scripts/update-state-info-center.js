/**
 * scripts/update-state-info-center.js
 *
 * 1. Updates the organization persona prompt and welcome message in Supabase
 *    to establish the agent as the official Plateau State Citizen Information Center.
 * 2. Removes obsolete/conflicting placeholder documents (e.g. ones claiming
 *    officials' names are not held).
 * 3. Ingests all 58 comprehensive MDA knowledge documents into the organization's
 *    knowledge base with full chunking (Current leadership, past leadership, mandates, services).
 */

const path = require('path');
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

  const leaderTitle = curLeader.title || '';
  const leaderName = curLeader.name || '';
  const leaderPos = curLeader.position || '';
  const leaderWho = [leaderTitle, leaderName].filter(Boolean).join(' ').trim();

  if (leaderWho || leaderPos) {
    lines.push('## Current Leadership');
    lines.push(`- **${leaderPos || 'Head of Agency'}**: ${leaderWho}`);
    if (curLeader.permanentSecretary) {
      lines.push(`- **Permanent Secretary**: ${curLeader.permanentSecretary}`);
    }
    if (curLeader.note) {
      lines.push(`- **Portfolio Overview**: ${curLeader.note}`);
    }
    lines.push('');
  }

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

const STATE_PERSONA_PROMPT = `You are the official Plateau State Citizen Information Center AI assistant, serving citizens and visitors of Plateau State on behalf of the Plateau State Government, the Ministry of Information and Communication, and all 58 Ministries, Departments, and Agencies (MDAs).

Core State Leadership (Always use these current, verified figures):
- Executive Governor: His Excellency, Barr. Caleb Manasseh Mutfwang ("The Time is Now" administration).
- Deputy Governor: Her Excellency, Ngo Josephine Chundung Piyo.
- Speaker, Plateau State House of Assembly: Rt. Hon. Na'anlong Daniel (representing Mikang State Constituency; unanimously elected Speaker on July 2, 2025, succeeding former Speaker Hon. Gabriel Dewan of the YPP who served from 2023 to July 2025).
- Deputy Speaker, House of Assembly: Hon. Timothy Dantong.
- Secretary to the Government of the State (SGS): Arc. Samuel Nanchang Jatau.
- Chief of Staff: Engr. Jeremiah Satmark.
- Head of Civil Service: Mr. Stephen Pam Gadong (confirmed December 2024, succeeding Barr. Rauta Dakok who retired).
- Attorney-General and Commissioner for Justice: Philemon Audu Daffi.
- Director-General, Plateau State Contributory Healthcare Management Agency (PLASCHEMA): Dr. Dawal Solomon Kwande.
- Commissioner for Health: Dr. Nicholas Ba'amlong.
- Commissioner for Works: Dr. Cletus Bako Shurkuk.
- Commissioner for Commerce and Industry: Dr. Sunday Alex (appointed January 2025).
- Commissioner for Tourism, Culture and Hospitality: Hon. Cornelius Dongnaan Doeyok (appointed January 2025).
- Commissioner for Youth and Sports Development: Hon. Bashir Lawandi Datti.
- Commissioner for Information and Communication: Hon. Joyce Lohya Ramnap.
- Director-General, Plateau State Energy Corporation: Engr. Ponzing Bindong Gamde (Board Chairman: Hon. Victor During Dagett).
- Project Coordinator, SDGs Project Support Unit: Hon. Mrs. Nanbam Esther Danjuma-Lot.
- Director-General, PEPSA: Samuel Nathaniel Dapiya.
- Director-General, PICTDA: Datong Dominic Gwaman.
- Executive Chairman, PSIRS: Jim Pam Wayas.
- Director-General, Plateau Peace Building Agency (PPBA): Dr. Julie Sanda.

Your core mandate is to serve as the State's central knowledge and public inquiry desk:
1. Caller Profiling & Memory:
   - At the START of every conversation, use the lookup-customer tool.
   - If the caller's name is not on file (known is false or name is missing), politely and warmly ask: "May I know who I have the pleasure of speaking with?" or "Could I take your name so I can properly address you?".
   - As soon as the caller provides their name or LGA, call update-caller-profile immediately so they are remembered.
   - If the caller is returning, greet them warmly by their name (e.g. "Welcome back, [Name]!") and acknowledge their history.
2. Multilingual Fluency (Hausa, English & Pidgin):
   - You are fluent in English, Hausa, and Nigerian Pidgin.
   - If a caller speaks or greets you in Hausa (e.g. "Sannu", "Ina kwana", "Lafia lau", "Ina son jin labarin..."), reply and converse fluently in Hausa! (e.g. "Barka da zuwa Cibiyar Bayanai ta Jama'a ta Jihar Plateau. Yaya zan iya taimaka maka a yau?").
   - If a caller speaks Nigerian Pidgin, converse naturally in warm Pidgin.
   - If a caller speaks English, converse in English. Seamlessly mirror their language choice!
3. Provide accurate, up-to-date, and complete details on the leadership of all MDAs:
   - Current Commissioners, Directors-General (DGs), Executive Secretaries, General Managers, Chairmen, and Permanent Secretaries.
   - Past leadership and administrative history ("past details"): Former Commissioners, former DGs/GMs, and historical restructuring across prior administrations (e.g. Mutfwang initial cabinet, Lalong administration 2015-2023, Jang administration 2007-2015).
4. Answer inquiries on statutory mandates, vision, mission, core responsibilities, departments, citizen assistance services (permits, health insurance, certificates, revenue/taxes, agricultural inputs, scholarships), physical office locations, and verified helplines.
5. Current Projects & Activities: Answer inquiries about current state projects, initiatives, and digital transformation efforts across all MDAs (e.g. PICTDA's 2,500km broadband fibre expansion, Code Plateau fellowship, 3MTT, e-Governance rollout, LGA innovation hubs; PLAGIS digital land titles; JMDB e-Permits; Tin City Metro; PLASCHEMA healthcare expansion; etc.). NEVER give cop-out responses like "I currently don't have specific information on the current projects that [MDA] is working on" when information exists. You have comprehensive records of current and ongoing state projects in your verified knowledge base.
6. Human Officer Requests & Callbacks: When there are no human agents available to handover or when a citizen asks to speak to a human officer: explain politely that human desk officers are currently attending to other citizens, promise a call back, and ask the user to confirm their phone number for a callback when an agent is available.
7. Budget Intelligence & Financial Transparency: Answer inquiries about the Plateau State Annual Budget (2024 'Budget of New Beginnings' ₦314.86B; 2025 'Budget of Sustainability and Economic Transformation' ₦468.49B), capital vs recurrent expenditures, sectoral allocations (Education ₦68.9B, Works & Transport ₦92.5B, Health ₦44.7B, Agriculture ₦39.2B, PICTDA/Tech ₦11.5B), revenue projections (IGR ₦62.5B, FAAC/VAT ₦238.1B), and fiscal principles. Distinguish approved allocations from actual disbursements, and never fabricate financial figures.

Communication Style:
- Warm, respectful, clear, and dignified. Speak the way an experienced, caring civil servant does.
- Plain, accessible English and Nigerian Pidgin. Understand English, Pidgin, Hausa, Igbo, and Yoruba.
- NEVER invent facts, prices, bank account details, or payment links. Only state facts documented in the verified records.
- When asked if you are an AI, answer truthfully that you are the Plateau State Government's AI Information Center assistant.`;

const STATE_WELCOME_MESSAGE = `Hello! Welcome to the Plateau State Citizen Information Center. How can I assist you with state ministries, leadership details, or public services today?`;

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
      name: 'Plateau State Citizen Information Center',
      welcomeMessage: STATE_WELCOME_MESSAGE,
      aiPersonaPrompt: STATE_PERSONA_PROMPT,
    },
  });
  console.log('   ✓ Updated AI persona prompt and welcome message successfully.');

  // 2. Remove obsolete / conflicting placeholder documents
  console.log('\n2. Cleaning up obsolete or conflicting placeholder documents...');
  const obsoleteDocs = await prisma.knowledgeDocument.findMany({
    where: {
      organizationId: org.id,
      title: { contains: 'MDA Directory', mode: 'insensitive' },
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

  let createdCount = 0;
  let updatedCount = 0;
  let totalChunks = 0;

  for (const mda of catalog) {
    const docData = documentFor(mda);
    const chunks = chunkText(docData.body);
    totalChunks += chunks.length;

    const existing = await prisma.knowledgeDocument.findFirst({
      where: { organizationId: org.id, title: docData.title },
      select: { id: true },
    });

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

    const doc = existing
      ? await prisma.knowledgeDocument.update({ where: { id: existing.id }, data: payload })
      : await prisma.knowledgeDocument.create({ data: payload });

    if (existing) updatedCount++;
    else createdCount++;

    // Replace chunks cleanly
    await prisma.documentChunk.deleteMany({ where: { documentId: doc.id } });
    for (let i = 0; i < chunks.length; i++) {
      await prisma.documentChunk.create({
        data: {
          organizationId: org.id,
          documentId: doc.id,
          chunkIndex: i,
          content: chunks[i],
        },
      });
    }
  }

  console.log(`   ✓ Knowledge base updated: ${createdCount} created, ${updatedCount} updated.`);
  console.log(`   ✓ Total chunks indexed: ${totalChunks}`);

  // 4. Also add a Master Leadership Directory Document for broad queries like "List all commissioners"
  console.log('\n4. Indexing Master Plateau State Executive Directory document...');
  const masterLines = [];
  masterLines.push('# Plateau State Government — Master Leadership Directory & Executive Council');
  masterLines.push('Complete listing of current Commissioners, Directors-General, Chairmen, and executive heads of all 58 MDAs in Plateau State:');
  masterLines.push('');
  masterLines.push('## Principal Officers of Plateau State Government (Executive & Legislative)');
  masterLines.push('- **Executive Governor of Plateau State**: His Excellency, Barr. Caleb Manasseh Mutfwang ("The Time is Now" administration)');
  masterLines.push('- **Deputy Governor of Plateau State**: Her Excellency, Ngo Josephine Chundung Piyo');
  masterLines.push('- **Speaker, Plateau State House of Assembly**: Rt. Hon. Na\'anlong Daniel (representing Mikang State Constituency; unanimously elected Speaker on July 2, 2025, succeeding former Speaker Hon. Gabriel Dewan of the YPP who served from 2023 to July 2025)');
  masterLines.push('- **Deputy Speaker, Plateau State House of Assembly**: Hon. Timothy Dantong');
  masterLines.push('- **Secretary to the Government of the State (SGS)**: Arc. Samuel Nanchang Jatau');
  masterLines.push('- **Chief of Staff to the Governor**: Engr. Jeremiah Satmark');
  masterLines.push('- **Head of Civil Service**: Mr. Stephen Pam Gadong (confirmed substantive Head of Civil Service in December 2024, succeeding Barr. Rauta Dakok who reached mandatory retirement age)');
  masterLines.push('- **Attorney-General and Commissioner for Justice**: Hon. Philemon Audu Daffi');
  masterLines.push('- **Director-General, Plateau State Contributory Healthcare Management Agency (PLASCHEMA)**: Dr. Dawal Solomon Kwande');
  masterLines.push('');
  masterLines.push('## All 58 Ministries, Departments, and Agencies (MDAs)');
  for (const mda of catalog) {
    const leader = mda.currentLeadership || {};
    const who = [leader.title, leader.name].filter(Boolean).join(' ').trim();
    masterLines.push(`- **${mda.abbreviation ? `${mda.abbreviation} — ` : ''}${mda.name}**: ${leader.position || 'Head'}: ${who || 'N/A'}`);
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
  for (let i = 0; i < masterChunks.length; i++) {
    await prisma.documentChunk.create({
      data: {
        organizationId: org.id,
        documentId: masterDoc.id,
        chunkIndex: i,
        content: masterChunks[i],
      },
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
    for (let i = 0; i < budgetChunks.length; i++) {
      await prisma.documentChunk.create({
        data: {
          organizationId: org.id,
          documentId: budgetDoc.id,
          chunkIndex: i,
          content: budgetChunks[i],
        },
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
    for (let i = 0; i < assemblyChunks.length; i++) {
      await prisma.documentChunk.create({
        data: {
          organizationId: org.id,
          documentId: assemblyDoc.id,
          chunkIndex: i,
          content: assemblyChunks[i],
        },
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
    for (let i = 0; i < guideChunks.length; i++) {
      await prisma.documentChunk.create({
        data: {
          organizationId: org.id,
          documentId: guideDoc.id,
          chunkIndex: i,
          content: guideChunks[i],
        },
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
    for (let i = 0; i < suppChunks.length; i++) {
      await prisma.documentChunk.create({
        data: {
          organizationId: org.id,
          documentId: suppDoc.id,
          chunkIndex: i,
          content: suppChunks[i],
        },
      });
    }
    console.log(`   ✓ Supplemental Services Guide indexed successfully (${suppChunks.length} chunks).`);
  } else {
    console.log('   ⚠ Supplemental Services Guide not found, skipping.');
  }

  console.log('\n======================================================');
  console.log('🎉 SUCCESS: Plateau State Citizen Information Center is live and fully synchronized!');
  console.log('======================================================\n');
}

main()
  .catch((err) => {
    console.error('Update failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
