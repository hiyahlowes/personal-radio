import { useCallback, useRef } from 'react';
import { useElevenLabs } from './useElevenLabs';
import type { WavlakeTrack } from './useWavlakeTracks';
import type { PodcastEpisode } from './usePodcastFeeds';

// ─── Time-of-day helpers ──────────────────────────────────────────────────────
type TimeOfDay = 'morning' | 'afternoon' | 'evening' | 'night';

function getTimeOfDay(): TimeOfDay {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return 'morning';
  if (h >= 12 && h < 17) return 'afternoon';
  if (h >= 17 && h < 21) return 'evening';
  return 'night';
}

function getDateString(): string {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

// ─── Title cleaning ───────────────────────────────────────────────────────────
/**
 * Strip parenthetical and bracketed suffixes from track titles that add no
 * value when spoken aloud — e.g. "(Acoustic Version)", "[Remaster]",
 * "(feat. Someone)", "(Live at Madison Square Garden)", etc.
 *
 * We do this client-side so the AI receives already-clean data and doesn't
 * need to be instructed to ignore it on every call.
 */
function cleanTrackTitle(title: string): string {
  return title
    // Remove anything in () or [] that matches common meta patterns
    .replace(/\s*[\(\[](feat\.?|ft\.?|featuring|acoustic|acústico|live|live at .+?|remaster(ed)?|remix(ed)?|radio edit|single (version|edit)|album version|extended|instrumental|demo|cover|original|bonus|deluxe|explicit|clean|radio version|unplugged|version|edit|mix)[^\)\]]*[\)\]]/gi, '')
    // Remove any remaining empty parens/brackets
    .replace(/\s*[\(\[\{][^\)\]\}]*[\)\]\}]\s*$/, '')
    .trim();
}

/**
 * Detect whether a podcast show title/episode title looks like a news bulletin.
 * Used to choose a smarter spoken intro.
 */
function isNewsShow(showName: string, episodeTitle: string): boolean {
  const combined = `${showName} ${episodeTitle}`.toLowerCase();
  return (
    /\b(news|nachrichten|noticias|nouvelles|headlines|bulletin|briefing|update|journal|bbc news|npr news|daily|morning edition|evening edition)\b/.test(combined)
  );
}

/**
 * Detect if an episode title looks like a raw timestamp/date dump
 * (e.g. "Die Nachrichten vom 13.03.2026, 09:00 Uhr").
 * When true, the moderator should use the show name instead of the episode title.
 */
function episodeTitleIsDateDump(episodeTitle: string): boolean {
  // Matches titles that are predominantly a date/time expression
  return (
    /\b\d{1,2}[\.\/]\d{1,2}[\.\/]\d{2,4}\b/.test(episodeTitle) || // DD.MM.YYYY or DD/MM/YYYY
    /\b\d{4}-\d{2}-\d{2}\b/.test(episodeTitle) ||                   // YYYY-MM-DD
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s+\d{4}/i.test(episodeTitle) ||
    /episode\s*#?\d+/i.test(episodeTitle) ||                         // "Episode 42"
    /^ep\.?\s*\d+/i.test(episodeTitle) ||                            // "Ep. 42"
    /\b\d{1,2}:\d{2}\s*(uhr|am|pm|h)\b/i.test(episodeTitle)         // time stamps like "09:00 Uhr"
  );
}

// ─── Fallback script generators (no AI required) ──────────────────────────────
function fallbackGreeting(name: string): string {
  const tod = getTimeOfDay();
  const firstName = name.split(' ')[0];
  const scripts: Record<TimeOfDay, string> = {
    morning: `Good morning, ${firstName}. You're tuned in to PR — your personal radio station. It's a great morning for music, so let's kick things off right. Sit back, relax, and enjoy the show.`,
    afternoon: `Good afternoon, ${firstName}. Welcome back to PR — your personal station. The afternoon playlist is ready and it's a good one. Let's get into it.`,
    evening: `Good evening, ${firstName}. You're listening to PR. The day is winding down and the evening set is ready to go. This one's for you — enjoy.`,
    night: `Hey, ${firstName}. Late night, good music. You're tuned in to PR and we've got the perfect soundtrack for the quiet hours. Let's go.`,
  };
  return scripts[tod];
}

function fallbackTrackIntro(track: WavlakeTrack): string {
  const title = cleanTrackTitle(track.name);
  const templates = [
    `Up next — ${track.artist} with "${title}". This one's a great listen.`,
    `Here's "${title}" from ${track.artist}. Enjoy.`,
    `Coming up — ${track.artist} with "${title}". Let it play.`,
    `Next on the playlist — "${title}" by ${track.artist}.`,
    `And now, from ${track.artist} — "${title}".`,
  ];
  const idx = track.id.charCodeAt(0) % templates.length;
  return templates[idx];
}

function fallbackPodcastTransition(showName: string, episodeTitle: string): string {
  const isNews = isNewsShow(showName, episodeTitle);
  const isDateDump = episodeTitleIsDateDump(episodeTitle);

  if (isNews) {
    const newsTemplates = [
      `Time to check in with the latest. Here's ${showName}.`,
      `Let's see what's happening in the world. ${showName} is up next.`,
      `Time for the news. Here's ${showName} with the latest headlines.`,
    ];
    return newsTemplates[showName.charCodeAt(0) % newsTemplates.length];
  }

  if (isDateDump) {
    // Episode title is useless — use show name only
    const templates = [
      `Coming up — a new segment from ${showName}. Stay with us.`,
      `That's the music for now. Here's the latest from ${showName}.`,
      `And now for something a little different. Here's ${showName}.`,
    ];
    return templates[showName.charCodeAt(0) % templates.length];
  }

  // Normal episode with a meaningful title
  const templates = [
    `Coming up — we're switching gears for a moment. From ${showName}: "${episodeTitle}". Stay with us.`,
    `That's the music for now. Next up — ${showName} with "${episodeTitle}". Don't go anywhere.`,
    `And now for something a little different. ${showName} is here with "${episodeTitle}". Take a listen.`,
  ];
  return templates[showName.charCodeAt(0) % templates.length];
}

// ─── Shakespeare AI script generator ─────────────────────────────────────────
// We call the Shakespeare API directly here (without requiring Nostr login)
// using a simple fetch — greetings are unauthenticated text generation.
async function generateScript(prompt: string): Promise<string | null> {
  try {
    const response = await fetch('https://ai.shakespeare.diy/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'tybalt', // free, no auth required
        messages: [
          {
            role: 'system',
            content:
              'You are a warm, natural-sounding AI radio host for PR – Personal Radio. ' +
              'Speak exactly as you would on air: no stage directions, no quotation marks around titles you speak, no asterisks, ' +
              'no parenthetical notes. Just pure, natural radio speech. ' +
              'Keep it short — 1 to 3 sentences maximum. No emojis. ' +
              'IMPORTANT RULES: ' +
              '(1) Never read out dates, times, episode numbers, or version tags. ' +
              '(2) For podcast episodes where the title is just a date or timestamp, ignore the episode title entirely and refer to the show by name only. ' +
              '(3) For music, drop any parenthetical suffixes like "(Acoustic Version)" or "(feat. X)" — just say the clean title and artist. ' +
              '(4) Sound like a real DJ who knows what is and is not worth saying on air.',
          },
          { role: 'user', content: prompt },
        ],
        max_tokens: 120,
        temperature: 0.85,
      }),
    });

    if (!response.ok) return null;
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    return typeof text === 'string' && text.trim() ? text.trim() : null;
  } catch {
    return null;
  }
}

// ─── Hook ─────────────────────────────────────────────────────────────────────
export interface ModeratorState {
  isSpeaking: boolean;
  isGenerating: boolean;
  currentScript: string;
  error: string | null;
}

export function useRadioModerator() {
  const { speak, stop, isSpeaking, isGenerating, error } = useElevenLabs();
  const currentScriptRef = useRef('');

  // ── Helpers ──────────────────────────────────────────────────────────────
  const sayScript = useCallback(
    async (script: string): Promise<void> => {
      currentScriptRef.current = script;
      await speak(script);
    },
    [speak]
  );

  const buildAndSpeak = useCallback(
    async (prompt: string, fallback: string): Promise<void> => {
      // Try AI first; fall back to pre-written script on any failure
      const aiScript = await generateScript(prompt);
      await sayScript(aiScript ?? fallback);
    },
    [sayScript]
  );

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Play a personalized greeting when the listener tunes in.
   * Called once, on first play.
   */
  const speakGreeting = useCallback(
    async (listenerName: string): Promise<void> => {
      const tod = getTimeOfDay();
      const firstName = listenerName.split(' ')[0];
      const date = getDateString();
      const prompt =
        `Write a ${tod} on-air greeting for a listener named ${firstName}. ` +
        `Today is ${date}. ` +
        `Sound warm, personal and authentic — like a real radio host welcoming them to their favourite station. ` +
        `Reference the time of day naturally. 2–3 sentences.`;

      await buildAndSpeak(prompt, fallbackGreeting(listenerName));
    },
    [buildAndSpeak]
  );

  /**
   * Introduce a track before it plays.
   * Called whenever the current track changes and music is about to start.
   * @param isTopChart  When true, the Claude prompt includes Lightning chart context.
   */
  const speakTrackIntro = useCallback(
    async (track: WavlakeTrack, isTopChart = false): Promise<void> => {
      const cleanTitle = cleanTrackTitle(track.name);
      const chartContext = isTopChart
        ? `This track is one of the top-earning songs on Wavlake, ranked by Bitcoin Lightning tips from listeners. Mention this naturally — something like it's a listener favourite or topping the Lightning charts. `
        : '';

      const prompt =
        `Introduce the next song on air. ` +
        `Artist: ${track.artist}. Song title: ${cleanTitle}. ` +
        `Album: ${track.albumTitle || 'their latest work'}. ` +
        chartContext +
        `Sound like a natural radio DJ handing off to the track. Keep it to 1–2 sentences. ` +
        `Vary your phrasing — don't start with "Here's". Don't put the title in quotes. ` +
        `Don't add any version tags or extra info — just the artist and the clean title.`;

      await buildAndSpeak(prompt, fallbackTrackIntro(track));
    },
    [buildAndSpeak]
  );

  /**
   * Comment on one or two tracks that just played, then introduce the next one.
   * Called after 1–2 silent tracks as a natural mid-set break.
   * @param isNextTopChart  When true, the Claude prompt includes Lightning chart context for the next track.
   */
  const speakReviewAndIntro = useCallback(
    async (played: WavlakeTrack[], next: WavlakeTrack, isNextTopChart = false): Promise<void> => {
      const playedList = played
        .map(t => `${t.artist} — ${cleanTrackTitle(t.name)}`)
        .join(' and then ');

      const cleanNextTitle = cleanTrackTitle(next.name);

      const chartContext = isNextTopChart
        ? `The next track is one of the top-earning songs on Wavlake, ranked by Bitcoin Lightning tips from listeners. Work that in naturally. `
        : '';

      const prompt =
        `You just played ${playedList} on air without commentary. ` +
        `Give a brief, warm reaction to that music — one sentence. ` +
        `Then introduce the next track: ${next.artist} with ${cleanNextTitle}. ` +
        chartContext +
        `Keep the whole thing to 2–3 sentences. Sound like a natural radio DJ, not a robot. ` +
        `Don't put titles in quotes or add version tags.`;

      const fallback = played.length > 1
        ? `Great music from ${played.map(t => t.artist).join(' and ')} — hope you enjoyed that. ` +
          `Coming up next — ${next.artist} with ${cleanNextTitle}.`
        : `That was ${played[0].artist} with ${cleanTrackTitle(played[0].name)}. ` +
          `Now let's keep it going — here's ${next.artist} with ${cleanNextTitle}.`;

      await buildAndSpeak(prompt, fallback);
    },
    [buildAndSpeak]
  );

  /**
   * Short transition bridge between a music segment and a podcast segment.
   * Uses the show name and intelligently handles news shows and date-dump titles.
   */
  const speakPodcastTransition = useCallback(
    async (episodeTitle: string, showName: string): Promise<void> => {
      const isNews    = isNewsShow(showName, episodeTitle);
      const isDateDump = episodeTitleIsDateDump(episodeTitle);

      let prompt: string;

      if (isNews) {
        prompt =
          `You're a radio host transitioning from music to a news segment. ` +
          `The news show is called "${showName}". ` +
          `Say something brief and natural to bridge to the news — like "time to check in with the headlines" or "let's see what's happening in the world". ` +
          `Mention the show name. 1–2 sentences. Never mention dates, times, or episode numbers.`;
      } else if (isDateDump) {
        // Episode title is just a timestamp — use show name only
        prompt =
          `You're a radio host transitioning from music to a podcast segment. ` +
          `The show is called "${showName}". ` +
          `Introduce it naturally using only the show name — do NOT mention the episode title. ` +
          `1–2 sentences. Keep it smooth and conversational.`;
      } else {
        prompt =
          `You're transitioning from a music set to a podcast segment. ` +
          `Show name: "${showName}". Episode: "${episodeTitle}". ` +
          `Give a smooth, natural on-air handoff — 1–2 sentences. ` +
          `Use the show name primarily. Only mention the episode title if it adds real value (not if it's generic). ` +
          `Never mention dates, times, or episode numbers.`;
      }

      await buildAndSpeak(
        prompt,
        fallbackPodcastTransition(showName, episodeTitle)
      );
    },
    [buildAndSpeak]
  );

  /**
   * Transition from music into a podcast episode.
   * Called just before the podcast audio starts playing.
   */
  const speakPodcastIntro = useCallback(
    async (episode: PodcastEpisode): Promise<void> => {
      const isNews     = isNewsShow(episode.feedTitle, episode.title);
      const isDateDump = episodeTitleIsDateDump(episode.title);

      let prompt: string;

      if (isNews) {
        prompt =
          `You're a radio host introducing a news segment. ` +
          `The show is "${episode.feedTitle}". ` +
          `Say something like "time for the news" or "let's check in with the latest headlines". ` +
          `Mention the show name. 1 sentence. Never read out dates, times, or timestamps.`;
      } else if (isDateDump) {
        prompt =
          `You're a radio host introducing a podcast segment. ` +
          `Show: "${episode.feedTitle}". ` +
          `The episode title is just a date/time — ignore it completely. ` +
          `Introduce the show by name only. 1–2 sentences. Sound warm and natural.`;
      } else {
        prompt =
          `You're a radio host transitioning from music to a podcast segment. ` +
          `Show: "${episode.feedTitle}". Episode: "${episode.title}". ` +
          `Sound warm and natural — 1 to 2 sentences. Don't say "here's" at the start. ` +
          `Refer to the show by name. Only use the episode title if it's genuinely descriptive. ` +
          `Never mention dates, times, or episode numbers.`;
      }

      const fallback = isNews || isDateDump
        ? `Up next — ${episode.feedTitle}. Take a listen.`
        : `Coming up — from ${episode.feedTitle}: "${episode.title}". Sit back and enjoy.`;

      await buildAndSpeak(prompt, fallback);
    },
    [buildAndSpeak]
  );

  /**
   * Speak a pre-generated commentary script (from Claude) directly via TTS.
   * Used by the podcast segmenter after a mid-episode break point is detected.
   * The text has already been generated — we just speak it.
   */
  const speakPodcastSegmentCommentary = useCallback(
    async (script: string): Promise<void> => {
      await sayScript(script);
    },
    [sayScript]
  );

  /**
   * Announce the return to a podcast after a music break.
   * e.g. "And we're back — here's part 2 of Huberman Lab"
   */
  const speakPodcastReturn = useCallback(
    async (podcastTitle: string, partNumber: number): Promise<void> => {
      const prompt =
        `You're a radio host returning from a music break back to a podcast. ` +
        `Podcast: "${podcastTitle}". This is part ${partNumber} of the episode. ` +
        `Say something warm and brief — 1 sentence — like "And we're back, here's part ${partNumber} of ${podcastTitle}". ` +
        `Vary the phrasing. Sound natural, not scripted.`;

      const fallback = [
        `And we're back — here's part ${partNumber} of ${podcastTitle}.`,
        `Welcome back. Picking up where we left off — ${podcastTitle}, part ${partNumber}.`,
        `Alright, back to it. Here's the next part of ${podcastTitle}.`,
      ][partNumber % 3];

      await buildAndSpeak(prompt, fallback);
    },
    [buildAndSpeak]
  );

  /**
   * Bridge back from podcast to music.
   */
  const speakPodcastOutro = useCallback(
    async (episode: PodcastEpisode, nextTrack: WavlakeTrack): Promise<void> => {
      const isNews     = isNewsShow(episode.feedTitle, episode.title);
      const isDateDump = episodeTitleIsDateDump(episode.title);
      const cleanNextTitle = cleanTrackTitle(nextTrack.name);

      // Reference the show name for news/date-dump episodes, not the raw title
      const podcastRef = (isNews || isDateDump)
        ? episode.feedTitle
        : `${episode.feedTitle}`;

      const prompt =
        `You're a radio host transitioning back from a podcast segment to music. ` +
        `The podcast was from ${podcastRef}. ` +
        `Now going back to music — next up: ${nextTrack.artist} with ${cleanNextTitle}. ` +
        `Keep it to 1–2 sentences. Sound natural. Don't mention dates or episode titles.`;

      const fallback = (isNews || isDateDump)
        ? `That was ${episode.feedTitle}. Back to music now — here's ${nextTrack.artist} with ${cleanNextTitle}.`
        : `That was ${episode.feedTitle}. Back to music now — here's ${nextTrack.artist} with ${cleanNextTitle}.`;

      await buildAndSpeak(prompt, fallback);
    },
    [buildAndSpeak]
  );

  return {
    speakGreeting,
    speakTrackIntro,
    speakReviewAndIntro,
    speakPodcastIntro,
    speakPodcastOutro,
    speakPodcastTransition,
    speakPodcastSegmentCommentary,
    speakPodcastReturn,
    stop,
    isSpeaking,
    isGenerating,
    currentScript: currentScriptRef.current,
    error,
  };
}
