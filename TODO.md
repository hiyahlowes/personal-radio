# Personal Radio — TODO & Roadmap
> Sorted by priority based on OpenSats grant readiness analysis (March 2026)
> Check off items as you go. Update before each session.

---

## 🔴 PHASE A — OpenSats Prep (Next 4–6 weeks)
*Do these before applying. Without them, application will likely be rejected.*

### 1. README (highest priority — first impression for the board)
- [ ] Write professional README.md in repo root
  - What is PR? (1 paragraph, clear and punchy)
  - Screenshot or GIF showing podcast interruption flow
  - Tech stack overview
  - How to run locally
  - How to self-host (basic Pi setup)
  - License (MIT)
  - Contribution guide
  - Link to live demo

### 2. Fix API Keys / Security
- [ ] Remove `SECRETS_SCAN_ENABLED=false` workaround
- [ ] Move any remaining client-side API keys into Netlify Functions
- [ ] Verify no secrets leak in frontend bundle

### 3. NWC Integration (strongest Bitcoin-specific proof)
- [ ] NWC connection string input in Settings
- [ ] V4V: stream sats to Wavlake artists during music playback
- [ ] V4V: parse `<podcast:value>` tag from RSS → stream sats to podcast host
- [ ] Show streamed sats in UI
- [ ] Tool: Shakespeare AI (by Alex Gleason)

### 4. Demo Video (60 seconds)
- [ ] Record screen capture showing:
  - Radio starts, moderator intro
  - Podcast interruption with commentary
  - V4V sats streaming (if NWC done)
- [ ] Upload to YouTube / Nostr

### 5. Nostr Presence
- [ ] Post regularly about PR on Nostr
- [ ] Tag Wavlake artists, podcast hosts, OpenSats
- [ ] Show you are active in the ecosystem
- [ ] The board checks your Nostr profile

---

## 🟡 PHASE B — Strategic Positioning (before application)

### 6. Settings Cleanup (polish for first users)
- [ ] Redesign Settings with collapsible sections:
  - Your Name
  - Moderator (Language, Voice, Agent)
  - Music (Genres, Liked Songs, Graveyard)
  - Podcasts (Feeds, Search, History)
  - Start Over (danger zone)

### 7. Self-Hosted PR — Phase A (Pi + Tailscale)
- [ ] Deploy PR as local web app on Raspberry Pi
- [ ] Telegram Bot: `/radio` → Start/Stop buttons → stream link in chat
- [ ] Document setup process (feeds into README)
- [ ] Solves iOS audio problem completely

### 8. Reframe the application narrative
- [ ] Position as: "Open-source V4V Podcast/Music player with NIP-90 agent
      integration and self-hostable architecture"
- [ ] Emphasize: PR is a reference implementation for NIP-90 + NWC + Podcast 2.0
- [ ] Apply to **Nostr Fund** (not General Fund)
- [ ] Realistic budget: $8,000–$15,000 for 6 months (first grant)
- [ ] Focused milestones: NWC ✅ + Self-Hosting ✅ + NIP-90 stable

---

## 🟢 PHASE C — Community (parallel, ongoing)

### 9. Find early users
- [ ] Contact 5–10 Wavlake artists — ask them to try PR and post about it
- [ ] Official launch post on Nostr
- [ ] Ask for feedback openly
- [ ] Find at least one contributor (even a small PR counts for the board)

### 10. Apply to OpenSats
- [ ] Apply to **Nostr Fund** (not General Fund)
- [ ] Do NOT apply in: March, June, September, December
- [ ] Next windows: **April 2026** or **May 2026**
- [ ] URL: https://opensats.org

---

## 🔵 PHASE D — After Funding

### 11. NIP-90 Agent (stable implementation)
- [ ] Own strfry relay on Pi
- [ ] Persistent WebSocket subscription (replace nostr-tools polling)
- [ ] TomBot / OpenClaw agent fully connected
- [ ] NIP-90 as reusable module for other developers

### 12. Self-Hosted PR — Phase B (Icecast Audio Stream)
- [ ] PR mixes music + TTS server-side → MP3/AAC stream
- [ ] Icecast broadcasts stream → any media player
- [ ] Stream URL delivered via Telegram Bot
- [ ] Docker image for easy deployment

### 13. Native iOS/Android App
- [ ] Solves all iOS audio issues permanently
- [ ] Background audio, Lock Screen controls, CarPlay

---

## 🐛 Open Bugs (fix when convenient)
- [ ] Segmenter: `createMediaElementSource` crash on second podcast episode
- [ ] Service Worker: `Failed to execute 'clone' on 'Response': body already used`
- [ ] Greeting pre-gen cache miss when play pressed very quickly
- [ ] tombot-listener: set up as systemd service on Pi
- [ ] Replace placeholder icons with real PR artwork

---

## 📅 Suggested Sprint Order

| Sprint | Focus | Est. Time |
|--------|-------|-----------|
| 1 | Settings Cleanup + NIP-90 toggle | 1 session |
| 2 | NWC Integration (Shakespeare AI) | 2-3 sessions |
| 3 | README + Demo Video | 1-2 sessions |
| 4 | API Key security cleanup | 1 session |
| 5 | Self-Hosted PR Phase A (Pi) | 2 sessions |
| 6 | Nostr presence + community outreach | ongoing |
| 7 | OpenSats application | April/May 2026 |

---

*Last updated: March 31, 2026*
*Next session: Settings Cleanup + NWC start*
