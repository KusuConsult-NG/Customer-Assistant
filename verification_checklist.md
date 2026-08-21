# PLASCHEMA Verification Checklist

> Run these checks to confirm every layer of the PLASCHEMA setup is working correctly.

---

## 1. 🖥️ UI Branding Checks
**Open:** http://localhost:3000

Login with:
- **Email:** `admin@acedemo.com`
- **Password:** `Admin@2030!`

After login, confirm the following in the sidebar:

| What to check | Expected result |
|---|---|
| Browser tab | `PLASCHEMA — Enrollee Helpline & Management System` |
| Sidebar logo icon | Green health cross (not purple sparkle) |
| Sidebar app name | `PLASCHEMA` |
| Sidebar tagline | `Enrollee Helpline Portal` |
| Org badge (sidebar) | `PLASCHEMA` with green `LIVE` badge |
| Sidebar section 1 heading | `HELPLINE` |
| First nav item | `Enrollees & Contacts` (not "CRM & Contacts") |
| Telephony nav item | `Helpline & Telephony` |
| Scheduling nav item | `Appointments` |
| Sidebar section 2 heading | `CHANNELS` |
| Sidebar section 3 heading | `ADMINISTRATION` |
| Top breadcrumb | `PLASCHEMA` in green (not "Care Agent" in indigo) |
| User avatar color | Green gradient (not indigo/purple) |

---

## 2. 📚 Knowledge Base Check
**Open:** http://localhost:3000/knowledge

Confirm you see **5 documents** loaded:

| Expected Document | Status |
|---|---|
| About Plaschema | ✅ Should appear |
| Health Plans | ✅ Should appear |
| Healthcare Facilities | ✅ Should appear |
| Faqs | ✅ Should appear |
| Grievance Complaints | ✅ Should appear |

Also confirm FAQs tab shows **20 PLASCHEMA FAQ entries** covering topics like enrollment, benefits, complaints, drug coverage.

---

## 3. 🗄️ Database Verification (Terminal)

Run this in the project folder to verify the org was updated:

```bash
node -e "
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
p.organization.findFirst({ where: { slug: 'plaschema' } })
  .then(o => {
    console.log('Org name:', o.name);
    console.log('Slug:', o.slug);
    console.log('Welcome msg:', o.welcomeMessage?.slice(0, 80));
  })
  .finally(() => p.\$disconnect());
"
```

**Expected output:**
```
Org name: PLASCHEMA
Slug: plaschema
Welcome msg: Hello! Welcome to the PLASCHEMA Helpline — Plateau State Contributory...
```

---

## 4. 🤖 ElevenLabs Agent Verification (Terminal)

Run this to confirm the agent on ElevenLabs was updated:

```bash
curl -s \
  -H "xi-api-key: sk_859d9ab10df8f59678f2c97c3e9dfdb0f64973a6b8d6b048" \
  "https://api.elevenlabs.io/v1/convai/agents/agent_3801m0c9terzf58tskm00cp3d008" \
  | python3 -c "
import json, sys
d = json.load(sys.stdin)
print('Agent Name  :', d.get('name'))
print('First Message:', d.get('conversation_config',{}).get('agent',{}).get('first_message','')[:80])
print('Voice ID    :', d.get('conversation_config',{}).get('tts',{}).get('voice_id'))
print('Tool count  :', len(d.get('tools', [])))
"
```

**Expected output:**
```
Agent Name  : PLASCHEMA — Sarah
First Message: Hello! Welcome to the PLASCHEMA Helpline — Plateau State Contributory...
Voice ID    : EXAVITQu4vr4xnSDxMaL
Tool count  : 9
```

---

## 5. 🎙️ Voice Agent Test (ElevenLabs Dashboard)

1. Go to **https://elevenlabs.io** → Conversational AI → Agents
2. Find **"PLASCHEMA — Sarah"**
3. Click **"Talk to Agent"**
4. Say: *"Hello, who are you?"*

**Expected response:** Sarah greets as a PLASCHEMA Helpline Officer, NOT as an AI

5. Ask: *"What is the informal sector plan?"*

**Expected:** She explains ₦12,000/person or ₦50,000/family, PLASCHEMA plans, and references proper contacts

6. Ask: *"The hospital is asking me to pay money even though I have my card — what do I do?"*

**Expected:** She explains enrollee rights, says to call 0700-700-1111, and guides how to report the facility

---

## 6. 📞 Telephony Page Check
**Open:** http://localhost:3000/telephony

Confirm:
- Page label is **"Helpline & Telephony"** in the nav
- Twilio config section shows the phone number `+17372212163`
- ElevenLabs agent section shows the agent ID `agent_3801m0c9terzf58tskm00cp3d008`

> **Note:** Twilio number cannot be auto-linked until the Twilio account is upgraded from Trial to a paid plan.

---

## 7. ⚙️ Settings Page Check
**Open:** http://localhost:3000/settings

Confirm:
- Organization name shows **PLASCHEMA**
- Welcome message shows the PLASCHEMA helpline greeting with `{name}` placeholder
- AI Persona/Prompt section contains the PLASCHEMA system prompt

---

## 8. 🧪 API Health Check (Terminal)

```bash
curl -s http://localhost:4000/api/health | python3 -m json.tool
```

**Expected:**
```json
{
  "status": "ok",
  "database": "connected",
  ...
}
```

---

## 9. 🔑 Login API Test (Terminal)

```bash
curl -s -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@acedemo.com","password":"Admin@2030!"}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('Login OK:', 'access_token' in d); print('Org:', d.get('user',{}).get('organizationName','—'))"
```

**Expected:**
```
Login OK: True
Org: PLASCHEMA
```

---

## Summary of All Changes Made

| Layer | Change |
|---|---|
| **UI** | PLASCHEMA logo, green colors, relabeled nav, updated title & breadcrumb |
| **Database** | Org renamed to PLASCHEMA, new persona prompt, new welcome message |
| **FAQs** | 20 PLASCHEMA-specific Q&As seeded |
| **Knowledge Base** | 5 documents: About, Plans, Facilities, FAQs, Grievances |
| **ElevenLabs Agent** | Agent renamed "PLASCHEMA — Sarah", greeting updated, 9 tools synced |
| **Agent Prompt** | Full PLASCHEMA-specific context: plans, benefits, LGAs, complaint handling |
| **Voice** | Sarah voice (warm, professional — ElevenLabs ID: EXAVITQu4vr4xnSDxMaL) |
