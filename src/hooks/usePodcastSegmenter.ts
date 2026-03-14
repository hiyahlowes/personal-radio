/**
 * usePodcastSegmenter
 *
 * Plays a podcast episode on a provided <audio> element and automatically
 * inserts music breaks at natural pause points (silences) between 8 and 15
 * minutes into each segment.
 *
 * Flow for each segment:
 *   1. Play podcast audio from `resumeFrom` seconds
 *   2. Monitor for silence via Web Audio API AnalyserNode (progressive, live)
 *      - Ignore silences before 8 min into this segment
 *      - Trigger split at the first silence after 8 min; force split at 15 min
 *   3. On split: pause podcast, record the last 90 s of audio into a blob
 *   4. POST blob to ElevenLabs STT → transcript
 *   5. POST transcript to Claude → witty commentary + music tease
 *   6. Speak commentary via ElevenLabs TTS
 *   7. Play 1–3 random Wavlake tracks (caller supplies `playMusicBreak`)
 *   8. Moderator announces return, then resume podcast from saved position
 *
 * CORS note: podcast CDNs (Libsyn, Fountain, Simplecast, Acast) send
 * Access-Control-Allow-Origin: * so we CAN use crossOrigin='anonymous'
 * on the podcast <audio> element and connect it to an AudioContext.
 * Wavlake CDN does NOT send CORS headers, so the music <audio> element
 * must remain untouched — that is handled outside this hook.
 */

import { useRef, useCallback } from 'react';
import type { PodcastChapter } from './usePodcastFeeds';

// ── Constants ─────────────────────────────────────────────────────────────────

// Credentials come from environment variables — never hardcoded.
// If VITE_ELEVENLABS_API_KEY is absent, STT is skipped (commentary falls back to pre-written).
// If VITE_ANTHROPIC_API_KEY is absent, Claude commentary is skipped (fallback text used).
const ELEVENLABS_API_KEY = import.meta.env.VITE_ELEVENLABS_API_KEY as string | undefined;

const STT_URL        = 'https://api.elevenlabs.io/v1/speech-to-text';
const CLAUDE_MODEL   = 'claude-haiku-4-5-20251001';
const CLAUDE_PROXY   = '/.netlify/functions/claude-proxy';
const PODCAST_PROXY  = '/.netlify/functions/podcast-proxy';

// Silence detection
const SILENCE_THRESHOLD_DB = -45;   // RMS below this = silence
const SILENCE_MIN_DURATION = 1.5;   // seconds of continuous silence to trigger
const SPLIT_WINDOW_MIN     = 8 * 60;  // 8 min — don't split before this
const SPLIT_WINDOW_MAX     = 15 * 60; // 15 min — force split at this point
const BUFFER_CAPTURE_SECS  = 90;      // seconds of audio to send to STT

// Analyser settings
const FFT_SIZE        = 2048;
const POLL_INTERVAL   = 200; // ms between silence checks

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SegmenterCallbacks {
  /** Called once the segmenter decides it's time for a break. Caller should
   *  play 1–3 music tracks, then resolve the promise when done. */
  playMusicBreak: () => Promise<void>;
  /** Called with the script the moderator should speak before break music.
   *  (Claude commentary). Caller uses their ElevenLabs TTS to speak it. */
  speakCommentary: (script: string) => Promise<void>;
  /** Called with the "we're back" return announcement. */
  speakReturn: (podcastTitle: string, partNumber: number) => Promise<void>;
  /** Called whenever runningRef should be checked — if this returns false the
   *  segmenter aborts cleanly (user hit pause). */
  isRunning: () => boolean;
}

// ── Helper — measure RMS in dB from AnalyserNode ─────────────────────────────

function getRmsDb(analyser: AnalyserNode): number {
  const data = new Float32Array(analyser.frequencyBinCount);
  analyser.getFloatTimeDomainData(data);
  let sum = 0;
  for (const v of data) sum += v * v;
  const rms = Math.sqrt(sum / data.length);
  return rms === 0 ? -Infinity : 20 * Math.log10(rms);
}

// ── ElevenLabs STT ────────────────────────────────────────────────────────────

async function transcribeBlob(blob: Blob): Promise<string> {
  if (!ELEVENLABS_API_KEY) {
    console.warn('[Segmenter] VITE_ELEVENLABS_API_KEY not set — skipping STT');
    return '';
  }

  const form = new FormData();
  form.append('audio', blob, 'segment.webm');
  form.append('model_id', 'scribe_v1');
  form.append('language_code', 'en');

  const res = await fetch(STT_URL, {
    method: 'POST',
    headers: { 'xi-api-key': ELEVENLABS_API_KEY },
    body: form,
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => res.statusText);
    throw new Error(`ElevenLabs STT ${res.status}: ${txt}`);
  }

  const data = await res.json();
  // ElevenLabs STT returns { text: "..." }
  const text = data?.text ?? data?.transcript ?? '';
  console.log('[Segmenter] STT transcript:', text.slice(0, 120));
  return text.trim();
}

// ── Podcast transcript window extraction ─────────────────────────────────────

function parseTimeSecs(ts: string): number {
  const s = ts.replace(',', '.');
  const parts = s.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(s) || 0;
}

/**
 * Extract spoken text between `fromSecs` and `toSecs`.
 * Auto-detects Podcast Index JSON, SRT, WebVTT, and plain text.
 */
function extractWindow(raw: string, fromSecs: number, toSecs: number): string {
  const trimmed = raw.trimStart();

  if (trimmed.startsWith('{')) {
    // Podcast Index JSON transcript: { segments: [{startTime, endTime, body}] }
    try {
      const data = JSON.parse(trimmed) as Record<string, unknown>;
      const segs = (data.segments ?? []) as Record<string, unknown>[];
      return segs
        .filter(s => {
          const start = Number(s.startTime ?? s.start ?? 0);
          const end   = Number(s.endTime   ?? s.end   ?? start + 5);
          return end >= fromSecs && start <= toSecs;
        })
        .map(s => String(s.body ?? s.text ?? ''))
        .join(' ')
        .trim();
    } catch { /* fall through to SRT/plain */ }
  }

  if (trimmed.includes('-->')) {
    // SRT or WebVTT — parse cue timestamps
    const lines  = raw.split('\n');
    const parts: string[] = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i].trim();
      if (line.includes('-->')) {
        const [startStr, endStr] = line.split('-->').map(s => s.trim());
        const start = parseTimeSecs(startStr);
        const end   = parseTimeSecs(endStr);
        const textLines: string[] = [];
        i++;
        while (i < lines.length && lines[i].trim() !== '') {
          const l = lines[i].trim();
          // Skip VTT cue settings lines and bare sequence numbers
          if (l && !/^\d+$/.test(l) && !l.startsWith('NOTE')) textLines.push(l);
          i++;
        }
        if (end >= fromSecs && start <= toSecs && textLines.length > 0) {
          parts.push(textLines.join(' '));
        }
      } else {
        i++;
      }
    }
    return parts.join(' ').trim();
  }

  // Plain text — no timestamps, return last ~1 600 chars
  return raw.slice(-1600).trim();
}

async function fetchTranscriptWindow(transcriptUrl: string, currentTime: number): Promise<string | null> {
  try {
    const proxyUrl = `${PODCAST_PROXY}?action=text&url=${encodeURIComponent(transcriptUrl)}`;
    const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw  = await res.text();
    const from = Math.max(0, currentTime - 120);
    const text = extractWindow(raw, from, currentTime);
    if (!text || text.length < 50) return null;
    return text.slice(0, 1600).trim(); // ~400 tokens
  } catch (err) {
    console.warn('[Segmenter] Transcript window fetch failed:', err);
    return null;
  }
}

// ── Tiered context builder ────────────────────────────────────────────────────

interface PodcastContext {
  tier: 1 | 2 | 3;
  /** Primary text: transcript window (T1) — empty for T2/T3. */
  primaryText: string;
  /** Background text: chapters + description (T2) or description only (T3). */
  backgroundText: string;
}

async function buildContext(
  currentTime: number,
  transcriptUrl: string | undefined,
  chapters: PodcastChapter[] | undefined,
  description: string,
): Promise<PodcastContext> {
  // ── Tier 1: RSS/Podcast 2.0 transcript file ──────────────────────────────
  if (transcriptUrl) {
    const window = await fetchTranscriptWindow(transcriptUrl, currentTime);
    if (window) {
      console.log('[Segmenter] Context → Tier 1 (transcript window)');
      return { tier: 1, primaryText: window, backgroundText: description };
    }
  }

  // ── Tier 2: chapter markers present ──────────────────────────────────────
  if (chapters && chapters.length > 0) {
    const sorted = [...chapters].sort((a, b) => a.startTime - b.startTime);
    // findLastIndex polyfill
    let curIdx = -1;
    for (let i = sorted.length - 1; i >= 0; i--) {
      if (sorted[i].startTime <= currentTime) { curIdx = i; break; }
    }
    const current  = curIdx >= 0 ? sorted[curIdx]     : null;
    const previous = curIdx >  0 ? sorted[curIdx - 1] : null;

    const parts: string[] = [];
    if (previous) parts.push(`Previous chapter: "${previous.title}"`);
    if (current)  parts.push(`Current chapter: "${current.title}"`);
    if (description) parts.push(`Episode: ${description}`);

    console.log('[Segmenter] Context → Tier 2 (chapters)');
    return { tier: 2, primaryText: '', backgroundText: parts.join('\n') };
  }

  // ── Tier 3: description only ──────────────────────────────────────────────
  console.log('[Segmenter] Context → Tier 3 (description only)');
  return { tier: 3, primaryText: '', backgroundText: description };
}

// ── Claude commentary ─────────────────────────────────────────────────────────

const COMMENTARY_SYSTEM =
  'You are a witty, opinionated radio host. Comment briefly (2–3 sentences max) on what was ' +
  'just said in this podcast segment. Be engaging, add your own take, maybe a light joke. ' +
  'Then casually tease that some music is coming up next. ' +
  'No stage directions, no asterisks, no emojis. Just speak naturally as you would on air.';

/**
 * Generate commentary using the best available context.
 * `mainText` = transcript window (T1) or STT transcript — the specific words spoken.
 * `backgroundText` = chapters + description (T2/T3) — thematic background.
 */
async function generateCommentary(
  podcastTitle: string,
  mainText: string,
  backgroundText: string,
): Promise<string | null> {
  let userContent: string;
  if (mainText.length > 20) {
    userContent = `Podcast: "${podcastTitle}"\n\nLast ~2 minutes of discussion:\n"${mainText.slice(0, 1200)}"`;
    if (backgroundText) userContent += `\n\nEpisode context: ${backgroundText.slice(0, 200)}`;
  } else if (backgroundText.length > 20) {
    userContent =
      `Podcast: "${podcastTitle}"\n\nEpisode context:\n${backgroundText.slice(0, 400)}\n\n` +
      'Comment on the current topic and tease the upcoming music break.';
  } else {
    return null; // nothing to say — use fallback
  }

  try {
    const res = await fetch(CLAUDE_PROXY, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 150,
        system: COMMENTARY_SYSTEM,
        messages: [{ role: 'user', content: userContent }],
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) {
      console.warn('[Segmenter] Claude API error:', res.status);
      return null;
    }

    const data = await res.json();
    const text = data?.content?.[0]?.text ?? '';
    return text.trim() || null;
  } catch (err) {
    console.warn('[Segmenter] Claude failed:', err);
    return null;
  }
}

function fallbackCommentary(podcastTitle: string): string {
  const options = [
    `That's some thought-provoking stuff from ${podcastTitle}. We'll let that sink in — but first, we're taking a quick music break. Stay with us.`,
    `Fascinating segment from ${podcastTitle} — lots to think about there. We're going to drop some tracks while you process that. Back in a bit.`,
    `Great conversation on ${podcastTitle}. Before we hear more, let's take a little musical detour. You won't want to change the dial.`,
  ];
  return options[Math.floor(Math.random() * options.length)];
}

// ── The hook ──────────────────────────────────────────────────────────────────

export function usePodcastSegmenter() {
  // We keep a stable ref to the active AudioContext so we can close it cleanly.
  const audioCtxRef    = useRef<AudioContext | null>(null);
  const recorderRef    = useRef<MediaRecorder | null>(null);
  const chunksRef      = useRef<Blob[]>([]);

  /**
   * Tear down Web Audio resources. Safe to call multiple times.
   */
  const teardown = useCallback(() => {
    recorderRef.current?.stop();
    recorderRef.current = null;
    chunksRef.current   = [];
    if (audioCtxRef.current?.state !== 'closed') {
      audioCtxRef.current?.close().catch(() => {});
    }
    audioCtxRef.current = null;
  }, []);

  /**
   * Main entry point. Call once per podcast episode.
   *
   * @param audio      The <audio> element already loaded with episode.audioUrl.
   *                   IMPORTANT: caller must set audio.crossOrigin = 'anonymous'
   *                   BEFORE setting audio.src, so the browser fetches with CORS.
   * @param episode    Metadata for UI and commentary prompts.
   * @param callbacks  See SegmenterCallbacks.
   * @returns          A promise that resolves when the episode finishes (or is
   *                   interrupted by isRunning() returning false).
   */
  const runEpisode = useCallback(async (
    audio: HTMLAudioElement,
    episodeTitle: string,
    episodeFeedTitle: string,
    chapters: PodcastChapter[] | undefined,
    callbacks: SegmenterCallbacks,
    description = '',
    transcriptUrl: string | undefined = undefined,
  ): Promise<void> => {
    teardown(); // clean slate

    // ── Set up AudioContext for this podcast element ──────────────────────
    // We need a fresh AudioContext because the podcast <audio> element may
    // have been connected to a previous context that is now closed.
    let ctx: AudioContext;
    try {
      ctx = new AudioContext();
    } catch {
      console.warn('[Segmenter] AudioContext unavailable — running without silence detection');
      await playUntilEnd(audio, callbacks.isRunning);
      return;
    }
    audioCtxRef.current = ctx;

    // Connect: audio element → analyser → destination (so audio still plays)
    let source: MediaElementAudioSourceNode;
    try {
      source = ctx.createMediaElementSource(audio);
    } catch (e) {
      console.warn('[Segmenter] createMediaElementSource failed (CORS?):', e);
      ctx.close();
      audioCtxRef.current = null;
      await playUntilEnd(audio, callbacks.isRunning);
      return;
    }

    const analyser          = ctx.createAnalyser();
    analyser.fftSize        = FFT_SIZE;
    analyser.smoothingTimeConstant = 0.8;

    // Also wire into a MediaStreamDestination for recording
    const streamDest        = ctx.createMediaStreamDestination();

    source.connect(analyser);
    analyser.connect(ctx.destination); // playback
    analyser.connect(streamDest);      // recording tap

    // ── MediaRecorder wired to the live stream ────────────────────────────
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : 'audio/ogg;codecs=opus';

    const recorder = new MediaRecorder(streamDest.stream, { mimeType });
    recorderRef.current = recorder;
    chunksRef.current   = [];

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    // Collect chunks every second so the buffer is always fresh
    recorder.start(1000);

    console.log(`[Segmenter] AudioContext + recorder ready (mimeType: ${mimeType})`);

    let segmentPart = 1;

    // ── Segment loop ──────────────────────────────────────────────────────
    while (callbacks.isRunning()) {

      const segmentStartTime = audio.currentTime; // seconds into the episode

      // If chapters are available, find the first chapter boundary at least
      // SPLIT_WINDOW_MIN into this segment; otherwise use silence detection.
      let targetChapterTime: number | null = null;
      if (chapters && chapters.length > 0) {
        const next = chapters
          .filter(c => c.startTime >= segmentStartTime + SPLIT_WINDOW_MIN)
          .sort((a, b) => a.startTime - b.startTime)[0];
        if (next) {
          targetChapterTime = next.startTime;
          console.log(`[Segmenter] Chapter split target: "${next.title}" @ ${next.startTime}s`);
        }
      }

      let splitTriggered = false;

      // Promise that resolves true on natural end, false on split or pause
      const result = await new Promise<'ended' | 'split' | 'paused'>((resolve) => {
        let pollId: ReturnType<typeof setInterval>;

        function cleanup() {
          clearInterval(pollId);
          audio.removeEventListener('ended', onEnded);
          audio.removeEventListener('pause', onPause);
        }

        function triggerSplit() {
          if (splitTriggered) return;
          splitTriggered = true;
          cleanup();
          resolve('split');
        }

        const onEnded = () => { cleanup(); resolve('ended'); };
        const onPause = () => {
          if (!callbacks.isRunning()) { cleanup(); resolve('paused'); }
          // else: transient pause (buffering) — ignore
        };

        audio.addEventListener('ended', onEnded);
        audio.addEventListener('pause', onPause);

        let silenceStart: number | null = null;

        pollId = setInterval(() => {
          if (!callbacks.isRunning()) { cleanup(); resolve('paused'); return; }

          const elapsedAudio = audio.currentTime - segmentStartTime;

          // Force-split at SPLIT_WINDOW_MAX regardless of method
          if (elapsedAudio >= SPLIT_WINDOW_MAX) {
            console.log('[Segmenter] Force-split at 15 min mark');
            triggerSplit();
            return;
          }

          if (targetChapterTime !== null) {
            // Chapter-based split: trigger when playhead reaches chapter boundary
            if (audio.currentTime >= targetChapterTime) {
              console.log(`[Segmenter] Chapter boundary reached at ${audio.currentTime.toFixed(1)}s`);
              triggerSplit();
            }
          } else {
            // Silence-based split: only after SPLIT_WINDOW_MIN
            if (elapsedAudio >= SPLIT_WINDOW_MIN) {
              const db = getRmsDb(analyser);
              const isSilent = db < SILENCE_THRESHOLD_DB;
              if (isSilent) {
                if (silenceStart === null) silenceStart = Date.now();
                const silenceDuration = (Date.now() - silenceStart) / 1000;
                if (silenceDuration >= SILENCE_MIN_DURATION) {
                  console.log(`[Segmenter] Silence detected (${silenceDuration.toFixed(1)}s @ ${db.toFixed(1)} dB) — triggering split`);
                  triggerSplit();
                }
              } else {
                silenceStart = null;
              }
            }
          }
        }, POLL_INTERVAL);
      });

      if (result === 'paused' || !callbacks.isRunning()) {
        console.log('[Segmenter] Aborted by user pause');
        break;
      }

      if (result === 'ended') {
        console.log('[Segmenter] Episode ended naturally — no more segments');
        break;
      }

      // ── result === 'split' ────────────────────────────────────────────────
      const resumeAt = audio.currentTime;
      console.log(`[Segmenter] Split at ${resumeAt.toFixed(1)}s — collecting buffer`);

      // Pause podcast audio
      audio.pause();

      // Stop recorder to flush final chunk, then collect last 90 s worth
      recorder.stop();
      await new Promise<void>(r => setTimeout(r, 300)); // let ondataavailable flush

      const capturedBlob = collectLastNSeconds(chunksRef.current, BUFFER_CAPTURE_SECS, mimeType);
      console.log(`[Segmenter] Captured blob: ${(capturedBlob.size / 1024).toFixed(0)} KB`);

      // Reset recorder for next segment
      chunksRef.current = [];
      if (callbacks.isRunning()) {
        try {
          recorder.start(1000);
        } catch {
          // recorder may have been stopped cleanly; create no-op fallback
        }
      }

      // ── Context (tiered: transcript URL → chapters → description) ─────────
      const podCtx = await buildContext(resumeAt, transcriptUrl, chapters, description);

      // ── STT — only when no RSS transcript window was available ───────────
      // Tier 1 provides equivalent precision without an ElevenLabs API call.
      let sttText = '';
      if (podCtx.tier > 1 && capturedBlob.size > 5_000) {
        try {
          sttText = await transcribeBlob(capturedBlob);
        } catch (err) {
          console.warn('[Segmenter] STT failed:', err);
        }
      }

      if (!callbacks.isRunning()) break;

      // ── Commentary ───────────────────────────────────────────────────────
      // T1 window or STT transcript = mainText (specific words spoken).
      // T2/T3 text = backgroundText (chapter / description context).
      const mainText = podCtx.tier === 1 ? podCtx.primaryText : sttText;
      let commentary: string;
      if (mainText.length > 20 || podCtx.backgroundText.length > 20) {
        const ai = await generateCommentary(episodeFeedTitle, mainText, podCtx.backgroundText);
        commentary = ai ?? fallbackCommentary(episodeFeedTitle);
      } else {
        commentary = fallbackCommentary(episodeFeedTitle);
      }

      if (!callbacks.isRunning()) break;

      // ── Speak commentary ─────────────────────────────────────────────────
      await callbacks.speakCommentary(commentary);

      if (!callbacks.isRunning()) break;

      // ── Music break ──────────────────────────────────────────────────────
      await callbacks.playMusicBreak();

      if (!callbacks.isRunning()) break;

      // ── Return announcement ───────────────────────────────────────────────
      segmentPart++;
      await callbacks.speakReturn(episodeFeedTitle, segmentPart);

      if (!callbacks.isRunning()) break;

      // ── Resume podcast ────────────────────────────────────────────────────
      console.log(`[Segmenter] Resuming episode from ${resumeAt.toFixed(1)}s (part ${segmentPart})`);

      // When we paused, the AudioContext may have suspended. Resume it.
      if (ctx.state === 'suspended') await ctx.resume();

      audio.currentTime = resumeAt;
      try {
        await audio.play();
      } catch (e) {
        console.error('[Segmenter] Failed to resume podcast audio:', e);
        break;
      }

      // Continue to next iteration — will monitor for next silence
    }

    teardown();
  }, [teardown]);

  return { runEpisode, teardown };
}

// ── Utilities ─────────────────────────────────────────────────────────────────

/** Fall-through: just wait for the audio to end or be paused (no segmentation). */
async function playUntilEnd(
  audio: HTMLAudioElement,
  isRunning: () => boolean,
): Promise<void> {
  await new Promise<void>((resolve) => {
    const cleanup = () => {
      audio.removeEventListener('ended', done);
      audio.removeEventListener('pause', check);
    };
    const done  = () => { cleanup(); resolve(); };
    const check = () => { if (!isRunning()) { cleanup(); resolve(); } };
    audio.addEventListener('ended', done);
    audio.addEventListener('pause', check);
  });
}

/**
 * Given an array of recorded Blob chunks (each ~1 s), return a single Blob
 * containing approximately the last `seconds` seconds worth.
 *
 * We can't know exact durations from raw chunks without decoding, so we
 * approximate by byte size: keep the last N chunks where N = seconds (because
 * each chunk is ~1 s). This is good enough for STT purposes.
 */
function collectLastNSeconds(chunks: Blob[], seconds: number, mimeType: string): Blob {
  const keep = chunks.slice(-Math.max(1, seconds)); // last N 1-second chunks
  return new Blob(keep, { type: mimeType });
}
