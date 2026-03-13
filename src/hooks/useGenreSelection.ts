import { useState, useCallback } from 'react';
import { ALL_GENRE_IDS, TOP_CHARTS_ID } from './useWavlakeTracks';

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

  const isTopCharts = selectedIds.includes(TOP_CHARTS_ID);

  const toggle = useCallback((id: string) => {
    setSelectedIds(prev => {
      let next: string[];

      if (id === TOP_CHARTS_ID) {
        // Top Charts is exclusive — selecting it clears all genres
        if (prev.includes(TOP_CHARTS_ID)) {
          // Already in Top Charts mode — deselect and fall back to all genres
          next = ALL_GENRE_IDS;
        } else {
          next = [TOP_CHARTS_ID];
        }
      } else {
        // Selecting a genre always exits Top Charts mode first
        const withoutTopCharts = prev.filter(g => g !== TOP_CHARTS_ID);
        if (withoutTopCharts.includes(id)) {
          // Deselect — but don't allow deselecting the last genre
          if (withoutTopCharts.length === 1) return prev;
          next = withoutTopCharts.filter(g => g !== id);
        } else {
          next = [...withoutTopCharts, id];
        }
      }

      saveToStorage(next);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    saveToStorage(ALL_GENRE_IDS);
    setSelectedIds(ALL_GENRE_IDS);
  }, []);

  const isAllSelected =
    !isTopCharts && selectedIds.length === ALL_GENRE_IDS.length;

  return { selectedIds, toggle, selectAll, isAllSelected, isTopCharts };
}
