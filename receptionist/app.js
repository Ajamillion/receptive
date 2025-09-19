const config = window.FIREBASE_CONFIG || {};
const hasFirebaseConfig = Boolean(config.apiKey && config.databaseURL);

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
const bookButton = document.getElementById("book-button");

let currentCallSid = null;
let detachListeners = [];
let demoTimeouts = [];

function setStatus(text) {
  statusEl.textContent = text;
}

function renderTranscript(transcript) {
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
  if (!card || !card.summary) {
    summaryEl.innerHTML = "<p class=\"placeholder\">Listening…</p>";
    actionsEl.innerHTML = "";
    bookButton.disabled = true;
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

  bookButton.disabled = false;
}

function clearListeners() {
  detachListeners.forEach((off) => off());
  detachListeners = [];
}

function listen(ref, event, handler) {
  ref.on(event, handler);
  detachListeners.push(() => ref.off(event, handler));
}

function watchCall(callSid) {
  if (!db) {
    return;
  }

  if (!callSid) {
    setStatus("Waiting for call…");
    return;
  }

  if (currentCallSid === callSid) {
    return;
  }

  clearListeners();
  currentCallSid = callSid;
  setStatus(`Monitoring call ${callSid}`);

  const callRef = db.ref(`calls/${callSid}`);
  listen(callRef, "value", (snapshot) => {
    const data = snapshot.val();
    if (!data) {
      setStatus(`Call ${callSid} ended.`);
      renderTranscript(null);
      renderAi(null);
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

  bookButton.disabled = true;
  bookButton.textContent = "Book appointment";
  bookButton.onclick = async () => {
    if (!currentCallSid) {
      return;
    }
    bookButton.disabled = true;
    bookButton.textContent = "Booking…";
    try {
      await db.ref(`calls/${currentCallSid}/actions`).push({
        type: "book",
        createdAt: new Date().toISOString(),
      });
      bookButton.textContent = "Booked!";
      setTimeout(() => {
        bookButton.textContent = "Book appointment";
        bookButton.disabled = false;
      }, 1200);
    } catch (error) {
      console.error("Failed to log booking", error);
      bookButton.textContent = "Try again";
      bookButton.disabled = false;
    }
  };
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
}

function enableDemoBooking(callSid) {
  const defaultText = "Book appointment";
  bookButton.disabled = false;
  bookButton.textContent = defaultText;
  bookButton.onclick = () => {
    bookButton.disabled = true;
    bookButton.textContent = "Booking…";
    console.info(`[demo] Logging booking for ${callSid}`);
    window.setTimeout(() => {
      bookButton.textContent = "Booked! (demo)";
      setStatus(`Demo call ${callSid}: booking logged`);
      window.setTimeout(() => {
        bookButton.textContent = defaultText;
        bookButton.disabled = false;
      }, 1500);
    }, 900);
  };
}

function startDemo() {
  clearDemoTimers();
  const callSid = "DEMO-CALL";
  currentCallSid = callSid;

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
  bookButton.disabled = true;
  bookButton.textContent = "Book appointment";
  bookButton.onclick = null;

  scheduleDemo(1000, () => {
    setStatus(`Demo call ${callSid}: connected`);
    setPartial("Receptionist: Thank you for calling Redwood HVAC, this is Jamie.");
  });

  scheduleDemo(3500, () => {
    addFinal("Receptionist: Thank you for calling Redwood HVAC, this is Jamie.");
  });

  scheduleDemo(4200, () => {
    setPartial(
      "Caller: Hi Jamie, our air conditioner is rattling and the house is still warm."
    );
  });

  scheduleDemo(6800, () => {
    addFinal(
      "Caller: Hi Jamie, our air conditioner is rattling and the house is still warm."
    );
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
    setPartial(
      "Receptionist: I can have a technician there tomorrow at 9 AM—will anyone be home?"
    );
  });

  scheduleDemo(10800, () => {
    addFinal(
      "Receptionist: I can have a technician there tomorrow at 9 AM—will anyone be home?"
    );
  });

  scheduleDemo(11600, () => {
    setPartial(
      "Caller: Yes, I'll be home. Please send me a confirmation text once it's booked."
    );
  });

  scheduleDemo(14000, () => {
    addFinal(
      "Caller: Yes, I'll be home. Please send me a confirmation text once it's booked."
    );
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
    setStatus(`Demo call ${callSid}: wrap-up`);
    enableDemoBooking(callSid);
  });

  scheduleDemo(16000, () => {
    setStatus(`Demo call ${callSid}: completed`);
  });

  scheduleDemo(25000, () => {
    setStatus("Demo mode: resetting…");
    startDemo();
  });
}

bootstrap();
