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
| Hosting | Netlify |
| AI Moderator | Anthropic Claude Haiku (`claude-haiku-4-5-20251001`) |
| Text-to-Speech | ElevenLabs (`eleven_turbo_v2_5`) |
| Speech-to-Text | ElevenLabs Scribe v2 (natural cut points) |
| Music | Wavlake API (Bitcoin Lightning Top Charts) |
| Podcasts | PodcastIndex API + RSS Feeds via Fountain.fm |
| Music Playback | **Howler.js v2.2.4** (replaces HTMLAudioElement for music) |
| Payments | Bitcoin Lightning / Value4Value (Nostr/Zaps via useZaps.ts) |

---

## Netlify Setup

- **Auto-Deploy: DISABLED** — always publish manually after push!
- Deploys → Trigger deploy → Deploy project → "Publish deploy"
- Always: `git add -A && git commit -m "..." && git pull --rebase && git push`
- NEVER use `--force`

### Netlify Environment Variables

| Variable | Type | Usage |
|---|---|---|
| `ELEVENLABS_API_KEY` | Server-side (no VITE_) | TTS + STT via Netlify Function |
| `VITE_ELEVENLABS_VOICE_ID` | Client-side | Default voice ID (English) |
| `VITE_ELEVENLABS_VOICE_ID_DE` | Client-side | German voice ID: `87AwpS6yC86wa2WglbsK` |
| `ANTHROPIC_API_KEY` | Server-side (no VITE_) | Claude Moderator via Netlify Function |
| `PODCASTINDEX_API_KEY` | Server-side | PodcastIndex API |
| `PODCASTINDEX_API_SECRET` | Server-side | PodcastIndex API |
| `SECRETS_SCAN_ENABLED` | Build | `false` |

---

## Netlify Functions (Server-side Proxies)

```
/.netlify/functions/claude-proxy     → Anthropic API
/.netlify/functions/podcast-proxy    → PodcastIndex + RSS + ElevenLabs TTS/STT
  actions:
    action=search        PodcastIndex search
    action=trending      Trending podcasts
    action=feed          RSS Feed fetch (CORS-safe)
    action=text          Transcript fetch (CORS-safe)
    action=tts           ElevenLabs Text-to-Speech (server-side key)
    action=stt           ElevenLabs Scribe v2 Speech-to-Text
    action=audioresolver Follows audio URL redirects, returns final CDN URL
```

---

## Important Files

```
src/
├── hooks/
│   ├── useRadioModerator.ts      # AI Moderator (Claude), prompts, language
│   ├── usePodcastFeeds.ts        # RSS feed fetching, transcript URL parsing
│   ├── usePodcastSegmenter.ts    # Podcast interruption logic, Scribe, chapters
│   ├── usePodcastIndex.ts        # PodcastIndex API, fetchSuggestedPodcasts
│   ├── useWavlakeTracks.ts       # Wavlake API, weighted shuffle, ambient pool
│   ├── useElevenLabs.ts          # TTS via Netlify Proxy, language-aware voice
│   │                               ttsAudio singleton — unlocked lazily inside
│   │                               unlockTTSAudio() called from touchend handler
│   ├── useListenerMemory.ts      # localStorage memory (songs, podcasts, topics)
│   └── useZaps.ts                # Bitcoin Lightning / Nostr Zaps
├── pages/
│   ├── RadioPage.tsx             # Main page, loop logic, jingles, transitions
│   │                               howlRef + nextHowlRef = Howler music playback
│   │                               bridgeHowlRef = ambient bridge Howl
│   │                               _introHowl + _returnHowl = jingle Howls
│   │                               crossfadeTimerRef = cancelled on podcast slot
│   ├── SettingsPage.tsx          # Settings incl. Song Graveyard
│   └── SetupPage.tsx             # Onboarding (language → name → genres → podcasts)
netlify/functions/
├── claude-proxy.mjs
└── podcast-proxy.mjs
public/
├── podcast-intro.mp3             # Jingle: AFTER moderator intro, BEFORE podcast
├── studio-return.mp3             # Jingle: IMMEDIATELY when podcast stops
├── manifest.webmanifest          # PWA manifest (valid JSON)
├── sw.js                         # Service worker — network-first for HTML,
│                                   stale-while-revalidate for assets
│                                   cache key: pr-shell-v2
│                                   on activate: deletes old caches + broadcasts RELOAD
├── icon-192.png                  # PWA icon (purple placeholder)
└── icon-512.png                  # PWA icon (purple placeholder)
```

---

## Features (Live)

### Music (via Howler.js)
- Wavlake Top Charts (Bitcoin Lightning music, V4V)
- Auto-shuffle on load (Fisher-Yates after full API load)
- Weighted shuffle: liked songs 2x, consecutive duplicate guard
- Like (♥) / Dislike (✕) → Song Graveyard in Settings
- Crossfade between songs via Howler fade()
- Duck effect: howl.fade(vol, 0.08, 300ms) — works iOS + Desktop
- Ambient bridge: Howler instance, ducked during moderator speech

### Podcasts
- PodcastIndex RSS feeds (CORS-safe via proxy)
- Round-robin queue (5 episodes per feed, 15 total)
- Green checkmark ✓ for transcript-ready episodes
- Drag-to-reorder queue
- Resume position saved (pr:podcast-position)
- Manual play/pause + ±30s skip
- Audio URL resolver: follows redirects server-side
- canplay wait before pod.play() on iOS

### AI Moderator
- Claude Haiku generates ALL text — NO hardcoded strings
- Language-aware: 🇩🇪 Deutsch / 🇬🇧 English / 🇫🇷 Français
- ElevenLabs TTS via server-side proxy
- Expressive tags (turbo_v2_5 ONLY): `[laughs]` `[excited]` `[sighs]` `[whispers]` `[slow]`
- ⚠️ NEVER use: `[pause]` `[rushed]` `[drawn out]` — v3-only, spoken aloud on turbo!

### Podcast Interruption (THE Killer Feature)
- Strategy A: chapters + transcript → natural cut point at sentence end + pause ≥1.5s
- Strategy B: no chapters → Scribe lookahead, largest pause in 20-40s window
- Context Tier 1: transcript window | Tier 2: chapters + description | Tier 3: description

### Transitions & Jingles
- Ambient bridge: Howler, ducked during moderator (bridgeHowlRef in duck effect)
- `_introHowl`: podcast-intro.mp3 — AFTER moderator, BEFORE podcast (Howler, iOS-safe)
- `_returnHowl`: studio-return.mp3 — IMMEDIATELY when podcast stops (Howler, iOS-safe)
- crossfadeTimerRef: cleared when podcast slot fires

### PWA
- Installable on iOS + Android homescreen
- Network-first SW, auto-reload on new deploy
- iOS: Safari → Share → "Add to Home Screen"

### iOS Audio (current state)
- Music ✅ | Crossfades ✅ | Moderator TTS ✅
- Duck effect: howl.fade(vol, 0.08, 300ms) ✅ logs correctly
- Ambient ducking ✅ | Jingles via Howler ✅
- Podcast audio: ⚠️ **UNTESTED** — ElevenLabs credits exhausted
- ⚠️ ElevenLabs Starter (30K/month) depleted March 2026, resets ~April 9

---

## 🗺️ Roadmap

### Phase 1 — Polish before demo (CURRENT)

**Next up when credits reset:**
- [ ] Test iOS podcast audio — does it play?
- [ ] Test duck effect audibly on iOS
- [ ] Fix: slow initial load — lazy-load podcast chapters (only when episode about to play)
- [ ] Fix: play button spins too long on first PWA open
- [ ] Fix: manual podcast start from queue (play button in queue broken)
- [ ] Replace placeholder icons with real PR artwork
- [ ] Record 60s demo video of podcast interruption feature

### Phase 2 — User API Keys (URGENT before public launch)
- [ ] Settings: user enters own ElevenLabs API key
- [ ] Settings: user enters own Anthropic API key
- [ ] Keys in localStorage, passed to proxy functions
- [ ] Prevents depleting shared keys during testing

### Phase 3 — Nostr Integration
- [ ] npub input in Setup/Settings
- [ ] Fetch user profile from npub → moderator context
- [ ] Migrate listener memory → Nostr NIP-78
- [ ] NWC for Lightning payments

### Phase 4 — API Cost Model (V4V)
- [ ] Stream sats via NWC to cover shared API costs

### Phase 5 — First Public Launch on Nostr
- [ ] Test with friends first
- [ ] Consider new project name
- [ ] Write README
- [ ] Publish on Nostr, tag podcast hosts

### Phase 6 — OpenSats Grant
- [ ] Apply at https://opensats.org

### Phase 7 — Scale
- [ ] Outreach Bot, Wavlake playlist export, native app

---

## Git Tags (Restore Points)
- `v1.0-pre-pwa` — stable desktop, before PWA
- `v1.0-pre-howler` — PWA working, before Howler migration

---

## ElevenLabs

| Service | Model | Cost |
|---|---|---|
| TTS | `eleven_turbo_v2_5` | 0.5 credits/char |
| STT | `scribe_v2` | per minute |

**⚠️ Credits:** Starter = 30K/month. Depleted March 2026. Resets ~April 9.
Consider Creator Plan (100K/month, $22) for heavy testing.

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

**Duck pattern:**
```js
// isSpeaking=true:
if (howl.volume() > 0.2) howl.fade(howl.volume(), 0.08, 300)
if (bridge?.volume() > 0.2) bridge.fade(bridge.volume(), 0.08, 300)

// isSpeaking=false:
howl.fade(0.08, 0.9, 2000)
bridge?.fade(DUCK_LEVEL, BRIDGE_VOLUME, 2000)  // BRIDGE_VOLUME = 0.3
```

**iOS unlock chain (touchend handler):**
1. `_audioCtx = new AudioContext()` → warm up
2. `Howler.ctx?.resume()` → unlock Howler's internal context
3. `unlockTTSAudio()` → create + unlock ttsAudio singleton lazily
4. `podAudioRef` pre-unlock via muted play/pause

---

## Workflow for New Chat Sessions

```
1. Paste this file as context
2. Check: https://github.com/hiyahlowes/personal-radio
3. Look at Roadmap — what's next?
4. Always: git add -A && git commit -m "..." && git pull --rebase && git push
5. NEVER --force
6. After push: manually publish on Netlify
```

---

*Last updated: March 2026*
*Current phase: Phase 1 — iOS testing blocked by ElevenLabs credit exhaustion*
*Next session: test iOS podcast audio once credits reset (~April 9), then lazy-load chapters*
