# GV AI Co-pilot

Production-ready starter that bolts AI assistance onto an existing Google Voice workflow in a weekend. The flow mirrors the spec:

1. Customer dials your Google Voice number.
2. Google Voice instantly forwards to a Twilio SIP domain.
3. Twilio bridges the call to the receptionist **and** streams μ-law audio to Cloud Run.
4. Cloud Run transcribes with Picovoice Cheetah, summarizes with Gemini 1.5 Flash, and writes updates into Firebase Realtime Database.
5. The receptionist dashboard (Firebase Hosting) shows the live transcript and AI guidance. No buttons to press—the phone call behaves exactly the same.

Total cloud spend stays on free tiers except for Twilio voice minutes: **≈ $0.025 per minute + $1.15/month** for the SIP number.

---

## Repository map

```
gv-ai-copilot/
├─ twilio/                 # TwiML bin + SIP setup notes
├─ backend/                # FastAPI service for Cloud Run
├─ receptionist/           # Firebase-hosted dashboard
├─ scripts/                # Deploy + Twilio CLI helpers
└─ README.md               # You are here
```

---

## 1. Twilio + Google Voice setup (≈ 5 minutes)

1. **Buy a local Twilio number** (Voice → Phone numbers). Keep it private; it is only the SIP ingress.
2. **Create a SIP domain** `your-company.sip.twilio.com` (Voice → Manage → SIP domains).
   - Credential list: username `gv`, password `16-random-chars`.
   - Voice configuration: point to a TwiML Bin that contains [`twilio/forward.xml`](twilio/forward.xml) with your phone numbers filled in.
3. **Link Google Voice** → Settings → Linked numbers → *Add SIP device*.
   - SIP URI: `gv:password@your-company.sip.twilio.com`.
   - Google Voice will now forward every call to Twilio and therefore to the co-pilot stack.

`forward.xml` is only seven lines:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Start>
    <Stream url="wss://your-cloud-run-url.run.app/audiostream" />
  </Start>
  <Dial callerId="+1YOUR-GV-NUMBER">
    <Number>+1RECEPTIONIST-PHONE</Number>
  </Dial>
</Response>
```

Twilio forks the live audio to the backend **and** keeps the PSTN leg to the receptionist connected.

---

## 2. Cloud Run backend (Python 3.11)

- [`backend/main.py`](backend/main.py) exposes:
  - `GET /healthz` for liveness checks.
  - `WS /audiostream` that accepts Twilio Stream frames, converts μ-law → 16 kHz PCM, feeds Picovoice Cheetah, and forwards transcript + Gemini cards to Firebase.
- Environment variables (copy [`backend/.env.example`](backend/.env.example)):

  | Key | Purpose |
  | --- | --- |
  | `CHEETAH_ACCESS_KEY` | Picovoice Cheetah access key (100 h/mo free). |
  | `GEMINI_API_KEY` | Gemini 1.5 Flash key (Google AI Studio free tier). |
  | `FIREBASE_RTDB_URL` | `https://<project>.firebaseio.com` root. |
  | `FIREBASE_DB_SECRET` | Optional database secret/custom token for REST writes. |
  | `FREE_TIER_GUARD` | Set to `true` to auto-pause once `FREE_TIER_MAX_MINUTES` is exceeded. |
  | `FREE_TIER_MAX_MINUTES` | Defaults to 5,400 (≈ 90 hours). |
  | `PORT` | Overridden automatically by Cloud Run. |

- Deploy with one command (after filling `backend/.env` and authenticating `gcloud`):

  ```bash
  ./scripts/deploy.sh
  ```

  The script builds with Cloud Build and deploys to Cloud Run, automatically injecting the `.env` file as `--set-env-vars`.

- The backend is intentionally tiny (< 200 lines of logic) so contractors can reason about it quickly.

---

## 3. Receptionist dashboard (Firebase Hosting)

- [`receptionist/index.html`](receptionist/index.html) + [`app.js`](receptionist/app.js) + [`style.css`](receptionist/style.css).
- Paste your Firebase config in the inline `window.FIREBASE_CONFIG` object and run `firebase deploy --only hosting`.
- The dashboard:
  - Subscribes to `calls/{CallSid}` in Realtime Database.
  - Streams the transcript and AI card in real time.
  - Provides a one-click **Book appointment** button that pushes to `calls/{CallSid}/actions` (ready for a Cloud Function that hits Google Calendar).
  - Accepts `?call=<CallSid>` in the URL to lock onto a specific conversation, otherwise follows the newest call.

---

## 4. Scripts and testing

- [`scripts/deploy.sh`](scripts/deploy.sh): Cloud Build → Cloud Run in a single command.
- [`scripts/twilio-test.sh`](scripts/twilio-test.sh): Simulate an inbound call with the Twilio CLI.

  ```bash
  FROM_NUMBER=+15551234567 \
  TO_NUMBER=+15557654321 \
  ./scripts/twilio-test.sh
  ```

  Use `TWIML_BIN_URL=https://handler.twilio.com/...` to hit a live TwiML Bin instead of the local XML.

---

## 5. Cost & quota snapshot (realistic)

Assuming **200 calls × 10 minutes = 2,000 minutes/month**:

| Item | Unit cost | Monthly |
| ---- | --------- | ------- |
| Twilio phone number | $1.15 | $1.15 |
| Twilio SIP inbound | $0.0075 / min | $15.00 |
| Twilio PSTN outbound | $0.0130 / min | $26.00 |
| **Total telephony** | | **≈ $42** |
| Cloud Run / Gemini / Firebase | Free tier | $0 |

Picovoice Cheetah stays within the 100 h/month allowance; Gemini Flash sits comfortably under the free 60 RPM cap with one request per second.

---

## 6. Privacy & compliance checklist

- Audio lives only in RAM—no recordings, no storage buckets.
- Gemini prompt includes just the transcript (no sensitive metadata beyond caller-provided info).
- Add the Cloud Run label `data-retention=24h` to auto-prune logs.
- Provide the receptionist a simple disclaimer: **“Calls may be monitored for quality.”**

---

## 7. Optional polish (still free tier)

- **Missed-call SMS:** Cloud Scheduler (3 free jobs) hits a Cloud Function that sends an SMS via Twilio if `<Dial>` fails.
- **Spam filter:** Add instructions to the Gemini prompt to tag robocalls and light up the dashboard in red.
- **Voicemail drop:** If the receptionist rejects the call, let Twilio `<Record>` and send the transcript to email/Slack.

---

## 8. Weekend rollout plan

| Time | Milestone |
| ---- | --------- |
| Fri 7 pm | Clone repo, buy Twilio number, link GV SIP. |
| Sat 9 am | Deploy Cloud Run backend. |
| Sat 2 pm | Point TwiML Bin to the Cloud Run URL. |
| Sat 5 pm | Firebase hosting live, dashboard configured. |
| Sun 10 am | Run three test calls via Twilio CLI, adjust prompts. |
| Sun 2 pm | Share dashboard URL with receptionist—done. |

You're now equipped with a production-grade, single-operator AI co-pilot that keeps the receptionist's phone workflow untouched.
