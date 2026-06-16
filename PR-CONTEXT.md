# Personal Radio (PR) — Project Context

> Paste this file at the start of any new chat session to restore full context.
> Never commit API keys here — use `.env.local` locally or Netlify Dashboard.
> When returning after a break: check the Roadmap section to see what's next.

---

## Project Overview

**Personal Radio (PR)** is an open-source, personalized AI radio station.
- Plays Bitcoin Lightning music from Wavlake (Value4Value / Top Charts)
- Intelligently interrupts podcasts with AI moderator comments based on transcript content
- Moderator knows the listener, their preferences, and the podcast content
- Built on Podcast 2.0 / Nostr / Lightning principles
- NIP-90 Agent Integration implemented — awaiting stable relay infrastructure

**Live:** https://personal-radio.netlify.app  
**GitHub:** https://github.com/hiyahlowes/personal-radio

---

## Tech Stack

| Layer | Tech |
|---|---|
| Frontend | React + Vite + TypeScript |
| Hosting | Netlify (Personal Plan, $9/mo) |
| AI Moderator | Anthropic Claude Haiku (`claude-haiku-4-5-20251001`) — Fallback |
| AI Moderator (personalized) | NIP-90 Data Vending Machine — each user brings their own agent |
| Text-to-Speech | **Fish Audio S2-Pro** ($15/1M chars, 22x cheaper than ElevenLabs) |
| Speech-to-Text | ElevenLabs Scribe v2 (natural cut points) |
| Music | Wavlake API (Bitcoin Lightning Top Charts) |
| Podcasts | PodcastIndex API + RSS Feeds via Fountain.fm |
| Music Playback | **Howler.js v2.2.4** |
| Payments | Bitcoin Lightning / Value4Value — NWC integration planned |
| NWC Agent | Shakespeare AI (by Alex Gleason, Nostr-trained) |

---

## Branch Workflow (IMPORTANT)

```
main          → Production only. Manual publish in Netlify. Costs 15 credits/deploy.
dev           → Default working branch. All development here. FREE deploys.
ios-testing   → iOS-specific fixes. FREE deploys.
```

**URLs:**
- Production: `personal-radio.netlify.app`
- Dev branch: `dev--personal-radio.netlify.app`

**Always work on `dev` branch:**
```
git add -A && git commit -m "..." && git pull --rebase && git push origin dev
```

**To ship to production:**
```
git checkout main && git merge dev && git push origin main
```
Then manually publish in Netlify dashboard.

**NEVER push directly to main during development.**

---

## Netlify Environment Variables

| Variable | Type | Usage |
|---|---|---|
| `ELEVENLABS_API_KEY` | Server-side | TTS + STT via Netlify Function |
| `FISH_AUDIO_API_KEY` | Server-side | Fish Audio TTS |
| `FISH_AUDIO_VOICE_ID` | Server-side | Fish Audio default voice (English) |
| `FISH_AUDIO_VOICE_ID_DE` | Server-side | Fish Audio default voice (German) |
| `ANTHROPIC_API_KEY` | Server-side | Claude Moderator |
| `PODCASTINDEX_API_KEY/SECRET` | Server-side | PodcastIndex API |
| `SECRETS_SCAN_ENABLED` | Build | `false` |

---

## Netlify Functions + Edge Functions

```
/.netlify/functions/claude-proxy     → Anthropic API
/.netlify/functions/podcast-proxy    → tts, tts-fish, stt, feed, audioresolver etc.
/podcast-stream                      → Edge Function: streams podcast audio (iOS only)
```

---

## TTS — Fish Audio S2-Pro

- Model: `s2-pro` (latest flagship model)
- $15/1M characters (vs ElevenLabs $330/1M) — 22x cheaper
- Free-form emotion tags: `[excited]` `[laughing]` `[whisper]` `[super happy]` `[low conspiratorial voice]` etc.
- German supported (Tier 2) — natural rhythm, no translation artifacts
- Sub-150ms latency with streaming
- Open source: S1-mini on Hugging Face (Apache 2.0) — self-hostable long-term
- ElevenLabs remains available as fallback in Settings

---

## AI Moderator Personality

- Bitcoin maxi, podcast nerd, radio host
- Casual, warm, opinionated — talks like a good friend
- English slang: "bro", "no cap", "fr fr", "goated", "sats don't lie"
- German slang: "Alter", "krass", "ehrlich gesagt", "Sats lügen nicht"
- Emotion tags used generously, 1-2 per sentence max

---

## TTS Pre-Generation Pipeline

Eliminates perceived latency by generating audio ahead of time:

```
Page loads    → Pre-generate greeting immediately (fire-and-forget)
Play pressed  → Play cached greeting instantly (no wait)
Song playing  → Pre-generate next track intro during crossfade
              → Podcast slot known? Pre-generate podcast intro
Podcast runs  → 30s before cut: pre-generate commentary with transcript context
At cut point  → Play pre-generated commentary instantly
```

- Background generation does NOT set isSpeaking (no duck effect!)
- Cache TTL: 5 minutes
- On cache miss: generate immediately as fallback

---

## NIP-90 Personal Agent Integration

### Vision
Every user brings their own AI agent. PR sends job requests (kind 5250) over a Nostr relay, the agent responds (kind 6250), Fish Audio speaks the result. Claude Haiku is the fallback if no agent responds within 3 seconds.

```
User A  → their own agent  → personalized moderation
User B  → their own agent  → personalized moderation
No agent configured → Claude Haiku → standard moderation
```

### Current Status
- ✅ NIP-90 code implemented in PR (useNIP90.ts, useNostrKey.ts)
- ✅ Settings UI: "Connect Your Agent" section
- ✅ PR generates its own Nostr keypair (stored in localStorage)
- ✅ Events published to nos.lol and accepted (relay returns `true`)
- ✅ 3s timeout with silent fallback to Claude Haiku
- ⚠️ Real-time event reception on agent side not yet stable
  → nostr-tools v2 not suitable for persistent subscriptions on Pi/n8n
  → Solution: own strfry relay after OpenSats funding

### PR Nostr Identity
- PR npub: `npub1uslhmx0hvkc9rg7e09z0hhh7qykw7ngd3qwezdc2rtlk08lch75qhvr70h`
- PR pubkey hex: `e43f7d99f765b051a3d97944fbdefe012cef4d0d881d91370a1aff679ff8bfa8`
- Relay: `wss://nos.lol`

### NIP-90 Protocol
- Kind 5250 → Job Request (PR → Agent)
- Kind 6250 → Job Result (Agent → PR)
- `#p` tag → addressed to agent's pubkey
- Content is NIP-04 encrypted

### Personal Agent Setup (Thomas' test agent — TomBot)
- Runs on BTCPay Pi via n8n
- n8n URL: `https://btcpay-pi.tailc45919.ts.net/n8n`
- TomBot npub: `npub1xznm465rd53ckfh0k6sglx7judn6tlw2hen5du3mzh09q5p2w59sdsmwec`
- TomBot hex: `30a7baea836d238b26efb6a08f9bd2e367a5fdcabe6746f23b15de50502a750b`
- tombot-listener: `~/tombot-listener/index.js` on Pi
  → listens for kind 5250, forwards to n8n webhook
  → known issue: nostr-tools subscribeMany does not receive live events reliably

---

## BTCPay Pi Setup

- Hardware: Raspberry Pi 5, 4GB RAM, 2TB NVMe SSD
- OS: Raspberry Pi OS Lite (64-bit)
- User: hi-yah_lowes, Local IP: 192.168.1.187
- Tailscale URL: https://btcpay-pi.tailc45919.ts.net
- Docker services: NBXplorer, BTCPay Server, PostgreSQL, n8n

### Tailscale Funnel
```
/     → BTCPay Server (Port 49392)
/n8n  → n8n (Port 5680)
```

### n8n on the Pi
- URL: https://btcpay-pi.tailc45919.ts.net/n8n
- Port: 5680
- Community nodes: n8n-nodes-nostrobots installed
- TomBot workflow: Telegram chat + NIP-90 receiver (in progress)
- Webhook: /webhook/nip90-job

### tombot-listener
```bash
cd ~/tombot-listener
node index.js  # start manually
```
No systemd service yet — needs to be set up.

---

## Howler.js Architecture

| Ref | Usage |
|---|---|
| `howlRef` | Current music track |
| `nextHowlRef` | Preloaded next track for crossfade |
| `bridgeHowlRef` | Ambient bridge during podcast transition |
| `_introHowl` / `_returnHowl` | Jingles |

Duck pattern — Desktop: `howl.fade()` / iOS: `howl.pause()` + `howl.play()`

---

## iOS Status

| Feature | Status |
|---|---|
| Music + Crossfades | ✅ Works |
| Moderator TTS | ✅ Works |
| Podcast audio | ❌ iOS WebKit limitation — requires native app |

---

## 🗺️ Roadmap

### Step 1 — Fish Audio ✅ DONE

### Step 2 — NWC Integration (NEXT)
- NWC connection string in Settings
- V4V Music → stream sats to Wavlake artists
- V4V Podcast → parse `<podcast:value>` tag from RSS → stream sats to host
- Tool: Shakespeare AI (by Alex Gleason)

### Step 3 — Self-Hosted PR (Pi + Tailscale)
**Vision:** PR runs on your own server, started on-demand via Telegram, streamed to your phone.

**Phase A — Self-Hosted Web App:**
- Deploy PR as a local web app on a Raspberry Pi or VPS
- Tailscale Funnel → phone opens browser → listens
- Solves iOS audio problem completely (audio mixed server-side)
- Telegram Bot starts/stops PR on demand:
  - `/radio` → inline buttons [▶️ Start] [⏹️ Stop]
  - Start → `systemctl start personal-radio` → stream link sent in chat
  - Stop → `systemctl stop personal-radio`
- No 24/7 running cost — on-demand only, no wasted tokens

**Phase B — Audio Stream (Icecast):**
- PR mixes music + TTS server-side into MP3/AAC stream
- Icecast broadcasts the stream → any media player can tune in
- No browser needed — runs in background like a real radio station
- Stream URL delivered via Telegram Bot

**Phase C — Multi-User Self-Hosting:**
- Open source Docker image for easy deployment
- Anyone can self-host PR on their own server
- Documentation: setup guide for Pi, VPS, etc.
- Strong OpenSats argument: full sovereignty, no cloud dependency

### Step 4 — NIP-90 Agent (stable implementation)
- After OpenSats funding
- Own strfry relay on Pi for reliable event routing
- Full agent integration with persistent WebSocket subscriptions

### Step 5 — OpenSats Grant Application
- Target: General Grant $20,000–$40,000 for 6 months
- Milestones: Fish Audio ✅, NWC, NIP-90, Self-Hosting, iOS App, 100 active users
- Do NOT apply in: March, June, September, December (closed periods)
- Apply at: https://opensats.org
- Payout 100% in Bitcoin

### Step 6 — Public Launch + Demo Video
- Record 60s demo showing podcast interruption feature
- Write README
- Launch on Nostr, tag podcast hosts and Wavlake artists

### Step 7 — Native iOS/Android App (after funding)
- Solves all iOS audio issues permanently
- Background audio, Lock Screen controls, CarPlay support

---

## Open Bugs / Minor Issues
- [ ] Replace placeholder icons with real PR artwork
- [ ] SW clone error: `Failed to execute 'clone' on 'Response': body already used`
- [ ] Greeting pre-gen cache miss when play is pressed very quickly
- [ ] Set up tombot-listener as a systemd service on the Pi

---

## Git Tags (Restore Points)
- `v1.0-pre-pwa` — stable desktop build, before PWA
- `v1.0-pre-howler` — PWA working, before Howler.js migration

---

## Workflow for New Chat Sessions

```
1. Paste this file as context
2. git checkout dev
3. Check the Roadmap — what's next?
4. Develop on dev branch → push origin dev (free deploys)
5. Production: merge dev → main → manually publish in Netlify
```

---

*Last updated: March 2026*
*Next step: NWC Integration with Shakespeare AI*
*NIP-90: Code complete, real-time reception to be stabilized after OpenSats funding*
