/**
 * SettingsPage — organized with collapsible sections
 *
 * 1. YOUR NAME        — always visible
 * 2. MODERATOR        — language, TTS provider, voice IDs, agent/NIP-90
 * 3. MUSIC            — genres, liked songs, song graveyard
 * 4. PODCASTS         — active feeds (draggable), search, history
 * 5. VALUE4VALUE      — NWC connection, sat rate, PR split
 * 6. START OVER       — danger zone, clears all localStorage
 */

import { useState, useEffect, useRef } from 'react';
import { useV4VContext } from '@/contexts/V4VContext';
import { useNavigate } from 'react-router-dom';
import { useSeoMeta } from '@unhead/react';
import { useNostrKey } from '@/hooks/useNostrKey';
import {
  getStoredFeeds,
  setStoredFeeds,
  type PodcastFeed,
} from '@/hooks/usePodcastFeeds';
import {
  fetchSuggestedPodcasts,
  searchPodcasts,
  type PodcastIndexFeed,
} from '@/hooks/usePodcastIndex';
import { GENRES, ALL_GENRE_IDS, TOP_CHARTS_ID } from '@/hooks/useWavlakeTracks';
import { useLikedTracks } from '@/hooks/useLikedTracks';
import { usePodcastHistory } from '@/hooks/usePodcastHistory';
import { useEngineMode } from '@/hooks/useEngineMode';
import {
  getStoredName,
  setStoredName,
  GENRES_KEY,
} from '@/pages/SetupPage';
import { loadListenerMemory, saveListenerMemory, type ListenerMemory } from '@/hooks/useListenerMemory';

const genreEmoji: Record<string, string> = {
  ambient:    '🌊',
  electronic: '⚡',
  lofi:       '☕',
  rock:       '🎸',
  folk:       '🪕',
  jazz:       '🎷',
  classical:  '🎻',
  hiphop:     '🎤',
};

const PODCAST_SEARCH_VISIBLE_LIMIT = 10;

type EngineLikedTrack = {
  id: string;
  title?: string;
  name?: string;
  artist?: string;
  artworkUrl?: string;
  liveUrl?: string;
  duration?: number;
  likedAt?: string;
};

type EngineBlockedTrack = {
  id: string;
  value: string;
  title?: string;
  artist?: string;
  url?: string;
};

function loadStoredGenres(): string[] {
  try {
    const raw = localStorage.getItem(GENRES_KEY);
    if (!raw) return ALL_GENRE_IDS;
    const parsed = JSON.parse(raw) as string[];
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : ALL_GENRE_IDS;
  } catch {
    return ALL_GENRE_IDS;
  }
}

// ── Collapsible section header ────────────────────────────────────────────────

function SectionHeader({
  title,
  open,
  onToggle,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className="w-full flex items-center justify-between py-3 px-1 group"
    >
      <span className="text-xs font-bold tracking-[0.2em] uppercase text-white/40 group-hover:text-white/60 transition-colors">
        {title}
      </span>
      <svg
        className={`w-4 h-4 text-white/25 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
      >
        <path d="M6 9l6 6 6-6"/>
      </svg>
    </button>
  );
}

// ── Saved indicator ────────────────────────────────────────────────────────────

function SavedBadge() {
  return (
    <span className="text-xs text-green-400 font-semibold flex items-center gap-1">
      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
        <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
      </svg>
      Saved
    </span>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export function SettingsPage() {
  useSeoMeta({ title: 'Settings — PR Personal Radio' });
  const navigate = useNavigate();
  const nostrKey = useNostrKey();
  const engineMode = useEngineMode();
  const [remoteVolumeDrafts, setRemoteVolumeDrafts] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!engineMode.isRemote) return;
    engineMode.refreshSettings();
    engineMode.refreshVolumes();
  }, [engineMode.isRemote]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!engineMode.volumes) return;
    setRemoteVolumeDrafts(prev => {
      const next = { ...prev };
      for (const [name, value] of Object.entries(engineMode.volumes ?? {})) {
        if (typeof value.volume === 'number' && !(name in next)) next[name] = value.volume;
      }
      return next;
    });
  }, [engineMode.volumes]);

  // ── Section open/closed ────────────────────────────────────────────────────
  const [moderatorOpen, setModeratorOpen] = useState(false);
  const [musicOpen, setMusicOpen]         = useState(false);
  const [podcastsOpen, setPodcastsOpen]   = useState(false);

  // ── Listener name ──────────────────────────────────────────────────────────
  const [listenerName, setListenerName] = useState(getStoredName);
  const [nameSaved, setNameSaved]       = useState(false);

  const saveName = () => {
    setStoredName(listenerName.trim());
    setNameSaved(true);
    setTimeout(() => setNameSaved(false), 2000);
  };

  // ── Language ───────────────────────────────────────────────────────────────
  const LANGUAGE_KEY = 'pr:language';
  const LANGUAGES = [
    { value: 'English',  label: 'English',  flag: '🇬🇧' },
    { value: 'Deutsch',  label: 'Deutsch',  flag: '🇩🇪' },
    { value: 'Français', label: 'Français', flag: '🇫🇷' },
  ];
  const [language, setLanguage] = useState(
    () => localStorage.getItem(LANGUAGE_KEY) || 'English'
  );
  const selectLanguage = (lang: string) => {
    setLanguage(lang);
    localStorage.setItem(LANGUAGE_KEY, lang);
  };

  // ── TTS Provider ───────────────────────────────────────────────────────────
  const [ttsProvider, setTtsProvider] = useState<'elevenlabs' | 'fish'>(
    () => (localStorage.getItem('pr:tts-provider') === 'fish' ? 'fish' : 'elevenlabs')
  );
  const [fishVoiceIdEn, setFishVoiceIdEn] = useState(
    () => localStorage.getItem('pr:fish-voice-id-en') ?? ''
  );
  const [fishVoiceIdDe, setFishVoiceIdDe] = useState(
    () => localStorage.getItem('pr:fish-voice-id-de') ?? ''
  );
  const [elevenVoiceIdEn, setElevenVoiceIdEn] = useState(
    () => localStorage.getItem('pr:elevenlabs-voice-id-en') ?? ''
  );
  const [elevenVoiceIdDe, setElevenVoiceIdDe] = useState(
    () => localStorage.getItem('pr:elevenlabs-voice-id-de') ?? ''
  );
  const [elevenModelId, setElevenModelId] = useState(
    () => localStorage.getItem('pr:elevenlabs-model-id') ?? 'eleven_v3'
  );
  const selectTtsProvider = (p: 'elevenlabs' | 'fish') => {
    setTtsProvider(p);
    localStorage.setItem('pr:tts-provider', p);
    if (engineMode.isRemote) engineMode.saveSettings({ ttsProvider: p });
  };
  const saveElevenVoiceSettings = () => {
    localStorage.setItem('pr:elevenlabs-voice-id-en', elevenVoiceIdEn.trim());
    localStorage.setItem('pr:elevenlabs-voice-id-de', elevenVoiceIdDe.trim());
    localStorage.setItem('pr:elevenlabs-model-id', elevenModelId.trim() || 'eleven_v3');
    if (engineMode.isRemote) {
      engineMode.saveSettings({
        elevenLabsVoiceIdEn: elevenVoiceIdEn.trim(),
        elevenLabsVoiceIdDe: elevenVoiceIdDe.trim(),
        elevenLabsModelId: elevenModelId.trim() || 'eleven_v3',
      });
    }
  };
  const saveFishVoiceIds = () => {
    localStorage.setItem('pr:fish-voice-id-en', fishVoiceIdEn.trim());
    localStorage.setItem('pr:fish-voice-id-de', fishVoiceIdDe.trim());
    if (engineMode.isRemote) {
      engineMode.saveSettings({
        fishVoiceIdEn: fishVoiceIdEn.trim(),
        fishVoiceIdDe: fishVoiceIdDe.trim(),
      });
    }
  };

  // ── Agent (NIP-90) ─────────────────────────────────────────────────────────
  const [nip90Enabled, setNip90Enabled] = useState<boolean>(
    () => localStorage.getItem('pr:nip90-enabled') === 'true'
  );
  const [agentNpub, setAgentNpub]       = useState(() => localStorage.getItem('pr:agent-npub')      ?? '');
  const [agentRelay, setAgentRelay]     = useState(() => localStorage.getItem('pr:agent-relay')     ?? 'wss://relay.damus.io');
  const [listenerNpub, setListenerNpub] = useState(() => localStorage.getItem('pr:listener-npub')   ?? '');
  const [npubCopied, setNpubCopied]     = useState(false);

  const toggleNip90 = () => {
    const next = !nip90Enabled;
    setNip90Enabled(next);
    localStorage.setItem('pr:nip90-enabled', String(next));
  };
  const saveAgentSettings = () => {
    localStorage.setItem('pr:agent-npub',    agentNpub.trim());
    localStorage.setItem('pr:agent-relay',   agentRelay.trim() || 'wss://relay.damus.io');
    localStorage.setItem('pr:listener-npub', listenerNpub.trim());
  };
  const copyNpub = () => {
    navigator.clipboard.writeText(nostrKey.npub).then(() => {
      setNpubCopied(true);
      setTimeout(() => setNpubCopied(false), 2000);
    }).catch(() => {});
  };

  // ── Genre selection ────────────────────────────────────────────────────────
  const [selectedGenres, setSelectedGenres] = useState<string[]>(loadStoredGenres);
  const [genresSaved, setGenresSaved]       = useState(false);
  const [playlistIdDraft, setPlaylistIdDraft] = useState('');
  const [playlistPreview, setPlaylistPreview] = useState<{ id: string; title: string; count: number } | null>(null);
  const [playlistLoading, setPlaylistLoading] = useState(false);
  const [playlistError, setPlaylistError] = useState('');
  const [musicSourceSaved, setMusicSourceSaved] = useState(false);

  const toggleGenre = (id: string) => {
    setSelectedGenres(prev => {
      let next: string[];
      if (id === TOP_CHARTS_ID) {
        next = prev.includes(TOP_CHARTS_ID) ? ALL_GENRE_IDS : [TOP_CHARTS_ID];
      } else {
        const withoutTop = prev.filter(g => g !== TOP_CHARTS_ID);
        if (withoutTop.includes(id)) {
          if (withoutTop.length === 1) return prev;
          next = withoutTop.filter(g => g !== id);
        } else {
          next = [...withoutTop, id];
        }
      }
      localStorage.setItem(GENRES_KEY, JSON.stringify(next));
      setGenresSaved(true);
      setTimeout(() => setGenresSaved(false), 1500);
      return next;
    });
  };

  const isTopChartsSelected = selectedGenres.includes(TOP_CHARTS_ID);

  const selectAllGenres = () => {
    setSelectedGenres(ALL_GENRE_IDS);
    localStorage.setItem(GENRES_KEY, JSON.stringify(ALL_GENRE_IDS));
    setGenresSaved(true);
    setTimeout(() => setGenresSaved(false), 1500);
  };

  const flashMusicSourceSaved = () => {
    setMusicSourceSaved(true);
    setTimeout(() => setMusicSourceSaved(false), 1800);
  };

  const previewWavlakePlaylist = async () => {
    const id = playlistIdDraft.trim();
    if (!id) { setPlaylistError('Enter a Wavlake playlist ID.'); return null; }
    setPlaylistLoading(true);
    setPlaylistError('');
    try {
      const res = await fetch(`/api/wavlake-playlist?id=${encodeURIComponent(id)}`);
      const data = await res.json() as { id: string; title: string; count: number; error?: string };
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
      setPlaylistPreview({ id: data.id, title: data.title, count: data.count });
      return data;
    } catch (err) {
      setPlaylistPreview(null);
      setPlaylistError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setPlaylistLoading(false);
    }
  };

  const setRemoteMusicSource = async (source: 'topCharts' | 'wavlakePlaylist' | 'prLikedSongs') => {
    if (!engineMode.isRemote) return;
    if (source === 'wavlakePlaylist') {
      const preview = playlistPreview?.id === playlistIdDraft.trim() ? playlistPreview : await previewWavlakePlaylist();
      if (!preview) return;
      await engineMode.saveSettings({
        musicSource: source,
        wavlakePlaylistId: preview.id,
        wavlakePlaylistTitle: preview.title,
      });
    } else {
      await engineMode.saveSettings({ musicSource: source });
    }
    flashMusicSourceSaved();
  };

  // ── Podcast feeds ──────────────────────────────────────────────────────────
  const [feeds, setFeeds]         = useState<PodcastFeed[]>(getStoredFeeds);
  const [error, setError]         = useState('');
  const [feedSaved, setFeedSaved] = useState(false);
  const [podcastRefreshing, setPodcastRefreshing] = useState(false);
  const [podcastRefreshError, setPodcastRefreshError] = useState('');
  const syncedFeedsToEngineRef = useRef(false);

  // ── Podcast search / trending ──────────────────────────────────────────────
  const [query, setQuery]                   = useState('');
  const [trending, setTrending]             = useState<PodcastIndexFeed[]>([]);
  const [results, setResults]               = useState<PodcastIndexFeed[]>([]);
  const [searchLoading, setSearchLoading]   = useState(false);
  const [searchError, setSearchError]       = useState('');
  const [addedIds, setAddedIds]             = useState<Set<number>>(new Set());
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setSearchLoading(true);
    fetchSuggestedPodcasts()
      .then(setTrending)
      .catch(err => setSearchError(String(err)))
      .finally(() => setSearchLoading(false));
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim()) { setResults([]); return; }
    debounceRef.current = setTimeout(async () => {
      setSearchLoading(true);
      setSearchError('');
      try {
        const res = await searchPodcasts(query);
        setResults(res);
      } catch (err) {
        setSearchError(String(err));
      } finally {
        setSearchLoading(false);
      }
    }, 400);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query]);

  const saveFeeds = (next: PodcastFeed[]) => {
    setFeeds(next);
    setStoredFeeds(next);
    if (engineMode.isRemote) {
      engineMode.saveSettings({
        podcastFeeds: next,
        podcastFeedUrl: next[0]?.url ?? '',
      });
    }
    setFeedSaved(true);
    setTimeout(() => setFeedSaved(false), 2000);
    window.dispatchEvent(new Event('pr:feeds-updated'));
  };

  useEffect(() => {
    if (!engineMode.isRemote || !engineMode.settings || syncedFeedsToEngineRef.current) return;
    if (feeds.length === 0) return;
    const remoteFeeds = engineMode.settings.podcastFeeds ?? [];
    const sameFeeds = remoteFeeds.length === feeds.length
      && remoteFeeds.every((feed, index) => feed.url === feeds[index]?.url);
    if (sameFeeds) return;
    syncedFeedsToEngineRef.current = true;
    engineMode.saveSettings({
      podcastFeeds: feeds,
      podcastFeedUrl: feeds[0]?.url ?? '',
    });
  }, [engineMode.isRemote, engineMode.settings, feeds]); // eslint-disable-line react-hooks/exhaustive-deps

  const addFeedByUrl = (url: string, title: string) => {
    setError('');
    if (!url.startsWith('http')) { setError('URL must start with http:// or https://'); return; }
    if (feeds.find(f => f.url === url)) { setError('That feed is already in your list.'); return; }
    saveFeeds([...feeds, { url, title: title || new URL(url).hostname }]);
  };

  const addFromIndex = (feed: PodcastIndexFeed) => {
    if (feeds.find(f => f.url === feed.url)) return;
    saveFeeds([...feeds, { url: feed.url, title: feed.title }]);
    setAddedIds(prev => new Set(prev).add(feed.id));
  };

  const removeFeed = (url: string) => saveFeeds(feeds.filter(f => f.url !== url));

  const refreshPodcastQueue = async () => {
    if (!engineMode.isRemote) return;
    setPodcastRefreshing(true);
    setPodcastRefreshError('');
    try {
      await engineMode.refreshPodcastQueue();
      setFeedSaved(true);
      setTimeout(() => setFeedSaved(false), 2000);
    } catch (err) {
      setPodcastRefreshError(err instanceof Error ? err.message : String(err));
    } finally {
      setPodcastRefreshing(false);
    }
  };

  // ── Drag-to-reorder feeds ──────────────────────────────────────────────────
  const dragIdx = useRef<number | null>(null);

  const handleDragStart = (i: number) => { dragIdx.current = i; };
  const handleDragOver  = (e: React.DragEvent) => e.preventDefault();
  const handleDrop      = (i: number) => {
    const from = dragIdx.current;
    if (from === null || from === i) return;
    const next = [...feeds];
    const [moved] = next.splice(from, 1);
    next.splice(i, 0, moved);
    dragIdx.current = null;
    saveFeeds(next);
  };

  // ── Liked tracks ───────────────────────────────────────────────────────────
  const { liked, unlike } = useLikedTracks();
  const [engineLiked, setEngineLiked] = useState<EngineLikedTrack[]>([]);
  const [engineBlocked, setEngineBlocked] = useState<EngineBlockedTrack[]>([]);
  const [likedExportText, setLikedExportText] = useState('');
  const [likedExportCopied, setLikedExportCopied] = useState(false);

  const refreshEngineLiked = async () => {
    if (!engineMode.isRemote) return;
    try {
      const res = await fetch('/api/liked');
      const data = await res.json() as { liked?: EngineLikedTrack[] };
      setEngineLiked(Array.isArray(data.liked) ? data.liked : []);
    } catch {
      setEngineLiked([]);
    }
  };

  const refreshEngineBlocked = async () => {
    if (!engineMode.isRemote) return;
    try {
      const res = await fetch('/api/blocked');
      const data = await res.json() as { blocked?: EngineBlockedTrack[] };
      setEngineBlocked(Array.isArray(data.blocked) ? data.blocked : []);
    } catch {
      setEngineBlocked([]);
    }
  };

  useEffect(() => {
    refreshEngineLiked();
    refreshEngineBlocked();
  }, [engineMode.isRemote]); // eslint-disable-line react-hooks/exhaustive-deps

  const exportLikedSongs = async (format: 'txt' | 'csv') => {
    if (engineMode.isRemote) {
      const res = await fetch(`/api/liked/export?format=${format}`);
      const text = await res.text();
      if (format === 'txt') {
        setLikedExportText(text);
        await navigator.clipboard.writeText(text).catch(() => {});
        setLikedExportCopied(true);
        setTimeout(() => setLikedExportCopied(false), 1800);
      } else {
        const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
        const href = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = href;
        a.download = 'pr-liked-wavlake-tracks.csv';
        a.click();
        URL.revokeObjectURL(href);
      }
      return;
    }

    const rows = liked.map(track => ({
      id: track.id,
      title: track.name,
      artist: track.artist,
      url: `https://wavlake.com/track/${track.id}`,
    }));
    const text = format === 'csv'
      ? [
          '"id","title","artist","url"',
          ...rows.map(r => [r.id, r.title, r.artist, r.url].map(v => `"${String(v).replaceAll('"', '""')}"`).join(',')),
        ].join('\n')
      : rows.map(r => `${r.title} — ${r.artist}\n${r.url}\n${r.id}`).join('\n\n');
    if (format === 'txt') {
      setLikedExportText(text);
      await navigator.clipboard.writeText(text).catch(() => {});
      setLikedExportCopied(true);
      setTimeout(() => setLikedExportCopied(false), 1800);
    } else {
      const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = 'pr-liked-wavlake-tracks.csv';
      a.click();
      URL.revokeObjectURL(href);
    }
  };

  // ── Podcast history ────────────────────────────────────────────────────────
  const { played: playedEpisodes, clearHistory } = usePodcastHistory();
  const [historyClearedMsg, setHistoryClearedMsg] = useState(false);
  const handleClearHistory = () => {
    clearHistory();
    setHistoryClearedMsg(true);
    setTimeout(() => setHistoryClearedMsg(false), 2000);
  };

  // ── Song Graveyard ─────────────────────────────────────────────────────────
  const [graveyardMemory, setGraveyardMemory] = useState<ListenerMemory>(
    () => loadListenerMemory(getStoredName() || 'Listener')
  );
  const [restoredId, setRestoredId] = useState<string | null>(null);

  const resurrect = (trackId: string) => {
    setGraveyardMemory(prev => {
      const next = { ...prev, dislikedSongs: prev.dislikedSongs.filter(id => id !== trackId) };
      saveListenerMemory(prev.listenerName, next);
      return next;
    });
    setRestoredId(trackId);
    setTimeout(() => setRestoredId(null), 2000);
  };

  const songInfo = (trackId: string) =>
    [...graveyardMemory.playedSongs].reverse().find(s => s.id === trackId);

  // ── Value4Value ────────────────────────────────────────────────────────────
  const v4v = useV4VContext();
  const [v4vOpen, setV4vOpen]           = useState(false);
  const [nwcInput, setNwcInput]         = useState(v4v.connectionString ?? '');
  const [v4vSaved, setV4vSaved]         = useState(false);
  const [boostAmountSats, setBoostAmountSats] = useState(100);

  useEffect(() => {
    if (!engineMode.isRemote || !engineMode.settings) return;
    const s = engineMode.settings;
    if (s.ttsProvider) {
      setTtsProvider(s.ttsProvider);
      localStorage.setItem('pr:tts-provider', s.ttsProvider);
    }
    setFishVoiceIdEn(s.fishVoiceIdEn ?? '');
    setFishVoiceIdDe(s.fishVoiceIdDe ?? '');
    setElevenVoiceIdEn(s.elevenLabsVoiceIdEn ?? '');
    setElevenVoiceIdDe(s.elevenLabsVoiceIdDe ?? '');
    setElevenModelId(s.elevenLabsModelId ?? 'eleven_v3');
    setBoostAmountSats(s.boostAmountSats ?? 100);
    setPlaylistIdDraft(s.wavlakePlaylistId ?? '');
    if (s.wavlakePlaylistId && s.wavlakePlaylistTitle) {
      setPlaylistPreview({ id: s.wavlakePlaylistId, title: s.wavlakePlaylistTitle, count: 0 });
    }
    if (Array.isArray(s.podcastFeeds)) setFeeds(s.podcastFeeds);
    if (typeof s.satRatePerMinute === 'number') v4v.setSatRatePerMinute(s.satRatePerMinute);
    if (typeof s.supportPREnabled === 'boolean') v4v.setSupportPREnabled(s.supportPREnabled);
    if (typeof s.prSplitPercent === 'number') v4v.setPRSplitPercent(s.prSplitPercent);
  }, [engineMode.isRemote, engineMode.settings]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveV4VSettings = () => {
    v4v.setSatRatePerMinute(v4v.satRatePerMinute);
    v4v.setSupportPREnabled(v4v.supportPREnabled);
    v4v.setPRSplitPercent(v4v.prSplitPercent);
    if (engineMode.isRemote) {
      engineMode.saveSettings({
        satStreamingEnabled: v4v.isConnected,
        satRatePerMinute: v4v.satRatePerMinute,
        supportPREnabled: v4v.supportPREnabled,
        prSplitPercent: v4v.prSplitPercent,
        boostAmountSats,
      });
    }
    setV4vSaved(true);
    setTimeout(() => setV4vSaved(false), 2000);
  };

  const handleConnectNWC = async () => {
    const trimmed = nwcInput.trim();
    if (!trimmed) return;
    await v4v.connect(trimmed);
  };

  // ── Start Over ─────────────────────────────────────────────────────────────
  const [confirmStartOver, setConfirmStartOver] = useState(false);

  const handleStartOver = () => {
    Object.keys(localStorage)
      .filter(k => k.startsWith('pr:'))
      .forEach(k => localStorage.removeItem(k));
    navigate('/setup');
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  const visibleLikedTracks = engineMode.isRemote ? engineLiked : liked;
  const visibleBlockedTracks = engineMode.isRemote
    ? engineBlocked
    : graveyardMemory.dislikedSongs.map(trackId => {
        const info = songInfo(trackId);
        return {
          id: trackId,
          value: trackId,
          title: info?.title ?? trackId,
          artist: info?.artist ?? '',
          url: '',
        };
      });
  const remoteOutputNames = Array.from(new Set([
    ...Object.keys(engineMode.status?.outputs ?? {}),
    ...Object.keys(engineMode.volumes ?? {}),
  ]));

  return (
    <div className="min-h-screen gradient-bg text-white">
      <div className="max-w-2xl mx-auto px-4 py-8">

        {/* Header */}
        <header className="flex items-center gap-4 fade-in-up mb-8">
          <button
            onClick={() => navigate(-1)}
            className="w-9 h-9 rounded-full flex items-center justify-center text-white/50 hover:text-white hover:bg-white/10 transition-all"
            aria-label="Go back"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M15 18l-6-6 6-6"/>
            </svg>
          </button>
          <div>
            <p className="text-xs tracking-[0.25em] text-purple-400 uppercase font-semibold">PR Personal Radio</p>
            <h1 className="text-2xl font-bold">Settings</h1>
          </div>
        </header>

        {/* ── 1. YOUR NAME ─────────────────────────────────────────────────── */}
        <div className="fade-in-up mb-1">
          <p className="text-xs font-bold tracking-[0.2em] uppercase text-white/40 mb-3 px-1">Your Name</p>
          <div className="glass-card rounded-2xl p-4 flex items-center gap-3">
            <input
              type="text"
              value={listenerName}
              onChange={e => setListenerName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && listenerName.trim() && saveName()}
              placeholder="Your name…"
              maxLength={50}
              className="flex-1 px-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-sm text-white placeholder-white/25 outline-none focus:border-purple-500 transition-colors"
            />
            {nameSaved ? (
              <SavedBadge />
            ) : (
              <button
                onClick={saveName}
                disabled={!listenerName.trim()}
                className="flex-shrink-0 px-4 py-2.5 bg-purple-600/20 text-purple-300 border border-purple-500/30 rounded-xl text-sm font-semibold hover:bg-purple-600/40 hover:text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Save
              </button>
            )}
          </div>
        </div>

        {engineMode.isRemote && (
          <div className="mt-6 border-t border-white/[0.06] pt-6">
            <p className="text-xs font-bold tracking-[0.2em] uppercase text-white/40 mb-3 px-1">Pi Audio</p>
            <div className="glass-card rounded-2xl p-4 space-y-4">
              <div className="rounded-xl border border-emerald-400/15 bg-emerald-500/5 px-3 py-2.5 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-emerald-200">Livestream</p>
                  <p className="text-xs text-white/35 truncate">Tailscale only · /live.mp3</p>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <a
                    href="/live.mp3"
                    className="px-3 py-1.5 rounded-lg bg-emerald-500/15 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/25 transition-colors"
                  >
                    Open
                  </a>
                  <a
                    href="/live.m3u"
                    className="px-3 py-1.5 rounded-lg bg-white/10 text-xs font-semibold text-white/65 hover:bg-white/15 transition-colors"
                  >
                    M3U
                  </a>
                </div>
              </div>

              {remoteOutputNames.map(output => {
                const current = remoteVolumeDrafts[output] ?? engineMode.volumes?.[output]?.volume ?? 0.8;
                const active = engineMode.status?.outputs?.[output]?.playing;
                const error = engineMode.status?.outputs?.[output]?.error;
                return (
                  <div key={output} className="space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${error ? 'bg-red-400' : active ? 'bg-green-400' : 'bg-white/25'}`} />
                        <span className="text-sm font-semibold text-white/70 capitalize">{output}</span>
                      </div>
                      <span className="text-xs text-white/35">{Math.round(current * 100)}%</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.02}
                      value={current}
                      onChange={e => {
                        const volume = Number(e.target.value);
                        setRemoteVolumeDrafts(prev => ({ ...prev, [output]: volume }));
                        engineMode.setVolume(output, volume);
                      }}
                      className="w-full accent-purple-400"
                    />
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── 2. MODERATOR ─────────────────────────────────────────────────── */}
        <div className="mt-6 border-t border-white/[0.06]">
          <SectionHeader title="Moderator" open={moderatorOpen} onToggle={() => setModeratorOpen(o => !o)} />
        </div>

        {moderatorOpen && (
          <div className="pb-4 space-y-5">

            {/* Language */}
            <div className="space-y-2">
              <p className="text-xs text-white/35 px-1">Language</p>
              <div className="glass-card rounded-2xl p-3 flex gap-2">
                {LANGUAGES.map(lang => (
                  <button
                    key={lang.value}
                    onClick={() => selectLanguage(lang.value)}
                    aria-pressed={language === lang.value}
                    className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl border text-sm font-semibold transition-all duration-150 select-none
                      ${language === lang.value
                        ? 'bg-purple-600/25 border-purple-500/60 text-purple-200 shadow-sm shadow-purple-900/40'
                        : 'bg-white/5 border-white/10 text-white/40 hover:border-white/25 hover:text-white/60'
                      }`}
                  >
                    <span>{lang.flag}</span>
                    {lang.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Voice Provider */}
            <div className="space-y-2">
              <p className="text-xs text-white/35 px-1">Voice Provider</p>
              <div className="glass-card rounded-2xl p-3 space-y-3">
                <div className="flex gap-2">
                  {(['elevenlabs', 'fish'] as const).map(p => (
                    <button
                      key={p}
                      onClick={() => selectTtsProvider(p)}
                      aria-pressed={ttsProvider === p}
                      className={`flex-1 py-2.5 rounded-xl border text-sm font-semibold transition-all duration-150 select-none
                        ${ttsProvider === p
                          ? 'bg-purple-600/25 border-purple-500/60 text-purple-200 shadow-sm shadow-purple-900/40'
                          : 'bg-white/5 border-white/10 text-white/40 hover:border-white/25 hover:text-white/60'
                        }`}
                    >
                      {p === 'elevenlabs' ? 'ElevenLabs' : 'Fish Audio'}
                    </button>
                  ))}
                </div>

                {ttsProvider === 'elevenlabs' && (
                  <div className="space-y-2 pt-1">
                    <input
                      type="text"
                      value={elevenVoiceIdEn}
                      onChange={e => setElevenVoiceIdEn(e.target.value)}
                      onBlur={saveElevenVoiceSettings}
                      placeholder="ElevenLabs Voice ID - English"
                      className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder-white/25 focus:outline-none focus:border-purple-500/50"
                    />
                    <input
                      type="text"
                      value={elevenVoiceIdDe}
                      onChange={e => setElevenVoiceIdDe(e.target.value)}
                      onBlur={saveElevenVoiceSettings}
                      placeholder="ElevenLabs Voice ID - Deutsch / Otto"
                      className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder-white/25 focus:outline-none focus:border-purple-500/50"
                    />
                    <input
                      type="text"
                      value={elevenModelId}
                      onChange={e => setElevenModelId(e.target.value)}
                      onBlur={saveElevenVoiceSettings}
                      placeholder="ElevenLabs model"
                      className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder-white/25 focus:outline-none focus:border-purple-500/50"
                    />
                  </div>
                )}

                {ttsProvider === 'fish' && (
                  <div className="space-y-2 pt-1">
                    <p className="text-xs text-white/35 leading-relaxed">
                      Enter your Fish Audio <span className="text-white/55">reference_id</span> from{' '}
                      <span className="text-purple-300">fish.audio</span>. API key is set server-side.
                    </p>
                    <input
                      type="text"
                      value={fishVoiceIdEn}
                      onChange={e => setFishVoiceIdEn(e.target.value)}
                      onBlur={saveFishVoiceIds}
                      placeholder="Voice ID — English"
                      className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder-white/25 focus:outline-none focus:border-purple-500/50"
                    />
                    <input
                      type="text"
                      value={fishVoiceIdDe}
                      onChange={e => setFishVoiceIdDe(e.target.value)}
                      onBlur={saveFishVoiceIds}
                      placeholder="Voice ID — Deutsch (optional)"
                      className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder-white/25 focus:outline-none focus:border-purple-500/50"
                    />
                  </div>
                )}
              </div>
            </div>

            {engineMode.isRemote && (
              <div className="space-y-2">
                <p className="text-xs text-white/35 px-1">Remote Moderation</p>
                <div className="glass-card rounded-2xl p-4 space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-white/70 leading-snug">Moderation</p>
                      <p className="text-xs text-white/25 leading-relaxed mt-0.5">Generated by Via, spoken by the selected voice provider.</p>
                    </div>
                    <button
                      onClick={() => engineMode.saveSettings({ moderationEnabled: !engineMode.settings?.moderationEnabled })}
                      className={`relative w-10 h-5 rounded-full transition-colors ${engineMode.settings?.moderationEnabled ? 'bg-purple-500' : 'bg-white/15'}`}
                    >
                      <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${engineMode.settings?.moderationEnabled ? 'translate-x-5' : ''}`} />
                    </button>
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-semibold text-white/40 uppercase tracking-widest">Every songs</p>
                      <span className="text-sm font-bold text-purple-300">{engineMode.settings?.moderationAfterSongs ?? 3}</span>
                    </div>
                    <input
                      type="range"
                      min={1}
                      max={10}
                      value={engineMode.settings?.moderationAfterSongs ?? 3}
                      onChange={e => engineMode.saveSettings({ moderationAfterSongs: Number(e.target.value) })}
                      className="w-full accent-purple-400"
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Connect Your Agent */}
            <div className="space-y-2">
              <p className="text-xs text-white/35 px-1">Connect Your Agent</p>
              <div className="glass-card rounded-2xl p-4 space-y-4">

                {/* PR Identity */}
                <div className="space-y-1.5">
                  <p className="text-xs font-semibold text-white/35 uppercase tracking-widest">Your PR Identity</p>
                  <p className="text-xs text-white/25">Share this with your agent so it recognises you</p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 px-3 py-2 bg-white/5 border border-white/10 rounded-xl text-xs text-white/55 truncate select-all">
                      {nostrKey.npub}
                    </code>
                    <button
                      onClick={copyNpub}
                      className="flex-shrink-0 px-3 py-2 rounded-xl text-xs font-semibold border transition-all text-white/45 border-white/10 hover:border-purple-500/40 hover:text-purple-300"
                    >
                      {npubCopied ? '✓ Copied' : 'Copy'}
                    </button>
                  </div>
                </div>

                {/* Agent npub */}
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-white/35 uppercase tracking-widest">Agent npub</label>
                  <input
                    type="text"
                    value={agentNpub}
                    onChange={e => setAgentNpub(e.target.value)}
                    onBlur={saveAgentSettings}
                    placeholder="npub1…"
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder-white/25 focus:outline-none focus:border-purple-500/50"
                  />
                </div>

                {/* Relay */}
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-white/35 uppercase tracking-widest">Relay</label>
                  <input
                    type="text"
                    value={agentRelay}
                    onChange={e => setAgentRelay(e.target.value)}
                    onBlur={saveAgentSettings}
                    placeholder="wss://relay.damus.io"
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder-white/25 focus:outline-none focus:border-purple-500/50"
                  />
                </div>

                {/* Your npub (optional) */}
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-white/35 uppercase tracking-widest">
                    Your npub <span className="text-white/20 normal-case font-normal">(optional)</span>
                  </label>
                  <input
                    type="text"
                    value={listenerNpub}
                    onChange={e => setListenerNpub(e.target.value)}
                    onBlur={saveAgentSettings}
                    placeholder="npub1… (your own Nostr identity)"
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder-white/25 focus:outline-none focus:border-purple-500/50"
                  />
                </div>

                {/* Enable Agent toggle */}
                <div className="flex items-start gap-3">
                  <button
                    role="checkbox"
                    aria-checked={nip90Enabled}
                    onClick={toggleNip90}
                    className={`mt-0.5 flex-shrink-0 w-5 h-5 rounded-md border transition-all duration-150 flex items-center justify-center
                      ${nip90Enabled
                        ? 'bg-purple-600/70 border-purple-500/80'
                        : 'bg-white/5 border-white/15 hover:border-white/30'
                      }`}
                  >
                    {nip90Enabled && (
                      <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 12 12" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M2 6l3 3 5-5" />
                      </svg>
                    )}
                  </button>
                  <div>
                    <p className="text-sm text-white/70 leading-snug">Enable Agent (NIP-90)</p>
                    <p className="text-xs text-white/25 leading-relaxed mt-0.5">
                      Enable when your agent is ready to receive requests. Falls back to Claude if no response within 3 s.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── 3. MUSIC ─────────────────────────────────────────────────────── */}
        <div className="mt-2 border-t border-white/[0.06]">
          <SectionHeader title="Music" open={musicOpen} onToggle={() => setMusicOpen(o => !o)} />
        </div>

        {musicOpen && (
          <div className="pb-4 space-y-5">

            {/* Genres */}
            <div className="space-y-2">
              <div className="flex items-center justify-between px-1">
                <p className="text-xs text-white/35">Genres</p>
                <div className="flex items-center gap-3">
                  {genresSaved && <SavedBadge />}
                  {!isTopChartsSelected && selectedGenres.length !== ALL_GENRE_IDS.length && (
                    <button onClick={selectAllGenres} className="text-xs text-purple-400 hover:text-purple-300 transition-colors">
                      All
                    </button>
                  )}
                </div>
              </div>
              <div className="glass-card rounded-2xl p-4">
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => toggleGenre(TOP_CHARTS_ID)}
                    aria-pressed={isTopChartsSelected}
                    className={`flex items-center gap-2 px-3.5 py-2 rounded-xl border transition-all duration-150 text-sm font-semibold select-none
                      ${isTopChartsSelected
                        ? 'bg-amber-500/20 border-amber-400/60 text-amber-200 shadow-sm shadow-amber-900/40'
                        : 'bg-white/5 border-white/10 text-white/40 hover:border-amber-500/40 hover:text-amber-300/70'
                      }`}
                  >
                    <span>⚡</span> Top Charts
                  </button>
                  {GENRES.map(genre => {
                    const active = !isTopChartsSelected && selectedGenres.includes(genre.id);
                    return (
                      <button
                        key={genre.id}
                        onClick={() => toggleGenre(genre.id)}
                        aria-pressed={active}
                        className={`flex items-center gap-2 px-3.5 py-2 rounded-xl border transition-all duration-150 text-sm font-semibold select-none
                          ${active
                            ? 'bg-purple-600/25 border-purple-500/60 text-purple-200 shadow-sm shadow-purple-900/40'
                            : 'bg-white/5 border-white/10 text-white/40 hover:border-white/25 hover:text-white/60'
                          } ${isTopChartsSelected ? 'opacity-40' : ''}`}
                      >
                        <span>{genreEmoji[genre.id] ?? '🎵'}</span>
                        {genre.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {engineMode.isRemote && (
              <div className="space-y-2">
                <div className="flex items-center justify-between px-1">
                  <p className="text-xs text-white/35">Radio Music Source</p>
                  {musicSourceSaved && <SavedBadge />}
                </div>
                <div className="glass-card rounded-2xl p-4 space-y-4">
                  <div className="grid grid-cols-3 gap-2">
                    <button
                      onClick={() => setRemoteMusicSource('topCharts')}
                      className={`px-3 py-2 rounded-xl border text-xs font-semibold transition-all ${engineMode.settings?.musicSource !== 'wavlakePlaylist' && engineMode.settings?.musicSource !== 'prLikedSongs' ? 'bg-amber-500/20 border-amber-400/50 text-amber-200' : 'bg-white/5 border-white/10 text-white/45 hover:text-white/70'}`}
                    >
                      Top Charts
                    </button>
                    <button
                      onClick={() => setRemoteMusicSource('prLikedSongs')}
                      className={`px-3 py-2 rounded-xl border text-xs font-semibold transition-all ${engineMode.settings?.musicSource === 'prLikedSongs' ? 'bg-pink-500/20 border-pink-400/50 text-pink-200' : 'bg-white/5 border-white/10 text-white/45 hover:text-white/70'}`}
                    >
                      PR Liked
                    </button>
                    <button
                      onClick={() => setRemoteMusicSource('wavlakePlaylist')}
                      className={`px-3 py-2 rounded-xl border text-xs font-semibold transition-all ${engineMode.settings?.musicSource === 'wavlakePlaylist' ? 'bg-purple-500/20 border-purple-400/50 text-purple-200' : 'bg-white/5 border-white/10 text-white/45 hover:text-white/70'}`}
                    >
                      Playlist
                    </button>
                  </div>

                  <div className="space-y-2">
                    <label className="text-xs text-white/35 px-1" htmlFor="wavlake-playlist-id">Wavlake Playlist ID</label>
                    <div className="flex gap-2">
                      <input
                        id="wavlake-playlist-id"
                        type="text"
                        value={playlistIdDraft}
                        onChange={e => { setPlaylistIdDraft(e.target.value.trim()); setPlaylistError(''); }}
                        placeholder="ab0b36aa-abe8-45b8-a0ab-97740d06b26a"
                        className="flex-1 bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white/80 placeholder-white/20 focus:outline-none focus:border-purple-500/50 font-mono"
                      />
                      <button
                        onClick={previewWavlakePlaylist}
                        disabled={playlistLoading || !playlistIdDraft.trim()}
                        className="px-3 py-2 rounded-xl text-xs font-semibold bg-white/8 hover:bg-white/12 border border-white/10 text-white/65 hover:text-white disabled:opacity-40 transition-all"
                      >
                        {playlistLoading ? 'Loading…' : 'Preview'}
                      </button>
                    </div>
                    {playlistError && <p className="text-xs text-red-400 px-1">{playlistError}</p>}
                    {playlistPreview && (
                      <div className="flex items-center justify-between gap-3 px-1">
                        <p className="text-xs text-white/45 truncate">
                          {playlistPreview.title} · {playlistPreview.count || 'loaded'} tracks
                        </p>
                        <a
                          href={`https://wavlake.com/playlist/${playlistPreview.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-purple-300/70 hover:text-purple-200 transition-colors"
                        >
                          Open
                        </a>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Liked Songs */}
            <div className="space-y-2">
              <div className="flex items-center justify-between px-1">
                <p className="text-xs text-white/35">Liked Songs</p>
                {visibleLikedTracks.length > 0 && (
                  <span className="text-xs text-pink-400/70">
                    {visibleLikedTracks.length} track{visibleLikedTracks.length !== 1 ? 's' : ''}
                    {engineMode.isRemote ? ' · engine list' : ' · 2× priority'}
                  </span>
                )}
              </div>
              {visibleLikedTracks.length === 0 ? (
                <div className="glass-card rounded-2xl px-5 py-6 text-center">
                  <p className="text-sm text-white/30">No liked tracks yet.</p>
                  <p className="text-xs text-white/20 mt-1">Tap ♥ on any track while listening.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="glass-card rounded-2xl divide-y divide-white/5">
                    {visibleLikedTracks.map(track => {
                      const title = track.name ?? track.title ?? track.id;
                      return (
                        <div key={track.id} className="flex items-center gap-3 px-4 py-3">
                          <div className="w-9 h-9 rounded-lg overflow-hidden flex-shrink-0 bg-white/5">
                            {track.artworkUrl && (
                              <img src={track.artworkUrl} alt={title} className="w-full h-full object-cover" loading="lazy" onError={e => (e.currentTarget.style.display = 'none')} />
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-white/80 truncate">{title}</p>
                            <p className="text-xs text-white/40 truncate">{track.artist}</p>
                          </div>
                          <a
                            href={`https://wavlake.com/track/${track.id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex-shrink-0 text-white/20 hover:text-purple-400 transition-colors p-1"
                            aria-label="Open on Wavlake"
                          >
                            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
                            </svg>
                          </a>
                          {!engineMode.isRemote && (
                            <button
                              onClick={() => unlike(track.id)}
                              aria-label="Unlike track"
                              className="flex-shrink-0 p-1.5 rounded-full text-pink-400 hover:text-red-400 hover:bg-red-900/20 transition-colors"
                            >
                              <svg className="w-4 h-4 fill-pink-400" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                                <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
                              </svg>
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <div className="flex items-center gap-2 flex-wrap px-1">
                    {engineMode.isRemote && (
                      <button
                        onClick={refreshEngineLiked}
                        className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-white/5 border border-white/10 text-white/45 hover:text-white/70 transition-all"
                      >
                        Refresh
                      </button>
                    )}
                    <button
                      onClick={() => exportLikedSongs('txt')}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-pink-500/10 border border-pink-400/20 text-pink-200/80 hover:bg-pink-500/15 transition-all"
                    >
                      Copy export
                    </button>
                    <button
                      onClick={() => exportLikedSongs('csv')}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-white/5 border border-white/10 text-white/45 hover:text-white/70 transition-all"
                    >
                      Download CSV
                    </button>
                    {likedExportCopied && <span className="text-xs text-green-400">Copied</span>}
                  </div>
                  {likedExportText && (
                    <textarea
                      value={likedExportText}
                      readOnly
                      rows={5}
                      className="w-full bg-black/20 border border-white/10 rounded-xl px-3 py-2 text-xs text-white/50 font-mono"
                    />
                  )}
                </div>
              )}
            </div>

            {/* Song Graveyard */}
            <div className="space-y-2">
              <div className="flex items-center justify-between px-1">
                <p className="text-xs text-white/35">Song Graveyard</p>
                {visibleBlockedTracks.length > 0 && (
                  <span className="text-xs text-white/25">{visibleBlockedTracks.length} banished</span>
                )}
              </div>
              {visibleBlockedTracks.length === 0 ? (
                <div className="rounded-2xl px-5 py-6 text-center bg-black/20 border border-white/[0.06]">
                  <p className="text-sm text-white/30">No songs banished yet. 🎵</p>
                </div>
              ) : (
                <div className="rounded-2xl overflow-hidden divide-y divide-white/[0.05] bg-black/20 border border-white/[0.06]">
                  {visibleBlockedTracks.map(track => {
                    const justRestored = restoredId === track.id;
                    return (
                      <div key={track.id} className="flex items-center gap-3 px-4 py-3">
                        <div className="w-9 h-9 rounded-lg bg-white/[0.04] border border-white/[0.07] flex items-center justify-center flex-shrink-0 text-base select-none">
                          🪦
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-white/50 truncate">{track.title || track.value}</p>
                          {track.artist && <p className="text-xs text-white/25 truncate">{track.artist}</p>}
                        </div>
                        {engineMode.isRemote ? (
                          track.url ? (
                            <a
                              href={track.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex-shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold text-white/35 border border-white/10 hover:text-white/60 transition-all"
                            >
                              URL
                            </a>
                          ) : null
                        ) : justRestored ? (
                          <span className="flex-shrink-0 text-xs text-emerald-400 font-semibold flex items-center gap-1">
                            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
                            Restored
                          </span>
                        ) : (
                          <button
                            onClick={() => resurrect(track.id)}
                            className="flex-shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold text-white/40 border border-white/10 hover:border-emerald-500/40 hover:text-emerald-300 hover:bg-emerald-900/20 transition-all"
                          >
                            🧟 Resurrect
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              {engineMode.isRemote && (
                <button
                  onClick={refreshEngineBlocked}
                  className="mx-1 px-3 py-1.5 rounded-lg text-xs font-semibold bg-white/5 border border-white/10 text-white/45 hover:text-white/70 transition-all"
                >
                  Refresh banned list
                </button>
              )}
            </div>
          </div>
        )}

        {/* ── 4. PODCASTS ──────────────────────────────────────────────────── */}
        <div className="mt-2 border-t border-white/[0.06]">
          <SectionHeader title="Podcasts" open={podcastsOpen} onToggle={() => setPodcastsOpen(o => !o)} />
        </div>

        {podcastsOpen && (
          <div className="pb-4 space-y-5">

            {/* Active Feeds */}
            <div className="space-y-2">
              <div className="flex items-center justify-between px-1">
                <p className="text-xs text-white/35">Active Feeds</p>
                {feedSaved && <SavedBadge />}
              </div>
              <div className="glass-card rounded-2xl overflow-hidden divide-y divide-white/5">
                {feeds.length === 0 ? (
                  <div className="px-5 py-8 text-center">
                    <p className="text-white/35 text-sm">No feeds yet. Search below.</p>
                  </div>
                ) : feeds.map((feed, i) => (
                  <div
                    key={feed.url}
                    draggable
                    onDragStart={() => handleDragStart(i)}
                    onDragOver={handleDragOver}
                    onDrop={() => handleDrop(i)}
                    className="flex items-center gap-3 px-4 py-3.5 group cursor-grab active:cursor-grabbing"
                  >
                    {/* Drag handle */}
                    <svg className="w-3.5 h-3.5 text-white/15 group-hover:text-white/35 flex-shrink-0 transition-colors" viewBox="0 0 24 24" fill="currentColor">
                      <circle cx="9" cy="5" r="1.2"/><circle cx="15" cy="5" r="1.2"/>
                      <circle cx="9" cy="12" r="1.2"/><circle cx="15" cy="12" r="1.2"/>
                      <circle cx="9" cy="19" r="1.2"/><circle cx="15" cy="19" r="1.2"/>
                    </svg>
                    <div className="w-8 h-8 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center flex-shrink-0">
                      <svg className="w-4 h-4 text-amber-400" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M6.18 15.64a2.18 2.18 0 0 1 2.18 2.18C8.36 19.01 7.38 20 6.18 20C4.98 20 4 19.01 4 17.82a2.18 2.18 0 0 1 2.18-2.18M4 4.44A15.56 15.56 0 0 1 19.56 20h-2.83A12.73 12.73 0 0 0 4 7.27V4.44m0 5.66a9.9 9.9 0 0 1 9.9 9.9h-2.83A7.07 7.07 0 0 0 4 12.93V10.1z"/>
                      </svg>
                    </div>
                    <p className="text-sm font-semibold text-white flex-1 truncate">{feed.title}</p>
                    <button
                      onClick={() => removeFeed(feed.url)}
                      className="w-7 h-7 rounded-lg flex items-center justify-center text-white/20 hover:text-red-400 hover:bg-red-400/10 transition-all opacity-0 group-hover:opacity-100 flex-shrink-0"
                      aria-label={`Remove ${feed.title}`}
                    >
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {engineMode.isRemote && (
              <div className="space-y-2">
                <div className="flex items-center justify-between px-1">
                  <p className="text-xs text-white/35">Podcast Engine</p>
                  <button
                    type="button"
                    onClick={refreshPodcastQueue}
                    disabled={podcastRefreshing}
                    className="text-xs font-semibold text-amber-300 hover:text-amber-200 disabled:opacity-40 disabled:cursor-wait transition-colors"
                  >
                    {podcastRefreshing ? 'Refreshing…' : 'Refresh'}
                  </button>
                </div>
                <div className="glass-card rounded-2xl p-4 space-y-3">
                  <div className="flex items-center justify-between text-xs text-white/35">
                    <span>{engineMode.podcastQueue.length} queued episode{engineMode.podcastQueue.length === 1 ? '' : 's'}</span>
                    {engineMode.settings?.podcastQueueRefreshedAt && (
                      <span>{new Date(engineMode.settings.podcastQueueRefreshedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    )}
                  </div>
                  {podcastRefreshError && (
                    <p className="text-xs text-red-400">{podcastRefreshError}</p>
                  )}
                  <label className="flex items-center justify-between gap-4">
                    <span className="text-sm text-white/60">Podcasts enabled</span>
                    <input
                      type="checkbox"
                      checked={engineMode.settings?.podcastsEnabled ?? true}
                      onChange={e => engineMode.saveSettings({ podcastsEnabled: e.target.checked })}
                      className="accent-amber-400"
                    />
                  </label>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-white/60">Songs before podcast</span>
                    <span className="text-sm font-bold text-amber-300">{engineMode.settings?.podcastAfterSongs ?? 6}</span>
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={12}
                    value={engineMode.settings?.podcastAfterSongs ?? 6}
                    onChange={e => engineMode.saveSettings({ podcastAfterSongs: Number(e.target.value) })}
                    className="w-full accent-amber-400"
                  />
                  <div className="grid grid-cols-2 gap-3">
                    <label className="space-y-1">
                      <span className="text-xs text-white/40">Min segment minutes</span>
                      <input
                        type="number"
                        min={8}
                        max={60}
                        step={1}
                        value={engineMode.settings?.podcastSegmentMinMinutes ?? 8}
                        onChange={e => engineMode.saveSettings({ podcastSegmentMinMinutes: Number(e.target.value) })}
                        className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white outline-none focus:border-amber-400/60"
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="text-xs text-white/40">Max segment minutes</span>
                      <input
                        type="number"
                        min={8}
                        max={60}
                        step={1}
                        value={engineMode.settings?.podcastSegmentMaxMinutes ?? 15}
                        onChange={e => engineMode.saveSettings({ podcastSegmentMaxMinutes: Number(e.target.value) })}
                        className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white outline-none focus:border-amber-400/60"
                      />
                    </label>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="space-y-1">
                      <span className="text-xs text-white/40">Music break tracks</span>
                      <input
                        type="number"
                        min={0}
                        max={6}
                        step={1}
                        value={engineMode.settings?.musicBreakTracksAfterPodcast ?? 0}
                        onChange={e => engineMode.saveSettings({ musicBreakTracksAfterPodcast: Number(e.target.value) })}
                        className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white outline-none focus:border-amber-400/60"
                      />
                    </label>
                    <div className="space-y-2 pt-5">
                      <label className="flex items-center justify-between gap-3 text-sm text-white/60">
                        <span>Transcript/chapters</span>
                        <input
                          type="checkbox"
                          checked={engineMode.settings?.podcastPreferTranscriptChapters ?? true}
                          onChange={e => engineMode.saveSettings({ podcastPreferTranscriptChapters: e.target.checked })}
                          className="accent-amber-400"
                        />
                      </label>
                      <label className="flex items-center justify-between gap-3 text-sm text-white/60">
                        <span>STT fallback</span>
                        <input
                          type="checkbox"
                          checked={engineMode.settings?.podcastSttFallbackEnabled ?? true}
                          onChange={e => engineMode.saveSettings({ podcastSttFallbackEnabled: e.target.checked })}
                          className="accent-amber-400"
                        />
                      </label>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Search New Podcasts */}
            <div className="space-y-2">
              <p className="text-xs text-white/35 px-1">Search New Podcasts</p>
              <div className="glass-card rounded-2xl p-4 space-y-3">
                <div className="relative">
                  <svg className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
                  </svg>
                  <input
                    type="search"
                    value={query}
                    onChange={e => { setQuery(e.target.value); setError(''); }}
                    placeholder="Search podcasts…"
                    className="w-full pl-10 pr-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-sm text-white placeholder-white/25 outline-none focus:border-purple-500 transition-colors"
                  />
                </div>

                <p className="text-xs font-semibold text-white/40 uppercase tracking-widest flex items-center gap-1.5">
                  {query.trim()
                    ? searchLoading ? 'Searching…' : `${results.length} result${results.length !== 1 ? 's' : ''}`
                    : <><span className="text-emerald-400">✓</span> Transcript-ready shows</>}
                </p>

                {searchError && <p className="text-xs text-red-400">{searchError}</p>}

                {searchLoading ? (
                  <div className="space-y-3">
                    {Array.from({ length: PODCAST_SEARCH_VISIBLE_LIMIT }).map((_, i) => (
                      <div key={i} className="flex items-center gap-3 animate-pulse">
                        <div className="w-10 h-10 rounded-xl bg-white/10 flex-shrink-0" />
                        <div className="flex-1 space-y-2">
                          <div className="h-3 bg-white/10 rounded w-3/5" />
                          <div className="h-2.5 bg-white/10 rounded w-2/5" />
                        </div>
                        <div className="w-12 h-7 bg-white/10 rounded-lg" />
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="space-y-1">
                    {(query.trim() ? results : trending).slice(0, PODCAST_SEARCH_VISIBLE_LIMIT).map(feed => {
                      const alreadyAdded = addedIds.has(feed.id) || !!feeds.find(f => f.url === feed.url);
                      return (
                        <div key={feed.id} className="flex items-center gap-3 p-2 rounded-xl hover:bg-white/5 transition-colors">
                          {feed.artwork ? (
                            <img src={feed.artwork} alt={feed.title} className="w-10 h-10 rounded-xl object-cover flex-shrink-0 bg-white/10" onError={e => (e.currentTarget.style.display = 'none')} />
                          ) : (
                            <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center flex-shrink-0">🎙️</div>
                          )}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <p className="text-sm font-semibold text-white truncate">{feed.title}</p>
                              {!!feed.hasTranscripts && (
                                <span title="Transcript-ready" className="flex-shrink-0 text-emerald-400/90 text-xs leading-none">✓</span>
                              )}
                            </div>
                            {feed.author && <p className="text-xs text-white/40 truncate">{feed.author}</p>}
                          </div>
                          <button
                            onClick={() => addFromIndex(feed)}
                            disabled={alreadyAdded}
                            className={`flex-shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                              alreadyAdded
                                ? 'bg-green-500/15 text-green-400 border border-green-500/30 cursor-default'
                                : 'bg-purple-600/20 text-purple-300 border border-purple-500/30 hover:bg-purple-600/40 hover:text-white'
                            }`}
                          >
                            {alreadyAdded ? '✓ Added' : 'Add'}
                          </button>
                        </div>
                      );
                    })}
                    {query.trim() && results.length === 0 && !searchLoading && !searchError && (
                      <p className="text-sm text-white/30 text-center py-3">No results found.</p>
                    )}
                  </div>
                )}

                <div className="pt-2 border-t border-white/5">
                  <PasteUrlForm feeds={feeds} onAdd={addFeedByUrl} error={error} setError={setError} />
                </div>
              </div>
            </div>

            {/* Podcast History */}
            <div className="space-y-2">
              <p className="text-xs text-white/35 px-1">Podcast History</p>
              <div className="glass-card rounded-2xl p-4">
                {graveyardMemory.episodeHistory.length === 0 ? (
                  <p className="text-sm text-white/30 text-center py-3">No episodes played yet.</p>
                ) : (
                  <div className="divide-y divide-white/5">
                    {[...graveyardMemory.episodeHistory].reverse().slice(0, 10).map(ep => (
                      <div key={ep.episodeId} className="py-3 flex items-start gap-3">
                        <div className="w-8 h-8 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                          <svg className="w-3.5 h-3.5 text-amber-400" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M6.18 15.64a2.18 2.18 0 0 1 2.18 2.18C8.36 19.01 7.38 20 6.18 20C4.98 20 4 19.01 4 17.82a2.18 2.18 0 0 1 2.18-2.18M4 4.44A15.56 15.56 0 0 1 19.56 20h-2.83A12.73 12.73 0 0 0 4 7.27V4.44m0 5.66a9.9 9.9 0 0 1 9.9 9.9h-2.83A7.07 7.07 0 0 0 4 12.93V10.1z"/>
                          </svg>
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-white/70 truncate">{ep.title}</p>
                          <p className="text-xs text-white/35 truncate">{ep.showName}</p>
                        </div>
                        {ep.completedAt && (
                          <span className="flex-shrink-0 text-xs text-emerald-400/60 mt-0.5">✓</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                <div className="pt-3 border-t border-white/5 flex items-center justify-between">
                  <p className="text-xs text-white/30">
                    {playedEpisodes.size === 0
                      ? 'No episodes in skip list'
                      : `${playedEpisodes.size} episode${playedEpisodes.size !== 1 ? 's' : ''} in skip list`}
                  </p>
                  <button
                    onClick={handleClearHistory}
                    disabled={playedEpisodes.size === 0}
                    className="text-xs text-white/40 hover:text-amber-300 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    {historyClearedMsg ? '✓ Cleared' : 'Clear history'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── 5. VALUE4VALUE ───────────────────────────────────────────────── */}
        <div className="mt-2 border-t border-white/[0.06]">
          <SectionHeader title="Value4Value ⚡" open={v4vOpen} onToggle={() => setV4vOpen(o => !o)} />
        </div>

        {v4vOpen && (
          <div className="pb-4 space-y-6">

            {/* NWC Connection */}
            <div className="rounded-2xl bg-white/[0.03] border border-white/[0.06] p-4 space-y-3">
              <div>
                <p className="text-xs font-semibold text-white/50 uppercase tracking-widest mb-1">NWC Connection</p>
                <p className="text-xs text-white/30">Connect your Bitcoin Lightning wallet to stream sats to artists</p>
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={nwcInput}
                  onChange={e => setNwcInput(e.target.value)}
                  placeholder="nostr+walletconnect://..."
                  className="flex-1 bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white/80 placeholder-white/20 focus:outline-none focus:border-purple-500/50 font-mono"
                />
                <button
                  onClick={handleConnectNWC}
                  disabled={v4v.isConnecting || !nwcInput.trim()}
                  className="px-4 py-2 rounded-xl text-sm font-semibold bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed transition-all text-white"
                >
                  {v4v.isConnecting ? 'Connecting…' : 'Connect'}
                </button>
              </div>
              {v4v.isConnected && (
                <div className="flex items-center justify-between">
                  <p className="text-xs text-green-400 flex items-center gap-1">
                    <span>✅</span>
                    Connected{v4v.walletAlias ? ` — ${v4v.walletAlias}` : ''}
                  </p>
                  <button
                    onClick={v4v.disconnect}
                    className="text-xs text-white/30 hover:text-red-400 transition-colors"
                  >
                    Disconnect
                  </button>
                </div>
              )}
              {v4v.connectError && (
                <p className="text-xs text-red-400 break-words">⚠ {v4v.connectError}</p>
              )}
            </div>

            {/* Sats per Minute */}
            <div className="rounded-2xl bg-white/[0.03] border border-white/[0.06] p-4 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-white/50 uppercase tracking-widest">Sats per Minute</p>
                <span className="text-sm font-bold text-yellow-400">{v4v.satRatePerMinute} sats/min</span>
              </div>
              <input
                type="range"
                min={1} max={100}
                value={v4v.satRatePerMinute}
                onChange={e => {
                  const next = parseInt(e.target.value, 10);
                  v4v.setSatRatePerMinute(next);
                  if (engineMode.isRemote) engineMode.saveSettings({ satRatePerMinute: next });
                }}
                className="w-full accent-yellow-400"
              />
              <div className="flex justify-between text-xs text-white/25">
                <span>1</span>
                <span>100</span>
              </div>
            </div>

            {/* Support Personal Radio toggle + split */}
            <div className="rounded-2xl bg-white/[0.03] border border-white/[0.06] p-4 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold text-white/50 uppercase tracking-widest mb-0.5">Support Personal Radio</p>
                  <p className="text-xs text-white/30">Split a portion of your sats with PR</p>
                </div>
                <button
                  onClick={() => {
                    const next = !v4v.supportPREnabled;
                    v4v.setSupportPREnabled(next);
                    if (engineMode.isRemote) engineMode.saveSettings({ supportPREnabled: next });
                  }}
                  className={`relative w-10 h-5 rounded-full transition-colors ${v4v.supportPREnabled ? 'bg-yellow-500' : 'bg-white/15'}`}
                >
                  <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${v4v.supportPREnabled ? 'translate-x-5' : ''}`} />
                </button>
              </div>

              {v4v.supportPREnabled && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs text-white/40">
                    <span>Artists {100 - v4v.prSplitPercent}%</span>
                    <span>Personal Radio {v4v.prSplitPercent}%</span>
                  </div>
                  <input
                    type="range"
                    min={1} max={50}
                    value={v4v.prSplitPercent}
                    onChange={e => {
                      const next = parseInt(e.target.value, 10);
                      v4v.setPRSplitPercent(next);
                      if (engineMode.isRemote) engineMode.saveSettings({ prSplitPercent: next });
                    }}
                    className="w-full accent-yellow-400"
                  />
                </div>
              )}
            </div>

            {engineMode.isRemote && (
              <div className="rounded-2xl bg-white/[0.03] border border-white/[0.06] p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-white/50 uppercase tracking-widest">Boost Amount</p>
                  <span className="text-sm font-bold text-yellow-400">{boostAmountSats} sats</span>
                </div>
                <input
                  type="range"
                  min={10}
                  max={1000}
                  step={10}
                  value={boostAmountSats}
                  onChange={e => {
                    const next = Number(e.target.value);
                    setBoostAmountSats(next);
                    engineMode.saveSettings({ boostAmountSats: next });
                  }}
                  className="w-full accent-yellow-400"
                />
              </div>
            )}

            {/* Save button */}
            <div className="flex items-center gap-3">
              <button
                onClick={saveV4VSettings}
                className="px-5 py-2 rounded-xl text-sm font-semibold bg-white/8 hover:bg-white/12 border border-white/10 text-white/70 hover:text-white transition-all"
              >
                Save
              </button>
              {v4vSaved && <SavedBadge />}
            </div>

            {/* Status */}
            {v4v.isConnected && (
              <div className="text-xs text-white/25 space-y-0.5">
                <p>⚡ {v4v.pendingTotal} sats pending in buffer</p>
                <p>✓ {v4v.totalSentThisSession} sats sent this session</p>
                {v4v.lastFlushResult && (
                  <p>Last flush: {v4v.lastFlushResult.payments} payment(s), {v4v.lastFlushResult.sent} sats</p>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── 6. START OVER ────────────────────────────────────────────────── */}
        <div className="mt-2 border-t border-white/[0.06] pt-6 pb-4">
          <p className="text-xs font-bold tracking-[0.2em] uppercase text-white/40 mb-3 px-1">Start Over</p>
          <div className="rounded-2xl p-4 bg-red-950/20 border border-red-900/30">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div>
                <p className="text-sm font-semibold text-white/70">Reset everything</p>
                <p className="text-xs text-white/35 mt-0.5">Clears all settings and returns to setup</p>
              </div>
              {!confirmStartOver ? (
                <button
                  onClick={() => setConfirmStartOver(true)}
                  className="flex-shrink-0 px-4 py-2 rounded-xl text-sm font-semibold text-red-400 border border-red-700/40 hover:bg-red-900/30 hover:border-red-600/50 transition-all"
                >
                  Start Over
                </button>
              ) : (
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span className="text-xs text-white/45">Are you sure?</span>
                  <button
                    onClick={handleStartOver}
                    className="px-3 py-1.5 rounded-lg text-xs font-bold text-white bg-red-600 hover:bg-red-500 transition-all"
                  >
                    Yes, reset
                  </button>
                  <button
                    onClick={() => setConfirmStartOver(false)}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white/50 border border-white/15 hover:text-white/70 transition-all"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="text-center pt-4 pb-10">
          <p className="text-white/15 text-xs">
            <a href="https://shakespeare.diy" target="_blank" rel="noopener noreferrer" className="hover:text-purple-400 transition-colors">
              Vibed with Shakespeare
            </a>
          </p>
        </div>

      </div>
    </div>
  );
}

// ── Paste URL directly ─────────────────────────────────────────────────────────

function PasteUrlForm({
  feeds,
  onAdd,
  error,
  setError,
}: {
  feeds: PodcastFeed[];
  onAdd: (url: string, title: string) => void;
  error: string;
  setError: (e: string) => void;
}) {
  const [open, setOpen]   = useState(false);
  const [url, setUrl]     = useState('');
  const [title, setTitle] = useState('');

  const submit = () => {
    const trimmed = url.trim();
    if (!trimmed) { setError('Paste a feed URL first.'); return; }
    onAdd(trimmed, title.trim());
    setUrl('');
    setTitle('');
    setOpen(false);
  };

  void feeds;

  return (
    <div className="space-y-2">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 text-xs text-white/30 hover:text-white/50 transition-colors"
      >
        <svg className={`w-3 h-3 transition-transform ${open ? 'rotate-90' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d="M9 18l6-6-6-6"/>
        </svg>
        Paste RSS URL directly
      </button>
      {open && (
        <div className="space-y-2 pt-1">
          <input
            type="url"
            value={url}
            onChange={e => { setUrl(e.target.value); setError(''); }}
            onKeyDown={e => e.key === 'Enter' && submit()}
            placeholder="https://example.com/feed.rss"
            className="w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-sm text-white placeholder-white/25 outline-none focus:border-purple-500 transition-colors"
          />
          <input
            type="text"
            value={title}
            onChange={e => setTitle(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && submit()}
            placeholder="Show name (optional)"
            className="w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-sm text-white placeholder-white/25 outline-none focus:border-purple-500 transition-colors"
          />
          {error && <p className="text-xs text-red-400">{error}</p>}
          <button
            onClick={submit}
            className="w-full py-2.5 bg-gradient-to-r from-violet-600 to-purple-600 text-white text-sm font-semibold rounded-xl hover:from-violet-500 hover:to-purple-500 transition-all"
          >
            Add Feed
          </button>
        </div>
      )}
    </div>
  );
}
