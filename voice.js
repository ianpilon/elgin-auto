// voice.js — both languages run on Vapi (streamed STT + LLM + TTS).
//   English  → VAPI_EN_ASSISTANT (Azure Andrew voice)
//   Portuguese → VAPI_PT_ASSISTANT (Azure Duarte voice)
// The booking persona, greeting, and flow live in each Vapi assistant (server-side), not here.
// This file only wires the call buttons, the live transcript bubbles, and cold-start handling.

const VAPI_PUBLIC_KEY = (window.RESERVE_CONFIG && window.RESERVE_CONFIG.vapiPublicKey) || "";
const VAPI_PT_ASSISTANT = (window.RESERVE_CONFIG && window.RESERVE_CONFIG.vapiPtAssistant) || "a4e944db-7ada-4b06-a906-9d71f9e19967";
const VAPI_EN_ASSISTANT = (window.RESERVE_CONFIG && window.RESERVE_CONFIG.vapiEnAssistant) || "71456e40-dbe6-4ef7-8593-040820ba7d79";

let vapi = null;              // lazy-loaded Vapi web client
let vapiActive = false;       // true while a call is running
let vapiVoiceOverride = null; // {provider, voiceId} set by the localhost voice picker; applied to English calls
let activeBtn = null;         // the button that started the current call (others hide during it)

const LABELS = { idle: "Talk to the AI in Your Browser", connecting: "Loading…", active: "End Call", error: "Try Again" };
let state = "idle";

function logError(where, e) {
  console.error("[voice]", `ERROR @${where}:`, e && e.message ? e.message : e, e);
}

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

// ---- Vapi call control ----
// Create + wire the Vapi client (idempotent). Instantiating does NOT request the mic or start a
// call, so it's safe to pre-warm on load — which avoids the cold-start flakiness on the first click.
async function ensureVapi() {
  if (vapi) return vapi;
  const mod = await import("https://esm.sh/@vapi-ai/web");
  const Vapi = mod.default || mod.Vapi || mod;
  vapi = new Vapi(VAPI_PUBLIC_KEY);
  vapi.on("call-start", () => { vapiActive = true; setState("active"); rvReset(); rvStatus("listening", true); });
  vapi.on("call-end", () => { vapiActive = false; setState("idle"); rvStatus("standby", false); });
  vapi.on("speech-start", () => rvStatus("speaking", true));   // assistant speaking
  vapi.on("speech-end", () => rvStatus("listening", true));
  vapi.on("message", (m) => {
    if (m && m.type === "transcript" && m.transcriptType === "final" && m.transcript) {
      // The English voice is fed "Elghin" so Azure says the hard g; show "Elgin" in the bubble.
      const shown = m.transcript.replace(/\bElghin\b/gi, "Elgin");
      rvBubble(m.role === "user" ? "user" : "bot", shown);
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
  return vapi;
}

async function startVapi(assistantId, overrides) {
  if (!VAPI_PUBLIC_KEY) { logError("vapi", "missing public key"); setState("error"); return; }
  const id = assistantId || VAPI_PT_ASSISTANT;
  setState("connecting");
  try {
    await ensureVapi();
    await vapi.start(id, overrides);
  } catch (e) {
    // Cold-start failures happen on the very first connection; tear down and retry once before erroring.
    logError("vapi-start", e);
    try { if (vapi) vapi.stop(); } catch {}
    vapi = null; vapiActive = false;
    try {
      await ensureVapi();
      await vapi.start(id, overrides);
    } catch (e2) { logError("vapi-start-retry", e2); setState("error"); }
  }
}

function stopVapi() {
  try { if (vapi) vapi.stop(); } catch {}
  vapiActive = false;
  setState("idle");
  rvStatus("standby", false);
}

function handleClick(e) {
  if (state === "connecting") return;
  if (state === "active") return stopVapi();
  const btn = e && e.currentTarget;
  activeBtn = btn || null;                  // remember which button started it (others hide)
  const lang = btn && btn.dataset ? btn.dataset.lang : "en";
  if (lang === "pt") return startVapi(VAPI_PT_ASSISTANT);
  // English: apply the localhost voice picker's choice (if any) via assistantOverrides.
  return startVapi(VAPI_EN_ASSISTANT, vapiVoiceOverride ? { voice: vapiVoiceOverride } : undefined);
}

document.querySelectorAll(".vapi-call-btn").forEach((btn) => btn.addEventListener("click", handleClick));

// Pre-warm the Vapi SDK on load so the first call connects cleanly (avoids cold-start flakiness).
ensureVapi().catch((e) => logError("vapi-prewarm", e));

// ---- localhost-only English voice picker — audition Azure Vapi voices live; never renders on the deployed demo ----
// Switches the English voice per call via Vapi assistantOverrides. Pick a voice, then start an English call.
(function vapiVoicePicker() {
  if (!["localhost", "127.0.0.1"].includes(location.hostname)) return;
  const VOICES = [
    ["en-US-AndrewMultilingualNeural", "Andrew — warm male (default)"],
    ["en-US-BrianMultilingualNeural", "Brian — casual male"],
    ["en-US-GuyNeural", "Guy — confident male"],
    ["en-US-DavisNeural", "Davis — calm male"],
    ["en-US-JasonNeural", "Jason — neutral male"],
    ["en-US-AvaMultilingualNeural", "Ava — warm female"],
    ["en-US-EmmaMultilingualNeural", "Emma — friendly female"],
    ["en-US-JennyNeural", "Jenny — assistant female"],
    ["en-US-AriaNeural", "Aria — professional female"],
    ["en-US-MichelleNeural", "Michelle — pleasant female"],
  ];
  vapiVoiceOverride = { provider: "azure", voiceId: VOICES[0][0] };
  const wrap = document.createElement("div");
  wrap.style.cssText = "position:fixed;bottom:12px;left:12px;z-index:9999;background:#111;color:#fff;border:1px solid #333;border-radius:8px;padding:8px 10px;font:12px system-ui,sans-serif";
  wrap.innerHTML = '<label style="display:block;margin-bottom:4px;opacity:.7">English voice (local test) — start a call to hear it</label>';
  const sel = document.createElement("select");
  sel.style.cssText = "background:#000;color:#fff;border:1px solid #444;border-radius:6px;padding:4px 6px;max-width:260px";
  VOICES.forEach(([id, label]) => {
    const o = document.createElement("option");
    o.value = id; o.textContent = label;
    sel.appendChild(o);
  });
  sel.addEventListener("change", () => { vapiVoiceOverride = { provider: "azure", voiceId: sel.value }; console.log("[voice] English voice →", sel.value); });
  wrap.appendChild(sel);
  const mount = () => document.body.appendChild(wrap);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
})();
