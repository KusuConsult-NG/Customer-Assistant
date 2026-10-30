import {
  EMPTY_CATALOGUE,
  canRegister,
  loadServiceCatalogue,
  locationsInLga,
  locationsInLgaAsText,
  lgasServed,
  readCatalogue,
  resolveLocation,
  resolveServiceOption,
  seedCatalogue,
  serviceOptionsAsText,
  type ServiceCatalogue,
} from '../src/service-catalogue';

/**
 * What an agency offers, and where.
 *
 * These were four health plans and a hospital directory in platform code, so
 * every agency on the platform offered a health scheme's products. The
 * assertions that matter are the refusals: resolving the WRONG service or the
 * WRONG location is not a near miss, it is somebody registered for something
 * they did not ask for or sent to an office that cannot help them.
 */

const CAT: ServiceCatalogue = {
  options: [
    { id: 'o1', name: 'Formal Sector', description: 'Employed workers.',
      matchPhrases: ['formal', 'civil servant'], isNoCost: false, requiresReview: false },
    { id: 'o2', name: 'Informal Sector', description: 'Traders and artisans.',
      matchPhrases: ['informal', 'trader'], isNoCost: false, requiresReview: false },
    { id: 'o3', name: 'Equity Program', description: 'No cost.',
      matchPhrases: ['equity', 'pregnan'], isNoCost: true, requiresReview: true },
  ],
  locations: [
    { id: 'l1', name: 'Plateau Specialist Hospital', kind: 'Specialist Hospital', address: 'Jos', lga: 'Jos North' },
    { id: 'l2', name: 'Gwong Primary Health Centre', kind: 'Primary Health Centre', address: 'Jos', lga: 'Jos North' },
    { id: 'l3', name: 'Du General Hospital', kind: 'General Hospital', address: 'Du', lga: 'Jos South' },
    // One referral hospital serving several LGAs — the case a unique key on
    // name alone collapsed into a single row.
    { id: 'l4', name: 'Shendam General Hospital', kind: 'General Hospital', address: 'Shendam', lga: 'Shendam' },
    { id: 'l5', name: 'Shendam General Hospital', kind: 'General Hospital', address: 'Shendam', lga: 'Kanam' },
  ],
};

describe('choosing a service', () => {
  it('matches the agency’s own phrases', () => {
    expect(resolveServiceOption(CAT, 'i am a trader in the market')?.name).toBe('Informal Sector');
    expect(resolveServiceOption(CAT, 'I am a civil servant')?.name).toBe('Formal Sector');
  });

  it('matches by name and by position in the list', () => {
    expect(resolveServiceOption(CAT, 'Equity Program')?.name).toBe('Equity Program');
    expect(resolveServiceOption(CAT, '2')?.name).toBe('Informal Sector');
  });

  it('refuses rather than guessing when nothing matches', () => {
    expect(resolveServiceOption(CAT, 'a mortgage')).toBeNull();
    expect(resolveServiceOption(CAT, '')).toBeNull();
    expect(resolveServiceOption(CAT, '9')).toBeNull();
  });

  it('refuses when SEVERAL match, rather than taking the first', () => {
    // "formal" is a substring of "informal": a citizen saying both words has
    // not chosen, and picking one registers them for something at random.
    const ambiguous: ServiceCatalogue = {
      options: [
        { id: 'a', name: 'Alpha', description: null, matchPhrases: ['card'], isNoCost: false, requiresReview: false },
        { id: 'b', name: 'Beta', description: null, matchPhrases: ['card'], isNoCost: false, requiresReview: false },
      ],
      locations: [],
    };
    expect(resolveServiceOption(ambiguous, 'i need a card')).toBeNull();
  });

  it('carries whether it costs the citizen anything, from the row not the name', () => {
    expect(resolveServiceOption(CAT, 'equity')?.isNoCost).toBe(true);
    expect(resolveServiceOption(CAT, 'trader')?.isNoCost).toBe(false);
  });

  it('numbers the options the way the prompt reads them out', () => {
    const text = serviceOptionsAsText(CAT);
    expect(text).toContain('1. Formal Sector');
    expect(text).toContain('3. Equity Program');
  });
});

describe('choosing a location', () => {
  it('only offers locations in the citizen’s own LGA', () => {
    const north = locationsInLga(CAT, 'Jos North').map((l) => l.name);
    expect(north).toEqual(['Plateau Specialist Hospital', 'Gwong Primary Health Centre']);
    expect(north).not.toContain('Du General Hospital');
  });

  it('keeps a hospital that serves several LGAs in every one of them', () => {
    expect(locationsInLga(CAT, 'Shendam').map((l) => l.name)).toContain('Shendam General Hospital');
    expect(locationsInLga(CAT, 'Kanam').map((l) => l.name)).toContain('Shendam General Hospital');
  });

  it('refuses a location that is real but not in this LGA', () => {
    // Du General Hospital exists — just not for somebody in Jos North.
    expect(resolveLocation(CAT, 'Jos North', 'Du General Hospital')).toBeNull();
  });

  it('refuses a location that does not exist at all', () => {
    expect(resolveLocation(CAT, 'Jos North', 'St Elsewhere')).toBeNull();
  });

  it('matches a partial name the way somebody would say it', () => {
    expect(resolveLocation(CAT, 'Jos North', 'gwong')?.name).toBe('Gwong Primary Health Centre');
  });

  it('reports an LGA the agency does not cover as empty, not as an error', () => {
    // A real LGA where this agency has no office. The citizen still lives
    // there and can still register; a human assigns somewhere.
    expect(locationsInLga(CAT, 'Wase')).toEqual([]);
    expect(locationsInLgaAsText(CAT, 'Wase')).toBe('');
  });

  it('ignores an LGA that is not in the State at all', () => {
    expect(locationsInLga(CAT, 'Lagos Island')).toEqual([]);
  });

  it('lists only the LGAs it can actually send somebody to', () => {
    expect(lgasServed(CAT)).toEqual(['Jos North', 'Jos South', 'Kanam', 'Shendam']);
  });
});

describe('travelling in the flow state', () => {
  it('survives a round trip through the JSON column', () => {
    expect(readCatalogue(seedCatalogue({}, CAT))).toEqual(CAT);
  });

  it('reads as empty rather than throwing on junk', () => {
    expect(readCatalogue({ _catalogue: 'not json' })).toEqual(EMPTY_CATALOGUE);
    expect(readCatalogue({ _catalogue: '{"options":"nope"}' })).toEqual(EMPTY_CATALOGUE);
    expect(readCatalogue({})).toEqual(EMPTY_CATALOGUE);
  });

  it('keeps the blob under an underscored key, so it cannot collide with a slot', () => {
    const seeded = seedCatalogue({ fullName: 'Amina' }, CAT);
    expect(Object.keys(seeded).filter((k) => !k.startsWith('_'))).toEqual(['fullName']);
  });

  it('says an agency with no services cannot run a registration', () => {
    expect(canRegister(EMPTY_CATALOGUE)).toBe(false);
    expect(canRegister({ options: [], locations: CAT.locations })).toBe(false);
    expect(canRegister(CAT)).toBe(true);
  });
});

describe('loading a catalogue', () => {
  const reader = (options: any[], locations: any[]) => ({
    serviceOption: { findMany: async () => options },
    serviceLocation: { findMany: async () => locations },
  }) as any;

  it('returns what the agency configured', async () => {
    const got = await loadServiceCatalogue(reader(CAT.options, CAT.locations), 'org-1');
    expect(got.options).toHaveLength(3);
    expect(got.locations).toHaveLength(5);
  });

  it('never throws into a live conversation when the query fails', async () => {
    const exploding = {
      serviceOption: { findMany: async () => { throw new Error('connection lost'); } },
      serviceLocation: { findMany: async () => [] },
    } as any;
    expect(await loadServiceCatalogue(exploding, 'org-1')).toEqual(EMPTY_CATALOGUE);
  });
});
