/**
 * useLikedTracks
 *
 * Persists liked Wavlake tracks to localStorage. Liked tracks are stored as
 * full WavlakeTrack objects so they can be displayed in Settings without
 * re-fetching and used for weighted playback in the loop.
 *
 * Weighting: liked tracks are inserted twice into the shuffled playlist so
 * they play approximately 2x more often than non-liked tracks.
 */

import { useState, useCallback } from 'react';
import type { WavlakeTrack } from './useWavlakeTracks';

const STORAGE_KEY = 'pr:liked-tracks';

function readStored(): WavlakeTrack[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as WavlakeTrack[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStored(tracks: WavlakeTrack[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tracks));
}

export function useLikedTracks() {
  const [liked, setLiked] = useState<WavlakeTrack[]>(readStored);

  const isLiked = useCallback(
    (id: string) => liked.some(t => t.id === id),
    [liked]
  );

  const toggle = useCallback((track: WavlakeTrack) => {
    setLiked(prev => {
      const exists = prev.some(t => t.id === track.id);
      const next   = exists ? prev.filter(t => t.id !== track.id) : [...prev, track];
      writeStored(next);
      return next;
    });
  }, []);

  const unlike = useCallback((id: string) => {
    setLiked(prev => {
      const next = prev.filter(t => t.id !== id);
      writeStored(next);
      return next;
    });
  }, []);

  /**
   * Apply 2x weighting to liked tracks within a playlist.
   * Each liked track is duplicated and the list is re-shuffled so the
   * duplicates are distributed throughout, not clumped at the end.
   * The currently-playing track index is preserved after the operation.
   */
  const applyWeighting = useCallback(
    (tracks: WavlakeTrack[], currentId?: string): WavlakeTrack[] => {
      if (liked.length === 0) return tracks;

      const likedIds = new Set(liked.map(t => t.id));
      const withDupes = [...tracks];

      // Insert an extra copy of each liked track
      for (const t of tracks) {
        if (likedIds.has(t.id)) withDupes.push({ ...t });
      }

      // Fisher-Yates shuffle, keeping current track at index 0
      const current = currentId ? withDupes.find(t => t.id === currentId) : undefined;
      const rest    = withDupes.filter(t => t !== current);

      for (let i = rest.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [rest[i], rest[j]] = [rest[j], rest[i]];
      }

      return current ? [current, ...rest] : rest;
    },
    [liked]
  );

  return { liked, isLiked, toggle, unlike, applyWeighting };
}
