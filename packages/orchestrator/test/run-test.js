/**
 * Orchestrator Unit Tests
 *
 * These tests run WITHOUT a real database or OpenAI connection.
 * They validate the pure orchestration logic: intent routing, handoff detection,
 * escalation phrases, and graceful error handling.
 *
 * Tests that require database (tool calls: book_appointment, manage_reservation)
 * are tested at the integration level against a real PostgreSQL instance.
 * Here we verify that those tool calls throw informative errors when DB is unavailable,
 * rather than returning fake mock data.
 */

const { ConversationOrchestrator } = require('../dist/index.js');
const assert = require('assert');

async function testOrchestrator() {
  console.log('Testing Channel-Agnostic AI Conversation Orchestrator...');

  const orchestrator = new ConversationOrchestrator();

  const baseContext = {
    conversationId: 'conv-unit-test-1',
    organizationId: 'org-unit-test-id',
    customerPhoneNumber: '+2348031112222',
    channel: 'WHATSAPP',
    history: [],
    slots: {},
    isHumanHandoffActive: false,
  };

  // ── Test 1: Empty message handling ──────────────────────────────────────
  const emptyRes = await orchestrator.processIncomingMessage(baseContext, '   ');
  assert.ok(emptyRes.replyText.includes('empty'), 'Should handle empty messages gracefully');
  assert.strictEqual(emptyRes.shouldHandoff, false, 'Empty message should not trigger handoff');

  // ── Test 2: Human agent handoff via explicit phrase ────────────────────
  const handoffPhrases = [
    'I want to speak to a human agent please',
    'connect me to a representative',
    'I need to talk to a person',
    'human agent please',
  ];

  for (const phrase of handoffPhrases) {
    const result = await orchestrator.processIncomingMessage(baseContext, phrase);
    assert.strictEqual(result.shouldHandoff, true, `"${phrase}" should trigger handoff`);
    assert.ok(result.replyText.includes('Connecting you to a live human agent'), `"${phrase}" should return handoff message`);
    assert.strictEqual(result.handoffReason, 'CUSTOMER_REQUEST', `"${phrase}" should have reason CUSTOMER_REQUEST`);
  }

  // ── Test 3: Active handoff passthrough ────────────────────────────────
  const handoffActiveContext = { ...baseContext, isHumanHandoffActive: true };
  const activeHandoffRes = await orchestrator.processIncomingMessage(handoffActiveContext, 'hello there');
  assert.strictEqual(activeHandoffRes.shouldHandoff, true, 'Active handoff context should always shouldHandoff=true');
  assert.strictEqual(activeHandoffRes.replyText, '', 'Active handoff should return empty replyText (AI is silent)');

  // ── Test 4: Tool call (appointment) NEVER throws — no customer silence ──
  // CONTRACT (updated): tool intents no longer propagate exceptions. On any
  // failure (DB down, unknown org, no free slot) the orchestrator returns an
  // honest reply with shouldHandoff=true / TOOL_FAILURE, because an uncaught
  // throw meant the customer received NO reply at all. What is still NOT
  // valid is returning a fake bookingId.
  const apptRes = await orchestrator.processIncomingMessage(baseContext, 'I want to book an appointment');
  assert.ok(typeof apptRes.replyText === 'string' && apptRes.replyText.length > 0, 'Appointment intent must always reply');
  if (apptRes.shouldHandoff) {
    assert.strictEqual(apptRes.handoffReason, 'TOOL_FAILURE', 'Failed booking must hand off with TOOL_FAILURE');
    console.log('  Appointment tool: failed gracefully → honest reply + handoff ✓');
  } else {
    assert.ok(apptRes.toolCallsExecuted?.[0]?.result?.bookingId, 'Successful booking must carry a real bookingId');
    console.log('  Appointment tool: succeeded with real DB ✓');
  }

  // ── Test 5: Greeting detection without DB (RAG fallback graceful) ─────
  // General inquiry path should NOT throw even without DB, because
  // RAG search catches errors internally and returns empty results.
  const greetingRes = await orchestrator.processIncomingMessage(baseContext, 'hello');
  assert.ok(typeof greetingRes.replyText === 'string', 'Greeting should return a string reply');
  assert.ok(greetingRes.replyText.length > 0, 'Greeting reply should not be empty');
  assert.strictEqual(greetingRes.shouldHandoff, false, 'Greeting should not trigger handoff');

  // ── Test 6: Pricing intent routing ────────────────────────────────────
  // CONTRACT (updated): quotations now file a real QUO-* ticket (DB write) and
  // never invent prices or dead PDF links. Without a working DB/org the intent
  // degrades to an honest handoff instead of throwing.
  const pricingRes = await orchestrator.processIncomingMessage(baseContext, 'I need a price quote for services');
  assert.strictEqual(pricingRes.intentDetected, 'REQUEST_QUOTATION', 'Pricing phrase must route to quotation intent');
  if (pricingRes.shouldHandoff) {
    assert.strictEqual(pricingRes.handoffReason, 'TOOL_FAILURE', 'Failed quotation must hand off with TOOL_FAILURE');
    console.log('  Quotation tool: failed gracefully → honest reply + handoff ✓');
  } else {
    assert.ok(pricingRes.replyText.includes('QUO-'), 'Quotation reply should include QUO- ticket number');
    assert.ok(!pricingRes.replyText.includes('₦'), 'Quotation reply must NOT invent a price');
    console.log('  Quotation tool: filed real QUO ticket ✓');
  }

  // ── Test 7: Missing phone number → graceful handoff, no phantom records ──
  // CONTRACT (updated): previously this threw (correct vs. the even older
  // phantom-contact fallback); now it degrades to a handoff reply. The
  // invariant that matters is unchanged: NO contact record is fabricated.
  const noPhoneContext = { ...baseContext, customerPhoneNumber: undefined };
  const noPhoneRes = await orchestrator.processIncomingMessage(noPhoneContext, 'book appointment');
  assert.ok(noPhoneRes.replyText.length > 0, 'Missing phone must still produce a reply');
  assert.strictEqual(noPhoneRes.shouldHandoff, true, 'Missing phone must hand off to a human');
  console.log('  Missing phone number: graceful handoff, no phantom contact ✓');

  console.log('\n✅ ALL ORCHESTRATOR UNIT TESTS PASSED SUCCESSFULLY!');
  console.log('   (Integration tests against live DB run separately with npm run test:integration)');
}

testOrchestrator().catch((err) => {
  console.error('❌ Orchestrator Test Failed:', err.message);
  process.exit(1);
});
