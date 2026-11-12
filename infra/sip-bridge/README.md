# SIP bridge: Alphatech toll-free → ElevenLabs agent

## Why this exists

Alphatech's PBX will not forward calls for **08000000456** to an outside SIP
address. It only delivers calls to a device **registered** as an extension
(1000). ElevenLabs cannot register to a PBX — it only receives calls sent to
`sip.rtc.elevenlabs.io`. Nothing in the app or in ElevenLabs can close that gap
on its own, and Render cannot carry voice media (no UDP), so the bridge runs on
a small server of its own:

```
caller → toll-free 08000000456 → Alphatech PBX ──(ext 1000, UDP)──▶ THIS BRIDGE
        ──(TCP 5060, +2348000000456)──▶ ElevenLabs agent "Nanpan" ──▶ our API tools
```

It registers as extension 1000, takes every call Alphatech delivers, rewrites
the caller's number to E.164 (`0803…` → `+234803…`, so officers can call back),
and dials the agent. If ElevenLabs cannot be reached the caller hears
"all circuits are busy" instead of dead air. Officer callbacks are unchanged:
they go out through ElevenLabs' own trunk straight to Alphatech.

## Set up (about 20 minutes)

1. **Create a server**: Ubuntu 24.04 (or 22.04), 1 vCPU / 1 GB is enough for
   ~30 concurrent calls; 2 vCPU / 2 GB for 100. Any provider with a **public
   IPv4** — DigitalOcean, Hetzner, AWS (af-south-1 is closest). In the
   provider's own firewall, allow UDP+TCP **5060** and UDP **10000–20000**.

2. **Copy this folder to it and fill in the secrets**:
   ```bash
   scp -r infra/sip-bridge root@SERVER_IP:/opt/
   ssh root@SERVER_IP
   cd /opt/sip-bridge && cp bridge.env.example bridge.env && nano bridge.env
   ```
   - `ALPHATECH_PASSWORD`: extension 1000's password from Alphatech.
   - `ELEVENLABS_SIP_PASSWORD`: the password set on the ElevenLabs phone
     number's **inbound** trunk (username 1000).

3. **Install**: `sudo ./setup.sh` — installs Asterisk, renders the config,
   opens the firewall, starts it, and prints the status.
   **"Registered"** next to `alphatech-reg` means Alphatech now sends calls here.

4. **Allow the bridge in ElevenLabs**: add the server's public IP to the phone
   number's inbound *allowed addresses* (Agents → Phone numbers → the toll-free
   number → Inbound). Without it ElevenLabs refuses the calls.

5. **Call 08000000456.** `sudo ./check.sh` shows registration, live calls and
   the last log lines.

## When it does not work

| `check.sh` shows | Meaning | Fix |
|---|---|---|
| `alphatech-reg … Rejected` | Alphatech refused the password | Check `ALPHATECH_PASSWORD`; ask Alphatech to confirm ext 1000 can register from your server's IP |
| `… Unregistered` / timeouts | Can't reach the PBX | Provider firewall: allow UDP 5060 outbound/inbound |
| Registered, call rings, then busy message | ElevenLabs refused the leg | Server IP missing from ElevenLabs allowed addresses, or wrong `ELEVENLABS_SIP_PASSWORD` |
| Call connects, no audio | RTP blocked or NAT | Open UDP 10000–20000; set `PUBLIC_IP` explicitly in `bridge.env` |

## What was verified, and what was not

Verified with Asterisk 20.6 (the version Ubuntu 24.04 installs): the rendered
config loads, both transports bind, both endpoints load, the identify rule
matches Alphatech by IP, the dialplan compiles, and caller-number rewriting
turns `08031234567` and `2348031234567` into `+2348031234567` while leaving
other numbers alone.

NOT verified: a real call. The sandbox it was tested in cannot reach Alphatech
or ElevenLabs, so registration and media are proven only on the real server —
step 3's "Registered" and step 5's call are those proofs.
