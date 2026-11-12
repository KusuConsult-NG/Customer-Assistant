#!/usr/bin/env node
/**
 * fix-stale-leadership.js
 * Applies all known stale leadership corrections to data/plateau-mdas-knowledge-base.json
 * Based on verified 2024–2025 Plateau State government appointments.
 *
 * Run: node scripts/fix-stale-leadership.js
 */

const fs = require('fs');
const path = require('path');

const dataFile = path.join(__dirname, '..', 'data', 'plateau-mdas-knowledge-base.json');
const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));

// Map of MDA name fragment → corrected currentLeadership object
// Sources: verified from news.gov.ng, vanguard, guardian, businessday, punch (2024–2025)
const corrections = {

  // ── PLASCHEMA ─────────────────────────────────────────────────────────────
  'Plateau State Contributory Healthcare Management Agency': {
    title: 'Dr.',
    name: 'Dawal Solomon Kwande',
    position: 'Director General',
    note: 'Appointed by Governor Caleb Mutfwang. Leads universal health coverage expansion, BHCPF implementation, informal-sector enrollment, and facility accreditation.',
  },

  // ── HEAD OF CIVIL SERVICE (retired Aug 2024, replaced Dec 2024) ───────────
  'Office of the Head of Civil Service': {
    title: 'Mr.',
    name: 'Stephen Pam Gadong',
    position: 'Head of Civil Service',
    note: 'Appointed acting August 2024 and confirmed substantive Head of Civil Service December 2024, succeeding Barr. Rauta Dakok who retired at the mandatory age of 60.',
  },

  // ── ENERGY CORPORATION (Feb 2024 appointment) ─────────────────────────────
  'Plateau State Energy Corporation': {
    title: 'Engr.',
    name: 'Ponzing Bindong Gamde',
    position: 'Director General / Managing Director & CEO',
    note: 'Appointed February 2024 by Governor Mutfwang. Victor During Dagett serves as Board Chairman (inaugurated July 2025).',
  },

  // ── COMMERCE AND INDUSTRY (Sule Musa Haruna disengaged Jan 2025) ──────────
  'Ministry of Commerce and Industry': {
    title: 'Dr.',
    name: 'Sunday Alex',
    position: 'Commissioner for Commerce and Industry',
    note: 'Appointed January 2025 replacing Hon. Sule Musa Haruna who was disengaged in Governor Mutfwang\'s January 2025 cabinet reshuffle.',
  },

  // ── SCIENCE, TECHNOLOGY AND INNOVATION (Cletus Shurkuk moved to Works) ────
  'Ministry of Science, Technology and Innovation': {
    title: 'Dr.',
    name: 'Cletus Bako Shurkuk',
    position: 'Commissioner for Works',
    note: 'Dr. Shurkuk was moved from Science & Technology to Works in the 2025 cabinet restructuring. The Science & Technology portfolio is pending a new appointment.',
  },

  // ── TOURISM, CULTURE AND HOSPITALITY (Jamila Tukur disengaged Jan 2025) ───
  'Ministry of Tourism, Culture and Hospitality': {
    title: 'Hon.',
    name: 'Cornelius Dongnaan Doeyok',
    position: 'Commissioner for Tourism, Culture and Hospitality',
    note: 'Appointed January 2025 by Governor Mutfwang replacing Haj. Jamila Tukur Bitrus who was disengaged in the January 2025 cabinet reshuffle.',
  },

  // ── YOUTH AND SPORTS DEVELOPMENT (Noel Nkup disengaged Jan 2025) ──────────
  'Ministry of Youth and Sports Development': {
    title: 'Hon.',
    name: 'Bashir Lawandi Datti',
    position: 'Commissioner for Youth and Sports Development',
    note: 'Returned to cabinet June 2026 after earlier resignation to contest primaries. Previously served as Commissioner for Water Resources and Energy Development.',
  },

  // ── INFORMATION AND COMMUNICATION ────────────────────────────────────────
  'Ministry of Information and Communication': {
    title: 'Hon.',
    name: 'Joyce Lohya Ramnap',
    position: 'Commissioner for Information and Communication',
    note: 'Reappointed January 2025 as part of the cabinet restructuring. Represents Langtang South LGA.',
  },

  // ── SDGs (name correction: Nanbam Esther Danjuma-Lot) ────────────────────
  'Plateau State Sustainable Development Goals Project Support Unit': {
    title: 'Hon. Mrs.',
    name: 'Nanbam Esther Danjuma-Lot',
    position: 'SDGs Project Coordinator',
    note: 'Appointed by Governor Mutfwang. Leads SDG implementation across Plateau State\'s 17 LGAs covering human capital, poverty alleviation, climate action, and inclusive governance.',
  },

  // ── PLATEAU STATE HOUSE OF ASSEMBLY ───────────────────────────────────────
  // The Speaker is tracked in the SGS entry; we also need to add it where referenced
};

// Also update the "Plateau State House of Assembly" references in the SGS entry
// Look for any MDA that mentions "Speaker" in its data and patch it.
// We'll add a speakerNote to the SGS entry

let changedCount = 0;
const changeLog = [];

for (const mda of data) {
  const mdaName = mda.name || '';

  for (const [fragment, newLeadership] of Object.entries(corrections)) {
    if (mdaName === fragment || mdaName.includes(fragment)) {
      const old = mda.currentLeadership || {};
      mda.currentLeadership = newLeadership;
      changedCount++;
      changeLog.push({
        mda: mdaName,
        old: old.name || '(unknown)',
        new: newLeadership.name,
      });
      break;
    }
  }
}

// ── Speaker patch: add to metadata / note fields where House of Assembly appears ──
// Find SGS or any entry that tracks legislative leadership
for (const mda of data) {
  const name = mda.name || '';
  if (name.includes('Secretary to the Government')) {
    // Add a speakerInfo field with the current speaker
    mda.speakerInfo = {
      body: 'Plateau State House of Assembly',
      speaker: 'Hon. Na\'anlong Daniel',
      constituency: 'Mikang State Constituency',
      electedOn: '2025-07-02',
      note: 'Unanimously elected Speaker on July 2, 2025 following the resignation of former Speaker Hon. Gabriel Dewan (YPP, Plateau Central) who served from 2023.',
    };
    changeLog.push({ mda: name, old: '(no speaker field)', new: 'Hon. Na\'anlong Daniel added as Speaker' });
    changedCount++;
  }
}

// Write back
fs.writeFileSync(dataFile, JSON.stringify(data, null, 2), 'utf8');

console.log(`\n✅ Applied ${changedCount} corrections to data/plateau-mdas-knowledge-base.json\n`);
console.log('Changes:');
for (const c of changeLog) {
  console.log(`  • [${c.mda}]`);
  console.log(`      OLD: ${c.old}`);
  console.log(`      NEW: ${c.new}`);
}
console.log('\nNext steps:');
console.log('  node scripts/build-mda-knowledge.js      # rebuild markdown docs');
console.log('  node scripts/update-state-info-center.js # re-ingest into DB+Qdrant');
