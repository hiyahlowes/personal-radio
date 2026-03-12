# PR – Personal Radio

**Your personal AI radio station, powered by Bitcoin Lightning & Nostr**

[![Edit with Shakespeare](https://shakespeare.diy/badge.svg)](https://shakespeare.diy/clone?url=https%3A%2F%2Fgithub.com%2Fhiyahlowes%2Fpersonal-radio)

---

## What is PR?

PR is a personalized radio experience that greets you by name, streams real music from independent artists on Wavlake, and uses AI to generate a warm, time-aware welcome every time you tune in. It's built on open protocols — Nostr for identity and social, Bitcoin Lightning for payments — so the music, the hosts, and the listeners are all part of the same value-for-value economy. There are no algorithms optimizing for engagement, no ads, and no middlemen between artists and their audience.

---

## Vision

The internet radio of the future is personal, open, and fair. PR is a bet on what that looks like:

- **Personalized AI moderation** — an AI host that knows your name, your time zone, and eventually your taste; generating natural, warm introductions between tracks like a real radio DJ
- **Real voices earning sats** — human and AI hosts get tipped directly via Lightning every time a listener enjoys their segment, with no platform cut
- **V4V music via Wavlake** — every track played streams micropayments back to the artist in real time using the Value-for-Value model; listeners pay what they think the music is worth
- **Podcasts via Fountain** — podcast segments pulled from the Fountain network, with per-minute streaming payments going directly to podcast creators
- **Nostr-native social** — listeners can react to tracks, share what they're hearing, and follow their favourite artists — all on the open Nostr protocol, owned by no one

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, TypeScript, Vite |
| Styling | Tailwind CSS 3, shadcn/ui, Radix UI |
| Nostr | Nostrify, nostr-tools, NIP-07 signer |
| Music | Wavlake Catalog API (`catalog.wavlake.com/v1`) |
| AI | Shakespeare AI (NIP-98 authenticated, OpenAI-compatible) |
| Payments | Bitcoin Lightning, Nostr Wallet Connect (NWC) |
| Identity | Nostr keypairs (npub / nsec), NIP-07 browser extensions |
| Data | TanStack Query for caching and async state |
| Routing | React Router v6 |

---

## Roadmap

### Phase 1 — MVP (current)

- [x] Welcome screen with personalized name entry
- [x] AI-generated morning / afternoon / evening / night greeting via Shakespeare AI
- [x] Real music streaming from Wavlake (ambient, lo-fi, chill, acoustic, electronic)
- [x] Full audio player — play, pause, seek, volume, prev/next, auto-advance
- [x] Rotating vinyl artwork, waveform visualizer, buffering states
- [x] Playlist with album art, track durations, and live Wavlake links
- [x] "Coming Up" segment preview (podcasts + music sets)
- [x] Nostr login via NIP-07 for authenticated AI greetings
- [x] Dark premium design with glassmorphism and ambient glow effects

### Phase 2 — Lightning & Value-for-Value

- [ ] Integrate Nostr Wallet Connect (NWC) for in-app Lightning wallet
- [ ] Stream sats to Wavlake artists per minute of playback (V4V)
- [ ] Zap button on Now Playing card — tip the artist directly
- [ ] Display artist Lightning address and cumulative sats earned
- [ ] Boost / comment system for podcast segments (Podcasting 2.0 compatible)
- [ ] Listener dashboard: total sats sent, favourite artists, listening time

### Phase 3 — Nostr Social

- [ ] Publish "Now Playing" as a Nostr kind 1 note with track metadata
- [ ] Follow artists' Nostr profiles and get notified of new releases
- [ ] Shared listening rooms — tune in together with friends via a Nostr event
- [ ] Reaction zaps — react to a track and split the zap between host and artist
- [ ] Artist profiles pulled from Nostr kind 0 metadata
- [ ] Playlist publishing — share your radio queue as a Nostr addressable event

---

## Getting Started

### Prerequisites

- Node.js 18+
- A Nostr browser extension for login (e.g. [Alby](https://getalby.com), [nos2x](https://github.com/fiatjaf/nos2x))

### Run locally

```bash
git clone https://github.com/hiyahlowes/personal-radio.git
cd personal-radio
npm install
npm run dev
```

Open `http://localhost:5173` in your browser.

### Build for production

```bash
npm run build
```

Output is in `dist/`. It's a fully static site — deploy anywhere (Netlify, Vercel, Cloudflare Pages, nsite).

---

## How to Contribute

PR is open source and welcomes contributions of all kinds — code, design, feedback, and ideas.

1. **Fork** the repository on GitHub
2. **Create a branch** for your feature or fix: `git checkout -b feat/your-feature`
3. **Make your changes** — keep commits focused and descriptive
4. **Test** — run `npm test` to check types, linting, and the build
5. **Open a pull request** — describe what you changed and why

### Good first issues

- Add support for a new Wavlake genre search term
- Improve the AI greeting prompt for a specific time of day
- Add keyboard shortcuts (space to play/pause, arrow keys for seek)
- Improve accessibility (ARIA labels, focus states, reduced motion)
- Add a settings panel for choosing preferred music genres

### Conventions

- TypeScript everywhere — no `any` types
- Tailwind for all styling — no inline styles
- Nostrify for all Nostr protocol interactions
- Keep components small and composable
- Follow the existing file structure (`pages/`, `hooks/`, `components/`)

If you have a bigger idea — a new phase from the roadmap, or something not listed — open an issue first to discuss it. This is a collaborative project and direction matters.

---

## License

MIT — do whatever you want with it. If you build something cool, we'd love to hear about it.

---

*Built with [Shakespeare](https://shakespeare.diy) — the AI-powered web app builder for the open web.*
