# Personal Radio (PR) — Project Context

> Dieses File dient als Kontext-Prompt für neue Chat-Sessions oder andere KI-Tools.
> API Keys NIEMALS hier eintragen — nur in `.env.local` lokal oder Netlify Dashboard.

---

## Projekt-Übersicht

**Personal Radio (PR)** ist eine open-source, personalisierte AI-Radiostation.
- Spielt Bitcoin Lightning Musik (Wavlake Top Charts)
- Unterbricht Podcasts intelligent mit AI-Moderator-Kommentaren
- Moderator kennt den Hörer, seine Vorlieben und Podcast-Inhalte
- Value4Value: Micropayments via Bitcoin Lightning

**Live:** https://personal-radio.netlify.app  
**GitHub:** https://github.com/hiyahlowes/personal-radio  
**Entwickler:** Thomas Kitsche, Düsseldorf

---

## Tech Stack

| Layer | Tech |
|---|---|
| Frontend | React + Vite + TypeScript |
| Hosting | Netlify (Personal Plan, $9/mo) |
| AI Moderator | Anthropic Claude Haiku (`claude-haiku-4-5-20251001`) |
| Text-to-Speech | ElevenLabs (`eleven_turbo_v2_5`) |
| Speech-to-Text | ElevenLabs Scribe v2 (für natürliche Schnittpunkte) |
| Musik | Wavlake API (Bitcoin Lightning Top Charts) |
| Podcasts | PodcastIndex API + RSS Feeds via Fountain.fm |
| Payments | Bitcoin Lightning / Value4Value (Nostr/Zaps via useZaps.ts) |

---

## Netlify Setup

- **Auto-Deploy: GESPERRT** — immer manuell publishen!
- Deploys → Trigger deploy → Deploy project → "Publish deploy"
- `git pull --rebase` vor jedem Push, NIE `--force`

### Netlify Environment Variables

| Variable | Typ | Verwendung |
|---|---|---|
| `ELEVENLABS_API_KEY` | Server-side (kein VITE_) | TTS + STT via Netlify Function |
| `VITE_ELEVENLABS_VOICE_ID` | Client-side | Voice ID: `UgBBYS2sOqTuMpoF3BR0` |
| `ANTHROPIC_API_KEY` | Server-side (kein VITE_) | Claude Moderator via Netlify Function |
| `PODCASTINDEX_API_KEY` | Server-side | PodcastIndex API |
| `PODCASTINDEX_API_SECRET` | Server-side | PodcastIndex API |
| `SECRETS_SCAN_ENABLED` | Build | `false` (temporärer Workaround) |

---

## Netlify Functions (Server-side Proxies)

```
/.netlify/functions/claude-proxy     → Anthropic API
/.netlify/functions/podcast-proxy    → PodcastIndex + RSS + ElevenLabs TTS/STT
  actions:
    - action=search       PodcastIndex Suche
    - action=trending     Trending Podcasts
    - action=feed         RSS Feed fetch (CORS-safe)
    - action=text         Transcript fetch (CORS-safe)
    - action=tts          ElevenLabs Text-to-Speech (server-side Key)
    - action=stt          ElevenLabs Scribe v2 Speech-to-Text
```

---

## Wichtige Dateien

```
src/
├── hooks/
│   ├── useRadioModerator.ts      # AI Moderator (Claude), Prompts, Sprache
│   ├── usePodcastFeeds.ts        # RSS Feed Fetching, transcript URL parsing
│   ├── usePodcastSegmenter.ts    # Podcast Unterbrechungslogik, Scribe, Chapters
│   ├── usePodcastIndex.ts        # PodcastIndex API, fetchSuggestedPodcasts
│   ├── useWavlakeTracks.ts       # Wavlake API, weighted shuffle
│   ├── useElevenLabs.ts          # TTS via Netlify Proxy
│   ├── useListenerMemory.ts      # localStorage Gedächtnis (Songs, Podcasts, Topics)
│   └── useZaps.ts                # Bitcoin Lightning / Nostr Zaps
├── pages/
│   ├── RadioPage.tsx             # Hauptseite, Loop-Logik, Jingles, Play/Pause
│   ├── SettingsPage.tsx          # Settings inkl. Song Graveyard
│   └── SetupPage.tsx             # Onboarding (Sprache → Name → Genres → Podcasts)
└── netlify/functions/
    ├── claude-proxy.mjs
    └── podcast-proxy.mjs
```

---

## Features (Live)

### Musik
- Wavlake Top Charts (Bitcoin Lightning Musik, V4V)
- Auto-Shuffle beim Laden (Fisher-Yates nach vollem API-Load)
- Weighted Shuffle: gelikte Songs 2x häufiger, consecutive duplicate guard
- Like-Button (♥) für Songs → gewichtete Wiedergabe
- Dislike/Ban (✕) → Song in "Song Graveyard", nie wieder spielen
- Song Graveyard in Settings → Songs resurrect-bar
- Crossfade zwischen Songs
- Duck-Effekt: Musik wird leiser wenn Moderator spricht (0.08 Lautstärke)

### Podcasts
- PodcastIndex RSS Feeds (CORS-safe via Proxy)
- Round-Robin Queue (5 Episoden pro Feed, 15 total)
- Grüner Haken ✓ bei Episoden mit Transcript ("Best Experience")
- Transcript-bevorzugte Episoden oben in der Queue
- Podcast-Settings zeigen kuratierte Transcript-ready Shows
- Drag-to-reorder Podcast Queue
- Resume-Position: speichert wo man aufgehört hat (pr:podcast-position)
- "X:XX left" Anzeige in der Podcast-Liste
- Manuelle Play/Pause Buttons pro Episode
- +30s / -30s Skip-Buttons (für Werbung überspringen)

### AI Moderator
- Claude Haiku generiert Moderationstext
- ElevenLabs `eleven_turbo_v2_5` für TTS
- Sprachen: 🇩🇪 Deutsch / 🇬🇧 English / 🇫🇷 Français (in localStorage: `pr:language`)
- CRITICAL language rule: spricht immer in der gewählten Sprache
- Expressive Tags: `[laughs]`, `[excited]`, `[sighs]`, `[whispers]`, `[slow]`
- Tags werden kontextabhängig eingesetzt (nicht dekorativ)

### Podcast-Unterbrechung (DAS Killer-Feature)
**Strategy A: Episode hat Kapitel + Transcript**
1. 30s vor Kapitel-Ende: `findNaturalCutPoint()` liest Transcript
2. Sucht Satzende (. ? !) + Gap ≥ 1.5s zum nächsten Eintrag
3. Unterbricht an natürlicher Gesprächspause, nicht mitten im Satz
4. Context Tier 1: Transcript-Fenster (±2min um currentTime) → ~400 Tokens

**Strategy B: Keine Kapitel (Scribe Lookahead)**
1. Random target: 8-15 Minuten in die Episode
2. Bei target-90s: MediaRecorder startet (Lookahead-Phase)
3. Bei target-30s: 60s Audio-Blob an ElevenLabs Scribe v2
4. Scribe liefert word-level timestamps → größte Pause im Fenster 20-40s
5. Scribe hat ~25s Puffer bevor target erreicht wird
6. Fallback: target+30s wenn Scribe zu langsam

**Context Tiers für Moderationskommentar:**
- Tier 1: Transcript-Fenster (was wurde gerade gesagt) ✅
- Tier 2: Kapitel-Titel + Episode-Beschreibung
- Tier 3: Nur Episode-Beschreibung (Fallback)

### Übergänge & Jingles
- `podcast-intro.mp3`: spielt NACH Moderationsansage, VOR Podcast-Start
- `studio-return.mp3`: spielt SOFORT wenn Podcast stoppt, VOR Moderationskommentar
- Musik-Sandwich: fade to 0.05 (3s) → Moderator spricht → fade to 0 (2s) → Podcast

### Listener Memory (localStorage)
Key: `pr:listener-memory:{listenerName}`
```json
{
  "playedSongs": [{"id", "title", "artist", "playedAt", "skipped", "liked"}],
  "dislikedSongs": ["id"],
  "likedSongs": ["id"],
  "episodeHistory": [{"episodeId", "title", "showName", "lastPosition", "totalListened", "completedAt", "topics"}],
  "recentTopics": [{"topic", "showName", "episodeTitle", "heardAt"}]
}
```
- Moderator kennt gehörte Themen → Cross-Episode Referenzen
- Moderator kennt gelikte Songs

### Episode Knowledge Memory
Key: `pr:episode-knowledge:{episodeId}`
- Speichert was der Moderator schon über eine Episode kommentiert hat
- Beim nächsten Einsteigen in die Episode: Moderator weiß schon mehr
- Cap: 10 Chunks pro Episode

---

## Offene TODOs / Roadmap

### Bugs
- [ ] Sprache wechselt gelegentlich zu Englisch bei Song-Intros (CRITICAL rule verstärken)
- [ ] Manifest.webmanifest Syntax Error (kosmetisch, kein Funktionsfehler)

### Features in Arbeit
- [ ] Nostr-Login + Profil-Integration (Moderator kennt deine Nostr-Posts)
- [ ] Nostr-Sync für Listener Memory (statt nur localStorage)
- [ ] Wavlake Playlist Export (gelikte Songs)
- [ ] Phase 4 Outreach-Bot (Musiker/Labels für Wavlake kontaktieren)

### Nice to Have
- [ ] Shuffle-Button sichtbarer machen
- [ ] Gespielte Songs grau aber sichtbar + × Delete
- [ ] Song-Kontext via Claude (Moderator improvisiert Infos über unbekannte Artists)
- [ ] Moderator-Persönlichkeit weiter ausbauen (Name, Eigenheiten)

---

## Aktuell eingestellte Podcasts (Thomas)

- **THE Bitcoin Podcast** — `https://feeds.fountain.fm/VV0f6IwusQoi5kOqvNCx`
- **TFTC: A Bitcoin Podcast** — `https://feeds.fountain.fm/ZwwaDULvAj0yZvJ5kdB9`
- **Coin Stories with Natalie Brunell** — `https://coinstories.libsyn.com/rsscoin`

---

## Workflow für neue Chat-Sessions

```
1. Dieses File als Kontext einfügen
2. GitHub aktuellen Stand checken: https://github.com/hiyahlowes/personal-radio
3. Immer: git pull --rebase vor Push, NIE --force
4. Nach Push: Netlify manuell publishen
5. Testen: Console auf Errors prüfen, Moderator spricht? TTS funktioniert?
```

---

## ElevenLabs Budget (Starter $5/mo)

| Service | Inkludiert | Verbrauch pro Session |
|---|---|---|
| TTS (turbo_v2_5) | 30.000 Credits (0.5/Zeichen) | ~225 Zeichen/Moderation |
| STT API (Scribe v2) | 12.5 Stunden | ~0.5 Min/Unterbrechung |
| STT Realtime | 10 Stunden | nicht genutzt |

---

*Zuletzt aktualisiert: März 2026*
*Nächster Schritt: Nostr-Integration*
