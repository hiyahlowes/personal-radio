import { useRef, useState, useCallback } from 'react';

const ELEVENLABS_API_KEY = 'sk_632e7857df9f28257efd1e9995e06af8741ead98b385099b';
const VOICE_ID = 'UgBBYS2sOqTuMpoF3BR0';
const TTS_URL = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=mp3_44100_128`;

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
        model_id: 'eleven_turbo_v2_5',
        voice_settings: {
          stability: opts.stability ?? 0.45,
          similarity_boost: opts.similarity_boost ?? 0.82,
          style: opts.style ?? 0.35,
          use_speaker_boost: opts.use_speaker_boost ?? true,
        },
      };

      console.log('[ElevenLabs] POSTing to:', TTS_URL);
      console.log('[ElevenLabs] Request body:', JSON.stringify(body));

      const response = await fetch(TTS_URL, {
        method: 'POST',
        headers: {
          'xi-api-key': ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: abort.signal,
      });

      console.log('[ElevenLabs] Response status:', response.status, response.statusText);
      console.log('[ElevenLabs] Response headers:', {
        'content-type': response.headers.get('content-type'),
        'access-control-allow-origin': response.headers.get('access-control-allow-origin'),
        'x-request-id': response.headers.get('x-request-id'),
      });

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
          // NotAllowedError = browser autoplay policy blocked it
          // Log clearly but still reject so the sequence knows
          cleanup();
          reject(playErr instanceof Error ? playErr : new Error(msg));
        });
      });

    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') {
        console.log('[ElevenLabs] Fetch aborted (AbortController)');
        return;
      }
      const msg = err instanceof Error ? err.message : 'TTS failed';
      console.error('[ElevenLabs] speak() caught error:', msg, err);
      setError(msg);
    } finally {
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
