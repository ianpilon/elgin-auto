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
const SYSTEM_PROMPT_BASE =
  "You are Elgin Auto Sales and Service's AI booking assistant, taking a service appointment over the phone. " +
  "Elgin Auto is a trusted local auto repair shop in Cambridge, Ontario, phone 519-622-7312, that services any make or model. " +
  "It handles: oil changes, engine repairs, wheel alignments, tires (changes, rotation, balancing, inspection), " +
  "A/C repairs, and technical diagnostics including check-engine-light codes. " +
  "If asked for the shop's phone number, give 519-622-7312. " +
  "Speak warmly and naturally with contractions, never stiff or robotic. If the caller asks whether you're a bot, " +
  "a person, or AI, say plainly that you're the shop's AI booking assistant. " +
  "You have ALREADY greeted the caller, told them Paul and Walter are busy on a car so you're covering the phones, " +
  "taken the caller's name, and asked what they need. Do NOT greet again or ask their name again. " +
  "The caller is now telling you what they need. Decide if it's ROUTINE (oil change, tires, alignment, A/C, basic " +
  "diagnostics) or COMPLEX (engine or transmission work, major or unclear problems). " +
  "If routine: collect the details one at a time, in this order: their vehicle (year, make, model), a preferred day " +
  "and time, then their phone number for the text confirmation. Then warmly confirm the appointment in one sentence " +
  "and say Paul and Walter will text to confirm. " +
  "If complex: ask for a short description of the problem and their phone number, then say you'll pass it to Paul and " +
  "Walter to call them back. " +
  "Keep each reply to one short sentence (about 12 words). Use the caller's name naturally when it fits. Acknowledge " +
  "what they just said, then ask for the next detail, one at a time. No lists, markdown, or stiff phrasing.";

// Language is chosen by which button starts the call (English vs Portuguese).
const LANG_CLAUSE = {
  en: " Respond only in English.",
  pt: " Responda sempre em português, de forma natural e cordial, e diga os nomes dos serviços em português.",
};
const GREETINGS = {
  en: "Thanks for calling Elgin Auto Sales and Service. I'm the shop's AI booking assistant. Paul and Walter are both working on a car right now, so I'm covering the phones. Can I get your name?",
  pt: "Obrigado por ligar para a Elgin Auto Sales and Service. Sou o assistente de inteligência artificial da oficina e posso marcar o seu serviço agora mesmo. Em que posso ajudar hoje?",
};
// Second beat of the English intro, spoken after the caller gives their name (exact copy, not LLM-generated).
const GREETING_PART2_EN =
  "I've got access to the openings on the shop's calendar. What are you looking to get serviced today?";
const STT_LANG = { en: "en", pt: "pt" };
let currentLang = "en";

// English voice (Deepgram Aura-2). Sent per-request so we can A/B voices with NO worker redeploy.
// Precedence: ?voice= URL param > RESERVE_CONFIG.englishVoice > worker default.
let englishVoice =
  new URLSearchParams(location.search).get("voice") ||
  (window.RESERVE_CONFIG && window.RESERVE_CONFIG.englishVoice) ||
  "";

// Portuguese runs on Vapi (native pt-PT voice via the paid Vapi account). English stays on the stack above.
const VAPI_PUBLIC_KEY = (window.RESERVE_CONFIG && window.RESERVE_CONFIG.vapiPublicKey) || "";
const VAPI_PT_ASSISTANT = (window.RESERVE_CONFIG && window.RESERVE_CONFIG.vapiPtAssistant) || "a4e944db-7ada-4b06-a906-9d71f9e19967";
let vapi = null;          // lazy-loaded Vapi web client
let vapiActive = false;   // true while a Vapi (Portuguese) call is running
let activeBtn = null;     // the button that started the current call (others hide during it)

// ---- state ----
const LABELS = { idle: "Talk to the AI in Your Browser", connecting: "Loading…", active: "End Call", error: "Try Again" };
let state = "idle";
let vadObj = null;
let micStream = null;
let history = [];
let callActive = false;
let introPart2Pending = false; // true between the name question and the scripted second intro beat (English)
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
  const hideOthers = (s === "connecting" || s === "active") && activeBtn; // one call running → show only its button
  document.querySelectorAll(".vapi-call-btn").forEach((btn) => {
    btn.dataset.state = s;
    const label = btn.querySelector(".vapi-label");
    if (label) label.textContent = s === "idle" ? (btn.dataset.idle || LABELS.idle) : (LABELS[s] || LABELS.idle);
    btn.classList.toggle("vapi-hidden", hideOthers && btn !== activeBtn);
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
  // Spoken-only respelling: Deepgram reads "Elgin" as soft-g "el-jin"; "Elghin" forces the
  // correct hard g. This affects the audio only — the on-screen transcript keeps "Elgin".
  const spoken = text.trim().replace(/\bElgin\b/gi, "Elghin");
  try {
    const res = await fetch(TTS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: spoken, lang: currentLang, ...(currentLang === "en" && englishVoice ? { voice: englishVoice } : {}) }),
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
    body: JSON.stringify({ messages: [{ role: "system", content: SYSTEM_PROMPT_BASE + LANG_CLAUSE[currentLang] }, ...history] }),
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
  const res = await fetch(STT_URL + "?lang=" + STT_LANG[currentLang], { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: encodeWav(f32) });
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

  // First English reply is the caller's name → speak the scripted second intro beat (exact copy),
  // record both turns in history, then hand the rest off to the LLM. No LLM call this turn.
  if (introPart2Pending && currentLang === "en") {
    introPart2Pending = false;
    history.push({ role: "user", content: text });
    history.push({ role: "assistant", content: GREETING_PART2_EN });
    agentSpeechText = GREETING_PART2_EN;
    rvStatus("speaking", true);
    await enqueueSpeech(GREETING_PART2_EN, gen);
    if (gen === turnGen) rvStatus("listening", true);
    processing = false;
    return;
  }

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
async function startCall(lang) {
  currentLang = lang === "pt" ? "pt" : "en";
  setState("connecting");
  try { micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
  catch (e) { logError("mic", e); setState("error"); return; }
  try { vadObj = await loadVAD(); } catch (e) { logError("vad", e); setState("error"); return; }

  callActive = true; history = []; turnGen = 0;
  introPart2Pending = true; // the caller's first reply is their name → triggers the scripted second beat
  setState("active");
  rvReset();

  // Speak the greeting with the mic NOT yet listening, so the VAD can't trip and invalidate it.
  const gen = ++turnGen;
  const greeting = GREETINGS[currentLang];
  agentSpeechText = greeting; // so the echo-matcher recognizes the greeting bouncing back
  await enqueueSpeech(greeting, gen); // greeting bubble appears when it starts speaking (in playAudio)
  history.push({ role: "assistant", content: greeting });

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
  introPart2Pending = false;
  stopAgent();
  if (vadObj) { try { vadObj.pause(); } catch {} }
  if (micStream) { try { micStream.getTracks().forEach((t) => t.stop()); } catch {} micStream = null; }
  setState("idle");
  rvStatus("standby", false);
}

// ---- Portuguese call via Vapi (native pt-PT voice; Vapi runs its own STT/LLM/TTS loop) ----
async function startVapi() {
  if (!VAPI_PUBLIC_KEY) { logError("vapi", "missing public key"); setState("error"); return; }
  setState("connecting");
  try {
    if (!vapi) {
      const mod = await import("https://esm.sh/@vapi-ai/web");
      const Vapi = mod.default || mod.Vapi || mod;
      vapi = new Vapi(VAPI_PUBLIC_KEY);
      vapi.on("call-start", () => { vapiActive = true; setState("active"); rvReset(); rvStatus("listening", true); });
      vapi.on("call-end", () => { vapiActive = false; setState("idle"); rvStatus("standby", false); });
      vapi.on("speech-start", () => rvStatus("speaking", true));   // assistant speaking
      vapi.on("speech-end", () => rvStatus("listening", true));
      vapi.on("message", (m) => {
        if (m && m.type === "transcript" && m.transcriptType === "final" && m.transcript) {
          rvBubble(m.role === "user" ? "user" : "bot", m.transcript);
        }
      });
      vapi.on("error", (err) => {
        logError("vapi", err);
        // The Vapi SDK fires a transient error on cold start even when the call connects fine.
        // Only surface a fatal UI error if no call is live or being established; real failures
        // still reject vapi.start() (handled below) or arrive as call-end, which resets the UI.
        if (vapiActive || state === "connecting") return;
        setState("error");
      });
    }
    await vapi.start(VAPI_PT_ASSISTANT);
  } catch (e) { logError("vapi-start", e); setState("error"); }
}

function stopVapi() {
  try { if (vapi) vapi.stop(); } catch {}
  vapiActive = false;
  setState("idle");
  rvStatus("standby", false);
}

async function handleClick(e) {
  if (state === "connecting") return;
  if (state === "active") return vapiActive ? stopVapi() : endCall();
  const btn = e && e.currentTarget;
  activeBtn = btn || null;                  // remember which button started it (others hide)
  const lang = btn && btn.dataset ? btn.dataset.lang : "en";
  if (lang === "pt") return startVapi();   // Portuguese → Vapi
  await startCall("en");                    // English → built-in stack
}

document.querySelectorAll(".vapi-call-btn").forEach((btn) => btn.addEventListener("click", handleClick));

// ---- localhost-only English voice picker — audition Aura-2 voices live; never renders on the deployed demo ----
(function voicePicker() {
  if (!["localhost", "127.0.0.1"].includes(location.hostname)) return;
  const VOICES = [
    "aura-2-orion-en", "aura-2-arcas-en", "aura-2-hermes-en", "aura-2-zeus-en",
    "aura-2-mars-en", "aura-2-orpheus-en", "aura-2-apollo-en", "aura-2-draco-en",
    "aura-2-cordelia-en", "aura-2-hera-en", "aura-2-athena-en", "aura-2-luna-en", "aura-2-vesta-en",
  ];
  if (!englishVoice) englishVoice = "aura-2-orion-en";
  const wrap = document.createElement("div");
  wrap.style.cssText = "position:fixed;bottom:12px;left:12px;z-index:9999;background:#111;color:#fff;border:1px solid #333;border-radius:8px;padding:8px 10px;font:12px system-ui,sans-serif";
  wrap.innerHTML = '<label style="display:block;margin-bottom:4px;opacity:.7">English voice (local test)</label>';
  const sel = document.createElement("select");
  sel.style.cssText = "background:#000;color:#fff;border:1px solid #444;border-radius:6px;padding:4px 6px";
  VOICES.forEach((v) => {
    const o = document.createElement("option");
    o.value = v; o.textContent = v.replace("aura-2-", "").replace("-en", "");
    if (v === englishVoice) o.selected = true;
    sel.appendChild(o);
  });
  sel.addEventListener("change", () => { englishVoice = sel.value; console.log("[voice] English voice →", englishVoice); });
  wrap.appendChild(sel);
  const mount = () => document.body.appendChild(wrap);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
})();
