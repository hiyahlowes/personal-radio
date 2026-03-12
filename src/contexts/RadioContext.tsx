/**
 * RadioContext
 *
 * Holds the two <audio> elements and all radio-loop state in a provider that
 * lives ABOVE the React Router, so they survive route changes (e.g. navigating
 * to Settings and back). RadioPage reads from this context instead of owning
 * the elements itself.
 *
 * Only the audio elements and a small set of refs are stored here. All the
 * playback logic (advanceLoop, moderator, etc.) still lives in RadioPage —
 * it's just the *elements* and *persistent refs* that need to outlive the page.
 */

import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';

// ── RadioItem type (duplicated here to avoid a circular import) ──────────────
// This is the minimal shape needed by RadioContext. RadioPage casts it properly.
export interface RadioItemMusic {
  kind: 'music';
  track: {
    id: string;
    name: string;
    artist: string;
    albumTitle: string;
    artworkUrl: string;
    liveUrl: string;
    duration: number;
    artistId: string;
    albumId: string;
    avatarUrl: string;
  };
}
export interface RadioItemPodcast {
  kind: 'podcast';
  episode: {
    id: string;
    feedTitle: string;
    title: string;
    audioUrl: string;
    duration: number;
    description: string;
    pubDate: string;
  };
}
export type RadioItem = RadioItemMusic | RadioItemPodcast;

export interface RadioContextValue {
  /** Main music <audio> element. NO crossOrigin — Wavlake CDN has no CORS. */
  audioRef: React.RefObject<HTMLAudioElement | null>;
  /** Podcast <audio> element. crossOrigin='anonymous' for Web Audio API. */
  podAudioRef: React.RefObject<HTMLAudioElement | null>;
  /** True while the radio loop is running (survives navigations). */
  runningRef: React.RefObject<boolean>;
  /** True once the opening greeting has been spoken. */
  greetedRef: React.RefObject<boolean>;
  /** Current track index in the playlist. */
  idxRef: React.RefObject<number>;
  /** Generation counter — incremented each loop iteration to cancel stale listeners. */
  loopGenRef: React.RefObject<number>;
  /**
   * The currently-playing item (music or podcast), stored in context so it
   * survives navigation to Settings and back. RadioPage keeps this in sync.
   */
  nowPlayingRef: React.RefObject<RadioItem | null>;
  nowPlaying: RadioItem | null;
  setNowPlaying: (item: RadioItem | null) => void;
}

const RadioContext = createContext<RadioContextValue | null>(null);

export function RadioProvider({ children }: { children: React.ReactNode }) {
  // Audio elements — created once, never destroyed while the app is mounted.
  const audioRef    = useRef<HTMLAudioElement | null>(null);
  const podAudioRef = useRef<HTMLAudioElement | null>(null);

  // Persistent loop state
  const runningRef  = useRef(false);
  const greetedRef  = useRef(false);
  const idxRef      = useRef(0);
  const loopGenRef  = useRef(0);

  // nowPlaying: stored in context so it survives route changes.
  // Both the ref (read by the loop) and the state (triggers React re-renders) live here.
  const nowPlayingRef = useRef<RadioItem | null>(null);
  const [nowPlaying, setNowPlayingState] = useState<RadioItem | null>(null);

  const setNowPlaying = useCallback((item: RadioItem | null) => {
    nowPlayingRef.current = item;
    setNowPlayingState(item);
  }, []);

  // Create the audio elements exactly once on mount.
  useEffect(() => {
    // Music audio — NO crossOrigin.
    const audio   = new Audio();
    audio.preload = 'metadata';
    audioRef.current = audio;

    // Podcast audio — crossOrigin must be set BEFORE src assignment.
    const pod        = new Audio();
    pod.preload      = 'metadata';
    pod.crossOrigin  = 'anonymous';
    podAudioRef.current = pod;

    // Only pause+clear on full app unmount (practically never in production).
    return () => {
      audio.pause(); audio.src = '';
      pod.pause();   pod.src   = '';
    };
  }, []);

  const value: RadioContextValue = {
    audioRef,
    podAudioRef,
    runningRef,
    greetedRef,
    idxRef,
    loopGenRef,
    nowPlayingRef,
    nowPlaying,
    setNowPlaying,
  };

  return (
    <RadioContext.Provider value={value}>
      {children}
    </RadioContext.Provider>
  );
}

export function useRadioContext(): RadioContextValue {
  const ctx = useContext(RadioContext);
  if (!ctx) throw new Error('useRadioContext must be used within <RadioProvider>');
  return ctx;
}
