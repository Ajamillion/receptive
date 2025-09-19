const config = window.FIREBASE_CONFIG || {};
if (!config.databaseURL) {
  console.warn("Firebase config missing; the dashboard will run in demo mode.");
}

firebase.initializeApp(config);
const db = firebase.database();

const statusEl = document.getElementById("call-status");
const transcriptEl = document.getElementById("transcript-text");
const summaryEl = document.getElementById("ai-summary");
const actionsEl = document.getElementById("ai-actions");
const bookButton = document.getElementById("book-button");

let currentCallSid = null;
let detachListeners = [];

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

bootstrap();
