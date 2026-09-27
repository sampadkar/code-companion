# Live Code Review Companion

A real-time, screen-aware code review session with the **Gemini Live API**. You share
your editor, talk through a bug out loud, and **Pair** — the companion — follows both
your screen and the conversation, answering like a senior engineer looking over your
shoulder, with natural interruption (barge-in) support.

Built for the NSOffice.AI internship assignment — **Idea 4: Live Code Review Companion**.

## Why this idea

Code review is a scenario where *neither* half works without the other: questions about
a bug are meaningless without seeing the code, and a screenshot without the conversation
misses the intent. The Live API's audio-to-audio streaming, native screen awareness, and
interruption handling are exactly what make this feel real — none of it could be bolted
onto a turn-based chatbot.

## The session

- **Start** — pick a review focus, then one action: share your screen, allow the mic, go live.
  Focus options: *Bug hunt*, *Security*, *Performance*, *Explain simply* (for newer
  developers) and *Interviewer* (Pair asks questions and gives hints instead of answers).
  Each one changes Pair's system prompt.
- **Live** — your shared screen fills the left panel, a timestamped transcript sits on
  the right. A floating glass pill controls the session: stop sharing, mute the mic,
  type instead of talking, or pause Pair without ending the call.
- **Following** — the chips under your screen show what Pair is tracking right now
  ("useSearch.ts · line 14", "Network · 2 requests"). Pair sets them itself with a
  `set_following` tool call when its focus shifts.
- **Pinned by Pair** — when Pair lands on something worth holding onto (a root cause,
  a risky line, a concrete fix), it calls `pin_note` with a severity (Critical, High,
  Medium or Suggestion). The note appears as a card above the transcript with its
  file:line, an optional code snippet, and sometimes a one-tap follow-up ("Show me the
  change"). The same location is badged on your screen.
- **Suggested change** — when Pair has a concrete fix it calls `suggest_patch` with the
  exact before and after lines. The card shows a line diff with a **Copy fix** button.
  Nothing is written to your files.
- **Share the real code** — paste code (6+ lines) anywhere, drop a file on the page, or
  use the paperclip in the pill. Pair gets it as line-numbered text, so it reads the
  exact source instead of a screenshot and cites real line numbers.
- **Review report** — ending the session sends the transcript, pins and suggested
  changes to `gemini-3-flash-preview`, which writes a headline, severity-ranked
  findings, open questions and next steps. The report also shows every suggested diff
  and a timeline of the session. **Copy report** gives you Markdown for a PR or ticket;
  **Download .md** saves it. If the summary call fails, the report falls back to Pair's
  pinned notes.

All three tools are real Live API function calls made mid-conversation. The model
decides when to use them; nothing in the UI is scripted.

## How it works

```
Browser (mic + screen)                    Vercel (Python)
┌──────────────────────────┐   GET /api/token   ┌─────────────────────┐
│  16 kHz PCM audio  ──┐   │ ◄─────────────── │ FastAPI mints a     │
│  1 fps JPEG frames ──┼──►│  ephemeral token  │ single-use ephemeral│
│  WebSocket (Gemini   │   │                   │ token via           │
│  Live API, direct)   │   │                   │ google-genai        │
└──────────────────────┼───┘                   └─────────────────────┘
                       │    wss://generativelanguage.googleapis.com
                       ▼                        (Live API)
              Spoken review + live transcript
```

- The API key **never** reaches the browser. The backend mints a **single-use,
  30-minute ephemeral token**; the browser connects to the Live API with it.
- Mic audio is tapped with an `AudioWorklet` at 16 kHz and streamed as PCM; a small
  `AnalyserNode` drives the mic level shown in the pill's waveform.
- The shared screen is shown live in the left panel and sampled at 1 fps as JPEG,
  sent alongside the audio.
- Model replies (24 kHz PCM) are scheduled gaplessly; if you start talking over
  the model, its queued audio is cut instantly (barge-in) and the transcript
  shows both sides live.
- `pin_note`, `suggest_patch` and `set_following` are declared in the Live API session
  setup; the client answers each call with a `toolResponse` so Pair keeps talking.
- **Long sessions:** audio+video Live sessions are cut off after ~2 minutes unless
  context window compression is on, so the setup enables `contextWindowCompression`
  (sliding window). Each connection also lasts only ~10 minutes, so the setup enables
  `sessionResumption`. When the server sends `goAway` or drops the socket, the client
  mints a new token, opens a new connection with the latest resumption handle, and
  swaps over. The live pill shows "Reconnecting" meanwhile, and the conversation carries on.
- Typed messages go over the same live stream as `realtimeInput.text`.
- The Live API sends JSON in binary WebSocket frames; the client reads them as
  ArrayBuffers and decodes synchronously so audio chunks stay in order.
- UI follows the NSOffice glass design (`tokens.css` + `liquid-glass.js`, tuned in
  `app.css`): Electric Blue `#1B4DFF` as the single accent, DM Sans, Apple-style
  spacing, one primary action per view. Light theme, as designed.

## Requirements

- Python 3.10+
- A free **Google AI Studio** API key — <https://aistudio.google.com/apikey>
  (no billing / Cloud project setup needed)
- A Chromium-based browser or Firefox (screen share + mic)

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `GEMINI_API_KEY` | yes | Google AI Studio key — **env var only, never committed** |
| `LIVE_MODEL` | no | Override the live model (default `gemini-3.1-flash-live-preview`) |
| `TEXT_MODEL` | no | Model that writes the end-of-session report (default `gemini-3-flash-preview`) |

## Run locally

```bash
# 1. Install dependencies
pip install -r requirements.txt

# 2. Configure the key (copy .env.example, fill in your key)
cp .env.example .env        # then export it:
export GEMINI_API_KEY=...   # macOS/Linux
$env:GEMINI_API_KEY="..."   # Windows PowerShell

# 3. Run it
uvicorn api.index:app --port 3000
```

Then open <http://localhost:3000> — the same process serves the UI and
`/api/token`.

### Recommended: `vercel dev`

The Vercel CLI runs the Python function and the static frontend on one origin,
exactly like production:

```bash
npm i -g vercel
vercel dev        # reads .env automatically, serves at http://localhost:3000
```

## Deploy to Vercel

```bash
vercel                               # first deploy, follow the prompts
vercel env add GEMINI_API_KEY        # add the key (Production)
vercel --prod
```

Or import the GitHub repo in the Vercel dashboard and add `GEMINI_API_KEY`
under **Settings → Environment Variables**. `vercel.json` maps the build for
`api/index.py`; everything in `public/` is served as static files.

## Project layout

```
api/index.py        FastAPI app: /api/token (ephemeral token), /api/summary (review
                     report via the text model, structured JSON), /api/health
public/index.html   Start, live-session and report views (glass UI, one page)
public/app.css       Page layout & components: hero, screen panel, pill, transcript
public/tokens.css   NSOffice design tokens (Electric Blue, DM Sans, spacing)
public/liquid-glass.js  Glass primitives (surfaces, buttons, chips, sheen)
public/app.js       Live API client: mic PCM, screen frames, WS, playback, barge-in,
                     reconnect/resumption, review modes, file sharing, the pin_note +
                     suggest_patch + set_following tools, and the review report
requirements.txt    fastapi, google-genai, uvicorn
vercel.json         Vercel config for the Python function
```

## Notes & fallbacks

- The assignment specifies `gemini-3.1-flash-live-preview`. If Google AI Studio
  serves a different live model name for your key, set `LIVE_MODEL` in the
  environment — it is centralized in `api/index.py` and read by `/api/token`.
- Ephemeral tokens are single-use with a 2-minute window to open the session,
  so a leaked token is close to useless; the real key stays on the server.
- `.env` is git-ignored; only `.env.example` (placeholder) is committed.
