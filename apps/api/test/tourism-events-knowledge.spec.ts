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
import { SEARCH_KNOWLEDGE_PASSAGE_CHARS } from '../src/agent-tools/agent-tools.service';
import { agentPromptFor } from '../src/agent-tools/agent-tool-catalog';

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

  it('hands the phone agent EVERY event for a broad question, not the first few', () => {
    // 1,200 characters stopped part-way through the lineup and the caller was
    // given the first events as if they were all of them.
    const passage = relevantPassage([DOC], 'What events are happening in December?', SEARCH_KNOWLEDGE_PASSAGE_CHARS)!;
    for (const event of ['Jos Family Christmas Festival', 'Jos Food Festival', 'Urban Fest', 'New Year Crossover', 'Plateau Cultural Carnival', 'ONE Movie Fest']) {
      expect(passage).toContain(event);
    }
  });

  it.each([
    'What can I do in Jos this Christmas?',
    'What are the activities for the festive season?',
    'What is on for ONE PLATEAU FEST?',
  ])('gives every event when the question names the lineup by another of its names: %s', (question) => {
    // These matched only the "Also known as" line, so the caller got the
    // introduction and four lines instead of the events.
    const passage = relevantPassage([DOC], question, SEARCH_KNOWLEDGE_PASSAGE_CHARS)!;
    for (const event of ['Jos Family Christmas Festival', 'Urban Fest', 'New Year Crossover']) {
      expect(passage).toContain(event);
    }
  });

  it('tells the phone agent to search before ever saying it does not have something', () => {
    // A caller heard the whole lineup one evening and was told it was not
    // there the next morning: whether to search was left to the model.
    const prompt = agentPromptFor({ name: 'Plateau State Government Citizen Contact Centre', slug: 'plateau-state', timezone: 'Africa/Lagos', welcomeMessage: null, aiPersonaPrompt: null } as any);
    expect(prompt).toContain('SEARCH EVERY TIME');
    expect(prompt).toMatch(/Never tell a caller something is not available[^\n]*unless search-knowledge was called for it in this call/);
  });

  it('tells the phone agent to give all of it, paced, rather than shorten it', () => {
    const prompt = agentPromptFor({ name: 'Plateau State Government Citizen Contact Centre', slug: 'plateau-state', timezone: 'Africa/Lagos', welcomeMessage: null, aiPersonaPrompt: null } as any);
    expect(prompt).toContain('COMPLETE ANSWERS');
    expect(prompt).toMatch(/give three at a time, then ask "Shall I continue\?"/);
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
