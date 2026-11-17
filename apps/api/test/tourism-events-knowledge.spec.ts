/**
 * The December Tourism Month 2026 lineup answers the questions callers ask.
 *
 * The document is search-knowledge's source for these events, and the agent
 * only speaks the passage relevantPassage() picks from it. Each event is one
 * self-contained line (date, event, venue, organiser) so the line that answers
 * the question carries everything needed — these pin that it does.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { relevantPassage } from '../src/agent-tools/relevant-passage';

const DOC = readFileSync(
  join(__dirname, '..', '..', '..', 'data', 'mda-knowledge', 'December-Tourism-Month-2026-Events.md'),
  'utf8'
);

describe('December Tourism Month 2026 events', () => {
  it.each([
    ['When is the New Year crossover and fireworks?', /31 December 2026 to 1 January 2027[\s\S]*Secretariat Flyover Bridge/],
    ['Where is the Jos Food Festival?', /Jos Food Festival[\s\S]*Christmas Market, Jos/],
    ['When does the Jos Family Christmas Festival hold?', /18 to 28 December 2026 — Jos Family Christmas Festival[\s\S]*Jonah Jang Way/],
    ['Tell me about Urban Fest', /22 to 27 December 2026 — Urban Fest[\s\S]*Azi Nyako Youth Centre/],
    ['When is the Plateau Cultural Carnival?', /10 to 12 December 2026 — Plateau Cultural Carnival/],
    ['When is PLAFEST?', /March 2027 — PLAFEST/],
  ])('%s', (question, answer) => {
    const passage = relevantPassage([DOC], question);
    expect(passage).toMatch(answer);
  });

  it('lists all thirteen events and PLAFEST', () => {
    const events = DOC.match(/^- \*\*[^*]+ — [^*]+\*\*/gm) ?? [];
    expect(events).toHaveLength(14);
  });

  it('says plainly where a date or venue is not fixed yet', () => {
    expect(DOC).toMatch(/Unity Carols and Praise Festival[^\n]*dates to be announced|dates to be announced — Unity Carols/);
    expect(DOC).toMatch(/do not guess one/);
  });
});
