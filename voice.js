// voice.js v9 — Deepgram Aura voice (hosted). Instant load (no browser model download), fast synth (~0.3s).
//   Listen : Silero VAD in-browser carves your utterance, Groq Whisper transcribes it (via Worker)
//   Think  : Groq LLM (streamed) via the Worker
//   Speak  : Deepgram Aura via the Worker — nothing downloads in the browser
//   Barge-in: talk over the agent and it stops (echo-verified)
// Requires the onnxruntime-web + vad-web <script> tags in the HTML (global `vad.MicVAD`).

// ---- config ----
const BASE =
  (window.RESERVE_CONFIG && window.RESERVE_CONFIG.workerUrl) || "http://localhost:8787";
const CHAT_URL = BASE + "/chat";
const STT_URL = BASE + "/stt";
const TTS_URL = BASE + "/tts";
const LOG_URL = BASE + "/log";
const SYSTEM_PROMPT =
  "You are Elgin Auto's AI booking assistant, taking a service appointment over the phone. " +
  "Elgin Auto is a trusted local auto repair shop. It services: " +
  "full synthetic oil changes, tires (changes, rotation, balancing, inspection, tread depth), " +
  "wheel alignment, transmission service, engine repair, brakes and suspension, struts and shocks, steering, " +
  "tune-ups and scheduled maintenance, battery testing and replacement, spark plugs, ignition and electrical systems, " +
  "cabin air filters, wiper blades, check-engine-light and electronic diagnostics, and A/C and heating repairs. " +
  "Speak warmly and naturally with contractions, never stiff or robotic. If the caller asks whether you're a bot, " +
  "a person, or AI, say plainly that you're the shop's AI booking assistant. " +
  "Keep each reply to one short sentence (about 12 words). Warmly acknowledge what they just said, then ask for the " +
  "next detail, one at a time, in this order: what service they need, their vehicle (year, make, model), " +
  "a preferred day and time, their name, their phone number. " +
  "When you have all of those, warmly confirm the appointment in one sentence and wrap up. " +
  "If they speak after that, keep it brief and friendly. No lists, markdown, or stiff phrasing.";
const GREETING = "Thanks for calling Elgin Auto. I'm the shop's AI booking assistant, and I can book your appointment right now. What do you need done today?";

// ---- state ----
const LABELS = { idle: "Talk to the AI in Your Browser", connecting: "Loading…", active: "End Call", error: "Try Again" };
let state = "idle";
let vadObj = null;
let micStream = null;
let history = [];
let callActive = false;
let agentSpeaking = false;
let processing = false;
let currentAudioEl = null;
let chatController = null;
let turnGen = 0;
let speakChain = Promise.resolve();
let agentSpeechText = ""; // what the agent is currently saying — used to tell real interruptions from echo
let lastAgentEndTime = 0;  // when the agent last stopped — echo can arrive just after, so we keep guarding briefly

// ---- logging (console only; open DevTools or run RV_DUMP() to inspect timings) ----
let turn = null;
window.RV_LOG = [];
function beaconLog(_msg) { /* disabled in production; timings live in the console + RV_DUMP() */ }
function mark(stage) {
  const since = turn ? Math.round(performance.now() - turn.t0) : 0;
  window.RV_LOG.push({ stage, sinceYouStoppedMs: since });
  console.log(`[voice] +${since}ms  ${stage}`);
  beaconLog(`+${since}ms ${stage}`);
}
function logError(where, e) {
  console.error("[voice]", `ERROR @${where}:`, e && e.message ? e.message : e, e);
  beaconLog(`ERROR @${where}: ${e && e.message ? e.message : e}`);
}
window.RV_DUMP = () => console.table(window.RV_LOG);

function setState(s) {
  state = s;
  document.querySelectorAll(".vapi-call-btn").forEach((btn) => {
    btn.dataset.state = s;
    const label = btn.querySelector(".vapi-label");
    if (label) label.textContent = LABELS[s] || LABELS.idle;
  });
}

// ---- live phone transcript (hero mockup) ----
function rvReset() { const c = document.getElementById("rv-chat"); if (c) c.innerHTML = ""; }
function rvStatus(label, live) {
  const s = document.getElementById("rv-status");
  if (s) { s.classList.toggle("live", !!live); s.innerHTML = `<span class="rv-dot"></span> ${label}`; }
}
function rvBubble(role, text) {
  const c = document.getElementById("rv-chat");
  if (!c || !text || !text.trim()) return;
  const cls = role === "user" ? "user" : "bot";
  const last = c.lastElementChild;
  if (last && last.classList.contains("rv-bubble") && last.classList.contains(cls)) {
    last.textContent = (last.textContent + " " + text).trim();
  } else {
    const d = document.createElement("div");
    d.className = "rv-bubble " + cls;
    d.textContent = text.trim();
    c.appendChild(d);
  }
  c.scrollTop = c.scrollHeight;
}

function beep() {
  try {
    const ctx = beep.ctx || (beep.ctx = new (window.AudioContext || window.webkitAudioContext)());
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = 880; o.connect(g); g.connect(ctx.destination);
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.1, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
    o.start(t); o.stop(t + 0.14);
  } catch {}
}

// ---- Speak (self-hosted Kokoro via Worker), PIPELINED: synth runs ahead of playback ----
// Synthesize a chunk immediately so it's ready (or already in flight) by the time it's its turn to play.
async function synth(text, gen) {
  if (gen !== turnGen || !text.trim()) return null;
  try {
    const res = await fetch(TTS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text.trim() }),
    });
    if (!res.ok) throw new Error("tts " + res.status);
    return await res.blob();
  } catch (e) { logError("tts", e); return null; }
}

async function playAudio(audioPromise, gen, text) {
  const blob = await audioPromise;
  if (!blob || gen !== turnGen) return; // synth failed or barged-in
  const url = URL.createObjectURL(blob);
  const el = new Audio(url);
  currentAudioEl = el;
  agentSpeaking = true;
  el.onplaying = () => {
    rvStatus("speaking", true);
    rvBubble("bot", text); // grow the bubble in sync with the chunk being spoken
    if (turn && !turn.firstAudio) { turn.firstAudio = true; mark("first audio plays (you hear it)"); }
  };
  await new Promise((res) => { el.onended = el.onerror = res; el.play().catch(res); });
  URL.revokeObjectURL(url);
  if (currentAudioEl === el) { currentAudioEl = null; agentSpeaking = false; lastAgentEndTime = performance.now(); }
}

// Kick off synthesis NOW (parallel, ahead of playback); queue playback to happen in order.
function enqueueSpeech(text, gen) {
  const audioPromise = synth(text, gen);
  speakChain = speakChain.then(() => playAudio(audioPromise, gen, text));
  return speakChain;
}

function stopAgent() {
  turnGen++; // invalidate anything queued or playing
  if (chatController) { try { chatController.abort(); } catch {} chatController = null; }
  if (currentAudioEl) { try { currentAudioEl.pause(); currentAudioEl.src = ""; } catch {} currentAudioEl = null; }
  agentSpeaking = false;
}

// ---- Think (Groq LLM via Worker), streamed + chunked, abortable ----
async function think(text, gen) {
  history.push({ role: "user", content: text });
  agentSpeechText = ""; // reset; fills in as this reply streams
  chatController = new AbortController();
  const res = await fetch(CHAT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history] }),
    signal: chatController.signal,
  });
  if (!res.ok || !res.body) throw new Error("chat " + res.status);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", sentence = "", full = "", firstTok = false;
  while (true) {
    const { value, done } = await reader.read();
    if (done || gen !== turnGen) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n"); buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const d = t.slice(5).trim();
      if (d === "[DONE]") continue;
      try {
        const delta = JSON.parse(d).choices?.[0]?.delta?.content || "";
        if (delta && !firstTok) { firstTok = true; mark("LLM first token (Groq replied)"); }
        sentence += delta; full += delta; agentSpeechText = full;
        // Flush on sentence end, or on a comma once we have enough — gets the first audio out faster.
        const flush = /[.!?]["')\]]?\s*$/.test(sentence) || (/,\s*$/.test(sentence) && sentence.trim().length >= 10);
        if (flush && sentence.trim()) { enqueueSpeech(sentence, gen); sentence = ""; }
      } catch {}
    }
  }
  if (gen === turnGen && sentence.trim()) enqueueSpeech(sentence, gen);
  history.push({ role: "assistant", content: full });
  await speakChain; // bubble grows per-chunk in playAudio, synced to speech
  if (gen === turnGen) { mark("done speaking (turn complete)"); rvStatus("listening", true); }
}

// ---- Listen (VAD carves the clip → Groq Whisper transcribes) ----
function encodeWav(f32, rate = 16000) {
  const buffer = new ArrayBuffer(44 + f32.length * 2);
  const v = new DataView(buffer);
  const w = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + f32.length * 2, true); w(8, "WAVE");
  w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, f32.length * 2, true);
  let off = 44;
  for (let i = 0; i < f32.length; i++) { const s = Math.max(-1, Math.min(1, f32[i])); v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true); off += 2; }
  return new Blob([buffer], { type: "audio/wav" });
}

async function transcribe(f32) {
  const res = await fetch(STT_URL, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: encodeWav(f32) });
  if (!res.ok) throw new Error("stt " + res.status);
  const j = await res.json();
  return { text: j.text || "", noSpeechProb: j.noSpeechProb ?? 0, avgLogprob: j.avgLogprob ?? 0 };
}

function rms(f32) { let s = 0; for (let i = 0; i < f32.length; i++) s += f32[i] * f32[i]; return Math.sqrt(s / f32.length); }
const MIN_RMS = 0.003;        // low floor so quiet first words still register; junk caught by confidence gate
const MAX_NO_SPEECH = 0.7;    // Whisper's own "this isn't speech" probability — the reliable junk signal
const MIN_AVG_LOGPROB = -1.8; // only reject truly garbled audio; real short words (e.g. "tomorrow") sit near -1.1
const ECHO_TAIL_MS = 1500;    // keep treating input as possible echo for this long after the agent stops

function unduck() { if (currentAudioEl) { try { currentAudioEl.volume = 1.0; } catch {} } }

// Is the heard text just the agent's own voice echoing back, rather than a real interruption?
function looksLikeEcho(userText, agentText) {
  const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  const u = norm(userText);
  if (u.length === 0) return true;
  const a = new Set(norm(agentText));
  const overlap = u.filter((w) => a.has(w)).length / u.length;
  return overlap >= 0.5; // half+ of the heard words are words the agent is currently saying → echo
}

function onSpeechStart() {
  // Speech detected. If the agent is talking, duck it (instant feedback + quiets echo) but don't
  // cut it yet — onSpeechEnd will verify whether it was really you or just the agent echoing.
  if (agentSpeaking && currentAudioEl) {
    try { currentAudioEl.volume = 0.18; } catch {}
    mark("possible interrupt — ducking");
  }
}

async function onSpeechEnd(f32) {
  if (f32.length < 16000 * 0.3) { unduck(); return; } // ignore <0.3s blips

  // Loudness gate: quiet/distant noise never becomes a turn (and saves an STT call).
  const level = rms(f32);
  if (level < MIN_RMS) { unduck(); mark(`ignored quiet clip (rms ${level.toFixed(3)})`); return; }

  const duringAgent = agentSpeaking || (performance.now() - lastAgentEndTime < ECHO_TAIL_MS);
  const agentText = agentSpeechText;

  let r;
  turn = { t0: performance.now(), firstAudio: false };
  mark(`got your audio (rms ${level.toFixed(3)}), transcribing`);
  try { r = await transcribe(f32); }
  catch (e) { logError("stt", e); unduck(); return; }
  const text = r.text;

  // Confidence gate: reject phantom words / garbled noise Whisper isn't sure about.
  if (r.noSpeechProb > MAX_NO_SPEECH || r.avgLogprob < MIN_AVG_LOGPROB) {
    unduck();
    mark(`ignored low-confidence: "${text}" (nsp ${r.noSpeechProb.toFixed(2)}, lp ${r.avgLogprob.toFixed(2)})`);
    return;
  }

  // If the agent was speaking, was this really you or just its own voice echoing back?
  if (duringAgent && looksLikeEcho(text, agentText)) {
    unduck(); // false alarm — keep talking
    if (text.trim()) mark(`ignored echo: "${text}"`);
    return;
  }
  if (!text.trim()) { unduck(); return; }

  // Real turn (normal or a genuine barge-in): stop the agent and respond.
  stopAgent();
  const gen = turnGen;
  processing = true;
  mark(`heard you: "${text}"`);
  rvBubble("user", text);
  rvStatus("thinking", true);
  try { await think(text, gen); }
  catch (e) { if (!e || e.name !== "AbortError") logError("turn", e); }
  finally { processing = false; }
}

async function loadVAD() {
  if (!window.vad || !window.vad.MicVAD) throw new Error("vad global missing — CDN script not loaded");
  return window.vad.MicVAD.new({
    onSpeechStart,
    onSpeechEnd,
    onVADMisfire: () => { mark("vad misfire — restoring volume"); unduck(); }, // blip wasn't real speech: undo the duck
    stream: micStream,
    // tuning for a snappier, less twitchy feel:
    positiveSpeechThreshold: 0.55, // catch short real words like "hello"; echo is handled by duck+verify
    negativeSpeechThreshold: 0.35,
    redemptionFrames: 10,         // silence frames before end-of-speech; higher avoids clipping trailing words on a pause
    minSpeechFrames: 3,           // ignore ultra-short blips
    preSpeechPadFrames: 2,
    onnxWASMBasePath: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/",
    baseAssetPath: "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.29/dist/",
  });
}

// ---- call control ----
async function startCall() {
  setState("connecting");
  try { micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
  catch (e) { logError("mic", e); setState("error"); return; }
  try { vadObj = await loadVAD(); } catch (e) { logError("vad", e); setState("error"); return; }

  callActive = true; history = []; turnGen = 0;
  setState("active");
  rvReset();

  // Speak the greeting with the mic NOT yet listening, so the VAD can't trip and invalidate it.
  const gen = ++turnGen;
  agentSpeechText = GREETING; // so the echo-matcher recognizes the greeting bouncing back
  await enqueueSpeech(GREETING, gen); // greeting bubble appears when it starts speaking (in playAudio)
  history.push({ role: "assistant", content: GREETING });

  // Let the speakers settle so the greeting's tail isn't captured as the caller's first answer.
  await new Promise((r) => setTimeout(r, 500));

  // Now cue the caller and start listening.
  if (!callActive) return; // user may have hung up during the greeting
  beep();
  vadObj.start();
  rvStatus("listening", true);
}

function endCall() {
  callActive = false;
  stopAgent();
  if (vadObj) { try { vadObj.pause(); } catch {} }
  if (micStream) { try { micStream.getTracks().forEach((t) => t.stop()); } catch {} micStream = null; }
  setState("idle");
  rvStatus("standby", false);
}

async function handleClick() {
  if (state === "connecting") return;
  if (state === "active") return endCall();
  await startCall();
}

document.querySelectorAll(".vapi-call-btn").forEach((btn) => btn.addEventListener("click", handleClick));
