# Personal Radio Memory Architecture

The self-hosted engine is the right place for long-lived radio memory. The WebPlayer remains the cockpit; the engine becomes the memory-bearing radio host.

## Principles

- Memory stays local only under `~/.config/personal-radio/`.
- Call-ins may influence the next normal moderation, but never trigger a moderation by themselves.
- Raw events are append-only; summaries and stats are derived materialized state.
- The moderator receives small context cards, never the whole log.
- The first implementation uses JSONL plus a materialized JSON document. The module boundary allows a later SQLite backend without changing the engine API.

## Files

- `radio-events.jsonl`: raw append-only events for debugging and future rebuilds.
- `radio-memory.json`: aggregate memory used by the engine.

Default directory:

```text
~/.config/personal-radio/
```

This directory is the migration payload for moving from the Pi to a mini PC.

## Memory layers

1. Raw events:
   - track started/finished/skipped/liked/banned
   - podcast segment heard
   - moderation spoken
   - call-in created/used/archived

2. Aggregates:
   - track stats
   - recent tracks
   - recent podcast segments
   - daily topic/mood summary
   - moderation history
   - call-in inbox

3. Context compiler:
   - current item facts
   - relevant track stats
   - today’s podcast themes
   - open call-ins
   - repeated-phrase guard from recent moderations

## Call-ins

Call-ins are listener notes to the host. They can be requests, moods or thoughts:

- "Spiel mal was Ruhiges"
- "Das Thema eben hat mich beschaeftigt"
- "Mehr Bitcoin, weniger Krach"

They are stored as `open`, then marked `used` once included in a successful moderation, or `archived` when dismissed.

Call-ins do not trigger moderation. They are only considered when the normal radio loop reaches a moderation point such as a music moderation, podcast intro or podcast segment commentary.

## Listener-aware sessions

The self-hosted engine treats listening as a real radio session, not as an endless unattended playlist.

An active listener currently means:

- a configured physical output sink exists, such as Bluetooth headphones or a deck/tunnel sink
- or the configured livestream sink has at least one `/live.mp3` client

If no active listener exists, the engine enters `suspended` instead of continuing playback. It stores the current music or podcast position as `pausedResumeItem`; podcast positions are also persisted in `podcast-state.json`.

Relevant settings are stored in `/api/settings`:

- `autoSuspendWhenNoListeners`
- `noListenerGraceSeconds`
- `newSessionAfterMinutes`
- `resumeWithLikedSong`
- `sessionIntroAfterFirstSong`

After a short outage the engine resumes the paused item. After a long outage, currently defaulting to 180 minutes, it starts a new session with a liked song when possible, prepares the welcome-back moderation during that song, and only then resumes any deferred podcast.

`/api/status` exposes `listenerState` so the Remote can show whether the engine is active, in grace, or suspended.

## Future Honcho-like layer

This first layer is intentionally simple. A later layer can add embeddings/retrieval:

- episodic memory from raw events
- semantic memory from topic extraction
- working memory for the current listening session
- retrieval ranking for the current moderation/curation task

The API contract should remain: the engine asks the context compiler for a concise context card.
