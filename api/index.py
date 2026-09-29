"""Live Code Review Companion — Vercel backend.

Two jobs:
- /api/token mints a short-lived ephemeral token for the Gemini Live API so
  the browser can open a real-time WebSocket session without ever seeing the
  API key.
- /api/summary turns a finished session (transcript, pinned notes, suggested
  changes) into a structured review report with the turn-based text model.

The key lives only in the GEMINI_API_KEY env var.
"""

import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Literal

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# Load .env for local `uvicorn` runs. No-op in production: Vercel injects env
# vars directly and .env is git-ignored, so there's no file to find there.
load_dotenv()

# The Live API model named in the NSOffice assignment. If your key is served a
# different live model name by Google AI Studio, change it here only.
LIVE_MODEL = os.environ.get("LIVE_MODEL", "gemini-3.1-flash-live-preview")
# Turn-based model that writes the end-of-session review report.
TEXT_MODEL = os.environ.get("TEXT_MODEL", "gemini-3-flash-preview")

TOKEN_LIFETIME_MINUTES = 30
NEW_SESSION_WINDOW_MINUTES = 2
# Keep the summary prompt bounded; the end of a review carries the conclusions.
MAX_TRANSCRIPT_CHARS = 40_000
SUMMARY_ATTEMPTS = 3

app = FastAPI(title="Code Review Companion Backend")


class TokenResponse(BaseModel):
    token: str
    model: str
    expires_at: str


# ---------- review summary: request (from the browser) ----------
class Turn(BaseModel):
    who: str
    time: str = ""
    text: str


class PinIn(BaseModel):
    note: str
    severity: str = ""
    location: str = ""
    detail: str = ""
    time: str = ""


class PatchIn(BaseModel):
    summary: str = ""
    location: str = ""
    before: str = ""
    after: str = ""
    time: str = ""


class SummaryRequest(BaseModel):
    mode: str = "Bug hunt"
    duration: str = ""
    transcript: list[Turn] = []
    pins: list[PinIn] = []
    patches: list[PatchIn] = []
    files: list[str] = []


# ---------- review summary: response (schema the model must fill) ----------
Severity = Literal["critical", "high", "medium", "suggestion"]


class Finding(BaseModel):
    severity: Severity
    title: str
    location: str
    explanation: str
    fix: str


class ReviewSummary(BaseModel):
    headline: str
    findings: list[Finding]
    unresolved: list[str]
    next_steps: list[str]


SUMMARY_INSTRUCTIONS = """You write the report at the end of a live, spoken code review between a developer ("You") and an AI reviewer ("CodeAssist"). You get the speech transcript (auto-transcribed, so expect small errors), the notes CodeAssist pinned, and the code changes CodeAssist suggested.

The developer will paste your report into a pull request or ticket:
- headline: one sentence on what the session found, naming the root cause if there was one.
- findings: the distinct issues actually discussed, most severe first. Merge duplicates. Keep CodeAssist's pinned severity when there is one. Severity: critical = security hole, data loss, or a crash on a common path; high = wrong behaviour users will hit; medium = an edge case or fragile code; suggestion = clarity, style, or a small improvement. location is file:line when known, otherwise "". fix is the concrete fix in one or two sentences, otherwise "".
- unresolved: questions or issues raised but not settled. Empty if none.
- next_steps: up to four concrete actions, such as tests to add or things to verify.

Only include what the session supports. Never invent files, lines, or issues. Plain text, no markdown."""


def _api_key() -> str:
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is not set")
    return api_key


def _has_grounded_code(req: SummaryRequest) -> bool:
    if req.files:
        return True
    if any((p.location or "").strip() for p in req.pins):
        return True
    if any((p.location or "").strip() for p in req.patches):
        return True
    return False


def _create_ephemeral_token() -> TokenResponse:
    """Create a single-use ephemeral token for a Live API session.

    Uses the v1alpha auth-tokens endpoint exposed by google-genai. The browser
    connects to BidiGenerateContentConstrained with this token and sends the
    full session setup itself, so no session config is baked in here.
    """
    from google import genai

    client = genai.Client(api_key=_api_key(), http_options={"api_version": "v1alpha"})
    now = datetime.now(timezone.utc)
    expire_time = now + timedelta(minutes=TOKEN_LIFETIME_MINUTES)
    auth_token = client.auth_tokens.create(
        config={
            "uses": 1,
            "expire_time": expire_time.isoformat(),
            "new_session_expire_time": (
                now + timedelta(minutes=NEW_SESSION_WINDOW_MINUTES)
            ).isoformat(),
        }
    )
    return TokenResponse(
        token=auth_token.name, model=LIVE_MODEL, expires_at=expire_time.isoformat()
    )


@app.get("/api/token", response_model=TokenResponse)
def mint_token():
    try:
        return _create_ephemeral_token()
    except RuntimeError as exc:
        return JSONResponse(status_code=500, content={"error": str(exc)})
    except Exception as exc:  # pragma: no cover - surface upstream API errors
        return JSONResponse(
            status_code=502,
            content={"error": f"Token minting failed: {exc.__class__.__name__}: {exc}"},
        )


def _summary_prompt(req: SummaryRequest) -> str:
    transcript = "\n".join(
        f"[{t.time}] {t.who}: {t.text.strip()}" for t in req.transcript if t.text.strip()
    )
    if len(transcript) > MAX_TRANSCRIPT_CHARS:
        transcript = "[earlier conversation omitted]\n" + transcript[-MAX_TRANSCRIPT_CHARS:]

    pins = "\n".join(
        f"- [{p.time}] ({p.severity or 'unrated'}) {p.note}"
        + (f" @ {p.location}" if p.location else "")
        + (f" | detail: {p.detail}" if p.detail else "")
        for p in req.pins
    )
    patches = "\n\n".join(
        f"[{p.time}] {p.location or 'unknown location'}: {p.summary}\n"
        f"BEFORE:\n{p.before}\nAFTER:\n{p.after}"
        for p in req.patches
    )
    return (
        f"Review focus: {req.mode}\n"
        f"Duration: {req.duration}\n"
        f"Files shared as text: {', '.join(req.files) or 'none'}\n\n"
        f"PINNED NOTES\n{pins or '(none)'}\n\n"
        f"SUGGESTED CHANGES\n{patches or '(none)'}\n\n"
        f"TRANSCRIPT\n{transcript or '(empty)'}"
    )


def _write_summary(req: SummaryRequest) -> ReviewSummary:
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=_api_key())
    config = types.GenerateContentConfig(
        system_instruction=SUMMARY_INSTRUCTIONS,
        response_mime_type="application/json",
        response_schema=ReviewSummary,
        automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
    )
    prompt = _summary_prompt(req)
    # The free tier sheds load with 503s now and then; one short retry usually lands.
    for attempt in range(SUMMARY_ATTEMPTS):
        try:
            response = client.models.generate_content(
                model=TEXT_MODEL, contents=prompt, config=config
            )
            break
        except genai.errors.ServerError:
            if attempt == SUMMARY_ATTEMPTS - 1:
                raise
            time.sleep(2 * (attempt + 1))
    if isinstance(response.parsed, ReviewSummary):
        return response.parsed
    return ReviewSummary.model_validate_json(response.text)


@app.post("/api/summary", response_model=ReviewSummary)
def summarize(req: SummaryRequest):
    if not (req.transcript or req.pins or req.patches):
        return JSONResponse(status_code=400, content={"error": "Nothing to summarize yet."})
    if not _has_grounded_code(req):
        return ReviewSummary(
            headline="No source files were shared for this review.",
            findings=[],
            unresolved=[],
            next_steps=["Upload the relevant source file or paste the code snippet to get a grounded review."],
        )
    try:
        return _write_summary(req)
    except RuntimeError as exc:
        return JSONResponse(status_code=500, content={"error": str(exc)})
    except Exception as exc:  # pragma: no cover - surface upstream API errors
        return JSONResponse(
            status_code=502,
            content={"error": f"Summary failed: {exc.__class__.__name__}: {exc}"},
        )


@app.get("/api/health")
def health():
    return {"status": "ok", "live_model": LIVE_MODEL, "text_model": TEXT_MODEL}


# Local convenience: one `uvicorn api.index:app` command serves the UI too.
# On Vercel, files in public/ are served by the platform, so this mount is a
# no-op there. API routes are defined above and take precedence.
_static_dir = Path(__file__).parent.parent / "public"
if _static_dir.is_dir():
    app.mount("/", StaticFiles(directory=_static_dir, html=True), name="static")
