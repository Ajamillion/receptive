"""FastAPI service that receives live Twilio audio and drives the AI co-pilot stack."""

from __future__ import annotations
import asyncio
import base64
import json
import logging
import os
import time
from array import array
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Dict, Iterable, Optional, Tuple

import audioop
import google.generativeai as genai
import httpx
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

import pvcheetah
from dotenv import load_dotenv
from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from pydantic import BaseModel, Field, validator

LOGGER = logging.getLogger("backend")

load_dotenv()

CHEETAH_ACCESS_KEY = os.getenv("CHEETAH_ACCESS_KEY")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
FIREBASE_RTDB_URL = os.getenv("FIREBASE_RTDB_URL", "").rstrip("/")
FIREBASE_DB_SECRET = os.getenv("FIREBASE_DB_SECRET")
FREE_TIER_GUARD = os.getenv("FREE_TIER_GUARD", "false").lower() == "true"
MAX_CALL_MINUTES = float(os.getenv("FREE_TIER_MAX_MINUTES", 90.0 * 60.0))
CALENDAR_ID = os.getenv("CALENDAR_ID")
SERVICE_ACCOUNT_INFO = os.getenv("GOOGLE_SERVICE_ACCOUNT_INFO")
SERVICE_ACCOUNT_FILE = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
ALLOWED_ORIGINS = [
    origin.strip() for origin in os.getenv("ALLOWED_ORIGINS", "*").split(",") if origin.strip()
]
if not ALLOWED_ORIGINS:
    ALLOWED_ORIGINS = ["*"]

for key, value in (
    ("CHEETAH_ACCESS_KEY", CHEETAH_ACCESS_KEY),
    ("GEMINI_API_KEY", GEMINI_API_KEY),
    ("FIREBASE_RTDB_URL", FIREBASE_RTDB_URL),
):
    if not value:
        raise RuntimeError(f"{key} is required")

genai.configure(api_key=GEMINI_API_KEY)

app = FastAPI(title="GV AI Co-pilot Backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

GEMINI_PROMPT = (
    "You are an AI assistant listening to phone calls between a customer and a home-services receptionist. "
    "Summarize the call so far. Return a JSON object with the keys summary, sentiment (one of positive, neutral, negative), "
    "urgency (low, medium, high), and action_items (array of short bullet items). The JSON must not include code fences or "
    "commentary."
)


class FirebaseClient:
    def __init__(self, base_url: str, auth_secret: Optional[str] = None) -> None:
        self._base = base_url
        self._params = {"auth": auth_secret} if auth_secret else None
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(5.0, connect=5.0))

    async def patch(self, path: str, payload: Dict) -> None:
        url = f"{self._base}/{path}.json"
        try:
            response = await self._client.patch(url, json=payload, params=self._params)
            response.raise_for_status()
        except httpx.HTTPError as exc:
            LOGGER.error("Firebase PATCH %s failed: %s", path, exc)

    async def post(self, path: str, payload: Dict) -> Optional[str]:
        url = f"{self._base}/{path}.json"
        try:
            response = await self._client.post(url, json=payload, params=self._params)
            response.raise_for_status()
            data = response.json()
            if isinstance(data, dict):
                return data.get("name")
        except httpx.HTTPError as exc:
            LOGGER.error("Firebase POST %s failed: %s", path, exc)
        return None

    async def close(self) -> None:
        await self._client.aclose()


GEMINI_MODEL = genai.GenerativeModel("gemini-1.5-flash")

CALENDAR_SCOPES = ["https://www.googleapis.com/auth/calendar"]
MAX_EVENT_SUMMARY = 120
MAX_EVENT_DESCRIPTION = 7000
MAX_TRANSCRIPT_SNIPPET = 2000


def _clip(text: Optional[str], limit: int) -> Optional[str]:
    if not text:
        return None
    cleaned = text.strip()
    if len(cleaned) <= limit:
        return cleaned
    return f"{cleaned[: limit - 1]}…"


def _compact(data: Dict[str, object]) -> Dict[str, object]:
    return {key: value for key, value in data.items() if value not in (None, "")}


def _load_calendar_credentials() -> service_account.Credentials:
    if SERVICE_ACCOUNT_INFO:
        raw = SERVICE_ACCOUNT_INFO.strip()
        if not raw.startswith("{"):
            try:
                raw = base64.b64decode(raw).decode("utf-8")
            except Exception as exc:  # noqa: BLE001
                raise RuntimeError("GOOGLE_SERVICE_ACCOUNT_INFO must be JSON or base64-encoded JSON") from exc
        try:
            info = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise RuntimeError("Invalid GOOGLE_SERVICE_ACCOUNT_INFO JSON") from exc
        return service_account.Credentials.from_service_account_info(info, scopes=CALENDAR_SCOPES)

    if SERVICE_ACCOUNT_FILE and os.path.exists(SERVICE_ACCOUNT_FILE):
        return service_account.Credentials.from_service_account_file(
            SERVICE_ACCOUNT_FILE, scopes=CALENDAR_SCOPES
        )

    raise RuntimeError(
        "Service account credentials not configured. Set GOOGLE_SERVICE_ACCOUNT_INFO or GOOGLE_APPLICATION_CREDENTIALS."
    )


class BookingRequest(BaseModel):
    call_sid: str = Field(..., alias="callSid")
    customer_name: Optional[str] = Field(None, alias="customerName")
    customer_phone: Optional[str] = Field(None, alias="customerPhone")
    start: datetime = Field(..., alias="startIso")
    duration_minutes: int = Field(60, alias="durationMinutes")
    notes: Optional[str] = Field(None, alias="notes")
    summary: Optional[str] = Field(None, alias="summary")
    transcript: Optional[str] = Field(None, alias="transcript")
    time_zone: Optional[str] = Field(None, alias="timeZone")
    action_items: Optional[Iterable[str]] = Field(None, alias="actionItems")

    @validator("start", pre=True)
    def _parse_start(cls, value: object) -> object:
        if isinstance(value, str):
            return value.replace("Z", "+00:00")
        return value

    @validator("duration_minutes")
    def _validate_duration(cls, value: int) -> int:
        if value <= 0:
            raise ValueError("durationMinutes must be positive")
        return value

    @property
    def start_at(self) -> datetime:
        dt = self.start
        if dt.tzinfo is None:
            return dt.replace(tzinfo=timezone.utc)
        return dt

    @property
    def end_at(self) -> datetime:
        return self.start_at + timedelta(minutes=self.duration_minutes)


async def create_calendar_event(request: BookingRequest) -> Dict:
    if not CALENDAR_ID:
        raise RuntimeError("CALENDAR_ID is not configured")

    summary_hint = request.summary or "Service appointment"
    if request.customer_name:
        summary_hint = f"{request.customer_name} – {summary_hint}"
    summary = _clip(summary_hint, MAX_EVENT_SUMMARY) or "Service appointment"

    description_parts = []
    notes = _clip(request.notes, MAX_EVENT_DESCRIPTION)
    if notes:
        description_parts.append(notes)

    if request.summary and request.summary != notes:
        description_parts.append(f"AI summary: {request.summary}")

    if request.action_items:
        items = [f"- {item}" for item in request.action_items if item]
        if items:
            description_parts.append("Action items:\n" + "\n".join(items))

    transcript_snippet = _clip(request.transcript, MAX_TRANSCRIPT_SNIPPET)
    if transcript_snippet:
        description_parts.append(f"Transcript excerpt:\n{transcript_snippet}")

    description_parts.append(f"Call SID: {request.call_sid}")
    if request.customer_phone:
        description_parts.append(f"Callback: {request.customer_phone}")

    description = _clip("\n\n".join(description_parts), MAX_EVENT_DESCRIPTION)

    start_dt = request.start_at
    end_dt = request.end_at

    body = {
        "summary": summary,
        "description": description,
        "start": {"dateTime": start_dt.isoformat()},
        "end": {"dateTime": end_dt.isoformat()},
        "extendedProperties": {"private": {"callSid": request.call_sid}},
    }

    if request.time_zone:
        body["start"]["timeZone"] = request.time_zone
        body["end"]["timeZone"] = request.time_zone

    def _insert_event() -> Dict:
        credentials = _load_calendar_credentials()
        service = build("calendar", "v3", credentials=credentials, cache_discovery=False)
        return service.events().insert(calendarId=CALENDAR_ID, body=body).execute()

    try:
        return await asyncio.to_thread(_insert_event)
    except HttpError as exc:
        LOGGER.error("Google Calendar API error: %s", exc)
        raise RuntimeError(exc.reason or "Google Calendar API error") from exc


async def build_ai_card(transcript: str) -> Optional[Dict]:
    text = transcript.strip()
    if not text:
        return None

    loop = asyncio.get_running_loop()
    response = await loop.run_in_executor(
        None, lambda: GEMINI_MODEL.generate_content([GEMINI_PROMPT, transcript])
    )
    text = response.text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[-1]
        if text.endswith("```"):
            text = text.rsplit("\n", 1)[0]

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        LOGGER.warning("Gemini returned non-JSON payload: %s", text)
        return {
            "summary": text,
            "sentiment": "neutral",
            "urgency": "medium",
            "action_items": [],
        }


@dataclass
class TranscriptState:
    call_sid: str
    stream_sid: str
    started_at: float
    final_text: str = ""
    partial_text: str = ""
    last_ai_push: float = 0.0

    @property
    def elapsed_minutes(self) -> float:
        return (time.time() - self.started_at) / 60.0

    def update_final(self, text: str) -> None:
        if text:
            if self.final_text:
                self.final_text += " " + text
            else:
                self.final_text = text
        self.partial_text = ""


class CheetahStream:
    def __init__(self) -> None:
        self._engine = pvcheetah.create(access_key=CHEETAH_ACCESS_KEY, enable_automatic_punctuation=True)
        self._frame_length = self._engine.frame_length
        self._buffer = bytearray()
        self._resample_state = None

    def _process_frame(self, frame: bytes) -> Tuple[str, bool]:
        pcm = array("h")
        pcm.frombytes(frame)
        partial, endpoint = self._engine.process(pcm)
        if endpoint:
            flushed = self._engine.flush()
            text = (partial + " " + flushed).strip()
            return text, True
        return partial.strip(), False

    def process_chunk(self, encoded_audio: str) -> Iterable[Tuple[str, bool]]:
        decoded = base64.b64decode(encoded_audio)
        linear8k = audioop.ulaw2lin(decoded, 2)
        converted, self._resample_state = audioop.ratecv(
            linear8k, 2, 1, 8000, 16000, self._resample_state
        )
        self._buffer.extend(converted)
        frame_size = self._frame_length * 2

        while len(self._buffer) >= frame_size:
            frame = bytes(self._buffer[:frame_size])
            del self._buffer[:frame_size]
            text, is_final = self._process_frame(frame)
            if text:
                yield text, is_final

    def flush(self) -> Optional[str]:
        text = self._engine.flush().strip()
        return text or None

    def close(self) -> None:
        self._engine.delete()


async def update_firebase(firebase: FirebaseClient, state: TranscriptState) -> None:
    await firebase.patch(f"calls/{state.call_sid}", {"status": "listening", "transcript": {"final": state.final_text, "partial": state.partial_text, "updatedAt": datetime.now(timezone.utc).isoformat()}})


def _extract_event_datetime(event: Dict, field: str) -> Optional[str]:
    value = event.get(field)
    if isinstance(value, dict):
        return value.get("dateTime") or value.get("date")
    return None


@app.post("/bookings")
async def create_booking_endpoint(request: BookingRequest) -> Dict:
    if not CALENDAR_ID:
        raise HTTPException(status_code=503, detail="Calendar integration is not configured")

    try:
        event = await create_calendar_event(request)
    except RuntimeError as exc:
        message = str(exc)
        status = 503 if "not configured" in message.lower() else 500
        raise HTTPException(status_code=status, detail=message) from exc

    event_start = _extract_event_datetime(event, "start") or request.start_at.isoformat()
    event_end = _extract_event_datetime(event, "end") or request.end_at.isoformat()
    event_summary = event.get("summary") or request.summary or "Service appointment"

    now_iso = datetime.now(timezone.utc).isoformat()
    firebase = FirebaseClient(FIREBASE_RTDB_URL, FIREBASE_DB_SECRET)

    booking_payload = _compact(
        {
            "eventId": event.get("id"),
            "htmlLink": event.get("htmlLink"),
            "start": event_start,
            "end": event_end,
            "createdAt": now_iso,
            "customerName": request.customer_name,
            "customerPhone": request.customer_phone,
            "notes": request.notes,
            "summary": request.summary,
            "actionItems": list(request.action_items) if request.action_items else None,
        }
    )

    action_payload = _compact(
        {
            "type": "book",
            "createdAt": now_iso,
            "eventId": event.get("id"),
            "start": event_start,
            "end": event_end,
            "customerName": request.customer_name,
            "customerPhone": request.customer_phone,
            "notes": request.notes,
            "summary": request.summary,
            "actionItems": list(request.action_items) if request.action_items else None,
        }
    )
    action_payload["callSid"] = request.call_sid

    try:
        await firebase.patch(
            f"calls/{request.call_sid}",
            {
                "booking": booking_payload,
                "bookingUpdatedAt": now_iso,
            },
        )
        await firebase.post(f"calls/{request.call_sid}/actions", action_payload)
    finally:
        await firebase.close()

    return {
        "callSid": request.call_sid,
        "event": {
            "id": event.get("id"),
            "htmlLink": event.get("htmlLink"),
            "start": event_start,
            "end": event_end,
            "summary": event_summary,
        },
    }


@app.websocket("/audiostream")
async def twilio_websocket(websocket: WebSocket) -> None:
    await websocket.accept()
    firebase = FirebaseClient(FIREBASE_RTDB_URL, FIREBASE_DB_SECRET)
    cheetah = CheetahStream()
    state: Optional[TranscriptState] = None

    try:
        async for message in websocket.iter_text():
            event = json.loads(message)
            kind = event.get("event")

            if kind == "start":
                stream = event["start"]["streamSid"]
                call_sid = event["start"].get("callSid", stream)
                state = TranscriptState(call_sid=call_sid, stream_sid=stream, started_at=time.time())
                await firebase.patch(f"calls/{call_sid}", {"status": "connected", "streamSid": stream, "startedAt": datetime.now(timezone.utc).isoformat()})
                continue

            if not state:
                LOGGER.warning("Received %s before start event", kind)
                continue

            if FREE_TIER_GUARD and state.elapsed_minutes > MAX_CALL_MINUTES:
                await firebase.patch(f"calls/{state.call_sid}", {"status": "paused", "notice": "Free tier budget exceeded"})
                await websocket.close()
                break

            if kind == "media":
                media = event["media"]["payload"]
                for text, is_final in cheetah.process_chunk(media):
                    if is_final:
                        state.update_final(text)
                    else:
                        state.partial_text = text
                    await update_firebase(firebase, state)

                    now = time.time()
                    if now - state.last_ai_push > 1.0:
                        card = await build_ai_card(
                            f"{state.final_text} {state.partial_text}".strip()
                        )
                        if card:
                            await firebase.patch(f"calls/{state.call_sid}/ai", card)
                        state.last_ai_push = now
                continue

            if kind == "stop":
                if state.partial_text:
                    state.update_final(state.partial_text)
                    await update_firebase(firebase, state)
                remaining = cheetah.flush()
                if remaining:
                    state.update_final(remaining)
                    await update_firebase(firebase, state)
                await firebase.patch(f"calls/{state.call_sid}", {"status": "completed", "endedAt": datetime.now(timezone.utc).isoformat()})
                break
    except WebSocketDisconnect:
        LOGGER.info("WebSocket disconnected")
    finally:
        await firebase.close()
        cheetah.close()


@app.get("/healthz")
async def healthcheck() -> JSONResponse:
    return JSONResponse({"ok": True})
