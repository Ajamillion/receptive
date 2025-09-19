#!/usr/bin/env bash
set -euo pipefail

if ! command -v twilio >/dev/null; then
  echo "Install the Twilio CLI first: https://www.twilio.com/docs/twilio-cli/quickstart" >&2
  exit 1
fi

FROM_NUMBER=${FROM_NUMBER:-}
TO_NUMBER=${TO_NUMBER:-}
TWIML_BIN_URL=${TWIML_BIN_URL:-}

if [[ -z "${FROM_NUMBER}" || -z "${TO_NUMBER}" ]]; then
  cat <<USAGE >&2
Usage: FROM_NUMBER=+15551234567 TO_NUMBER=+15557654321 $0

FROM_NUMBER  Verified caller ID that Twilio can use for the outbound leg.
TO_NUMBER    Your Twilio SIP ingress number (the one linked from Google Voice).
TWIML_BIN_URL Optional: override to hit a deployed TwiML Bin instead of local forward.xml.
USAGE
  exit 1
fi

if [[ -n "${TWIML_BIN_URL}" ]]; then
  echo "Placing test call via TwiML Bin ${TWIML_BIN_URL}…"
  twilio api:core:calls:create --from "${FROM_NUMBER}" --to "${TO_NUMBER}" --url "${TWIML_BIN_URL}"
  exit 0
fi

TWIML_PAYLOAD=$(tr -d '\n' < "$(dirname "$0")/../twilio/forward.xml")

echo "Placing test call using embedded TwiML…"
twilio api:core:calls:create --from "${FROM_NUMBER}" --to "${TO_NUMBER}" --twiml "${TWIML_PAYLOAD}"
