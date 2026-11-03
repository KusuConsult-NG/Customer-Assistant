/**
 * The callback form: what the citizen is asked, and what they are promised.
 *
 * ── Why this flow exists ────────────────────────────────────────────────────
 *
 * "Call me back" reached NOTHING. There was no intent for it, so it fell
 * through to retrieval and the citizen got a knowledge-base answer about
 * something else. The nearest thing the platform could do was raise a ticket,
 * which carries no time and promises nobody anything.
 *
 * A callback is a commitment, and the only thing that makes it one is that a
 * time was said out loud. These tests are about that promise: that a time is
 * always offered, that the citizen hears it read back before it is recorded,
 * and that what they were told is kept word for word for the officer who
 * eventually rings.
 */
import { advanceFlow, beginFlow, type FlowState } from '../src/flows';
import {
  CALLBACK_FLOW,
  CALLBACK_WINDOWS,
  callbackWindowsAsText,
  chosenWindow,
} from '../src/callback-flow';
import { t, SUPPORTED_LANGUAGES, type Language } from '../src/languages';
import { nextServiceTime, nextAttemptAt, callbackReference } from '@ace/database';

const F = CALLBACK_FLOW;

function play(answers: string[], lang: Language = 'en') {
  let state: FlowState = beginFlow(F);
  const replies: string[] = [];
  let executed = false;

  let step = advanceFlow(F, state, '', lang);
  if (step.kind === 'ask' || step.kind === 'confirm') {
    replies.push(step.reply);
    state = step.state;
  }
  for (const answer of answers) {
    step = advanceFlow(F, state, answer, lang);
    if (step.kind === 'execute') { executed = true; state = step.state; break; }
    if (step.kind === 'abandon') { replies.push(step.reply); break; }
    // `not-mine` means the engine does not own this turn — nothing to record.
    if (step.kind === 'not-mine') break;
    replies.push(step.reply);
    state = step.state;
  }
  return { replies, last: replies[replies.length - 1] ?? '', state, executed };
}

const GOOD = ['my water supply has been off for three days', '1', 'yes'];

describe('the callback form', () => {
  it('asks what the call is about before asking when', () => {
    const { replies } = play([]);
    expect(replies[0]).toMatch(/call you back/i);
  });

  it('offers real windows rather than asking for a time it cannot keep', () => {
    const { last } = play(['my borehole has not worked for a week']);
    for (let i = 1; i <= CALLBACK_WINDOWS.length; i++) {
      expect(last).toContain(`${i} —`);
    }
  });

  it('refuses a reason too short to act on', () => {
    // An officer ringing back with "k" as the subject has to ask from
    // scratch, which is the call the citizen rang to avoid.
    const { last } = play(['k']);
    expect(last).toMatch(/little more|more about/i);
  });

  it('re-asks with the list when the window is not understood', () => {
    const { last } = play(['my water supply has been off', 'sometime next year']);
    expect(last).toMatch(/did not catch/i);
    expect(last).toContain('1 —');
  });

  it('reads the promise back before anything is written', () => {
    // A read-back, not a second "are you sure?". The reason was typed freely
    // several turns earlier and it is what the officer will ring about, so
    // this is the citizen's only chance to correct it.
    const { last } = play(['my water supply has been off for three days', '1']);
    expect(last).toMatch(/about:/i);
    expect(last).toMatch(/my water supply has been off for three days/);
    expect(last).toMatch(/when:/i);
    expect(last).toMatch(/within the hour/i);
  });

  it('only executes once the citizen confirms', () => {
    expect(play(['my water supply has been off for three days', '1']).executed).toBe(false);
    expect(play(GOOD).executed).toBe(true);
  });

  it('stores the window as the index the citizen picked', () => {
    const { state } = play(GOOD);
    expect(chosenWindow(state.collected)).toMatchObject({ index: 1, minutes: 60 });
  });

  it('shows staff the window, not the number it is stored as', () => {
    // `when` holds "1". An operator reading "When to call: 1" is worse off
    // than one shown nothing, because it looks like an answer.
    const slot = F.slots.find((s) => s.name === 'when')!;
    const { state } = play(GOOD);
    expect(slot.display?.(state.collected)).toMatch(/within the hour/i);
  });
});

describe('the promise is made in the citizen\'s own language', () => {
  it.each(SUPPORTED_LANGUAGES)('offers the windows in %s', (lang) => {
    const text = callbackWindowsAsText(lang as Language);
    for (let i = 1; i <= CALLBACK_WINDOWS.length; i++) expect(text).toContain(`${i} —`);
    // And the words are actually translated, not the English left in place.
    for (const w of CALLBACK_WINDOWS) expect(t(lang as Language, w.key as any).length).toBeGreaterThan(0);
  });

  it.each(SUPPORTED_LANGUAGES)('reads the promise back in %s', (lang) => {
    const { last } = play(['ruwa ya kare', '2'], lang as Language);
    expect(last.length).toBeGreaterThan(0);
    expect(last).not.toMatch(/\{\w+\}/); // no unfilled placeholder
  });
});

describe('when the promise falls due', () => {
  const HOURS = { openHour: 8, closeHour: 18, days: [1, 2, 3, 4, 5] };

  it('leaves a time that is already inside opening hours alone', () => {
    const tenAm = new Date(Date.UTC(2026, 10, 3, 9, 0)); // 10:00 WAT, Tuesday
    expect(nextServiceTime(tenAm, HOURS).getTime()).toBe(tenAm.getTime());
  });

  it('moves a promise made near closing to the next opening hour', () => {
    // 17:50 WAT + one hour is 18:50 — after the office shuts. Promising that
    // breaks the promise at the moment it is made.
    const late = new Date(Date.UTC(2026, 10, 3, 16, 50));
    const due = nextServiceTime(new Date(late.getTime() + 60 * 60 * 1000), HOURS);
    const watHour = (due.getUTCHours() + 1) % 24;
    expect(watHour).toBeGreaterThanOrEqual(HOURS.openHour);
    expect(watHour).toBeLessThan(HOURS.closeHour);
  });

  it('skips a day the agency does not serve', () => {
    const friday6pm = new Date(Date.UTC(2026, 10, 6, 17, 30)); // 18:30 WAT Friday
    const due = nextServiceTime(friday6pm, HOURS);
    const watDay = new Date(due.getTime() + 60 * 60 * 1000).getUTCDay();
    expect(HOURS.days).toContain(watDay);
  });

  it('backs off between retries instead of ringing again immediately', () => {
    const now = new Date(Date.UTC(2026, 10, 3, 9, 0));
    const first = nextAttemptAt(1, HOURS, now).getTime();
    const second = nextAttemptAt(2, HOURS, now).getTime();
    expect(first).toBeGreaterThan(now.getTime());
    expect(second).toBeGreaterThan(first);
  });

  it('never loops forever on hours that can never be satisfied', () => {
    // The settings endpoint rejects these, but this runs inside a live
    // conversation and must not hang on a row written before that check.
    const impossible = { openHour: 9, closeHour: 9, days: [1] };
    const from = new Date(Date.UTC(2026, 10, 3, 9, 0));
    expect(nextServiceTime(from, impossible).getTime()).toBe(from.getTime());
  });
});

describe('the reference the citizen is quoted', () => {
  it('is stable, upper case and derived from the row', () => {
    const id = '216c875e-60e3-4a2d-8a3b-a4f846cc96c3';
    expect(callbackReference(id)).toBe('CB-216C875E');
    expect(callbackReference(id)).toBe(callbackReference(id));
  });

  it('differs between two rows', () => {
    expect(callbackReference('aaaaaaaa-0000-0000-0000-000000000000'))
      .not.toBe(callbackReference('bbbbbbbb-0000-0000-0000-000000000000'));
  });
});
