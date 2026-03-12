import { useRef, useState, useCallback } from 'react';

const ELEVENLABS_API_KEY = 'sk_632e7857df9f28257efd1e9995e06af8741ead98b385099b';
const VOICE_ID = 'UgBBYS2sOqTuMpoF3BR0';
const TTS_URL = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`;

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

  // Dedicated audio element for the moderator voice (separate from music)
  const voiceAudioRef = useRef<HTMLAudioElement | null>(null);
  // Track the current object URL so we can revoke it after use
  const currentBlobUrl = useRef<string | null>(null);
  // Allow callers to cancel in-flight speech
  const abortRef = useRef<AbortController | null>(null);

  const getOrCreateAudio = (): HTMLAudioElement => {
    if (!voiceAudioRef.current) {
      voiceAudioRef.current = new Audio();
    }
    return voiceAudioRef.current;
  };

  /** Speak text aloud. Returns a promise that resolves when the audio finishes playing. */
  const speak = useCallback(
    async (
      text: string,
      opts: ElevenLabsOptions = {}
    ): Promise<void> => {
      // Cancel any in-progress speech
      abortRef.current?.abort();
      const abort = new AbortController();
      abortRef.current = abort;

      // Stop & clean up previous audio
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
          model_id: 'eleven_turbo_v2_5',
          voice_settings: {
            stability: opts.stability ?? 0.45,
            similarity_boost: opts.similarity_boost ?? 0.82,
            style: opts.style ?? 0.35,
            use_speaker_boost: opts.use_speaker_boost ?? true,
          },
        };

        const response = await fetch(TTS_URL, {
          method: 'POST',
          headers: {
            'xi-api-key': ELEVENLABS_API_KEY,
            'Content-Type': 'application/json',
            Accept: 'audio/mpeg',
          },
          body: JSON.stringify(body),
          signal: abort.signal,
        });

        if (!response.ok) {
          const errText = await response.text().catch(() => response.statusText);
          throw new Error(`ElevenLabs error ${response.status}: ${errText}`);
        }

        const blob = await response.blob();
        if (abort.signal.aborted) return;

        const url = URL.createObjectURL(blob);
        currentBlobUrl.current = url;

        setIsGenerating(false);
        setIsSpeaking(true);

        await new Promise<void>((resolve, reject) => {
          audio.src = url;
          audio.volume = 1;

          const onEnded = () => {
            cleanup();
            resolve();
          };
          const onError = () => {
            cleanup();
            reject(new Error('Audio playback error'));
          };
          const onAbort = () => {
            cleanup();
            resolve(); // treat abort as clean finish
          };

          function cleanup() {
            audio.removeEventListener('ended', onEnded);
            audio.removeEventListener('error', onError);
          }

          audio.addEventListener('ended', onEnded);
          audio.addEventListener('error', onError);

          // Handle external abort
          abort.signal.addEventListener('abort', onAbort, { once: true });

          audio.play().catch(reject);
        });
      } catch (err) {
        if ((err as { name?: string }).name === 'AbortError') return;
        const msg = err instanceof Error ? err.message : 'TTS failed';
        setError(msg);
        console.warn('[ElevenLabs]', msg);
      } finally {
        setIsSpeaking(false);
        setIsGenerating(false);
      }
    },
    []
  );

  /** Stop speaking immediately */
  const stop = useCallback(() => {
    abortRef.current?.abort();
    voiceAudioRef.current?.pause();
    setIsSpeaking(false);
    setIsGenerating(false);
  }, []);

  return { speak, stop, isSpeaking, isGenerating, error };
}
