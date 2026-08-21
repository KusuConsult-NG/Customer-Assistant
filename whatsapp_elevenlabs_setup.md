# PLASCHEMA WhatsApp Setup via ElevenLabs

> [!IMPORTANT]
> All code is correct and deployed. The only missing step is your action:
> **import your WhatsApp Business Account** into ElevenLabs (takes ~5 minutes).

---

## How It Works (Architecture)

```
Patient calls PLASCHEMA Twilio number
      ↓
Sarah (ElevenLabs) handles voice conversation
      ↓
Enrollment confirmed → registerEnrollee tool fires
      ↓
Call ends → ElevenLabs fires POST /api/webhooks/elevenlabs (post-call webhook)
      ↓
Our API: ingestCall() → sendPostCallLink()
      ↓
POST /v1/convai/whatsapp/outbound-message   ← CORRECT endpoint (verified)
   • Uses Meta-approved template "plaschema_selfie_request"
   • whatsapp_phone_number_id = from ELEVENLABS dashboard
   • Patient receives WhatsApp with selfie upload link

Patient WhatsApps PLASCHEMA number directly
      ↓
ElevenLabs handles inbound natively (no code needed on our side)
      ↓
Post-call: ingestWhatsApp() stores transcript to DB

Outbound WhatsApp CALL (e.g. follow-up):
      ↓
POST /v1/convai/whatsapp/outbound-call
   • Sends permission-request template first (required by Meta)
   • Then places WhatsApp voice call with Sarah
```

---

## What the Docs Actually Say

From [ElevenLabs WhatsApp Docs](https://elevenlabs.io/docs/eleven-agents/whatsapp/getting-started):

> "Go to the WhatsApp page and click the **Import account** button. This opens Meta's authorization flow, where you select (or create) the WhatsApp business account and phone number and grant ElevenLabs permission to manage it."

The import is **dashboard-only** — there is no API to do it programmatically. This is a one-time step.

---

## Verified API Endpoints (Live-tested)

| Endpoint | Status | Purpose |
|---|---|---|
| `GET /v1/convai/whatsapp/accounts` | ✅ exists | List imported WhatsApp accounts |
| `POST /v1/convai/whatsapp/outbound-message` | ✅ exists | Send WhatsApp template message |
| `POST /v1/convai/whatsapp/outbound-call` | ✅ exists | Initiate WhatsApp voice call |

### Outbound Message Payload (Correct)
```json
{
  "agent_id": "agent_3801m0c9terzf58tskm00cp3d008",
  "whatsapp_phone_number_id": "<from ElevenLabs dashboard>",
  "whatsapp_user_id": "2348033445566",
  "template_name": "plaschema_selfie_request",
  "template_language_code": "en",
  "template_params": [
    {
      "type": "body",
      "parameters": [
        { "type": "text", "parameter_name": "name", "text": "John" },
        { "type": "text", "parameter_name": "link", "text": "https://..." }
      ]
    }
  ]
}
```

> [!CAUTION]
> `whatsapp_user_id` must be **digits-only, no leading `+`**.
> `+2348033445566` → `"2348033445566"`
>
> The `{type: "body", ...}` wrapper around parameters is **required** — the API rejects flat arrays.

---

## Step-by-Step: Activate WhatsApp (One-Time)

### Step 1 — Import WhatsApp Business Account (5 min)

1. Go to **[elevenlabs.io/app/agents/whatsapp](https://elevenlabs.io/app/agents/whatsapp)**
2. Click **Import account**
3. Log into Facebook/Meta with the account that owns your WhatsApp Business number
4. Select the WhatsApp Business Account → select the phone number `+234...`
5. Grant ElevenLabs the requested permissions
6. Click **Continue** → you land on the account settings page

### Step 2 — Assign Sarah as the Agent

On the account settings page:
- **Agent**: Select **PLASCHEMA (Sarah)**
- **Enable messaging**: ON (agent responds to WhatsApp text + voice notes)
- **Enable audio message response**: ON (Sarah replies to voice notes with voice notes)
- **Enable typing indicator**: ON (shows typing while Sarah processes)
- Click **Save**

### Step 3 — Copy the Phone Number ID

Still on the account settings page:
- Click the **account menu (⋮)** → **Copy phone number ID**
- This gives you a number like `524029457612345`

Open both `.env` files and uncomment + fill:
```bash
ELEVENLABS_WHATSAPP_PHONE_NUMBER_ID=524029457612345
```

Files to edit:
- `/Users/mac/Customer Assistance/apps/api/.env`
- `/Users/mac/Customer Assistance/.env`

Then restart the API:
```bash
pkill -f "dist/main.js"; sleep 1
node "/Users/mac/Customer Assistance/apps/api/dist/main.js" > /tmp/api.log 2>&1 &
```

### Step 4 — Create the Message Template (20 min + Meta review)

Go to **[WhatsApp Manager](https://business.facebook.com/latest/whatsapp_manager/message_templates)** → **Create template**

| Field | Value |
|---|---|
| Category | **Utility** |
| Template name | `plaschema_selfie_request` |
| Language | English |

**Header**: None (or plain text: `PLASCHEMA Enrollment`)

**Body** (exactly as below — the `{{name}}` and `{{link}}` must be the variable names):
```
Hi {{name}}, your PLASCHEMA registration is confirmed! ✅

To complete your enrollment, please upload your selfie photo here:
{{link}}

This link is valid for 48 hours. Once uploaded, your coverage will be activated within 2 working days.

Questions? Call our Helpline: 0700-700-1111
```

**Footer**: `PLASCHEMA · Plateau State Contributory Healthcare Management Agency`

Submit for review. Meta typically approves Utility templates within a few hours.

### Step 5 — Create the Call Permission Template (for outbound calls)

This template is required when initiating a WhatsApp voice call to someone who hasn't called you before.

| Field | Value |
|---|---|
| Category | **Utility** |
| Template name | `plaschema_call_request` |
| Language | English |

**Body**:
```
Hi {{name}}, PLASCHEMA would like to call you on WhatsApp about your health coverage enrollment. Please accept the call when it comes.
```

---

## Inbound WhatsApp (Zero Code Needed)

Once you assign Sarah in Step 2, **inbound WhatsApp is fully handled by ElevenLabs** automatically:

- Patient sends "Hello" → Sarah replies via WhatsApp text
- Patient sends a voice note → Sarah transcribes it and replies with a voice note
- Patient sends a voice note saying "I want to enroll" → Sarah processes the full enrollment
- Call ends → ElevenLabs fires our post-call webhook → transcript stored in DB ✅

Our `ingestWhatsApp()` function in `elevenlabs-webhook.service.ts` is already correct — it reads the `metadata.whatsapp` field from the ElevenLabs post-call payload and creates/updates the conversation in the PLASCHEMA DB.

---

## Outbound WhatsApp Call (implemented)

To proactively call a patient via WhatsApp (e.g. follow-up):

```typescript
import { initiateWhatsAppCall } from './agent-tools/elevenlabs-webhook.service';

const result = await initiateWhatsAppCall(
  '+2348033445566',  // patient WhatsApp number
  process.env.ELEVENLABS_AGENT_ID!,
  'correlation-id'
);

if (result.success) {
  console.log('Call started, conversation:', result.conversationId);
}
```

This uses `POST /v1/convai/whatsapp/outbound-call` — ElevenLabs first sends the `plaschema_call_request` template to get call permission from the patient, then places the call with Sarah.

---

## Current Status

| Component | Status |
|---|---|
| Post-call webhook registered | ✅ Active |
| `ingestWhatsApp` (transcript storage) | ✅ Correct |
| `sendViaElevenLabsWhatsApp` endpoint | ✅ Fixed → `/v1/convai/whatsapp/outbound-message` |
| `initiateWhatsAppCall` (outbound call) | ✅ Implemented → `/v1/convai/whatsapp/outbound-call` |
| `whatsapp_user_id` format | ✅ Fixed → digits-only, no + |
| Template payload structure | ✅ Fixed → component objects required |
| WhatsApp Business Account imported | ⏳ **Needs your action (Step 1-3 above)** |
| `plaschema_selfie_request` template approved | ⏳ Needs creation + Meta review |
| `ELEVENLABS_WHATSAPP_PHONE_NUMBER_ID` in .env | ⏳ Needs Phone Number ID from dashboard |
