/**
 * useMusicHistory
 *
 * Tracks how many times each song has been played.
 * Persisted to localStorage so history survives page reloads.
 * Used to weight selection: songs played 0 times get priority,
 * frequently played songs appear less often.
 */

import { useState, useCallback } from 'react';

const STORAGE_KEY = 'pr:music-history';

export type PlayCounts = Record<string, number>;

function readHistory(): PlayCounts {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as PlayCounts;
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function writeHistory(h: PlayCounts): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(h));
}

export function useMusicHistory() {
  const [history, setHistory] = useState<PlayCounts>(readHistory);

  const markPlayed = useCallback((trackId: string) => {
    setHistory(prev => {
      const next = { ...prev, [trackId]: (prev[trackId] ?? 0) + 1 };
      writeHistory(next);
      return next;
    });
  }, []);

  const getPlayCount = useCallback(
    (trackId: string) => (history[trackId] ?? 0),
    [history]
  );

  const clearHistory = useCallback(() => {
    setHistory({});
    localStorage.removeItem(STORAGE_KEY);
  }, []);

  return { history, markPlayed, getPlayCount, clearHistory };
}

/** Read play counts without the hook (for non-React contexts). */
export function getMusicPlayCounts(): PlayCounts {
  return readHistory();
}
