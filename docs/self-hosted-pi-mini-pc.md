# Self-hosted Personal Radio on a Pi or mini PC

Personal Radio can run in two modes:

- WebPlayer mode: the browser is the player. It plays audio locally with the existing React UI, Howler, HTMLAudio, V4V, wallet and settings logic.
- Self-hosted mode: a Pi or mini PC is the player. The browser is only the cockpit/remote; the server-side engine owns audio, queue, podcasts, moderation, outputs and persistent radio state.

Use self-hosted mode when you want one always-on radio at home, Bluetooth/HiFi outputs, a Tailscale livestream, and multiple phones or browsers controlling the same state.

## Architecture

```text
Remote browser / PWA
  /remote or ?remote=1
  no local playback
  settings + controls + queue UI
        |
        v
via-radio-server.mjs on port 8899
  static React app
  Netlify function compatibility
  /api/* proxy to engine
  /live.mp3 and /live.m3u Tailscale stream
        |
        v
radio-engine.mjs on port 8898
  single source of truth
  Wavlake music queue
  segmented podcasts
  moderation + TTS
  likes/bans/settings persistence
  independent ffplay outputs
        |
        v
PipeWire/Pulse sinks
  Bluetooth / deck / livestream null sink
```

## Requirements

- Node.js 18+
- ffmpeg and ffplay
- PipeWire/PulseAudio with the target sinks visible via `pactl list short sinks`
- Optional: Tailscale for secure mobile remote/livestream access
- Optional: ElevenLabs and/or Fish Audio keys for TTS
- Optional: `personal-radio-moderator.service` when `PERSONAL_RADIO_USE_VIA=true`

## Install

```bash
git clone https://github.com/hiyahlowes/personal-radio.git
cd personal-radio
npm install
npm run build
```

Create `.env` from `.env.example` and set the provider keys you need.

## Engine outputs

The engine reads outputs from `RADIO_OUTPUTS`:

```bash
RADIO_OUTPUTS='[
  {"name":"sony","sink":"bluez_output.AC_80_0A_E8_50_2E.1"},
  {"name":"stream","sink":"personal_radio_stream"}
]'
```

For a home deck mode, use the deck sink instead of headphones. For a headphones mode, do not include the deck tunnel. The engine starts one independent `ffplay` process per configured output and does not use `cleo_deck_combined` or `module-combine-sink`.

## Recommended systemd split

Run two user services:

- `personal-radio.service`: serves the React app, local Netlify-compatible functions, API proxy and livestream on port 8899.
- `personal-radio-engine.service`: runs the central engine on `127.0.0.1:8898`.

The engine should be configured with:

- `WorkingDirectory=/home/<user>/projects/personal-radio`
- `ExecStart=/usr/bin/node /home/<user>/projects/personal-radio/scripts/radio-engine.mjs`
- `RADIO_OUTPUTS=...`
- `PULSE_LATENCY_MSEC=...` when Bluetooth needs extra buffering
- `PERSONAL_RADIO_CACHE_HTTP_AUDIO=true` if music HTTP streams should be cached locally before playback

If using the Via moderator path, keep `personal-radio-moderator.service` running too. If `PERSONAL_RADIO_USE_VIA=true` and the Via moderator is down, moderation should fail loudly instead of silently pretending Anthropic fallback is configured.

## Remote/PWA access

- Open `/remote` or `/?remote=1`.
- On iPhone over Tailscale, save the Tailscale URL to the Home Screen.
- The manifest starts at `/remote?remote=1`, and the app redirects standalone/Tailscale root opens into remote mode.

If an old iOS Home Screen icon still opens setup, remove and re-add it. iOS can keep old manifest data aggressively.

## Livestream

The local server exposes:

- `/live.mp3`
- `/live.m3u`
- `/api/live-stream/status`

By default, `/live.mp3` and `/live.m3u` are restricted to localhost or Tailscale addresses. The stream reads from the monitor of `personal_radio_stream`, so include a stream output in `RADIO_OUTPUTS` and load a null sink named `personal_radio_stream`.

## Persistent state

Self-hosted state lives under `~/.config/personal-radio/` by default:

- `settings.json`
- `podcast-state.json`
- `liked-tracks.json`
- `blocked-tracks.txt`

For a Pi-to-mini-PC migration, copy this directory plus the repo checkout and systemd env/drop-ins. That should preserve queue settings, podcast resume state, likes and bans.

## Verification

```bash
npm test
node --check scripts/radio-engine.mjs
systemctl --user restart personal-radio.service personal-radio-engine.service
curl http://127.0.0.1:8899/api/status
curl http://127.0.0.1:8899/api/settings
curl http://127.0.0.1:8899/api/live-stream/status
```

For audio routing:

```bash
pactl list short sinks
pactl list short sink-inputs
journalctl --user -u personal-radio-engine.service -n 100 --no-pager
```
