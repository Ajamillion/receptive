const config = window.FIREBASE_CONFIG || {};
const backendBaseUrl = (window.BACKEND_BASE_URL || "").replace(/\/$/, "");
const hasFirebaseConfig = Boolean(config.apiKey && config.databaseURL);

if (hasFirebaseConfig) {
  firebase.initializeApp(config);
}

const db = hasFirebaseConfig ? firebase.database() : null;
const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || null;

const statusEl = document.getElementById("call-status");
const transcriptEl = document.getElementById("transcript");
const summaryEl = document.getElementById("ai-summary");
const actionsEl = document.getElementById("ai-actions");
const bookingDetailsEl = document.getElementById("booking-details");
const bookingStatusEl = document.getElementById("booking-status");
const bookButton = document.getElementById("book-button");
const bookingDialog = document.getElementById("booking-dialog");
const bookingForm = document.getElementById("booking-form");
const bookingNameInput = document.getElementById("booking-name");
const bookingPhoneInput = document.getElementById("booking-phone");
const bookingStartInput = document.getElementById("booking-start");
const bookingDurationInput = document.getElementById("booking-duration");
const bookingNotesInput = document.getElementById("booking-notes");
const bookingCancelButton = document.getElementById("booking-cancel");
const bookingSubmitButton = document.getElementById("booking-submit");

const state = {
  callId: null,
  transcript: { final: "", partial: "" },
  ai: null,
  booking: null,
  bookingInFlight: false,
  callUnsub: null,
  followUnsub: null,
  demoTimers: [],
  demoMode: !hasFirebaseConfig,
};

function setStatus(text) {
  statusEl.textContent = text;
}

function setBookingStatus(message, tone = "info") {
  bookingStatusEl.textContent = message || "";
  bookingStatusEl.dataset.tone = message ? tone : "";
}

function updateBookButton() {
  const ready = Boolean(state.callId) && !state.bookingInFlight;
  bookButton.disabled = !ready;
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDateRange(startIso, endIso) {
  const start = parseDate(startIso);
  if (!start) return "";
  const end = parseDate(endIso);
  const baseOptions = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
  const startLabel = start.toLocaleString([], baseOptions);
  if (!end) return startLabel;
  if (start.toDateString() === end.toDateString()) {
    return `${startLabel} – ${end.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  }
  return `${startLabel} → ${end.toLocaleString([], baseOptions)}`;
}

function renderTranscript(data) {
  state.transcript = data || { final: "", partial: "" };
  transcriptEl.innerHTML = "";

  if (!data || (!data.final && !data.partial)) {
    const placeholder = document.createElement("p");
    placeholder.className = "placeholder";
    placeholder.textContent = "No transcript yet.";
    transcriptEl.appendChild(placeholder);
    return;
  }

  if (data.final) {
    data.final
      .split(/\n+/)
      .filter(Boolean)
      .forEach((line) => {
        const p = document.createElement("p");
        p.textContent = line;
        transcriptEl.appendChild(p);
      });
  }

  if (data.partial) {
    const partial = document.createElement("p");
    partial.className = "partial";
    partial.textContent = data.partial;
    transcriptEl.appendChild(partial);
  }

  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function renderAi(card) {
  state.ai = card || null;
  summaryEl.innerHTML = "";
  actionsEl.innerHTML = "";

  if (!card || !card.summary) {
    const placeholder = document.createElement("p");
    placeholder.className = "placeholder";
    placeholder.textContent = "Waiting for summary…";
    summaryEl.appendChild(placeholder);
    updateBookButton();
    return;
  }

  const summary = document.createElement("p");
  summary.textContent = card.summary;
  summaryEl.appendChild(summary);

  const meta = document.createElement("p");
  meta.className = "meta";
  const sentiment = card.sentiment || "neutral";
  const urgency = card.urgency || "medium";
  meta.textContent = `Sentiment: ${sentiment} · Urgency: ${urgency}`;
  summaryEl.appendChild(meta);

  const items = Array.isArray(card.action_items) ? card.action_items : [];
  if (items.length) {
    const header = document.createElement("h3");
    header.textContent = "Action items";
    actionsEl.appendChild(header);

    const list = document.createElement("ul");
    items.forEach((item) => {
      const li = document.createElement("li");
      li.textContent = item;
      list.appendChild(li);
    });
    actionsEl.appendChild(list);
  }

  updateBookButton();
}

function renderBooking(booking) {
  state.booking = booking || null;
  bookingDetailsEl.innerHTML = "";

  if (!booking) {
    return;
  }

  const title = document.createElement("h3");
  title.textContent = "Calendar booking";
  bookingDetailsEl.appendChild(title);

  if (booking.summary) {
    const summary = document.createElement("p");
    summary.textContent = booking.summary;
    bookingDetailsEl.appendChild(summary);
  }

  const when = formatDateRange(booking.start, booking.end);
  if (when) {
    const whenEl = document.createElement("p");
    whenEl.className = "meta";
    whenEl.textContent = when;
    bookingDetailsEl.appendChild(whenEl);
  }

  if (booking.htmlLink) {
    const link = document.createElement("a");
    link.href = booking.htmlLink;
    link.target = "_blank";
    link.rel = "noreferrer noopener";
    link.textContent = "Open in Google Calendar";
    bookingDetailsEl.appendChild(link);
  }

  if (booking.notes) {
    const notes = document.createElement("p");
    notes.textContent = booking.notes;
    bookingDetailsEl.appendChild(notes);
  }

  setBookingStatus("Appointment saved to Google Calendar.", "success");
}

function formatStatus(value) {
  if (!value) return "Connected";
  const clean = value.replace(/_/g, " ");
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

function toDatetimeLocal(date) {
  const pad = (num) => String(num).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

function roundToNextQuarter(date) {
  const clone = new Date(date.getTime());
  const minutes = clone.getMinutes();
  const remainder = minutes % 15;
  if (remainder !== 0) {
    clone.setMinutes(minutes + (15 - remainder));
  }
  clone.setSeconds(0, 0);
  return clone;
}

function suggestStartTime() {
  const now = new Date();
  now.setMinutes(now.getMinutes() + 60);
  now.setSeconds(0, 0);
  return roundToNextQuarter(now);
}

function detachCallListener() {
  if (state.callUnsub) {
    state.callUnsub();
    state.callUnsub = null;
  }
}

function attachCall(callSid) {
  if (!db) {
    return;
  }
  detachCallListener();
  state.callId = callSid;
  setStatus("Connecting…");
  setBookingStatus("");
  renderTranscript(null);
  renderAi(null);
  renderBooking(null);
  updateBookButton();

  const ref = db.ref(`calls/${callSid}`);
  const handler = (snapshot) => {
    const data = snapshot.val() || {};
    setStatus(formatStatus(data.status));
    renderTranscript(data.transcript || null);
    renderAi(data.ai || null);
    renderBooking(data.booking || null);
  };
  ref.on("value", handler);
  state.callUnsub = () => ref.off("value", handler);
}

function followLatestCall() {
  if (!db) {
    return;
  }
  if (state.followUnsub) {
    state.followUnsub();
  }
  const ref = db.ref("calls").limitToLast(20);
  const handler = (snapshot) => {
    const calls = snapshot.val();
    if (!calls || typeof calls !== "object") {
      return;
    }
    let latestId = null;
    let latestTime = -Infinity;
    Object.entries(calls).forEach(([id, call]) => {
      const timestamp = Date.parse(call.startedAt || call.connectedAt || call.createdAt || call.updatedAt || 0);
      if (!Number.isNaN(timestamp) && timestamp >= latestTime) {
        latestTime = timestamp;
        latestId = id;
      }
    });
    if (!latestId) {
      const keys = Object.keys(calls);
      latestId = keys[keys.length - 1];
    }
    if (latestId && latestId !== state.callId) {
      attachCall(latestId);
    }
  };
  ref.on("value", handler);
  state.followUnsub = () => ref.off("value", handler);
}

function openBookingDialog() {
  if (!state.callId) {
    setBookingStatus("Wait for an active call before booking.", "error");
    return;
  }

  const defaultStart = state.booking?.start ? parseDate(state.booking.start) : suggestStartTime();
  bookingStartInput.value = defaultStart ? toDatetimeLocal(defaultStart) : "";
  bookingDurationInput.value = state.booking?.durationMinutes || bookingDurationInput.value || "60";
  bookingNameInput.value = state.booking?.customerName || "";
  bookingPhoneInput.value = state.booking?.customerPhone || "";
  bookingNotesInput.value = state.booking?.notes || "";
  setBookingStatus("");
  bookingDialog.showModal();
}

function setBookingInFlight(active) {
  state.bookingInFlight = active;
  bookingSubmitButton.disabled = active;
  updateBookButton();
}

function gatherTranscriptText() {
  const parts = [];
  if (state.transcript.final) parts.push(state.transcript.final);
  if (state.transcript.partial) parts.push(state.transcript.partial);
  return parts.join(" ").trim();
}

async function submitBooking(event) {
  event.preventDefault();
  if (!state.callId) {
    setBookingStatus("No active call to attach the booking.", "error");
    bookingDialog.close();
    return;
  }

  if (state.demoMode) {
    setBookingStatus("Demo mode: bookings are not sent to Google Calendar.", "info");
    bookingDialog.close();
    return;
  }

  if (!backendBaseUrl) {
    setBookingStatus("Set BACKEND_BASE_URL to enable calendar bookings.", "error");
    bookingDialog.close();
    return;
  }

  if (!hasFirebaseConfig) {
    setBookingStatus("Connect the dashboard to Firebase before booking.", "error");
    bookingDialog.close();
    return;
  }

  const startValue = bookingStartInput.value;
  if (!startValue) {
    setBookingStatus("Choose a start time for the appointment.", "error");
    return;
  }
  const startDate = new Date(startValue);
  if (Number.isNaN(startDate.getTime())) {
    setBookingStatus("Invalid start time.", "error");
    return;
  }

  const clean = (value) => (value && value.trim() ? value.trim() : null);
  const durationRaw = Number.parseInt(bookingDurationInput.value, 10);
  const durationMinutes = Number.isFinite(durationRaw) && durationRaw > 0 ? durationRaw : 60;

  const payload = {
    callSid: state.callId,
    customerName: clean(bookingNameInput.value),
    customerPhone: clean(bookingPhoneInput.value),
    startIso: new Date(startValue).toISOString(),
    durationMinutes,
    notes: clean(bookingNotesInput.value),
    summary: state.ai?.summary || null,
    transcript: gatherTranscriptText() || null,
    timeZone: localTimeZone,
  };

  setBookingInFlight(true);
  setBookingStatus("Saving appointment…", "info");

  try {
    const response = await fetch(`${backendBaseUrl}/bookings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      let message = `Booking failed with status ${response.status}`;
      try {
        const data = await response.json();
        if (data && data.detail) {
          message = data.detail;
        }
      } catch (err) {
        // ignore JSON parse errors
      }
      throw new Error(message);
    }
    setBookingStatus("Appointment saved to Google Calendar.", "success");
  } catch (error) {
    setBookingStatus(error.message || "Booking failed.", "error");
  } finally {
    setBookingInFlight(false);
    bookingDialog.close();
  }
}

function clearDemoTimers() {
  state.demoTimers.forEach((timer) => clearTimeout(timer));
  state.demoTimers = [];
}

function runDemo() {
  state.callId = "demo-call";
  state.demoMode = true;
  updateBookButton();
  setStatus("Demo call connected");
  setBookingStatus("Demo mode: add Firebase config to go live.", "info");
  renderTranscript({ final: "", partial: "" });
  renderAi(null);

  const transcriptSteps = [
    "Customer: Hi, I'm calling about a water heater that isn't working.",
    "Receptionist: I'm sorry to hear that! What's your name?",
    "Customer: It's Jamie Patel. I'm hoping for service this week.",
    "Receptionist: We can send a technician on Wednesday afternoon.",
    "Customer: Perfect, any time after 2 PM works.",
    "Receptionist: Great, I'll confirm the address and schedule it.",
  ];

  const aiCards = [
    {
      summary: "Customer is reporting a broken water heater and needs service this week.",
      sentiment: "neutral",
      urgency: "high",
      action_items: ["Capture contact details", "Offer earliest technician availability"],
    },
    {
      summary: "Jamie Patel agreed to a Wednesday afternoon visit for water heater repair.",
      sentiment: "positive",
      urgency: "medium",
      action_items: ["Book Wednesday 2 PM", "Send confirmation text"],
    },
  ];

  const finalLines = [];
  function advance(step) {
    if (step >= transcriptSteps.length) {
      const start = new Date();
      start.setDate(start.getDate() + 1);
      start.setHours(14, 0, 0, 0);
      const end = new Date(start.getTime() + 60 * 60 * 1000);
      renderBooking({
        summary: "Demo: Water heater repair",
        start: start.toISOString(),
        end: end.toISOString(),
        notes: "Demo mode placeholder",
        htmlLink: "https://calendar.google.com",
      });
      return;
    }

    finalLines.push(transcriptSteps[step]);
    renderTranscript({ final: finalLines.join("\n"), partial: "" });
    const cardIndex = step < 3 ? 0 : 1;
    renderAi(aiCards[cardIndex]);

    const timer = setTimeout(() => advance(step + 1), 2000);
    state.demoTimers.push(timer);
  }

  advance(0);
}

bookButton.addEventListener("click", openBookingDialog);
bookingCancelButton.addEventListener("click", () => bookingDialog.close());
bookingForm.addEventListener("submit", submitBooking);
window.addEventListener("beforeunload", clearDemoTimers);

updateBookButton();

if (hasFirebaseConfig) {
  const params = new URLSearchParams(window.location.search);
  const callParam = params.get("call");
  if (callParam) {
    attachCall(callParam);
  } else {
    followLatestCall();
  }
} else {
  console.warn("Firebase config missing; running in demo mode.");
  runDemo();
}
