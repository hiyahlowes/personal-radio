import { useState, useCallback } from 'react';
import { ALL_GENRE_IDS } from './useWavlakeTracks';

const STORAGE_KEY = 'pr:selected-genres';

function loadFromStorage(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return ALL_GENRE_IDS; // fallback so RadioPage always has music
    const parsed = JSON.parse(raw) as string[];
    // Validate: must be a non-empty array of strings
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every(s => typeof s === 'string')) {
      return parsed;
    }
    return ALL_GENRE_IDS;
  } catch {
    return ALL_GENRE_IDS;
  }
}

function saveToStorage(ids: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // quota exceeded or private browsing — silently ignore
  }
}

export function useGenreSelection() {
  const [selectedIds, setSelectedIds] = useState<string[]>(loadFromStorage);

  const toggle = useCallback((id: string) => {
    setSelectedIds(prev => {
      let next: string[];
      if (prev.includes(id)) {
        // Don't allow deselecting the last genre
        if (prev.length === 1) return prev;
        next = prev.filter(g => g !== id);
      } else {
        next = [...prev, id];
      }
      saveToStorage(next);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    saveToStorage(ALL_GENRE_IDS);
    setSelectedIds(ALL_GENRE_IDS);
  }, []);

  const isAllSelected = selectedIds.length === ALL_GENRE_IDS.length;

  return { selectedIds, toggle, selectAll, isAllSelected };
}
