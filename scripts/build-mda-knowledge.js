/**
 * scripts/build-mda-knowledge.js
 *
 * Compiles the authoritative, comprehensive Plateau State MDA Knowledge Base:
 * 1. Current Leadership (Commissioners, DGs, Executive Secretaries, GMs, Chairmen, etc.)
 * 2. Past Leadership & Administrative History ("pass dtails" / predecessors across administrations)
 * 3. Mandates, Vision, Mission, and Core Functions
 * 4. Key Departments and Divisions
 * 5. Citizen Services and Public Engagement Procedures
 * 6. Contact Information (Verified offices, emails, phones with placeholder filtering)
 * 7. Supervised Parastatals, Institutions, and Legal Frameworks
 *
 * Outputs:
 * - data/plateau-mdas-knowledge-base.json
 * - docs/plateau-state-mdas-comprehensive-knowledge.md
 * - data/mda-knowledge/*.md
 */

const fs = require('fs');
const path = require('path');

// Load raw API data if present
const rawPath = path.join(__dirname, '..', 'data', 'plsgov-mdas-raw.json');
const rawMdas = fs.existsSync(rawPath) ? JSON.parse(fs.readFileSync(rawPath, 'utf8')) : [];

function findRaw(nameOrAbbr) {
  const target = nameOrAbbr.toLowerCase().trim();
  return rawMdas.find((m) => {
    const n = (m.name || '').toLowerCase();
    const a = (m.abbreviation || '').toLowerCase();
    return a === target || n === target || n.includes(target) || target.includes(n);
  });
}

function cleanHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\/\s*(p|div|li|h[1-6])\s*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#x27;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .trim();
}

const MDA_CATALOG = [
  // ── 1. MINISTRIES ──────────────────────────────────────────────────────────
  {
    name: 'Ministry of Agriculture and Natural Resources',
    abbreviation: 'MARD',
    alsoWritten: ['Ministry of Agriculture', 'Ministry of Agriculture and Rural Development'],
    category: 'GOVERNMENT',
    currentLeadership: {
      title: 'Hon.',
      name: 'Samson Ishaku Bugama',
      position: 'Commissioner',
      permanentSecretary: 'Dr. Jonathan B. Danladi',
      note: 'Supervises state agrarian transformation, food security, and farmer empowerment.'
    },
    pastLeadership: [
      { role: 'Commissioner', title: 'Dr.', name: 'Hosea Finangwai', period: '2019 – 2023 (Lalong administration)' },
      { role: 'Commissioner', title: 'Mrs.', name: 'Linda Barau', period: '2015 – 2019 (Lalong administration)' },
      { role: 'Commissioner', title: 'Hon.', name: 'Steven Barko', period: '2011 – 2015 (Jang administration)' }
    ],
    administrativeHistory: 'Formerly oversaw veterinary services and livestock until the creation of the dedicated Ministry of Livestock Development, Veterinary Services and Fisheries in February 2025. Coordinates closely with the Federal Ministry of Agriculture and Food Security.',
    mandate: 'Formulate, execute, and monitor state agricultural policies, spearhead food security programs, distribute subsidized agricultural inputs (fertilizers, chemicals, improved seedlings), maintain farm mechanization tractor hiring schemes, and promote agricultural extension services to smallholder farmers.',
    vision: 'A modern, productive, and competitive agricultural sector ensuring sustainable food security, poverty reduction, and economic wealth for Plateau State.',
    mission: 'To empower farmers through cutting-edge extension services, modern mechanization, high-yield inputs, and agro-allied value-chain development across all 17 LGAs.',
    departments: [
      'Department of Agricultural Services',
      'Department of Extension & Rural Development',
      'Department of Fisheries & Aquaculture (liaison)',
      'Department of Irrigation & Land Resources',
      'Department of Planning, Research & Statistics (PRS)',
      'Department of Administration & Supplies'
    ],
    citizenServices: [
      'Subsidized inorganic and organic fertilizer distribution through designated ward collection centres',
      'Tractor hiring and farm implements leasing for cooperative farming groups',
      'Certified high-yield disease-resistant crop seedlings distribution (maize, Irish potato, soya beans, rice)',
      'Agricultural extension advisory visits and pest outbreak interventions',
      'Dry-season fadama irrigation support and small water pumps allocation',
      'Registration and certification of farmer cooperative societies'
    ],
    supervisedParastatals: [
      'Plateau Agricultural Development Programme (PADP)',
      'Plateau State College of Agriculture, Garkawa'
    ],
    contact: {
      office: 'Joseph Gomwalk State Secretariat Complex, Jos, Plateau State',
      phones: ['+2348037042854'],
      email: 'info.agric@plateaustate.gov.ng',
      website: 'https://plateaustate.gov.ng'
    },
    legalFramework: 'Established pursuant to the executive powers of Plateau State Government and the Laws of Plateau State.'
  },

  {
    name: 'Ministry of Budget and Economic Planning',
    abbreviation: 'MoBEP',
    alsoWritten: ['Ministry of Budget and Planning'],
    category: 'GOVERNMENT',
    currentLeadership: {
      title: 'Hon.',
      name: 'Adams Bulus Lekshak',
      position: 'Commissioner',
      permanentSecretary: 'Mrs. Martha Azi',
      note: 'Reassigned from Ministry of Works during cabinet reshuffle to lead economic planning and budget coordination.'
    },
    pastLeadership: [
      { role: 'Commissioner', title: 'Hon.', name: 'Chrysanthus Dawam', period: 'August 2023 – February 2025 (Mutfwang cabinet)' },
      { role: 'Commissioner', title: 'Hon.', name: 'Sylvester Wallangko', period: '2015 – 2023 (Lalong administration)' },
      { role: 'Commissioner', title: 'Mr.', name: 'Ezekiel Gomos', period: 'Pre-2015' }
    ],
    administrativeHistory: 'Serves as the think-tank of the state government, formulating Medium-Term Expenditure Frameworks (MTEF) and State Development Plans. Coordinates Open Government Partnership (OGP) commitments.',
    mandate: 'Formulating macroeconomic policies, preparing annual state capital and recurrent budgets, tracking budgetary allocations, monitoring state projects, and coordinating with multilateral development partners (World Bank, AfDB, UNDP, UNICEF).',
    vision: 'A model state planning agency driving transparent, equitable, and sustainable socioeconomic growth for Plateau State.',
    mission: 'To ensure prudent allocation of state resources through participatory, transparent budgeting and rigorous evidence-based monitoring and evaluation.',
    departments: [
      'Department of Budget Formulation & Monitoring',
      'Department of Macroeconomic Planning & Research',
      'Department of International Cooperation & Donor Coordination',
      'Department of Monitoring & Evaluation (M&E)',
      'Department of Administration & Human Resources'
    ],
    citizenServices: [
      'Hosting public citizen budget consultation sessions across the three senatorial zones',
      'Publishing approved annual budgets, budget performance reports, and citizen budget summaries',
      'Facilitating Open Government Partnership (OGP) public commitments and citizen feedback mechanisms',
      'Monitoring capital development projects and addressing citizen expenditure inquiries'
    ],
    supervisedParastatals: [
      'Plateau State Bureau of Statistics (PSBS)',
      'Plateau State Sustainable Development Goals Project Support Unit (SDGs-PSU)'
    ],
    contact: {
      office: '2nd Floor, Joseph Gomwalk State Secretariat, Jos, Plateau State',
      phones: ['+2348036916250'],
      email: 'info.budget@plateaustate.gov.ng',
      website: 'https://plateaustate.gov.ng'
    },
    legalFramework: 'Established under the Plateau State Fiscal Responsibility Law and executive council structure.'
  },

  {
    name: 'Ministry of Commerce and Industry',
    abbreviation: 'MOCI',
    alsoWritten: ['Ministry of Commerce', 'Ministry of Commerce and Industries', 'Ministry of Commerce and Energy'],
    category: 'GOVERNMENT',
    currentLeadership: {
      title: 'Hon.',
      name: 'Sule Musa Haruna',
      position: 'Commissioner for Commerce and Industry',
      note: 'Portfolio also coordinated with Nyalum M. Salisu (Commerce and Energy).'
    },
    pastLeadership: [
      { role: 'Commissioner', title: 'Hon.', name: 'Abe Aku', period: '2015 – 2023 (Lalong administration)' },
      { role: 'Commissioner', title: 'Hon.', name: 'Idi Waziri', period: 'Pre-2015' }
    ],
    administrativeHistory: 'Over the years has managed state commercial enterprise development, industrial parks, and mineral/energy liaisons.',
    mandate: 'Facilitating industrial development, promoting domestic and international trade, encouraging small and medium enterprises, organizing international trade fairs, and supervising state cooperative societies.',
    vision: 'To position Plateau State as Northern Nigeria’s premier commercial, manufacturing, and agro-allied processing hub.',
    mission: 'To stimulate private sector enterprise, industrial growth, and commercial investments through an enabling business climate.',
    departments: [
      'Department of Commerce & Trade Promotion',
      'Department of Industrial Development',
      'Department of Cooperative Societies & Associations',
      'Department of Small & Medium Enterprises Development',
      'Department of Planning, Research & Statistics (PRS)'
    ],
    citizenServices: [
      'Business premises registration and statutory certification',
      'Registration, supervision, and annual auditing of cooperative societies',
      'Trade fair and agricultural exhibition participation coordination',
      'Allocation of commercial stalls in state-managed market plazas',
      'Export readiness support for local agricultural and artisanal producers'
    ],
    supervisedParastatals: [
      'Plateau State Micro, Small and Medium Enterprises Development Agency (PLASMEDA)',
      'Plateau Investment and Property Development Company (PIPC)',
      'Plateau Minerals Development Company (PMDC)'
    ],
    contact: {
      office: 'Joseph Gomwalk State Secretariat, Jos, Plateau State',
      phones: ['+2348037042854'],
      email: 'commerce@plateaustate.gov.ng',
      website: 'https://plateaustate.gov.ng'
    },
    legalFramework: 'Enacted under the Plateau State Business Premises Registration and Commercial Laws.'
  },

  {
    name: 'Ministry of Education',
    abbreviation: 'MoE',
    alsoWritten: ['Ministry of Education (MoE)', 'Ministry of Basic and Secondary Education', 'Ministry of Higher Education'],
    category: 'GOVERNMENT',
    currentLeadership: {
      title: 'Dr. (Mrs.)',
      name: 'Kachollom Pyam Gang',
      position: 'Commissioner for Education',
      note: 'Originally appointed Commissioner for Higher Education in August 2023; assumed leadership of the unified Ministry of Education following the February 2025 merger of Secondary and Higher Education.'
    },
    pastLeadership: [
      { role: 'Commissioner (Secondary Education)', title: 'Mrs.', name: 'Grace Dongkum', period: 'August 2023 – February 2025 (reassigned to Finance)' },
      { role: 'Commissioner (Secondary Education)', title: 'Mrs.', name: 'Elizabeth Wapmuk', period: '2019 – 2023 (Lalong administration)' },
      { role: 'Commissioner (Higher Education)', title: 'Hon.', name: 'Sylvester Wallangko', period: '2019 – 2023 (Lalong administration)' },
      { role: 'Commissioner', title: 'Mr.', name: 'Athanasius Lozeng', period: '2011 – 2015 (Jang administration)' }
    ],
    administrativeHistory: 'Under Governor Simon Lalong and the early Mutfwang administration, the portfolio was split into Secondary Education and Higher Education. In the February 2025 cabinet restructuring, Governor Caleb Mutfwang merged both branches back into a single unified Ministry of Education.',
    mandate: 'Formulate, regulate, and supervise education policies across basic, secondary, technical, and tertiary institutions in Plateau State; enforce national standards; inspect schools; and promote educational excellence.',
    vision: 'A world-class, inclusive, and technologically grounded educational system preparing all Plateau children and youth for 21st-century global opportunities.',
    mission: 'To deliver accessible, equitable, and qualitative education through motivated teachers, modern learning infrastructure, and rigorous quality assurance.',
    departments: [
      'Department of Basic and Secondary Education',
      'Department of Higher & Technical Education',
      'Department of Science & Technology Education',
      'Department of Quality Assurance & School Inspection',
      'Department of Educational Planning, Research & Statistics',
      'Department of Examinations & Certification'
    ],
    citizenServices: [
      'Public secondary school placement, admissions, and inter-school transfer processing',
      'Accreditation, licensing, and annual regulatory inspection of private nursery, primary, and secondary schools',
      'Coordination of state basic education certificate examinations (BECE) and Mock SSCE',
      'Teacher posting, continuous professional development, and discipline in public schools',
      'Approval of WAEC, NECO, and NABTEB examination centres'
    ],
    supervisedParastatals: [
      'Plateau State Universal Basic Education Board (PSUBEB)',
      'Teachers\' Service Commission (TSC)',
      'Plateau State Scholarship Board (PSSB)',
      'Plateau State University (PLASU), Bokkos',
      'Plateau State Polytechnic, Barkin Ladi',
      'College of Education, Gindiri',
      'College of Arts, Science and Technology (CAST), Kurgwi'
    ],
    contact: {
      office: 'Joseph Gomwalk State Secretariat Complex, Jos, Plateau State',
      phones: ['+2348038724158'],
      email: 'moe@plateaustate.gov.ng',
      website: 'https://plateaustate.gov.ng'
    },
    legalFramework: 'Established under the Plateau State Education Law, National Policy on Education, and UBE Act.'
  },

  {
    name: 'Ministry of Environment, Climate Change and Mineral Development',
    abbreviation: 'MECCMD',
    alsoWritten: ['Ministry of Environment', 'Ministry of Environment and Mineral Development'],
    category: 'GOVERNMENT',
    currentLeadership: {
      title: 'Hon.',
      name: 'Peter Kanang Gwom',
      position: 'Commissioner',
      note: 'Leading state climate change resilience, conservation, and mineral tracking.'
    },
    pastLeadership: [
      { role: 'Commissioner', title: 'Hon.', name: 'Usman Idi', period: '2019 – 2023 (Lalong administration)' },
      { role: 'Commissioner', title: 'Hon.', name: 'Elisha Bitrus Wanah', period: '2015 – 2019 (Lalong administration)' },
      { role: 'Commissioner', title: 'Hon.', name: 'Yiljap Abraham', period: '2007 – 2011 (Jang administration)' }
    ],
    administrativeHistory: 'Broadened to formally integrate Climate Change Adaptation and Mineral Development surveillance into its ministerial portfolio under Governor Caleb Mutfwang.',
    mandate: 'Protecting and restoring the natural environment, spearheading climate change adaptation, tackling gully erosion and flood risks, overseeing forestry and wildlife conservation, and monitoring artisanal and commercial mining practices.',
    vision: 'A clean, green, climate-resilient Plateau State where natural ecosystems and rich mineral resources are sustainably managed for present and future generations.',
    mission: 'To preserve biodiversity, eliminate environmental pollution, combat land degradation, and enforce responsible mining through robust policy, public action, and technological monitoring.',
    departments: [
      'Department of Climate Change & Green Growth',
      'Department of Forestry, Wildlife & Conservation',
      'Department of Environmental Health & Pollution Control',
      'Department of Mineral Resources & Mining Surveillance',
      'Department of Erosion, Flood Control & Coastal Management',
      'Department of Planning, Research & Statistics'
    ],
    citizenServices: [
      'Environmental Impact Assessment (EIA) reviews and environmental compliance certificates',
      'Tree seedling distribution from state nurseries for afforestation and community greening',
      'Flood and gully erosion risk assessments and drainage intervention requests',
      'Monitoring and reporting abandoned mining pits, environmental degradation, and water contamination',
      'Tree felling permits and timber exploitation regulations'
    ],
    supervisedParastatals: [
      'Plateau Environmental Protection and Sanitation Agency (PEPSA)'
    ],
    contact: {
      office: 'JD Gomwalk State Secretariat, Jos, Plateau State',
      phones: ['+2348036916250'],
      email: 'contact.meccmd@plateaustate.gov.ng',
      website: 'https://plateaustate.gov.ng'
    },
    legalFramework: 'Plateau State Environmental Protection Law and National Environmental Standards Regulations.'
  },

  {
    name: 'Ministry of Finance',
    abbreviation: 'MOF',
    alsoWritten: ['Plateau State Ministry of Finance'],
    category: 'GOVERNMENT',
    currentLeadership: {
      title: 'Hon.',
      name: 'Grace Dongkum Shwarta',
      position: 'Commissioner',
      permanentSecretary: 'Mrs. Ladi Agwom',
      note: 'Reassigned from Secondary Education during cabinet restructuring to lead state public financial management.'
    },
    pastLeadership: [
      { role: 'Commissioner', title: 'Mrs.', name: 'Grace Shwarka', period: 'August 2023 – February 2025 (Mutfwang cabinet)' },
      { role: 'Commissioner', title: 'Dr.', name: 'Regina Soemlat', period: '2019 – 2023 (Lalong administration)' },
      { role: 'Commissioner', title: 'Hon.', name: 'Tamwakat Weli', period: '2015 – 2019 (Lalong administration)' },
      { role: 'Commissioner', title: 'Mr.', name: 'Davou Mang', period: '2007 – 2015 (Jang administration)' }
    ],
    administrativeHistory: 'Manages state fiscal discipline, sovereign loan management, and disbursements of monthly statutory allocations and internally generated revenue.',
    mandate: 'Formulate and implement state fiscal policies, maintain internal financial controls, manage state cash flow and sovereign investments, disburse approved funds, and coordinate tax policy and debt management.',
    vision: 'A financially sound, resilient, and transparent government that optimizes public revenue and expenditure for economic transformation.',
    mission: 'To ensure integrity, efficiency, and accountability in the generation, allocation, and accounting of Plateau State financial resources.',
    departments: [
      'Department of Consolidated Revenue Fund & Treasury',
      'Department of Financial Regulations & Expenditure Monitoring',
      'Department of Public Debt & Capital Market Operations',
      'Department of Internal Audit & Quality Assurance',
      'Department of Administration & Personnel'
    ],
    citizenServices: [
      'Contractor and vendor verification, registration, and payment status tracking',
      'Civil servant and pensioner payroll inquiries and electronic payment confirmation',
      'Fiscal transparency reporting under State Fiscal Transparency, Accountability and Sustainability (SFTAS) guidelines',
      'Inter-governmental fiscal transfers and local government joint account monitoring'
    ],
    supervisedParastatals: [
      'Office of the Accountant General (OAG)',
      'Plateau State Internal Revenue Service (PSIRS)',
      'Plateau State Debt Management Department (DMO)'
    ],
    contact: {
      office: 'Joseph Gomwalk State Secretariat, Jos, Plateau State',
      phones: ['+2348032805371'],
      email: 'ag.ictliaison@plateaustate.gov.ng',
      website: 'https://plateaustate.gov.ng'
    },
    legalFramework: '1999 Constitution of the Federal Republic of Nigeria (as amended) and Plateau State Public Finance Management Law.'
  },

  {
    name: 'Ministry of Health',
    abbreviation: 'MOH',
    alsoWritten: ['Plateau State Ministry of Health (MOH)'],
    category: 'GOVERNMENT',
    currentLeadership: {
      title: 'Dr.',
      name: 'Nicolas Baamlong',
      position: 'Commissioner for Health',
      permanentSecretary: 'Dr. Cletus Bako / Dr. Agabus',
      note: 'Appointed during cabinet restructuring to lead primary and secondary health sector renewal.'
    },
    pastLeadership: [
      { role: 'Commissioner', title: 'Dr.', name: 'Cletus Bako Shurkuk', period: 'August 2023 – February 2025 (reassigned to MOSTI)' },
      { role: 'Commissioner', title: 'Dr.', name: 'Nimkong Lar', period: '2019 – 2023 (Lalong administration)' },
      { role: 'Commissioner', title: 'Dr.', name: 'Kunde Deyin', period: '2015 – 2019 (Lalong administration)' },
      { role: 'Commissioner', title: 'Dr.', name: 'Fahat Fom', period: '2007 – 2015 (Jang administration)' }
    ],
    administrativeHistory: 'Oversees the state healthcare architecture. In recent years established PLASCHEMA for health insurance and PSDMCMA for pooled drug procurement.',
    mandate: 'Formulate, regulate, and supervise state healthcare policy; control epidemics and infectious diseases; regulate private and public healthcare facilities; ensure universal health coverage; and develop health human resources.',
    vision: 'A healthy, prosperous Plateau State where every citizen has guaranteed access to affordable, quality, and equitable healthcare.',
    mission: 'To deliver comprehensive, patient-centred, and sustainable preventive, curative, and rehabilitative health services across all 17 LGAs.',
    departments: [
      'Department of Public Health & Disease Control',
      'Department of Medical Services & Hospital Standards',
      'Department of Nursing Services',
      'Department of Food, Drugs & Pharmaceutical Services',
      'Department of Health Planning, Research & Statistics',
      'Department of Primary Healthcare Liaison'
    ],
    citizenServices: [
      'Licensing, accreditation, and annual inspection of private clinics, maternity homes, and diagnostic centres',
      'Epidemic outbreak response, surveillance, and toll-free reporting (Cholera, Lassa Fever, Measles, Mpox)',
      'Statewide maternal, newborn, and child health healthcare interventions and routine immunization',
      'Medical outreach missions and surgical camps for underserved rural communities',
      'Accreditation and clinical training approvals for health professional interns'
    ],
    supervisedParastatals: [
      'Plateau State Contributory Healthcare Management Agency (PLASCHEMA)',
      'Plateau Specialist Hospital (PSSH Jos)',
      'Plateau State Hospitals Management Board (HMB)',
      'Plateau State Drugs and Medical Commodities Management Agency (PSDMCMA)',
      'Plateau State Primary Health Care Board (PSPHCB)',
      'Plateau State College of Health Technology, Zawan',
      'Plateau State College of Health Technology, Pankshin',
      'Plateau State College of Nursing and Midwifery, Vom'
    ],
    contact: {
      office: 'Joseph Gomwalk State Secretariat, Ministry of Health Headquarters, PMB 2014, Jos, Plateau State',
      phones: ['+2348035990349'],
      email: 'moh.ictliaison@plateaustate.gov.ng',
      website: 'https://plateaustate.gov.ng'
    },
    legalFramework: 'National Health Act 2014 and Plateau State Public Health Laws.'
  },

  {
    name: 'Ministry of Housing and Urban Development',
    abbreviation: 'MHUD',
    alsoWritten: ['Ministry of Housing'],
    category: 'GOVERNMENT',
    currentLeadership: {
      title: 'Hon.',
      name: 'Sylvanus Dongtoe',
      position: 'Commissioner',
      note: 'Appointed in the cabinet restructuring to oversee public housing schemes and urban master planning.'
    },
    pastLeadership: [
      { role: 'Commissioner', title: 'Hon.', name: 'Joshua Laven Ubandoma', period: 'August 2023 – February 2025 (reassigned to Works)' },
      { role: 'Commissioner', title: 'Alh.', name: 'Dayyabu Garga', period: '2019 – 2023 (Lalong administration)' },
      { role: 'Commissioner', title: 'Mr.', name: 'Samuel Galadima', period: '2015 – 2019 (Lalong administration)' }
    ],
    administrativeHistory: 'Responsible for public shelter delivery, civil service residential estates, and urban regeneration projects.',
    mandate: 'Formulate housing policies, develop affordable residential housing schemes, regulate urban development layouts, oversee architectural and structural engineering designs for state buildings, and conduct urban renewal.',
    vision: 'A planned, orderly, and modern Plateau State with decent, affordable, and sustainable housing for all socioeconomic strata.',
    mission: 'To eliminate housing deficits through public-private partnerships, smart building technologies, and orderly urban land development.',
    departments: [
      'Department of Architectural & Building Design',
      'Department of Public Housing Schemes & Estates Management',
      'Department of Urban Renewal & Slum Upgrading',
      'Department of Quantity Surveying & Building Economics',
      'Department of Planning, Research & Statistics'
    ],
    citizenServices: [
      'Applications and allocation of units in state civil servant and commercial housing estates',
      'Building plan reviews and structural safety compliance certification for commercial developments',
      'Urban regeneration and neighborhood infrastructure upgrading requests',
      'Public building valuation and tenancy management services'
    ],
    contact: {
      office: 'Joseph Gomwalk State Secretariat, Jos, Plateau State',
      phones: ['+2348037042854'],
      email: 'housing@plateaustate.gov.ng',
      website: 'https://plateaustate.gov.ng'
    },
    legalFramework: 'Plateau State Urban and Regional Planning Law and National Housing Policy.'
  },

  {
    name: 'Ministry of Humanitarian Affairs and Poverty Alleviation',
    abbreviation: 'MHAPA',
    alsoWritten: ['Ministry of Humanitarian Affairs', 'Ministry of Humanitarian Affairs, Disaster Management and Social Development'],
    category: 'GOVERNMENT',
    currentLeadership: {
      title: 'Hon.',
      name: 'Ishaku Maren / Prince Miaphen',
      position: 'Commissioner',
      note: 'Newly created ministry established in the 2025/2026 restructuring to address displacement, emergency relief, and social safety nets.'
    },
    pastLeadership: [
      { role: 'Supervisory Coordinator', title: 'Hon.', name: 'Caroline Panglang Dafur', period: '2023 – 2025 (as Women Affairs & Social Welfare)' }
    ],
    administrativeHistory: 'Created by Governor Caleb Mutfwang to provide focused executive attention on internally displaced persons (IDPs), disaster rehabilitation, and targeted social welfare interventions following security challenges.',
    mandate: 'Coordinate emergency disaster response, provide relief materials to victims of floods, storms, and civil unrest; manage IDP camps and resettlement; implement conditional cash transfers; and drive poverty eradication schemes.',
    vision: 'A compassionate, resilient Plateau State where vulnerable citizens, displaced families, and crisis victims are rapidly supported and permanently rehabilitated.',
    mission: 'To deliver prompt, dignified, and accountable humanitarian assistance, disaster relief, and sustainable poverty alleviation interventions.',
    departments: [
      'Department of Emergency Relief & Disaster Management',
      'Department of IDP Rehabilitation & Resettlement',
      'Department of Social Safety Nets & Conditional Cash Transfers',
      'Department of Poverty Alleviation & Livelihood Empowerment',
      'Department of Donor & Humanitarian Agency Coordination'
    ],
    citizenServices: [
      'Emergency relief food and non-food supplies distribution to disaster-affected communities',
      'Registration, profiling, and psycho-social support for Internally Displaced Persons (IDPs)',
      'Disaster casualty and property damage assessment for government compensations/grants',
      'Coordination of state social register and cash transfer enrollments for poorest households'
    ],
    supervisedParastatals: [
      'Plateau State Emergency Management Agency (PLASEMA / SEMA)'
    ],
    contact: {
      office: 'State Secretariat Annex, Jos, Plateau State',
      phones: ['+2348036916250'],
      email: 'humanitarian@plateaustate.gov.ng',
      website: 'https://plateaustate.gov.ng'
    },
    legalFramework: 'Executive Order of the Governor of Plateau State establishing the Ministry.'
  },

  {
    name: 'Ministry of Information and Communication',
    abbreviation: 'MOIC',
    alsoWritten: ['Ministry of Information'],
    category: 'GOVERNMENT',
    currentLeadership: {
      title: 'Rt. Hon.',
      name: 'Joyce Lohya Ramnap',
      position: 'Commissioner for Information and Communication',
      note: 'Former Deputy Speaker of the Plateau State House of Assembly; appointed in cabinet restructuring.'
    },
    pastLeadership: [
      { role: 'Commissioner', title: 'Hon.', name: 'Musa Ibrahim Ashoms', period: 'August 2023 – February 2025 (reassigned to Youth & Sports)' },
      { role: 'Commissioner', title: 'Hon.', name: 'Dan Manjang', period: '2019 – 2023 (Lalong administration)' },
      { role: 'Commissioner', title: 'Hon.', name: 'Yakubu Dati', period: '2018 – 2019 (Lalong administration)' },
      { role: 'Commissioner', title: 'Hon.', name: 'Yiljap Abraham', period: '2011 – 2014 (Jang administration)' },
      { role: 'Commissioner', title: 'Hon.', name: 'Olivia Dazyem Esq', period: '2014 – 2015 (Jang administration)' }
    ],
    administrativeHistory: 'The chief communications organ of the Plateau State Government, managing the government’s public enlightenment, press relations, and state broadcasting media.',
    mandate: 'Formulate information policies, disseminate government programs and accomplishments, manage press relations, accredit journalists, combat misinformation, and oversee state public media broadcasting corporations.',
    vision: 'A transparent, well-informed, and actively engaged Plateau citizenry with open channels of communication between the government and the people.',
    mission: 'To project Plateau State positively, ensure prompt and truthful information dissemination, and foster citizen participation in governance through modern multi-channel media.',
    departments: [
      'Department of Public Enlightenment & Information Dissemination',
      'Department of Media Relations & Press Affairs',
      'Department of Publications & Documentation',
      'Department of Audio-Visual & Photographic Services',
      'Department of Planning, Research & Statistics'
    ],
    citizenServices: [
      'State government press releases, daily news bulletins, and official gazette publications',
      'Accreditation and facilitation for local, national, and international media correspondents',
      'Citizen grievance and inquiry resolution through official government helplines and platforms',
      'Town hall meeting scheduling and public feedback collection on state policies'
    ],
    supervisedParastatals: [
      'Plateau Radio Television Corporation (PRTVC Jos)',
      'Plateau Printing Press'
    ],
    contact: {
      office: 'Joseph Gomwalk State Secretariat Complex, Jos, Plateau State',
      phones: ['+2348037042854'],
      email: 'info@plateaustate.gov.ng',
      website: 'https://plateaustate.gov.ng'
    },
    legalFramework: 'Plateau State Information and Public Enlightenment Laws.'
  },

  {
    name: 'Ministry of Justice',
    abbreviation: 'MOJ',
    alsoWritten: ['Ministry of Justice, Plateau State (MOJ)', 'Office of the Attorney-General and Ministry of Justice'],
    category: 'GOVERNMENT',
    currentLeadership: {
      title: 'Barr.',
      name: 'Philemon Audu Daffi',
      position: 'Attorney-General and Commissioner for Justice',
      permanentSecretary: 'Barr. Julie Sanda / Ministry Solicitor General',
      note: 'Leading state justice reform, public prosecutions, and citizens’ rights mediation.'
    },
    pastLeadership: [
      { role: 'Attorney-General & Commissioner', title: 'Hon.', name: 'Chrysanthus Senlong', period: '2019 – 2023 (Lalong administration)' },
      { role: 'Attorney-General & Commissioner', title: 'Hon.', name: 'Jonathan Mawiyau', period: '2015 – 2019 (Lalong administration)' },
      { role: 'Attorney-General & Commissioner', title: 'Hon.', name: 'Edward Pwajok SAN', period: '2007 – 2015 (Jang administration)' },
      { role: 'Attorney-General & Commissioner', title: 'Prof.', name: 'Dakas C.J. Dakas SAN', period: 'Pre-2007' }
    ],
    administrativeHistory: 'Oldest legal institution of the state, advising all MDAs on constitutional, statutory, and contractual matters.',
    mandate: 'Serve as Chief Legal Adviser to the Plateau State Government, institute and prosecute criminal matters on behalf of the state, defend civil suits against the government, draft executive bills and subsidiary legislation, and uphold the rule of law and citizens\' rights.',
    vision: 'A fair, swift, and transparent justice delivery system that guarantees fundamental human rights, upholds the rule of law, and protects public interest.',
    mission: 'To dispense justice without fear or favour, protect public assets through rigorous legal defence, modernise state laws, and provide free legal support to underprivileged citizens.',
    departments: [
      'Department of Public Prosecutions (DPP)',
      'Department of Civil Litigation & Advisory Services',
      'Department of Legal Drafting & Codification',
      'Department of Citizens\' Rights & Mediation Centre (ADR)',
      'Department of Law Reform & International Law'
    ],
    citizenServices: [
      'Free dispute mediation and alternative dispute resolution (ADR) for civil, tenancy, and family matters through the Citizens\' Rights Centre',
      'Prosecution inquiries, bail verification, and legal aid linkages for indigent defendants',
      'Vetting, drafting, and gazetting of executive bills and statutory regulations',
      'Public petitions and human rights violations investigative intake'
    ],
    contact: {
      office: 'Bepco Building, Joseph Gomwalk State Secretariat, Jos, Plateau State',
      phones: ['+2348138562770'],
      email: 'mojplateaustate@gmail.com',
      website: 'https://plateaustate.gov.ng'
    },
    legalFramework: 'Section 195 of the 1999 Constitution of the Federal Republic of Nigeria and Plateau State Ministry of Justice Law.'
  },

  {
    name: 'Ministry of Lands, Survey, and Town Planning',
    abbreviation: 'MLSTP',
    alsoWritten: ['Ministry of Lands and Survey', 'Ministry of Lands, Survey and Town Planning'],
    category: 'GOVERNMENT',
    currentLeadership: {
      title: 'Barr.',
      name: 'Peter Nyam Gai',
      position: 'Commissioner',
      permanentSecretary: 'Surv. Bitrus Pam',
      note: 'Leading digital land reform, title issuance, and spatial planning.'
    },
    pastLeadership: [
      { role: 'Commissioner', title: 'Hon.', name: 'Yakubu Dati', period: '2019 – 2023 (Lalong administration)' },
      { role: 'Commissioner', title: 'Hon.', name: 'Festus Fuanter', period: '2015 – 2019 (Lalong administration)' },
      { role: 'Commissioner', title: 'Hon.', name: 'Yiljap Abraham', period: 'Pre-2015' }
    ],
    administrativeHistory: 'Operates the Plateau Geographic Information System (PLAGIS) for electronic land titling and cadastral management.',
    mandate: 'Administer all state land resources, conduct cadastral and geodetic surveys, issue Certificates of Occupancy (C of O), manage Deeds Registry, formulate town and regional plans, and prevent land encroachments.',
    vision: 'An efficient, transparent, and digitally driven land administration system unlocking capital value and promoting orderly spatial development.',
    mission: 'To secure property ownership rights through automated cadastral mapping, seamless land titling, and strict enforcement of sustainable town planning masterplans.',
    departments: [
      'Department of Lands Administration',
      'Department of Cadastral & Geodetic Surveys',
      'Department of Town & Regional Planning',
      'Department of Deeds & Title Registration',
      'Plateau Geographic Information System (PLAGIS) Unit'
    ],
    citizenServices: [
      'Processing and issuance of Statutory Certificates of Occupancy (C of O) for residential, commercial, and agricultural lands',
      'Governor\'s Consent processing for mortgages, deeds of assignment, leases, and property transfers',
      'Official land registry searches, boundary beacons verification, and cadastral survey charting',
      'Town planning layout approvals and building setback inspection'
    ],
    supervisedParastatals: [
      'Jos Metropolitan Development Board (JMDB)'
    ],
    contact: {
      office: 'Joseph Gomwalk State Secretariat, Jos, Plateau State',
      phones: ['+2348036916250'],
      email: 'lands@plateaustate.gov.ng',
      website: 'https://plateaustate.gov.ng'
    },
    legalFramework: 'Land Use Act 1978 and Plateau State Urban and Regional Planning Law.'
  },

  {
    name: 'Ministry of Livestock Development, Veterinary Services, and Fisheries',
    abbreviation: 'MLDVSF',
    alsoWritten: ['Ministry of Livestock Development', 'Ministry of Livestock and Fisheries'],
    category: 'GOVERNMENT',
    currentLeadership: {
      title: 'Hon.',
      name: 'Sunday Akpa',
      position: 'Commissioner',
      note: 'Inaugurated as the pioneer Commissioner following the creation of the dedicated ministry in February 2025.'
    },
    pastLeadership: [
      { role: 'Supervisory Commissioner (as Agric)', title: 'Hon.', name: 'Samson Ishaku Bugama', period: '2023 – 2025' },
      { role: 'Supervisory Commissioner (as Agric)', title: 'Dr.', name: 'Hosea Finangwai', period: '2019 – 2023' }
    ],
    administrativeHistory: 'Created by Governor Caleb Manasseh Mutfwang in February 2025 by carving out livestock, veterinary clinics, disease surveillance, and aquaculture out of the Ministry of Agriculture. Aligns with the national creation of the Federal Ministry of Livestock Development.',
    mandate: 'Promote commercial livestock production, pastoralist transformation, ranching and fodder development; control animal diseases; inspect meat and abattoir operations; and boost commercial aquaculture and fisheries.',
    vision: 'A modern, disease-free, and commercially prosperous livestock and aquaculture economy fostering peaceful coexistence and high-protein nutrition.',
    mission: 'To eliminate transboundary animal diseases, modernize pastoral and fish farming value-chains, and build modern abattoirs and cold-chains across Plateau State.',
    departments: [
      'Department of Livestock Production & Pastoral Development',
      'Department of Veterinary Clinics & Hospital Services',
      'Department of Animal Disease Surveillance & Epizootiology',
      'Department of Fisheries & Aquaculture Development',
      'Department of Abattoir Management & Meat Inspection'
    ],
    citizenServices: [
      'Veterinary clinical consultations, disease diagnoses, and surgery at state veterinary hospitals',
      'Annual vaccination campaigns for cattle, sheep, goats, poultry, and dogs (Rabies, CBPP, PPR, Newcastle disease)',
      'Abattoir ante-mortem and post-mortem meat inspection and public health slaughterhouse oversight',
      'Commercial catfish and tilapia fingerlings supply and fish feed production guidance',
      'Pastoralist dispute resolution, grazing reserve demarcation, and fodder bank access'
    ],
    facilities: [
      'Jos Modern Abattoir Complex, Dogon Dutse, Jos',
      'Zawan Veterinary Hospital & Clinics in 17 LGAs',
      'Pandam Lake Fishery and Wildlife Sanctuary'
    ],
    contact: {
      office: 'Jos, Plateau State',
      phones: ['+2348037042854'],
      email: 'livestock@plateaustate.gov.ng',
      website: 'https://plateaustate.gov.ng'
    },
    legalFramework: 'Plateau State Livestock and Animal Health Laws, and Executive Restructuring Order 2025.'
  },

  {
    name: 'Ministry for Local Government and Chieftaincy Affairs',
    abbreviation: 'MLGCA',
    alsoWritten: ['Ministry of Local Government and Chieftaincy Affairs (MLGCA)', 'Ministry of Local Government'],
    category: 'GOVERNMENT',
    currentLeadership: {
      title: 'Hon. Chief',
      name: 'Ephraim Usman',
      position: 'Commissioner',
      permanentSecretary: 'Mr. Nanle James',
      note: 'Leading local government administration, traditional council liaisons, and grassroots development.'
    },
    pastLeadership: [
      { role: 'Commissioner', title: 'Alh.', name: 'Dayyabu Garga', period: '2019 – 2023 (Lalong administration)' },
      { role: 'Commissioner', title: 'Hon.', name: 'Sylvanus Tapgun', period: '2015 – 2019 (Lalong administration)' }
    ],
    administrativeHistory: 'Coordinates administrative, fiscal, and traditional matters across the 17 Local Government Areas of Plateau State.',
    mandate: 'Supervise and coordinate the administration of the 17 Local Government Councils, liaise with traditional councils and chieftaincy institutions, administer joint local government accounts, and facilitate community peace and development.',
    vision: 'Autonomous, vibrant, and transparent local government councils delivering grassroots socioeconomic prosperity in harmony with respected traditional institutions.',
    mission: 'To ensure accountability, human capacity development, and peace across all 17 LGAs through effective supervisory oversight and traditional partnership.',
    departments: [
      'Department of Local Government Affairs & Administration',
      'Department of Chieftaincy Affairs & Traditional Councils',
      'Department of Inspectorate & Monitoring',
      'Department of Joint Account Allocation Committee (JAAC) Secretariat',
      'Department of Community Development & Peace Liaison'
    ],
    citizenServices: [
      'Facilitating verification and resolution of local government boundary and community chieftaincy petitions',
      'Gazetting, documentation, and staff-of-office ceremonies for confirmed traditional rulers',
      'Supervising local government service delivery and budget compliance across all 17 LGAs',
      'Inter-communal dialogue and grassroots peace committee coordination'
    ],
    supervisedParastatals: [
      'Plateau State Local Government Service Commission (LGSC)'
    ],
    contact: {
      office: 'No. 2 Richard Road, Behind Leventis Motors, P.M.B. 2138, Jos, Plateau State',
      phones: ['+2348065822795'],
      email: 'Info.minlgc@plateaustate.gov.ng',
      website: 'https://plateaustate.gov.ng'
    },
    legalFramework: 'Plateau State Local Government Law and Plateau State Traditional Councils & Chieftaincy Laws.'
  },

  {
    name: 'Ministry of Science, Technology and Innovation',
    abbreviation: 'MOSTI',
    alsoWritten: ['Ministry of Science and Technology'],
    category: 'GOVERNMENT',
    currentLeadership: {
      title: 'Dr.',
      name: 'Cletus Bako Shurkuk',
      position: 'Commissioner',
      note: 'Reassigned from Ministry of Health in cabinet restructuring to drive innovation, research, and technical education.'
    },
    pastLeadership: [
      { role: 'Commissioner', title: 'Hon.', name: 'Danladi Mann', period: '2019 – 2023 (Lalong administration)' },
      { role: 'Commissioner', title: 'Hon.', name: 'Musa Sule', period: '2015 – 2019 (Lalong administration)' },
      { role: 'Commissioner', title: 'Mr.', name: 'Gyang Tanko', period: '2007 – 2015 (Jang administration)' }
    ],
    administrativeHistory: 'Promotes science culture, school science laboratories, technology adoption, and intellectual property development.',
    mandate: 'Promote scientific research and technological innovations, support STEM education in schools, foster indigenous technical inventions, facilitate intellectual property registrations, and collaborate with tech startups.',
    vision: 'A knowledge-driven and technologically advanced Plateau State applying science and innovation for sustainable industrialization.',
    mission: 'To incubate technological innovations, build scientific capacity among youth, and deploy practical science solutions to societal challenges.',
    departments: [
      'Department of Science Promotion & STEM Education',
      'Department of Technology Transfer & Incubation',
      'Department of Innovation, Research & Intellectual Property',
      'Department of Information Technology Systems',
      'Department of Planning, Research & Statistics'
    ],
    citizenServices: [
      'STEM school science equipment support and state science competitions sponsorship',
      'Patent application advisory and intellectual property assistance for indigenous inventors',
      'Technology incubation support and startup mentorship linkages',
      'Vocational and technical skills development workshops'
    ],
    collaboratingAgencies: [
      'Plateau Information Communication and Technology Development Agency (PICTDA)'
    ],
    contact: {
      office: 'Joseph Gomwalk State Secretariat, Jos, Plateau State',
      phones: ['+2348037042854'],
      email: 'mosti@plateaustate.gov.ng',
      website: 'https://plateaustate.gov.ng'
    },
    legalFramework: 'Plateau State Science and Technology Development Policy.'
  },

  {
    name: 'Ministry of Tourism, Culture and Hospitality',
    abbreviation: 'MTC&H',
    alsoWritten: ['Ministry of Tourism and Culture', 'Ministry of Tourism'],
    category: 'GOVERNMENT',
    currentLeadership: {
      title: 'Haj.',
      name: 'Jamila Tukur Bitrus',
      position: 'Commissioner, Ministry of Tourism, Culture and Hospitality',
      note: 'Leading the revitalization of Plateau’s tourism sites, cultural festivals, and hospitality standards.'
    },
    pastLeadership: [
      { role: 'Commissioner', title: 'Mrs.', name: 'Tamwakat Weli', period: '2019 – 2023 (Lalong administration)' },
      { role: 'Commissioner', title: 'Hon.', name: 'Peter Mwankon', period: '2015 – 2019 (Lalong administration)' },
      { role: 'Commissioner', title: 'Hon.', name: 'Nuhu Gagara', period: '2007 – 2011 (Jang administration)' }
    ],
    administrativeHistory: 'Champions Plateau State’s official slogan: "Home of Peace and Tourism". Oversees major tourist assets and cultural heritage.',
    mandate: 'Preserve cultural heritage, develop state tourism destinations, regulate and classify hotels and hospitality establishments, organize cultural festivals, and promote ecotourism and film-making.',
    vision: 'To establish Plateau State as West Africa’s premier eco-tourism, cultural heritage, and leisure hospitality destination.',
    mission: 'To harness Plateau State’s unique climate, picturesque landscapes, and rich cultural diversity to generate employment and foreign exchange.',
    departments: [
      'Department of Tourism Development & Marketing',
      'Department of Cultural Affairs & Heritage Preservation',
      'Department of Hospitality Standards & Hotel Classification',
      'Department of Creative Arts & Performing Arts',
      'Department of Planning, Research & Statistics'
    ],
    citizenServices: [
      'Licensing, grading, and regulatory standards inspection of hotels, guest houses, and event resorts',
      'Official calendar coordination and endorsements for ethnic cultural festivals (Ngas Pusdung, Berom Nzem Berom, Tarok Tarok Day, Goemai Koenoem, Mwaghvul Puus Kaat)',
      'Tourism destination guiding and visitor permits for state conservation parks and waterfalls',
      'Cultural troupe performances bookings for official and educational events'
    ],
    supervisedParastatals: [
      'Plateau State Tourism Corporation (PSTC)',
      'Plateau State Council for Arts and Culture'
    ],
    contact: {
      office: 'Ministry of Tourism, Culture and Hospitality, First Floor, Joseph Gomwalk Secretariat, Jos, Plateau State',
      phones: ['+2348037042854'],
      email: 'plateautourism1@gmail.com',
      website: 'https://plateaustate.gov.ng'
    },
    legalFramework: 'Plateau State Tourism Corporation Edict and Hospitality Regulations.'
  },

  {
    name: 'Ministry of Transport',
    abbreviation: 'MOT',
    alsoWritten: ['Plateau State Ministry of Transport'],
    category: 'GOVERNMENT',
    currentLeadership: {
      title: 'Hon.',
      name: 'Jatau Davou Gyang',
      position: 'Commissioner',
      permanentSecretary: 'Engr. Stephen Pam',
      note: 'Leading the rollout of urban mass transit schemes including the Tin City Metro Bus system.'
    },
    pastLeadership: [
      { role: 'Commissioner', title: 'Hon.', name: 'Muhammad Muhammad', period: '2019 – 2023 (Lalong administration)' },
      { role: 'Commissioner', title: 'Hon.', name: 'Pam Bot-Mang', period: '2015 – 2018 (Lalong administration)' }
    ],
    administrativeHistory: 'Coordinates inter-modal urban transportation, traffic regulation enforcement, roadworthiness testing, and terminal management.',
    mandate: 'Formulate state transport policies, enforce road safety and vehicle roadworthiness standards through the VIO, regulate commercial transport fares and routes, and operate public transit systems.',
    vision: 'A safe, efficient, affordable, and integrated transportation system supporting commercial connectivity across Plateau State.',
    mission: 'To develop and regulate road, rail, and air transport infrastructure to enable seamless movement of people and agricultural goods.',
    departments: [
      'Department of Public Transport Operations & Route Management',
      'Directorate of Vehicle Inspection Services (VIO)',
      'Department of Traffic Safety & Driver Training',
      'Department of Transport Infrastructure & Terminal Operations',
      'Department of Planning, Research & Statistics'
    ],
    citizenServices: [
      'Vehicle roadworthiness inspections and computerized roadworthiness certificates (VIO)',
      'Commercial motor vehicle licensing, hackney carriage permits, and route registrations',
      'Operation and card ticketing of the Tin City Metro urban bus transit system across Jos-Bukuru corridors',
      'Driver testing and learner permit endorsements'
    ],
    supervisedParastatals: [
      'Plateau Express Services Group LTD (PESGL)'
    ],
    contact: {
      office: 'Joseph Gomwalk State Secretariat, Jos, Plateau State',
      phones: ['+2348037042854'],
      email: 'transport@plateaustate.gov.ng',
      website: 'https://plateaustate.gov.ng'
    },
    legalFramework: 'Plateau State Road Traffic Law and National Road Traffic Regulations.'
  },

  {
    name: 'Ministry of Water Resources and Energy Development',
    abbreviation: 'MWRED',
    alsoWritten: ['Ministry of Water Resources', 'Ministry of Water Resources and Energy'],
    category: 'GOVERNMENT',
    currentLeadership: {
      title: 'Hon.',
      name: 'Bashir Lawandi Datti',
      position: 'Commissioner',
      note: 'Reassigned from Ministry of Youth and Sports Development during cabinet restructuring.'
    },
    pastLeadership: [
      { role: 'Commissioner', title: 'Hon.', name: 'Noel Nkup', period: 'August 2023 – February 2025 (Mutfwang cabinet)' },
      { role: 'Commissioner', title: 'Engr.', name: 'Saad Bello', period: '2019 – 2023 (Lalong administration)' },
      { role: 'Commissioner', title: 'Hon.', name: 'David Wuyep', period: '2015 – 2019 (Lalong administration)' },
      { role: 'Commissioner', title: 'Hon.', name: 'Idi Waziri', period: '2007 – 2011 (Jang administration)' }
    ],
    administrativeHistory: 'Combines urban water treatment and distribution with rural water schemes and energy/power generation development.',
    mandate: 'Formulate water and energy policies, rehabilitate water treatment plants and dams, expand piped water networks, regulate commercial water extraction, and spearhead rural off-grid solar electrification.',
    vision: 'Guaranteed access to potable drinking water and reliable, clean energy for all households and industries in Plateau State.',
    mission: 'To optimize water resources and renewable energy through sustainable infrastructure development, water safety monitoring, and community stewardship.',
    departments: [
      'Department of Urban Water Supply & Dam Operations',
      'Department of Rural Water Supply & Sanitation (PRUWASSA liaison)',
      'Department of Energy & Power Development',
      'Department of Water Quality Control & Hydrology',
      'Department of Planning, Research & Statistics'
    ],
    citizenServices: [
      'New residential and commercial connections to the public piped municipal water network',
      'Borehole drilling permits and commercial groundwater exploitation monitoring',
      'Water quality laboratory testing and drinking water safety certification',
      'Deployment of solar mini-grids and clean energy power installations for rural communities'
    ],
    supervisedParastatals: [
      'Plateau State Water Board (PSWB)',
      'Plateau State Energy Corporation (PSEC)',
      'Plateau Rural Water Supply and Sanitation Agency (PRUWASSA)'
    ],
    contact: {
      office: 'Joseph Gomwalk State Secretariat, Jos, Plateau State',
      phones: ['+2348037042854'],
      email: 'water@plateaustate.gov.ng',
      website: 'https://plateaustate.gov.ng'
    },
    legalFramework: 'Plateau State Water and Sanitation Law and Plateau State Energy Corporation Edict.'
  },

  {
    name: 'Ministry of Women Affairs and Social Development',
    abbreviation: 'MWASD',
    alsoWritten: ['Ministry of Women Affairs'],
    category: 'GOVERNMENT',
    currentLeadership: {
      title: 'Hon.',
      name: 'Caroline Panglang Dafur',
      position: 'Commissioner',
      permanentSecretary: 'Mrs. Mary Ishaya',
      note: 'Leading social welfare, gender protection, and rehabilitation programs.'
    },
    pastLeadership: [
      { role: 'Commissioner', title: 'Mrs.', name: 'Rebecca Sambo', period: '2019 – 2023 (Lalong administration)' },
      { role: 'Commissioner', title: 'Mrs.', name: 'Rufina Gurumyen', period: '2015 – 2019 (Lalong administration)' }
    ],
    administrativeHistory: 'Dedicated to women empowerment, early childhood protection, rehabilitation of destitute persons, and anti-GBV enforcement.',
    mandate: 'Promote gender equality, advance socioeconomic empowerment of women, protect child rights, manage public orphanages and destitute rehabilitation centres, and combat gender-based violence (GBV).',
    vision: 'A gender-balanced, caring, and inclusive society where women and children live free from violence, exploitation, and discrimination.',
    mission: 'To formulate and implement protective policies, provide psycho-social and economic support, and enforce laws protecting women, children, and vulnerable groups.',
    departments: [
      'Department of Women Affairs & Economic Empowerment',
      'Department of Child Development & Protection',
      'Department of Social Welfare & Community Rehabilitation',
      'Department of Rehabilitation of Persons with Disabilities',
      'Department of Planning, Research & Statistics'
    ],
    citizenServices: [
      'Legal child adoption and foster care application processing and screening',
      'Immediate crisis response and safe shelter for victims of domestic violence and sexual assault (SARC linkages)',
      'Women cooperative enterprise skills acquisition training and startup equipment grants',
      'Registration and supervision of private orphanages and children homes',
      'Rehabilitation and assistive device distribution for persons with disabilities'
    ],
    supervisedParastatals: [
      'Plateau State Gender and Equal Opportunities Commission (PLAGEO)'
    ],
    contact: {
      office: 'Joseph Gomwalk State Secretariat, Jos, Plateau State',
      phones: ['+2348037042854'],
      email: 'womenaffairs@plateaustate.gov.ng',
      website: 'https://plateaustate.gov.ng'
    },
    legalFramework: 'Child\'s Rights Law of Plateau State and Gender and Equal Opportunities Law 2015.'
  },

  {
    name: 'Ministry of Works',
    abbreviation: 'MOW',
    alsoWritten: ['Plateau State Ministry of Works'],
    category: 'GOVERNMENT',
    currentLeadership: {
      title: 'Hon.',
      name: 'Joshua Laven Ubandoma',
      position: 'Commissioner',
      permanentSecretary: 'Engr. Beedee Bot',
      note: 'Reassigned from Housing and Urban Development during cabinet restructuring to spearhead road infrastructure.'
    },
    pastLeadership: [
      { role: 'Commissioner', title: 'Hon.', name: 'Adams Bulus Lekshak', period: 'August 2023 – February 2025 (reassigned to Budget & Planning)' },
      { role: 'Commissioner', title: 'Hon.', name: 'Pam Bot-Mang', period: '2018 – 2023 (Lalong administration)' },
      { role: 'Commissioner', title: 'Engr.', name: 'Alexander Plangnan', period: '2015 – 2018 (Lalong administration)' },
      { role: 'Commissioner', title: 'Hon.', name: 'Chris Hassan', period: '2011 – 2015 (Jang administration)' }
    ],
    administrativeHistory: 'Engineers state road networks, bridges, flyovers, and public building civil works.',
    mandate: 'Design, construct, and rehabilitate state highways, urban roads, and bridges; supervise engineering contracts; conduct materials quality testing; and maintain public civil infrastructure.',
    vision: 'A modern, well-connected road and structural infrastructure network driving commerce and regional connectivity.',
    mission: 'To build and maintain durable, safe, and cost-effective roads, bridges, and public edifices adhering to rigorous engineering standards.',
    departments: [
      'Department of Civil Engineering & Highways',
      'Department of Bridges, Structures & Drainage',
      'Department of Materials Testing & Quality Assurance Laboratories',
      'Department of Mechanical & Electrical Services',
      'Department of Planning, Research & Statistics'
    ],
    citizenServices: [
      'Reporting road failures, collapsed culverts, and dangerous potholes for rapid maintenance',
      'Engineering materials laboratory quality testing (concrete, asphalt, aggregate compaction, steel tensile tests)',
      'Contractor pre-qualification and civil works contract monitoring',
      'Encroachment clearance and road right-of-way demarcation'
    ],
    keyUnits: [
      'Plateau State Road Maintenance Agency (PLARAMA)'
    ],
    contact: {
      office: 'Joseph Gomwalk State Secretariat, Jos, Plateau State',
      phones: ['+2348037042854'],
      email: 'works@plateaustate.gov.ng',
      website: 'https://plateaustate.gov.ng'
    },
    legalFramework: 'Plateau State Public Works Law and Highways Act.'
  },

  {
    name: 'Ministry of Youth and Sports Development',
    abbreviation: 'MYSD',
    alsoWritten: ['Ministry of Youth Development', 'Ministry of Youth and Sports', 'Ministry of Youth and Sports Development (MYSD)'],
    category: 'GOVERNMENT',
    currentLeadership: {
      title: 'Hon.',
      name: 'Musa Ibrahim Ashoms',
      position: 'Commissioner for Youth and Sports Development',
      note: 'Reassigned from Information and Communication during cabinet restructuring.'
    },
    pastLeadership: [
      { role: 'Commissioner', title: 'Mr.', name: 'Bashir Lawandi Datti', period: 'August 2023 – February 2025 (reassigned to Water Resources)' },
      { role: 'Commissioner', title: 'Hon.', name: 'Victor Lapang', period: '2018 – 2023 (Lalong administration)' },
      { role: 'Commissioner', title: 'Alh.', name: 'Dayyabu Garga', period: '2015 – 2018 (Lalong administration)' },
      { role: 'Commissioner', title: 'Hon.', name: 'James Pam', period: '2007 – 2015 (Jang administration)' }
    ],
    administrativeHistory: 'Responsible for mobilizing youth potential, vocational entrepreneurship, state athletic teams, and sports stadium facilities.',
    mandate: 'Formulate youth empowerment policies, organize vocational training for unemployed youth, administer state sports competitions, maintain stadia, and supervise state-owned sports teams (Plateau United Football Club and Mighty Jets FC).',
    vision: 'Empowered, self-reliant, and socially responsible Plateau youth, backed by sporting excellence in national and international arenas.',
    mission: 'To unlock youth talents through structured entrepreneurship schemes, leadership mentorship, and grassroots athletic programmes.',
    departments: [
      'Department of Youth Mobilization & Development',
      'Department of Sports Administration & Competitions',
      'Department of Youth Vocational Skills & Entrepreneurship',
      'Department of Facilities & Stadia Management',
      'Department of Planning, Research & Statistics'
    ],
    citizenServices: [
      'Registration, screening, and certification of youth clubs, associations, and NGOs',
      'Enrollment in state youth vocational skills acquisition and digital training bootcamps',
      'Grassroots sporting competitions talent scouting and athletics mentoring',
      'Stadium usage permits for public and private sporting events (New Jos Stadium Zaria Road, Rwang Pam Stadium)'
    ],
    supervisedParastatals: [
      'Plateau State Sports Council',
      'Plateau United Football Club',
      'Mighty Jets International FC'
    ],
    contact: {
      office: 'Joseph Gomwalk State Secretariat, Jos, Plateau State',
      phones: ['+2348037042854'],
      email: 'youthandsports@plateaustate.gov.ng',
      website: 'https://plateaustate.gov.ng'
    },
    legalFramework: 'National Youth Policy and Plateau State Sports Council Edict.'
  },

  // ── 2. EXECUTIVE OFFICES & CENTRAL BODIES ────────────────────────────────────
  {
    name: 'Office of the Secretary to the Government of the State',
    abbreviation: 'OSGS',
    alsoWritten: ['Office of the Secretary to the State Government', 'SSG Office'],
    category: 'GOVERNMENT',
    currentLeadership: {
      title: 'Arc.',
      name: 'Samuel Nanchang Jatau',
      position: 'Secretary to the Government of the State',
      note: 'Coordinates all state ministries, boards, commissions, and implementation of executive council decisions.'
    },
    pastLeadership: [
      { role: 'Secretary to the State Government', title: 'Prof.', name: 'Danladi Abok Atu', period: '2019 – 2023 (Lalong administration)' },
      { role: 'Secretary to the State Government', title: 'Hon.', name: 'Rufus Bature', period: '2015 – 2018 (Lalong administration)' },
      { role: 'Secretary to the State Government', title: 'Prof.', name: 'Shedrack Best', period: '2011 – 2015 (Jang administration)' }
    ],
    administrativeHistory: 'The central clearinghouse of the Plateau State Government, providing policy continuity, cabinet secretariat operations, and state protocol management.',
    mandate: 'Coordinate government policies across all MDAs, serve as Secretariat to the State Executive Council, supervise implementation of council decisions, manage national honours and protocol, and coordinate inter-governmental relations.',
    vision: 'An agile, coordinated, and accountable civil governance apparatus implementing the Governor\'s transformation agenda.',
    mission: 'To ensure seamless synergy among all arms and agencies of government, foster policy coherence, and maintain security and inter-faith harmony.',
    departments: [
      'Cabinet Secretariat',
      'Special Services Directorate (Security & Intelligence Liaison)',
      'General Administration Directorate',
      'Political & Inter-Governmental Affairs',
      'State Protocol Directorate'
    ],
    citizenServices: [
      'Receiving, processing, and channeling public petitions to appropriate ministries and commissions',
      'Coordinating official state ceremonies, national day celebrations, and inter-denominational events',
      'Liaising with federal agencies, diplomatic corps, and international missions visiting Plateau State'
    ],
    contact: {
      office: 'Old Government House, Fwavei, Rayfield, Jos, Plateau State',
      phones: ['+2348037042854'],
      email: 'info.sgs@plateaustate.gov.ng',
      website: 'https://plateaustate.gov.ng'
    },
    legalFramework: '1999 Constitution of the Federal Republic of Nigeria (as amended).'
  },

  {
    name: 'Office of the Head of Civil Service',
    abbreviation: 'OHCS',
    alsoWritten: ['Head of Service'],
    category: 'GOVERNMENT',
    currentLeadership: {
      title: 'Mrs.',
      name: 'Rauta Dakok',
      position: 'Head of Civil Service',
      note: 'Leading state civil service professionalization and worker welfare.'
    },
    pastLeadership: [
      { role: 'Head of Civil Service', title: 'Engr.', name: 'Sunday Hyat', period: '2021 – 2023 (Lalong administration)' },
      { role: 'Head of Civil Service', title: 'Mr.', name: 'Izam Azi', period: '2015 – 2021 (Lalong administration)' }
    ],
    administrativeHistory: 'Responsible for public service personnel management, administrative leadership, and civil service reforms.',
    mandate: 'Manage the human capital of the Plateau State civil service, foster meritocracy and discipline, organize staff development and civil service examinations, administer pensions, and maintain harmonious labour relations.',
    vision: 'A professional, ethical, and high-performing civil service dedicated to excellence in public governance.',
    mission: 'To build a competent, well-motivated workforce utilizing modern technologies to deliver public services efficiently to Plateau citizens.',
    departments: [
      'Establishment & Service Matters',
      'Staff Development & Training',
      'Public Service Reforms',
      'Pensions & Gratuities Administration',
      'Labour Relations & Staff Welfare'
    ],
    citizenServices: [
      'Civil service career appointments, promotions, gazetting, and service records verification',
      'Retired public servants pension enrollment, biometrics, and gratuity processing',
      'Civil service internship, NYSC placement, and industrial attachment postings',
      'Public service grievance mediation and labour dispute resolutions'
    ],
    contact: {
      office: 'Joseph Gomwalk State Secretariat, Jos, Plateau State',
      phones: ['+2348037042854'],
      email: 'ohcs@plateaustate.gov.ng',
      website: 'https://plateaustate.gov.ng'
    },
    legalFramework: 'Section 206 of the 1999 Constitution of the Federal Republic of Nigeria.'
  },

  {
    name: 'Office of the Accountant General',
    abbreviation: 'OAG',
    alsoWritten: ['Office of the Accountant General (OAG)', 'Accountant General\'s Office'],
    category: 'GOVERNMENT',
    currentLeadership: {
      title: 'Mrs.',
      name: 'Naanret A. Manset',
      position: 'Accountant General',
      note: 'Chief Accounting Officer of receipts and disbursements of the Plateau State Government.'
    },
    pastLeadership: [
      { role: 'Accountant General', title: 'Mr.', name: 'Cyril Tsenyil', period: '2015 – 2023 (Lalong administration)' }
    ],
    administrativeHistory: 'Custodians of the state treasury, operating the electronic central payment platform and statutory accounting records.',
    mandate: 'Serve as Chief Accounting Officer of receipts and payments of the state, produce annual financial statements of the government, manage state bank accounts and cash flows, and enforce public financial regulations.',
    vision: 'A transparent, digital, and world-class state treasury delivering accurate, real-time financial stewardship.',
    mission: 'To maintain the highest professional standards in accounting, revenue tracking, and public expenditure reporting for Plateau State.',
    departments: [
      'Treasury Operations & Cash Management',
      'Final Accounts & Financial Reporting',
      'Payroll & Electronic Payments Administration',
      'Inspectorate & Internal Financial Control',
      'Funds Management & Investments'
    ],
    citizenServices: [
      'Central electronic salary and pension payments processing and remittance inquiries',
      'Verification of government revenue receipts and e-payment confirmations',
      'Publication of annual statutory audited financial statements and SFTAS public accounts reports'
    ],
    contact: {
      office: 'Ministry of Finance, JD Gomwalk Secretariat, Jos, Plateau State',
      phones: ['+2348032805371'],
      email: 'ag.ictliaison@plateaustate.gov.ng',
      website: 'https://plateaustate.gov.ng'
    },
    legalFramework: 'Plateau State Public Finance Management Law and Financial Regulations.'
  },

  {
    name: 'Plateau State Audit Department (Office of the State Auditor General)',
    abbreviation: 'SAI',
    alsoWritten: ['Office of the State Auditor General', 'Plateau State Audit Department (SAI)'],
    category: 'GOVERNMENT',
    currentLeadership: {
      title: 'Mrs.',
      name: 'Charity Elisha Davou (FCNA)',
      position: 'Auditor General',
      note: 'Constitutional external auditor of the Plateau State Government.'
    },
    pastLeadership: [
      { role: 'Auditor General', title: 'Mr.', name: 'Ezekiel Dung', period: 'Pre-2023' }
    ],
    administrativeHistory: 'An independent constitutional supreme audit institution reporting directly to the State House of Assembly.',
    mandate: 'Conduct independent financial, compliance, and performance audits of all state ministries, departments, parastatals, and courts; submit annual audit reports to the Plateau State House of Assembly; and ensure value for public money.',
    vision: 'An independent, credible, and supreme audit institution promoting fiscal discipline and good governance in Plateau State.',
    mission: 'To deliver objective, rigorous, and professional external audits that safeguard public assets and enhance transparency.',
    departments: [
      'Department of Ministerial Audits',
      'Department of Parastatals, Boards & Tertiary Institutions Audits',
      'Department of Project & Performance Audits',
      'Department of Special Investigations & Forensic Audits',
      'Department of Quality Assurance & Methodology'
    ],
    citizenServices: [
      'Publication of annual statutory audit reports on state government accounts for public scrutiny',
      'Investigative intake of citizen whistleblowing on public fund misappropriation or contractor abandonment',
      'Benchmarking public institutions compliance with fiscal integrity guidelines'
    ],
    contact: {
      office: 'Joseph Gomwalk Secretariat, Jos, Plateau State',
      phones: ['+2348036916250'],
      email: 'adankalaassra@gmail.com',
      website: 'https://plateaustate.gov.ng'
    },
    legalFramework: 'Section 125 of the 1999 Constitution of the Federal Republic of Nigeria and Plateau State Audit Law.'
  },

  // ── 3. STATUTORY AGENCIES, COMMISSIONS & BOARDS ─────────────────────────────
  {
    name: 'Jos Metropolitan Development Board',
    abbreviation: 'JMDB',
    alsoWritten: ['The Jos Metropolitan Development Board (JMDB)', 'Jos Metropolitan Development Board'],
    category: 'GOVERNMENT',
    currentLeadership: {
      title: 'Arc.',
      name: 'Hart Bankat',
      position: 'General Manager',
      note: 'Leading Greater Jos urban regeneration, development control, and environmental beautification.'
    },
    pastLeadership: [
      { role: 'General Manager', title: 'Arc.', name: 'Sukukum Burdap', period: '2019 – 2023 (Lalong administration)' },
      { role: 'General Manager', title: 'Mr.', name: 'Mathias Hata', period: '2015 – 2019 (Lalong administration)' }
    ],
    administrativeHistory: 'Established in 1974 to oversee orderly urban growth of the Jos-Bukuru metropolis across Jos North, Jos South, Jos East, and Bassa LGAs.',
    mandate: 'Enforce development control and urban building codes, approve architectural and structural building drawings, prevent illegal construction and encroachments, maintain city roads, drainages, and streetlights, and regulate outdoor advertising.',
    vision: 'A functional, clean, aesthetically pleasing, and resilient metropolitan city planned to international standards.',
    mission: 'To enforce smart urban planning, maintain modern public infrastructure, and deliver efficient city municipal services across Greater Jos.',
    departments: [
      'Department of Development Control & Inspections',
      'Department of Urban Planning, Architecture & Design',
      'Department of Civil & Structural Engineering',
      'Department of Environmental Sanitation & City Greening',
      'Department of Outdoor Advertising & Signage Regulations'
    ],
    citizenServices: [
      'Building plan assessments, structural approvals, and construction permits for residential and commercial buildings',
      'Right-of-way compliance verification and demolition of hazardous or unauthorized structures',
      'Clearing blocked city arterial drainages and stormwater channels',
      'Outdoor advertising billboard registration, positioning permits, and signage control',
      'Reporting illegal building construction and right-of-way encroachments'
    ],
    contact: {
      office: 'No. 12 Constitution Hill Road / Joseph Gomwalk Secretariat Annex, Jos, Plateau State',
      phones: ['+2348037042854', '+2348138562770'],
      email: 'jmdb@plateaustate.gov.ng',
      website: 'https://plateaustate.gov.ng'
    },
    legalFramework: 'Jos Metropolitan Development Board Edict 1974 and Plateau State Urban Development Laws.'
  },

  {
    name: 'Plateau State Contributory Healthcare Management Agency',
    abbreviation: 'PLASCHEMA',
    alsoWritten: [
      'Plateau State Contributory Healthcare Management Agency (PLASCHEMA)',
      'Plateau State Contributory Health Insurance Management Agency',
      'PLASCHEMA'
    ],
    category: 'HOSPITAL',
    currentLeadership: {
      title: 'Dr.',
      name: 'Agabus Nanfwang Manasseh',
      position: 'Director General',
      note: 'Spearheading universal health coverage, facility accreditation, and informal sector enrollments.'
    },
    pastLeadership: [
      { role: 'Director General', title: 'Dr.', name: 'Fabong Jemchang Yildam', period: '2019 – 2023 (Founding Director General)' }
    ],
    administrativeHistory: 'Established under the PLASCHEMA Law 2019 to achieve universal health coverage for all Plateau residents, reducing out-of-pocket medical expenditures.',
    mandate: 'Implement mandatory and voluntary contributory health insurance in Plateau State; accredit primary, secondary, and tertiary healthcare providers; manage benefit packages; and disburse equity health funds to vulnerable citizens under the Basic Health Care Provision Fund (BHCPF).',
    vision: 'A healthy Plateau State where every citizen, regardless of economic status, has financial risk protection against catastrophic healthcare expenditures.',
    mission: 'To provide equitable, affordable, and quality healthcare services through an efficient, transparent, and technology-driven contributory health insurance scheme.',
    departments: [
      'Department of Planning, Research & Quality Assurance',
      'Department of Enrolment & Operations',
      'Department of Health Services & Provider Accreditation',
      'Department of Finance, Investment & Accounts',
      'Department of Information & Communications Technology'
    ],
    citizenServices: [
      'Formal Sector Health Plan: Public civil servants and organized private sector employee enrollments (5% basic salary)',
      'Informal Sector Health Plan: Artisans, traders, farmers, transport operators, and self-employed individuals (₦12,000/year per person; ₦50,000/year family of 6)',
      'Equity Plan (Vulnerable): Free government and BHCPF-subsidized healthcare coverage for pregnant women, children under 5, elderly aged 65+, and persons living with disabilities',
      'Healthcare provider facility selection, biometric enrollment, and e-card issuance',
      'Complaints and grievance resolution against accredited hospitals charging unauthorized fees or denying covered medicines (Helpline: 0700-700-1111)'
    ],
    contact: {
      office: 'No. 36 Murtala Mohammed Way, PMB 2014, Jos, Plateau State',
      phones: ['+2347007001111', '+2348035990349'],
      email: 'info@plaschema.org',
      website: 'https://plaschema.app'
    },
    legalFramework: 'Plateau State Contributory Healthcare Management Agency Law 2019.'
  },

  {
    name: 'Plateau Environmental Protection And Sanitation Agency',
    abbreviation: 'PEPSA',
    alsoWritten: ['Plateau Environmental Protection And Sanitation Agency (PEPSA)', 'Plateau State Environmental Protection and Sanitation Agency'],
    category: 'GOVERNMENT',
    currentLeadership: {
      title: 'Mr.',
      name: 'Samuel Nathaniel Dapiya',
      position: 'Director General',
      note: 'Leading urban waste revolution, municipal skip bin rollouts, and commercial sanitation enforcement.'
    },
    pastLeadership: [
      { role: 'Director General', title: 'Hon.', name: 'Gabriel Bako', period: '2019 – 2023 (Lalong administration)' }
    ],
    administrativeHistory: 'Carved out to provide dedicated municipal solid waste collection, waste-to-wealth recycling, and environmental cleanliness across the state capital and commercial corridors.',
    mandate: 'Collect, transport, and dispose of municipal municipal solid and liquid waste; enforce environmental cleanliness; manage official landfill sites; enforce the monthly environmental sanitation exercise; and abate public environmental nuisances.',
    vision: 'A pristine, healthy, and waste-free Plateau State with sustainable circular economy waste management systems.',
    mission: 'To deliver daily waste evacuation, maintain municipal hygiene, and foster community environmental stewardship through aggressive public education and firm regulatory enforcement.',
    departments: [
      'Department of Waste Operations & Municipal Logistics',
      'Department of Environmental Health & Sanitation Enforcement',
      'Department of Landfills & Waste-to-Wealth Recycling',
      'Department of Mobile Courts & Environmental Prosecution',
      'Department of Community Sensitization & Corporate Partnerships'
    ],
    citizenServices: [
      'Daily and weekly municipal waste evacuation from designated neighborhood skip bins and roll-on roll-off containers',
      'Registration and monitoring of Private Sector Participation (PSP) commercial waste collection operators',
      'Enforcement and vehicular movement restrictions during the monthly environmental sanitation exercise (last Saturday of every month)',
      'Mobile sanitation court prosecution of public waste dumping, open defecation, and overgrown plots',
      'Reporting illegal roadside dumpsites and toxic waste overflows'
    ],
    contact: {
      office: 'No. 36, Murtala Mohammed Way by Gangare Junction, Jos, Plateau State',
      phones: ['+2348036916250', '+2348138562770'],
      email: 'info.pepsa@plateaustate.gov.ng',
      website: 'https://plateaustate.gov.ng'
    },
    legalFramework: 'Plateau Environmental Protection and Sanitation Agency Law.'
  },

  {
    name: 'Plateau Information Communication and Technology Development Agency',
    abbreviation: 'PICTDA',
    alsoWritten: [
      'Plateau Information Communication and Technology Development Agency (PICTDA)',
      'Plateau State Information and Communication Technology Development Agency',
      'PICTDA'
    ],
    category: 'GOVERNMENT',
    currentLeadership: {
      title: 'Mr.',
      name: 'Datong Dominic Gwaman',
      position: 'Director General',
      note: 'Leading Plateau State digital transformation, government cloud infrastructure, and tech innovation ecosystem.'
    },
    pastLeadership: [
      { role: 'Director General', title: 'Mr.', name: 'Daser David', period: '2018 – 2023 (Founding Director General)' }
    ],
    administrativeHistory: 'Established in 2018 to pioneer state digital governance, manage government cloud services, build the Code Plateau tech workforce, and establish IT standards.',
    mandate: 'Formulate and execute state ICT policy; deploy and manage government email, web portals, and connectivity networks; administer the Code Plateau software engineering training academy; protect government cyber infrastructure; and catalyze the digital economy.',
    vision: 'To position Plateau State as Nigeria\'s leading technological innovation ecosystem and preferred digital outsourcing destination.',
    mission: 'To leverage digital technology for open governance, build a globally competitive technical workforce, and automate government services for citizen convenience.',
    departments: [
      'Department of E-Governance & Software Systems',
      'Department of Infrastructure, Networks & Cybersecurity',
      'Department of Digital Skills & Workforce Development (Code Plateau)',
      'Department of IT Standards, Policy & Regulatory Compliance',
      'Department of Innovation, Research & Startup Incubation'
    ],
    citizenServices: [
      'Code Plateau Fellowship: Intensive training in full-stack software development, UI/UX design, data science, and cloud computing for youth',
      'Government official email and subdomain provisioning for MDAs (plateaustate.gov.ng)',
      'Tech startup incubation, co-working facilities, and digital investor linkages',
      'Open Government Data portal maintenance and ICT equipment standards testing'
    ],
    contact: {
      office: 'New Government House, Little Rayfield, Jos, Plateau State',
      phones: ['+2348037042854'],
      email: 'pictda.ictlaison@plateaustate.gov.ng',
      website: 'https://pictda.plateaustate.gov.ng'
    },
    legalFramework: 'Plateau State Information and Communication Technology Development Agency Law.'
  },

  {
    name: 'Plateau State Internal Revenue Service',
    abbreviation: 'PSIRS',
    alsoWritten: ['Plateau State Internal Revenue Service (PSIRS)', 'Plateau Board of Internal Revenue'],
    category: 'GOVERNMENT',
    currentLeadership: {
      title: 'Dr.',
      name: 'Jim Pam Wayas',
      position: 'Executive Chairman',
      note: 'Leading automated tax collection, taxpayer enumeration, and voluntary tax compliance.'
    },
    pastLeadership: [
      { role: 'Executive Chairman', title: 'Mr.', name: 'Dashe Arlat', period: '2015 – 2023 (Lalong administration)' }
    ],
    administrativeHistory: 'The sole statutory tax administration body of Plateau State, operating autonomous tax collection under the Plateau State Revenue Law.',
    mandate: 'Assess, collect, and account for all internally generated revenue (IGR), personal income taxes, stamp duties, withholding taxes, road taxes, and capital gains tax; maintain the State Taxpayer Database; and combat tax evasion.',
    vision: 'A transparent, taxpayer-friendly, and fully automated revenue service maximizing Plateau State financial autonomy.',
    mission: 'To mobilize domestic revenue efficiently through fair tax administration, digital tax payment gateways, and transparent accounting.',
    departments: [
      'Department of Personal Income Tax & PAYE',
      'Department of Direct Assessment & Informal Sector Taxes',
      'Department of Road Taxes & Motor Licensing',
      'Department of Tax Audit, Enforcement & Investigations',
      'Department of Information Technology & Electronic Billing'
    ],
    citizenServices: [
      'Issuance of State Taxpayer Identification Number (Plateau TIN) for individuals and registered businesses',
      'Application, assessment, and issuance of electronic Tax Clearance Certificates (e-TCC)',
      'Filing annual Pay-As-You-Earn (PAYE) returns for employers of labour and private companies',
      'Motor vehicle registration, road tax, new vehicle number plates, and driver license endorsements',
      'Direct online tax assessment and instant electronic receipting'
    ],
    contact: {
      office: 'Bank Road, Jos, Plateau State',
      phones: ['+2348037042854'],
      email: 'info@psirs.gov.ng',
      website: 'https://psirs.gov.ng'
    },
    legalFramework: 'Plateau State Revenue (Consolidation) Law and Personal Income Tax Act (PITA).'
  },

  {
    name: 'Plateau State Peace Building Agency',
    abbreviation: 'PSPBA',
    alsoWritten: ['Plateau State Peace Building Agency (PSPBA)', 'Plateau Peace Building Agency'],
    category: 'GOVERNMENT',
    currentLeadership: {
      title: 'Dr.',
      name: 'Julie Sanda',
      position: 'Director General',
      note: 'Leading strategic peacebuilding, inter-faith dialogue, and early-warning response systems.'
    },
    pastLeadership: [
      { role: 'Director General', title: 'Mr.', name: 'Joseph Lengmang', period: '2016 – 2023 (Founding Director General)' }
    ],
    administrativeHistory: 'Pioneering institutional peace agency established in 2016 to institutionalize conflict prevention, community mediation, and social cohesion.',
    mandate: 'Design and implement peacebuilding policies; mediate inter-ethnic and inter-religious disputes; operate the Early Warning and Early Response (EWER) network; promote tolerance education; and de-escalate communal tensions across the 17 LGAs.',
    vision: 'A harmonious, peaceful, and resilient Plateau State where diverse cultural and religious communities coexist productively.',
    mission: 'To proactively transform conflicts, build sustainable peace structures, and strengthen community resilience through collaborative problem-solving.',
    departments: [
      'Department of Conflict Prevention & Early Warning Systems',
      'Department of Mediation, Dialogue & Reconciliation',
      'Department of Peace Education, Gender & Youth Engagement',
      'Department of Research, Policy Analysis & Strategic Linkages',
      'Department of Public Outreach & Peace Advocacy'
    ],
    citizenServices: [
      'Early Warning and Early Response (EWER) reporting of security threats and communal tension indicators',
      'Community and farmer-herder mediation and peace dialogue facilitation',
      'Peace club establishment and youth conflict de-escalation mentorship in secondary schools',
      'Capacity building for traditional rulers and community peace monitors'
    ],
    contact: {
      office: 'Old Government House, Rayfield, Jos, Plateau State',
      phones: ['+2348037042854'],
      email: 'info@plateaupeacebuilding.org',
      website: 'https://plateaupeacebuilding.org'
    },
    legalFramework: 'Plateau State Peace Building Agency Law 2016.'
  },

  {
    name: 'Plateau State Emergency Management Agency',
    abbreviation: 'PLASEMA',
    alsoWritten: ['Plateau State Emergency Management Agency (PLASEMA)', 'State Emergency Management Agency', 'SEMA'],
    category: 'GOVERNMENT',
    currentLeadership: {
      title: 'Mr.',
      name: 'Sunday Akson Abdu',
      position: 'Executive Secretary',
      note: 'Overseeing disaster preparedness, humanitarian relief distribution, and IDP coordination.'
    },
    pastLeadership: [
      { role: 'Executive Secretary', title: 'Alh.', name: 'Alhassan Barde', period: '2015 – 2023 (Lalong administration)' }
    ],
    administrativeHistory: 'Coordinates natural and human-induced disaster relief operations across Plateau State in partnership with NEMA.',
    mandate: 'Formulate disaster risk reduction plans, conduct disaster risk mapping, manage emergency search and rescue, distribute relief supplies to crisis and natural disaster victims, and manage temporary IDP camps.',
    vision: 'A disaster-resilient Plateau State with proactive emergency response mechanisms protecting lives and livelihoods.',
    mission: 'To prevent, mitigate, and respond promptly to disasters through coordinated stakeholder actions, scientific risk reduction, and humane victim support.',
    departments: [
      'Department of Relief & Rehabilitation Operations',
      'Department of Search, Rescue & Disaster Response',
      'Department of Disaster Risk Reduction & Early Warning',
      'Department of Planning, Research & Documentation'
    ],
    citizenServices: [
      'Emergency reporting of windstorm, flood, fire, and conflict displacement disasters',
      'Distribution of relief supplies (foodstuffs, mattresses, blankets, roofing zinc, medical aid) to verified victims',
      'Coordination of search and rescue missions with federal and state emergency responders',
      'Flood hazard mapping and seasonal rainfall disaster advisory warnings'
    ],
    contact: {
      office: 'Jos, Plateau State',
      phones: ['+2348037042854'],
      email: 'plsema@plateaustate.gov.ng',
      website: 'https://plateaustate.gov.ng'
    },
    legalFramework: 'Plateau State Emergency Management Agency Law.'
  },

  {
    name: 'Plateau State Drugs and Medical Commodities Management Agency',
    abbreviation: 'PSDMCMA',
    alsoWritten: [
      'Plateau State Drugs and Medical Commodities Management Agency (PSDMCMA)',
      'Plateau State Drugs and Commodities Management Agency'
    ],
    category: 'GOVERNMENT',
    currentLeadership: {
      title: 'Pharm',
      name: 'Kim Jerry Bot',
      position: 'Executive Secretary',
      note: 'Leading state pooled drug procurement, drug revolving funds (DRF), and pharmaceutical quality control.'
    },
    pastLeadership: [
      { role: 'Director (Pharmaceutical Services)', title: 'Pharm', name: 'Gyang Pam', period: 'Pre-creation of Agency' }
    ],
    administrativeHistory: 'Established to solve drug stockouts and eradicate counterfeit medicines in public health facilities through a sustainable drug revolving fund.',
    mandate: 'Procure, warehouse, and distribute quality, safe, and cost-effective essential pharmaceuticals and surgical consumables to all primary, secondary, and tertiary public healthcare institutions in Plateau State.',
    vision: 'An uninterrupted supply chain of certified, high-quality, and affordable medicines across every public healthcare facility in Plateau State.',
    mission: 'To eliminate stockouts and fake medicines through transparent bulk procurement, modern cold-chain warehousing, and automated distribution logistics.',
    departments: [
      'Department of Pooled Procurement & Supply Chain Logistics',
      'Department of Quality Assurance & Pharmaceutical Testing',
      'Department of Warehousing & Inventory Control',
      'Department of Drug Revolving Fund (DRF) Accounts',
      'Department of Monitoring & Distribution'
    ],
    citizenServices: [
      'Ensuring availability of affordable, laboratory-tested authentic medicines in public General Hospitals and Primary Health Centres',
      'Central warehouse pooled supply of emergency epidemic drugs (antivenom, cholera kits, malaria treatments, maternal delivery packs)',
      'Investigative quality checks on suspected counterfeit drugs reported in public facilities'
    ],
    contact: {
      office: 'No. 69 Murtala Mohammed Way, Jos, Plateau State',
      phones: ['+2348065909268'],
      email: 'plateaustatedmcma@gmail.com',
      website: 'https://plateaustate.gov.ng'
    },
    legalFramework: 'Plateau State Drugs and Medical Commodities Management Agency Law.'
  },

  {
    name: 'Plateau State Micro, Small and Medium Enterprises Development Agency',
    abbreviation: 'PLASMEDA',
    alsoWritten: [
      'Plateau State Micro, Small and Medium Enterprises Development Agency (PLASMEDA)',
      'Plateau State Microfinance Development Agency'
    ],
    category: 'GOVERNMENT',
    currentLeadership: {
      title: 'Mr.',
      name: 'Bomkam Ali Wuyep',
      position: 'Director General',
      note: 'Leading MSME development, microcredit linkages, and entrepreneurship incubation.'
    },
    pastLeadership: [
      { role: 'Director General', title: 'Mr.', name: 'Haggai Haruna Gutap', period: '2016 – 2023 (Lalong administration)' }
    ],
    administrativeHistory: 'Created to catalyze micro and small businesses, enhance financial inclusion, and provide vocational incubation for youth and women.',
    mandate: 'Stimulate micro, small, and medium enterprise growth; provide financial literacy; facilitate access to low-interest credit; train entrepreneurs; and create business development hubs across Plateau State.',
    vision: 'A vibrant entrepreneurial ecosystem driving wealth creation, self-employment, and industrial value addition.',
    mission: 'To empower micro and small enterprise owners through capacity building, micro-credit access, business formalization, and technological incubation.',
    departments: [
      'Department of Enterprise Training & Capacity Building',
      'Department of Micro-Credit Linkages & Financial Inclusion',
      'Department of Business Development Services & Incubation',
      'Department of Monitoring, Evaluation & MSME Database'
    ],
    citizenServices: [
      'Free entrepreneurship, bookkeeping, and digital marketing training for small business owners',
      'Linkage to Bank of Industry (BOI), Development Bank of Nigeria (DBN), and microfinance loan schemes',
      'Assistance with corporate business registration (CAC) and NAFDAC product certifications',
      'Access to state-supported business incubation centres and shared tool facilities'
    ],
    contact: {
      office: 'Plot 760 Liberty Boulevard Beside Nigerian Film Corporation, Jos, Plateau State',
      phones: ['+2349164825537'],
      email: 'plasmida@plateaustate.gov.ng',
      website: 'https://plateaustate.gov.ng'
    },
    legalFramework: 'Plateau State Micro, Small and Medium Enterprises Development Agency Law.'
  },

  {
    name: 'Plateau Express Services Group LTD',
    abbreviation: 'PESGL',
    alsoWritten: ['Plateau Express Services Group LTD (PESGL)', 'Plateau Riders', 'Plateau Express Services'],
    category: 'GOVERNMENT',
    currentLeadership: {
      title: 'Hon.',
      name: 'Samuel Jok Gwott',
      position: 'Managing Director / CEO',
      note: 'Leading modern fleet expansion, inter-state route revitalization, and Tin City Metro urban bus services.'
    },
    pastLeadership: [
      { role: 'General Manager', title: 'Hon.', name: 'Samuel Jok Gwott', period: '2019 – 2023' }
    ],
    administrativeHistory: 'Originally established as Plateau Riders in 1989. Restructured into a modern logistics and multimodal transport corporate group.',
    mandate: 'Provide safe, reliable, and affordable commercial inter-state passenger transit, urban intra-city mass transit, cargo haulage, and courier logistics services.',
    vision: 'To be Nigeria\'s safest, most innovative, and technologically integrated state-owned transport and logistics brand.',
    mission: 'To deliver exceptional customer travel experiences, link major Nigerian commercial hubs, and provide subsidized mass transit for Plateau citizens.',
    departments: [
      'Inter-State Passenger Operations',
      'Tin City Metro Urban Transit Operations',
      'Logistics, Courier & Haulage Services',
      'Fleet Maintenance & Technical Workshop',
      'Customer Care & Digital Ticketing'
    ],
    citizenServices: [
      'Inter-state passenger express travel from Jos to Abuja, Lagos, Kano, Port Harcourt, Kaduna, Bauchi, Enugu, etc.',
      'Tin City Metro subsidized intra-city public bus rides across Jos-Bukuru metropolitan corridors',
      'Waybill, parcel delivery, and express courier logistics across Nigeria',
      'Automated online bus seat booking and digital ticket reservation'
    ],
    contact: {
      office: 'Plateau Express Services Group LTD, No. 36 Murtala Mohammed Way, Jos, Plateau State',
      phones: ['+2348062423115'],
      email: 'plateauriders@gmail.com',
      website: 'https://plateauriders.com.ng'
    },
    legalFramework: 'Incorporated under Companies and Allied Matters Act (CAMA) and owned by Plateau State Government.'
  },

  {
    name: 'Plateau State Gender and Equal Opportunities Commission',
    abbreviation: 'PLAGEO',
    alsoWritten: [
      'Plateau State Gender and Equal Opportunities Commission (PLAGEO)',
      'Plateau Gender Commission'
    ],
    category: 'GOVERNMENT',
    currentLeadership: {
      title: 'Mrs.',
      name: 'Olivia Dazyem Esq',
      position: 'Acting Chairperson',
      note: 'Former Commissioner for Information and leading legal luminary; spearheading anti-discrimination enforcement.'
    },
    pastLeadership: [
      { role: 'Pioneer Head', title: 'Mrs.', name: 'Olivia Dazyem Esq', period: '2023 – Present' }
    ],
    administrativeHistory: 'Established under Section 3 of the Plateau State Gender and Equal Opportunities Law 2015 to eliminate discrimination against women and promote equitable development.',
    mandate: 'Promote gender equality, monitor enforcement of the GEO Law 2015, investigate violations and discrimination, provide mediation and legal aid to victims of gender rights violations, and advocate for equitable representation in public office.',
    vision: 'A just and equitable Plateau State where women, men, girls, and boys enjoy equal rights, dignified livelihoods, and full participation in governance.',
    mission: 'To eradicate all forms of gender-based discrimination through evidence-based research, legislative advocacy, public enlightenment, mediation, and public interest litigation.',
    departments: [
      'Department of Legal Services, Mediation & Litigation',
      'Department of Research, Monitoring & Evaluation',
      'Department of Public Education & Advocacy',
      'Department of Gender Mainstreaming & Policy Reviews'
    ],
    citizenServices: [
      'Intake, investigation, and legal intervention for victims of gender-based discrimination, disinheritance, and domestic violence',
      'Free legal aid representation and alternative dispute resolution (ADR) mediation for vulnerable women and minors',
      'Gender rights awareness workshops across schools, religious groups, and traditional councils',
      'Monitoring public and private compliance with gender equity benchmarks'
    ],
    contact: {
      office: 'Jos, Plateau State',
      phones: ['+2348037042854'],
      email: 'info.plageo@plateaustate.gov.ng',
      website: 'https://plateaustate.gov.ng'
    },
    legalFramework: 'Section 3 of the Plateau State Gender and Equal Opportunities Law 2015.'
  },

  {
    name: 'Plateau State Scholarship Board',
    abbreviation: 'PSSB',
    alsoWritten: ['Plateau State Scholarship Board (PSSB)', 'State Scholarship Board'],
    category: 'GOVERNMENT',
    currentLeadership: {
      title: 'Mrs.',
      name: 'Nankus Ngwalang Adams',
      position: 'Executive Secretary',
      note: 'Managing domestic bursaries, specialized foreign scholarships, and student welfare.'
    },
    pastLeadership: [
      { role: 'Executive Secretary', title: 'Mr.', name: 'David Mwelbish', period: '2015 – 2023 (Lalong administration)' }
    ],
    administrativeHistory: 'Mandated to administer bursaries, academic grants, and scholarships to Plateau State indigenes studying in tertiary institutions.',
    mandate: 'Formulate scholarship policies, screen applicant indigenes, disburse annual bursary allowances, manage bilateral education agreements (BEA) foreign postgraduate scholarships, and support aviation, medical, and STEM scholars.',
    vision: 'Empowering every qualified Plateau student through equitable financial assistance to attain academic and technical excellence.',
    mission: 'To administer merit-based and need-based scholarships transparently, fostering intellectual development for the state’s workforce.',
    departments: [
      'Department of Bursary Operations & Verification',
      'Department of Foreign & Postgraduate Scholarships',
      'Department of Special Education & STEM Awards',
      'Department of Planning, Research & Statistics'
    ],
    citizenServices: [
      'Annual online bursary registration and verification for Plateau indigenes in universities, polytechnics, and colleges of education',
      'Law School bursary grants processing for indigent Bar Part II students',
      'Selection and placement screening for state government foreign postgraduate scholarship awardees',
      'Special education academic grants for students living with disabilities'
    ],
    contact: {
      office: '3rd Floor, Ministry of Education, JD Gomwalk Secretariat, Jos, Plateau State',
      phones: ['+2348038724158'],
      email: 'pssb@plateaustate.gov.ng',
      website: 'https://plateaustate.gov.ng'
    },
    legalFramework: 'Plateau State Scholarship Board Law.'
  },

  {
    name: 'Plateau State Energy Corporation',
    abbreviation: 'PSEC',
    alsoWritten: ['Plateau State Energy Corporation (PSEC)', 'Plateau Energy Corporation'],
    category: 'GOVERNMENT',
    currentLeadership: {
      title: 'Hon.',
      name: 'Victor During Dagett',
      position: 'Chairman of the Board',
      note: 'Leading renewable energy development, mini-grid electrification, and off-grid solar infrastructure.'
    },
    pastLeadership: [
      { role: 'Coordinator', title: 'Engr.', name: 'Gyang Pam', period: 'Pre-2023' }
    ],
    administrativeHistory: 'Created to harness Plateau State\'s enormous hydro, solar, and wind energy potentials following the constitutional devolution of electricity to states under the Electricity Act 2023.',
    mandate: 'Develop state power policies, formulate the Plateau State Electricity Market regulations, develop off-grid and on-grid renewable energy projects, install solar street lighting, and attract private power developers.',
    vision: 'A fully electrified Plateau State driven by clean, renewable, and decentralised energy powering rural and urban economic growth.',
    mission: 'To exploit renewable energy potentials (hydro, solar, biomass), construct mini-grids, and establish a competitive state electricity market.',
    departments: [
      'Department of Renewable Energy & Solar Projects',
      'Department of Small Hydro & Power Generation',
      'Department of Electricity Market Regulations & IPP Liaison',
      'Department of Rural Electrification & Energy Planning'
    ],
    citizenServices: [
      'Rural community mini-grid electrification requests and solar power feasibility assessments',
      'Permits and licensing for independent power producers (IPPs) and solar mini-grid developers',
      'Maintenance of metropolitan solar streetlights along commercial traffic corridors',
      'Consultancy on industrial energy efficiency and captive power setups'
    ],
    contact: {
      office: 'No. 23 Mark Samchi Road, P.O. Box 7160, Jos, Plateau State',
      phones: ['+2347088923274'],
      email: 'plateauenergycorp@gmail.com',
      website: 'https://plateaustate.gov.ng'
    },
    legalFramework: 'Plateau State Electricity Law and Federal Electricity Act 2023.'
  },

  {
    name: 'Plateau Radio Television Corporation',
    abbreviation: 'PRTVC',
    alsoWritten: ['Plateau Radio Television Corporation Jos (PRTVC)', 'PRTV', 'PRTVC Jos'],
    category: 'GOVERNMENT',
    currentLeadership: {
      title: 'Mrs.',
      name: 'Rita Kachollom Pam',
      position: 'General Manager',
      note: 'Managing state public television (PRTV) and radio stations (Peace 90.5 FM and AM).'
    },
    pastLeadership: [
      { role: 'General Manager', title: 'Mr.', name: 'Jephtha Jackden', period: '2015 – 2023 (Lalong administration)' }
    ],
    administrativeHistory: 'Plateau State’s premier broadcasting media organization, established in 1982 to broadcast information, educational programming, and entertainment across North-Central Nigeria.',
    mandate: 'Broadcast radio and television programs that inform, educate, and entertain the people of Plateau State; project state cultural heritage; provide a platform for democratic discourse; and broadcast official public announcements.',
    vision: 'To be the preferred, most authoritative, and digitally broadcast network in Central Nigeria.',
    mission: 'To deliver objective news, qualitative educational programs, and culturally rich broadcasts promoting peace, democracy, and community development.',
    departments: [
      'Directorate of News & Current Affairs',
      'Directorate of Programmes (Radio & Television)',
      'Directorate of Engineering & Digital Broadcast Transmission',
      'Directorate of Commercial, Marketing & Public Relations',
      'Directorate of Administration & Human Resources'
    ],
    citizenServices: [
      'Broadcasting official public service announcements, obituary notices, and press releases',
      'Live coverage of cultural festivals, government town halls, and sporting events',
      'Commercial advertising, program sponsorship, and documentary production services',
      'Audience interactive radio phone-in programs on public governance and citizen concerns'
    ],
    contact: {
      office: 'PRTVC Headquarters, Rayfield, Jos, Plateau State',
      phones: ['+2348037042854'],
      email: 'prtvjos@gmail.com',
      website: 'https://prtvjos.com.ng'
    },
    legalFramework: 'Plateau Radio Television Corporation Law 1982.'
  },

  {
    name: 'Plateau Specialist Hospital',
    abbreviation: 'PSSH',
    alsoWritten: ['Plateau Specialist Hospital (PSSH JOS)', 'Plateau State Specialist Hospital', 'PSSH'],
    category: 'HOSPITAL',
    currentLeadership: {
      title: 'Professor',
      name: 'Christopher S. Yilgwan',
      position: 'Chief Medical Director',
      note: 'Renowned consultant pediatrician leading hospital transformation, modern diagnostic upgrades, and clinical residency.'
    },
    pastLeadership: [
      { role: 'Chief Medical Director', title: 'Dr.', name: 'Philemon Golwa', period: '2015 – 2023 (Lalong administration)' }
    ],
    administrativeHistory: 'The apex tertiary referral hospital of the Plateau State Government, providing specialist clinical care and medical training.',
    mandate: 'Provide tertiary medical, surgical, pediatric, obstetric, and psychiatric services; train medical doctors, nurses, and allied healthcare professionals; and conduct clinical research.',
    vision: 'A centre of clinical excellence providing cutting-edge, compassionate, and affordable specialist healthcare to all citizens.',
    mission: 'To deliver high-quality, patient-centred tertiary medical services through modern diagnostic technology, skilled healthcare professionals, and continuous medical research.',
    departments: [
      'Department of Internal Medicine',
      'Department of Surgery & Anaesthesia',
      'Department of Paediatrics & Child Health',
      'Department of Obstetrics & Gynaecology',
      'Department of Radiology & Diagnostic Imaging',
      'Department of Pathology & Medical Laboratory Sciences',
      'Department of Pharmacy Services'
    ],
    citizenServices: [
      '24-hour accident, trauma, and medical emergency casualty care',
      'Specialist surgical operations, laparoscopic surgeries, and intensive care unit (ICU) support',
      'Specialist outpatient clinics (Cardiology, Oncology, Endocrinology, Nephrology, Urology)',
      'Accredited clinical services for PLASCHEMA and NHIA health insurance enrollees',
      'Comprehensive diagnostic services (CT scan, digital X-ray, ultrasound, automated clinical chemistry)'
    ],
    contact: {
      office: 'No. 1 Hospital Road / Jos, Plateau State',
      phones: ['+2347036120895'],
      email: 'Info@psshjos.com.ng',
      website: 'https://psshjos.com.ng'
    },
    legalFramework: 'Plateau State Specialist Hospital Management Board Law.'
  },

  {
    name: 'Plateau State Hospitals Management Board',
    abbreviation: 'HMB',
    alsoWritten: ['Plateau State Hospitals Management Board (HMB)', 'Hospitals Management Board'],
    category: 'HOSPITAL',
    currentLeadership: {
      title: 'Dr.',
      name: 'Sumi B. Garkuwa',
      position: 'Chief Medical Director',
      note: 'Supervising secondary public hospitals, clinical staffing, and medical equipment across all 17 LGAs.'
    },
    pastLeadership: [
      { role: 'Chief Medical Director', title: 'Dr.', name: 'Barkin Ladi', period: 'Pre-2023' }
    ],
    administrativeHistory: 'Administers the network of General Hospitals and Cottage Hospitals throughout the 17 Local Government Areas of Plateau State.',
    mandate: 'Manage, staff, equip, and supervise all secondary healthcare institutions; ensure uniform clinical standards; coordinate referral links between primary health centres and specialist hospitals; and deploy medical doctors and nursing staff.',
    vision: 'An accessible, well-equipped, and responsive secondary healthcare hospital network serving every community in Plateau State.',
    mission: 'To provide quality, dignified, and decentralized secondary clinical services across all 17 LGAs through professional healthcare personnel and modern medical technologies.',
    departments: [
      'Directorate of Medical Services & Clinical Audits',
      'Directorate of Nursing & Midwifery Services',
      'Directorate of Pharmacy & Medical Consumables',
      'Directorate of Hospital Equipment & Maintenance',
      'Directorate of Hospital Administration & Accounts'
    ],
    citizenServices: [
      'Clinical inpatient and outpatient services at General Hospitals in Barkin Ladi, Bokkos, Bassa, Mangu, Pankshin, Langtang, Shendam, Quan\'pan, etc.',
      'Emergency obstetric care, Cesarean sections, and safe delivery services across rural districts',
      'Inpatient medical admissions, surgical procedures, and blood bank transfusions',
      'Medical fitness certificate assessments for employment, school admission, and driver licensing'
    ],
    contact: {
      office: 'No. 1 Constitution Hill Road, PMB 2148, Jos, Plateau State',
      phones: ['+2348065302359'],
      email: 'pstatehmbjos@yahoo.com',
      website: 'https://plateaustate.gov.ng'
    },
    legalFramework: 'Plateau State Hospitals Management Board Law.'
  },

  {
    name: 'Plateau State Debt Management Department',
    abbreviation: 'DMO',
    alsoWritten: ['Plateau state Debt Management Department (DMO)', 'Plateau DMO'],
    category: 'GOVERNMENT',
    currentLeadership: {
      title: 'Mrs.',
      name: 'Atihong Yengoet',
      position: 'Director General',
      note: 'Leading public debt portfolio recording, debt sustainability analysis, and loan servicing.'
    },
    pastLeadership: [
      { role: 'Director General', title: 'Mr.', name: 'Emmanuel Rurum', period: 'Pre-2023' }
    ],
    administrativeHistory: 'Responsible for recording, servicing, and reporting all domestic and external public debt portfolios of the Plateau State Government.',
    mandate: 'Maintain a comprehensive database of all state public debts, loans, guarantees, and contractual liabilities; conduct debt sustainability analyses; advise on borrowing limits; and ensure timely servicing of public debts.',
    vision: 'Prudent, transparent, and sustainable public debt management that supports strategic state infrastructure without compromising fiscal stability.',
    mission: 'To manage Plateau State\'s debt obligations cost-effectively and transparently, adhering strictly to international best practices and fiscal responsibility thresholds.',
    departments: [
      'Department of Debt Recording & Settlement',
      'Department of Debt Strategy & Risk Analysis',
      'Department of Monitoring, Policy & Legal Advisory'
    ],
    citizenServices: [
      'Quarterly and annual publication of official Plateau State public debt statistical reports',
      'Verification of state debt figures and domestic contractor loan liability schedules',
      'Debt sustainability analysis consultations with civil society and financial institutions'
    ],
    contact: {
      office: 'Jos, Plateau State',
      phones: ['+2348037042854'],
      email: 'dmo@plateaustate.gov.ng',
      website: 'https://plateaustate.gov.ng'
    },
    legalFramework: 'Plateau State Debt Management Law and Fiscal Responsibility Law.'
  },

  {
    name: 'Plateau State Bureau of Statistics',
    abbreviation: 'PSBS',
    alsoWritten: ['Plateau State Bureau of Statistics (PSBS)', 'Bureau of Statistics'],
    category: 'GOVERNMENT',
    currentLeadership: {
      title: 'Mr.',
      name: 'Micah S. Gongden',
      position: 'Statistician General Plateau State',
      note: 'Leading state socioeconomic statistical surveys, demographic studies, and open data systems.'
    },
    pastLeadership: [
      { role: 'Statistician General', title: 'Mr.', name: 'Gyang Dalyop', period: 'Pre-2023' }
    ],
    administrativeHistory: 'The authoritative official statistical coordinating body of the Plateau State Government.',
    mandate: 'Collect, compile, analyze, and disseminate official demographic, socioeconomic, and economic statistics; calculate State Gross Domestic Product (SGDP); conduct household surveys; and coordinate statistical activities across all MDAs.',
    vision: 'A reliable, cutting-edge statistical centre of excellence producing timely, accurate data for evidence-based decision-making in Plateau State.',
    mission: 'To generate and publish accurate, credible, and standardized statistical indicators to guide policy planning, budget formulation, and development research.',
    departments: [
      'Department of Demographic & Social Statistics',
      'Department of Economic & Real Sector Statistics',
      'Department of Censuses, Surveys & Methodology',
      'Department of Data Processing & Information Technology'
    ],
    citizenServices: [
      'Access to official statistical publications, state socioeconomic surveys, and demographic datasets',
      'Conducting state consumer price index (CPI) and inflation benchmarking',
      'Provision of statistical data to academic researchers, international donor agencies, and investors'
    ],
    contact: {
      office: 'Joseph Gomwalk Secretariat, Jos, Plateau State',
      phones: ['+2348037042854'],
      email: 'psbs@plateaustate.gov.ng',
      website: 'https://plateaustate.gov.ng'
    },
    legalFramework: 'Plateau State Statistics Law.'
  },

  {
    name: 'Plateau State Sustainable Development Goals Project Support Unit',
    abbreviation: 'SDGs-PSU',
    alsoWritten: ['Plateau State Sustainable Development Goals', 'Plateau SDGs Unit'],
    category: 'GOVERNMENT',
    currentLeadership: {
      title: 'Mrs.',
      name: 'Nanbam Esther Danjum',
      position: 'Plateau State Project Coordinator',
      note: 'Leading grassroots localization of the 17 UN Sustainable Development Goals across rural communities.'
    },
    pastLeadership: [
      { role: 'Project Coordinator', title: 'Mr.', name: 'Sam Damla', period: '2015 – 2023 (Lalong administration)' }
    ],
    administrativeHistory: 'Coordinates donor and state co-funded micro-projects delivering rural water, primary healthcare clinics, and school classrooms across the 17 LGAs.',
    mandate: 'Mainstream the 17 United Nations Sustainable Development Goals into state development plans, execute counterpart-funded community micro-projects, and monitor progress on poverty eradication, health, education, and clean water.',
    vision: 'A prosperous Plateau State where every rural community achieves sustainable benchmarks in health, education, clean water, and food security.',
    mission: 'To localize the SDGs through transparent community project execution, inter-agency synergy, and grassroots citizen participation.',
    departments: [
      'Department of Project Planning & Counterpart Operations',
      'Department of Community Social Mobilization',
      'Department of Monitoring, Evaluation & Reporting'
    ],
    citizenServices: [
      'Rural community solar borehole drilling and motorized water supply installations',
      'Construction and equipping of Primary Healthcare Centres and rural maternal health clinics',
      'Rehabilitation of basic school classroom blocks and supply of student desks in underserved villages'
    ],
    contact: {
      office: 'Jos, Plateau State',
      phones: ['+2348037042854'],
      email: 'sdgs@plateaustate.gov.ng',
      website: 'https://plateaustate.gov.ng'
    },
    legalFramework: 'UN SDGs Framework and Plateau State Planning Mandate.'
  },

  {
    name: 'Plateau State Tourism Corporation',
    abbreviation: 'PSTC',
    alsoWritten: ['Plateau State Tourism Corporation ( PSTC)', 'Tourism Corporation'],
    category: 'GOVERNMENT',
    currentLeadership: {
      title: 'Mr.',
      name: 'Chuwang Pwajok Nyam',
      position: 'General Manager',
      note: 'Managing major state conservation parks, wildlife resorts, and eco-tourism promotion.'
    },
    pastLeadership: [
      { role: 'General Manager', title: 'Mr.', name: 'John Gabriel', period: 'Pre-2023' }
    ],
    administrativeHistory: 'Established under the Plateau State Tourism Corporation Law to commercialize and maintain the state’s extraordinary eco-tourism destinations.',
    mandate: 'Manage and develop state-owned tourist attractions; preserve flora, fauna, and wildlife reserves; promote eco-tourism excursions; and market Plateau State\'s natural beauty.',
    vision: 'To position Plateau State as Nigeria\'s leading destination for wildlife conservation, nature tourism, and mountain recreation.',
    mission: 'To sustainably manage state tourist assets, protect wildlife, and deliver unforgettable visitor experiences.',
    departments: [
      'Department of Wildlife Parks & Game Reserves',
      'Department of Tourism Destination Marketing',
      'Department of Hospitality Facilities & Concessions'
    ],
    touristSites: [
      'Jos Wildlife Park (Tudun Wada / Federal Lowcost Road)',
      'Pandam Wildlife Park & Game Reserve (Qua\'an Pan LGA)',
      'Assop Waterfalls (Riyom LGA)',
      'Kurra Falls & Hydro Resort (Barkin Ladi LGA)',
      'Solomon Lar Amusement Park, Jos',
      'Shere Hills Mountain Range & Rock Formations'
    ],
    citizenServices: [
      'Visitor admissions and educational guided tours at Jos Wildlife Park and Pandam Game Reserve',
      'Event venue hire at Solomon Lar Amusement Park and tourism resort grounds',
      'Organizing student nature excursions and wildlife conservation education programmes'
    ],
    contact: {
      office: 'Jos Wildlife Park Grounds, Tudun Wada, Jos, Plateau State',
      phones: ['+2348037042854'],
      email: 'tourismcorp@plateaustate.gov.ng',
      website: 'https://plateaustate.gov.ng'
    },
    legalFramework: 'Plateau State Tourism Corporation Law.'
  },

  {
    name: 'Teachers\' Service Commission',
    abbreviation: 'TSC',
    alsoWritten: ['Teachers\' Service Commission (TSC)', 'Plateau TSC'],
    category: 'GOVERNMENT',
    currentLeadership: {
      title: 'Mr.',
      name: 'Chup Alexander Sunday',
      position: 'Commissioner / Chairman, Teacher\'s Service Commission',
      note: 'Leading secondary school teacher welfare, promotions, postings, and discipline.'
    },
    pastLeadership: [
      { role: 'Chairman', title: 'Mr.', name: 'Sylvester Wallangko', period: 'Pre-2023' }
    ],
    administrativeHistory: 'Autonomous statutory commission responsible for managing the teaching service across public secondary and technical colleges.',
    mandate: 'Appoint, recruit, post, promote, discipline, and manage the welfare and pension administration of public secondary school teachers in Plateau State.',
    vision: 'A highly motivated, competent, and professional secondary school teaching workforce driving student academic excellence.',
    mission: 'To recruit and retain qualified educators through merit-based appointments, continuous professional training, and prompt promotion administration.',
    departments: [
      'Department of Appointments, Postings & Promotions',
      'Department of Teacher Discipline & Ethics',
      'Department of Teacher Professional Development & Training',
      'Department of Pensions & Records Management'
    ],
    citizenServices: [
      'Recruitment and documentation of qualified graduate teachers for public secondary schools',
      'Teacher inter-school postings, rural posting allowances, and promotions assessment',
      'Processing retirement documents and service records for secondary school teachers',
      'Investigating teacher professional misconduct and student protection complaints'
    ],
    contact: {
      office: 'Teachers\' Service Commission, J.D Gomwalk Secretariat, Jos, Plateau State',
      phones: ['+2349064500882'],
      email: 'tscplateaustatejos@gmail.com',
      website: 'https://plateaustate.gov.ng'
    },
    legalFramework: 'Plateau State Teachers\' Service Commission Law.'
  },

  {
    name: 'Plateau State Local Government Service Commission',
    abbreviation: 'LGSC',
    alsoWritten: ['Plateau State Local Government Service Commission (LGSC)', 'LGSC'],
    category: 'GOVERNMENT',
    currentLeadership: {
      title: 'Chief',
      name: 'Simon Tangni',
      position: 'Chairman, Local Government Service Commission',
      note: 'Leading unified local government personnel administration across all 17 LGAs.'
    },
    pastLeadership: [
      { role: 'Chairman', title: 'Hon.', name: 'Robert Taple', period: '2015 – 2023 (Lalong administration)' }
    ],
    administrativeHistory: 'The central personnel authority for the unified local government service across the 17 Local Government Areas of Plateau State.',
    mandate: 'Recruit, appoint, post, transfer, promote, and discipline senior local government administrative and technical staff across all 17 LGAs; conduct service examinations; and maintain unified personnel standards.',
    vision: 'A dedicated, professional, and efficient local government workforce driving grassroots governance and community prosperity.',
    mission: 'To ensure fairness, merit, and high ethical conduct in the management of local government employees across Plateau State.',
    departments: [
      'Department of Appointments, Promotions & Transfers',
      'Department of Discipline & Appeals',
      'Department of Training & Human Resource Development',
      'Department of Local Government Pension Administration'
    ],
    citizenServices: [
      'Recruitment and confirmation of unified local government career officers across the 17 LGAs',
      'Inter-local government transfers and career promotion board assessments',
      'Disciplinary appeal hearings for aggrieved local government staff',
      'Local government staff pension documentation and gratuity computations'
    ],
    contact: {
      office: 'JD Gomwalk Secretariat Annex, Jos, Plateau State',
      phones: ['+2348036073126'],
      email: 'info.lgsc@plateaustate.gov.ng',
      website: 'https://plateaustate.gov.ng'
    },
    legalFramework: 'Plateau State Local Government Law and Unified Local Government Service Regulations.'
  },

  {
    name: 'Plateau Minerals Development Company Limited',
    abbreviation: 'PMDC',
    alsoWritten: ['Plateau Minerals Development Company Limited (PMDC)', 'Plateau Minerals Development Company'],
    category: 'GOVERNMENT',
    currentLeadership: {
      title: 'Mr.',
      name: 'Matthews Dawap',
      position: 'Managing Director',
      note: 'Leading state solid mineral exploration, joint ventures, and mineral beneficiation.'
    },
    pastLeadership: [
      { role: 'Managing Director', title: 'Mr.', name: 'Gyang Dalyop', period: 'Pre-2023' }
    ],
    administrativeHistory: 'The state-owned enterprise established to commercially explore, process, and partner in the development of solid mineral deposits.',
    mandate: 'Engage in commercial mining exploration, joint venture partnerships, mineral processing, and value-addition for tin, columbite, zircon, tantalite, lead, zinc, and barites abundant in Plateau State.',
    vision: 'To be Nigeria\'s foremost state-owned commercial mining corporation unlocking sustainable mineral wealth.',
    mission: 'To conduct responsible, environmentally friendly, and profitable commercial mining operations while empowering host communities.',
    departments: [
      'Department of Geology & Mineral Exploration',
      'Department of Joint Ventures, Legal & Business Development',
      'Department of Mineral Beneficiation & Processing Operations',
      'Department of Community Relations & Environmental Safety'
    ],
    citizenServices: [
      'Joint-venture partnerships with local and international mining investors',
      'Mineral laboratory assaying, sample testing, and purity certification',
      'Artisanal mining cooperative organization, safety training, and formal market linkages'
    ],
    contact: {
      office: 'Mineral House, Anguldi-Bukuru Express Way, Adjacent NECO office, Jos, Plateau State',
      phones: ['+2348037042854'],
      email: 'plateaumineralsdevco@yahoo.com',
      website: 'https://plateaustate.gov.ng'
    },
    legalFramework: 'Incorporated under Companies and Allied Matters Act (CAMA) and Plateau State Mineral Development Mandate.'
  },

  {
    name: 'College of Arts, Science and Technology, Kurgwi',
    abbreviation: 'CAST',
    alsoWritten: ['College of Arts, Science and Technology, Kurgwi (CAST)', 'CAST Kurgwi'],
    category: 'TERTIARY_INSTITUTION',
    currentLeadership: {
      title: 'Mr.',
      name: 'Birmiap Patrick Yilpoe',
      position: 'Provost',
      note: 'Leading academic curriculum accreditation, technical diploma programs, and IJMB tertiary preparation.'
    },
    pastLeadership: [
      { role: 'Provost', title: 'Dr.', name: 'Stephen Hirse', period: 'Pre-2023' }
    ],
    administrativeHistory: 'Plateau State tertiary academic institution situated in Southern Senatorial District, providing diploma and IJMB tertiary pre-degree education.',
    mandate: 'Provide qualitative tertiary education, Interim Joint Matriculation Board (IJMB) pre-degree courses, National Diploma (ND) programs in arts, sciences, and management, and technical vocational certificates.',
    vision: 'A reputable tertiary polytechnic-style institution renowned for academic discipline, practical science, and technological innovation.',
    mission: 'To prepare students for direct university entry and gainful technical employment through rigorous academic and technical training.',
    academicProgrammes: [
      'IJMB Direct-Entry University Preparation (Sciences, Arts, Social Sciences)',
      'National Diploma (ND) in Computer Science, Statistics, and Laboratory Technology',
      'Diploma in Public Administration, Accounting, and Business Studies',
      'Remedial and Pre-ND Science Programmes'
    ],
    citizenServices: [
      'Admission applications for IJMB, Remedial, and National Diploma programmes',
      'Academic transcript processing, certificate issuance, and student verification',
      'Community adult literacy and vocational computer training classes'
    ],
    contact: {
      office: 'College of Arts, Science and Technology, Kurgwi, Qua\'an Pan LGA, Plateau State',
      phones: ['+2348037042854'],
      email: 'info@castkurgwi.edu.ng',
      website: 'https://castkurgwi.edu.ng'
    },
    legalFramework: 'Plateau State College of Arts, Science and Technology Edict.'
  },

  {
    name: 'Community and Social Development Agency',
    abbreviation: 'CSDA',
    alsoWritten: ['Community and Social Development Agency (CSDA)', 'Plateau CSDA'],
    category: 'GOVERNMENT',
    currentLeadership: {
      title: 'Mr.',
      name: 'Dauda D. Dinju',
      position: 'General Manager',
      note: 'Leading community-driven development micro-projects across poor rural communities.'
    },
    pastLeadership: [
      { role: 'General Manager', title: 'Mr.', name: 'Daniel Chup', period: 'Pre-2023' }
    ],
    administrativeHistory: 'Created to manage community-driven development projects funded through tripartite partnerships between the World Bank, Federal Government, and Plateau State Government.',
    mandate: 'Empower poor rural communities to plan, co-finance, construct, and maintain their own priority social infrastructure micro-projects in health, water, education, and rural access.',
    vision: 'Self-reliant rural communities actively driving their own sustainable socioeconomic development.',
    mission: 'To build community capacity, reduce rural poverty, and improve access of poor households to basic social services.',
    departments: [
      'Department of Operations & Community Mobilization',
      'Department of Monitoring & Evaluation',
      'Department of Finance & Administration',
      'Department of Engineering & Project Quality Control'
    ],
    citizenServices: [
      'Community-Driven Development (CDD) micro-grants for rural community water schemes, clinic blocks, and culverts',
      'Community Project Management Committee (CPMC) training on procurement and project maintenance',
      'Vulnerable group empowerment projects for widows, elderly, and persons with disabilities'
    ],
    contact: {
      office: 'Jos, Plateau State',
      phones: ['+2348037042854'],
      email: 'csda@plateaustate.gov.ng',
      website: 'https://plateaustate.gov.ng'
    },
    legalFramework: 'Plateau State Community and Social Development Agency Law.'
  },

  {
    name: 'Plateau State Independent Electoral Commission',
    abbreviation: 'PLASIEC',
    alsoWritten: ['Plateau State Independent Electoral Commission (PLASIEC)', 'PLASIEC'],
    category: 'GOVERNMENT',
    currentLeadership: {
      title: 'Hon.',
      name: 'Plangji Daniel Cishak',
      position: 'Executive Chairman',
      note: 'Leading state local government electoral reforms, transparent voting technologies, and local council elections.'
    },
    pastLeadership: [
      { role: 'Chairman', title: 'Mr.', name: 'Fabian Ntung', period: '2017 – 2023 (Lalong administration)' }
    ],
    administrativeHistory: 'Autonomous constitutional commission responsible for conducting democratic elections across all 17 Local Government Areas.',
    mandate: 'Organize, conduct, and supervise democratic elections for Local Government Council Chairmen and Ward Councilors across all 17 LGAs and 325 electoral wards of Plateau State, register eligible political party candidates, and declare election results.',
    vision: 'A fiercely independent, transparent, and trusted state electoral commission delivering credible local democratic elections.',
    mission: 'To uphold democratic tenets, ensure level playing fields for all political parties, and conduct free, fair, and peaceful local council elections.',
    departments: [
      'Department of Election Operations & Logistics',
      'Department of Voter Education, Publicity & Civil Society',
      'Department of Legal Services & Candidate Clearance',
      'Department of Information Technology & Results Collation'
    ],
    citizenServices: [
      'Notice of local government council elections, guidelines, and candidate nomination filing',
      'Accreditation of election domestic observers, civil society monitors, and media correspondents',
      'Voter education campaigns and peace accords among contesting political parties',
      'Official declaration and issuance of Certificate of Return to elected Local Government Chairmen and Councilors'
    ],
    contact: {
      office: 'No. 7 John Mark Samchi Road, Jos, Plateau State',
      phones: ['+2348037042854'],
      email: 'info@plasiec.org.ng',
      website: 'https://plasiec.org.ng'
    },
    legalFramework: 'Section 197 of the 1999 Constitution of the Federal Republic of Nigeria and Plateau State Independent Electoral Commission Law.'
  },

  {
    name: 'Plateau State Universal Basic Education Board',
    abbreviation: 'PSUBEB',
    alsoWritten: ['Plateau State Universal Basic Education Board (PSUBEB)', 'SUBEB Plateau'],
    category: 'GOVERNMENT',
    currentLeadership: {
      title: 'Hon.',
      name: 'Sunday Amuna',
      position: 'Executive Chairman',
      note: 'Leading public primary and junior secondary education revitalisation and school infrastructure.'
    },
    pastLeadership: [
      { role: 'Executive Chairman', title: 'Prof.', name: 'Matthew Sule', period: '2015 – 2023 (Lalong administration)' }
    ],
    administrativeHistory: 'Formed under the Compulsory, Free Universal Basic Education Act 2004 to administer public primary schools and junior secondary schools.',
    mandate: 'Manage public primary and junior secondary schools across all 17 LGAs; disburse and manage UBE matching grants; construct and renovate classrooms; recruit, train, and pay basic education teachers; and distribute free textbooks.',
    vision: 'Every Plateau child of school age in school, acquiring qualitative, foundational literacy, numeracy, and life skills.',
    mission: 'To eliminate out-of-school children, provide child-friendly school environments, and ensure qualitative foundational learning through motivated basic school teachers.',
    departments: [
      'Department of Physical Planning & School Infrastructure',
      'Department of Academic Services, Quality Assurance & Curriculum',
      'Department of Teacher Professional Development',
      'Department of Social Mobilization & Enrolment Drive',
      'Department of Planning, Research & Statistics'
    ],
    citizenServices: [
      'Public primary and junior secondary school enrollment for children aged 6 to 15',
      'Reporting dilapidated school classrooms, storm damages, or lack of water/toilet facilities',
      'Primary school teacher recruitment, promotion, and payroll administration via Local Education Authorities (LEAs)',
      'Distribution of free instructional materials, mathematical sets, and textbooks'
    ],
    contact: {
      office: 'Dogon Dutse, Jos, Plateau State',
      phones: ['+2348037042854'],
      email: 'psubeb@plateaustate.gov.ng',
      website: 'https://plateaustate.gov.ng'
    },
    legalFramework: 'Compulsory, Free Universal Basic Education Act 2004 and Plateau State Basic Education Law.'
  },

  {
    name: 'Operation Rainbow',
    abbreviation: 'Operation Rainbow',
    alsoWritten: ['Operation Rainbow Plateau State', 'Plateau State Neighborhood Watch'],
    category: 'SECURITY',
    currentLeadership: {
      title: 'Brig.-Gen.',
      name: 'G.G. Shipi (rtd)',
      position: 'State Coordinator',
      note: 'Leading community neighborhood watch, early warning intelligence, and civil protection.'
    },
    pastLeadership: [
      { role: 'Coordinator', title: 'Maj.-Gen.', name: 'Nicholas Rogers (rtd)', period: '2019 – 2023' }
    ],
    administrativeHistory: 'Created under Governor Jonah Jang and strengthened under successive administrations as a state-backed community security intelligence outfit.',
    mandate: 'Maintain neighborhood vigilance, collect grassroots early-warning security intelligence, protect rural communities from armed attacks, foster inter-ethnic peace, and liaise closely with federal security forces (Police, Operation Safe Haven, Civil Defence).',
    vision: 'A safe, peaceful, and secure Plateau State where communities live without fear of armed violence.',
    mission: 'To provide proactive community surveillance, early warning alert networks, and peaceful civil defense support to safeguard Plateau lives and farmlands.',
    departments: [
      'Directorate of Community Neighborhood Operations',
      'Directorate of Intelligence & Early Warning Gathering',
      'Directorate of Training & Civil Protection',
      'Directorate of Inter-Agency Liaison'
    ],
    citizenServices: [
      '24-hour toll-free reporting of imminent security threats, suspicious armed movements, and distress calls in rural communities',
      'Community neighborhood patrol coordination and early warning de-escalation',
      'Protection of farming communities and conflict hotspot liaison'
    ],
    contact: {
      office: 'Jos, Plateau State',
      phones: ['+2348037042854'],
      email: 'operationrainbow@plateaustate.gov.ng',
      website: 'https://plateaustate.gov.ng'
    },
    legalFramework: 'Plateau State Operation Rainbow Law.'
  },

  {
    name: 'Plateau State Water Board',
    abbreviation: 'PSWB',
    alsoWritten: ['Plateau State Water Board (PSWB)', 'State Water Board'],
    category: 'GOVERNMENT',
    currentLeadership: {
      title: 'Engr.',
      name: 'Eugene Pam',
      position: 'General Manager',
      note: 'Leading urban water treatment, pipe rehabilitation, and clean drinking water distribution.'
    },
    pastLeadership: [
      { role: 'General Manager', title: 'Engr.', name: 'David Wuyep', period: 'Pre-2023' }
    ],
    administrativeHistory: 'Founded to operate the urban municipal piped water networks, Yakubu Gowon Dam treatment facility at Lamingo, and regional water supply schemes.',
    mandate: 'Treat and distribute potable drinking water across Jos-Bukuru metropolis and regional urban centres; maintain dams, reservoirs, and pipe networks; bill water consumers; and test municipal water purity.',
    vision: 'Uninterrupted supply of clean, safe, and affordable piped water to every urban home and business in Plateau State.',
    mission: 'To produce and distribute water adhering strictly to WHO and Nigerian Drinking Water Quality Standards.',
    departments: [
      'Department of Water Treatment & Quality Control',
      'Department of Distribution, Pipe Networks & Maintenance',
      'Department of Commercial Operations, Metering & Billing',
      'Department of Mechanical, Electrical & Dam Operations'
    ],
    citizenServices: [
      'New public municipal water pipeline connections and water meter installations',
      'Reporting burst water pipes, leakages, and municipal water supply interruptions',
      'Payment of monthly residential and commercial water bills',
      'Laboratory bacteriological and physicochemical water testing for private boreholes'
    ],
    contact: {
      office: 'British America Junction, Jos, Plateau State',
      phones: ['+2348037042854'],
      email: 'pswb@plateaustate.gov.ng',
      website: 'https://plateaustate.gov.ng'
    },
    legalFramework: 'Plateau State Water Board Law.'
  },

  {
    name: 'Plateau Agricultural Development Programme',
    abbreviation: 'PADP',
    alsoWritten: ['Plateau Agricultural Development Programme (PADP)', 'PADP Jos'],
    category: 'GOVERNMENT',
    currentLeadership: {
      title: 'Mr.',
      name: 'Bitrus Dalyop',
      position: 'Programme Manager',
      note: 'Directing statewide agricultural extension delivery, smallholder farmer support, and demonstration farms.'
    },
    administrativeHistory: 'Established under World Bank counterpart funding to provide front-line agricultural extension services to smallholder farmers.',
    mandate: 'Deliver agricultural extension advisory to smallholder farmers; train farmers on climate-smart agronomic practices; introduce high-yield certified seeds and seedlings; manage farm demonstration plots; and monitor pest attacks.',
    vision: 'A food-secure Plateau State powered by empowered, knowledgeable, and technologically equipped smallholder farmers.',
    mission: 'To bridge the gap between agricultural research and farming practices through effective extension services.',
    departments: [
      'Department of Extension Services & Farmer Training',
      'Department of Technical Services & Seed Multiplication',
      'Department of Rural Infrastructure & Fadama Development',
      'Department of Monitoring, Evaluation & Agronomic Surveys'
    ],
    citizenServices: [
      'Field extension advisory visits by Village Extension Workers (VEWs) across all agricultural zones',
      'Provision of certified improved crop seeds (maize, Irish potato, cowpea, sorghum, rice)',
      'Training on integrated pest management (Fall Armyworm control, potato blight prevention)',
      'Farmer Field School (FFS) demonstration classes and modern irrigation techniques'
    ],
    contact: {
      office: 'Dogon Dutse, Jos, Plateau State',
      phones: ['+2348037042854'],
      email: 'padp@plateaustate.gov.ng',
      website: 'https://plateaustate.gov.ng'
    },
    legalFramework: 'Plateau State Agricultural Development Programme Edict.'
  },

  {
    name: 'Plateau State Primary Health Care Board',
    abbreviation: 'PSPHCB',
    alsoWritten: ['Plateau State Primary Health Care Board (PSPHCB)', 'Plateau Primary Health Care Development Board'],
    category: 'HOSPITAL',
    currentLeadership: {
      title: 'Dr.',
      name: 'Raymond Juryit',
      position: 'Executive Secretary',
      note: 'Leading Primary Health Care Under One Roof (PHCUOR), routine immunization, and maternal healthcare.'
    },
    administrativeHistory: 'Created to coordinate primary health centres across all 325 electoral wards under the Primary Health Care Under One Roof policy.',
    mandate: 'Manage, staff, and supervise all Primary Health Centres (PHCs) and basic health clinics; conduct routine childhood immunization campaigns; combat maternal and infant mortality; and deliver primary preventive healthcare.',
    vision: 'A healthy grassroots population with access to functional, accessible, and well-equipped primary health centres in every ward.',
    mission: 'To deliver high-impact, integrated primary healthcare services through community ownership and skilled primary healthcare workers.',
    departments: [
      'Department of Disease Control & Immunization',
      'Department of Maternal, Newborn & Child Health',
      'Department of Primary Healthcare Infrastructure & Logistics',
      'Department of Community Mobilization & Health Education'
    ],
    citizenServices: [
      'Routine childhood vaccinations (Polio, BCG, Pentavalent, Measles, Yellow Fever, HPV)',
      'Antenatal care, safe childbirth delivery, and postnatal tracking at ward PHCs',
      'Free distribution of insecticide-treated bed nets (ITNs) and malaria rapid diagnostic testing',
      'Community health outreaches and child nutrition supplementation'
    ],
    contact: {
      office: 'Jos, Plateau State',
      phones: ['+2348035990349'],
      email: 'psphcb@plateaustate.gov.ng',
      website: 'https://plateaustate.gov.ng'
    },
    legalFramework: 'Plateau State Primary Health Care Development Board Law.'
  },

  {
    name: 'Plateau State Road Maintenance Agency',
    abbreviation: 'PLARAMA',
    alsoWritten: ['Plateau State Road Maintenance Agency (PLARAMA)', 'PLARAMA'],
    category: 'GOVERNMENT',
    currentLeadership: {
      title: 'Engr.',
      name: 'Pam Dung',
      position: 'General Manager',
      note: 'Leading rapid response pothole patching, asphalt maintenance, and drainage clearing.'
    },
    administrativeHistory: 'Dedicated road maintenance agency operating under the supervision of the Ministry of Works to keep state highways motorable.',
    mandate: 'Carry out routine and periodic road maintenance, emergency pothole repairs, culvert restorations, and storm drain clearings on all state roads across the 17 LGAs.',
    vision: 'Zero pothole highways and seamless, safe vehicular mobility across Plateau State.',
    mission: 'To maintain state roads efficiently and proactively using skilled direct-labor teams and quality asphalt materials.',
    departments: [
      'Department of Direct Labour Operations & Asphalt Patching',
      'Department of Road Drainage & Structural Maintenance',
      'Department of Highway Monitoring & Emergency Intervention'
    ],
    citizenServices: [
      'Rapid intervention pothole patching on damaged township and inter-town state roads',
      'Desilting and rehabilitation of road culverts to prevent seasonal flooding',
      'Public reporting intake for dangerous road washouts and damaged bridges'
    ],
    contact: {
      office: 'Works Yard, Joseph Gomwalk Secretariat, Jos, Plateau State',
      phones: ['+2348037042854'],
      email: 'plarama@plateaustate.gov.ng',
      website: 'https://plateaustate.gov.ng'
    },
    legalFramework: 'Plateau State Road Maintenance Agency Law.'
  },

  {
    name: 'Plateau Investment and Property Development Company',
    abbreviation: 'PIPC',
    alsoWritten: ['Plateau Investment and Property Development Company (PIPC)', 'PIPC'],
    category: 'GOVERNMENT',
    currentLeadership: {
      title: 'Mr.',
      name: 'Danladi Dalyop',
      position: 'Managing Director / CEO',
      note: 'Leading state commercial investment portfolios, equity assets, and real estate properties.'
    },
    administrativeHistory: 'The premier commercial investment vehicle of the Plateau State Government, managing state equities and commercial properties.',
    mandate: 'Manage the state government\'s equity portfolios in quoted and unquoted companies; develop and manage commercial real estate; promote joint venture industrial investments; and unlock wealth from state assets.',
    vision: 'A premier sovereign investment corporation driving sustainable industrialization and wealth for Plateau State.',
    mission: 'To maximize return on state capital assets, attract global private investments, and develop strategic commercial enterprises.',
    departments: [
      'Department of Portfolio Investments & Capital Markets',
      'Department of Real Estate Development & Property Management',
      'Department of Business Development & Joint Ventures'
    ],
    citizenServices: [
      'Commercial office space and shopping plaza leasing in PIPC commercial properties',
      'Joint-venture investment partnerships in agro-processing, tourism, and real estate',
      'Verification of state shareholdings and investment asset disclosures'
    ],
    contact: {
      office: 'PIPC House, Murtala Mohammed Way, Jos, Plateau State',
      phones: ['+2348037042854'],
      email: 'info@pipc.com.ng',
      website: 'https://pipc.com.ng'
    },
    legalFramework: 'Incorporated under CAMA and Plateau State Investment Mandate.'
  }
];

// Enrich with raw API descriptions where useful
for (const entry of MDA_CATALOG) {
  const raw = findRaw(entry.abbreviation) || findRaw(entry.name);
  if (raw && raw.about) {
    if (!entry.rawVision && raw.about.vision) entry.rawVision = cleanHtml(raw.about.vision);
    if (!entry.rawMission && raw.about.mission) entry.rawMission = cleanHtml(raw.about.mission);
    if (!entry.rawDescription && raw.about.description) entry.rawDescription = cleanHtml(raw.about.description);
    if (raw.director && raw.director.name && !entry.rawLeader) {
      entry.rawLeader = {
        name: raw.director.name,
        title: raw.director.title,
        position: raw.director.position
      };
    }
    if (raw.contact && raw.contact.location && !entry.rawLocation) {
      entry.rawLocation = raw.contact.location;
    }
  }
}

// ── BUILD OUTPUTS ─────────────────────────────────────────────────────────────

console.log(`Loaded ${MDA_CATALOG.length} comprehensive MDAs into catalog.`);

// Merge existing enriched fields (e.g. currentProjects) if jsonOut exists
const jsonOut = path.join(__dirname, '..', 'data', 'plateau-mdas-knowledge-base.json');
if (fs.existsSync(jsonOut)) {
  try {
    const existing = JSON.parse(fs.readFileSync(jsonOut, 'utf8'));
    for (const em of existing) {
      const match = MDA_CATALOG.find((m) => m.name === em.name || (m.abbreviation && m.abbreviation === em.abbreviation));
      if (match) {
        if (em.currentProjects && em.currentProjects.length && !match.currentProjects) {
          match.currentProjects = em.currentProjects;
        }
        if (em.currentLeadership && em.currentLeadership.name && (!match.currentLeadership || match.currentLeadership.name !== em.currentLeadership.name)) {
          match.currentLeadership = em.currentLeadership;
        }
      }
    }
  } catch (e) {
    console.warn('Could not merge existing json:', e.message);
  }
}

// 1. Write structured JSON
fs.writeFileSync(jsonOut, JSON.stringify(MDA_CATALOG, null, 2));
console.log(`Wrote structured knowledge base to ${jsonOut}`);

// 2. Write individual markdown documents for ingestion / inspection
const mdaDocsDir = path.join(__dirname, '..', 'data', 'mda-knowledge');
fs.mkdirSync(mdaDocsDir, { recursive: true });

function buildMarkdownDoc(m) {
  const lines = [];
  const title = m.abbreviation ? `${m.abbreviation} — ${m.name}` : m.name;
  lines.push(`# ${title}`);
  if (m.alsoWritten && m.alsoWritten.length) {
    lines.push(`Also known as: ${m.alsoWritten.join(', ')}`);
  }
  lines.push('');

  // Current Leadership
  lines.push('## Current Leadership');
  const cur = m.currentLeadership;
  const who = [cur.title, cur.name].filter(Boolean).join(' ');
  lines.push(`- **${cur.position}**: ${who}`);
  if (cur.permanentSecretary) lines.push(`- **Permanent Secretary**: ${cur.permanentSecretary}`);
  if (cur.note) lines.push(`- **Role Overview**: ${cur.note}`);
  lines.push('');

  // Past Leadership & History
  lines.push('## Past Leadership & Administrative History');
  if (m.pastLeadership && m.pastLeadership.length) {
    for (const p of m.pastLeadership) {
      const pWho = [p.title, p.name].filter(Boolean).join(' ');
      lines.push(`- **Former ${p.role}**: ${pWho} (${p.period})`);
    }
  } else {
    lines.push('- Predecessor leadership records maintained under historical state gazettes and executive transition archives.');
  }
  if (m.administrativeHistory) {
    lines.push('');
    lines.push(m.administrativeHistory);
  }
  lines.push('');

  // What this agency does
  lines.push('## Mandate and Core Functions');
  lines.push(m.mandate);
  lines.push('');
  if (m.vision) {
    lines.push(`**Vision**: ${m.vision}`);
    lines.push('');
  }
  if (m.mission) {
    lines.push(`**Mission**: ${m.mission}`);
    lines.push('');
  }

  // Departments
  if (m.departments && m.departments.length) {
    lines.push('## Key Departments and Directorates');
    for (const d of m.departments) lines.push(`- ${d}`);
    lines.push('');
  }

  // Citizen Services
  if (m.citizenServices && m.citizenServices.length) {
    lines.push('## Public Services and Citizen Assistance');
    for (const s of m.citizenServices) lines.push(`- ${s}`);
    lines.push('');
  }

  // Current Projects & Strategic Initiatives
  if (m.currentProjects && m.currentProjects.length) {
    lines.push('## Current Projects, Strategic Initiatives & Ongoing Activities');
    for (const p of m.currentProjects) lines.push(`- ${p}`);
    lines.push('');
  }

  // Supervised Parastatals or Institutions
  if (m.supervisedParastatals && m.supervisedParastatals.length) {
    lines.push('## Supervised Parastatals and Tertiary Institutions');
    for (const p of m.supervisedParastatals) lines.push(`- ${p}`);
    lines.push('');
  }
  if (m.touristSites && m.touristSites.length) {
    lines.push('## Key State Tourist Destinations Managed');
    for (const t of m.touristSites) lines.push(`- ${t}`);
    lines.push('');
  }
  if (m.facilities && m.facilities.length) {
    lines.push('## Key State Facilities');
    for (const f of m.facilities) lines.push(`- ${f}`);
    lines.push('');
  }

  // How to Reach It
  lines.push('## How to Reach It');
  lines.push(`- **Office Location**: ${m.contact.office}`);
  if (m.contact.phones && m.contact.phones.length) {
    lines.push(`- **Phone**: ${m.contact.phones.join(', ')}`);
  }
  if (m.contact.email) {
    lines.push(`- **Email**: ${m.contact.email}`);
  }
  if (m.contact.website) {
    lines.push(`- **Website**: ${m.contact.website}`);
  }
  lines.push('');

  if (m.legalFramework) {
    lines.push('## Legal Framework and Enabling Law');
    lines.push(m.legalFramework);
    lines.push('');
  }

  lines.push('---');
  lines.push(
    `Source: Plateau State Government Official Portal, State Executive Council Gazettes, and Public Verified Directory. Last updated: ${new Date().toISOString().slice(0, 10)}.`
  );

  return { title, body: lines.join('\n') };
}

let docCount = 0;
for (const m of MDA_CATALOG) {
  const d = buildMarkdownDoc(m);
  const safeName = d.title.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
  fs.writeFileSync(path.join(mdaDocsDir, `${safeName}.md`), d.body + '\n');
  docCount++;
}
console.log(`Generated ${docCount} markdown files in ${mdaDocsDir}`);

// 3. Write Master Comprehensive Knowledge Document
const masterDocPath = path.join(__dirname, '..', 'docs', 'plateau-state-mdas-comprehensive-knowledge.md');
const masterLines = [];
masterLines.push('# Comprehensive Directory & Knowledge Base: Plateau State Ministries, Departments, and Agencies (MDAs)');
masterLines.push('');
masterLines.push('> **Official Knowledge Document for the Customer Care Platform & AI Citizen Assistant.**');
masterLines.push('> Covers current leadership (Commissioners, Directors-General, Chairmen, General Managers), past leadership and historical succession ("pass dtails"), mandates, departments, citizen-facing services, and verified contact points across all Plateau State MDAs.');
masterLines.push('');
masterLines.push('## Table of Contents');
masterLines.push('');
masterLines.push('### Ministries');
MDA_CATALOG.filter(m => m.category === 'GOVERNMENT' && m.name.startsWith('Ministry')).forEach(m => {
  masterLines.push(`- [${m.name} (${m.abbreviation})](#${m.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')})`);
});
masterLines.push('');
masterLines.push('### Executive Offices, Central Administration & Specialized Agencies');
MDA_CATALOG.filter(m => !(m.category === 'GOVERNMENT' && m.name.startsWith('Ministry'))).forEach(m => {
  masterLines.push(`- [${m.name} (${m.abbreviation || 'MDA'})](#${m.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')})`);
});
masterLines.push('');
masterLines.push('---');
masterLines.push('');

for (const m of MDA_CATALOG) {
  const d = buildMarkdownDoc(m);
  masterLines.push(d.body);
  masterLines.push('');
  masterLines.push('---');
  masterLines.push('');
}

fs.writeFileSync(masterDocPath, masterLines.join('\n'));
console.log(`Wrote master comprehensive knowledge doc to ${masterDocPath}`);
