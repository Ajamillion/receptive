const config = window.FIREBASE_CONFIG || {};
const backendBaseUrl = (window.BACKEND_BASE_URL || "").replace(/\/$/, "");
const hasFirebase = Boolean(config.apiKey && config.databaseURL);
if (hasFirebase) firebase.initializeApp(config);
const db = hasFirebase ? firebase.database() : null;

const el = {
  status: document.getElementById("status"),
  callId: document.getElementById("call-id"),
  callerName: document.getElementById("caller-name"),
  callerNumber: document.getElementById("caller-number"),
  callerForwarded: document.getElementById("caller-forwarded"),
  transcriptFinal: document.getElementById("transcript-final"),
  transcriptPartial: document.getElementById("transcript-partial"),
  aiSummary: document.getElementById("ai-summary"),
  aiMeta: document.getElementById("ai-meta"),
  aiActions: document.getElementById("ai-actions"),
  bookingForm: document.getElementById("booking-form"),
  bookingSubmit: document.getElementById("booking-submit"),
  bookingResult: document.getElementById("booking-result"),
  bookingName: document.getElementById("booking-name"),
  bookingPhone: document.getElementById("booking-phone"),
  bookingStart: document.getElementById("booking-start"),
  bookingDuration: document.getElementById("booking-duration"),
  bookingNotes: document.getElementById("booking-notes"),
};

const state = { callId: null, callRef: null, callListener: null, latestRef: null, latestListener: null, demoTimer: null };
const clean = (value) => (value === undefined || value === null ? "" : String(value).trim());

function setStatus(text) {
  el.status.textContent = text || "Waiting for a call…";
}

function renderActionItems(items) {
  el.aiActions.innerHTML = "";
  const list = Array.isArray(items) && items.length ? items : ["No action items yet."];
  list.forEach((item, index) => {
    const li = document.createElement("li");
    li.textContent = item;
    if (!Array.isArray(items) || !items.length) li.className = "muted";
    el.aiActions.appendChild(li);
  });
}

function renderCall(callSid, data) {
  state.callId = callSid;
  if (el.callId) {
    el.callId.hidden = !callSid;
    el.callId.textContent = callSid ? `Call SID: ${callSid}` : "";
  }
  el.bookingSubmit.disabled = !callSid;
  if (!data) {
    setStatus("Waiting for a call…");
    [el.callerName, el.callerNumber, el.callerForwarded].forEach((node) => (node.textContent = "—"));
    el.transcriptFinal.textContent = "No transcript yet.";
    el.transcriptPartial.textContent = "";
    el.aiSummary.textContent = "Waiting for summary…";
    el.aiMeta.textContent = "";
    renderActionItems([]);
    el.bookingResult.textContent = "";
    return;
  }

  setStatus(data.status || "Connected");
  const metadata = data.metadata && typeof data.metadata === "object" ? data.metadata : {};
  el.callerName.textContent = clean(metadata.callerName || metadata.name) || "—";
  el.callerNumber.textContent = clean(metadata.callerNumber || metadata.from) || "—";
  el.callerForwarded.textContent = clean(metadata.forwardedTo || metadata.to) || "—";

  const transcript = data.transcript && typeof data.transcript === "object" ? data.transcript : {};
  const finalText = clean(transcript.final);
  el.transcriptFinal.textContent = finalText || "No transcript yet.";
  el.transcriptPartial.textContent = clean(transcript.partial);

  const card = data.ai && data.ai.card && typeof data.ai.card === "object" ? data.ai.card : null;
  if (card) {
    el.aiSummary.textContent = clean(card.summary) || "Waiting for summary…";
    const sentiment = clean(card.sentiment) || "neutral";
    const urgency = clean(card.urgency) || "medium";
    el.aiMeta.textContent = `Sentiment: ${sentiment} · Urgency: ${urgency}`;
    renderActionItems(card.action_items || card.actionItems || []);
  } else {
    el.aiSummary.textContent = "Waiting for summary…";
    el.aiMeta.textContent = "";
    renderActionItems([]);
  }

  const booking = data.booking && typeof data.booking === "object" ? data.booking : null;
  if (booking && (booking.summary || booking.eventId)) {
    el.bookingResult.textContent = booking.summary ? `Booked: ${booking.summary}` : `Booked event ${booking.eventId}`;
  } else {
    el.bookingResult.textContent = "";
  }

  if (!el.bookingName.value && metadata.callerName) el.bookingName.value = metadata.callerName;
  if (!el.bookingPhone.value && metadata.callerNumber) el.bookingPhone.value = metadata.callerNumber;
}

function unsubscribe(ref, listener) {
  if (ref && listener) ref.off("value", listener);
}

function subscribeToCall(callSid) {
  if (!db || !callSid) return;
  unsubscribe(state.callRef, state.callListener);
  const ref = db.ref(`calls/${callSid}`);
  renderCall(callSid, null);
  const listener = (snapshot) => renderCall(callSid, snapshot.val());
  ref.on("value", listener);
  state.callRef = ref;
  state.callListener = listener;
}

function followLatestCall() {
  if (!db) return;
  unsubscribe(state.latestRef, state.latestListener);
  const ref = db.ref("calls").orderByChild("createdAt").limitToLast(1);
  const listener = (snapshot) => {
    const value = snapshot.val();
    if (!value) return;
    let newestId = null;
    let newestCreated = "";
    Object.entries(value).forEach(([key, entry]) => {
      if (!entry || typeof entry !== "object") return;
      const created = typeof entry.createdAt === "string" ? entry.createdAt : "";
      if (!newestId || created > newestCreated) {
        newestId = key;
        newestCreated = created;
      }
    });
    if (newestId && newestId !== state.callId) subscribeToCall(newestId);
  };
  ref.on("value", listener);
  state.latestRef = ref;
  state.latestListener = listener;
}

function toLocalInputValue(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

function setDefaultStart() {
  const date = new Date();
  date.setMinutes(date.getMinutes() + 30, 0, 0);
  el.bookingStart.value = toLocalInputValue(date);
}

async function submitBooking(event) {
  event.preventDefault();
  if (!state.callId) {
    el.bookingResult.textContent = "Wait for a call before booking.";
    return;
  }
  if (!backendBaseUrl) {
    el.bookingResult.textContent = "Set BACKEND_BASE_URL in index.html.";
    return;
  }
  el.bookingSubmit.disabled = true;
  el.bookingResult.textContent = "Saving to calendar…";

  const startValue = el.bookingStart.value;
  const startDate = startValue ? new Date(startValue) : null;
  if (!startDate || Number.isNaN(startDate.getTime())) {
    el.bookingResult.textContent = "Provide a valid start time.";
    el.bookingSubmit.disabled = false;
    return;
  }

  const payload = {
    callSid: state.callId,
    customerName: el.bookingName.value.trim() || null,
    customerPhone: el.bookingPhone.value.trim() || null,
    startIso: startDate.toISOString(),
    durationMinutes: Number.parseInt(el.bookingDuration.value, 10) || 60,
    notes: el.bookingNotes.value.trim() || null,
    summary: el.aiSummary.textContent || null,
    transcript:
      el.transcriptFinal.textContent && el.transcriptFinal.textContent !== "No transcript yet."
        ? el.transcriptFinal.textContent
        : null,
  };

  try {
    const response = await fetch(`${backendBaseUrl}/bookings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();
    el.bookingResult.textContent = data.eventId ? `Booked event ${data.eventId}` : "Booking saved.";
  } catch (error) {
    console.error(error);
    el.bookingResult.textContent = "Calendar booking failed.";
  } finally {
    el.bookingSubmit.disabled = !state.callId;
  }
}

function runDemo() {
  setStatus("Demo mode — no Firebase config provided");
  renderCall(null, null);
  el.callerName.textContent = "Taylor (demo)";
  el.callerNumber.textContent = "+1 555 0100";
  el.callerForwarded.textContent = "Receptionist";
  const script = [
    "Hi, this is Taylor. The water heater is leaking again and we need a technician.",
    "It started this morning and we already shut off the water.",
    "We are free tomorrow after 2pm if that works.",
  ];
  let index = 0;
  state.demoTimer = setInterval(() => {
    if (index >= script.length) {
      clearInterval(state.demoTimer);
      el.aiSummary.textContent = "Schedule a technician for Taylor tomorrow after 2pm.";
      el.aiMeta.textContent = "Sentiment: neutral · Urgency: medium";
      renderActionItems(["Offer a same-day appointment window", "Confirm callback number"]);
      el.bookingSubmit.disabled = false;
      el.bookingName.value = "Taylor";
      el.bookingPhone.value = "+1 555 0100";
      return;
    }
    el.transcriptFinal.textContent = `${el.transcriptFinal.textContent} ${script[index]}`.trim();
    index += 1;
  }, 1800);
}

setDefaultStart();
if (el.bookingForm) el.bookingForm.addEventListener("submit", submitBooking);

if (hasFirebase) {
  const params = new URLSearchParams(window.location.search);
  const callParam = params.get("call");
  if (callParam) {
    subscribeToCall(callParam);
  } else {
    followLatestCall();
  }
} else {
  el.bookingSubmit.disabled = false;
  runDemo();
}
