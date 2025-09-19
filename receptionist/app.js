const config = window.FIREBASE_CONFIG || {};
const hasFirebaseConfig = Boolean(config.apiKey && config.databaseURL);
const backendBaseUrl = (window.BACKEND_BASE_URL || "").replace(/\/$/, "");
const userTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";

let db = null;
if (hasFirebaseConfig) {
  firebase.initializeApp(config);
  db = firebase.database();
} else {
  console.warn("Firebase config missing; the dashboard will run in demo mode.");
}

const statusEl = document.getElementById("call-status");
const transcriptEl = document.getElementById("transcript-text");
const summaryEl = document.getElementById("ai-summary");
const actionsEl = document.getElementById("ai-actions");
const actionLogEl = document.getElementById("action-log");
const bookButton = document.getElementById("book-button");
const defaultBookText = "Book appointment";
bookButton.textContent = defaultBookText;

const bookingModal = document.getElementById("booking-modal");
const bookingForm = document.getElementById("booking-form");
const bookingNameInput = document.getElementById("booking-name");
const bookingPhoneInput = document.getElementById("booking-phone");
const bookingStartInput = document.getElementById("booking-start");
const bookingDurationInput = document.getElementById("booking-duration");
const bookingNotesInput = document.getElementById("booking-notes");
const bookingMessage = document.getElementById("booking-message");
const bookingCancelButton = document.getElementById("booking-cancel");
const bookingSubmitButton = document.getElementById("booking-submit");
const bookingTimezoneHint = document.getElementById("booking-timezone-hint");

if (bookingTimezoneHint) {
  bookingTimezoneHint.textContent = userTimeZone
    ? `Times shown in ${userTimeZone}`
    : "Times shown in your local timezone";
}

let currentCallSid = null;
let detachListeners = [];
let demoTimeouts = [];
let latestTranscript = { final: "", partial: "" };
let latestAiCard = null;
let bookingInFlight = false;
let demoBookingUnlocked = false;
let canBook = false;
let localActionLog = [];

function setStatus(text) {
  statusEl.textContent = text;
}

function updateBookButtonState() {
  const hasCall = Boolean(currentCallSid);
  bookButton.disabled = bookingInFlight || !canBook || !hasCall;
}

updateBookButtonState();

const MODE_BADGE_LABELS = {
  backend: "Calendar",
  firebase: "Firebase",
  demo: "Demo",
};

function escapeHtml(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}

function parseIsoDate(value) {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function getActionTimestamp(action) {
  if (!action || typeof action !== "object") {
    return 0;
  }
  const created = parseIsoDate(action.createdAt || action.created_at);
  if (created) {
    return created.getTime();
  }
  const start = parseIsoDate(action.start || action.startIso || action.start_time);
  if (start) {
    return start.getTime();
  }
  return 0;
}

function formatLogTimestamp(value) {
  const date = parseIsoDate(value);
  if (!date) {
    return "—";
  }
  const now = new Date();
  const sameDay = now.toDateString() === date.toDateString();
  const options = sameDay
    ? { hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
  return date.toLocaleString([], options);
}

function formatActionTimeRange(startIso, endIso) {
  const startDate = parseIsoDate(startIso);
  if (!startDate) {
    return "";
  }
  const baseOptions = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
  const startLabel = startDate.toLocaleString([], baseOptions);
  const endDate = parseIsoDate(endIso);
  if (!endDate) {
    return startLabel;
  }
  if (startDate.toDateString() === endDate.toDateString()) {
    const endLabel = endDate.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return `${startLabel} – ${endLabel}`;
  }
  return `${startLabel} → ${endDate.toLocaleString([], baseOptions)}`;
}

function formatActionBadge(action) {
  if (!action || typeof action.mode !== "string") {
    return "";
  }
  const key = action.mode.toLowerCase();
  if (MODE_BADGE_LABELS[key]) {
    return MODE_BADGE_LABELS[key];
  }
  return action.mode.charAt(0).toUpperCase() + action.mode.slice(1);
}

function formatActionDescription(action) {
  if (!action || typeof action !== "object") {
    return "Action logged";
  }
  if (action.type === "book") {
    let text = "Booked appointment";
    if (action.customerName) {
      text += ` for ${action.customerName}`;
    }
    const when = formatActionTimeRange(action.start, action.end);
    if (when) {
      text += ` – ${when}`;
    }
    return text;
  }
  if (typeof action.description === "string" && action.description.trim()) {
    return action.description.trim();
  }
  if (typeof action.summary === "string" && action.summary.trim()) {
    return action.summary.trim();
  }
  if (typeof action.notes === "string" && action.notes.trim()) {
    return action.notes.trim();
  }
  if (typeof action.type === "string" && action.type.trim()) {
    return action.type.trim();
  }
  return "Action logged";
}

function formatActionDetails(action) {
  if (!action || typeof action !== "object") {
    return [];
  }
  const details = [];
  if (typeof action.summary === "string" && action.summary.trim()) {
    details.push({ label: "Summary", value: action.summary.trim() });
  }
  if (
    typeof action.notes === "string" &&
    action.notes.trim() &&
    action.notes.trim() !== action.summary?.trim()
  ) {
    details.push({ label: "Notes", value: action.notes.trim() });
  }
  if (typeof action.customerPhone === "string" && action.customerPhone.trim()) {
    details.push({ label: "Phone", value: action.customerPhone.trim() });
  }
  return details;
}

function renderActionLog(actions) {
  if (!actionLogEl) {
    return;
  }

  const header = "<h3>Activity</h3>";

  if (!actions || actions.length === 0) {
    actionLogEl.innerHTML = `${header}<p class="placeholder">No receptionist actions yet.</p>`;
    return;
  }

  const sorted = actions
    .filter((item) => item && typeof item === "object")
    .sort((a, b) => getActionTimestamp(a) - getActionTimestamp(b));

  const limited = sorted.slice(-20);
  const itemsHtml = limited
    .map((action) => {
      const timestampLabel = formatLogTimestamp(action.createdAt || action.created_at || action.start);
      const description = formatActionDescription(action);
      const badge = formatActionBadge(action);
      const detailsHtml = formatActionDetails(action)
        .map(
          ({ label, value }) =>
            `<p class="activity-detail"><span class="detail-label">${escapeHtml(label)}</span>${escapeHtml(value)}</p>`,
        )
        .join("");
      const actionItems = Array.isArray(action.actionItems)
        ? action.actionItems
        : Array.isArray(action.action_items)
        ? action.action_items
        : [];
      const itemsList = actionItems.length
        ? `<div class="activity-detail"><span class="detail-label">Tasks</span><ul class="activity-sublist">${actionItems
            .map((item) => `<li>${escapeHtml(item)}</li>`)
            .join("")}</ul></div>`
        : "";

      return `
        <li class="activity-item">
          <span class="activity-time">${escapeHtml(timestampLabel)}</span>
          <div class="activity-body">
            <div class="activity-header">
              <span class="activity-title">${escapeHtml(description)}</span>
              ${badge ? `<span class="activity-badge">${escapeHtml(badge)}</span>` : ""}
            </div>
            ${detailsHtml}${itemsList}
          </div>
        </li>
      `;
    })
    .join("");

  actionLogEl.innerHTML = `${header}<ul class="activity-list">${itemsHtml}</ul>`;
}

function resetLocalActionLog() {
  localActionLog = [];
  renderActionLog([]);
}

function recordLocalAction(action) {
  if (db) {
    return;
  }
  const entry = { ...action };
  entry.createdAt = entry.createdAt || new Date().toISOString();
  localActionLog = [...localActionLog, entry].slice(-20);
  renderActionLog(localActionLog);
}

renderActionLog([]);

function refreshBookingAvailability() {
  const hasCard = Boolean(latestAiCard && latestAiCard.summary);
  if (!currentCallSid) {
    canBook = false;
  } else if (!db && !demoBookingUnlocked) {
    canBook = false;
  } else {
    canBook = hasCard;
  }
  updateBookButtonState();
}

function renderTranscript(transcript) {
  latestTranscript = transcript
    ? { final: transcript.final || "", partial: transcript.partial || "" }
    : { final: "", partial: "" };

  if (!transcript) {
    transcriptEl.innerHTML = "<p class=\"placeholder\">No transcript yet.</p>";
    return;
  }

  const parts = [];
  if (transcript.final) {
    const paragraphs = transcript.final.split(/\n+/).filter(Boolean);
    paragraphs.forEach((p) => {
      parts.push(`<p>${p}</p>`);
    });
  }
  if (transcript.partial) {
    parts.push(`<p class="partial">${transcript.partial}</p>`);
  }
  transcriptEl.innerHTML = parts.join("");
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function renderAi(card) {
  latestAiCard = card || null;

  if (!card || !card.summary) {
    summaryEl.innerHTML = "<p class=\"placeholder\">Listening…</p>";
    actionsEl.innerHTML = "";
    refreshBookingAvailability();
    return;
  }

  summaryEl.innerHTML = `
    <h3>Summary</h3>
    <p>${card.summary}</p>
    <p class="meta">Sentiment: <strong>${card.sentiment || "neutral"}</strong></p>
    <p class="meta">Urgency: <strong>${card.urgency || "medium"}</strong></p>
  `;

  const items = Array.isArray(card.action_items) ? card.action_items : [];
  if (items.length) {
    actionsEl.innerHTML = `
      <h3>Action items</h3>
      <ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul>
    `;
  } else {
    actionsEl.innerHTML = "";
  }

  refreshBookingAvailability();
}

function clearListeners() {
  detachListeners.forEach((off) => off());
  detachListeners = [];
}

function listen(ref, event, handler) {
  ref.on(event, handler);
  detachListeners.push(() => ref.off(event, handler));
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function formatDatetimeLocal(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

function roundToQuarterHour(date) {
  const rounded = new Date(date.getTime());
  const minutes = rounded.getMinutes();
  const remainder = minutes % 15;
  if (remainder !== 0) {
    rounded.setMinutes(minutes + (15 - remainder));
  }
  rounded.setSeconds(0, 0);
  return rounded;
}

function suggestStartTime() {
  const now = new Date();
  now.setMinutes(now.getMinutes() + 60);
  now.setSeconds(0, 0);
  return roundToQuarterHour(now);
}

function resetBookingForm() {
  if (!bookingForm) {
    return;
  }
  bookingForm.reset();
  if (bookingDurationInput && bookingDurationInput.dataset.default) {
    bookingDurationInput.value = bookingDurationInput.dataset.default;
  }
  if (bookingStartInput) {
    bookingStartInput.value = "";
  }
  if (bookingNotesInput) {
    bookingNotesInput.value = "";
  }
  bookingMessage.textContent = "";
}
function openBookingModal() {
  if (!bookingForm) {
    return;
  }

  if (!bookingStartInput.value) {
    bookingStartInput.value = formatDatetimeLocal(suggestStartTime());
  }

  if (bookingDurationInput && bookingDurationInput.dataset.default) {
    bookingDurationInput.value = bookingDurationInput.dataset.default;
  }

  if (latestAiCard && latestAiCard.summary && !bookingNotesInput.value) {
    bookingNotesInput.value = latestAiCard.summary;
  } else if (!bookingNotesInput.value && latestTranscript.final) {
    const excerpt = latestTranscript.final.split(/\n+/).slice(-3).join(" ");
    bookingNotesInput.value = excerpt;
  }

  bookingMessage.textContent = "";
  bookingModal.classList.remove("hidden");
  window.setTimeout(() => {
    bookingNameInput?.focus();
  }, 0);
}

function closeBookingModal() {
  if (!bookingModal) {
    return;
  }
  bookingModal.classList.add("hidden");
  bookingMessage.textContent = "";
}

async function handleBookingSubmit(event) {
  event.preventDefault();
  if (!currentCallSid || bookingInFlight) {
    return;
  }

  if (!bookingStartInput.value) {
    bookingMessage.textContent = "Select a start time.";
    return;
  }

  const startDate = new Date(bookingStartInput.value);
  if (Number.isNaN(startDate.getTime())) {
    bookingMessage.textContent = "Start time is invalid.";
    return;
  }

  const durationMinutes = parseInt(bookingDurationInput.value, 10);
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
    bookingMessage.textContent = "Duration must be positive.";
    return;
  }

  bookingInFlight = true;
  updateBookButtonState();
  bookingSubmitButton.disabled = true;
  bookingCancelButton.disabled = true;
  bookButton.textContent = "Booking…";
  bookingMessage.textContent = "Scheduling…";

  const payload = {
    callSid: currentCallSid,
    customerName: bookingNameInput.value.trim() || null,
    customerPhone: bookingPhoneInput.value.trim() || null,
    startIso: startDate.toISOString(),
    durationMinutes,
    notes: bookingNotesInput.value.trim() || null,
    summary: latestAiCard?.summary || null,
    transcript: latestTranscript.final || null,
    timeZone: userTimeZone || null,
    actionItems: Array.isArray(latestAiCard?.action_items) ? latestAiCard.action_items : null,
  };

  try {
    const result = await createBooking(payload);
    const event = result.event || {};
    const eventStart = event.start ? new Date(event.start) : startDate;
    const eventStartIso = typeof event.start === "string" ? event.start : payload.startIso;
    let eventEndIso = typeof event.end === "string" ? event.end : null;
    if (!eventEndIso && eventStartIso) {
      const fallbackEnd = new Date(eventStartIso);
      if (!Number.isNaN(fallbackEnd.getTime())) {
        fallbackEnd.setMinutes(fallbackEnd.getMinutes() + durationMinutes);
        eventEndIso = fallbackEnd.toISOString();
      }
    }
    const link = event.htmlLink;

    if (link) {
      bookingMessage.innerHTML = `Appointment scheduled. <a href="${link}" target="_blank" rel="noopener">Open Google Calendar</a>`;
    } else {
      bookingMessage.textContent = "Appointment scheduled.";
    }

    const displayTime = eventStart.toLocaleString();
    if (!db) {
      setStatus(`Demo call ${currentCallSid}: booking logged for ${displayTime}`);
    } else {
      setStatus(`Call ${currentCallSid}: appointment booked for ${displayTime}`);
    }

    if (!db) {
      recordLocalAction({
        type: "book",
        start: eventStartIso,
        end: eventEndIso,
        customerName: payload.customerName,
        customerPhone: payload.customerPhone,
        notes: payload.notes,
        summary: payload.summary,
        actionItems: payload.actionItems,
        mode: result.mode,
      });
    }

    const bookedLabel = result.mode === "demo" ? "Booked! (demo)" : "Booked!";
    bookButton.textContent = bookedLabel;

    window.setTimeout(() => {
      bookButton.textContent = defaultBookText;
      refreshBookingAvailability();
    }, 1500);

    window.setTimeout(() => {
      closeBookingModal();
      resetBookingForm();
    }, 900);
  } catch (error) {
    console.error("Failed to book appointment", error);
    bookingMessage.textContent = error.message || "Failed to schedule appointment.";
    bookButton.textContent = "Try again";
  } finally {
    bookingInFlight = false;
    bookingSubmitButton.disabled = false;
    bookingCancelButton.disabled = false;
    refreshBookingAvailability();
  }
}

async function createBooking(payload) {
  const trimmedTranscript = payload.transcript ? payload.transcript.slice(-4000) : null;
  const body = {
    callSid: payload.callSid,
    customerName: payload.customerName,
    customerPhone: payload.customerPhone,
    startIso: payload.startIso,
    durationMinutes: payload.durationMinutes,
    notes: payload.notes,
    summary: payload.summary,
    transcript: trimmedTranscript,
    timeZone: payload.timeZone,
    actionItems: payload.actionItems,
  };

  Object.keys(body).forEach((key) => {
    const value = body[key];
    if (value === null || value === "" || (Array.isArray(value) && value.length === 0)) {
      delete body[key];
    }
  });

  if (backendBaseUrl) {
    const response = await fetch(`${backendBaseUrl}/bookings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      let detail = "Failed to schedule appointment.";
      try {
        const errorData = await response.json();
        detail = errorData.detail || errorData.error || detail;
      } catch (parseError) {
        detail = await response.text();
      }
      throw new Error(detail);
    }

    const data = await response.json();

    return { ...data, mode: "backend" };
  }

  const startDate = new Date(payload.startIso);
  const endDate = new Date(startDate.getTime() + payload.durationMinutes * 60000);
  const event = {
    id: null,
    htmlLink: null,
    start: payload.startIso,
    end: endDate.toISOString(),
    summary: payload.summary || "Service appointment",
  };

  if (db) {
    const nowIso = new Date().toISOString();
    const bookingRecord = {
      eventId: null,
      htmlLink: null,
      start: event.start,
      end: event.end,
      createdAt: nowIso,
      customerName: payload.customerName,
      customerPhone: payload.customerPhone,
      notes: payload.notes,
      summary: payload.summary,
      actionItems: payload.actionItems,
    };
    const cleanedBooking = Object.fromEntries(
      Object.entries(bookingRecord).filter(([, value]) =>
        Array.isArray(value) ? value.length : Boolean(value)
      )
    );
    try {
      await db.ref(`calls/${payload.callSid}`).update({
        booking: cleanedBooking,
        bookingUpdatedAt: nowIso,
      });
      const actionRecord = {
        type: "book",
        createdAt: nowIso,
        start: event.start,
        end: event.end,
        customerName: payload.customerName,
        customerPhone: payload.customerPhone,
        notes: payload.notes,
        summary: payload.summary,
        actionItems: payload.actionItems,
        mode: "firebase",
      };
      const cleanedAction = Object.fromEntries(
        Object.entries(actionRecord).filter(([, value]) =>
          Array.isArray(value) ? value.length : Boolean(value)
        )
      );
      await db.ref(`calls/${payload.callSid}/actions`).push(cleanedAction);
    } catch (error) {
      console.error("Failed to record booking in Firebase", error);
    }
    return { callSid: payload.callSid, event, mode: "firebase" };
  }

  await new Promise((resolve) => window.setTimeout(resolve, 900));
  return { callSid: payload.callSid, event, mode: "demo" };
}

bookButton.addEventListener("click", (event) => {
  event.preventDefault();
  if (bookButton.disabled) {
    return;
  }
  openBookingModal();
});

bookingCancelButton.addEventListener("click", () => {
  if (!bookingInFlight) {
    closeBookingModal();
    resetBookingForm();
  }
});

bookingModal.addEventListener("click", (event) => {
  if (event.target === bookingModal && !bookingInFlight) {
    closeBookingModal();
    resetBookingForm();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !bookingInFlight && !bookingModal.classList.contains("hidden")) {
    closeBookingModal();
    resetBookingForm();
  }
});

bookingForm.addEventListener("submit", handleBookingSubmit);

function watchCall(callSid) {
  if (!db) {
    return;
  }

  if (!callSid) {
    setStatus("Waiting for call…");
    currentCallSid = null;
    latestAiCard = null;
    refreshBookingAvailability();
    renderActionLog([]);
    return;
  }

  if (currentCallSid === callSid) {
    return;
  }

  clearListeners();
  closeBookingModal();
  resetBookingForm();

  currentCallSid = callSid;
  latestTranscript = { final: "", partial: "" };
  latestAiCard = null;
  demoBookingUnlocked = false;
  bookingInFlight = false;
  bookButton.textContent = defaultBookText;
  refreshBookingAvailability();
  renderActionLog([]);

  setStatus(`Monitoring call ${callSid}`);

  const callRef = db.ref(`calls/${callSid}`);
  listen(callRef, "value", (snapshot) => {
    const data = snapshot.val();
    if (!data) {
      setStatus(`Call ${callSid} ended.`);
      renderTranscript(null);
      renderAi(null);
      currentCallSid = callSid;
      refreshBookingAvailability();
      return;
    }
    if (data.status) {
      setStatus(`Call ${callSid}: ${data.status}`);
    }
    renderTranscript(data.transcript);
  });

  const aiRef = db.ref(`calls/${callSid}/ai`);
  listen(aiRef, "value", (snapshot) => {
    renderAi(snapshot.val());
  });

  const actionsRef = db.ref(`calls/${callSid}/actions`).limitToLast(50);
  listen(actionsRef, "value", (snapshot) => {
    const data = snapshot.val();
    if (!data) {
      renderActionLog([]);
      return;
    }
    const entries = Object.values(data).filter((item) => item && typeof item === "object");
    renderActionLog(entries);
  });
}

function bootstrap() {
  if (!db) {
    startDemo();
    return;
  }

  const params = new URLSearchParams(window.location.search);
  const pinnedCall = params.get("call");
  if (pinnedCall) {
    watchCall(pinnedCall);
    return;
  }

  const callsRef = db.ref("calls");
  listen(callsRef.limitToLast(1), "child_added", (snapshot) => {
    watchCall(snapshot.key);
  });
}

function scheduleDemo(delay, fn) {
  const id = window.setTimeout(fn, delay);
  demoTimeouts.push(id);
}

function clearDemoTimers() {
  demoTimeouts.forEach((id) => window.clearTimeout(id));
  demoTimeouts = [];
  closeBookingModal();
  resetBookingForm();
}

function startDemo() {
  clearDemoTimers();
  currentCallSid = "DEMO-CALL";
  latestTranscript = { final: "", partial: "" };
  latestAiCard = null;
  bookingInFlight = false;
  demoBookingUnlocked = false;
  bookButton.textContent = defaultBookText;
  refreshBookingAvailability();
  resetLocalActionLog();

  const transcript = { final: "", partial: "" };
  const setPartial = (text) => {
    transcript.partial = text;
    renderTranscript(transcript);
  };
  const addFinal = (text) => {
    transcript.final = transcript.final ? `${transcript.final}\n${text}` : text;
    transcript.partial = "";
    renderTranscript(transcript);
  };

  setStatus("Demo mode: waiting for caller…");
  renderTranscript(null);
  renderAi(null);
  actionsEl.innerHTML = "";

  scheduleDemo(1000, () => {
    setStatus(`Demo call ${currentCallSid}: connected`);
    setPartial("Receptionist: Thank you for calling Redwood HVAC, this is Jamie.");
  });

  scheduleDemo(3500, () => {
    addFinal("Receptionist: Thank you for calling Redwood HVAC, this is Jamie.");
  });

  scheduleDemo(4200, () => {
    setPartial("Caller: Hi Jamie, our air conditioner is rattling and the house is still warm.");
  });

  scheduleDemo(6800, () => {
    addFinal("Caller: Hi Jamie, our air conditioner is rattling and the house is still warm.");
    renderAi({
      summary:
        "Caller reports a noisy AC unit that is no longer cooling; receptionist is gathering service details.",
      sentiment: "neutral",
      urgency: "high",
      action_items: [
        "Confirm service address and system details",
        "Offer earliest diagnostic appointment",
      ],
    });
  });

  scheduleDemo(8200, () => {
    setPartial("Receptionist: I can have a technician there tomorrow at 9 AM—will anyone be home?");
  });

  scheduleDemo(10800, () => {
    addFinal("Receptionist: I can have a technician there tomorrow at 9 AM—will anyone be home?");
  });

  scheduleDemo(11600, () => {
    setPartial("Caller: Yes, I'll be home. Please send me a confirmation text once it's booked.");
  });

  scheduleDemo(14000, () => {
    addFinal("Caller: Yes, I'll be home. Please send me a confirmation text once it's booked.");
    renderAi({
      summary:
        "Technician visit scheduled for tomorrow at 9 AM to inspect the AC issue. Customer expects a confirmation text.",
      sentiment: "positive",
      urgency: "medium",
      action_items: [
        "Book technician for tomorrow 9 AM",
        "Send confirmation text with arrival window",
      ],
    });
    demoBookingUnlocked = true;
    refreshBookingAvailability();
    setStatus(`Demo call ${currentCallSid}: wrap-up`);
  });

  scheduleDemo(16000, () => {
    setStatus(`Demo call ${currentCallSid}: completed`);
  });

  scheduleDemo(25000, () => {
    setStatus("Demo mode: resetting…");
    startDemo();
  });
}

bootstrap();
