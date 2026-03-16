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
| Payments | Bitcoin Lightning / Value4Value (Nostr/Zaps via useZaps.ts) |

---

## Netlify Setup

- **Auto-Deploy: DISABLED** — always publish manually after push!
- Deploys → Trigger deploy → Deploy project → "Publish deploy"
- Always `git pull --rebase` before push, NEVER `--force`

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
│   ├── useListenerMemory.ts      # localStorage memory (songs, podcasts, topics)
│   └── useZaps.ts                # Bitcoin Lightning / Nostr Zaps
├── pages/
│   ├── RadioPage.tsx             # Main page, loop logic, jingles, transitions
│   ├── SettingsPage.tsx          # Settings incl. Song Graveyard
│   └── SetupPage.tsx             # Onboarding (language → name → genres → podcasts)
netlify/functions/
├── claude-proxy.mjs
└── podcast-proxy.mjs
public/
├── podcast-intro.mp3             # Jingle: plays AFTER moderator intro, BEFORE podcast
├── studio-return.mp3             # Jingle: plays IMMEDIATELY when podcast stops
├── manifest.webmanifest          # PWA manifest (valid JSON, fixes syntax error)
├── sw.js                         # Service worker for PWA offline support
├── icon-192.png                  # PWA icon (purple placeholder, replace later)
└── icon-512.png                  # PWA icon (purple placeholder, replace later)
```

---

## Features (Live)

### Music
- Wavlake Top Charts (Bitcoin Lightning music, V4V)
- Auto-shuffle on load (Fisher-Yates after full API load)
- Weighted shuffle: liked songs 2x more frequent, consecutive duplicate guard
- Like button (♥) → weighted playback
- Dislike/ban (✕) → Song Graveyard, never plays again
- Song Graveyard in Settings → songs can be resurrected
- Crossfade between songs
- Duck effect: music pauses on iOS (volume read-only), lowers to 0.08 on desktop
- Ambient bridge pool: always fetched in background for podcast transitions

### Podcasts
- PodcastIndex RSS feeds (CORS-safe via proxy)
- Round-robin queue (5 episodes per feed, 15 total)
- Green checkmark ✓ for episodes with transcripts ("Best Experience")
- Transcript episodes prioritized at top of queue
- Settings show curated transcript-ready shows
- Drag-to-reorder podcast queue
- Resume position saved (pr:podcast-position)
- "X:XX left" display in podcast list
- Manual play/pause + +30s / -30s skip buttons
- Audio URL resolver: follows redirects server-side (fixes iOS CORS)

### AI Moderator
- Claude Haiku generates ALL moderation text — NO hardcoded strings
- Language-aware fallbacks in all 3 languages (de/en/fr)
- ElevenLabs TTS via server-side proxy
- Language-aware voice: Deutsch → 87AwpS6yC86wa2WglbsK, others → default
- Languages: 🇩🇪 Deutsch / 🇬🇧 English / 🇫🇷 Français (stored: `pr:language`)
- CRITICAL language rule: always responds in selected language
- Expressive tags (turbo_v2_5 compatible only): `[laughs]`, `[excited]`, `[sighs]`, `[whispers]`, `[slow]`
- NOTE: `[pause]`, `[rushed]`, `[drawn out]` are v3-only — do NOT use with turbo!

### Podcast Interruption (THE Killer Feature)

**Strategy A: Episode has chapters + transcript**
1. 30s before chapter end: `findNaturalCutPoint()` reads transcript
2. Finds sentence ending (. ? !) + gap ≥ 1.5s to next entry
3. Interrupts at natural speech pause, never mid-sentence
4. Context Tier 1: transcript window (±2min around currentTime) ~400 tokens

**Strategy B: No chapters (Scribe Lookahead)**
1. Random target: 8-15 minutes into episode
2. At target-90s: MediaRecorder starts (lookahead phase)
3. At target-30s: 60s audio blob sent to ElevenLabs Scribe v2
4. Scribe returns word-level timestamps → largest pause in 20-40s window
5. Scribe has ~25s buffer before target is reached
6. Fallback: target+30s if Scribe is too slow

**Context Tiers for moderator commentary:**
- Tier 1: Transcript window (what was just said) ✅ best
- Tier 2: Chapter titles + episode description
- Tier 3: Episode description only (fallback)

### Transitions & Jingles
- Ambient bridge: quiet ambient song plays under podcast intro moderation
- `podcast-intro.mp3`: plays AFTER moderator intro, BEFORE podcast
- `studio-return.mp3`: plays IMMEDIATELY when podcast stops, BEFORE commentary
- Post-podcast: next song starts BEFORE commentary (radio always playing)

### Resume-Aware Introductions
- If episode already heard (lastPosition > 60s): "Wir kommen zurück zu..."
- References last known topic from episodeKnowledge
- Max 25 words, never re-introduces as new

### Listener Memory (localStorage)
Key: `pr:listener-memory:{listenerName}`
- Played/skipped/liked/banned songs
- Episode history with topics and resume position
- Recent podcast topics → cross-episode references for moderator
- Cap: 200 songs, 10 chunks per episode

### Episode Knowledge Memory
Key: `pr:episode-knowledge:{episodeId}`
- Saves what moderator has already commented about an episode
- Next session: moderator already knows the episode
- Prevents repeating the same observations

### PWA (Progressive Web App)
- Installable on iOS and Android homescreen
- Works offline (app shell cached via service worker)
- iOS: Safari → Share → "Add to Home Screen"
- theme-color: #7c3aed (purple)
- Icons: purple placeholders — replace with final art before public launch

### iOS Audio (current state)
- Music plays ✅ (via direct HTMLAudioElement, no GainNode)
- Moderator TTS plays ✅
- Podcast plays ✅ (audio URL resolved via proxy to bypass CORS redirects)
- Duck effect: music PAUSES when moderator speaks (not volume fade) ⚠️
- Real ducking requires Howler.js migration (planned)

---

## 🗺️ Roadmap

### Phase 1 — Polish before first public demo (CURRENT)

**Next up: Howler.js Migration**
- [ ] Migrate music playback from HTMLAudioElement to Howler.js
      → Fixes iOS duck effect (real volume fade instead of pause/resume)
      → Works on iOS, Android, Desktop with same code
      → Git tag v1.0-pre-howler already set as restore point
      → Keep podcast element as HTMLAudioElement (separate concern)
      → Keep ElevenLabs TTS as HTMLAudioElement (blob URLs, separate)
      → Keep MediaRecorder/Scribe unchanged

**Before launch:**
- [ ] Replace purple placeholder icons with real PR artwork
- [ ] Fix: language occasionally switches to English for song intros
- [ ] Record 60-second demo video showing the podcast interruption feature
      → Must capture the "holy shit" moment: moderator commenting on what was just said

### Phase 2 — Nostr Integration
- [ ] npub input in Setup and Settings
- [ ] Fetch user profile from npub → moderator context (knows the listener)
- [ ] Fetch user's recent Nostr posts → moderator references them naturally
- [ ] Podcast Nostr profiles → some podcasts have their own npub, use as context
- [ ] Migrate listener memory from localStorage → Nostr (NIP-78 app-specific data)
- [ ] NWC (Nostr Wallet Connect) integration for Lightning payments

### Phase 3 — API Cost Model (Value4Value for infrastructure)
- [ ] Option A: User enters their own API keys (ElevenLabs + Anthropic) in Settings
- [ ] Option B: Use shared API → stream sats to cover costs via NWC
- [ ] Build this in a charming, user-friendly way — explain WHY, make it feel like V4V
- [ ] Not a paywall — a value exchange

### Phase 4 — First Public Launch on Nostr
- [ ] Test with a small group of friends first → collect feedback
- [ ] Consider a new, cooler name for the project
- [ ] Write a good README for GitHub
- [ ] Publish on Nostr — tag podcast hosts whose shows work especially well
      → Goal: GitHub stars, community feedback, word of mouth
- [ ] Curated list: which podcasts give the best PR experience (transcripts + chapters)

### Phase 5 — OpenSats Grant Application
- [ ] PR qualifies: open source + Bitcoin/Lightning + Podcast 2.0 + V4V + Nostr
- [ ] Document what makes PR unique vs existing podcast players
- [ ] Apply at https://opensats.org

### Phase 6 — Scale & Service
- [ ] Outreach Bot: contact musicians/labels to join Wavlake / Lightning
- [ ] Wavlake playlist export (liked songs)
- [ ] Native mobile app (after funding)
- [ ] Multi-user / social features via Nostr

---

## Git Tags (Restore Points)
- `v1.0-pre-pwa` — stable desktop, before PWA setup
- `v1.0-pre-howler` — PWA working, before Howler.js migration

---

## ElevenLabs

| Service | Model | Cost |
|---|---|---|
| TTS | `eleven_turbo_v2_5` | 0.5 credits/character |
| STT | `scribe_v2` | billed per minute |

**Important:** Only use these expressive tags with turbo model:
`[laughs]`, `[excited]`, `[sighs]`, `[whispers]`, `[slow]`
DO NOT use: `[pause]`, `[rushed]`, `[drawn out]` — v3-only, get spoken aloud!

→ Each user needs their own ElevenLabs API key (or streams sats via NWC).

---

## Workflow for New Chat Sessions

```
1. Paste this file as context
2. Check current state: https://github.com/hiyahlowes/personal-radio
3. Look at the Roadmap — which Phase are we in? What's next?
4. Always: git pull --rebase before push, NEVER --force
5. After push: manually publish on Netlify
6. Test: check Console for errors, moderator speaking?
```

---

*Last updated: March 2026*
*Current phase: Phase 1 — Howler.js migration next*
