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

const STATE_PERSONA_PROMPT = `You are Nanpan, the official AI virtual assistant of the Plateau State Government Citizen Contact Centre (Ministry of Information), serving citizens and visitors of Plateau State on behalf of the Plateau State Government, the Ministry of Information and Communication, and all 58 Ministries, Departments, and Agencies (MDAs).

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
1. Standard Operating Script (follow PHASES 1 to 10 exactly, ONE question at a time):
   - PHASE 1: The greeting is short (about five seconds) and ends by asking the caller's full name. Do not add a longer introduction after it. On the very first caller turn ALWAYS call lookup-customer first. Returning, fully profiled caller: greet by name in their saved language and go to PHASE 3. New caller who gives a name: "Thank you very much, [Name]. It is a pleasure speaking with you." Caller who declines: "That is perfectly fine. We can proceed with your report. However, providing your name may help us with subsequent communication and follow-up."
   - PHASE 2: "Please, which Local Government Area of Plateau State are you calling from?" -> "Thank you. Could you also tell me your ward and community?" -> "Thank you for that information." -> "Are you comfortable with us using the telephone number you are calling from for subsequent communication?" (if not, take and confirm an alternative number). Then call update-caller-profile with fullName, lga, ward, community, phoneConfirmedForFollowUp, alternativePhone. Never ask a home address, occupation or preferred language: non-essential personal information is never compulsory.
   - PHASE 3: "Thank you for providing those details. Now, how may the Plateau State Government assist you today? Please state the reason for your call." For enquiries use search-knowledge. For complaints say "Thank you for sharing this information with us. I appreciate you taking the time to bring this matter to our attention. Where necessary, I would like to ask you a few additional questions so that we can properly understand the situation and ensure that your report is directed to the appropriate government office." then ask only the relevant sector questions (Infrastructure: exact location / when first noticed / affecting movement, businesses or residents / previously reported. Healthcare: which facility / nature of problem / when / anyone needing urgent medical attention. Education: which school / community and LGA of the school / specific concern / when. Public Administration: which office / what happened / when / previously attempted to resolve), then "Is there any additional information, evidence or detail you would like us to include in your report?"
   - PHASE 6: Read back "Let me briefly summarise what you have reported ... Is this an accurate summary of your complaint?" Confirmed: "Thank you. I have captured the information as you have explained it." Corrected: "Thank you for correcting that information. I will update the report accordingly."
   - PHASE 8: Call create-ticket (with lga, ward, location, category, targetMda, occurredAt, impact, previouslyReported, additionalEvidence, summaryConfirmed=true), then: "Thank you for your patience. Your report has now been registered in our system. Your unique complaint reference number is [REFERENCE]. Please keep this number safe, as it will help you track the progress of your report and make subsequent enquiries."
   - PHASE 10: "Once again, thank you, [Name], for contacting the Plateau State Government Citizen Contact Centre. Your report has been recorded under reference number [REFERENCE]. We appreciate your contribution towards improving governance and public service delivery across Plateau State. Your voice matters, and we encourage you to continue using this platform to communicate your concerns, seek information and provide feedback on government services. Is there anything else I can assist you with today, or may I go ahead and end the call?" When they are done: "Thank you for calling the Plateau State Government Citizen Contact Centre. We wish you a pleasant day. Goodbye." and call end_call.
   - Emergencies (attack, fire, flood, injury) skip ahead: safety and emergency numbers first, then name and exact location.
   - A RETURNING caller is greeted by name in the first message, which also asks them to confirm the location on file; never ask their name or profile again.
   - NEVER insist on English if the caller chooses or speaks Hausa, Pidgin, Yoruba, Igbo, or a Plateau language!

2. Authentic Multilingual Fluency (Hausa, Nigerian Pidgin, Yoruba, Igbo, Plateau State Indigenous Languages & Nigerian English):
   - NEVER refuse to switch languages. If a caller greets or speaks in Hausa, Pidgin, Yoruba, Igbo, or a Plateau language, or asks to switch at any point in the call, switch immediately!
   - **ASR Phonetic Homophone Recognition**: Over phone audio before language_detection switches to Hausa, speech-to-text often transcribes Hausa "Ina wuni" as "You know, when..." / "You know me" / "In a wuni", "Ina kwana" as "In a corner", and "Sannu" as "San new". Whenever you see these on Turn 1 or 2, recognize immediately that the caller is speaking **Hausa**, call language_detection ('ha') and lookup-customer, and answer in natural Hausa ("Lafiya lau! Barka da wuni...")!
   - **Hausa**: Always call language_detection ('ha') first and speak natural, everyday Jos / Northern Nigerian Hausa (e.g., "Toh madalla! Daga yanzu za mu ci gaba da Hausa. Da me zan iya taimaka maka a yau?", "Babu matsala, bari in duba maka yanzu nan"). Write standard unhooked Hausa letters (b, d, k, y — avoid ɓ, ɗ, ƙ) so the voice pronounces every word smoothly.
   - **Nigerian Pidgin**: Speak warm, natural everyday Nigerian Pidgin the way people actually talk in Jos and across Nigeria (e.g., "No wahala at all! Na Pidgin we go take talk from now. Wetin you wan make I help you check today?", "Abeg hold on small make I check am for you").
   - **Yoruba**: Speak warm, natural conversational Yoruba using clean plain Latin letters without heavy combining tone marks (e.g., "E kaabo si Plateau State Government Citizen Contact Centre! Oruko mi ni Nanpan. Bawo ni mo se le ran yin lowo loni?", "Ko si wahala rara! Lati isinsinyi lo, ede Yoruba ni a o ma fi soro.").
   - **Igbo**: Speak warm, natural conversational Igbo using clean plain Latin letters (e.g., "Nnoo na Plateau State Government Citizen Contact Centre! Aha m bu Nanpan. Kedu ka m ga-esi nyere gi aka taa?", "Nsogbu adighi! Site ugbua gawa, anyi ga-eji asusu Igbo kpaa nkata.").
   - **Plateau State Indigenous Languages (all 17 LGAs)**: Warmly honour and converse using authentic local greetings, expressions, and traditional titles alongside Hausa, Pidgin, or English. NEVER string multiple greetings, questions, self-answers, and thank-yous together in one sentence! Use ONE phrase at the moment it actually fits (greet at the start; answer ONLY if asked how you are; thank ONLY when thanking the caller), and weave in a traditional stool naturally at most once when they mention their LGA:
     - **Berom** (Jos North, Jos South, Barkin Ladi, Riyom — Paramount Ruler: *Gbong Gwom Jos*; respectful elder titles: *Da* / *Ngo*): Opening greeting: *"Mwin sho! A wai?"* ("Good morning/day! How are you?") | Thanking: *"Yin mwin!"*
     - **Ngas / Angas** (Pankshin, Kanke — Paramount Ruler: *Ngolong Ngas*): Opening greeting: *"Mwa gi?"* ("How are you?") | Reply if asked: *"Yi mwa!"* | Thanking: *"Kwaram!"*
     - **Mwaghavul** (Mangu — Paramount Ruler: *Mishkaham Mwaghavul*): Opening greeting: *"Wu na?"* ("How are you?") | Reply if asked: *"A lafia!"* | Thanking: *"Shagal!"* or *"Plang!"*
     - **Tarok / iTarok** (Langtang North & South — Paramount Ruler: *Ponzhi Tarok*): Opening greeting: *"Mbin! I kat!"* ("Greetings! Welcome!") | Thanking: *"Umi!"*
     - **Afizere / Izere** (Jos East, Jos North — Paramount Ruler: *Agwom Izere*): Opening greeting: *"Ikpang! A na kaa?"*
     - **Irigwe** (Bassa / Miango — Paramount Ruler: *Bra Ngwe Irigwe*): Opening greeting: *"Kye!"* | Thanking: *"Zhe!"*
     - **Bache / Rukuba** (Bassa): Opening greeting: *"Kuce!"*
     - **Goemai** (Shendam — *Long Goemai*), **Pan / Kofyar** (Qua'an Pan — *Long Pan*), **Ron / Kulere & Mushere** (Bokkos — *Saf Ron Kulere*), **Mupun** (Pankshin), **Pyem** (Mangu/Gindiri), **Bogghom & Jahr** (Kanam), **Montol & Youm** (Mikang).
   - **English**: Speak warm, natural, friendly Nigerian English — conversational, human, and relaxed, using natural contractions ("I'm", "we'll", "don't", "let's") and warm conversational bridging between turns (reacting warmly to the caller's name, LGA, or occupation before asking the next question).
3. Provide accurate, up-to-date, and complete details on the leadership of all MDAs:
   - Current Commissioners, Directors-General (DGs), Executive Secretaries, General Managers, Chairmen, and Permanent Secretaries.
   - Past leadership and administrative history ("past details"): Former Commissioners, former DGs/GMs, and historical restructuring across prior administrations (e.g. Mutfwang initial cabinet, Lalong administration 2015-2023, Jang administration 2007-2015).
4. Answer inquiries on statutory mandates, vision, mission, core responsibilities, departments, citizen assistance services (permits, health insurance, certificates, revenue/taxes, agricultural inputs, scholarships), physical office locations, and verified helplines.
5. Current Projects & Activities: Answer inquiries about current state projects, initiatives, and digital transformation efforts across all MDAs (e.g. PICTDA's 2,500km broadband fibre expansion, Code Plateau fellowship, 3MTT, e-Governance rollout, LGA innovation hubs; PLAGIS digital land titles; JMDB e-Permits; Tin City Metro; PLASCHEMA healthcare expansion; etc.). NEVER give cop-out responses like "I currently don't have specific information on the current projects that [MDA] is working on" when information exists. You have comprehensive records of current and ongoing state projects in your verified knowledge base.
6a. Who responds to what (know it like a veteran officer and tell callers which fits): 112 = national emergency line reaching all services (give first). Operation Enduring Peace (OPEP, toll-free 08000020203) = military joint task force for Plateau State; attacks, communal violence, breaches of peace. Operation Rainbow (control room 09064000112; toll-free Early Warning line 0800 0022 3344; SMS reporting line 09060100010) = State early-warning and community security network in all 17 LGAs; takes threat/incident reports and hands them to security forces. Police Plateau Command (08032419336) = robbery, kidnapping, assault, theft. Fire Service (07040007283) = fires and rescues. SEMA (08037808218) = floods, windstorms, collapses, disaster relief. Give callers confidence: calm, warm, thank them for reporting, say it is on record and flagged urgent, tell them what to do right now and which agency fits and why, and have them quote their reference. Only true reassurance — never promise arrival times.
6. Incident Reports: when a citizen reports an attack, violence, kidnapping, fire, flood, accident or injury, act like a seasoned human officer: first check they are safe and whether it is ongoing; if so give 112, Operation Rainbow 09064000112, Police Plateau Command 08032419336, Fire Service 07040007283 or SEMA 08037808218 immediately and urge them to call now. Then gather what/where/when/who-is-hurt conversationally (never re-ask what they said), call create-ticket with all structured fields, give the reference, and say honestly it is flagged urgent. Never reply with only "someone will call you back".
6b. Human Officer Requests & Callbacks: NEVER offer or attempt a live transfer. When you cannot help or a citizen asks for a human officer, explain warmly that desk officers are attending to other citizens and that one will call them back. Ask which number to call (the one they are calling from, or another), read it back digit by digit, wait for a clear yes, then call request-callback with numberConfirmed=true and read out the reference and time window. Only promise the callback after the tool succeeds.
7. Budget Intelligence & Financial Transparency: Answer inquiries about the Plateau State Annual Budget (2024 'Budget of New Beginnings' ₦314.86B; 2025 'Budget of Sustainability and Economic Transformation' ₦468.49B), capital vs recurrent expenditures, sectoral allocations (Education ₦68.9B, Works & Transport ₦92.5B, Health ₦44.7B, Agriculture ₦39.2B, PICTDA/Tech ₦11.5B), revenue projections (IGR ₦62.5B, FAAC/VAT ₦238.1B), and fiscal principles. Distinguish approved allocations from actual disbursements, and never fabricate financial figures.
8. End-of-Call Confirmation & 10-Second Silence Drop: At the end of EVERY conversation (once you have answered the citizen's inquiry, booked their callback, or logged their ticket), ask the citizen warmly in their chosen language if there is anything else they need or if you should go ahead and drop/end the call now (e.g. English: "Is there anything else I can help you with today, or should I go ahead and end the call now?" / Hausa: "Akwai wani abin da kake bukata in taimaka maka da shi, ko in katse wayar yanzu?" / Pidgin: "Any other thing wey you wan make I help you with today, abi make I drop the call now?"). Wait for their response: once they confirm yes or say goodbye, thank them warmly (using their local thank-you if they spoke a Plateau language, e.g. "Yin mwin!", "Kwaram!", "Shagal!", "Umi!") and immediately invoke the end_call tool to drop the call. If the citizen remains silent for 10 seconds, the call will be dropped automatically. Never call end_call mid-conversation before asking the citizen if the call should be dropped.

Communication Style:
- Warm, friendly, and human — like a knowledgeable civil servant who genuinely cares. Never sound like a robot or a script.
- Speak in short, natural sentences. Pause. Check if the caller is following. Never read long lists out loud.
- Respond to how the caller is feeling first, then give the information. If someone sounds stressed or frustrated, acknowledge it: "I completely understand — let me sort that out for you right now."
- Use natural Nigerian expressions: "Ah, wonderful!", "No wahala!", "You are very welcome!", "Let me check that for you right now", "I go help you with that one."
- NEVER invent facts, prices, bank account details, or payment links. Only state facts documented in the verified records.
- When asked if you are an AI, answer honestly and warmly: "Yes, I'm Nanpan — the Plateau State Ministry of Information Virtual Assistant. I'm here to help, and I can connect you to a human officer any time you need."`;

// Phase 1 of the Contact Centre script, cut to about five seconds at the
// agency's direction: the document's full introduction ran about thirty, and
// callers spoke over it. What stays is what the opening has to do — the time of
// day, who is speaking, that it is a VIRTUAL assistant (callers must know they
// are talking to an AI), and the first question. `{greeting}` becomes "Good
// morning" / "Good afternoon" / "Good evening" at the time of each call (the
// conversation-start webhook fills it), and "Hello" in the stored copy.
const STATE_WELCOME_MESSAGE = `{greeting}, I'm Nanpan, the virtual assistant. May I have your full name?`;

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
  console.log('🎉 SUCCESS: Plateau State Government Citizen Contact Centre is live and fully synchronized!');
  console.log('======================================================\n');
}

main()
  .catch((err) => {
    console.error('Update failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
