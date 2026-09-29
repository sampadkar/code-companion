/* app.js — Live Code Review Companion client.
 *
 * Flow: pick a review focus → share screen + mic → mint an ephemeral token from
 * our Python backend → open a WebSocket to the Gemini Live API → stream mic
 * audio (16 kHz PCM) and screen frames (1 fps JPEG) in → play spoken replies
 * back gaplessly, with barge-in. CodeAssist calls three tools mid-conversation:
 * pin_note (the pinned card, with a severity), suggest_patch (a before/after
 * diff you can copy) and set_following (the "Following" chips). Files pasted
 * or dropped in go to CodeAssist as numbered text. Ending the session writes a
 * review report via /api/summary.
 */

import { ensureGlassStyles, bindGlassSheen } from "./liquid-glass.js";

ensureGlassStyles();
bindGlassSheen();

const WS_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained";
const IN_SAMPLE_RATE = 16000;   // mic → model
const OUT_SAMPLE_RATE = 24000;  // model → speakers
const SCREEN_FRAME_MS = 1000;   // one shared-screen frame per second
const JPEG_QUALITY = 0.6;
const SETUP_TIMEOUT_MS = 15000; // give up if Gemini never confirms the session
const MAX_RECONNECTS = 20;      // per session; each connection lasts ~10 minutes
const MAX_SHARE_BYTES = 150_000;
const PASTE_AS_FILE_LINES = 6;  // a paste this long is code, not a message
const MODE_KEY = "pair.mode";
const utf8 = new TextDecoder();

const MODES = {
  bug: {
    label: "Bug hunt",
    desc: "Chases the root cause of the bug you're looking at.",
    prompt: `Focus: find the bug. Chase runtime errors, logic errors, wrong state, off-by-ones,
unhandled edge cases and async ordering problems. Get to a root cause, then a fix.`,
  },
  security: {
    label: "Security",
    desc: "Looks for injection, auth gaps, secrets and unsafe input.",
    prompt: `Focus: security. Look for injection, missing authentication or authorization checks,
secrets in code, unsafe input handling, XSS, insecure defaults and data exposure. Judge each
issue by its real-world impact, not by how it looks. If the issue is concrete and the risky code
is visible or shared, give both the warning and a minimal fix patch; do not stop at a verbal
warning when a specific fix is obvious.`,
  },
  performance: {
    label: "Performance",
    desc: "Spots wasted requests, re-renders, leaks and slow paths.",
    prompt: `Focus: performance. Look for redundant network requests, unnecessary re-renders,
N+1 queries, memory leaks, blocking work on hot paths and poor algorithmic complexity. Say what
it costs, not just that it's slow.`,
  },
  explain: {
    label: "Explain simply",
    desc: "Walks through the code in plain words, for newer developers.",
    prompt: `Focus: teaching. The developer is newer to this code. Explain what the code does in
plain words before judging it, define any jargon you use, and use small concrete examples.
Still point out bugs, gently.`,
  },
};

const OPENING_PROMPTS = {
  bug: `Start the review now. Inspect the latest shared-screen frame. Briefly say what file or UI you can see, then identify a likely bug only if the visible evidence supports it. If the code is unreadable or context is missing, ask one precise question or request the relevant file. Do not wait for the developer to speak.`,
  security: `Start a focused security review of the shared screen now. Look for concrete authentication or authorization gaps, injection, XSS, exposed secrets, unsafe input handling, and data leaks. For a confirmed issue, explain the visible code evidence, how it could be triggered, its impact, and a practical fix. If the fix is clear and grounded in visible code, use a suggest_patch tool call with exact before/after lines; do not stop at a verbal warning. Do not invent a vulnerability from incomplete context. If the code is not readable, ask for the relevant file or a closer view. Begin speaking now.`,
  performance: `Start a performance review of the shared screen now. Look for an evidenced bottleneck such as redundant requests, repeated work, blocking operations, leaks, or inefficient queries. Explain the cost and one practical improvement. If the code is not readable, ask for the relevant file or a closer view. Begin speaking now.`,
  explain: `Start by explaining the code currently visible on the shared screen in plain language, then ask what part the developer wants to understand. Define jargon and do not assume experience. If no code is readable, ask them to open a file or share one. Begin speaking now.`,
};

const BASE_PROMPT = `You are CodeAssist, a senior staff engineer doing a live code review beside the developer.
You can SEE their shared screen and HEAR them talking through the problem. Use both together.

Style:
- Speak like a person at their desk, not a document. Short sentences. No lists unless asked.
- React to what's on screen right now. Name the file, line, or panel you're looking at.
- If they're mid-thought, hold back. Ask one pointed follow-up rather than lecturing.
- If they interrupt you, stop and follow their new thread.
- Never use markdown. This is a spoken conversation.

Tools:
- set_following: when your attention shifts to something specific on screen (a file and
  line range, a DevTools panel, a failing test), update the 1-3 short labels of what
  you're following. Only when it changes, not every turn.
- pin_note: when you land on something worth holding onto (a root cause, a risky line,
  a concrete fix), pin it. One clear insight at a time. Always set severity: critical
  (security hole, data loss, a crash on a common path), high (wrong behaviour users will
  hit), medium (an edge case or fragile code), suggestion (clarity, style, a small
  improvement). Use detail for a short supporting snippet shown in monospace with a
  detail_label such as "Worth adding". Add a cta_label only when there's a natural next
  step ("Show me the change", "Draft the test").
- suggest_patch: when you have a concrete code fix, show it. Put the exact current lines in
  before and your replacement in after, copied character for character with indentation,
  from a shared file if there is one, otherwise from the screen. Keep it under 15 lines.
  Don't read code aloud; say in one sentence what the change does. In security reviews,
  prefer a concrete patch when the risk and fix are both clear.

Shared files:
- The developer may paste or drop a file. It arrives as text with line numbers. Treat it as
  the source of truth over the screenshot, use its line numbers in locations, and
  acknowledge it in one short sentence.
- Only reference file names that are actually on screen, in a shared file snippet, or
  explicitly pasted by the developer. Never guess or invent a file that isn't visible.`;

function systemPrompt(mode) {
  return `${BASE_PROMPT}\n\n${MODES[mode].prompt}`;
}

const SEVERITY = { critical: "Critical", high: "High", medium: "Medium", suggestion: "Suggestion" };
const SEVERITY_ORDER = Object.keys(SEVERITY);
const SEVERITY_PARAM = {
  type: "STRING",
  enum: SEVERITY_ORDER,
  description:
    "critical: security hole, data loss, crash on a common path. high: wrong behaviour users will hit. " +
    "medium: edge case or fragile code. suggestion: clarity, style, small improvement.",
};

function normSeverity(value) {
  const s = String(value || "").toLowerCase();
  return SEVERITY[s] ? s : "medium";
}

const TOOLS = {
  functionDeclarations: [
    {
      name: "pin_note",
      description:
        "Pin one high-value insight next to the conversation so it stays visible. Use sparingly: " +
        "a root cause, a specific risky location, or a concrete fix.",
      parameters: {
        type: "OBJECT",
        properties: {
          note: { type: "STRING", description: "The insight in one or two sentences, phrased the way you'd say it." },
          severity: SEVERITY_PARAM,
          location: { type: "STRING", description: "Where it applies, e.g. 'useSearch.ts:14' or 'useSearch.ts:18-20'. Omit if unknown." },
          detail_label: { type: "STRING", description: "Short heading for the detail box, e.g. 'Worth adding'." },
          detail: { type: "STRING", description: "Optional short snippet shown in monospace: a line of code, a test name." },
          cta_label: { type: "STRING", description: "Optional 2-4 word follow-up action, e.g. 'Show me the change'." },
        },
        required: ["note", "severity"],
      },
    },
    {
      name: "suggest_patch",
      description:
        "Show a concrete code change as a before/after diff the developer can copy. Use it when you have " +
        "a specific fix, not a vague idea.",
      parameters: {
        type: "OBJECT",
        properties: {
          summary: { type: "STRING", description: "One sentence on what the change does and why." },
          location: { type: "STRING", description: "File and lines being replaced, e.g. 'useSearch.ts:14-17'." },
          before: { type: "STRING", description: "The exact current lines being replaced, verbatim with indentation." },
          after: { type: "STRING", description: "The replacement lines, with indentation." },
          severity: SEVERITY_PARAM,
        },
        required: ["summary", "before", "after"],
      },
    },
    {
      name: "set_following",
      description:
        "Update the 'Following' labels under the shared screen: the 1-3 specific things on screen " +
        "you're tracking right now. Call it when your focus changes, not on every turn.",
      parameters: {
        type: "OBJECT",
        properties: {
          items: {
            type: "ARRAY",
            items: { type: "STRING" },
            description:
              "1-3 labels, each under 6 words, e.g. 'useSearch.ts · lines 12-14' or 'Network · 2 requests to /api/search'.",
          },
        },
        required: ["items"],
      },
    },
  ],
};

const $ = (id) => document.getElementById(id);
const els = {
  viewStart: $("view-start"),
  viewLive: $("view-live"),
  viewSummary: $("view-summary"),
  startBtn: $("start-btn"),
  endBtn: $("end-btn"),
  modeOptions: $("mode-options"),
  modeDesc: $("mode-desc"),
  liveBadge: $("live-badge"),
  liveLabel: $("live-label"),
  liveMode: $("live-mode"),
  timer: $("timer"),
  screenVideo: $("screen-video"),
  screenSub: $("screen-sub"),
  screenBadge: $("screen-badge"),
  watching: $("watching"),
  watchingText: $("watching-text"),
  following: $("following"),
  switchShareBtn: $("switchshare-btn"),
  stopShareBtn: $("stopshare-btn"),
  micBtn: $("mic-btn"),
  micLabel: $("mic-label"),
  micBars: document.querySelectorAll("#mic-waveform span"),
  typeToggleBtn: $("type-toggle-btn"),
  attachBtn: $("attach-btn"),
  fileInput: $("file-input"),
  pauseBtn: $("pause-btn"),
  typeRow: $("type-row"),
  typeInput: $("type-input"),
  pinnedCard: $("pinned-card"),
  pinnedLabel: $("pinned-label"),
  pinnedSev: $("pinned-sev"),
  pinnedLoc: $("pinned-loc"),
  pinnedText: $("pinned-text"),
  pinnedDetail: $("pinned-detail"),
  pinnedDetailLabel: $("pinned-detail-label"),
  pinnedDetailBody: $("pinned-detail-body"),
  pinnedDiff: $("pinned-diff"),
  pinActions: $("pin-actions"),
  pinnedCopy: $("pinned-copy"),
  pinnedCta: $("pinned-cta"),
  speaking: $("speaking"),
  speakingText: $("speaking-text"),
  transcript: $("transcript"),
  report: $("report"),
  reportTitle: $("report-title"),
  reportMeta: $("report-meta"),
  reportNote: $("report-note"),
  reportStats: $("report-stats"),
  reportFindings: $("report-findings"),
  reportPatchesWrap: $("report-patches-wrap"),
  reportPatches: $("report-patches"),
  reportUnresolvedWrap: $("report-unresolved-wrap"),
  reportUnresolved: $("report-unresolved"),
  reportNextWrap: $("report-next-wrap"),
  reportNext: $("report-next"),
  reportTimeline: $("report-timeline"),
  copyReportBtn: $("copy-report-btn"),
  downloadReportBtn: $("download-report-btn"),
  newSessionBtn: $("new-session-btn"),
  browserSupportNote: $("browser-support-note"),
  errorNote: $("error-note"),
};

if (/Electron/i.test(navigator.userAgent)) {
  els.browserSupportNote.hidden = false;
} else if (!window.isSecureContext || typeof navigator.mediaDevices?.getDisplayMedia !== "function") {
  els.browserSupportNote.hidden = false;
  els.browserSupportNote.textContent = "Screen sharing is unavailable here. Open this page in desktop Chrome or Edge over localhost or HTTPS.";
}

const START_LABEL = els.startBtn.textContent;
const svgIcon = (paths) =>
  `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const EYE_ICON = svgIcon('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"></path><circle cx="12" cy="12" r="3"></circle>');
const PIN_ICON = svgIcon('<path d="M12 17v5M9 3h6l-1 7 4 3v2H6v-2l4-3z"></path>');
const FILE_ICON = svgIcon('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"></path><path d="M14 3v5h5"></path>');
const LINK_ICON = svgIcon('<path d="M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3"></path><path d="M18 3v4h-4M6 21v-4h4"></path>');

// ---------- session state ----------
const session = {
  active: false,
  mode: "bug",
  ws: null,
  resumeHandle: null,
  reconnecting: false,
  reconnects: 0,
  micCtx: null,
  micSource: null,
  micAnalyser: null,
  worklet: null,
  playCtx: null,
  nextPlayTime: 0,
  playSources: new Set(),
  screenStream: null,
  micStream: null,
  frameTimer: null,
  clockTimer: null,
  meterRaf: null,
  startedAt: 0,
  muted: false,
  paused: false,
  speaking: null,
  sourceLabel: "Your screen",
  following: [],
  // What the report is built from
  pins: [],
  patches: [],
  files: [],
  events: [],
  snippets: 0,
  copyText: "",
};

function resetSessionRecord(mode) {
  Object.assign(session, {
    mode,
    resumeHandle: null,
    reconnecting: false,
    reconnects: 0,
    following: [],
    pins: [],
    patches: [],
    files: [],
    events: [],
    snippets: 0,
    copyText: "",
  });
}

// ---------- small DOM helpers ----------
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function sevTag(severity) {
  return el("span", `sev sev--${severity}`, SEVERITY[severity]);
}

async function copyText(text, button, doneLabel = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    const label = button.textContent;
    button.textContent = doneLabel;
    setTimeout(() => (button.textContent = label), 1600);
  } catch {
    showError("Couldn't copy to the clipboard. Your browser may have blocked it.");
  }
}

// ---------- view helpers ----------
function showView(name) {
  els.viewStart.hidden = name !== "start";
  els.viewLive.hidden = name !== "live";
  els.viewSummary.hidden = name !== "summary";
  els.liveBadge.hidden = name !== "live";
  els.endBtn.hidden = name !== "live";
}

function showStartView() {
  showView("start");
  els.startBtn.disabled = false;
  els.startBtn.textContent = START_LABEL;
}

function setStartBusy(label) {
  els.startBtn.disabled = true;
  els.startBtn.textContent = label;
}

let toastTimer = null;
function showToast(message, ms = 4000) {
  clearTimeout(toastTimer);
  els.errorNote.textContent = message;
  els.errorNote.classList.add("is-visible");
  toastTimer = setTimeout(clearError, ms);
}

function showError(message) {
  showToast(message, 9000);
}

function clearError() {
  els.errorNote.classList.remove("is-visible");
}

function elapsed() {
  const s = Math.max(0, Math.floor((Date.now() - session.startedAt) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function logEvent(text) {
  session.events.push({ time: elapsed(), text });
}

function setLiveState(state) {
  els.liveBadge.classList.toggle("is-reconnecting", state === "reconnecting");
  els.liveLabel.textContent = state === "reconnecting" ? "Reconnecting" : "Live";
}

const SPEAKING_TEXT = { quiet: "Quiet", you: "You're talking", pair: "CodeAssist is speaking", paused: "Paused" };
function setSpeaking(state) {
  if (session.speaking === state) return;
  session.speaking = state;
  els.speaking.dataset.state = state;
  els.speakingText.textContent = SPEAKING_TEXT[state];
}

// ---------- review modes ----------
function selectedMode() {
  const value = els.modeOptions.querySelector('input[name="mode"]:checked')?.value;
  return MODES[value] ? value : "bug";
}

function renderModes() {
  let saved = "bug";
  try {
    const stored = localStorage.getItem(MODE_KEY);
    if (MODES[stored]) saved = stored;
  } catch { /* storage blocked: default mode */ }

  els.modeOptions.replaceChildren(
    ...Object.entries(MODES).map(([value, mode]) => {
      const label = el("label", "mode");
      const input = el("input");
      input.type = "radio";
      input.name = "mode";
      input.value = value;
      input.checked = value === saved;
      label.append(input, el("span", null, mode.label));
      return label;
    })
  );
  els.modeDesc.textContent = MODES[saved].desc;
}

els.modeOptions.addEventListener("change", () => {
  const mode = selectedMode();
  els.modeDesc.textContent = MODES[mode].desc;
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* not remembered, that's fine */ }
});

// ---------- following chips ----------
function renderFollowing() {
  els.following.querySelectorAll(".chip").forEach((c) => c.remove());
  const items = session.following.length ? session.following : [session.sourceLabel];
  items.forEach((text, i) => {
    const chip = el("span", i === 0 ? "chip is-focus" : "chip", text);
    chip.title = text;
    els.following.appendChild(chip);
  });
}

function setFollowing(items) {
  const clean = (Array.isArray(items) ? items : [])
    .map((s) => normalizeKnownFileRef(String(s).trim()))
    .filter(Boolean)
    .slice(0, 3);

  const fallback = session.following.length ? session.following : [session.sourceLabel];
  const changed = clean.join("|") !== session.following.join("|");
  session.following = clean.length ? clean : fallback;
  renderFollowing();
  if (changed && session.following.length) {
    addNote(`CodeAssist is following ${joinWords(session.following)}.`);
    logEvent(`Following ${joinWords(session.following)}`);
  }
}

function joinWords(list) {
  return list.length < 2 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
}

function normalizeKnownFileRef(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const match = raw.match(/([A-Za-z0-9_.-]+\.[A-Za-z0-9]+)(?::\d+(?:-\d+)?)?/);
  if (!match) return raw;

  const file = match[1];
  const known = session.files.some((name) => name.toLowerCase() === file.toLowerCase());
  if (!known) return "";

  return raw;
}

// ---------- transcript ----------
function addNote(text, icon = EYE_ICON) {
  const div = el("div", "note");
  div.innerHTML = icon;
  div.appendChild(el("span", null, text));
  els.transcript.appendChild(div);
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

function addTurn(who, text) {
  closeLastTurn();
  const div = el("div", `turn turn--${who === "You" ? "you" : "pair"} is-streaming`);
  div.dataset.who = who;
  const meta = el("div", "turn-meta");
  meta.append(el("span", "who", who), el("span", "time", elapsed()));
  div.append(meta, el("p", "what", text.trimStart()));
  els.transcript.appendChild(div);
  els.transcript.scrollTop = els.transcript.scrollHeight;
  return div;
}

function appendToTurn(who, text) {
  if (!text) return;
  const last = els.transcript.lastElementChild;
  if (last?.dataset.who === who && last.classList.contains("is-streaming")) {
    last.querySelector(".what").textContent += text;
    els.transcript.scrollTop = els.transcript.scrollHeight;
  } else if (text.trim()) {
    addTurn(who, text);
  }
}

function closeLastTurn() {
  els.transcript.querySelectorAll(".turn.is-streaming").forEach((t) => t.classList.remove("is-streaming"));
}

// ---------- diff ----------
function splitLines(text) {
  const s = String(text || "").replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  return s ? s.split("\n").map((l) => l.trimEnd()) : [];
}

// Line-level LCS. Patches are a handful of lines, so O(n·m) is fine; anything
// huge just shows as all-removed then all-added.
function diffLines(a, b) {
  if (a.length * b.length > 40000) return [...a.map((t) => ["-", t]), ...b.map((t) => ["+", t])];
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push([" ", a[i]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(["-", a[i++]]);
    else out.push(["+", b[j++]]);
  }
  while (i < n) out.push(["-", a[i++]]);
  while (j < m) out.push(["+", b[j++]]);
  return out;
}

function renderDiff(container, before, after) {
  const body = el("div", "diff-body");
  for (const [op, text] of diffLines(splitLines(before), splitLines(after))) {
    const row = el("div", op === "+" ? "diff-line is-add" : op === "-" ? "diff-line is-del" : "diff-line", text || " ");
    row.dataset.op = op;
    body.appendChild(row);
  }
  container.replaceChildren(body);
}

function patchCopyText(before, after) {
  const parts = [];
  for (const [op, text] of diffLines(splitLines(before), splitLines(after))) {
    if (op === "+") parts.push(text);
  }
  return parts.join("\n").trim();
}

// ---------- pinned card: a pin or a suggested change ----------
function setCardHead(label, severity, location) {
  els.pinnedLabel.textContent = label;
  els.pinnedSev.hidden = !severity;
  if (severity) {
    els.pinnedSev.className = `sev sev--${severity}`;
    els.pinnedSev.textContent = SEVERITY[severity];
  }
  els.pinnedLoc.textContent = location || "";
  els.screenBadge.hidden = !location;
  els.screenBadge.textContent = location ? `CodeAssist · ${location}` : "";
}

function syncPinActions() {
  els.pinActions.hidden = els.pinnedCopy.hidden && els.pinnedCta.hidden;
}

function renderPin(args) {
  const pin = {
    note: String(args.note || "").trim(),
    severity: normSeverity(args.severity),
    location: normalizeKnownFileRef(String(args.location || "").trim()),
    detail: String(args.detail || ""),
    detail_label: String(args.detail_label || ""),
    time: elapsed(),
  };
  if (!pin.note) return false;
  session.pins.push(pin);
  logEvent(`Pinned (${SEVERITY[pin.severity]}): ${pin.note}`);

  setCardHead("Pinned by CodeAssist", pin.severity, pin.location);
  els.pinnedText.textContent = pin.note;
  els.pinnedDetail.hidden = !pin.detail;
  els.pinnedDetailLabel.textContent = pin.detail_label || "Detail";
  els.pinnedDetailBody.textContent = pin.detail;
  els.pinnedDiff.hidden = true;
  els.pinnedCopy.hidden = true;
  els.pinnedCta.hidden = !args.cta_label;
  els.pinnedCta.textContent = args.cta_label || "";
  syncPinActions();
  els.pinnedCard.hidden = false;

  addNote(`Pinned · ${SEVERITY[pin.severity]}: ${pin.note}`, PIN_ICON);
  return true;
}

function renderPatch(args) {
  const patch = {
    summary: String(args.summary || "").trim(),
    location: normalizeKnownFileRef(String(args.location || "").trim()),
    before: String(args.before || ""),
    after: String(args.after || ""),
    severity: args.severity ? normSeverity(args.severity) : "",
    time: elapsed(),
  };
  if (!patch.after.trim() && !patch.before.trim()) return false;
  session.patches.push(patch);
  logEvent(`Suggested a change${patch.location ? ` at ${patch.location}` : ""}: ${patch.summary}`);

  setCardHead("Suggested change", patch.severity, patch.location);
  els.pinnedText.textContent = patch.summary;
  els.pinnedDetail.hidden = true;
  renderDiff(els.pinnedDiff, patch.before, patch.after);
  els.pinnedDiff.hidden = false;
  session.copyText = patchCopyText(patch.before, patch.after) || patch.after;
  els.pinnedCopy.hidden = !session.copyText.trim();
  els.pinnedCta.hidden = true;
  syncPinActions();
  els.pinnedCard.hidden = false;

  addNote(`CodeAssist suggested a change${patch.location ? ` to ${patch.location}` : ""}. Copy it from the card above.`, PIN_ICON);
  return true;
}

function clearPin() {
  els.pinnedCard.hidden = true;
  els.screenBadge.hidden = true;
}

// ---------- base64 <-> pcm ----------
function floatToPcm16Base64(float32) {
  const pcm = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  let binary = "";
  const bytes = new Uint8Array(pcm.buffer);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function pcm16Base64ToFloat32(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const pcm = new Int16Array(bytes.buffer);
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 0x8000;
  return out;
}

// ---------- capture ----------
async function mintToken() {
  const res = await fetch("/api/token");
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Token endpoint failed (${res.status})`);
  return body; // { token, model, expires_at }
}

function describeSurface(track) {
  const surface = track.getSettings?.().displaySurface;
  const kind = surface === "window" ? "A window" : surface === "browser" ? "A browser tab" : "Entire screen";
  // Chrome labels window captures with the window title; screens get ids like "screen:0:0".
  const label = track.label && !/^(screen|window|web-contents-media-stream):/i.test(track.label) ? track.label : "";
  return { kind, label: label || kind };
}

async function attachScreenStream(stream) {
  session.screenStream = stream;
  const track = stream.getVideoTracks()[0];
  track.addEventListener("ended", () => {
    if (session.screenStream === stream) endSession();
  });
  const { kind, label } = describeSurface(track);
  els.screenSub.textContent = kind;
  session.sourceLabel = label;
  els.screenVideo.srcObject = stream;
  await els.screenVideo.play().catch(() => {});
  return { kind, label };
}

async function startScreenShare() {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 } });
  await attachScreenStream(stream);

  // Offscreen canvas only for the JPEG frames sent to the model; the visible
  // <video> shows the live feed directly.
  const canvas = document.createElement("canvas");
  return () => {
    const w = els.screenVideo.videoWidth;
    if (!w) return null;
    const scale = Math.min(1, 960 / w);
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(els.screenVideo.videoHeight * scale);
    canvas.getContext("2d").drawImage(els.screenVideo, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", JPEG_QUALITY).split(",")[1];
  };
}

async function switchScreenShare() {
  if (!session.active || session.switchingScreen) return;
  session.switchingScreen = true;
  els.switchShareBtn.disabled = true;
  els.switchShareBtn.textContent = "Choose screen...";

  try {
    const nextStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 } });
    if (!session.active) {
      nextStream.getTracks().forEach((track) => track.stop());
      return;
    }

    const previousStream = session.screenStream;
    const { kind, label } = await attachScreenStream(nextStream);
    previousStream?.getTracks().forEach((track) => track.stop());
    session.following = [];
    renderFollowing();
    const message = `The shared screen changed to ${label} (${kind}). Review the current screen and do not rely on the previous screen.`;
    send({ realtimeInput: { text: message } });
    addNote(`Screen switched to ${label}. CodeAssist is continuing the review.`);
    logEvent(`Screen switched to ${label}`);
  } catch (err) {
    if (err.name !== "NotAllowedError" && err.name !== "AbortError") {
      showError(`Couldn't switch the shared screen: ${err.message}`);
    }
  } finally {
    session.switchingScreen = false;
    els.switchShareBtn.disabled = false;
    els.switchShareBtn.textContent = "Switch screen";
  }
}

// Mic capture with an inline AudioWorklet (no extra file needed).
async function startMic(onChunk) {
  const workletSource = `
    class PcmTap extends AudioWorkletProcessor {
      process(inputs) {
        const input = inputs[0];
        if (input && input[0] && input[0].length) this.port.postMessage(input[0].slice(0));
        return true;
      }
    }
    registerProcessor("pcm-tap", PcmTap);
  `;
  const blobUrl = URL.createObjectURL(new Blob([workletSource], { type: "application/javascript" }));

  session.micStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  session.micCtx = new AudioContext({ sampleRate: IN_SAMPLE_RATE });
  await session.micCtx.resume();
  await session.micCtx.audioWorklet.addModule(blobUrl);
  URL.revokeObjectURL(blobUrl);

  session.micSource = session.micCtx.createMediaStreamSource(session.micStream);
  session.worklet = new AudioWorkletNode(session.micCtx, "pcm-tap");
  session.worklet.port.onmessage = (e) => onChunk(e.data);
  session.micSource.connect(session.worklet);
  session.worklet.connect(session.micCtx.destination); // silent; no monitoring path

  // Level meter for the pill's waveform and the "You're talking" state.
  session.micAnalyser = session.micCtx.createAnalyser();
  session.micAnalyser.fftSize = 256;
  session.micSource.connect(session.micAnalyser);
  runMicMeter();
}

function runMicMeter() {
  const analyser = session.micAnalyser;
  const data = new Uint8Array(analyser.frequencyBinCount);
  let talkingUntil = 0;

  const tick = () => {
    if (!session.micAnalyser) return; // torn down
    analyser.getByteTimeDomainData(data);
    let sumSquares = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sumSquares += v * v;
    }
    const silenced = session.muted || session.paused;
    const level = silenced ? 0 : Math.sqrt(sumSquares / data.length);

    const t = performance.now() / 220;
    els.micBars.forEach((bar, i) => {
      const wobble = 0.4 + 0.6 * Math.abs(Math.sin(t + i * 1.3));
      bar.style.height = `${Math.max(4, 4 + Math.min(1, level * 4) * 14 * wobble)}px`;
    });

    if (level > 0.04) talkingUntil = performance.now() + 500;
    if (session.paused) setSpeaking("paused");
    else if (session.playSources.size > 0) setSpeaking("pair");
    else if (performance.now() < talkingUntil) setSpeaking("you");
    else setSpeaking("quiet");

    session.meterRaf = requestAnimationFrame(tick);
  };
  tick();
}

// ---------- playback ----------
async function initPlayback() {
  session.playCtx = new AudioContext({ sampleRate: OUT_SAMPLE_RATE });
  await session.playCtx.resume();
  session.nextPlayTime = session.playCtx.currentTime;
}

function playChunk(pcmFloat) {
  const ctx = session.playCtx;
  if (!ctx) return;
  const buffer = ctx.createBuffer(1, pcmFloat.length, OUT_SAMPLE_RATE);
  buffer.copyToChannel(pcmFloat, 0);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  const startAt = Math.max(session.nextPlayTime, ctx.currentTime);
  source.start(startAt);
  session.nextPlayTime = startAt + buffer.duration;
  session.playSources.add(source);
  source.onended = () => session.playSources.delete(source);
}

function stopPlayback() {
  // Barge-in: the user spoke while CodeAssist was talking — cut it instantly.
  for (const s of session.playSources) {
    try { s.stop(); } catch { /* already stopped */ }
  }
  session.playSources.clear();
  if (session.playCtx) session.nextPlayTime = session.playCtx.currentTime;
}

// ---------- Live API socket ----------
function send(message) {
  if (session.ws?.readyState === WebSocket.OPEN) session.ws.send(JSON.stringify(message));
}

function openSocket(token, model, resumeHandle) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_URL}?access_token=${encodeURIComponent(token)}`);
    // The Live API sends JSON in binary frames. Reading them as ArrayBuffers
    // lets us decode synchronously, which keeps audio chunks in order.
    ws.binaryType = "arraybuffer";

    let settled = false; // guards against the socket closing/erroring before setupComplete
    const fail = (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(setupTimer);
      reject(new Error(message));
      ws.close();
    };
    const setupTimer = setTimeout(() => fail("Gemini didn't confirm the session in time. Try again."), SETUP_TIMEOUT_MS);

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          setup: {
            model: `models/${model}`,
            generationConfig: { responseModalities: ["AUDIO"] },
            systemInstruction: { parts: [{ text: systemPrompt(session.mode) }] },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            tools: [TOOLS],
            // Audio+video sessions are cut off after ~2 minutes without
            // compression; a sliding window lets a review run as long as it needs.
            contextWindowCompression: { slidingWindow: {} },
            // Each connection lasts ~10 minutes. Resumption handles let a new
            // connection pick up the same conversation.
            sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
          },
        })
      );
    };
    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(typeof event.data === "string" ? event.data : utf8.decode(event.data));
      } catch (err) {
        console.error("Unreadable message from the Live API", err);
        return;
      }
      if (msg.setupComplete) {
        settled = true;
        clearTimeout(setupTimer);
        resolve(ws);
        return;
      }
      handleServerMessage(msg);
    };
    ws.onerror = () => fail("Couldn't connect to Gemini Live. Check your network and try again.");
    ws.onclose = (e) => {
      if (!settled) {
        // Closed before the server confirmed setup (bad token, rejected auth,
        // malformed setup) — reject instead of hanging forever.
        fail(`Connection closed before it was ready (code ${e.code}${e.reason ? `: ${e.reason}` : ""}).`);
        return;
      }
      if (session.ws !== ws) return; // replaced by a reconnect, or ended by stopSession
      // The server dropped us mid-review: pick the conversation back up.
      console.warn(`Live API closed the connection (code ${e.code}${e.reason ? `: ${e.reason}` : ""}); reconnecting.`);
      reconnect();
    };
  });
}

// Moves the session onto a fresh connection. The old one keeps streaming
// until the new one is ready (goAway gives us time), so there's no gap.
async function reconnect() {
  if (session.reconnecting || !session.active) return;
  if (session.reconnects >= MAX_RECONNECTS) {
    showError("CodeAssist's connection kept dropping, so the session ended.");
    endSession();
    return;
  }
  session.reconnecting = true;
  session.reconnects++;
  setLiveState("reconnecting");
  const old = session.ws;

  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        // Last try without the handle in case it's the handle being rejected.
        const handle = attempt < 3 ? session.resumeHandle : null;
        const { token, model } = await mintToken();
        const ws = await openSocket(token, model, handle);
        if (!session.active) {
          ws.close(1000);
          return;
        }
        session.ws = ws;
        if (old && old.readyState <= WebSocket.OPEN) old.close(1000);
        setLiveState("live");
        const text = handle ? "Reconnected to the same conversation" : "Reconnected with a fresh context";
        logEvent(text);
        addNote(`${text}.`, LINK_ICON);
        return;
      } catch (err) {
        console.warn(`Reconnect attempt ${attempt} failed`, err);
        if (!session.active) return;
        await new Promise((r) => setTimeout(r, attempt * 1000));
      }
    }
    showError("Lost the connection to CodeAssist and couldn't get it back.");
    endSession();
  } finally {
    session.reconnecting = false;
  }
}

function handleToolCall(toolCall) {
  const functionResponses = (toolCall.functionCalls || []).map((call) => {
    const args = call.args || {};
    if (call.name === "pin_note") {
      return { id: call.id, name: call.name, response: renderPin(args) ? { result: "pinned" } : { error: "note is empty" } };
    }
    if (call.name === "suggest_patch") {
      return { id: call.id, name: call.name, response: renderPatch(args) ? { result: "shown" } : { error: "before and after are empty" } };
    }
    if (call.name === "set_following") {
      setFollowing(args.items);
      return { id: call.id, name: call.name, response: { result: "updated" } };
    }
    return { id: call.id, name: call.name, response: { error: "unknown tool" } };
  });
  if (functionResponses.length) send({ toolResponse: { functionResponses } });
}

function handleServerMessage(msg) {
  if (msg.toolCall) handleToolCall(msg.toolCall);

  const resume = msg.sessionResumptionUpdate;
  if (resume?.resumable && resume.newHandle) session.resumeHandle = resume.newHandle;
  // The server is about to close this connection (~10 minute limit).
  if (msg.goAway) reconnect();

  const sc = msg.serverContent;
  if (!sc) return;

  if (sc.interrupted) {
    stopPlayback();
    closeLastTurn();
  }
  if (sc.modelTurn?.parts && !session.paused) {
    for (const part of sc.modelTurn.parts) {
      if (part.inlineData?.mimeType?.startsWith("audio/pcm")) {
        playChunk(pcm16Base64ToFloat32(part.inlineData.data));
      }
    }
  }
  if (sc.inputTranscription?.text) appendToTurn("You", sc.inputTranscription.text);
  if (sc.outputTranscription?.text) appendToTurn("CodeAssist", sc.outputTranscription.text);
  if (sc.turnComplete) closeLastTurn();
}

function sendTextTurn(text) {
  if (!text?.trim() || session.ws?.readyState !== WebSocket.OPEN) return;
  // realtimeInput.text rides the same live stream as the mic. clientContent
  // stalls mid-session on the 3.1 live model (verified against the API).
  send({ realtimeInput: { text } });
  addTurn("You", text);
  closeLastTurn();
}

// ---------- sharing code as text ----------
function shareCode(name, text) {
  if (session.ws?.readyState !== WebSocket.OPEN) {
    showToast("CodeAssist isn't connected right now. Try again in a moment.");
    return;
  }
  const lines = String(text).replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
  const width = String(lines.length).length;
  const numbered = lines.map((line, i) => `${String(i + 1).padStart(width)} | ${line}`).join("\n");
  send({
    realtimeInput: {
      text:
        `[The developer shared ${name} (${lines.length} lines) as text. Use it as the source of truth ` +
        `over the screen and cite these line numbers.]\n${numbered}`,
    },
  });
  if (!session.files.includes(name)) session.files.push(name);
  logEvent(`Shared ${name} (${lines.length} lines)`);
  addNote(`You shared ${name} · ${lines.length} lines. CodeAssist reads it as text, so line numbers are exact.`, FILE_ICON);
}

async function shareFile(file) {
  if (file.size > MAX_SHARE_BYTES) {
    showToast(`${file.name} is too big to share (limit ${Math.round(MAX_SHARE_BYTES / 1000)} KB). Paste the relevant part instead.`);
    return;
  }
  const text = await file.text();
  if (text.includes("\u0000")) {
    showToast(`${file.name} doesn't look like a text file.`);
    return;
  }
  shareCode(file.name, text);
}

async function shareFiles(fileList) {
  for (const file of [...fileList].slice(0, 5)) await shareFile(file);
}

const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");

document.addEventListener("dragover", (e) => {
  if (!session.active || !hasFiles(e)) return;
  e.preventDefault();
  els.viewLive.classList.add("is-dropping");
});
document.addEventListener("dragleave", (e) => {
  if (!e.relatedTarget) els.viewLive.classList.remove("is-dropping");
});
document.addEventListener("drop", (e) => {
  els.viewLive.classList.remove("is-dropping");
  if (!session.active || !hasFiles(e)) return;
  e.preventDefault();
  shareFiles(e.dataTransfer.files);
});
// A multi-line paste anywhere in the live view is code: share it as a file.
document.addEventListener("paste", (e) => {
  if (!session.active) return;
  const text = e.clipboardData?.getData("text") || "";
  if (text.split("\n").length < PASTE_AS_FILE_LINES) return;
  e.preventDefault();
  shareCode(`snippet-${++session.snippets}`, text);
});

// ---------- pill controls ----------
function setMuted(muted) {
  session.muted = muted;
  els.micBtn.classList.toggle("is-muted", muted);
  els.micBtn.setAttribute("aria-label", muted ? "Unmute microphone" : "Mute microphone");
  els.micLabel.textContent = muted ? "Muted" : "Mic live";
}

function setPaused(paused) {
  if (session.paused !== paused && session.active) logEvent(paused ? "Paused CodeAssist" : "Resumed CodeAssist");
  session.paused = paused;
  els.pauseBtn.classList.toggle("is-active", paused);
  els.pauseBtn.setAttribute("aria-pressed", String(paused));
  els.pauseBtn.setAttribute("aria-label", paused ? "Resume CodeAssist" : "Pause CodeAssist");
  els.watching.classList.toggle("is-paused", paused);
  els.watchingText.textContent = paused ? "CodeAssist is paused" : "CodeAssist is watching";
  if (paused) stopPlayback();
}

function toggleTypeRow(forceOpen) {
  const open = forceOpen ?? els.typeRow.hidden;
  els.typeRow.hidden = !open;
  els.typeToggleBtn.classList.toggle("is-active", open);
  els.typeToggleBtn.setAttribute("aria-pressed", String(open));
  if (open) els.typeInput.focus();
  else els.typeInput.value = "";
}

els.micBtn.addEventListener("click", () => setMuted(!session.muted));
els.pauseBtn.addEventListener("click", () => setPaused(!session.paused));
els.typeToggleBtn.addEventListener("click", () => toggleTypeRow());
els.attachBtn.addEventListener("click", () => els.fileInput.click());
els.fileInput.addEventListener("change", async () => {
  await shareFiles(els.fileInput.files);
  els.fileInput.value = "";
});
els.typeRow.addEventListener("submit", (e) => {
  e.preventDefault();
  sendTextTurn(els.typeInput.value);
  els.typeInput.value = "";
});
els.typeInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") toggleTypeRow(false);
});
els.pinnedCta.addEventListener("click", () => sendTextTurn(els.pinnedCta.textContent));
els.pinnedCopy.addEventListener("click", () => copyText(session.copyText, els.pinnedCopy));
els.switchShareBtn.addEventListener("click", switchScreenShare);
// track.stop() doesn't fire "ended", so end the session directly.
els.stopShareBtn.addEventListener("click", () => endSession());

// ---------- review report ----------
let reportSeq = 0;
let currentReport = null;

function captureReport() {
  const transcript = [...els.transcript.querySelectorAll(".turn")]
    .map((t) => ({
      who: t.dataset.who,
      time: t.querySelector(".time").textContent,
      text: t.querySelector(".what").textContent.trim(),
    }))
    .filter((t) => t.text);
  return {
    mode: session.mode,
    modeLabel: MODES[session.mode].label,
    duration: elapsed(),
    endedAt: new Date(),
    source: session.sourceLabel,
    transcript,
    pins: [...session.pins],
    patches: [...session.patches],
    files: [...session.files],
    events: [...session.events],
  };
}

function normalizeSummary(ai) {
  const list = (v) => (Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean) : []);
  return {
    headline: String(ai?.headline || "").trim(),
    findings: (Array.isArray(ai?.findings) ? ai.findings : [])
      .map((f) => ({
        severity: normSeverity(f.severity),
        title: String(f.title || "").trim(),
        location: String(f.location || "").trim(),
        explanation: String(f.explanation || "").trim(),
        fix: String(f.fix || "").trim(),
      }))
      .filter((f) => f.title),
    unresolved: list(ai?.unresolved),
    next_steps: list(ai?.next_steps),
  };
}

function reportFindings(r) {
  const findings = r.ai
    ? r.ai.findings
    : r.pins.map((p) => ({ severity: p.severity, title: p.note, location: p.location, explanation: "", fix: p.detail }));
  return [...findings].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
}

function renderList(wrap, list, items) {
  wrap.hidden = !items.length;
  list.replaceChildren(...items.map((text) => el("li", null, text)));
}

function renderReport(r) {
  const loading = r.status === "loading";
  els.report.classList.toggle("is-loading", loading);
  els.reportTitle.textContent = loading
    ? "Writing your review summary…"
    : r.ai?.headline || (r.pins.length ? "Here's what CodeAssist pinned." : "Review summary");
  const files = r.files.length ? `${r.files.length} file${r.files.length === 1 ? "" : "s"} shared` : "";
  els.reportMeta.textContent = [r.modeLabel, r.duration, files].filter(Boolean).join(" · ");
  els.reportNote.hidden = r.status !== "failed";

  const findings = reportFindings(r);
  els.reportStats.replaceChildren(
    ...SEVERITY_ORDER.map((sev) => {
      const count = findings.filter((f) => f.severity === sev).length;
      const stat = el("span", `stat stat--${sev}${count ? " has-items" : ""}`);
      stat.append(el("b", null, String(count)), ` ${SEVERITY[sev]}`);
      return stat;
    })
  );

  if (!findings.length) {
    els.reportFindings.replaceChildren(
      el("p", "report-empty", loading ? "Pulling the findings out of the conversation…" : "No issues were raised in this session.")
    );
  } else {
    els.reportFindings.replaceChildren(
      ...findings.map((f) => {
        const card = el("article", "finding");
        const head = el("div", "finding-head");
        head.append(sevTag(f.severity), el("span", "finding-title", f.title));
        if (f.location) head.append(el("span", "finding-loc", f.location));
        card.append(head);
        if (f.explanation) card.append(el("p", "finding-body", f.explanation));
        if (f.fix) {
          const fix = el("p", "finding-fix");
          fix.append(el("b", null, "Fix "), f.fix);
          card.append(fix);
        }
        return card;
      })
    );
  }

  els.reportPatchesWrap.hidden = !r.patches.length;
  els.reportPatches.replaceChildren(
    ...r.patches.map((p) => {
      const block = el("div", "patch");
      const head = el("div", "finding-head");
      if (p.severity) head.append(sevTag(p.severity));
      head.append(el("span", "finding-title", p.summary || "Suggested change"));
      if (p.location) head.append(el("span", "finding-loc", p.location));
      const diff = el("div", "diff");
      renderDiff(diff, p.before, p.after);
      block.append(head, diff);
      return block;
    })
  );

  renderList(els.reportUnresolvedWrap, els.reportUnresolved, r.ai?.unresolved || []);
  renderList(els.reportNextWrap, els.reportNext, r.ai?.next_steps || []);

  els.reportTimeline.replaceChildren(
    ...r.events.map((e) => {
      const li = el("li");
      li.append(el("time", null, e.time), el("span", null, e.text));
      return li;
    })
  );
}

function reportMarkdown(r) {
  const findings = reportFindings(r);
  const out = ["# CodeAssist review summary", "", `**${r.modeLabel}** · ${r.duration} · ${r.endedAt.toLocaleString()}`];
  if (r.ai?.headline) out.push("", r.ai.headline);
  if (r.files.length) out.push("", `Files shared: ${r.files.join(", ")}`);

  out.push("", "## Findings", "");
  if (!findings.length) out.push("No issues were raised in this session.", "");
  findings.forEach((f, i) => {
    out.push(`### ${i + 1}. [${SEVERITY[f.severity]}] ${f.title}${f.location ? ` (\`${f.location}\`)` : ""}`);
    if (f.explanation) out.push("", f.explanation);
    if (f.fix) out.push("", `**Fix:** ${f.fix}`);
    out.push("");
  });

  if (r.patches.length) {
    out.push("## Suggested changes", "");
    for (const p of r.patches) {
      out.push(`**${p.location || "Change"}**: ${p.summary}`, "", "```diff");
      for (const [op, text] of diffLines(splitLines(p.before), splitLines(p.after))) out.push(`${op}${text}`);
      out.push("```", "");
    }
  }
  if (r.ai?.unresolved.length) out.push("## Still open", "", ...r.ai.unresolved.map((s) => `- ${s}`), "");
  if (r.ai?.next_steps.length) out.push("## Next steps", "", ...r.ai.next_steps.map((s) => `- ${s}`), "");
  out.push("## Timeline", "", ...r.events.map((e) => `- \`${e.time}\` ${e.text}`), "");
  out.push("## Transcript", "", ...r.transcript.flatMap((t) => [`**${t.who}** (${t.time}): ${t.text}`, ""]));
  return out.join("\n");
}

async function fetchSummary(r) {
  const res = await fetch("/api/summary", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode: r.modeLabel,
      duration: r.duration,
      transcript: r.transcript,
      pins: r.pins,
      patches: r.patches,
      files: r.files,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Summary failed (${res.status})`);
  return body;
}

function showReport(r) {
  const seq = ++reportSeq;
  currentReport = { ...r, status: "loading", ai: null };
  showView("summary");
  els.viewSummary.scrollTop = 0;

  const grounded = r.files.length || r.pins.some((p) => String(p.location || "").trim()) || r.patches.some((p) => String(p.location || "").trim());
  if (!grounded) {
    currentReport.ai = {
      headline: "No source files were shared for this review.",
      findings: [],
      unresolved: [],
      next_steps: ["Upload the relevant source file or paste the code snippet to get a grounded review."],
    };
    currentReport.status = "ready";
    renderReport(currentReport);
    return;
  }

  renderReport(currentReport);
  fetchSummary(r)
    .then((ai) => {
      if (seq !== reportSeq) return;
      currentReport.ai = normalizeSummary(ai);
      currentReport.status = "ready";
      renderReport(currentReport);
    })
    .catch((err) => {
      console.error(err);
      if (seq !== reportSeq) return;
      currentReport.status = "failed";
      renderReport(currentReport);
    });
}

els.copyReportBtn.addEventListener("click", () => {
  if (currentReport) copyText(reportMarkdown(currentReport), els.copyReportBtn);
});
els.downloadReportBtn.addEventListener("click", () => {
  if (!currentReport) return;
  const stamp = currentReport.endedAt.toISOString().slice(0, 16).replace(/[T:]/g, "-");
  const url = URL.createObjectURL(new Blob([reportMarkdown(currentReport)], { type: "text/markdown" }));
  const a = el("a");
  a.href = url;
  a.download = `code-review-${stamp}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
els.newSessionBtn.addEventListener("click", () => {
  reportSeq++; // drop any summary still in flight
  currentReport = null;
  showStartView();
});

// ---------- session lifecycle ----------
async function startSession() {
  clearError();
  setStartBusy("Choose a screen to share…");
  resetSessionRecord(selectedMode());

  try {
    // Screen first: Chrome only allows getDisplayMedia while the click's user
    // activation is fresh, so nothing slow (like a cold-start token call) goes before it.
    const grabFrame = await startScreenShare();

    setStartBusy("Allow the microphone…");
    await startMic((chunk) => {
      if (session.paused || session.muted) return;
      send({ realtimeInput: { audio: { mimeType: `audio/pcm;rate=${IN_SAMPLE_RATE}`, data: floatToPcm16Base64(chunk) } } });
    });

    setStartBusy("Connecting to CodeAssist…");
    const { token, model } = await mintToken();
    session.ws = await openSocket(token, model, null);
    session.active = true;
    await initPlayback();

    session.frameTimer = setInterval(() => {
      if (session.paused) return;
      const frame = grabFrame();
      if (frame) send({ realtimeInput: { video: { mimeType: "image/jpeg", data: frame } } });
    }, SCREEN_FRAME_MS);

    // Fresh live view
    session.startedAt = Date.now();
    els.transcript.replaceChildren();
    clearPin();
    setMuted(false);
    setPaused(false);
    toggleTypeRow(false);
    setLiveState("live");
    renderFollowing();
    const mode = MODES[session.mode].label;
    const watching = session.sourceLabel === "Entire screen" ? "your entire screen" : session.sourceLabel;
    els.liveMode.textContent = mode;
    logEvent(`Session started in ${mode} mode, watching ${watching}`);
    addNote(`CodeAssist is watching ${watching} in ${mode} mode. Start talking whenever you're ready. Paste or drop a file to share the exact code.`);

    els.timer.textContent = "00:00";
    session.clockTimer = setInterval(() => (els.timer.textContent = elapsed()), 1000);
    showView("live");

    let firstFrame = grabFrame();
    for (let attempt = 0; !firstFrame && attempt < 10; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      firstFrame = grabFrame();
    }
    if (firstFrame) {
      send({ realtimeInput: { video: { mimeType: "image/jpeg", data: firstFrame } } });
    }
    addNote(`CodeAssist is starting the ${mode} review.`);
    logEvent(`CodeAssist started the ${mode} review`);
    send({ realtimeInput: { text: OPENING_PROMPTS[session.mode] } });
  } catch (err) {
    console.error(err);
    stopSession();
    showStartView();
    if (err.name === "NotAllowedError") {
      showError("CodeAssist needs your screen and microphone. Allow both to start a session.");
    } else if (err.name === "NotSupportedError" || /not supported/i.test(err.message || "")) {
      showError("This browser cannot share your screen. Open http://localhost:8000 in desktop Chrome or Edge to start a review.");
    } else if (err.name !== "AbortError") {
      showError(err.message);
    }
  }
}

// Ends a live session and shows the review report (or the start view if
// nothing happened worth reporting).
function endSession() {
  if (!session.active) return;
  logEvent("Session ended");
  const report = captureReport();
  stopSession();
  if (report.transcript.length || report.pins.length || report.patches.length) showReport(report);
  else showStartView();
}

// Tears down capture, playback and the socket. Doesn't change the view.
function stopSession() {
  session.active = false;
  clearInterval(session.frameTimer);
  clearInterval(session.clockTimer);
  cancelAnimationFrame(session.meterRaf);
  session.frameTimer = session.clockTimer = session.meterRaf = null;

  const ws = session.ws;
  session.ws = null;
  if (ws && ws.readyState <= WebSocket.OPEN) ws.close(1000);

  session.micAnalyser?.disconnect();
  session.worklet?.disconnect();
  session.micSource?.disconnect();
  session.micCtx?.close();
  session.micStream?.getTracks().forEach((t) => t.stop());
  session.screenStream?.getTracks().forEach((t) => t.stop());
  els.screenVideo.srcObject = null;
  els.viewLive.classList.remove("is-dropping");

  stopPlayback();
  session.playCtx?.close();

  session.micAnalyser = session.worklet = session.micSource = session.micCtx = session.micStream = null;
  session.screenStream = session.playCtx = null;
  session.speaking = null;
}

renderModes();
els.startBtn.addEventListener("click", startSession);
els.endBtn.addEventListener("click", () => endSession());
window.addEventListener("pagehide", () => stopSession());
