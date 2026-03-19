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

## Netlify Functions

```
/.netlify/functions/claude-proxy     → Anthropic API
/.netlify/functions/podcast-proxy    → actions: search, trending, feed, text, tts, stt, audioresolver
```

---

## Important Files

```
src/
├── hooks/
│   ├── useRadioModerator.ts      # AI Moderator, prompts, language
│   ├── usePodcastFeeds.ts        # RSS feed fetching, transcript URL parsing
│   ├── usePodcastSegmenter.ts    # Podcast interruption, Scribe, chapters
│   ├── usePodcastIndex.ts        # PodcastIndex API
│   ├── useWavlakeTracks.ts       # Wavlake API, weighted shuffle, ambient pool
│   ├── useElevenLabs.ts          # TTS via proxy, ttsAudio singleton (lazily unlocked)
│   ├── useListenerMemory.ts      # localStorage memory
│   └── useZaps.ts                # Bitcoin Lightning / Nostr Zaps
├── pages/
│   ├── RadioPage.tsx             # Main page, Howler refs, loop logic
│   ├── SettingsPage.tsx          # Settings, Song Graveyard
│   └── SetupPage.tsx             # Onboarding
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

**iOS Audio Reality:**
- Howler `html5: true` is required for streaming on iOS
- `html5: true` ignores ALL programmatic volume changes on iOS
  (audio.volume, GainNode, AND Howler.fade() all silently ignored)
- This is an iOS Safari platform restriction, NOT a code bug
- Wavlake CDN has no CORS headers → cannot use Web Audio API
- **Duck effect on iOS: Pause/Resume** (not volume fade)
- **Duck effect on Desktop: Howler.fade()** (works perfectly)

**iOS unlock chain (touchend handler):**
1. `_audioCtx = new AudioContext()` → warm up
2. `Howler.ctx?.resume()` → unlock Howler's internal context
3. `unlockTTSAudio()` → create + unlock ttsAudio singleton lazily
4. `podAudioRef` pre-unlock via muted play/pause

---

## Features (Live — Desktop)

### Music
- Wavlake Top Charts, weighted shuffle, Like/Dislike, Song Graveyard
- Crossfade via Howler fade(), Duck via Howler.fade(0.9→0.08, 300ms)
- Ambient bridge pool

### Podcasts
- PodcastIndex RSS, round-robin queue, transcript-ready episodes prioritized
- Resume position, ±30s skip, drag-to-reorder
- Audio URL resolver (follows redirects)
- canplay wait before pod.play()

### AI Moderator
- Claude Haiku, language-aware (🇩🇪🇬🇧🇫🇷)
- Expressive tags: `[laughs]` `[excited]` `[sighs]` `[whispers]` `[slow]`
- ⚠️ NEVER: `[pause]` `[rushed]` `[drawn out]` — spoken aloud on turbo!

### Podcast Interruption
- Strategy A: chapters + transcript → natural cut point
- Strategy B: Scribe lookahead → largest pause in 20-40s window

### PWA
- Installable on iOS/Android, network-first SW, auto-reload on deploy

---

## iOS Status

| Feature | Status |
|---|---|
| Music playback | ✅ Works |
| Crossfade | ✅ Works |
| Moderator TTS | ✅ Works (after 1-2 opens sometimes) |
| Duck effect | ❌ Pause/Resume needed (volume control impossible on iOS html5) |
| Podcast audio | ❌ Silent — plays technically but no sound output |
| Jingles | ✅ Via Howler |

---

## 🗺️ Roadmap

### Phase 1 — iOS fixes (CURRENT — work on `ios-testing` branch)

**Next session priorities:**
- [ ] **FIX: Podcast audio silent on iOS** — BLOCKER
      Root cause: pod.play() called too far from user gesture chain
      Fix: pre-unlock podAudioRef earlier, or call pod.play() synchronously
      within gesture chain before awaiting TTS/bridge
- [ ] **FIX: Duck effect on iOS** — use Pause/Resume instead of fade()
      When isSpeaking=true on iOS: howl.pause()
      When isSpeaking=false on iOS: howl.play()
      Desktop keeps Howler.fade() as before
      Detect iOS: /iPhone|iPad|iPod/.test(navigator.userAgent)

### Phase 2 — User API Keys (URGENT before public launch)
- [ ] Settings: user enters own ElevenLabs + Anthropic API keys
- [ ] Keys in localStorage, passed to proxy functions
- [ ] Prevents depleting shared keys

### Phase 3 — Nostr Integration
- [ ] npub input, fetch profile → moderator context
- [ ] Migrate listener memory → Nostr NIP-78
- [ ] NWC for Lightning payments

### Phase 4 — API Cost Model (V4V)
- [ ] Stream sats via NWC (~10.000 sats/month per user at 2h/day)

### Phase 5 — First Public Launch on Nostr
- [ ] Test with friends, write README, publish on Nostr

### Phase 6 — OpenSats Grant
- [ ] Apply at https://opensats.org

### Phase 7 — Native App (after funding)
- [ ] React Native or Swift — solves ALL iOS audio issues permanently
- [ ] Background audio, Lock Screen controls, CarPlay

---

## Git Tags (Restore Points)
- `v1.0-pre-pwa` — stable desktop, before PWA
- `v1.0-pre-howler` — PWA working, before Howler migration

---

## ElevenLabs
- Model: `eleven_turbo_v2_5` (0.5 credits/char)
- STT: `scribe_v2` (per minute)
- ⚠️ Starter 30K/month depleted. Resets ~April 9 2026.

---

## Workflow for New Chat Sessions

```
1. Paste this file as context
2. git checkout dev (always start on dev!)
3. Check Roadmap — what's next?
4. Develop on dev branch, push to origin dev (free deploys)
5. iOS fixes: merge to ios-testing, test on ios-testing--personal-radio.netlify.app
6. Production: merge dev to main, push, manual publish in Netlify
```

---

*Last updated: March 2026*
*Current: iOS podcast audio silent + duck effect broken — next session fix these on ios-testing branch*
