# Testing WhatsApp locally

Two different things get called "testing WhatsApp", and only one of them needs
Meta:

| | Needs Meta? | Needs a public URL? | Loop time |
|---|---|---|---|
| **Inbound probe** — impersonates Meta against your webhook | no | no | seconds |
| **A real message from a real phone** | yes | yes | minutes |

Start with the probe. It exercises the same controller, the same signature
check, the same orchestrator and the same database writes that a real message
does. Everything below the network boundary is identical.

## 1. The probe (no Meta account required)

With the stack running (`npm run dev`):

```bash
node e2e-validation/whatsapp-inbound-probe.js
```

It signs its payloads with your `WHATSAPP_APP_SECRET`, so it proves the real
HMAC path rather than bypassing it. Nine checks: webhook verification, a wrong
verify token, unsigned and mis-signed payloads, contact and conversation
creation, redelivery de-duplication, tenant isolation for an unmapped phone
number id, delivery receipts, media and interactive messages, and that the
assistant actually replies.

If this passes, your webhook works. A real message failing after this is a
configuration or connectivity problem, not a code problem — which is the point
of running it first.

## 2. A real message

### 2.1 Environment

Six variables. The two marked **required** are enforced at boot; the API will
not start without them.

| Variable | Where it comes from |
|---|---|
| `WHATSAPP_APP_SECRET` **(required)** | App Dashboard → App settings → Basic → App secret |
| `WHATSAPP_VERIFY_TOKEN` **(required)** | You invent it. Must match what you type into the webhook config |
| `WHATSAPP_ACCESS_TOKEN` | WhatsApp → API Setup → temporary token (24h), or a System User token |
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp → API Setup |
| `WHATSAPP_BUSINESS_ID` | WhatsApp → API Setup (WhatsApp Business Account ID) |
| `WHATSAPP_DISPLAY_NUMBER` | The number itself, E.164, e.g. `+15556719884` |

`WHATSAPP_APP_SECRET` is the one that quietly ruins an afternoon. Every inbound
webhook is verified as HMAC-SHA256 of the raw body against
`X-Hub-Signature-256`, and a mismatch is a **403 before any processing**. That
is deliberate — an unverified webhook is an anonymous stranger posting into your
CRM — but from the outside it looks exactly like "WhatsApp isn't working". The
App Secret is not the access token and not the verify token.

The access token from **API Setup** expires in **24 hours**. When replies stop
working a day later, this is why. Create a System User token for anything
longer-lived.

### 2.2 Meta cannot reach your laptop

This is the step people skip. `localhost:4000` does not exist on the internet.
Meta delivers webhooks by making an HTTPS request to a public URL, so you need a
tunnel:

```bash
# either
ngrok http 4000
# or
cloudflared tunnel --url http://localhost:4000
```

Both print a public HTTPS URL. Take that URL and set:

```
API_BASE_URL=https://<your-tunnel>.ngrok-free.app
```

then restart the API so emitted links and callbacks use it.

The URL changes every time you restart the tunnel (on free plans), and Meta must
be updated to match each time.

### 2.3 Webhook configuration

App Dashboard → WhatsApp → Configuration → Edit:

- **Callback URL**: `https://<your-tunnel>/api/whatsapp/webhook`
- **Verify token**: exactly your `WHATSAPP_VERIFY_TOKEN`
- Subscribe to the **`messages`** field. Without this subscription Meta accepts
  your webhook and then never sends anything to it.

Clicking *Verify and save* makes Meta issue a `GET` with `hub.mode`,
`hub.verify_token` and `hub.challenge`. The API echoes the challenge on a match
and returns 403 otherwise — so a failure here is a token mismatch and nothing
else.

### 2.4 Tell the platform which tenant owns the number

Inbound messages route by `phone_number_id`. A number that maps to no
organization is **dropped, not guessed at** — that is what stops one tenant's
messages reaching another (probe check WA-006). Either seed the demo tenant with
the credentials in `.env`:

```bash
npm run db:seed:gatekipa
```

or set them per-organization from **Settings → WhatsApp** in the dashboard.

### 2.5 Test numbers only message registered recipients

A Meta test number can only send to phone numbers you have added under **API
Setup → To**. Messaging anything else fails, correctly, and the reply never
arrives. Add your own phone there first.

Also note the 24-hour customer service window: outside it, only approved
template messages can be sent. During a live test you are inside the window, so
free-form replies work — but a reply attempted the next morning will not.

## 3. Reading a failure

| Symptom | Cause |
|---|---|
| Meta rejects *Verify and save* | `WHATSAPP_VERIFY_TOKEN` differs from the console |
| Webhook returns 403 on delivery | `WHATSAPP_APP_SECRET` is wrong — this is a signature mismatch, not a bug |
| Webhook returns 500 | The secret is missing entirely; Meta retries, which is intended |
| Message arrives, no reply | Recipient not registered on the test number, or the token expired |
| Nothing arrives at all | Tunnel down, URL changed, or `messages` not subscribed |
| Message arrives, no tenant | No organization maps to that `phone_number_id` |

Watch the API logs while you send — the webhook logs the verification outcome
before anything else, which separates "never arrived" from "arrived and was
rejected" immediately.
