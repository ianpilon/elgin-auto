# Elgin Auto — browser voice agent (Groq + Deepgram), no Vapi

A voice booking desk that takes auto-service appointments in the browser. Instant load (nothing heavy downloads), fast, and effectively free to run for a long time.

## Stack
- **Listen:** Silero VAD in-browser (free) carves each utterance → **Groq Whisper** (`whisper-large-v3-turbo`) transcribes it, via the Worker
- **Think:** **Groq** `llama-3.3-70b-versatile` (streamed) via the Worker
- **Speak:** **Deepgram Aura-2** (`aura-2-arcas-en`, American male) via the Worker — hosted, ~0.3s, nothing downloads to the browser
- **Barge-in:** talk over the agent and it stops, with echo verification so it never cuts itself off
- **Backend:** one Cloudflare Worker (`worker/`) that hides both API keys and serves `/chat`, `/stt`, `/tts`

In-browser libs (CDN `<script>` tags in `index.html`): `onnxruntime-web@1.22.0` + `@ricky0123/vad-web@0.0.29` (small). No TTS model in the browser.

## Cost
- **Groq** (chat + transcription): free tier.
- **Deepgram** (voice): $200 free credit ≈ 200+ hours of speech, then ~1.5¢/1k chars. No per-day cap.

## Deploy / run

### Worker (the backend) — set both secrets, then deploy
```bash
cd worker
npx wrangler login
npx wrangler secret put GROQ_API_KEY       # free key from console.groq.com
npx wrangler secret put DEEPGRAM_API_KEY   # free key from console.deepgram.com ($200 credit)
npx wrangler deploy                         # prints https://elgin-brain.<you>.workers.dev
```
Put that URL in `index.html` → `window.RESERVE_CONFIG.workerUrl`.

### Frontend
- Local test (Chrome): `python3 -m http.server 5500 --bind 127.0.0.1`, open http://127.0.0.1:5500
- Public: `git push` (GitHub Pages serves it). Bump the `?v=` on the `voice.js` tag in `index.html` each deploy so browsers fetch the new build.

## Tuning
- Persona / wording: `SYSTEM_PROMPT`, `GREETING` (in `voice.js`)
- Voice: `TTS_VOICE` in `worker/src/index.js` (any Deepgram Aura model, e.g. `aura-2-thalia-en`)
- Chat model / brevity: `CHAT_MODEL`, `max_tokens` in `worker/src/index.js`
- Turn-end snappiness vs clipping: `redemptionFrames` in `loadVAD` (voice.js)
- Noise/phantom-word rejection: `MIN_RMS`, `MAX_NO_SPEECH`, `MIN_AVG_LOGPROB` (voice.js)

## Not included
Telephony — a real dialable phone number. This is web-mic only. To take phone calls, add Twilio Media Streams in front of the same Worker pipeline.
