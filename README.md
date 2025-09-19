# GV AI Co-pilot

Production-ready starter that bolts AI assistance onto an existing Google Voice workflow in a weekend. The call flow:

1. Customer dials your Google Voice number.
2. Google Voice forwards to a Twilio SIP domain.
3. Twilio bridges the caller to the receptionist **and** streams μ-law audio to Cloud Run.
4. Cloud Run (this repo) transcribes with Picovoice Cheetah, summarizes with Gemini 1.5 Flash, and writes updates into Firebase Realtime Database.
5. The receptionist dashboard (Firebase Hosting) shows the live transcript, AI guidance, and a one-click booking form.

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

[`backend/main.py`](backend/main.py) exposes three endpoints:

- `GET /healthz` for liveness checks.
- `WS /audiostream` accepts Twilio media frames, converts μ-law → 16 kHz PCM, streams Picovoice Cheetah results, asks Gemini 1.5 Flash for JSON summaries, and mirrors everything into Firebase (`calls/{CallSid}`).
  - Caller metadata from the Twilio start event (`from`, `to`, and custom parameters) is written so the dashboard can show who is on the line and pre-fill the booking form.
  - Gemini calls only happen when Cheetah emits an end-of-utterance chunk so you get concise cards without hammering the API.
  - When the socket closes the service flushes the final transcript, publishes one last AI card, and marks the call `Completed` with the duration.
- `POST /bookings` takes the receptionist form, creates a Google Calendar event via a service account, and records the booking metadata back into Firebase.

Environment variables (copy [`backend/.env.example`](backend/.env.example)):

| Key | Purpose |
| --- | --- |
| `CHEETAH_ACCESS_KEY` | Picovoice Cheetah access key (100 h/mo free). |
| `GEMINI_API_KEY` | Gemini 1.5 Flash key (Google AI Studio free tier). |
| `FIREBASE_RTDB_URL` | `https://<project>.firebaseio.com` root. |
| `FIREBASE_DB_SECRET` | Optional database secret/custom token for REST writes. |
| `CALENDAR_ID` | Google Calendar ID (e.g. `primary` or a shared calendar address). |
| `GOOGLE_SERVICE_ACCOUNT_INFO` | Inline JSON (or base64) for the service account; you can also mount a file and set `GOOGLE_APPLICATION_CREDENTIALS`. |
| `ALLOWED_ORIGINS` | Optional comma-separated list for CORS. Leave blank to allow all origins. |
| `PORT` | Overridden automatically by Cloud Run. |

**Google Calendar hookup:**

1. Create a service account in the same Google Cloud project, enable the Calendar API, and download the JSON credentials.
2. Share the target calendar (e.g. `primary` or a dedicated team calendar) with the service-account email and grant “Make changes to events”.
3. Provide the credentials to Cloud Run either by pasting JSON into `GOOGLE_SERVICE_ACCOUNT_INFO` or by mounting the file and setting `GOOGLE_APPLICATION_CREDENTIALS`.
4. Set `CALENDAR_ID` to the calendar you shared. The backend will write booking metadata back to `calls/{CallSid}` for the dashboard.

Deploy with one command (after filling `backend/.env` and authenticating `gcloud`):

```bash
./scripts/deploy.sh
```

The script builds with Cloud Build and deploys to Cloud Run, automatically injecting the `.env` file as `--set-env-vars`.

---

## 3. Receptionist dashboard (Firebase Hosting)

[`receptionist/index.html`](receptionist/index.html) + [`app.js`](receptionist/app.js) + [`style.css`](receptionist/style.css).

- Paste your Firebase config in the inline `window.FIREBASE_CONFIG` object and run `firebase deploy --only hosting`.
- Set `window.BACKEND_BASE_URL` in `index.html` to point at the Cloud Run service (e.g. `https://your-service.a.run.app`).
- The dashboard automatically follows the newest call in `calls/{CallSid}` (or a specific one via `?call=<CallSid>`), renders the live transcript, surfaces Gemini summaries/action items, and exposes a Google Calendar booking form that posts to the backend.
- Leave the Firebase config blank to showcase the built-in demo stream—handy for onboarding without wiring any credentials.

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

Picovoice Cheetah stays within the 100 h/month allowance; Gemini Flash sits comfortably under the free 60 RPM cap with one request per utterance.

---

## 6. Privacy & compliance checklist

- Audio lives only in RAM—no recordings, no storage buckets.
- Gemini prompt includes just the transcript (no sensitive metadata beyond caller-provided info).
- Add the Cloud Run label `data-retention=24h` to auto-prune logs.
- Provide the receptionist a simple disclaimer: **“Calls may be monitored for quality.”**

---

## 7. Optional polish (still free tier)

- **Missed-call SMS:** Cloud Scheduler (3 free jobs) hits a Cloud Function that sends an SMS via Twilio if `<Dial>` fails.
- **Spam filter:** Add a Gemini guardrail—if the transcript looks like a robocall, write `spam: true` to Firebase so the receptionist knows to hang up.
- **Voicemail drop:** If the human rejects the call, Twilio `<Record>` → transcript → email.
