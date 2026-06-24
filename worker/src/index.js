// Elgin Auto "brain" — Cloudflare Worker. Hides the Groq + Deepgram + OpenAI keys and serves these routes:
//   POST /chat        → Groq LLM (streamed reply)
//   POST /stt?lang=   → Groq Whisper (transcribe a WAV clip; lang "en" or "pt", default en)
//   POST /tts {lang}  → English: Deepgram Aura;  Portuguese: ElevenLabs (native European Portuguese voice)
// This is the only backend. Structured so Twilio telephony can be added later.
//
// Deploy:  cd worker && npx wrangler deploy
// Secrets: npx wrangler secret put GROQ_API_KEY
//          npx wrangler secret put DEEPGRAM_API_KEY
//          npx wrangler secret put ELEVENLABS_API_KEY   (only needed for the Portuguese voice)

const GROQ_CHAT = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_STT = "https://api.groq.com/openai/v1/audio/transcriptions";
const DEEPGRAM_TTS = "https://api.deepgram.com/v1/speak"; // fast hosted TTS, nothing downloads in the browser
const ELEVEN_TTS = "https://api.elevenlabs.io/v1/text-to-speech"; // Portuguese (Deepgram/OpenAI lack a native PT voice)
const CHAT_MODEL = "llama-3.3-70b-versatile";      // follows brevity + sounds more natural; ~200ms slower than 8b
const STT_MODEL = "whisper-large-v3-turbo";        // ~$0.04/hr, far better accuracy than browser STT
const TTS_VOICE = "aura-2-arcas-en";               // Deepgram Aura-2, American male (English)
const ELEVEN_MODEL = "eleven_multilingual_v2";     // ElevenLabs multilingual model
// Paste a NATIVE European Portuguese (pt-PT) voice id from the ElevenLabs Voice Library
// (Voices → filter Language = Portuguese, Accent = Portugal). Replace the placeholder below.
const ELEVEN_VOICE_ID = "5tqq6ewvJtcNtaffrqUJ"; // native European Portuguese (pt-PT)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (req.method !== "POST") return new Response("POST only", { status: 405, headers: CORS });

    const path = new URL(req.url).pathname;
    if (path === "/log") return handleLog(req);   // browser beacons timings/errors here so they show in `wrangler tail`
    console.log("REQ", path);
    if (path === "/stt") return handleSTT(req, env);
    if (path === "/tts") return handleTTS(req, env);
    return handleChat(req, env); // default + "/chat"
  },
};

async function handleChat(req, env) {
  let body;
  try { body = await req.json(); } catch { return new Response("Bad JSON", { status: 400, headers: CORS }); }

  const r = await fetch(GROQ_CHAT, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.GROQ_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: CHAT_MODEL,
      messages: body.messages,
      stream: true,
      temperature: 0.4,
      max_tokens: 40,
    }),
  });
  if (!r.ok) return new Response(await r.text(), { status: r.status, headers: CORS });
  return new Response(r.body, { headers: { ...CORS, "Content-Type": "text/event-stream" } });
}

async function handleLog(req) {
  try { const b = await req.json(); console.log("CLIENT", b.msg || JSON.stringify(b)); } catch {}
  return new Response(null, { status: 204, headers: CORS });
}

async function handleTTS(req, env) {
  let body;
  try { body = await req.json(); } catch { return new Response("Bad JSON", { status: 400, headers: CORS }); }
  const text = body.text || "";

  // Portuguese: ElevenLabs with a native European Portuguese voice (Deepgram/OpenAI only "read" PT with an accent).
  if (body.lang === "pt") {
    const r = await fetch(`${ELEVEN_TTS}/${ELEVEN_VOICE_ID}?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "xi-api-key": env.ELEVENLABS_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ text, model_id: ELEVEN_MODEL }),
    });
    if (!r.ok) { const e = await r.text(); console.log("TTS PT ERROR", r.status, e.slice(0, 200)); return new Response(e, { status: r.status, headers: CORS }); }
    return new Response(r.body, { headers: { ...CORS, "Content-Type": "audio/mpeg" } });
  }

  // English: Deepgram Aura (fast, hosted).
  const model = body.voice || TTS_VOICE;
  const r = await fetch(`${DEEPGRAM_TTS}?model=${model}&encoding=mp3`, {
    method: "POST",
    headers: { Authorization: `Token ${env.DEEPGRAM_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!r.ok) { const e = await r.text(); console.log("TTS ERROR", r.status, e.slice(0, 200)); return new Response(e, { status: r.status, headers: CORS }); }
  return new Response(r.body, { headers: { ...CORS, "Content-Type": "audio/mpeg" } });
}

async function handleSTT(req, env) {
  const lang = new URL(req.url).searchParams.get("lang") === "pt" ? "pt" : "en";
  const buf = await req.arrayBuffer(); // raw WAV bytes from the browser
  const fd = new FormData();
  fd.append("file", new Blob([buf], { type: "audio/wav" }), "audio.wav");
  fd.append("model", STT_MODEL);
  fd.append("response_format", "verbose_json"); // gives per-segment confidence so we can reject phantom words
  fd.append("language", lang);

  const r = await fetch(GROQ_STT, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
    body: fd,
  });
  if (!r.ok) return new Response(await r.text(), { status: r.status, headers: CORS });
  const j = await r.json();
  // Summarize Whisper's own confidence across segments (defaults are safe if fields are absent).
  let noSpeechProb = 0, avgLogprob = 0, n = 0;
  if (Array.isArray(j.segments)) {
    for (const s of j.segments) { noSpeechProb = Math.max(noSpeechProb, s.no_speech_prob ?? 0); avgLogprob += (s.avg_logprob ?? 0); n++; }
    if (n) avgLogprob /= n;
  }
  return new Response(JSON.stringify({ text: j.text || "", noSpeechProb, avgLogprob }), {
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
