# Twilio configuration

1. **Buy a local phone number** that will only be used as the SIP ingress point. Do not publish it.
2. **Create a SIP Domain** inside Twilio Voice > Manage > SIP Domains.
   - Domain name: `your-company.sip.twilio.com`
   - Credential list: username `gv`, password `16-random-chars`
   - Voice configuration: set the webhook to a TwiML Bin that points to [`forward.xml`](./forward.xml).
3. **Link Google Voice to Twilio**: in Google Voice → Settings → Linked numbers → *Add SIP device* and use the URI `gv:password@your-company.sip.twilio.com`.
4. **Replace placeholders** in `forward.xml` with your receptionist's phone and the Cloud Run WebSocket endpoint.

When Google Voice receives a call it forwards to the SIP domain. Twilio then:

- Bridges the call to the receptionist's phone using `<Dial>`.
- Streams the raw μ-law audio to the Cloud Run backend via `<Start><Stream>`.

No human interaction is required on the Twilio side after this one-time setup.
