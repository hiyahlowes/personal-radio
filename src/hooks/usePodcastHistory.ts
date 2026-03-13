/**
 * usePodcastHistory
 *
 * Tracks which podcast episode IDs have already been played.
 * Persisted to localStorage so history survives page reloads within a session.
 * The user can clear history from Settings.
 *
 * Usage in the queue seed:
 *   const { hasPlayed, markPlayed, clearHistory } = usePodcastHistory();
 *   // Filter episodes before seeding orderedEpisodes:
 *   const fresh = episodes.filter(ep => !hasPlayed(ep.id));
 *
 * Usage in the loop (after an episode finishes):
 *   markPlayed(episode.id);
 */

import { useState, useCallback } from 'react';

const STORAGE_KEY = 'pr:podcast-history';

function readStored(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as string[];
    return Array.isArray(parsed) ? new Set(parsed) : new Set();
  } catch {
    return new Set();
  }
}

function writeStored(ids: Set<string>): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
}

export function usePodcastHistory() {
  const [played, setPlayed] = useState<Set<string>>(readStored);

  const hasPlayed = useCallback(
    (id: string) => played.has(id),
    [played],
  );

  const markPlayed = useCallback((id: string) => {
    setPlayed(prev => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      writeStored(next);
      return next;
    });
  }, []);

  const clearHistory = useCallback(() => {
    setPlayed(new Set());
    localStorage.removeItem(STORAGE_KEY);
  }, []);

  return { played, hasPlayed, markPlayed, clearHistory };
}

/** Read the played set without the hook (for use in non-React contexts). */
export function getPlayedEpisodeIds(): Set<string> {
  return readStored();
}
