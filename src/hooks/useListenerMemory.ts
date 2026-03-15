/**
 * useListenerMemory
 *
 * Persistent per-listener memory stored in localStorage under
 * `pr:listener-memory:{listenerName}`.
 *
 * Tracks:
 *   - Song play history (with skipped / liked flags)
 *   - Disliked songs (never play again)
 *   - Liked songs (play more often via useLikedTracks weighting)
 *   - Podcast episode history (position, topics)
 *   - Recent discussion topics (last 10) for AI host context
 */

import { useState, useCallback } from 'react';
import type { WavlakeTrack } from './useWavlakeTracks';

// ── Schema ────────────────────────────────────────────────────────────────────

export interface PlayedSong {
  id: string;
  title: string;
  artist: string;
  playedAt: number;      // epoch ms
  skipped: boolean;
  liked: boolean;
}

export interface EpisodeRecord {
  episodeId: string;
  title: string;
  showName: string;
  lastPosition: number;    // seconds
  totalListened: number;   // seconds actually heard
  completedAt: number | null;
  topics: string[];
}

export interface RecentTopic {
  topic: string;
  showName: string;
  episodeTitle: string;
  heardAt: number;  // epoch ms
}

export interface ListenerMemory {
  listenerName: string;
  playedSongs: PlayedSong[];
  dislikedSongs: string[];   // song IDs — never play again
  likedSongs: string[];      // song IDs — play more often
  episodeHistory: EpisodeRecord[];
  recentTopics: RecentTopic[];
}

// ── Storage helpers ───────────────────────────────────────────────────────────

const STORAGE_PREFIX    = 'pr:listener-memory:';
const MAX_PLAYED_SONGS  = 200;
const MAX_RECENT_TOPICS = 10;

function emptyMemory(name: string): ListenerMemory {
  return {
    listenerName: name,
    playedSongs: [],
    dislikedSongs: [],
    likedSongs: [],
    episodeHistory: [],
    recentTopics: [],
  };
}

export function loadListenerMemory(name: string): ListenerMemory {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + name);
    if (!raw) return emptyMemory(name);
    const parsed = JSON.parse(raw) as Partial<ListenerMemory>;
    return { ...emptyMemory(name), ...parsed };
  } catch {
    return emptyMemory(name);
  }
}

export function saveListenerMemory(name: string, data: ListenerMemory): void {
  localStorage.setItem(STORAGE_PREFIX + name, JSON.stringify(data));
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useListenerMemory(listenerName: string) {
  const [memory, setMemory] = useState<ListenerMemory>(() => loadListenerMemory(listenerName));

  const update = useCallback((updater: (m: ListenerMemory) => ListenerMemory) => {
    setMemory(prev => {
      const next = updater(prev);
      saveListenerMemory(listenerName, next);
      return next;
    });
  }, [listenerName]);

  // ── Song tracking ──────────────────────────────────────────────────────────

  const recordSongStart = useCallback((track: WavlakeTrack) => {
    console.log(`[Memory] Song played: ${track.name}`);
    update(m => {
      const entry: PlayedSong = {
        id: track.id,
        title: track.name,
        artist: track.artist,
        playedAt: Date.now(),
        skipped: false,
        liked: m.likedSongs.includes(track.id),
      };
      return { ...m, playedSongs: [...m.playedSongs, entry].slice(-MAX_PLAYED_SONGS) };
    });
  }, [update]);

  /** Mark the most-recent entry for this track as skipped. */
  const recordSongSkip = useCallback((trackId: string) => {
    update(m => {
      // Only update the last (most recent) entry for this track
      let updated = false;
      const playedSongs = [...m.playedSongs].reverse().map(s => {
        if (!updated && s.id === trackId && !s.skipped) {
          updated = true;
          return { ...s, skipped: true };
        }
        return s;
      }).reverse();
      return { ...m, playedSongs };
    });
  }, [update]);

  /**
   * Toggle like on a track. Mirrors the liked state in playedSongs and
   * maintains the likedSongs ID list (used by the AI moderator context).
   * Call this alongside useLikedTracks.toggle() so both stores stay in sync.
   */
  const recordSongLike = useCallback((track: WavlakeTrack) => {
    update(m => {
      const alreadyLiked = m.likedSongs.includes(track.id);
      const likedSongs   = alreadyLiked
        ? m.likedSongs.filter(id => id !== track.id)
        : [...m.likedSongs, track.id];
      const playedSongs = m.playedSongs.map(s =>
        s.id === track.id ? { ...s, liked: !alreadyLiked } : s,
      );
      return { ...m, likedSongs, playedSongs };
    });
  }, [update]);

  /** Ban a song permanently. Removes from liked if present. */
  const recordSongDislike = useCallback((trackId: string) => {
    update(m => ({
      ...m,
      dislikedSongs: m.dislikedSongs.includes(trackId)
        ? m.dislikedSongs
        : [...m.dislikedSongs, trackId],
      likedSongs: m.likedSongs.filter(id => id !== trackId),
      playedSongs: m.playedSongs.map(s =>
        s.id === trackId ? { ...s, liked: false } : s,
      ),
    }));
  }, [update]);

  const isDisliked = useCallback(
    (id: string) => memory.dislikedSongs.includes(id),
    [memory.dislikedSongs],
  );

  // ── Episode tracking ───────────────────────────────────────────────────────

  const recordEpisodeStart = useCallback((
    episodeId: string,
    title: string,
    showName: string,
  ) => {
    update(m => {
      if (m.episodeHistory.some(e => e.episodeId === episodeId)) return m;
      const entry: EpisodeRecord = {
        episodeId, title, showName,
        lastPosition: 0,
        totalListened: 0,
        completedAt: null,
        topics: [],
      };
      return { ...m, episodeHistory: [...m.episodeHistory, entry] };
    });
  }, [update]);

  const recordEpisodeProgress = useCallback((
    episodeId: string,
    position: number,
    totalListened: number,
  ) => {
    console.log(`[Memory] Episode progress: ${episodeId} at ${Math.round(position)}s`);
    update(m => ({
      ...m,
      episodeHistory: m.episodeHistory.map(e =>
        e.episodeId === episodeId
          ? { ...e, lastPosition: position, totalListened }
          : e,
      ),
    }));
  }, [update]);

  const recordEpisodeComplete = useCallback((episodeId: string) => {
    update(m => ({
      ...m,
      episodeHistory: m.episodeHistory.map(e =>
        e.episodeId === episodeId ? { ...e, completedAt: Date.now() } : e,
      ),
    }));
  }, [update]);

  const addTopics = useCallback((
    episodeId: string,
    topics: string[],
    showName: string,
    episodeTitle: string,
  ) => {
    if (!topics.length) return;
    console.log(`[Memory] Topics updated: ${topics.join(', ')}`);
    const now = Date.now();
    update(m => {
      const episodeHistory = m.episodeHistory.map(e =>
        e.episodeId === episodeId
          ? { ...e, topics: [...new Set([...e.topics, ...topics])] }
          : e,
      );
      const newEntries: RecentTopic[] = topics.map(topic => ({
        topic, showName, episodeTitle, heardAt: now,
      }));
      const recentTopics = [
        ...newEntries,
        ...m.recentTopics.filter(t => !topics.includes(t.topic)),
      ].slice(0, MAX_RECENT_TOPICS);
      return { ...m, episodeHistory, recentTopics };
    });
  }, [update]);

  // ── Moderator context ──────────────────────────────────────────────────────

  /**
   * Returns a formatted context string for inclusion in the AI moderator's
   * system prompt: recent topics, 30-minute repeat guard, liked songs.
   */
  const getMemoryContext = useCallback((): string => {
    const parts: string[] = [];

    const recent5 = memory.recentTopics.slice(0, 5).map(t => t.topic);
    if (recent5.length > 0) {
      parts.push(`Recent topics the listener has heard about: ${recent5.join(', ')}.`);
      parts.push('If relevant, make natural connections to current content.');

      const thirtyMinAgo  = Date.now() - 30 * 60 * 1000;
      const recentTopics30 = memory.recentTopics
        .filter(t => t.heardAt > thirtyMinAgo)
        .map(t => t.topic);
      if (recentTopics30.length > 0) {
        parts.push(
          `Do not repeat observations about topics heard in the last 30 minutes: ${recentTopics30.join(', ')}.`,
        );
      }
    }

    return parts.join(' ');
  }, [memory]);

  return {
    memory,
    recordSongStart,
    recordSongSkip,
    recordSongLike,
    recordSongDislike,
    isDisliked,
    recordEpisodeStart,
    recordEpisodeProgress,
    recordEpisodeComplete,
    addTopics,
    getMemoryContext,
  };
}
