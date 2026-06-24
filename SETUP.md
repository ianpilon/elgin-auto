# Elgin Auto — browser voice agent (Groq + Deepgram + OpenAI), no Vapi

A bilingual voice booking desk that takes auto-service appointments in the browser. Two buttons: **Talk to the AI in English** and **Talk to the AI in Portuguese**. The chosen language sets the greeting, the LLM's reply language, the transcription language, and the voice. Instant load, fast.

## Stack
- **Listen:** Silero VAD in-browser (free) carves each utterance → **Groq Whisper** (`whisper-large-v3-turbo`) transcribes it. Language is passed per call (`?lang=en|pt`).
- **Think:** **Groq** `llama-3.3-70b-versatile` (streamed); a language clause tells it to answer in English or Portuguese.
- **Speak:**
  - **English** → **Deepgram Aura-2** (`aura-2-arcas-en`), hosted, ~0.3s.
  - **Portuguese** → **ElevenLabs** (`eleven_multilingual_v2`) with a **native European Portuguese (pt-PT) voice**. Deepgram and OpenAI voices only "read" Portuguese with an English/American accent, so the PT button uses ElevenLabs for a real Portuguese tongue.
- **Barge-in:** talk over the agent and it stops, with echo verification so it never cuts itself off.
- **Backend:** one Cloudflare Worker (`worker/`) that hides the keys and serves `/chat`, `/stt`, `/tts`.

> **English works on the shared proxy today.** The Portuguese button only works once Elgin's own worker (with `ELEVENLABS_API_KEY` and a pt-PT voice id) is deployed and its URL is pasted into `index.html`.

In-browser libs (CDN `<script>` tags in `index.html`): `onnxruntime-web@1.22.0` + `@ricky0123/vad-web@0.0.29` (small). No TTS model in the browser.

## Cost
- **Groq** (chat + transcription): free tier.
- **Deepgram** (voice): $200 free credit ≈ 200+ hours of speech, then ~1.5¢/1k chars. No per-day cap.

## Deploy / run

### Worker (the backend) — set secrets, then deploy
```bash
cd worker
npx wrangler login
npx wrangler secret put GROQ_API_KEY       # free key from console.groq.com
npx wrangler secret put DEEPGRAM_API_KEY   # free key from console.deepgram.com ($200 credit)
npx wrangler secret put ELEVENLABS_API_KEY # elevenlabs.io — only the Portuguese voice needs it
npx wrangler deploy                         # prints https://elgin-brain.<you>.workers.dev
```
Put that URL in `index.html` → `window.RESERVE_CONFIG.workerUrl`. Paste keys straight into Wrangler, never back into chat.

**Pick the Portuguese voice:** in the ElevenLabs Voice Library, filter Language = Portuguese, Accent = Portugal (pt-PT), choose a male voice, copy its voice id, and set `ELEVEN_VOICE_ID` in `worker/src/index.js` (replace `REPLACE_WITH_PT_PT_VOICE_ID`), then redeploy.

### Frontend
- Local test (Chrome): `python3 -m http.server 5500 --bind 127.0.0.1`, open http://127.0.0.1:5500
- Public: `git push` (GitHub Pages serves it). Bump the `?v=` on the `voice.js` tag in `index.html` each deploy so browsers fetch the new build.

## Tuning
- Persona / wording / greetings: `SYSTEM_PROMPT_BASE`, `GREETINGS`, `LANG_CLAUSE` (in `voice.js`)
- English voice: `TTS_VOICE` in `worker/src/index.js` (any Deepgram Aura model, e.g. `aura-2-thalia-en`)
- Portuguese voice: `ELEVEN_VOICE_ID` / `ELEVEN_MODEL` in `worker/src/index.js` (use a native pt-PT voice id from the ElevenLabs library)
- Chat model / brevity: `CHAT_MODEL`, `max_tokens` in `worker/src/index.js`
- Turn-end snappiness vs clipping: `redemptionFrames` in `loadVAD` (voice.js)
- Noise/phantom-word rejection: `MIN_RMS`, `MAX_NO_SPEECH`, `MIN_AVG_LOGPROB` (voice.js)

## Not included
Telephony — a real dialable phone number. This is web-mic only. To take phone calls, add Twilio Media Streams in front of the same Worker pipeline.
