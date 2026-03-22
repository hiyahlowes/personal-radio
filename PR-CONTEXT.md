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
| Text-to-Speech | ElevenLabs (`eleven_turbo_v2_5`) → **Fish Audio geplant (22x günstiger)** |
| Speech-to-Text | ElevenLabs Scribe v2 (natural cut points) |
| Music | Wavlake API (Bitcoin Lightning Top Charts) |
| Podcasts | PodcastIndex API + RSS Feeds via Fountain.fm |
| Music Playback | **Howler.js v2.2.4** |
| Payments | Bitcoin Lightning / Value4Value — **NWC Integration geplant** |
| NWC Agent | **Shakespeare AI** (von Alex Gleason, Nostr-trained) |

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
| `VITE_ELEVENLABS_VOICE_ID_DE` | Client-side | German voice (neue Stimme, lebendiger) |
| `ANTHROPIC_API_KEY` | Server-side | Claude Moderator |
| `FISH_AUDIO_API_KEY` | Server-side | Fish Audio TTS via Netlify Function |
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
├── podcast-intro.mp3 / studio-return.mp3
├── manifest.webmanifest
├── sw.js                         # Service worker (network-first, pr-shell-v2)
└── icon-192/512.png              # Purple placeholders — ersetzen vor Launch!
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
- iOS: `howl.pause()` / `howl.play()`
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
| Music playback | ✅ |
| Crossfades | ✅ |
| Moderator TTS | ✅ |
| Duck effect | ⚠️ Pause/Resume |
| Podcast audio | ❌ Silent — iOS WebKit Limitation, nicht lösbar in PWA |

**Lösung: Native App nach Förderung.**

---

## TTS — ElevenLabs Alternativen

**Problem:** ElevenLabs ist die Achillesferse von PR — zu teuer für Scale.

| Option | Cost | Status |
|---|---|---|
| ElevenLabs `turbo_v2_5` | ~$330/1M chars | Currently in use |
| **Fish Audio** | ~$15/1M chars (22x cheaper!) | **Next step** |
| Coqui TTS / similar OSS | Server costs | Long-term, self-hosted |

**Fish Audio** hat vergleichbare Qualität + emotionale Tags.
→ Einbinden sobald Demo fertig ist, vor Public Launch.

---

## NWC Integration — Plan

**Tool: Shakespeare AI** (von Alex Gleason)
- Auf Nostr-Apps trainiert
- Bereits in PR angefangen (steht im useZaps.ts)

**Zahlungsströme:**
1. **V4V Musik** → Sats an Wavlake-Künstler (via Wavlake API Lightning Adresse)
2. **V4V Podcast** → Sats an Podcast-Hosts (via `<podcast:value>` Tag im RSS Feed)
3. **Infrastruktur** → Sats an Thomas für API-Kosten (noch zu entscheiden)

**User Flow:**
- User gibt NWC-String in Settings ein (von Alby, Mutiny, Phoenix etc.)
- Während Musik/Podcast läuft → automatisch Sats streamen
- Betrag: ~2 sats/Minute (kaum spürbar, aber fair)

---

## 🗺️ Roadmap — Priorisierte Reihenfolge

### Schritt 1 — Fish Audio einbauen (DONE ✅)
- [x] Fish Audio API in `podcast-proxy.mjs` als TTS Alternative einbinden
- [x] Settings: User kann zwischen ElevenLabs und Fish Audio wählen
- [ ] Eigenen Fish Audio API Key in Netlify hinterlegen (`FISH_AUDIO_API_KEY`)
- [ ] Qualitätsvergleich: emotionale Tags, deutsche Stimme

### Schritt 2 — NWC Integration (mit Shakespeare AI)
- [ ] NWC-String Eingabe in Settings/Setup
- [ ] V4V Musik: Sats an Wavlake-Künstler streamen
- [ ] V4V Podcast: `<podcast:value>` Tag aus RSS parsen → Sats an Host
- [ ] UI: Zeige wie viele Sats gestreamt wurden

### Schritt 3 — OpenSats Grant Antrag
- [ ] Antrag schreiben mit konkreten Milestones
- [ ] Realistischer Betrag: **$20.000–$40.000 für 6 Monate**
      → Stundensatz für Entwicklung + Infrastrukturkosten + App Store
- [ ] Auszahlung 100% in Bitcoin
- [ ] Milestones: Fish Audio ✅, NWC ✅, iOS Native App, 100 aktive User
- [ ] **NICHT bewerben in: März, Juni, September, Dezember** (geschlossen)
- [ ] Bewerbung: https://opensats.org
- [ ] PR qualifiziert: Open Source ✅ Bitcoin/Lightning ✅ Podcast 2.0 ✅ V4V ✅ Nostr ✅

### Danach — Launch + Native App
- [ ] Demo-Video aufnehmen (60s, zeigt Podcast-Interruption Feature)
- [ ] README schreiben
- [ ] Auf Nostr launchen, Podcast-Hosts taggen
- [ ] Native iOS/Android App (nach Förderung)

---

### Offene Bugs / Kleinigkeiten
- [ ] Icons ersetzen (purple placeholder → echtes PR Artwork)
- [ ] Langsamer initialer Load — Podcast Chapters lazy laden
- [ ] Manueller Podcast-Start aus Queue (Play-Button in Queue)

---

## OpenSats Details

**Grant-Typen:**
- **General Grant**: einmalig/zeitlich begrenzt, für konkrete Features → **realistisch für PR**
- **LTS Grant**: monatliches Gehalt (~$80-120K/Jahr), für kritische Infrastruktur → eher nicht

**Rechnung für PR General Grant:**
- Entwicklung (6 Monate): ~$3.000/Monat = $18.000
- Infrastruktur (APIs, Server): ~$200/Monat = $1.200
- App Store Gebühren: ~$800
- **Gesamt: ~$20.000** (konservativ) bis **$40.000** (inkl. native App)

**Wichtig:** OpenSats gibt keine festen Beträge vor — du schlägst Höhe + Milestones vor.
Die Auszahlung erfolgt in Bitcoin (on-chain oder Lightning).

---

## Git Tags (Restore Points)
- `v1.0-pre-pwa` — stable desktop, before PWA
- `v1.0-pre-howler` — PWA working, before Howler migration

---

## ElevenLabs
- Model: `eleven_turbo_v2_5` (0.5 credits/char)
- STT: `scribe_v2` (per minute)
- ⚠️ Starter 30K/month depleted March 2026. Resets ~April 9 2026.
- Long-term: replace with Fish Audio

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
*Next: Fish Audio integration → NWC Integration → OpenSats application → Launch*
