# WebPlayer to self-hosted engine parity

This document tracks the old browser WebPlayer behavior against the self-hosted Pi/mini-PC engine. The goal is not to maintain two different radios; the React UI remains the cockpit and the server engine becomes the motor in remote mode.

## Modes

| Area | WebPlayer mode | Self-hosted remote mode |
|---|---|---|
| Audio owner | Browser HTMLAudio/Howler | `scripts/radio-engine.mjs` |
| State owner | Browser React/localStorage | Engine API and `~/.config/personal-radio` |
| UI | `src/pages/RadioPage.tsx`, `SettingsPage.tsx` | Same UI, remote adapter via `useEngineMode` |
| Output | Local browser device | PipeWire/Pulse sinks and Tailscale livestream |
| PWA start | Normal setup/player flow | `/remote?remote=1` |

## Parity checklist

| WebPlayer behavior | Reference | Engine status |
|---|---|---|
| Play/pause resumes current music instead of choosing a new song | `RadioPage.tsx`, HTMLAudio/Howler pause semantics | Implemented. `/api/pause` stores `pausedResumeItem`; `/api/play` resumes with `ffplay -ss`. |
| Podcast pause preserves the current episode position | `RadioPage.tsx`, `usePodcastSegmenter.ts` | Implemented. Pause snapshots podcast position and writes it into `podcast-state.json`. |
| Browser does not play audio in remote mode | `RadioPage.tsx`, `useEngineMode.ts` | Implemented. Remote controls call engine endpoints and render engine state. |
| Podcast is segmented, not played as one full episode | `usePodcastSegmenter.ts` | Implemented server-side. Engine uses min/max window, chapter/transcript/silence/hard-max break selection. |
| No normal podcast break before 8 minutes | `usePodcastSegmenter.ts` | Implemented via `podcastSegmentMinMinutes`. |
| Force podcast break at 15 minutes | `usePodcastSegmenter.ts` | Implemented via `podcastSegmentMaxMinutes` and `ffplay -t` hard stop. |
| Prefer chapter boundary | `usePodcastSegmenter.ts` | Implemented via parsed chapter metadata when available. |
| Prefer transcript cue/natural cut | `usePodcastSegmenter.ts` | Implemented for timed transcript cues. |
| Silence fallback for natural breaks | `usePodcastSegmenter.ts` | Implemented server-side using ffmpeg `silencedetect` in the 8-15 minute window. |
| STT/context fallback for podcast commentary | `usePodcastSegmenter.ts` | Implemented using transcript/chapter context first, then STT fallback when enabled. |
| Podcast intro before the segment | `useRadioModerator.ts`, `RadioPage.tsx` | Implemented server-side with TTS before podcast playback. |
| Podcast intro jingle before podcast starts | `public/podcast-intro.mp3`, `RadioPage.tsx` | Implemented server-side as a jingle item. |
| Ambient bridge under podcast intro | `RadioPage.tsx`, ambient Howler bridge | Not copied 1:1. The engine uses a simpler server-side intro + jingle path. A future enhancement can mix a low-volume bridge with ffmpeg/PipeWire, but it is intentionally not required for stable remote playback. |
| Studio return jingle before podcast interruption commentary | `public/studio-return.mp3`, `usePodcastSegmenter.ts` callback | Implemented server-side before podcast segment commentary. |
| Commentary summarizes the heard podcast section | `usePodcastSegmenter.ts`, `useRadioModerator.ts` | Implemented. Prompt receives show, episode, segment start/end, context source, transcript/STT excerpt and chapter title. |
| 1-3 music tracks after podcast segment | `usePodcastSegmenter.ts` | Implemented via `musicBreakTracksAfterPodcast` or random 1-3 default. |
| Return announcement before resuming same podcast | `usePodcastSegmenter.ts` `speakReturn` | Implemented. Engine resumes the same `podcast-state.json` episode after the break and speaks a return line. |
| Same episode resumes later | `usePodcastSegmenter.ts` position storage | Implemented. Engine rebuilds a playable podcast item from `podcast-state.json`. |
| Podcast queue refresh | `usePodcastFeeds.ts`, Settings podcast UI | Implemented. `/api/podcast-refresh` refreshes RSS queues; remote Settings and player buttons call it. |
| Podcast queue manual episode play | `RadioPage.tsx` queue controls | Implemented. `/api/play-podcast` forces selected episode as next engine item. |
| Podcast abandon/skip segment controls | Remote UI | Implemented. `/api/skip-podcast-segment` and `/api/abandon-podcast`. |
| Settings parity | `SettingsPage.tsx` | Implemented for remote engine settings: sat streaming, boost amount, TTS provider/voices/model/settings, podcast feeds/queue/frequency, moderation, output volume and music source. |
| Likes | `useLikedTracks.ts`, `useListenerMemory.ts` | Implemented server-side. `/api/like-current`, `/api/liked`, `liked-tracks.json`, PR Liked Songs source. |
| Bans | `useListenerMemory.ts` graveyard | Implemented server-side. `/api/ban-current`, `/api/blocked`, `blocked-tracks.txt`. Remote unban is not yet implemented. |
| Wavlake playlist import | Settings music source | Implemented with playlist ID and `wavlakePlaylist` source. |
| Liked Wavlake export | Settings | Implemented via `/api/liked/export`. |
| V4V sat streaming/boost UI | `useV4V.ts`, Settings | Partially remote-adapted. UI/settings remain; actual wallet payment logic still lives in the browser and uses current engine track metadata. |
| Multi-output audio | N/A, new self-hosted feature | Implemented. Independent `ffplay` per configured sink. |
| Tailscale livestream | N/A, new self-hosted feature | Implemented via `via-radio-server.mjs` `/live.mp3` and `/live.m3u`. |
| Long-lived radio memory | Browser local memory only | Engine-only v1. Local files under `~/.config/personal-radio/` store raw events, track stats, podcast segment memory, moderation history and call-ins. |
| Call-In button | N/A | Engine-only remote feature. A call-in can influence the next normal moderation but never triggers moderation by itself. |

## Intentional differences

- The browser WebPlayer uses local audio APIs because it is itself the player. The self-hosted engine cannot run React hooks, Howler or Web Audio; every audio behavior must be represented as engine state and `ffplay`/ffmpeg playback.
- Ambient bridge mixing under podcast intros is the main remaining dramaturgy difference. It should be implemented only if it can be done without destabilizing Bluetooth/stream outputs.
- V4V wallet/NWC logic remains browser-side because wallet authorization is user/browser state. The engine exposes the current track and settings; the browser remains responsible for payments.
- Remote unban is read-only for now. The engine exposes banned rows, but does not yet offer an `/api/unban` endpoint.
- Radio memory is intentionally self-hosted only for now. It is local to the Pi/mini-PC and should not sync to cloud services without an explicit future design.

## Regression rules

- Do not play browser audio in remote mode.
- Do not treat podcast episodes as full-length music items.
- Do not use `cleo_deck_combined` or `module-combine-sink`.
- Do not add new settings UI for existing settings; wire existing UI to `/api/settings`.
- Do not add another minimal remote player; `RadioPage.tsx` remains the cockpit.
