const fs = require('fs');
const path = require('path');

const FILE_PATH = path.join(__dirname, '..', 'data', 'plateau-mdas-knowledge-base.json');
const mdas = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));

/**
 * Comprehensive Governor Caleb Manasseh Mutfwang ("The Time is Now" Administration,
 * May 2023 – Present) projects across ALL 58 Plateau State MDAs.
 */
const PROJECTS_MAP = {
  MARD: [
    "Direct Fertilizer & Farm Input Intervention: Distribution of over 200 truckloads (more than 120,000 bags) of subsidized NPK and Urea fertilizers, improved maize and rice seedlings, and agro-chemicals directly to registered farmers across all 17 LGAs.",
    "BARI & Resettlement Dry-Season/Wet-Season Farming Initiative: Cultivation of over 6,000+ hectares of abandoned and conflict-affected farmlands across Barkin Ladi, Riyom, Bokkos, Mangu, and Bassa in partnership with ASTC and PADP, providing free land preparation, inputs, and security cover for displaced farmers.",
    "Irish Potato Value Chain & Tissue Culture Multiplication: Tissue culture seed multiplication, late-blight control, and modern cold-storage/packhouse facilities in Bokkos, Mangu, and Barkin Ladi.",
    "ASTC Agricultural Mechanization & Tractor Fleet Revival: Acquisition and refurbishment of heavy-duty tractors, harvesters, and planters under the Agricultural Services and Training Centre (ASTC) Vom/Kassa to provide subsidized tractor leasing across the 3 senatorial zones."
  ],
  MoBEP: [
    "2024 'Budget of New Beginnings' (₦314.86 Billion) & 2025 'Budget of Sustainability and Economic Transformation' (₦468.49 Billion): Transitioning Plateau State to a 60.9% capital-expenditure-driven budget focused on infrastructure, agriculture, digital economy, and human capital.",
    "State Fiscal Transparency, Accountability and Sustainability (SFTAS) & SABER Reforms: Implementation of World Bank-supported State Action on Business Enabling Reforms (SABER) and Citizens' Participatory Budget townhalls across all 3 senatorial districts.",
    "Medium-Term Sector Strategy (MTSS 2024–2027) & Automated Budget Monitoring Portal: Digital tracking of capital project releases, contractor milestones, and donor counterpart funds."
  ],
  MOCI: [
    "Jos Main Market (Terminus) Redevelopment & Commercial Hub Revival: Phased urban renewal and PPP-driven reconstruction of the historic Jos Main Market and surrounding commercial corridors to restore Plateau as North-Central Nigeria's trade capital.",
    "Jos Inland Container Dry Port (Heipang) & Special Agro-Industrial Processing Zone (SAPZ): Fast-tracking completion of the Heipang Inland Dry Port and African Development Bank (AfDB)-backed Special Agro-Industrial Processing Zone for export of Irish potatoes, vegetables, and solid minerals.",
    "One-Stop Investment & Ease of Doing Business Desk: Streamlining business premises registration, cooperative society digitization, and MSME trade fair exhibitions."
  ],
  MoE: [
    "State-Wide Secondary School Rehabilitation & Model Science Schools Upgrade: Renovation of dilapidated classrooms, hostels, and science/computer laboratories across government secondary schools in all 17 LGAs.",
    "Merit-Based Teacher Recruitment & Capacity Training: Recruitment and digital pedagogical training of thousands of qualified secondary and basic education teachers to close the rural teacher gap.",
    "Adolescent Girls Initiative for Learning and Empowerment (AGILE): World Bank-assisted project upgrading secondary school infrastructure, WASH facilities, digital literacy labs, and conditional cash transfers to keep girls in school across Plateau State."
  ],
  MECCMD: [
    "Agro-Climatic Resilience in Semi-Arid Landscapes (ACReSAL): World Bank-backed multi-million-dollar watershed management, gully erosion control, afforestation, and climate-smart agriculture project across degraded sites in Jos North, Jos South, Barkin Ladi, Mangu, Shendam, and Wase.",
    "Executive Order on Illegal Mining Suspension & Artisanal Miners Formalization: Reorganizing mining cooperatives, curbing environmental degradation and insecurity around mining sites, and establishing mineral buying centers so Plateau benefits from its tin, columbite, lithium, and lead-zinc endowments.",
    "Clean & Green Plateau Tree Planting & Urban Beautification Campaign: Planting of over 500,000 economic and ornamental trees across metropolitan Jos-Bukuru and erosion-prone LGAs."
  ],
  MOF: [
    "Clearing of Multi-Year Civil Service Salary, Pension & Gratuity Arrears: Liquidation of inherited 4-to-6-month salary backlogs, restoration of prompt monthly salary payments before the 25th of every month, and phased clearing of long-standing gratuity/pension arrears.",
    "₦70,000 New National Minimum Wage Implementation: Full implementation of the new ₦70,000 minimum wage for Plateau State civil servants following landmark agreement with organized labour.",
    "Treasury Single Account (TSA) & Integrated Financial Management Information System (IFMIS): Blocking revenue leakages, centralizing state receipts, and digitizing payroll verification."
  ],
  MOH: [
    "General Hospitals Comprehensive Upgrade & Re-equipping: Renovation and equipping of zonal General Hospitals in Barkin Ladi, Mangu, Pankshin, Shendam, Langtang, and Bukuru with solar power, digital X-ray, ultrasound, and theatre equipment.",
    "Plateau State Pharma-Grade Central Medical Warehouse: Commissioning of a modern, temperature-controlled central pharma-grade warehouse in Jos (managed with PSDMCMA) to guarantee uninterrupted supply of genuine, affordable medicines.",
    "Health Workforce Retention & CONMESS/CONHESS Welfare Implementation: Improved hazard and welfare packages for doctors, nurses, and midwives, plus accreditation restoration at state health training institutions."
  ],
  MHUD: [
    "New Jos Urban Pocket Layouts & Civil Servants Affordable Housing Scheme: Development of serviced residential layouts and PPP mass housing estates for civil servants and low-to-middle-income earners in Jos South, Bassa, and Barkin Ladi.",
    "Government Buildings & Liaison Offices Rehabilitation: Renovation of the J.D. Gomwalk State Secretariat Complex, Government House Rayfield facilities, and the Plateau State Liaison Office in Abuja.",
    "Urban Slum Upgrading & Public Lighting Project: Installation of solar-powered streetlights and drainage networks across high-density neighborhoods in Greater Jos."
  ],
  MHAPA: [
    "Safe Return, Rehabilitation & Resettlement of Internally Displaced Persons (IDPs): Coordinated humanitarian relief, building materials support, trauma counseling, and security-backed return of displaced families in Bokkos, Mangu, Barkin Ladi, Riyom, and Bassa.",
    "Plateau Social Register Expansion & Conditional Cash Transfers: Expanding the verified State Social Register of vulnerable households for federal/state palliative distributions, livelihood grants, and food security interventions."
  ],
  MOIC: [
    "Plateau State Government Citizen Contact Centre (Nanpan AI Helpline — 08000000456): Launch of Nigeria's first multilingual AI-enabled State Citizen Contact Centre & Public Inquiry Desk handling citizen complaints, emergency routing, and MDA inquiries in English, Hausa, Pidgin, Yoruba, Igbo, and Plateau indigenous languages.",
    "PRTVC & State Media Digital Broadcast Modernization: Upgrading transmitters, studio equipment, and digital terrestrial broadcasting at Plateau Radio Television Corporation (Rayfield & Bukuru) and reviving The Nigeria Standard newspaper.",
    "Regular Ministerial Press Briefings & Citizen Townhall Series: Open-government accountability briefings detailing MDA scorecards under 'The Time is Now' administration."
  ],
  MOJ: [
    "Administration of Criminal Justice Law (ACJL) & E-Justice Digitization: Fast-tracking criminal trials, decongesting correctional centers through prerogative of mercy and bail reviews, and digitizing case records.",
    "Citizens' Rights & Alternative Dispute Resolution (ADR) Multi-Door Courthouse: Expanding free legal aid for indigent citizens and commercial/community mediation services in Jos.",
    "Land Swap & Anti-Land-Grabbing Legal Enforcement: Prosecuting illegal land grabbing and enforcing state land administration laws."
  ],
  MLSTP: [
    "PLAGIS Digital Land Administration Reform: Plateau State Geographic Information System digitalization of all cadastral maps, automated land title searches, electronic land registries, and accelerated issuance of electronic Certificates of Occupancy (e-C of O).",
    "State-Wide Aerial Cadastral Mapping: High-resolution GIS aerial mapping of urban and rural land parcels to resolve boundary disputes and enhance land documentation.",
    "50% Waiver & Recertification Drive on Land Title Regularization: Special governor's concession enabling property owners to regularize titles and obtain digital C of O at discounted rates."
  ],
  MLDVSF: [
    "Creation of Dedicated Ministry of Livestock Development, Veterinary Services & Fisheries (2025): Institutional reform by Governor Mutfwang to unlock Plateau's livestock, dairy, poultry, and aquaculture economy and align with the Federal Ministry of Livestock Development.",
    "Wase Grazing Reserve & Modern Ranching Transformation: Developing modern pasture, veterinary clinics, and water earth-dams to transition from open grazing to ranching and peaceful livestock production.",
    "Panyam Fish Farm & NVRI Vom Vaccine Cold-Chain Partnership: Revitalization of Panyam Fish Farm in Mangu and statewide mass vaccination of cattle, sheep, goats, and poultry against transboundary animal diseases."
  ],
  MLGCA: [
    "Conduct of Peaceful, Democratic Elections Across All 17 LGAs (October 2024): Restoration of full democratically elected Local Government Chairmen and Councillors across all 17 LGAs.",
    "LGA Financial Autonomy & Joint Account Transparency Projects: Coordinating rural market upgrades, primary healthcare counterpart funding, and traditional council welfare across all 17 LGAs.",
    "Graders & Earth-Moving Equipment Acquisition for Rural LGA Roads: Procurement of motor graders and rollers for grading rural feeder roads across the 3 senatorial zones."
  ],
  MOSTI: [
    "Rural Renewable Energy & Solar Mini-Grids: Installing solar power systems and mini-grids in rural primary healthcare centers, public schools, and government facilities across off-grid communities in Plateau State.",
    "Plateau State STEM Education Modernization: Equipping public secondary school science laboratories with modern laboratory equipment, computer workstations, and robotics learning kits.",
    "Plateau Innovation and Invention Grant Scheme: Providing technical grants, prototype incubation, and intellectual property patenting support for grassroots inventors and young technical innovators."
  ],
  "MTC&H": [
    "Hill Station Hotel & Plateau Hotel PPP Revitalization: Landmark concession and redevelopment partnerships with premier hospitality investors to rebuild Hill Station Hotel and Plateau Hotel into 5-star international hospitality hubs.",
    "Jos Wildlife Park & Pandam Game Reserve Eco-Tourism Rehabilitation: Upgrading perimeter fencing, safari tracks, animal enclosures, and visitor chalets at Jos Wildlife Park and Pandam Wildlife Park.",
    "Plateau Cultural Carnival & Heritage Festival Revival: Promoting Nzem Berom, Puuskat Mwaghavul, Pusdung Ngas, Bit Goemai, Ilumutarok, and domestic tourism."
  ],
  MOT: [
    "Jos–Bukuru Commuter Rail Line Revival: Rehabilitation and resumption of passenger train services along the Jos–Bukuru–Kuru rail corridor in partnership with the Nigerian Railway Corporation (NRC) to provide affordable mass transit.",
    "Yakubu Gowon Airport (Heipang) Upgrade & Abuja–Jos Scheduled Flights: Partnership with ValueJet Airlines and FAAN to restore regular commercial flights between Abuja and Jos (in addition to Lagos–Jos routes) and upgrade airport fire/navigational infrastructure into an international agro-cargo hub.",
    "Tin City Metro Bus Rapid Transit (BRT) Expansion: Supervision of the 15-bus luxury Tin City Metro fleet and smart-card terminal infrastructure across Greater Jos."
  ],
  MWRED: [
    "SURWASH (Sustainable Urban and Rural Water Supply, Sanitation and Hygiene): World Bank-supported program rehabilitating urban water treatment works and expanding piped water connections in Jos-Bukuru and semi-urban LGA headquarters.",
    "Assop Hydro & State Clean Energy Transition Policy: Utilizing the new Electricity Act to develop mini-hydropower and solar independent power projects (IPPs) across Plateau State.",
    "State-Wide Dam Desilting & Irrigation Dam Repairs: Rehabilitation of Yakubu Gowon Dam, Lamingo Dam, Shen Dam, and Langtang Dam."
  ],
  MWASD: [
    "Nigeria for Women Project (NFWP) Scale-Up: World Bank-supported women's affinity groups, financial inclusion, and livelihood grants empowering tens of thousands of rural and urban women across Plateau State.",
    "Gender-Based Violence (GBV) One-Stop Sexual Assault Referral Centres (SARCs): Upgrading trauma shelters, psychosocial support, and vocational rehabilitation for survivors of gender violence and conflict.",
    "Orphans, Widows & Persons With Disabilities (PWDs) Empowerment: Distribution of assistive devices, starter packs, and micro-grants to widows and PWDs across the 17 LGAs."
  ],
  MOW: [
    "Metropolitan Jos–Bukuru Road Dualization & Urban Renewal Network: Rehabilitation and asphalt overlay of over 35+ key urban roads across Jos North and Jos South (including Tudun Wada–Kabong, Rukuba Road spurs, Hwolshe, Rayfield, Bukuru Express service lanes, Apata, Jenta, and Secretariat links).",
    "Strategic Inter-LGA Arterial Roads & Bridges Construction: Ongoing construction and rehabilitation of critical rural-urban highways and bridges across Riyom, Barkin Ladi, Mangu, Bokkos, Pankshin, Kanke, Shendam, Langtang, Mikang, Qua'an Pan, and Wase.",
    "Rural Access and Agricultural Marketing Project (RAAMP): Constructing all-weather feeder roads and river crossings connecting agricultural clusters to markets across the 17 LGAs."
  ],
  MYSD: [
    "Zaria Road New Jos International Stadium Completion Drive: Phased engineering work and pitch/spectator upgrades at the Zaria Road Stadium and Rwang Pam Township Stadium.",
    "Plateau United FC & Mighty Jets FC Revitalization & Grassroots Sports Talent Hunt: Sponsorship of state football clubs, Governor's Cup tournament across 17 LGAs, and national marathon hosting in Jos.",
    "Plateau Youth Artisanal, Agro-Preneurship & Digital Skills Bootcamp: Training and equipping over 5,000 youths in solar installation, modern carpentry, welding, fashion, and ICT."
  ],
  OSGS: [
    "Inter-Agency Security Coordination & Operation Rainbow Reinforcement: Central coordination of military, police, DSS, NSCDC, and Operation Rainbow deployments, early-warning response, and logistics support across all 17 LGAs.",
    "Executive Orders Implementation & Policy Tracking Unit: Enforcing Executive Order 003 (urban traffic, illegal structures, and sanitation sanity in Greater Jos) and monitoring cabinet performance.",
    "Biometric Verification & Christian/Muslim Pilgrims Welfare Reform: Streamlining state sponsorship and welfare operations for holy pilgrimages."
  ],
  OHCS: [
    "Civil Service Digital Transformation & E-Registry: Full computerization of civil service personnel records, promotion examinations, and digital work emails in partnership with PICTDA.",
    "Restoration of Civil Service Training, Promotions & Leave Grants: Clearing backlogs of staff promotions, reopening the Civil Service Training Centre, and implementing the ₦70,000 minimum wage structure.",
    "Secretariat Solar Power & Workspace Modernization: Upgrading offices across the J.D. Gomwalk State Secretariat for higher productivity."
  ],
  OAG: [
    "State Integrated Financial Management Information System (SIFMIS): Real-time electronic treasury operations, automated warrant releases, and biometric pension/salary payment validation.",
    "IPSAS Accrual Accounting Compliance & Timely Audited Financial Statements: Publication of transparent quarterly budget execution reports and annual audited state accounts."
  ],
  SAI: [
    "Performance & Value-for-Money Capital Project Audits: Physical verification and forensic auditing of state capital projects across all 17 LGAs to ensure contractors deliver to specification.",
    "Digital Audit Management System: Transitioning state audit workflows to paperless electronic working papers."
  ],
  JMDB: [
    "Jos Main Market (Terminus) Urban Renewal & Traffic Decongestion (Executive Order 003): Clearing illegal roadside shanties, restoring pedestrian walkways, and reorganizing Terminus, Ahmadu Bello Way, and Bukuru commercial corridors.",
    "Greater Jos Master Plan GIS Revision: Digital zoning and urban master plan overhaul to manage urban growth, protect green areas, and guide sustainable metropolitan development.",
    "E-Permit Digital Building Approval Portal: Online portal for submitting, vetting, and issuing building approvals within 14 days, alongside structural integrity audits to prevent building collapse."
  ],
  PLASCHEMA: [
    "Informal Sector Universal Health Coverage Expansion: Massive statewide enrollment drives enrolling artisans, market traders, farmers, and self-employed individuals at ₦12,000/year per person or ₦50,000/year for families of 6.",
    "Retiree Free Healthcare Scheme: Providing fully subsidized medical care coverage for state and local government retirees under Governor Caleb Mutfwang's social welfare mandate.",
    "Basic Health Care Provision Fund (BHCPF) & Vulnerable Group Equity Plan: 100% free healthcare coverage for over 100,000+ vulnerable citizens (pregnant women, children under 5, elderly 65+, IDPs, and persons living with disabilities).",
    "Digital Health Management Information System & Biometric Verification: Automated provider claims processing and electronic patient authentication across accredited public and private hospitals."
  ],
  PEPSA: [
    "'Keep Plateau Clean' Metropolitan Waste Evacuation Fleet Upgrade: Acquisition of modern compactor trucks, roll-off bins, and motorized street sweepers clearing decades-old refuse dumps across Jos and Bukuru.",
    "Waste-to-Wealth Recycling & Plastic Recovery Initiative: Establishing material recovery facilities and organic compost conversion plants.",
    "Monthly Environmental Sanitation & Drainage Desilting Campaign: Clearing blocked stormwater drains ahead of rainy seasons to prevent urban flash flooding."
  ],
  PICTDA: [
    "State-Wide Broadband Fibre Infrastructure Expansion: Expanding high-speed fibre-optic coverage from 900 km to 2,500 km across Plateau State in a public-private partnership with Solutron Eastern Fibre Limited.",
    "Code Plateau Fellowship (6.0 & Code Plateau on Wheels): Flagship tuition-free software engineering, AI, UI/UX, data science, and cybersecurity academy in Jos with mobile digital outreach to rural LGAs.",
    "Federal 3 Million Technical Talents (3MTT) Partnership: Training thousands of Plateau youths in software development, cloud computing, and AI.",
    "LGA Computer-Based Test (CBT) & Grassroots Innovation Centres: Establishing modern digital examination and innovation hubs across Plateau State's 17 LGAs (including Qua'an Pan Innovation Hub and Murtala Mohammed House Tech Hub).",
    "Government E-Governance & Data-Driven Digital Migration: Digitizing school management, civil service payroll, judiciary files, and official `plateaustate.gov.ng` MDA portals.",
    "ICT Procurement Technical Clearance & Vendor Registry: Enforcing IT standards and local tech patronage across state MDAs.",
    "Silicon Plateau & Tech Ecosystem Collaboration: Hosting the Plateau State Tech Summit and partnering with NITDA, World Bank, PLATEC, and nHub."
  ],
  PSIRS: [
    "Central Billing System (CBS) & Automated Tax Clearance Certificate (e-TCC): Fully automated taxpayer self-service portal (`psirs.gov.ng`) enabling online tax filing, instant electronic receipts, and e-TCC verification—growing Plateau's IGR from ~₦15B to over ₦38B–₦62B+.",
    "Harmonized Informal Sector Revenue & Single-Haulage Ticketing: Digital POS/USSD ticketing eliminating multiple taxation and illegal roadblocks across all 17 LGAs."
  ],
  PSPBA: [
    "Early Warning and Early Response (EWER) Situation Room Upgrade: 24/7 digital conflict-monitoring desk tracking community tensions across all 17 LGAs and deploying rapid mediation teams.",
    "Inter-Ethnic & Farmer-Herder Peace Dialogues: Community peace accords and trauma-healing workshops in Bokkos, Mangu, Barkin Ladi, Riyom, Bassa, and Wase."
  ],
  PLASEMA: [
    "IDP Camp Humanitarian Relief & Resettlement Logistics: Distribution of food, mattresses, roofing sheets, cement, and medical supplies to displaced persons in Mangu, Bokkos, Barkin Ladi, and Riyom.",
    "Flood Early-Warning & Disaster Rapid Response Teams: Pre-positioning relief materials and search-and-rescue equipment across flood-prone lowland LGAs (Shendam, Langtang South, Wase, Qua'an Pan, Kanam)."
  ],
  PSDMCMA: [
    "Commissioning of Pharma-Grade Central Medical Commodities Warehouse: World-class temperature-regulated central drug store in Jos ensuring 24/7 availability of genuine, low-cost essential medicines across state facilities.",
    "Central Medical Commodities Supply Chain Modernization & Anti-Counterfeit Lab: Automated inventory tracking from central warehouse to general hospitals and PHCs, plus forensic quality testing."
  ],
  PLASMEDA: [
    "Plateau CARES (NG-CARES Result Area 3) MSME Grants: Disbursement of operational support grants, IT enhancement grants, and soft loans to thousands of micro and small enterprises across all 17 LGAs.",
    "One-LGA-One-Product Industrial Clusters & Packaging Support: NAFDAC/SON certification assistance and modern packaging support for local processors of acha, Irish potato chips, coffee, honey, and leather."
  ],
  PESGL: [
    "Tin City Metro Bus Transit Modernization: Deployment of 15 German-engineered MAN/Neoplan energy-efficient metro buses operating along 8 major Jos-Bukuru corridors with automated NFC smart-card ticketing (over 10,000+ daily passengers at subsidized ₦200 fare).",
    "Plateau Riders Interstate Fleet Modernization & Terminal Upgrade: Acquisition of new air-conditioned interstate buses, digitized manifest/ticketing, and terminal renovation in Jos and Abuja."
  ],
  PLAGEO: [
    "24/7 Gender-Based Violence (GBV) Rapid Response & Legal Prosecution Desk: Toll-free reporting, survivor shelter placement, and prosecution of domestic and sexual violence cases under the VAPP Law.",
    "Women in Governance & Affirmative Action Advocacy: Community sensitization across 17 LGAs on women's inheritance rights, girl-child education, and political participation."
  ],
  PSSB: [
    "Upward Review & Prompt Disbursement of Student Bursaries and Nigerian Law School Grants: Clearing backlogs and paying enhanced bursary allowances to Plateau State indigent students in tertiary institutions nationwide and 100% sponsorship support for Plateau students at the Nigerian Law School.",
    "Digital Scholarship Application & Biometric Verification Portal: Online portal eliminating ghost beneficiaries and paying scholarships directly to students' bank accounts."
  ],
  PSEC: [
    "Plateau State Electricity Market & Mini-Grid Rollout: Implementing the Plateau State Electricity Law to attract private independent power producers (IPPs) and deploy solar hybrid mini-grids to unserved communities, hospitals, and markets.",
    "Streetlight Solarization & Public Building Energy Audits: Retrofitting metropolitan streetlights and government complexes with solar-battery hybrid systems."
  ],
  PRTVC: [
    "PRTVC AM/FM & TV Digital Switchover Modernization: Installation of new high-power digital transmitters, outside broadcasting (OB) vans, and modern HD studios in Rayfield and Bukuru, restoring clear reception across Plateau and neighboring states.",
    "24-Hour Programming & Digital Live-Streaming Launch: Expanding online streaming and indigenous language news broadcasts."
  ],
  PSSH: [
    "Plateau Specialist Hospital Infrastructure & Diagnostic Upgrade: Renovation of emergency wards, maternity complex, intensive care unit (ICU), and installation of modern CT-scan, digital X-ray, dialysis machines, and 24/7 solar-inverter backup.",
    "Electronic Medical Records (EMR) Deployment: Digitizing patient folders, pharmacy billing, and laboratory results to cut patient waiting times."
  ],
  HMB: [
    "Zonal General Hospitals Revitalization & Solarization: Upgrading clinical wards, operating theatres, blood banks, and solar power across the 18+ General and Cottage Hospitals in all 17 LGAs.",
    "Mobile Rural Medical & Surgical Outreaches: Free cataract surgeries, hernia repairs, dental care, and maternal screenings for rural citizens."
  ],
  DMO: [
    "State Domestic & External Debt Restructuring and Arrears Verification: Comprehensive forensic verification of inherited contractor liabilities and restructuring of commercial bank facilities to free up funds for capital projects.",
    "Annual Debt Sustainability Analysis (DSA) & Bond Issuance Readiness: Transparent quarterly debt reporting in compliance with Fiscal Responsibility laws."
  ],
  PSBS: [
    "Plateau State Socio-Economic & Demographic Data Portal: Conducting the State Gross Domestic Product (SGDP) computation, CPI inflation tracking, and LGA-level baseline surveys for evidence-based budgeting.",
    "Digitized Statistical Yearbook & Open Data Repository: Publishing verified data on agriculture, health, education, and employment."
  ],
  "SDGs-PSU": [
    "SDG Primary Healthcare & Rural Classroom Interventions: Construction and solarization of maternal health clinics, VIP toilets, and solar boreholes in hard-to-reach rural wards across the 3 senatorial zones.",
    "Voluntary Local Review (VLR) of SDG Progress in Plateau State: Aligning the state's 2024–2027 development plan with the UN 2030 Sustainable Development Goals."
  ],
  PSTC: [
    "Jos Wildlife Park Rehabilitation & Eco-Tourism Drive: Renovation of animal enclosures, picnic grounds, internal road network, and security perimeter at Jos Wildlife Park.",
    "Solomon Lar Amusement Park & Pandam Tourist Resort Upgrade: Revamping family recreational parks and promoting eco-tourism to Assop Falls, Kurra Falls, Wase Rock, and Shere Hills."
  ],
  TSC: [
    "Merit-Based Secondary School Teachers Recruitment & Rural Posting Incentives: Transparent computer-based recruitment of qualified STEM, English, and Mathematics teachers and clearing promotion arrears.",
    "Biometric Staff Audit & Teacher Quality Assurance Inspections: Digital attendance and instructional monitoring across public secondary schools."
  ],
  LGSC: [
    "Unified Local Government Staff Biometric Verification & Training: Eliminating ghost workers across the 17 Local Government Councils and conducting capacity-building workshops for LGA administrative, treasury, and health staff.",
    "Clearing of LGA Staff Promotion Backlogs & Minimum Wage Alignment: Regularizing career progression for local government employees."
  ],
  PMDC: [
    "Revalidation of State Mining Leases & Joint-Venture Lithium/Tin Exploration: Partnering with credible international and domestic mining investors to develop Plateau's lithium, tin, columbite, tantalite, and kaolin deposits transparently.",
    "Mineral Buying Centres & Artisanal Miners Formalization: Establishing state-backed mineral buying hubs to curb smuggling and boost state royalty/IGR."
  ],
  CAST: [
    "CAST Kurgwi Infrastructure & NBTE Accreditation Expansion: Construction of new lecture halls, ICT center, science laboratories, and student hostels at the College of Arts, Science and Technology, Kurgwi (Qua'an Pan LGA), plus full NBTE accreditation of National Diploma programs.",
    "IJMB Centre of Excellence Modernization: Upgrading library and e-learning facilities."
  ],
  CSDA: [
    "NG-CARES Community & Social Development Micro-Projects: Funding and completing over 300+ community-driven micro-projects across all 17 LGAs—including rural health posts, motorized boreholes, culverts, market stalls, and primary school blocks.",
    "Vulnerable Rural Communities Basic Infrastructure Grants: Empowering Community Project Management Committees (CPMCs) to execute local priority projects."
  ],
  PLASIEC: [
    "Conduct of October 9, 2024 Local Government Council Elections: Successful, peaceful conduct of chairmanship and councillorship elections across all 17 LGAs and 325 electoral wards using upgraded logistics and transparent result collation.",
    "PLASIEC Headquarters & LGA Electoral Offices Upgrade: Modernization of ICT result portal and storage facilities."
  ],
  PSUBEB: [
    "UBEC/PSUBEB Smart Model Schools & Classroom Construction: Construction and renovation of over 400+ primary and junior secondary school classroom blocks, solar-powered ICT labs, perimeter fencing, and Early Childhood Care facilities across all 17 LGAs.",
    "Distribution of Thousands of Student Desks, Textbooks & Teacher Tablets: Supplying modern furniture and instructional materials to public basic schools and training teachers under the BESDA/Smart Education initiative."
  ],
  "Operation Rainbow": [
    "Deployment of 600+ Newly Trained Operation Rainbow Community Security Operatives: Recruitment, training, kitting, and deployment of local early-warning and neighbourhood watch operatives across flashpoint communities in all 17 LGAs.",
    "Agro-Rangers & Farmland Protection Patrols: Joint patrols with conventional security agencies protecting farmers during planting and harvest seasons in Bokkos, Mangu, Barkin Ladi, Riyom, and Bassa.",
    "24/7 Toll-Free Early Warning Control Room (0800 0022 3344 / 09064000112) & Drone/GIS Surveillance: Upgrading rapid-response vehicles, motorcycles, communication radios, and situational tracking."
  ],
  PSWB: [
    "Jos–Bukuru Metropolitan Water Supply Rehabilitation: Major overhaul of Yakubu Gowon Dam and Lamingo Water Treatment Plants, replacement of burst high-pressure transmission mains, and restoration of treated tap water to Jos and Bukuru neighborhoods.",
    "World Bank SURWASH & AFD Urban Water Expansion: Upgrading pumping stations, chemical dosing plants, and digital customer metering."
  ],
  PADP: [
    "BARI Resettlement Farming & Dry-Season Irrigation Support: Deployment of extension officers, motorized water pumps, and high-yield inputs to cultivate thousands of hectares across all 17 LGAs.",
    "Rural Feeder Roads, Earth Dams & Agro-Processing Centres (RAAMP/FADAMA): Constructing rural farm access roads, solar boreholes, and grain storage silos for farmer cooperatives."
  ],
  PSPHCB: [
    "Revitalization of 325 Ward Focal Primary Health Care (PHC) Centres: Upgrading at least one model Primary Health Care Centre per electoral ward across all 17 LGAs under the World Bank IMPACT Project and BHCPF—complete with solar power, cold-chain vaccine fridges, motorized boreholes, and staff quarters.",
    "Statewide Maternal, Newborn & Child Health (MNCH) & Routine Immunization Drives: Free malaria, polio, HPV, and maternal health campaigns across rural communities."
  ],
  PLARAMA: [
    "'Operation Zero Potholes' Metropolitan & Township Road Maintenance: Continuous asphalt patching, desilting of side drains, and restoration of failed road sections across Jos North, Jos South, and LGA headquarters using state-owned asphalt plants.",
    "Direct-Labour Rehabilitation of Neighbourhood Link Roads: Rapid intervention on inner-city streets in Tudun Wada, Rantya, Dadin Kowa, Rayfield, Hwolshe, Anglo-Jos, and Bukuru."
  ],
  PIPC: [
    "Revitalization of Plateau State Investment Portfolio & Moribund Assets: Restructuring and PPP turnaround of strategic state-owned enterprises (including BARC Farms, Highland Bottling Company, Jos International Breweries/JIB, and Hill Station Hotel).",
    "Plateau Diaspora Investment Summit & Venture Capital Desk: Mobilizing domestic and diaspora investment into agro-processing, solid minerals, renewable energy, and hospitality."
  ]
};

let enrichedCount = 0;
let totalProjects = 0;
for (const m of mdas) {
  const key = m.abbreviation || m.name;
  if (PROJECTS_MAP[key]) {
    m.currentProjects = PROJECTS_MAP[key];
    enrichedCount++;
    totalProjects += m.currentProjects.length;
  } else {
    console.warn(`WARNING: No projects mapped for ${key} (${m.name})`);
  }
}

fs.writeFileSync(FILE_PATH, JSON.stringify(mdas, null, 2), 'utf8');
console.log(`✓ Successfully enriched ${enrichedCount}/${mdas.length} MDAs with ${totalProjects} current projects in data/plateau-mdas-knowledge-base.json!`);
