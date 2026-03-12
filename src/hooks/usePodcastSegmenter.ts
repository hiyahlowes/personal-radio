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

const ELEVENLABS_API_KEY = 'sk_632e7857df9f28257efd1e9995e06af8741ead98b385099b';
const STT_URL            = 'https://api.elevenlabs.io/v1/speech-to-text';

/** Claude sonnet endpoint — caller must supply ANTHROPIC_API_KEY via env or
 *  we fall back to a pre-written commentary if the key is absent. */
const CLAUDE_MODEL   = 'claude-sonnet-4-20250514';
const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';

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

// ── Claude commentary ─────────────────────────────────────────────────────────

const COMMENTARY_SYSTEM =
  'You are a witty, opinionated radio host. Comment briefly (2–3 sentences max) on what was ' +
  'just said in this podcast segment. Be engaging, add your own take, maybe a light joke. ' +
  'Then casually tease that some music is coming up next. ' +
  'No stage directions, no asterisks, no emojis. Just speak naturally as you would on air.';

async function generateCommentary(transcript: string, podcastTitle: string): Promise<string | null> {
  const apiKey = (import.meta as { env?: Record<string, string> }).env?.VITE_ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('[Segmenter] No VITE_ANTHROPIC_API_KEY — using fallback commentary');
    return null;
  }

  try {
    const res = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 150,
        system: COMMENTARY_SYSTEM,
        messages: [
          {
            role: 'user',
            content:
              `Podcast: "${podcastTitle}"\n\nLast 90 seconds of transcript:\n"${transcript.slice(0, 800)}"`,
          },
        ],
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

      // ── STT ──────────────────────────────────────────────────────────────
      let transcript = '';
      if (capturedBlob.size > 5_000) { // skip STT if blob is too small
        try {
          transcript = await transcribeBlob(capturedBlob);
        } catch (err) {
          console.warn('[Segmenter] STT failed:', err);
        }
      }

      if (!callbacks.isRunning()) break;

      // ── Commentary ───────────────────────────────────────────────────────
      let commentary: string;
      if (transcript.length > 20) {
        const aiCommentary = await generateCommentary(transcript, episodeFeedTitle);
        commentary = aiCommentary ?? fallbackCommentary(episodeFeedTitle);
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
