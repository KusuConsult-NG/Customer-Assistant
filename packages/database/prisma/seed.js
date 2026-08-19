/**
 * Customer Care Agent — Comprehensive Database Seed Script
 */

const { PrismaClient } = require('@prisma/client');
const { randomBytes } = require('crypto');
const bcrypt = require('bcryptjs');

const { assertLocalDatabase } = require('../../../scripts/guard-production-db');

assertLocalDatabase('the full database seed');

const prisma = new PrismaClient();

function generateId() {
  return randomBytes(12).toString('hex');
}

async function main() {
  console.log('🌱 Seeding entire Customer Care Agent database with rich enterprise data...\n');

  // ── 1. Create or Find Organization ──────────────────────────────────────────
  let org = await prisma.organization.findFirst({ where: { slug: 'ace-demo' } });

  if (!org) {
    org = await prisma.organization.create({
      data: {
        id: generateId(),
        name: 'Kusu Consult',
        slug: 'ace-demo',
        industry: 'SME',
        country: 'Nigeria',
        timezone: 'Africa/Lagos',
        phone: '+17372212163',
        welcomeMessage: 'Hello! Welcome to Kusu Consult. How can I help you today?',
        aiPersonaPrompt: 'You speak naturally, warmly, conversationally, and professionally like an experienced customer service team member at Kusu Consult. Answer questions about our consulting services, scheduling, and pricing directly and helpfully.',
        updatedAt: new Date(),
      },
    });
    console.log(`✅ Created Organization: ${org.name}`);
  } else {
    org = await prisma.organization.update({
      where: { id: org.id },
      data: {
        name: 'Kusu Consult',
        phone: '+17372212163',
        welcomeMessage: 'Hello! Welcome to Kusu Consult. How can I help you today?',
        aiPersonaPrompt: 'You speak naturally, warmly, conversationally, and professionally like an experienced customer service team member at Kusu Consult. Answer questions about our consulting services, scheduling, and pricing directly and helpfully.',
      },
    });
    console.log(`✅ Using Organization: ${org.name} (${org.id})`);
  }

  // ── 2. Create Admin & Agent Users ───────────────────────────────────────────
  const passwordHash = await bcrypt.hash('Admin@2030!', 12);
  const usersData = [
    { email: 'admin@acedemo.com', fullName: 'Dr. Emeka Okafor', role: 'OWNER' },
    { email: 'sarah.adebayo@acedemo.com', fullName: 'Sarah Adebayo', role: 'ADMIN' },
    { email: 'chidi.ezekiel@acedemo.com', fullName: 'Chidi Ezekiel', role: 'AGENT' },
    { email: 'amaka.nwosu@acedemo.com', fullName: 'Amaka Nwosu', role: 'AGENT' },
  ];

  for (const u of usersData) {
    let user = await prisma.user.findUnique({ where: { email: u.email } });
    if (!user) {
      user = await prisma.user.create({
        data: {
          id: generateId(),
          organizationId: org.id,
          email: u.email,
          passwordHash,
          fullName: u.fullName,
          role: u.role,
          isActive: true,
          updatedAt: new Date(),
        },
      });
      console.log(`  + Created user: ${user.fullName} (${user.role})`);
    } else {
      console.log(`  . User already exists: ${user.fullName}`);
    }
  }

  // ── 3. Create Contacts ──────────────────────────────────────────────────────
  const contactsInput = [
    { fullName: 'Babatunde Fashola', phoneNumber: '+2348031234567', email: 'babatunde@example.ng', tags: ['VIP', 'Enterprise'] },
    { fullName: 'Nneka Okonkwo', phoneNumber: '+2348029876543', email: 'nneka.o@gmail.com', tags: ['Patient', 'Regular'] },
    { fullName: 'Tunde Bakare', phoneNumber: '+2348145550192', email: 'tunde.bakare@outlook.com', tags: ['Lead', 'WhatsApp'] },
    { fullName: 'Fatima Mohammed', phoneNumber: '+2347061112233', email: 'fatima.m@company.co', tags: ['Corporate', 'Deal'] },
    { fullName: 'David Osei', phoneNumber: '+2348094445566', email: 'david.osei@startup.io', tags: ['Tech', 'Partner'] },
    { fullName: 'Grace Danjuma', phoneNumber: '+2348123332211', email: 'grace.d@danjumagroup.com', tags: ['VIP', 'Healthcare'] },
    { fullName: 'Kelechi Iheanacho', phoneNumber: '+2348039998877', email: 'kelechi@sports.ng', tags: ['Sports', 'Individual'] },
    { fullName: 'Amina Yusuf', phoneNumber: '+2348187776655', email: 'amina.yusuf@bank.ng', tags: ['Finance', 'Executive'] },
  ];

  const createdContacts = [];
  for (const c of contactsInput) {
    let contact = await prisma.contact.findFirst({
      where: { organizationId: org.id, phoneNumber: c.phoneNumber },
    });
    if (!contact) {
      contact = await prisma.contact.create({
        data: {
          id: generateId(),
          organizationId: org.id,
          fullName: c.fullName,
          phoneNumber: c.phoneNumber,
          email: c.email,
          tags: c.tags,
          updatedAt: new Date(),
        },
      });
      console.log(`  + Created contact: ${contact.fullName}`);
    } else {
      console.log(`  . Contact already exists: ${contact.fullName}`);
    }
    createdContacts.push(contact);
  }

  // ── 4. Create Leads ──────────────────────────────────────────────────────────
  const leadsData = [
    { contactId: createdContacts[0].id, status: 'NEW', notes: 'Inquired about annual corporate health retainer plan.' },
    { contactId: createdContacts[2].id, status: 'CONTACTED', notes: 'Interested in AI Telephony automation for hospital reception.' },
    { contactId: createdContacts[3].id, status: 'QUALIFIED', notes: 'Budget approved for 50-seat AI voice center.' },
    { contactId: createdContacts[4].id, status: 'CONVERTED', notes: 'Signed growth plan subscription.' },
    { contactId: createdContacts[6].id, status: 'UNQUALIFIED', notes: 'Selected alternative local provider.' },
  ];

  for (const l of leadsData) {
    const existingLead = await prisma.lead.findFirst({
      where: { organizationId: org.id, contactId: l.contactId },
    });
    if (!existingLead) {
      await prisma.lead.create({
        data: {
          id: generateId(),
          organizationId: org.id,
          contactId: l.contactId,
          status: l.status,
          notes: l.notes,
          updatedAt: new Date(),
        },
      });
      console.log(`  + Created lead (${l.status})`);
    } else {
      console.log(`  . Lead already exists (${l.status})`);
    }
  }

  // ── 5. Create Deals ──────────────────────────────────────────────────────────
  const dealsData = [
    { contactId: createdContacts[0].id, title: 'Enterprise Health Automation Contract', amount: 450000, stage: 'PROPOSAL' },
    { contactId: createdContacts[3].id, title: 'Corporate Clinic Voice AI Retainer', amount: 250000, stage: 'NEGOTIATION' },
    { contactId: createdContacts[4].id, title: 'Startup AI Customer Care Package', amount: 150000, stage: 'CLOSED_WON' },
    { contactId: createdContacts[5].id, title: 'Danjuma Group Diagnostic Portal Integration', amount: 850000, stage: 'DISCOVERY' },
    { contactId: createdContacts[7].id, title: 'Bank Branch Virtual Receptionist Deal', amount: 1200000, stage: 'CLOSED_WON' },
  ];

  for (const d of dealsData) {
    const existingDeal = await prisma.deal.findFirst({
      where: { organizationId: org.id, title: d.title },
    });
    if (!existingDeal) {
      await prisma.deal.create({
        data: {
          id: generateId(),
          organizationId: org.id,
          contactId: d.contactId,
          title: d.title,
          amount: d.amount,
          stage: d.stage,
          updatedAt: new Date(),
        },
      });
      console.log(`  + Created deal: ${d.title} (₦${d.amount.toLocaleString()})`);
    } else {
      console.log(`  . Deal already exists: ${d.title}`);
    }
  }

  // ── 6. Create Support Tickets ────────────────────────────────────────────────
  const ticketsData = [
    { contactId: createdContacts[1].id, subject: 'WhatsApp AI response delay inquiry', description: 'Customer reported a 5-second delay when asking about specialist consultation hours.', priority: 'MEDIUM', status: 'RESOLVED' },
    { contactId: createdContacts[2].id, subject: 'Voice call forwarding configuration help', description: 'Needs help pointing MTN line to Twilio SIP trunk.', priority: 'HIGH', status: 'IN_PROGRESS' },
    { contactId: createdContacts[5].id, subject: 'Custom domain SSL certificate setup', description: 'Customer requested assistance setting up app.danjumagroup.com CNAME record.', priority: 'URGENT', status: 'OPEN' },
    { contactId: createdContacts[6].id, subject: 'Refund request for cancelled consultation', description: 'Customer cancelled booking 48 hours in advance and requested a full refund.', priority: 'HIGH', status: 'OPEN' },
  ];

  for (let i = 0; i < ticketsData.length; i++) {
    const t = ticketsData[i];
    const existingTicket = await prisma.ticket.findFirst({
      where: { organizationId: org.id, subject: t.subject },
    });
    if (!existingTicket) {
      await prisma.ticket.create({
        data: {
          id: generateId(),
          organizationId: org.id,
          contactId: t.contactId,
          ticketNumber: `TICK-${generateId().slice(0, 8).toUpperCase()}`,
          subject: t.subject,
          description: t.description,
          priority: t.priority,
          status: t.status,
          updatedAt: new Date(),
        },
      });
      console.log(`  + Created ticket: ${t.subject} (${t.priority})`);
    } else {
      console.log(`  . Ticket already exists: ${t.subject}`);
    }
  }

  // ── 7. Create Conversations & Messages ──────────────────────────────────────
  const conversationsData = [
    {
      contactId: createdContacts[0].id,
      channel: 'WHATSAPP',
      messages: [
        { sender: 'CUSTOMER', content: 'Hello, I want to inquire about corporate health plans for our 50 employees.' },
        { sender: 'AI', content: 'Hello Mr. Babatunde! 👋 Thank you for contacting Apex Care Services. Our Corporate Health Package covers full diagnostic consultations, priority appointments, and 24/7 AI telemedicine support for ₦450,000 annually. Would you like me to send over our detailed brochure?' },
        { sender: 'CUSTOMER', content: 'Yes please, send the brochure and pricing breakdown.' },
        { sender: 'HUMAN_AGENT', content: 'Hi Babatunde, I am Sarah from executive support. I have emailed the full brochure to babatunde@example.ng. Let me know if you have any questions!' },
      ],
    },
    {
      contactId: createdContacts[1].id,
      channel: 'VOICE',
      messages: [
        { sender: 'CUSTOMER', content: 'Good morning, what time are doctor consultations available today?' },
        { sender: 'AI', content: 'Good morning! Our specialist consultations run from 9:00 AM to 5:00 PM today. Would you like me to reserve a slot for you at 2:00 PM?' },
        { sender: 'CUSTOMER', content: 'Yes, 2:00 PM works perfectly for me. Thank you.' },
      ],
    },
    {
      contactId: createdContacts[3].id,
      channel: 'WEBCHAT',
      messages: [
        { sender: 'CUSTOMER', content: 'Can I integrate my existing hospital management system with your AI API?' },
        { sender: 'AI', content: 'Absolutely! Our platform provides a REST API and real-time Webhooks (`call.started`, `appointment.booked`, `lead.captured`). You can view your API key in Settings → White-Label & API.' },
      ],
    },
  ];

  for (const cData of conversationsData) {
    const existingConv = await prisma.conversation.findFirst({
      where: { organizationId: org.id, contactId: cData.contactId, channel: cData.channel },
    });
    let conv = existingConv;
    if (!conv) {
      conv = await prisma.conversation.create({
        data: {
          id: generateId(),
          organizationId: org.id,
          contactId: cData.contactId,
          channel: cData.channel,
          lastMessageAt: new Date(),
          updatedAt: new Date(),
        },
      });
      console.log(`  + Created conversation channel ${cData.channel}`);

      for (const msg of cData.messages) {
        await prisma.message.create({
          data: {
            id: generateId(),
            conversationId: conv.id,
            sender: msg.sender,
            content: msg.content,
            sentAt: new Date(),
          },
        });
      }
    } else {
      console.log(`  . Conversation channel ${cData.channel} already exists`);
    }
  }

  // ── 8. Create Knowledge Base Documents ──────────────────────────────────────
  const knowledgeDocs = [
    { title: 'Apex Care Service Catalog 2026', fileName: 'Service_Catalog_2026.pdf', mimeType: 'application/pdf', fileSize: 245000, storageUrl: 'https://storage.ace-ai.io/docs/Service_Catalog_2026.pdf', status: 'INDEXED', chunkCount: 18 },
    { title: 'Corporate Telemedicine Refund Policy', fileName: 'Refund_Policy.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', fileSize: 112000, storageUrl: 'https://storage.ace-ai.io/docs/Refund_Policy.docx', status: 'INDEXED', chunkCount: 8 },
    { title: 'ApexCare Official Website Sync', fileName: 'website-sync.html', mimeType: 'text/html', fileSize: 480000, storageUrl: 'https://apexcare.ng', status: 'INDEXED', chunkCount: 42 },
  ];

  for (const doc of knowledgeDocs) {
    const existingDoc = await prisma.knowledgeDocument.findFirst({
      where: { organizationId: org.id, title: doc.title },
    });
    if (!existingDoc) {
      await prisma.knowledgeDocument.create({
        data: {
          id: generateId(),
          organizationId: org.id,
          title: doc.title,
          fileName: doc.fileName,
          mimeType: doc.mimeType,
          fileSize: doc.fileSize,
          storageUrl: doc.storageUrl,
          status: doc.status,
          chunkCount: doc.chunkCount,
          updatedAt: new Date(),
        },
      });
      console.log(`  + Created knowledge document: ${doc.title}`);
    } else {
      console.log(`  . Knowledge document already exists: ${doc.title}`);
    }
  }

  // ── 9. Create Bookings & Reservations ────────────────────────────────────────
  const bookingsData = [
    { contactId: createdContacts[0].id, serviceName: 'Executive Health Screening', staffName: 'Dr. Emeka Okafor', startTime: new Date(Date.now() + 86400000), endTime: new Date(Date.now() + 90000000), status: 'CONFIRMED' },
    { contactId: createdContacts[1].id, serviceName: 'General Specialist Consultation', staffName: 'Sarah Adebayo', startTime: new Date(Date.now() + 172800000), endTime: new Date(Date.now() + 176400000), status: 'CONFIRMED' },
    { contactId: createdContacts[3].id, serviceName: 'Corporate Partnership Meeting', staffName: 'Dr. Emeka Okafor', startTime: new Date(Date.now() - 86400000), endTime: new Date(Date.now() - 82800000), status: 'COMPLETED' },
  ];

  for (const b of bookingsData) {
    const existingBooking = await prisma.booking.findFirst({
      where: { organizationId: org.id, contactId: b.contactId, serviceName: b.serviceName },
    });
    if (!existingBooking) {
      await prisma.booking.create({
        data: {
          id: generateId(),
          organizationId: org.id,
          contactId: b.contactId,
          serviceName: b.serviceName,
          staffName: b.staffName,
          startTime: b.startTime,
          endTime: b.endTime,
          status: b.status,
          updatedAt: new Date(),
        },
      });
      console.log(`  + Created booking: ${b.serviceName}`);
    } else {
      console.log(`  . Booking already exists: ${b.serviceName}`);
    }
  }

  const reservationsData = [
    { contactId: createdContacts[5].id, partySize: 4, tableOrRoomNumber: 'Executive Suite 201', specialRequests: 'Requires wheelchair access and VIP lunch menu.', reservationTime: new Date(Date.now() + 259200000), status: 'CONFIRMED' },
    { contactId: createdContacts[7].id, partySize: 6, tableOrRoomNumber: 'Conference Room B', specialRequests: 'AV projector and video conferencing setup.', reservationTime: new Date(Date.now() + 345600000), status: 'CONFIRMED' },
  ];

  for (const r of reservationsData) {
    const existingRes = await prisma.reservation.findFirst({
      where: { organizationId: org.id, contactId: r.contactId, tableOrRoomNumber: r.tableOrRoomNumber },
    });
    if (!existingRes) {
      await prisma.reservation.create({
        data: {
          id: generateId(),
          organizationId: org.id,
          contactId: r.contactId,
          partySize: r.partySize,
          tableOrRoomNumber: r.tableOrRoomNumber,
          specialRequests: r.specialRequests,
          reservationTime: r.reservationTime,
          status: r.status,
          updatedAt: new Date(),
        },
      });
      console.log(`  + Created reservation: ${r.tableOrRoomNumber}`);
    } else {
      console.log(`  . Reservation already exists: ${r.tableOrRoomNumber}`);
    }
  }

  // ── 10. Create Call Logs ────────────────────────────────────────────────────
  const callLogsData = [
    { fromNumber: '+2348031234567', toNumber: '+17372212163', direction: 'INBOUND', durationSeconds: 145, status: 'COMPLETED' },
    { fromNumber: '+17372212163', toNumber: '+2348029876543', direction: 'OUTBOUND', durationSeconds: 98, status: 'COMPLETED' },
    { fromNumber: '+2348145550192', toNumber: '+17372212163', direction: 'INBOUND', durationSeconds: 210, status: 'COMPLETED' },
  ];

  for (const call of callLogsData) {
    const existingCall = await prisma.callLog.findFirst({
      where: { organizationId: org.id, fromNumber: call.fromNumber, durationSeconds: call.durationSeconds },
    });
    if (!existingCall) {
      await prisma.callLog.create({
        data: {
          id: generateId(),
          organizationId: org.id,
          callSid: 'CA' + generateId(),
          fromNumber: call.fromNumber,
          toNumber: call.toNumber,
          direction: call.direction,
          durationSeconds: call.durationSeconds,
          status: call.status,
          startedAt: new Date(),
        },
      });
      console.log(`  + Created call log: ${call.direction} ${call.fromNumber} (${call.durationSeconds}s)`);
    } else {
      console.log(`  . Call log already exists: ${call.fromNumber}`);
    }
  }

  // ── 11. Create Telephony Config (Twilio) ────────────────────────────────────
  const existingTelephony = await prisma.telephonyConfig.findFirst({
    where: { organizationId: org.id, phoneNumber: '+17372212163' },
  });
  if (!existingTelephony) {
    await prisma.telephonyConfig.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        provider: 'TWILIO',
        phoneNumber: '+17372212163',
        accountSid: process.env.TWILIO_ACCOUNT_SID || '',
        authToken:  process.env.TWILIO_AUTH_TOKEN  || '',
        apiKey:     process.env.TWILIO_API_KEY      || null,
        isDefault:  true,
        updatedAt:  new Date(),
      },
    });
    console.log('  + Created TelephonyConfig: +17372212163 (Twilio)');
  } else {
    console.log('  . TelephonyConfig already exists: +17372212163');
  }

  console.log('\n════════════════════════════════════════════════════════════');
  console.log('🚀 DB SEEDING COMPLETE! All modules populated with rich data.');
  console.log('   Admin Login Email:    admin@acedemo.com');
  console.log('   Admin Login Password: Admin@2030!');
  console.log('   Organization:         ' + org.name + ' (' + org.id + ')');
  console.log('════════════════════════════════════════════════════════════\n');
}

main()
  .catch((err) => {
    console.error('❌ Seeding failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
