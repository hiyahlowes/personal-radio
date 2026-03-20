import { useRef, useState, useCallback } from 'react';

// ── Env vars ───────────────────────────────────────────────────────────────────
// Voice IDs are safe to bundle (not secrets).
// The API key is kept server-side in ELEVENLABS_API_KEY (no VITE_ prefix) and
// accessed only through the podcast-proxy Netlify Function.
const VOICE_ID_EN = import.meta.env.VITE_ELEVENLABS_VOICE_ID    as string | undefined;
const VOICE_ID_DE = import.meta.env.VITE_ELEVENLABS_VOICE_ID_DE as string | undefined;
const TTS_PROXY      = '/.netlify/functions/podcast-proxy?action=tts';
const FISH_TTS_PROXY = '/.netlify/functions/podcast-proxy?action=tts-fish';

if (!VOICE_ID_EN) {
  console.warn(
    '[ElevenLabs] VITE_ELEVENLABS_VOICE_ID is not set. ' +
    'TTS will be disabled — the AI host will not speak.',
  );
}

function getStoredLang(): string {
  try { return localStorage.getItem('pr:language') ?? 'English'; } catch { return 'English'; }
}

/** Reads the current language from localStorage and returns the matching ElevenLabs voice ID. */
function getVoiceId(): string | undefined {
  const lang = getStoredLang();
  console.log(`[ElevenLabs] Language from localStorage (pr:language): "${lang}"`);
  const id = lang === 'Deutsch' ? (VOICE_ID_DE ?? VOICE_ID_EN) : VOICE_ID_EN;
  console.log(`[ElevenLabs] Selected voice_id: ${id ?? '(none)'} (lang=${lang})`);
  return id;
}

/** Returns the active TTS provider ('elevenlabs' | 'fish'). */
function getTtsProvider(): 'elevenlabs' | 'fish' {
  try {
    const v = localStorage.getItem('pr:tts-provider');
    return v === 'fish' ? 'fish' : 'elevenlabs';
  } catch { return 'elevenlabs'; }
}

/**
 * Returns the Fish Audio reference_id (voice ID) for the current language.
 * Stored in localStorage as pr:fish-voice-id-en / pr:fish-voice-id-de.
 */
function getFishVoiceId(): string | undefined {
  const lang = getStoredLang();
  const key  = lang === 'Deutsch' ? 'pr:fish-voice-id-de' : 'pr:fish-voice-id-en';
  try { return localStorage.getItem(key) ?? undefined; } catch { return undefined; }
}

/**
 * ElevenLabs uses [laughs] / [sighs] / [whispers].
 * Fish Audio uses [laughing] / [sigh] / [whisper].
 * Translate tags so emotion cues survive a provider switch.
 */
function translateTagsForFish(text: string): string {
  return text
    .replace(/\[laughs\]/gi,   '[laughing]')
    .replace(/\[sighs\]/gi,    '[sigh]')
    .replace(/\[whispers\]/gi, '[whisper]');
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
void sleep; // used by callers via re-export path — keep for tree-shaking safety

export interface ElevenLabsOptions {
  stability?: number;
  similarity_boost?: number;
  style?: number;
  use_speaker_boost?: boolean;
}

// Module-level singleton — lazily created on first unlock gesture so iOS
// treats play() as user-initiated. Do NOT use `new Audio()` at module load.
let _ttsAudio: HTMLAudioElement | null = null;

/** Call inside a touchend/click handler to create + unlock the TTS element. */
export function unlockTTSAudio(): void {
  if (!_ttsAudio) _ttsAudio = new Audio();
  const el = _ttsAudio;
  // Silent 1-frame WAV — smallest valid audio data iOS will accept.
  el.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
  el.muted = true;
  el.play().then(() => {
    el.pause();
    el.muted = false;
    console.log('[ElevenLabs] iOS pre-unlock complete');
  }).catch(() => { el.muted = false; });
}

/** Converts text to speech via ElevenLabs and plays it. Returns a promise that resolves when playback ends. */
export function useElevenLabs() {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentBlobUrl = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const getOrCreateAudio = (): HTMLAudioElement => {
    if (!_ttsAudio) _ttsAudio = new Audio();
    return _ttsAudio;
  };

  const speak = useCallback(async (text: string, opts: ElevenLabsOptions = {}): Promise<void> => {
    const provider = getTtsProvider();
    console.log('[TTS] speak() — provider:', provider, '— text:', text.slice(0, 80) + (text.length > 80 ? '…' : ''));

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
      let proxyUrl: string;
      let body: Record<string, unknown>;

      if (provider === 'fish') {
        const fishVoiceId = getFishVoiceId();
        if (!fishVoiceId) {
          console.warn('[Fish] Skipping TTS — no Fish voice ID set. Configure one in Settings.');
          setIsGenerating(false);
          return;
        }
        proxyUrl = FISH_TTS_PROXY;
        body = { text: translateTagsForFish(text), reference_id: fishVoiceId };
        console.log('[Fish] POSTing to:', proxyUrl, '— reference_id:', fishVoiceId);
      } else {
        const voiceId = getVoiceId();
        if (!voiceId) {
          console.warn('[ElevenLabs] Skipping TTS — no voice ID configured for current language.');
          setIsGenerating(false);
          return;
        }
        const isGerman = (() => {
          try { return localStorage.getItem('pr:language') === 'Deutsch'; } catch { return false; }
        })();
        proxyUrl = TTS_PROXY;
        body = {
          text,
          voice_id: voiceId,
          model_id: 'eleven_turbo_v2_5',
          voice_settings: {
            // German: lower stability + higher style for a more expressive, lively delivery.
            stability:         opts.stability        ?? (isGerman ? 0.25 : 0.45),
            similarity_boost:  opts.similarity_boost ?? 0.82,
            style:             opts.style            ?? (isGerman ? 0.35 : 0.35),
            use_speaker_boost: opts.use_speaker_boost ?? true,
          },
        };
        console.log('[ElevenLabs] POSTing to:', proxyUrl);
      }

      const response = await fetch(proxyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: abort.signal,
      });

      console.log('[TTS] Response status:', response.status, response.statusText);

      if (!response.ok) {
        const errText = await response.text().catch(() => response.statusText);
        console.error('[TTS] API error response body:', errText);
        throw new Error(`TTS ${response.status}: ${errText}`);
      }

      const blob = await response.blob();
      console.log('[TTS] Audio blob received — size:', blob.size, 'bytes, type:', blob.type);

      if (blob.size === 0) {
        throw new Error('TTS returned an empty audio blob');
      }

      if (abort.signal.aborted) {
        console.log('[TTS] Aborted after blob received, skipping playback');
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
    _ttsAudio?.pause();
    setIsSpeaking(false);
    setIsGenerating(false);
  }, []);

  return { speak, stop, isSpeaking, isGenerating, error };
}
