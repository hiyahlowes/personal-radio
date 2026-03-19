# Personal Radio (PR) — Project Context

> Paste this file at the start of any new chat session to restore full context.
> Never commit API keys here — use `.env.local` locally or Netlify Dashboard.
> When returning after a break: check the Roadmap section to see what's next.

---

## Project Overview

**Personal Radio (PR)** is an open-source, personalized AI radio station.
- Plays Bitcoin Lightning music (Wavlake Top Charts, Value4Value)
- Intelligently interrupts podcasts with AI moderator comments based on transcript content
- Moderator knows the listener, their preferences, and podcast content
- Built on Podcast 2.0 / Nostr / Lightning principles

**Live:** https://personal-radio.netlify.app
**GitHub:** https://github.com/hiyahlowes/personal-radio

---

## Tech Stack

| Layer | Tech |
|---|---|
| Frontend | React + Vite + TypeScript |
| Hosting | Netlify (Personal Plan, $9/mo) |
| AI Moderator | Anthropic Claude Haiku (`claude-haiku-4-5-20251001`) |
| Text-to-Speech | ElevenLabs (`eleven_turbo_v2_5`) |
| Speech-to-Text | ElevenLabs Scribe v2 (natural cut points) |
| Music | Wavlake API (Bitcoin Lightning Top Charts) |
| Podcasts | PodcastIndex API + RSS Feeds via Fountain.fm |
| Music Playback | **Howler.js v2.2.4** |
| Payments | Bitcoin Lightning / Value4Value (Nostr/Zaps) |

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
- iOS testing: `ios-testing--personal-radio.netlify.app`

**Always work on `dev` branch:**
```
git add -A && git commit -m "..." && git pull --rebase && git push origin dev
```

**To ship to production:**
```
git checkout main && git merge dev && git push origin main
```
Then manually publish in Netlify dashboard.

**For iOS fixes:**
```
git checkout ios-testing && git merge dev && git push origin ios-testing
git checkout dev
```

**NEVER push directly to main during development.**

---

## Netlify Setup

- **Auto-Deploy: ENABLED for dev + ios-testing branches** (free, automatic)
- **Production: Manual publish only** (costs 15 credits)
- Credits: Personal Plan = 1.000 credits/month. Production deploys = 15 credits each.
- ⚠️ ElevenLabs Starter (30K/month) depleted March 2026, resets ~April 9

### Netlify Environment Variables

| Variable | Type | Usage |
|---|---|---|
| `ELEVENLABS_API_KEY` | Server-side | TTS + STT via Netlify Function |
| `VITE_ELEVENLABS_VOICE_ID` | Client-side | Default voice ID (English) |
| `VITE_ELEVENLABS_VOICE_ID_DE` | Client-side | German voice: `87AwpS6yC86wa2WglbsK` |
| `ANTHROPIC_API_KEY` | Server-side | Claude Moderator |
| `PODCASTINDEX_API_KEY/SECRET` | Server-side | PodcastIndex API |
| `SECRETS_SCAN_ENABLED` | Build | `false` |

---

## Netlify Functions + Edge Functions

```
/.netlify/functions/claude-proxy     → Anthropic API
/.netlify/functions/podcast-proxy    → actions: search, trending, feed, text, tts, stt, audioresolver
/podcast-stream                      → Netlify Edge Function: streams podcast audio with CORS headers
                                       Used on iOS only — desktop uses direct CDN URLs
```

---

## Important Files

```
src/
├── hooks/
│   ├── useRadioModerator.ts      # AI Moderator, prompts, language
│   ├── usePodcastFeeds.ts        # RSS feed fetching, audio/mpeg enclosure preference
│   ├── usePodcastSegmenter.ts    # Podcast interruption, Scribe, chapters
│   ├── usePodcastIndex.ts        # PodcastIndex API
│   ├── useWavlakeTracks.ts       # Wavlake API, weighted shuffle, ambient pool
│   ├── useElevenLabs.ts          # TTS via proxy, ttsAudio singleton (lazily unlocked)
│   ├── useListenerMemory.ts      # localStorage memory
│   └── useZaps.ts                # Bitcoin Lightning / Nostr Zaps
├── pages/
│   ├── RadioPage.tsx             # Main page, Howler refs, loop logic
│   │                               iOS: pod.src = /podcast-stream?url=...
│   │                               Desktop: pod.src = direct CDN URL
│   ├── SettingsPage.tsx          # Settings, Song Graveyard
│   └── SetupPage.tsx             # Onboarding
netlify/
├── functions/
│   ├── claude-proxy.mjs
│   └── podcast-proxy.mjs
└── edge-functions/
    └── podcast-stream.ts         # Streams podcast audio, forwards Range headers, adds CORS
public/
├── podcast-intro.mp3 / studio-return.mp3  # Jingles (via Howler)
├── manifest.webmanifest          # PWA manifest
├── sw.js                         # Service worker (network-first, pr-shell-v2)
└── icon-192/512.png              # Purple placeholders
```

---

## Howler.js Architecture

| Ref | Usage |
|---|---|
| `howlRef` | Current music track |
| `nextHowlRef` | Preloaded next track for crossfade |
| `bridgeHowlRef` | Ambient bridge during podcast transition |
| `_introHowl` | podcast-intro.mp3 jingle |
| `_returnHowl` | studio-return.mp3 jingle |
| `crossfadeTimerRef` | setTimeout ID — cleared on podcast slot |
| `musicVolumeRef` | Tracks actual music volume (iOS workaround) |

**Duck pattern:**
- iOS: `howl.pause()` / `howl.play()` (volume control impossible on iOS html5)
- Desktop: `howl.fade(vol, 0.08, 300ms)` / `howl.fade(0.08, 0.9, 2000ms)`

**iOS unlock chain (touchend handler):**
1. `_audioCtx = new AudioContext()` → warm up
2. `Howler.ctx?.resume()` → unlock Howler's internal context
3. `unlockTTSAudio()` → create + unlock ttsAudio singleton lazily
4. `podAudioRef` pre-unlock via silent blob play/pause

---

## Features (Live — Desktop ✅, iOS ⚠️)

### Music
- Wavlake Top Charts, weighted shuffle, Like/Dislike, Song Graveyard
- Crossfade via Howler, Duck via Howler.fade() on desktop
- Ambient bridge pool

### Podcasts
- PodcastIndex RSS, round-robin queue, audio/mpeg enclosure preference
- Transcript-ready episodes prioritized, drag-to-reorder
- Resume position, ±30s skip
- iOS: streams via Edge Function proxy (/podcast-stream)
- Desktop: direct CDN URLs

### AI Moderator
- Claude Haiku, language-aware (🇩🇪🇬🇧🇫🇷)
- All prompt templates written in listener's language (lp() helper)
- German: expressive personality addendum + lower stability (0.25) in voice settings
- Expressive tags: `[laughs]` `[excited]` `[sighs]` `[whispers]` `[slow]`
- ⚠️ NEVER: `[pause]` `[rushed]` `[drawn out]` — spoken aloud on turbo!

### Podcast Interruption
- Strategy A: chapters + transcript → natural cut point
- Strategy B: Scribe lookahead → largest pause in 20-40s window

### PWA
- Installable on iOS/Android, network-first SW, auto-reload on deploy

---

## iOS Status (Known Issues)

| Feature | Status |
|---|---|
| Music playback | ✅ Works |
| Crossfades | ✅ Works |
| Moderator TTS | ✅ Works |
| Duck effect | ⚠️ Pause/Resume (volume control impossible on iOS html5) |
| Podcast audio | ❌ Silent — timeupdate fires correctly but no audio output |
| Jingles | ✅ Via Howler |

**Root cause of podcast silence on iOS:**
iOS routes HTMLAudioElement streams to wrong Audio Session category.
Even via Edge Function proxy with correct CORS headers, no audio output.
This is a fundamental iOS WebKit limitation — not fixable in PWA.
**Solution: Native App (React Native or Swift) after funding.**

---

## 🗺️ Roadmap

### Phase 1 — Launch Desktop (CURRENT)

**Immediate next steps (on `dev` branch):**
- [ ] Replace placeholder icons with real PR artwork
- [ ] Fix: slow initial load — lazy-load podcast chapters
- [ ] Fix: manual podcast start from queue (play button in queue)
- [ ] Record 60s demo video of podcast interruption feature

### Phase 2 — User API Keys (URGENT before public launch)
- [ ] Settings: user enters own ElevenLabs + Anthropic API keys
- [ ] Keys in localStorage, passed to proxy functions

### Phase 3 — Nostr Integration
- [ ] npub input, fetch profile → moderator context
- [ ] Migrate listener memory → Nostr NIP-78
- [ ] NWC for Lightning payments

### Phase 4 — API Cost Model (V4V)
- [ ] ~10.000 sats/month per user, streamed via NWC

### Phase 5 — First Public Launch on Nostr
- [ ] Test with friends, write README, publish on Nostr

### Phase 6 — OpenSats Grant
- [ ] Apply at https://opensats.org

### Phase 7 — Native iOS/Android App (after funding)
- [ ] Solves ALL iOS audio issues permanently
- [ ] Background audio, Lock Screen controls, CarPlay

---

## Git Tags (Restore Points)
- `v1.0-pre-pwa` — stable desktop, before PWA
- `v1.0-pre-howler` — PWA working, before Howler migration

---

## ElevenLabs
- Model: `eleven_turbo_v2_5` (0.5 credits/char)
- STT: `scribe_v2` (per minute)
- ⚠️ Starter 30K/month depleted March 2026. Resets ~April 9 2026.

---

## Workflow for New Chat Sessions

```
1. Paste this file as context
2. git checkout dev (always start on dev!)
3. Check Roadmap — what's next?
4. Develop on dev branch → push to origin dev (free deploys)
5. iOS fixes: merge to ios-testing
6. Production: merge dev to main → push → manual publish in Netlify
```

---

*Last updated: March 2026*
*Current: iOS podcast audio unsolvable in PWA — desktop launch ready*
*Next: Replace icons, lazy-load chapters, record demo video*
