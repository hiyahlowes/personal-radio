import { useRef, useState, useCallback } from 'react';

// ── Env vars ───────────────────────────────────────────────────────────────────
// Voice IDs are safe to bundle (not secrets).
// The API key is kept server-side in ELEVENLABS_API_KEY (no VITE_ prefix) and
// accessed only through the podcast-proxy Netlify Function.
const VOICE_ID_EN = import.meta.env.VITE_ELEVENLABS_VOICE_ID    as string | undefined;
const VOICE_ID_DE = import.meta.env.VITE_ELEVENLABS_VOICE_ID_DE as string | undefined;
const TTS_PROXY   = '/.netlify/functions/podcast-proxy?action=tts';

if (!VOICE_ID_EN) {
  console.warn(
    '[ElevenLabs] VITE_ELEVENLABS_VOICE_ID is not set. ' +
    'TTS will be disabled — the AI host will not speak.',
  );
}

/** Reads the current language from localStorage and returns the matching voice ID. */
function getVoiceId(): string | undefined {
  const lang = (() => {
    try { return localStorage.getItem('pr:language') ?? 'English'; } catch { return 'English'; }
  })();
  console.log(`[ElevenLabs] Language from localStorage (pr:language): "${lang}"`);
  const id = lang === 'Deutsch' ? (VOICE_ID_DE ?? VOICE_ID_EN) : VOICE_ID_EN;
  console.log(`[ElevenLabs] Selected voice_id: ${id ?? '(none)'} (lang=${lang})`);
  return id;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
void sleep; // used by callers via re-export path — keep for tree-shaking safety

export interface ElevenLabsOptions {
  stability?: number;
  similarity_boost?: number;
  style?: number;
  use_speaker_boost?: boolean;
}

/** Converts text to speech via ElevenLabs and plays it. Returns a promise that resolves when playback ends. */
export function useElevenLabs() {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const voiceAudioRef = useRef<HTMLAudioElement | null>(null);
  const currentBlobUrl = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const getOrCreateAudio = (): HTMLAudioElement => {
    if (!voiceAudioRef.current) {
      voiceAudioRef.current = new Audio();
    }
    return voiceAudioRef.current;
  };

  const speak = useCallback(async (text: string, opts: ElevenLabsOptions = {}): Promise<void> => {
    const voiceId = getVoiceId();

    // Graceful no-op when voice ID is missing
    if (!voiceId) {
      console.warn('[ElevenLabs] Skipping TTS — no voice ID configured for current language.');
      return;
    }

    console.log('[ElevenLabs] speak() called with text:', text.slice(0, 80) + (text.length > 80 ? '…' : ''));

    // Cancel any in-progress speech
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;

    const audio = getOrCreateAudio();
    audio.pause();
    if (currentBlobUrl.current) {
      URL.revokeObjectURL(currentBlobUrl.current);
      currentBlobUrl.current = null;
    }

    setError(null);
    setIsGenerating(true);

    try {
      const body = {
        text,
        voice_id: voiceId,
        model_id: 'eleven_turbo_v2_5',
        voice_settings: {
          stability: opts.stability ?? 0.45,
          similarity_boost: opts.similarity_boost ?? 0.82,
          style: opts.style ?? 0.35,
          use_speaker_boost: opts.use_speaker_boost ?? true,
        },
      };

      console.log('[ElevenLabs] POSTing to:', TTS_PROXY);

      const response = await fetch(TTS_PROXY, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: abort.signal,
      });

      console.log('[ElevenLabs] Response status:', response.status, response.statusText);

      if (!response.ok) {
        const errText = await response.text().catch(() => response.statusText);
        console.error('[ElevenLabs] API error response body:', errText);
        throw new Error(`ElevenLabs ${response.status}: ${errText}`);
      }

      const blob = await response.blob();
      console.log('[ElevenLabs] Audio blob received — size:', blob.size, 'bytes, type:', blob.type);

      if (blob.size === 0) {
        throw new Error('ElevenLabs returned an empty audio blob');
      }

      if (abort.signal.aborted) {
        console.log('[ElevenLabs] Aborted after blob received, skipping playback');
        return;
      }

      const url = URL.createObjectURL(blob);
      currentBlobUrl.current = url;
      console.log('[ElevenLabs] Blob URL created:', url);

      setIsGenerating(false);
      console.log('[ElevenLabs] isSpeaking → TRUE');
      setIsSpeaking(true);

      await new Promise<void>((resolve, reject) => {
        audio.src = url;
        audio.volume = 1;

        const cleanup = () => {
          audio.removeEventListener('ended', onEnded);
          audio.removeEventListener('error', onError);
          abort.signal.removeEventListener('abort', onAbort);
        };

        const onEnded = () => {
          console.log('[ElevenLabs] Playback ended cleanly');
          cleanup();
          resolve();
        };

        const onError = (e: Event) => {
          const mediaErr = (e.target as HTMLAudioElement).error;
          console.error('[ElevenLabs] Audio element error:', mediaErr?.code, mediaErr?.message);
          cleanup();
          reject(new Error(`Audio playback error: ${mediaErr?.message ?? 'unknown'}`));
        };

        const onAbort = () => {
          console.log('[ElevenLabs] Playback aborted externally');
          audio.pause();
          cleanup();
          resolve();
        };

        audio.addEventListener('ended', onEnded);
        audio.addEventListener('error', onError);
        abort.signal.addEventListener('abort', onAbort, { once: true });

        console.log('[ElevenLabs] Calling audio.play()…');
        audio.play().then(() => {
          console.log('[ElevenLabs] audio.play() resolved — playback started');
        }).catch((playErr: unknown) => {
          const msg = playErr instanceof Error ? playErr.message : String(playErr);
          console.error('[ElevenLabs] audio.play() rejected:', msg);
          cleanup();
          reject(playErr instanceof Error ? playErr : new Error(msg));
        });
      });

    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') {
        console.log('[ElevenLabs] Fetch aborted (AbortController)');
        // Aborted intentionally (e.g. user skip) — not an error, just return.
        return;
      }
      const msg = err instanceof Error ? err.message : 'TTS failed';
      // Log but DO NOT rethrow. speak() must never reject — a failed TTS call
      // must be a silent no-op so the radio loop continues without interruption.
      console.error('[ElevenLabs] speak() swallowing error to keep loop alive:', msg, err);
      setError(msg);
    } finally {
      console.log('[ElevenLabs] isSpeaking → FALSE');
      setIsSpeaking(false);
      setIsGenerating(false);
    }
  }, []);

  const stop = useCallback(() => {
    console.log('[ElevenLabs] stop() called');
    abortRef.current?.abort();
    voiceAudioRef.current?.pause();
    setIsSpeaking(false);
    setIsGenerating(false);
  }, []);

  return { speak, stop, isSpeaking, isGenerating, error };
}
