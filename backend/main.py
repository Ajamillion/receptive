"""FastAPI service streaming Twilio audio into Picovoice, Gemini, and Firebase."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import time
from array import array
from datetime import datetime, timedelta, timezone
from typing import Dict, Optional

import audioop
import google.generativeai as genai
import httpx
import pvcheetah
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from pydantic import BaseModel, Field, validator

load_dotenv()
logging.basicConfig(level=logging.INFO)
LOGGER = logging.getLogger("gv-ai")


def require(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


CHEETAH_KEY = require("CHEETAH_ACCESS_KEY")
GEMINI_KEY = require("GEMINI_API_KEY")
FIREBASE_URL = require("FIREBASE_RTDB_URL").rstrip("/")
FIREBASE_SECRET = os.getenv("FIREBASE_DB_SECRET")
FREE_GUARD = os.getenv("FREE_TIER_GUARD", "false").lower() == "true"
FREE_MINUTES = float(os.getenv("FREE_TIER_MAX_MINUTES", 5400))
ALLOWED_ORIGINS = [item.strip() for item in os.getenv("ALLOWED_ORIGINS", "*").split(",") if item.strip()] or ["*"]
CALENDAR_ID = os.getenv("CALENDAR_ID")
SERVICE_INFO = os.getenv("GOOGLE_SERVICE_ACCOUNT_INFO")
SERVICE_FILE = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")

HTTP = httpx.AsyncClient(timeout=httpx.Timeout(5.0, connect=5.0))
FIREBASE_PARAMS = {"auth": FIREBASE_SECRET} if FIREBASE_SECRET else None

def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def firebase_patch(path: str, payload: Dict) -> None:
    url = f"{FIREBASE_URL}/{path}.json"
    try:
        response = await HTTP.patch(url, json=payload, params=FIREBASE_PARAMS)
        response.raise_for_status()
    except httpx.HTTPError as exc:
        LOGGER.warning("Firebase PATCH %s failed: %s", path, exc)


async def firebase_post(path: str, payload: Dict[str, object]) -> Optional[str]:
    url = f"{FIREBASE_URL}/{path}.json"
    try:
        response = await HTTP.post(url, json=payload, params=FIREBASE_PARAMS)
        response.raise_for_status()
        data = response.json()
        if isinstance(data, dict):
            return str(data.get("name")) if data.get("name") else None
    except httpx.HTTPError as exc:
        LOGGER.warning("Firebase POST %s failed: %s", path, exc)
    return None


async def log_activity(
    call_sid: str, kind: str, message: str, extra: Optional[Dict[str, object]] = None
) -> None:
    payload: Dict[str, object] = {"type": kind, "message": message, "at": iso_now()}
    if extra:
        payload.update(extra)
    await firebase_post(f"calls/{call_sid}/activity", payload)


genai.configure(api_key=GEMINI_KEY)
MODEL = genai.GenerativeModel("gemini-1.5-flash")
PROMPT = (
    "You are assisting a home-services receptionist. Summarize the call so far and respond with JSON "
    "containing summary, sentiment (positive|neutral|negative), urgency (low|medium|high), and action_items (array)."
)

DEFAULT_CARD = {
    "summary": "AI summary temporarily unavailable.",
    "sentiment": "neutral",
    "urgency": "medium",
    "action_items": [],
}


async def build_ai_card(transcript: str) -> Optional[Dict]:
    text = transcript.strip()
    if not text:
        return None

    def _invoke() -> Dict:
        try:
            response = MODEL.generate_content([PROMPT, text])
        except Exception as exc:  # noqa: BLE001
            LOGGER.error("Gemini request failed: %s", exc)
            return dict(DEFAULT_CARD)

        raw = (response.text or "").strip()
        if raw.startswith("```"):
            lines = raw.splitlines()
            raw = "\n".join(line for line in lines[1:] if not line.startswith("```"))
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            LOGGER.warning("Gemini returned non-JSON payload: %s", raw)
            return {"summary": raw or "Call in progress", "sentiment": "neutral", "urgency": "medium", "action_items": []}

    return await asyncio.to_thread(_invoke)


class CheetahStream:
    def __init__(self) -> None:
        self.engine = pvcheetah.create(access_key=CHEETAH_KEY, enable_automatic_punctuation=True)
        self.frame_bytes = self.engine.frame_length * 2
        self.buffer = bytearray()
        self.state = None

    def process(self, payload: str):
        audio = base64.b64decode(payload)
        linear = audioop.ulaw2lin(audio, 2)
        pcm, self.state = audioop.ratecv(linear, 2, 1, 8000, 16000, self.state)
        self.buffer.extend(pcm)
        while len(self.buffer) >= self.frame_bytes:
            chunk = bytes(self.buffer[: self.frame_bytes])
            del self.buffer[: self.frame_bytes]
            text, endpoint = self.engine.process(array("h", chunk))
            text = text.strip()
            if endpoint:
                flushed = self.engine.flush().strip()
                combined = " ".join(part for part in (text, flushed) if part).strip()
                if combined:
                    yield combined, True
            elif text:
                yield text, False

    def flush(self) -> Optional[str]:
        text = self.engine.flush().strip()
        return text or None

    def close(self) -> None:
        self.engine.delete()


async def push_transcript(session: Dict, status: Optional[str] = None, extra: Optional[Dict] = None) -> None:
    payload: Dict[str, object] = {
        "transcript": {"final": session["final"], "partial": session["partial"], "updatedAt": iso_now()}
    }
    if status:
        payload["status"] = status
    if extra:
        payload.update(extra)
    await firebase_patch(f"calls/{session['call']}", payload)


class BookingRequest(BaseModel):
    call_sid: str = Field(..., alias="callSid")
    customer_name: Optional[str] = Field(None, alias="customerName")
    customer_phone: Optional[str] = Field(None, alias="customerPhone")
    start_iso: datetime = Field(..., alias="startIso")
    duration_minutes: int = Field(60, alias="durationMinutes")
    notes: Optional[str] = Field(None, alias="notes")
    summary: Optional[str] = Field(None, alias="summary")
    transcript: Optional[str] = Field(None, alias="transcript")
    time_zone: Optional[str] = Field(None, alias="timeZone")

    @validator("start_iso", pre=True)
    def _parse_start(cls, value: object) -> object:
        return value.replace("Z", "+00:00") if isinstance(value, str) else value


def load_credentials() -> service_account.Credentials:
    if SERVICE_INFO:
        raw = SERVICE_INFO.strip()
        if not raw.startswith("{"):
            raw = base64.b64decode(raw).decode("utf-8")
        return service_account.Credentials.from_service_account_info(json.loads(raw), scopes=["https://www.googleapis.com/auth/calendar"])
    if SERVICE_FILE and os.path.exists(SERVICE_FILE):
        return service_account.Credentials.from_service_account_file(SERVICE_FILE, scopes=["https://www.googleapis.com/auth/calendar"])
    raise RuntimeError("Service account credentials are not configured")


def _clip(text: Optional[str], limit: int) -> Optional[str]:
    if not text:
        return None
    text = text.strip()
    return text if len(text) <= limit else text[: limit - 1] + "…"


async def create_event(request: BookingRequest) -> Dict:
    if not CALENDAR_ID:
        raise RuntimeError("CALENDAR_ID is not configured")
    start = request.start_iso if request.start_iso.tzinfo else request.start_iso.replace(tzinfo=timezone.utc)
    if request.duration_minutes <= 0:
        raise RuntimeError("durationMinutes must be positive")
    end = start + timedelta(minutes=request.duration_minutes)
    summary_hint = request.summary or "Service appointment"
    summary_hint = f"{request.customer_name} – {summary_hint}" if request.customer_name else summary_hint
    body = {
        "summary": _clip(summary_hint, 120) or "Service appointment",
        "description": None,
        "start": {"dateTime": start.isoformat()},
        "end": {"dateTime": end.isoformat()},
        "extendedProperties": {"private": {"callSid": request.call_sid}},
    }
    if request.time_zone:
        body["start"]["timeZone"] = request.time_zone
        body["end"]["timeZone"] = request.time_zone
    snippet = _clip(request.transcript, 2000)
    parts = [
        _clip(request.notes, 4000),
        f"AI summary: {request.summary}" if request.summary else None,
        f"Transcript excerpt:\n{snippet}" if snippet else None,
        f"Callback: {request.customer_phone}" if request.customer_phone else None,
        f"Call SID: {request.call_sid}",
    ]
    body["description"] = _clip("\n\n".join(filter(None, parts)), 4000)

    def _insert() -> Dict:
        service = build("calendar", "v3", credentials=load_credentials(), cache_discovery=False)
        return service.events().insert(calendarId=CALENDAR_ID, body=body).execute()

    try:
        return await asyncio.to_thread(_insert)
    except HttpError as exc:
        LOGGER.error("Google Calendar error: %s", exc)
        raise RuntimeError(exc.reason or "Google Calendar API error") from exc


app = FastAPI(title="GV AI Co-pilot Backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("shutdown")
async def _shutdown() -> None:
    await HTTP.aclose()


@app.websocket("/audiostream")
async def twilio_stream(websocket: WebSocket) -> None:
    await websocket.accept()
    cheetah = CheetahStream()
    session: Optional[Dict] = None
    try:
        async for message in websocket.iter_text():
            try:
                event = json.loads(message)
            except json.JSONDecodeError:
                continue
            kind = event.get("event")
            if kind == "start":
                info = event.get("start", {})
                stream_sid = info.get("streamSid") or "stream"
                call_sid = info.get("callSid") or stream_sid
                session = {
                    "call": call_sid,
                    "stream": stream_sid,
                    "started": time.time(),
                    "final": "",
                    "partial": "",
                    "card": "",
                    "card_at": 0.0,
                    "card_logged": False,
                }
                await firebase_patch(
                    f"calls/{call_sid}",
                    {"status": "connected", "streamSid": stream_sid, "startedAt": iso_now()},
                )
                await log_activity(call_sid, "call_started", "Call connected")
                continue
            if not session:
                continue
            if FREE_GUARD and (time.time() - session["started"]) / 60.0 > FREE_MINUTES:
                await firebase_patch(f"calls/{session['call']}", {"status": "paused", "notice": "Free tier budget exceeded"})
                await log_activity(session["call"], "guard_paused", "Free tier budget exceeded; stream closed")
                await websocket.close()
                break
            if kind == "media":
                payload = event.get("media", {}).get("payload")
                if not payload:
                    continue
                for text, is_final in cheetah.process(payload):
                    if is_final:
                        session["final"] = f"{session['final']} {text}".strip() if session["final"] else text
                        session["partial"] = ""
                    else:
                        session["partial"] = text
                    await push_transcript(session, "listening")
                    combined = f"{session['final']} {session['partial']}".strip()
                    if combined and combined != session["card"] and time.time() - session["card_at"] >= 1.0:
                        card = await build_ai_card(combined)
                        if card:
                            await firebase_patch(f"calls/{session['call']}/ai", card)
                            session["card"] = combined
                            session["card_at"] = time.time()
                            if not session["card_logged"] and card.get("summary"):
                                await log_activity(
                                    session["call"],
                                    "ai_summary",
                                    card.get("summary", "AI update"),
                                    {"details": f"Sentiment {card.get('sentiment', 'neutral')} · Urgency {card.get('urgency', 'medium')}"},
                                )
                                session["card_logged"] = True
                continue
            if kind == "stop":
                if session["partial"]:
                    session["final"] = f"{session['final']} {session['partial']}".strip()
                    session["partial"] = ""
                remaining = cheetah.flush()
                if remaining:
                    session["final"] = f"{session['final']} {remaining}".strip()
                await push_transcript(session, "completed", {"endedAt": iso_now()})
                final_text = session["final"].strip()
                if final_text and (final_text != session["card"] or not session["card_logged"]):
                    card = await build_ai_card(final_text)
                    if card:
                        await firebase_patch(f"calls/{session['call']}/ai", card)
                        session["card"] = final_text
                        session["card_at"] = time.time()
                        if not session["card_logged"] and card.get("summary"):
                            await log_activity(
                                session["call"],
                                "ai_summary",
                                card.get("summary", "AI update"),
                                {
                                    "details": f"Sentiment {card.get('sentiment', 'neutral')} · Urgency {card.get('urgency', 'medium')}",
                                },
                            )
                            session["card_logged"] = True
                duration = max(0, time.time() - session["started"])
                await log_activity(
                    session["call"],
                    "call_completed",
                    "Call ended",
                    {"details": f"Duration {duration/60:.1f} min"},
                )
                break
    except WebSocketDisconnect:
        LOGGER.info("WebSocket disconnected")
    finally:
        cheetah.close()


@app.post("/bookings")
async def create_booking(request: BookingRequest) -> Dict:
    if not CALENDAR_ID:
        await log_activity(request.call_sid, "booking_failed", "Calendar integration is not configured")
        raise HTTPException(status_code=503, detail="Calendar integration is not configured")
    if request.duration_minutes <= 0:
        raise HTTPException(status_code=400, detail="durationMinutes must be positive")
    try:
        event = await create_event(request)
    except RuntimeError as exc:
        await log_activity(request.call_sid, "booking_failed", str(exc))
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    start_dt = request.start_iso if request.start_iso.tzinfo else request.start_iso.replace(tzinfo=timezone.utc)
    end_dt = start_dt + timedelta(minutes=request.duration_minutes)
    start = event.get("start", {}).get("dateTime") or start_dt.isoformat()
    end = event.get("end", {}).get("dateTime") or end_dt.isoformat()
    booking = {
        "eventId": event.get("id"),
        "htmlLink": event.get("htmlLink"),
        "start": start,
        "end": end,
        "summary": event.get("summary") or request.summary,
        "customerName": request.customer_name,
        "customerPhone": request.customer_phone,
        "notes": request.notes,
        "createdAt": iso_now(),
    }
    await firebase_patch(f"calls/{request.call_sid}", {"booking": {k: v for k, v in booking.items() if v}})
    await log_activity(
        request.call_sid,
        "booking_created",
        f"Booked {(booking.get('summary') or 'appointment').strip()}",
        {
            "details": f"Start {start}",
            "data": {"start": start, "end": end, "eventId": booking.get("eventId")},
        },
    )
    return {
        "callSid": request.call_sid,
        "event": {"id": event.get("id"), "htmlLink": event.get("htmlLink"), "start": start, "end": end},
    }


@app.get("/healthz")
async def healthcheck() -> JSONResponse:
    return JSONResponse({"ok": True})
