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
from datetime import datetime, timezone
from typing import Dict, Iterable, Optional, Tuple

import audioop
import google.generativeai as genai
import httpx
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

import pvcheetah
from dotenv import load_dotenv

LOGGER = logging.getLogger("backend")

load_dotenv()

CHEETAH_ACCESS_KEY = os.getenv("CHEETAH_ACCESS_KEY")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
FIREBASE_RTDB_URL = os.getenv("FIREBASE_RTDB_URL", "").rstrip("/")
FIREBASE_DB_SECRET = os.getenv("FIREBASE_DB_SECRET")
FREE_TIER_GUARD = os.getenv("FREE_TIER_GUARD", "false").lower() == "true"
MAX_CALL_MINUTES = float(os.getenv("FREE_TIER_MAX_MINUTES", 90.0 * 60.0))

for key, value in (
    ("CHEETAH_ACCESS_KEY", CHEETAH_ACCESS_KEY),
    ("GEMINI_API_KEY", GEMINI_API_KEY),
    ("FIREBASE_RTDB_URL", FIREBASE_RTDB_URL),
):
    if not value:
        raise RuntimeError(f"{key} is required")

genai.configure(api_key=GEMINI_API_KEY)

app = FastAPI(title="GV AI Co-pilot Backend")

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

    async def close(self) -> None:
        await self._client.aclose()


GEMINI_MODEL = genai.GenerativeModel("gemini-1.5-flash")


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
