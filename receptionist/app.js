const config = window.FIREBASE_CONFIG || {};
const backendBaseUrl = (window.BACKEND_BASE_URL || "").replace(/\/$/, "");
const hasFirebaseConfig = Boolean(config.apiKey && config.databaseURL);

if (hasFirebaseConfig) {
  firebase.initializeApp(config);
}

const db = hasFirebaseConfig ? firebase.database() : null;
const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || null;

const statusEl = document.getElementById("call-status");
const callMetaEl = document.getElementById("call-meta");
const callCallerEl = document.getElementById("call-caller");
const callForwardedEl = document.getElementById("call-forwarded");
const callLocationEl = document.getElementById("call-location");
const callNotesEl = document.getElementById("call-notes");
const callIdentifierEl = document.getElementById("call-identifier");
const transcriptEl = document.getElementById("transcript");
const summaryEl = document.getElementById("ai-summary");
const actionsEl = document.getElementById("ai-actions");
const callListEl = document.getElementById("call-list");
const activityListEl = document.getElementById("activity-list");
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
const followLatestButton = document.getElementById("follow-latest");

const state = {
  callId: null,
  transcript: { final: "", partial: "" },
  ai: null,
  booking: null,
  metadata: null,
  activity: [],
  bookingInFlight: false,
  callUnsub: null,
  followUnsub: null,
  demoTimers: [],
  demoMode: !hasFirebaseConfig,
  callsData: {},
  callSummaries: [],
  latestCallId: null,
  followMode: hasFirebaseConfig ? "latest" : "manual",
};

function setStatus(text, notice) {
  const base = text || "Connected";
  const cleanNotice =
    typeof notice === "string" && notice.trim() ? notice.trim() : null;
  statusEl.textContent = cleanNotice ? `${base} — ${cleanNotice}` : base;
  statusEl.dataset.tone = cleanNotice ? "notice" : "";
  statusEl.title = cleanNotice || "";
}

function setBookingStatus(message, tone = "info") {
  bookingStatusEl.textContent = message || "";
  bookingStatusEl.dataset.tone = message ? tone : "";
}

function formatCallIdentifier(value) {
  if (!value) return "";
  const text = String(value);
  if (text.length <= 12) return text;
  return `${text.slice(0, 6)}…${text.slice(-4)}`;
}

function cleanMetaValue(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function formatCallerDisplay(metadata) {
  if (!metadata || typeof metadata !== "object") {
    return "—";
  }
  const name = cleanMetaValue(metadata.callerName);
  const number = cleanMetaValue(metadata.callerNumber);
  if (name && number) {
    return `${name} (${number})`;
  }
  if (name) {
    return name;
  }
  if (number) {
    return number;
  }
  return "Unknown caller";
}

function setOptionalMetaLine(element, label, value) {
  if (!element) return;
  const clean = cleanMetaValue(value);
  if (!clean) {
    element.hidden = true;
    element.textContent = "";
    return;
  }
  element.hidden = false;
  element.textContent = `${label}: ${clean}`;
}

function renderCallDetails(metadata) {
  state.metadata = metadata && typeof metadata === "object" ? metadata : null;
  const active = Boolean(state.callId);
  if (callMetaEl) {
    callMetaEl.hidden = !active;
  }
  if (!active) {
    if (callCallerEl) callCallerEl.textContent = "Caller: —";
    if (callForwardedEl) callForwardedEl.textContent = "Forwarded to: —";
    if (callIdentifierEl) {
      callIdentifierEl.hidden = true;
      callIdentifierEl.textContent = "";
    }
    if (callLocationEl) {
      callLocationEl.hidden = true;
      callLocationEl.textContent = "";
    }
    if (callNotesEl) {
      callNotesEl.hidden = true;
      callNotesEl.textContent = "";
    }
    return;
  }

  const callerDisplay = formatCallerDisplay(state.metadata);
  if (callCallerEl) {
    callCallerEl.textContent = `Caller: ${callerDisplay}`;
  }
  if (callForwardedEl) {
    const forwarded = cleanMetaValue(state.metadata?.forwardedTo);
    callForwardedEl.textContent = `Forwarded to: ${forwarded || "—"}`;
  }
  setOptionalMetaLine(callLocationEl, "Location", state.metadata?.location || null);
  setOptionalMetaLine(callNotesEl, "Notes", state.metadata?.notes || null);
  if (callIdentifierEl) {
    if (state.callId) {
      callIdentifierEl.hidden = false;
      callIdentifierEl.textContent = `Call ID: ${formatCallIdentifier(state.callId)}`;
    } else {
      callIdentifierEl.hidden = true;
      callIdentifierEl.textContent = "";
    }
  }
}

function updateBookButton() {
  const ready = Boolean(state.callId) && !state.bookingInFlight;
  bookButton.disabled = !ready;
}

function updateFollowButton() {
  if (!followLatestButton) {
    return;
  }

  if (!hasFirebaseConfig || state.demoMode) {
    followLatestButton.disabled = true;
    followLatestButton.textContent = "Follow live call";
    return;
  }

  if (state.followMode === "latest") {
    followLatestButton.disabled = true;
    followLatestButton.textContent = "Following live call";
  } else {
    followLatestButton.disabled = !state.latestCallId;
    followLatestButton.textContent = "Follow live call";
  }
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

function formatDurationSeconds(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "";
  }
  if (seconds < 90) {
    return `${Math.max(1, Math.round(seconds))} sec`;
  }
  const minutes = seconds / 60;
  if (minutes < 90) {
    const value = minutes < 10 ? Math.round(minutes * 10) / 10 : Math.round(minutes);
    return `${value} min`;
  }
  const hours = minutes / 60;
  const value = hours < 10 ? Math.round(hours * 10) / 10 : Math.round(hours);
  const suffix = Math.abs(value - 1) < 0.01 ? "hr" : "hrs";
  return `${value} ${suffix}`;
}

function buildCallSummary(id, call) {
  const data = call && typeof call === "object" ? call : {};
  const metadata = data.metadata && typeof data.metadata === "object" ? data.metadata : {};
  const callerDisplay = formatCallerDisplay(metadata);
  const caller = callerDisplay === "—" ? "Unknown caller" : callerDisplay;
  const startedAt = typeof data.startedAt === "string" ? data.startedAt : typeof data.connectedAt === "string"
    ? data.connectedAt
    : typeof data.createdAt === "string"
    ? data.createdAt
    : null;
  const endedAt = typeof data.endedAt === "string" ? data.endedAt : null;
  const updatedAt = typeof data.updatedAt === "string" ? data.updatedAt : null;
  const rawStatus = typeof data.status === "string" && data.status.trim() ? data.status : endedAt ? "completed" : "";
  const statusKey = rawStatus || (endedAt ? "completed" : "");
  const statusLabel = formatStatus(statusKey);
  const normalizedStatus = statusKey.toLowerCase();
  let statusTone = "";
  if (normalizedStatus === "completed") {
    statusTone = "success";
  } else if (normalizedStatus === "paused" || normalizedStatus === "guard_paused") {
    statusTone = "danger";
  } else if (normalizedStatus === "listening" || normalizedStatus === "connected" || (!normalizedStatus && !endedAt)) {
    statusTone = "live";
  }

  const startDate = parseDate(startedAt);
  const endDate = parseDate(endedAt);
  const updatedDate = parseDate(updatedAt);
  const referenceDate = endDate || startDate || updatedDate;

  let durationLabel = "";
  if (startDate) {
    const compareDate = endDate || new Date();
    const seconds = (compareDate.getTime() - startDate.getTime()) / 1000;
    durationLabel = formatDurationSeconds(seconds);
  }

  const metaParts = [];
  if (statusLabel) {
    metaParts.push(statusLabel);
  }
  if (durationLabel) {
    metaParts.push(durationLabel);
  }
  let metaLabel = metaParts.join(" · ");

  let timeLabel = "";
  const timeSource = endedAt || startedAt || updatedAt;
  if (timeSource) {
    const timeText = formatActivityTime(timeSource);
    if (timeText) {
      const prefix = endedAt ? "Ended" : startedAt ? "Started" : "Updated";
      timeLabel = `${prefix} ${timeText}`;
    }
  }

  if (!metaLabel && timeLabel) {
    metaLabel = timeLabel;
    timeLabel = "";
  }

  return {
    id,
    caller,
    statusLabel,
    statusTone,
    metaLabel,
    timeLabel,
    sortKey: referenceDate ? referenceDate.getTime() : 0,
  };
}

function summarizeCalls(data) {
  if (!data || typeof data !== "object") {
    return [];
  }
  const entries = Object.entries(data)
    .filter(([, value]) => value && typeof value === "object")
    .map(([id, value]) => buildCallSummary(id, value));
  return entries.sort((a, b) => b.sortKey - a.sortKey).slice(0, 20);
}

function renderCallList(entries) {
  if (!callListEl) {
    return;
  }

  callListEl.innerHTML = "";
  const list = Array.isArray(entries) ? entries : [];
  state.callSummaries = list.map((entry) => ({
    id: entry.id,
    caller: entry.caller || "Unknown caller",
    statusLabel: entry.statusLabel || "",
    statusTone: entry.statusTone || "",
    metaLabel: entry.metaLabel || "",
    timeLabel: entry.timeLabel || "",
    sortKey: entry.sortKey || 0,
  }));

  if (!state.callSummaries.length) {
    const placeholder = document.createElement("li");
    placeholder.className = "placeholder";
    placeholder.textContent = "Waiting for calls…";
    callListEl.appendChild(placeholder);
    return;
  }

  state.callSummaries.forEach((entry) => {
    const item = document.createElement("li");
    item.className = "call-item";
    item.dataset.active = entry.id === state.callId ? "true" : "false";

    const button = document.createElement("button");
    button.type = "button";
    button.dataset.callId = entry.id;

    const header = document.createElement("div");
    header.className = "call-item-header";

    const name = document.createElement("span");
    name.className = "call-item-name";
    name.textContent = entry.caller || "Unknown caller";
    header.appendChild(name);

    if (entry.statusLabel) {
      const status = document.createElement("span");
      status.className = "call-item-status";
      if (entry.statusTone) {
        status.dataset.tone = entry.statusTone;
      }
      status.textContent = entry.statusLabel;
      header.appendChild(status);
    }

    button.appendChild(header);

    if (entry.metaLabel) {
      const meta = document.createElement("span");
      meta.className = "call-item-meta";
      meta.textContent = entry.metaLabel;
      button.appendChild(meta);
    }

    if (entry.timeLabel) {
      const time = document.createElement("span");
      time.className = "call-item-time";
      time.textContent = entry.timeLabel;
      button.appendChild(time);
    }

    item.appendChild(button);
    callListEl.appendChild(item);
  });
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

function formatActivityTime(value) {
  const date = parseDate(value);
  if (!date) return "";
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const options = sameDay
    ? { hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
  return date.toLocaleString([], options);
}

function renderActivity(activity) {
  state.activity = [];
  activityListEl.innerHTML = "";

  if (!activity || typeof activity !== "object") {
    const placeholder = document.createElement("li");
    placeholder.className = "placeholder";
    placeholder.textContent = "No activity yet.";
    activityListEl.appendChild(placeholder);
    activityListEl.classList.add("is-empty");
    return;
  }

  const entries = Object.values(activity)
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => {
      const rawAt = entry.at || entry.timestamp || null;
      const at = rawAt && typeof rawAt !== "string" ? String(rawAt) : rawAt;
      const messageValue = entry.message;
      const detailsValue = entry.details;
      return {
        type: entry.type || "note",
        message:
          typeof messageValue === "string"
            ? messageValue
            : messageValue != null
            ? String(messageValue)
            : "Update",
        at,
        details:
          typeof detailsValue === "string"
            ? detailsValue
            : detailsValue != null
            ? String(detailsValue)
            : null,
      };
    })
    .sort((a, b) => {
      const aTime = parseDate(a.at)?.getTime() ?? 0;
      const bTime = parseDate(b.at)?.getTime() ?? 0;
      return aTime - bTime;
    });

  if (!entries.length) {
    const placeholder = document.createElement("li");
    placeholder.className = "placeholder";
    placeholder.textContent = "No activity yet.";
    activityListEl.appendChild(placeholder);
    activityListEl.classList.add("is-empty");
    return;
  }

  activityListEl.classList.remove("is-empty");
  entries.forEach((entry) => {
    const item = document.createElement("li");
    item.className = "activity-item";
    item.dataset.type = entry.type;

    const header = document.createElement("div");
    header.className = "activity-header";

    const message = document.createElement("span");
    message.className = "activity-message";
    message.textContent = entry.message;
    header.appendChild(message);

    const label = formatActivityTime(entry.at);
    if (label) {
      const timeEl = document.createElement("time");
      timeEl.className = "activity-time";
      timeEl.dateTime = entry.at || "";
      timeEl.textContent = label;
      header.appendChild(timeEl);
    }

    item.appendChild(header);

    if (entry.details) {
      const details = document.createElement("p");
      details.className = "activity-details";
      details.textContent = entry.details;
      item.appendChild(details);
    }

    activityListEl.appendChild(item);
  });

  state.activity = entries;
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
  state.metadata = null;
  renderCallList(state.callSummaries);
  setStatus("Connecting…");
  setBookingStatus("");
  renderTranscript(null);
  renderAi(null);
  renderActivity(null);
  renderBooking(null);
  renderCallDetails(null);
  updateBookButton();
  updateFollowButton();

  const ref = db.ref(`calls/${callSid}`);
  const handler = (snapshot) => {
    const data = snapshot.val() || {};
    setStatus(formatStatus(data.status), data.notice);
    renderTranscript(data.transcript || null);
    renderAi(data.ai || null);
    renderActivity(data.activity || null);
    renderBooking(data.booking || null);
    renderCallDetails(data.metadata || null);
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
    state.callsData = calls && typeof calls === "object" ? calls : {};
    const summaries = summarizeCalls(state.callsData);
    state.latestCallId = summaries.length ? summaries[0].id : null;
    renderCallList(summaries);

    if (state.followMode === "latest") {
      if (state.latestCallId && state.latestCallId !== state.callId) {
        attachCall(state.latestCallId);
      } else if (!state.latestCallId) {
        detachCallListener();
        state.callId = null;
        state.metadata = null;
        renderCallDetails(null);
        renderTranscript(null);
        renderAi(null);
        renderActivity(null);
        renderBooking(null);
        setBookingStatus("");
        setStatus("Waiting for a call…");
        updateBookButton();
      }
    }
    updateFollowButton();
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
  const metadata = state.metadata || {};
  bookingNameInput.value = state.booking?.customerName || metadata.callerName || "";
  bookingPhoneInput.value = state.booking?.customerPhone || metadata.callerNumber || "";
  bookingNotesInput.value = state.booking?.notes || metadata.notes || "";
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
  state.followMode = "manual";
  updateBookButton();
  const now = new Date();
  const start = new Date(now.getTime() - 5 * 60 * 1000);
  const demoMetadata = {
    callerName: "Jamie Patel",
    callerNumber: "+1 555 010 2000",
    forwardedTo: "+1 555 777 1988",
    location: "Seattle, WA",
    notes: "Demo: water heater not working",
  };
  state.callsData = {
    "demo-call": {
      metadata: demoMetadata,
      status: "completed",
      startedAt: start.toISOString(),
      endedAt: now.toISOString(),
    },
  };
  state.latestCallId = "demo-call";
  renderCallList(summarizeCalls(state.callsData));
  updateFollowButton();
  setStatus("Demo call connected");
  setBookingStatus("Demo mode: add Firebase config to go live.", "info");
  renderTranscript({ final: "", partial: "" });
  renderAi(null);
  renderCallDetails(demoMetadata);
  renderActivity(null);

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
  const demoActivity = {};

  const addDemoActivity = (entry) => {
    const key = `demo-${Object.keys(demoActivity).length}`;
    demoActivity[key] = entry;
    renderActivity(demoActivity);
  };

  addDemoActivity({
    type: "call_started",
    message: "Call connected",
    at: new Date().toISOString(),
  });

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
      addDemoActivity({
        type: "booking_created",
        message: "Booked demo appointment",
        details: formatDateRange(start.toISOString(), end.toISOString()),
        at: new Date().toISOString(),
      });
      addDemoActivity({
        type: "call_completed",
        message: "Call ended",
        details: "Duration 5.0 min",
        at: new Date(Date.now() + 1000).toISOString(),
      });
      return;
    }

    finalLines.push(transcriptSteps[step]);
    renderTranscript({ final: finalLines.join("\n"), partial: "" });
    const cardIndex = step < 3 ? 0 : 1;
    renderAi(aiCards[cardIndex]);

    if (step === 2) {
      addDemoActivity({
        type: "ai_summary",
        message: aiCards[0].summary,
        details: "Sentiment neutral · Urgency high",
        at: new Date(Date.now() + 500).toISOString(),
      });
    }

    const timer = setTimeout(() => advance(step + 1), 2000);
    state.demoTimers.push(timer);
  }

  advance(0);
}

bookButton.addEventListener("click", openBookingDialog);
bookingCancelButton.addEventListener("click", () => bookingDialog.close());
bookingForm.addEventListener("submit", submitBooking);
window.addEventListener("beforeunload", clearDemoTimers);

if (callListEl) {
  callListEl.addEventListener("click", (event) => {
    const target = event.target.closest("button[data-call-id]");
    if (!target) {
      return;
    }
    const callSid = target.dataset.callId;
    if (!callSid) {
      return;
    }
    if (hasFirebaseConfig) {
      state.followMode = "manual";
    }
    if (callSid !== state.callId) {
      attachCall(callSid);
    } else {
      renderCallList(state.callSummaries);
    }
    updateFollowButton();
  });
}

if (followLatestButton) {
  followLatestButton.addEventListener("click", () => {
    if (!hasFirebaseConfig || state.followMode === "latest") {
      return;
    }
    state.followMode = "latest";
    updateFollowButton();
    if (state.latestCallId) {
      attachCall(state.latestCallId);
    }
  });
}

renderCallDetails(null);
updateBookButton();
updateFollowButton();

if (hasFirebaseConfig) {
  const params = new URLSearchParams(window.location.search);
  const callParam = params.get("call");
  if (callParam) {
    state.followMode = "manual";
    attachCall(callParam);
  } else {
    state.followMode = "latest";
    followLatestCall();
  }
} else {
  console.warn("Firebase config missing; running in demo mode.");
  runDemo();
}
