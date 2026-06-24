# Elgin Auto — AI Booking Desk demo

A forwardable sales demo: an Elgin Auto-branded landing page that pitches an AI booking desk and lets the prospect talk to it live in the browser. It answers a call, books a service appointment, and shows a live phone-mockup transcript as you speak. Built **without Vapi**, on a cheap, mostly-free stack.

The page is framed as a pitch to Elgin Auto (problem → before/after → response-time research → their own service list, already configured → how it works → timeline → revenue calculator → pricing), with a `pricing.html` page and a "Book a Meeting with Ian" cal.com CTA throughout.

> Cloned from the Kingsway Service Centre demo (itself built on [ReserveVoice-v2](https://github.com/ianpilon/ReserveVoice-v2)) and tailored for Elgin Auto.

## Configured for this shop
- **Elgin Auto Sales & Service Ltd**, 561 Clyde Rd, Cambridge, ON. Owners Paulo (Paul) Figueiredo & Walter Pires.
- **Phone:** (519) 622-7312 (the voice agent will read it out if asked).
- **Services (6):** oil changes, engine repairs, alignments, tires, A/C repairs, technical diagnostics, any make or model.
- **Brand:** black + red (red accent `#d61f26`), matching their logo.
- **Pricing:** $299/mo with a $199 founding rate for the first three months.
- **Hook:** their own job post is hiring an office admin to "answer phones & book customer appointments" — exactly this. The pitch leans on time-back and the Portuguese/English bilingual angle.

## Bilingual (English / Portuguese)
Two buttons start the call in either language. Each sets the greeting, the LLM reply language, the Whisper transcription language, and the voice. **English** uses Deepgram and works on the shared proxy today. **Portuguese** uses OpenAI TTS (Deepgram has no Portuguese voice), so it needs Elgin's own `elgin-brain` worker with an `OPENAI_API_KEY` — see SETUP.md.

## Still to do before production
- Deploy the `elgin-brain` worker (adds `OPENAI_API_KEY`) and point `window.RESERVE_CONFIG.workerUrl` at it — required for the Portuguese button; English already works.
- Connect the booking flow to the shop's real calendar (the agent confirms verbally only today).

## How it works

A full voice loop assembled from parts, no single all-in-one platform:

| Stage | What runs it | Where |
|-------|-------------|-------|
| **Listen** | Silero VAD (turn detection) → **Groq Whisper** `whisper-large-v3-turbo` (transcription) | VAD in browser, Whisper via Worker |
| **Think** | **Groq** `llama-3.3-70b-versatile`, streamed | Worker |
| **Speak** | **Deepgram Aura-2** (`aura-2-arcas-en`) | Worker → browser plays it |
| **Orchestrate** | turn-taking, echo-verified barge-in, noise/phantom-word filtering | browser (`voice.js`) |

The only backend is a single **Cloudflare Worker** (`worker/`) that hides the API keys and exposes `/chat`, `/stt`, `/tts`. It is a generic proxy — the booking persona lives client-side in `voice.js` (`SYSTEM_PROMPT`, `GREETING`). The frontend is static (any static host / GitHub Pages).

### What the assistant books
Full synthetic oil changes (from $45.99), tire services, transmission service, engine repair and diagnostics, brakes and suspension, and A/C and heating repairs. It collects: service needed → vehicle → preferred day/time → name → phone number, then confirms.

### Notable details
- **Instant load** — nothing heavy downloads to the browser (TTS is hosted), so the first visit is immediate, on desktop or phone.
- **Echo-verified barge-in** — you can talk over the assistant; it ducks, checks that what it heard isn't its own voice echoing back, and only then stops.
- **Live transcript** — the hero phone mockup shows the conversation as bubbles, synced to the assistant's speech.
- **Honest by design** — the greeting discloses it's an AI assistant, and it says so plainly if asked.

## Run it yourself
See **[SETUP.md](SETUP.md)** for full steps. In short:

```bash
cd worker
npx wrangler login
npx wrangler secret put GROQ_API_KEY       # console.groq.com (free)
npx wrangler secret put DEEPGRAM_API_KEY   # console.deepgram.com (free $200 credit)
npx wrangler deploy
```
Put the printed Worker URL into `index.html` (`window.RESERVE_CONFIG.workerUrl`), then host the static files.

> The demo currently points at an existing generic proxy worker so it runs out of the box. Deploy your own (above) before going to production.

## Notes / to do
- The cal.com CTA points at `https://cal.com/ian-pilon/physiovoice-20-min-intro-call` — swap it if you want a different scheduling link.
- Pricing is set to **$149/mo flat**; the revenue calculator and pricing page assume a $250 average repair order and 32 missed calls/month. Adjust those in `index.html` / `pricing.html` if you want different numbers.
- The demo points at an existing generic proxy worker so it runs out of the box. Deploy your own (above) for production.
- If you later turn this into Elgin Auto's real customer-facing booking site, connect the booking flow to a real calendar (currently the assistant confirms verbally only).

## Not included
Telephony — a real dialable phone number. This is web-mic only. To take actual phone calls, add Twilio Media Streams in front of the same Worker pipeline.
