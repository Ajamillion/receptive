from __future__ import annotations

import asyncio
import base64
import functools
import json
import logging
import os
from array import array
from datetime import datetime, timedelta, timezone
from typing import Optional

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
from pydantic import BaseModel

load_dotenv()
logging.basicConfig(level=logging.INFO)
LOGGER = logging.getLogger("gv-ai")


def env(name: str) -> str:
  value = os.getenv(name)
  if not value:
    raise RuntimeError(f"{name} is required")
  return value


CHEETAH_ACCESS_KEY = env("CHEETAH_ACCESS_KEY")
GEMINI_API_KEY = env("GEMINI_API_KEY")
FIREBASE_RTDB_URL = env("FIREBASE_RTDB_URL").rstrip("/")
FIREBASE_DB_SECRET = os.getenv("FIREBASE_DB_SECRET")
CALENDAR_ID = os.getenv("CALENDAR_ID")
SERVICE_INFO = os.getenv("GOOGLE_SERVICE_ACCOUNT_INFO")
SERVICE_FILE = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")

HTTP = httpx.AsyncClient(timeout=httpx.Timeout(10.0, connect=5.0))
FIREBASE_PARAMS = {"auth": FIREBASE_DB_SECRET} if FIREBASE_DB_SECRET else None


def iso_now() -> str:
  return datetime.now(timezone.utc).isoformat()


async def fb(path: str, payload: dict) -> None:
  url = f"{FIREBASE_RTDB_URL}/{path}.json"
  try:
    response = await HTTP.patch(url, json=payload, params=FIREBASE_PARAMS)
    response.raise_for_status()
  except httpx.HTTPError as exc:  # pragma: no cover
    LOGGER.warning("Firebase PATCH %s failed: %s", path, exc)


genai.configure(api_key=GEMINI_API_KEY)
MODEL = genai.GenerativeModel("gemini-1.5-flash")
PROMPT = (
  "Summarize this phone call for a receptionist. Reply with JSON containing summary, sentiment (positive|neutral|negative), "
  "urgency (low|medium|high), and action_items (array of strings)."
)
DEFAULT_CARD = {"summary": "Waiting for enough transcript…", "sentiment": "neutral", "urgency": "medium", "action_items": []}


async def build_card(transcript: str) -> Optional[dict]:
  text = transcript.strip()
  if not text:
    return None

  def _invoke() -> dict:
    try:
      result = MODEL.generate_content([PROMPT, text])
    except Exception as exc:  # pragma: no cover
      LOGGER.warning("Gemini call failed: %s", exc)
      return dict(DEFAULT_CARD)
    raw = (result.text or "").strip()
    if raw.startswith("```"):
      raw = "\n".join(line for line in raw.splitlines()[1:] if not line.startswith("```"))
    try:
      parsed = json.loads(raw)
      if isinstance(parsed, dict):
        return parsed
    except json.JSONDecodeError:
      LOGGER.warning("Gemini returned non-JSON payload: %s", raw)
    return {"summary": raw or DEFAULT_CARD["summary"], **{k: v for k, v in DEFAULT_CARD.items() if k != "summary"}}

  return await asyncio.to_thread(_invoke)


class CheetahStream:
  def __init__(self) -> None:
    self.engine = pvcheetah.create(access_key=CHEETAH_ACCESS_KEY, enable_automatic_punctuation=True)
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

  def close(self) -> Optional[str]:
    text = self.engine.flush().strip()
    self.engine.delete()
    return text or None


class CallSession:
  def __init__(self, call_sid: str) -> None:
    self.call_sid = call_sid
    self.final = ""
    self.partial = ""
    self.ai_source = ""

  async def push(self) -> None:
    await fb(
      f"calls/{self.call_sid}",
      {"transcript": {"final": self.final, "partial": self.partial, "updatedAt": iso_now()}},
    )

  async def push_ai(self) -> None:
    text = self.final.strip()
    if not text or text == self.ai_source:
      return
    card = await build_card(text)
    if card:
      self.ai_source = text
      await fb(f"calls/{self.call_sid}", {"ai": {"card": card, "updatedAt": iso_now()}})

  async def consume(self, stream: CheetahStream, payload: str) -> None:
    for text, endpoint in stream.process(payload):
      if endpoint:
        self.final = (self.final + " " + text).strip()
        self.partial = ""
        await self.push()
        await self.push_ai()
      else:
        self.partial = text
        await self.push()


class BookingRequest(BaseModel):
  callSid: str
  startIso: str
  durationMinutes: int = 60
  customerName: Optional[str] = None
  customerPhone: Optional[str] = None
  notes: Optional[str] = None
  summary: Optional[str] = None
  transcript: Optional[str] = None


@functools.lru_cache(maxsize=1)
def calendar_service():
  if SERVICE_INFO and SERVICE_INFO.strip():
    raw = SERVICE_INFO.strip()
    if not raw.startswith("{"):
      raw = base64.b64decode(raw).decode("utf-8")
    credentials = service_account.Credentials.from_service_account_info(
      json.loads(raw), scopes=["https://www.googleapis.com/auth/calendar"]
    )
  elif SERVICE_FILE and os.path.exists(SERVICE_FILE):
    credentials = service_account.Credentials.from_service_account_file(
      SERVICE_FILE, scopes=["https://www.googleapis.com/auth/calendar"]
    )
  else:
    raise RuntimeError("Google service account credentials are not configured")
  return build("calendar", "v3", credentials=credentials, cache_discovery=False)


app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.get("/healthz")
async def healthz() -> dict:
  return {"status": "ok"}


@app.post("/bookings")
async def create_booking(request: BookingRequest) -> JSONResponse:
  if not CALENDAR_ID:
    raise HTTPException(status_code=503, detail="Calendar is not configured")
  try:
    start = datetime.fromisoformat(request.startIso.replace("Z", "+00:00")).astimezone(timezone.utc)
  except ValueError as exc:
    raise HTTPException(status_code=400, detail="Invalid startIso") from exc
  end = start + timedelta(minutes=request.durationMinutes)
  body = {
    "summary": request.summary or f"Booking for {request.customerName or 'customer'}",
    "start": {"dateTime": start.isoformat()},
    "end": {"dateTime": end.isoformat()},
  }
  notes = [request.notes or "", request.transcript or "", request.customerPhone or ""]
  description = "\n\n".join(part for part in notes if part)
  if description:
    body["description"] = description
  try:
    event = calendar_service().events().insert(calendarId=CALENDAR_ID, body=body).execute()
  except HttpError as exc:  # pragma: no cover
    LOGGER.error("Calendar insert failed: %s", exc)
    raise HTTPException(status_code=502, detail="Calendar API error") from exc
  event_id = str(event.get("id")) if event.get("id") else None
  await fb(
    f"calls/{request.callSid}",
    {"booking": {"createdAt": iso_now(), "eventId": event_id, "summary": body["summary"]}},
  )
  return JSONResponse({"status": "ok", "eventId": event_id})


@app.websocket("/audiostream")
async def audiostream(websocket: WebSocket) -> None:
  await websocket.accept()
  stream = CheetahStream()
  session: Optional[CallSession] = None
  started = datetime.now(timezone.utc)

  try:
    while True:
      message = await websocket.receive_json()
      event = message.get("event")
      if event == "start":
        start = message.get("start", {})
        call_sid = start.get("callSid") or start.get("streamSid")
        session = CallSession(call_sid)
        metadata = {"callerNumber": start.get("from"), "forwardedTo": start.get("to")}
        if isinstance(start.get("customParameters"), dict):
          metadata.update(start["customParameters"])
        await fb(
          f"calls/{call_sid}",
          {
            "callSid": call_sid,
            "streamSid": start.get("streamSid"),
            "status": "Connected",
            "createdAt": iso_now(),
            "metadata": metadata,
            "transcript": {"final": "", "partial": "", "updatedAt": iso_now()},
          },
        )
      elif event == "media" and session:
        payload = message.get("media", {}).get("payload")
        if payload:
          await session.consume(stream, payload)
      elif event == "stop":
        break
  except WebSocketDisconnect:  # pragma: no cover
    LOGGER.info("WebSocket disconnected by client")
  finally:
    tail = stream.close()
    if session:
      if tail:
        session.final = (session.final + " " + tail).strip()
      session.partial = ""
      await session.push()
      await session.push_ai()
      await fb(
        f"calls/{session.call_sid}",
        {
          "status": "Completed",
          "completedAt": iso_now(),
          "durationSeconds": int((datetime.now(timezone.utc) - started).total_seconds()),
        },
      )
