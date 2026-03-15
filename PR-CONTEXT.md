# Personal Radio (PR) — Project Context

> Paste this file at the start of any new chat session to restore full context.
> Never commit API keys here — use `.env.local` locally or Netlify Dashboard.
> When returning after a break: check the "Next Steps" section first!

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

## ⚡ NEXT STEPS (start here after a break)

### Immediate fixes still to test/verify:
1. **Resume Bug** — `isResuming=false` even when episode is 70% heard. 
   Episode IDs from RSS feed may not match IDs saved in `pr:podcast-position` 
   and `pr:listener-memory`. Need to verify ID consistency.

2. **Audio Tags spoken aloud** — `[pause]`, `[rushed]`, `[drawn out]` don't 
   work with `eleven_turbo_v2_5` and get spoken as text. Remove these from 
   moderator system prompt. Keep only: `[laughs]`, `[excited]`, `[sighs]`, 
   `[whispers]`, `[slow]`.

3. **"Sats/Wavlake" in track intros** — moderator keeps mentioning Wavlake 
   and sats counts. Add to prompt: "Never mention Wavlake, sats, charts, 
   or streaming numbers. Talk about the music itself."

4. **Post-podcast dead air** — after podcast stops, music should start 
   BEFORE moderator speaks, not after. Music at 0.3 → moderator over it → 
   fade up to 0.9.

5. **Ambient bridge pool** — always fetch 5 ambient tracks from Wavlake 
   regardless of user genre selection. Store separately from main playlist. 
   Use as bridge under podcast intro moderation.

6. **Crossfade gap** — brief silence after crossfade handoff. Fade-up should 
   start immediately when nextAudio is promoted to audio.

### Still to prompt (not yet sent to Claude Code):
- Moderator personality prompt update (more human, contractions, opinions, 
  no clichés, max 40 words)

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
| `VITE_ELEVENLABS_VOICE_ID_DE` | Client-side | German voice: `87AwpS6yC86wa2WglbsK` |
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
    action=search     PodcastIndex search
    action=trending   Trending podcasts
    action=feed       RSS Feed fetch (CORS-safe)
    action=text       Transcript fetch (CORS-safe)
    action=tts        ElevenLabs Text-to-Speech (server-side key)
    action=stt        ElevenLabs Scribe v2 Speech-to-Text
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
│   ├── RadioPage.tsx             # Main page, loop logic, jingles, play/pause
│   ├── SettingsPage.tsx          # Settings incl. Song Graveyard
│   └── SetupPage.tsx             # Onboarding (language → name → genres → podcasts)
netlify/functions/
├── claude-proxy.mjs
└── podcast-proxy.mjs
public/
├── podcast-intro.mp3             # Jingle: plays AFTER moderator intro, BEFORE podcast
└── studio-return.mp3             # Jingle: plays IMMEDIATELY when podcast stops
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
- Duck effect: music lowers to 0.08 when moderator speaks
- Ambient bridge pool: always available for podcast transitions (separate from main playlist)

### Podcasts
- PodcastIndex RSS feeds (CORS-safe via proxy)
- Round-robin queue (5 episodes per feed, 15 total)
- Green checkmark ✓ for episodes with transcripts ("Best Experience")
- Transcript episodes prioritized at top of queue
- Settings show curated transcript-ready shows
- Drag-to-reorder podcast queue
- Resume position saved (pr:podcast-position)
- "X:XX left" display in podcast list
- Manual play/pause + +30s / -30s skip buttons (for skipping ads)
- Resume-aware intro: "Wir kommen zurück zu..." when episode already partially heard

### AI Moderator
- Claude Haiku generates ALL moderation text — NO hardcoded strings
- Language-aware fallbacks in all 3 languages (en/de/fr)
- ElevenLabs TTS via server-side proxy
- Language-aware voice selection: German uses voice `87AwpS6yC86wa2WglbsK`
- Languages: 🇩🇪 Deutsch / 🇬🇧 English / 🇫🇷 Français (stored: `pr:language`)
- CRITICAL language rule: always responds in selected language
- Expressive tags (turbo-compatible only): `[laughs]`, `[excited]`, `[sighs]`, `[whispers]`, `[slow]`
- Voice settings: stability=0.40, similarity_boost=0.75, style=0.15

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
- Podcast intro: ambient bridge song (low vol) → moderator speaks → song fades out → jingle → podcast
- Studio return: podcast stops → jingle → moderator commentary → next song starts → moderator over it
- Music always playing — no dead air at any point

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

---

## 🗺️ Roadmap

### Phase 1 — Polish before first public demo (CURRENT)
- [ ] Fix remaining bugs (see NEXT STEPS above)
- [ ] Moderator personality prompt: more human, contractions, opinions, max 40 words, no clichés
- [ ] Fix: Manifest.webmanifest syntax error (cosmetic)
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
      → These hosts may repost → reach their Bitcoin/Podcast2.0 audience
      → Goal: GitHub stars, community feedback, word of mouth
- [ ] Curated list: which podcasts give the best PR experience (have transcasts + chapters)

### Phase 5 — OpenSats Grant Application
- [ ] PR qualifies: open source + Bitcoin/Lightning + Podcast 2.0 + V4V + Nostr
- [ ] Document what makes PR unique vs existing podcast players
- [ ] Build out grant roadmap: what would funding enable?
- [ ] Apply at https://opensats.org

### Phase 6 — Scale & Service
- [ ] Outreach Bot: contact musicians/labels to join Wavlake / Lightning
- [ ] Wavlake playlist export (liked songs)
- [ ] Mobile app (PWA first, then native)
- [ ] Multi-user / social features via Nostr

---

## ElevenLabs

| Service | Model | Cost |
|---|---|---|
| TTS | `eleven_turbo_v2_5` | 0.5 credits/character |
| STT | `scribe_v2` | billed per minute |

→ Each user needs their own ElevenLabs API key (or streams sats via NWC).
→ ElevenLabs key needs: Text to Speech (Access) + Speech to Text (Access) + Voices (Read)
→ See https://elevenlabs.io/pricing for current plan details.

---

## Workflow for New Chat Sessions

```
1. Paste this file as context
2. Read "NEXT STEPS" section at the top
3. Check current state: https://github.com/hiyahlowes/personal-radio
4. Always: git pull --rebase before push, NEVER --force
5. After push: manually publish on Netlify
6. Test: check Console for errors, moderator speaking?
```

---

*Last updated: March 15, 2026*
*Current phase: Phase 1 — Polish before first public demo*
