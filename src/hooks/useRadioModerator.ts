import { useCallback, useRef } from 'react';
import { useElevenLabs } from './useElevenLabs';
import type { WavlakeTrack } from './useWavlakeTracks';
import type { PodcastEpisode } from './usePodcastFeeds';

// Time-of-day helpers
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

// Title cleaning helpers

/**
 * Strip parenthetical/bracketed suffixes from track titles that add no value
 * when spoken aloud: "(Acoustic Version)", "[Remaster]", "(feat. X)", "(Live)", etc.
 */
function cleanTrackTitle(title: string): string {
  return title
    .replace(
      /\s*[\(\[](feat\.?|ft\.?|featuring|acoustic|acustico|live|live at .+?|remaster(ed)?|remix(ed)?|radio edit|single (version|edit)|album version|extended|instrumental|demo|cover|original|bonus|deluxe|explicit|clean|radio version|unplugged|version|edit|mix)[^\)\]]*[\)\]]/gi,
      ''
    )
    .replace(/\s*[\(\[\{][^\)\]\}]*[\)\]\}]\s*$/, '')
    .trim();
}

/**
 * Return true if the podcast show/episode looks like a news bulletin.
 */
function isNewsShow(showName: string, episodeTitle: string): boolean {
  const combined = (showName + ' ' + episodeTitle).toLowerCase();
  return /\b(news|nachrichten|noticias|nouvelles|headlines|bulletin|briefing|update|journal|bbc news|npr news|daily|morning edition|evening edition|tagesschau|top stories)\b/.test(
    combined
  );
}

/**
 * Return true if the episode title is just a timestamp/date dump and not
 * meaningful spoken content, e.g. "Die Nachrichten vom 13.03.2026, 09:00 Uhr".
 */
function episodeTitleIsDateDump(episodeTitle: string): boolean {
  return (
    /\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b/.test(episodeTitle) ||
    /\b\d{4}-\d{2}-\d{2}\b/.test(episodeTitle) ||
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s+\d{4}/i.test(episodeTitle) ||
    /episode\s*#?\d+/i.test(episodeTitle) ||
    /^ep\.?\s*\d+/i.test(episodeTitle) ||
    /\b\d{1,2}:\d{2}\s*(uhr|am|pm|h)\b/i.test(episodeTitle)
  );
}

// Fallback scripts (no AI required)

function fallbackGreeting(name: string): string {
  const tod = getTimeOfDay();
  const firstName = name.split(' ')[0];
  const scripts: Record<TimeOfDay, string> = {
    morning: `Good morning, ${firstName}. You're tuned in to PR, your personal radio station. It's a great morning for music, so let's kick things off right.`,
    afternoon: `Good afternoon, ${firstName}. Welcome back to PR. The afternoon playlist is ready and it's a good one. Let's get into it.`,
    evening: `Good evening, ${firstName}. You're listening to PR. The day is winding down and the evening set is ready. This one's for you.`,
    night: `Hey, ${firstName}. Late night, good music. You're tuned in to PR. Let's go.`,
  };
  return scripts[tod];
}

function fallbackTrackIntro(track: WavlakeTrack): string {
  const title = cleanTrackTitle(track.name);
  const templates = [
    `Up next, ${track.artist} with ${title}.`,
    `Here's ${title} from ${track.artist}.`,
    `Coming up, ${track.artist} with ${title}.`,
    `Next on the playlist, ${title} by ${track.artist}.`,
    `And now from ${track.artist}, ${title}.`,
  ];
  return templates[track.id.charCodeAt(0) % templates.length];
}

function fallbackPodcastTransition(showName: string, episodeTitle: string): string {
  if (isNewsShow(showName, episodeTitle)) {
    const templates = [
      `Time to check in with the latest. Here's ${showName}.`,
      `Let's see what's happening in the world. ${showName} is up next.`,
      `Time for the news. Here's ${showName}.`,
    ];
    return templates[showName.charCodeAt(0) % templates.length];
  }
  if (episodeTitleIsDateDump(episodeTitle)) {
    const templates = [
      `Coming up, the latest from ${showName}. Stay with us.`,
      `That's the music for now. Here's ${showName}.`,
      `And now for something a little different. Here's ${showName}.`,
    ];
    return templates[showName.charCodeAt(0) % templates.length];
  }
  const templates = [
    `Coming up, we're switching gears. ${showName} joins us with ${episodeTitle}. Stay with us.`,
    `That's the music for now. Next up, ${showName}. Don't go anywhere.`,
    `And now for something a little different. Here's ${showName}.`,
  ];
  return templates[showName.charCodeAt(0) % templates.length];
}

// Shakespeare AI script generator

async function generateScript(prompt: string): Promise<string | null> {
  try {
    const response = await fetch('https://ai.shakespeare.diy/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'tybalt',
        messages: [
          {
            role: 'system',
            content:
              'You are a warm, natural-sounding AI radio host for PR, Personal Radio. ' +
              'Speak exactly as you would on air: no stage directions, no quotation marks around spoken titles, no asterisks, ' +
              'no parenthetical notes. Just pure, natural radio speech. ' +
              'Keep it short, 1 to 3 sentences maximum. No emojis. ' +
              'RULES: ' +
              '(1) Never read out dates, times, episode numbers, or version tags. ' +
              '(2) For podcast episodes where the title is just a date or timestamp, ignore it and use the show name only. ' +
              '(3) For music, drop parenthetical suffixes like acoustic version or feat X, just say the clean title and artist. ' +
              '(4) Sound like a real DJ who knows what is worth saying on air.',
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

// Hook

export interface ModeratorState {
  isSpeaking: boolean;
  isGenerating: boolean;
  currentScript: string;
  error: string | null;
}

export function useRadioModerator() {
  const { speak, stop, isSpeaking, isGenerating, error } = useElevenLabs();
  const currentScriptRef = useRef('');

  const sayScript = useCallback(
    async (script: string): Promise<void> => {
      currentScriptRef.current = script;
      await speak(script);
    },
    [speak]
  );

  const buildAndSpeak = useCallback(
    async (prompt: string, fallback: string): Promise<void> => {
      const aiScript = await generateScript(prompt);
      await sayScript(aiScript ?? fallback);
    },
    [sayScript]
  );

  const speakGreeting = useCallback(
    async (listenerName: string): Promise<void> => {
      const tod = getTimeOfDay();
      const firstName = listenerName.split(' ')[0];
      const date = getDateString();
      const prompt =
        `Write a ${tod} on-air greeting for a listener named ${firstName}. ` +
        `Today is ${date}. ` +
        `Sound warm, personal and authentic, like a real radio host welcoming them to their favourite station. ` +
        `Reference the time of day naturally. 2 to 3 sentences.`;
      await buildAndSpeak(prompt, fallbackGreeting(listenerName));
    },
    [buildAndSpeak]
  );

  const speakTrackIntro = useCallback(
    async (track: WavlakeTrack, isTopChart = false): Promise<void> => {
      const cleanTitle = cleanTrackTitle(track.name);
      const chartContext = isTopChart
        ? `This track is one of the top-earning songs on Wavlake, ranked by Bitcoin Lightning tips from listeners. Mention this naturally. `
        : '';
      const prompt =
        `Introduce the next song on air. ` +
        `Artist: ${track.artist}. Song title: ${cleanTitle}. ` +
        `Album: ${track.albumTitle || 'their latest work'}. ` +
        chartContext +
        `Sound like a natural radio DJ handing off to the track. Keep it to 1 to 2 sentences. ` +
        `Vary your phrasing, do not start with Here's. Do not put the title in quotes. ` +
        `Do not add version tags or extra info, just the artist and clean title.`;
      await buildAndSpeak(prompt, fallbackTrackIntro(track));
    },
    [buildAndSpeak]
  );

  const speakReviewAndIntro = useCallback(
    async (played: WavlakeTrack[], next: WavlakeTrack, isNextTopChart = false): Promise<void> => {
      const playedList = played
        .map(t => `${t.artist} with ${cleanTrackTitle(t.name)}`)
        .join(' and then ');
      const cleanNextTitle = cleanTrackTitle(next.name);
      const chartContext = isNextTopChart
        ? `The next track is one of the top-earning songs on Wavlake, ranked by Bitcoin Lightning tips. Work that in naturally. `
        : '';
      const prompt =
        `You just played ${playedList} on air without commentary. ` +
        `Give a brief warm reaction to that music, one sentence. ` +
        `Then introduce the next track: ${next.artist} with ${cleanNextTitle}. ` +
        chartContext +
        `Keep the whole thing to 2 to 3 sentences. Sound like a natural radio DJ, not a robot. ` +
        `Do not put titles in quotes or add version tags.`;
      const fallback =
        played.length > 1
          ? `Great music from ${played.map(t => t.artist).join(' and ')}, hope you enjoyed that. Coming up next, ${next.artist} with ${cleanNextTitle}.`
          : `That was ${played[0].artist} with ${cleanTrackTitle(played[0].name)}. Now let's keep it going, here's ${next.artist} with ${cleanNextTitle}.`;
      await buildAndSpeak(prompt, fallback);
    },
    [buildAndSpeak]
  );

  const speakPodcastTransition = useCallback(
    async (episodeTitle: string, showName: string): Promise<void> => {
      const isNews = isNewsShow(showName, episodeTitle);
      const isDateDump = episodeTitleIsDateDump(episodeTitle);

      let prompt: string;
      if (isNews) {
        prompt =
          `You're a radio host transitioning from music to a news segment. ` +
          `The news show is called ${showName}. ` +
          `Say something brief and natural to bridge to the news, like time to check in with the headlines or let's see what's happening in the world. ` +
          `Mention the show name. 1 to 2 sentences. Never mention dates, times, or episode numbers.`;
      } else if (isDateDump) {
        prompt =
          `You're a radio host transitioning from music to a podcast segment. ` +
          `The show is called ${showName}. ` +
          `Introduce it naturally using only the show name, do not mention the episode title at all. ` +
          `1 to 2 sentences. Keep it smooth and conversational.`;
      } else {
        prompt =
          `You're transitioning from a music set to a podcast segment. ` +
          `Show name: ${showName}. Episode: ${episodeTitle}. ` +
          `Give a smooth natural on-air handoff, 1 to 2 sentences. ` +
          `Use the show name primarily. Only mention the episode title if it adds real value. ` +
          `Never mention dates, times, or episode numbers.`;
      }
      await buildAndSpeak(prompt, fallbackPodcastTransition(showName, episodeTitle));
    },
    [buildAndSpeak]
  );

  const speakPodcastIntro = useCallback(
    async (episode: PodcastEpisode): Promise<void> => {
      const isNews = isNewsShow(episode.feedTitle, episode.title);
      const isDateDump = episodeTitleIsDateDump(episode.title);

      let prompt: string;
      if (isNews) {
        prompt =
          `You're a radio host introducing a news segment. ` +
          `The show is ${episode.feedTitle}. ` +
          `Say something like time for the news or let's check in with the latest headlines. ` +
          `Mention the show name. 1 sentence. Never read out dates, times, or timestamps.`;
      } else if (isDateDump) {
        prompt =
          `You're a radio host introducing a podcast segment. ` +
          `Show: ${episode.feedTitle}. ` +
          `The episode title is just a date or time, ignore it completely. ` +
          `Introduce the show by name only. 1 to 2 sentences. Sound warm and natural.`;
      } else {
        prompt =
          `You're a radio host transitioning from music to a podcast segment. ` +
          `Show: ${episode.feedTitle}. Episode: ${episode.title}. ` +
          `Sound warm and natural, 1 to 2 sentences. Do not say here's at the start. ` +
          `Refer to the show by name. Only use the episode title if it is genuinely descriptive. ` +
          `Never mention dates, times, or episode numbers.`;
      }

      const fallback =
        isNews || isDateDump
          ? `Up next, ${episode.feedTitle}. Take a listen.`
          : `Coming up, from ${episode.feedTitle}: ${episode.title}. Sit back and enjoy.`;

      await buildAndSpeak(prompt, fallback);
    },
    [buildAndSpeak]
  );

  const speakPodcastSegmentCommentary = useCallback(
    async (script: string): Promise<void> => {
      await sayScript(script);
    },
    [sayScript]
  );

  const speakPodcastReturn = useCallback(
    async (podcastTitle: string, partNumber: number): Promise<void> => {
      const prompt =
        `You're a radio host returning from a music break back to a podcast. ` +
        `Podcast: ${podcastTitle}. This is part ${partNumber} of the episode. ` +
        `Say something warm and brief, 1 sentence, like And we're back, here's part ${partNumber} of ${podcastTitle}. ` +
        `Vary the phrasing. Sound natural, not scripted.`;
      const fallback = [
        `And we're back, here's part ${partNumber} of ${podcastTitle}.`,
        `Welcome back. Picking up where we left off, ${podcastTitle}, part ${partNumber}.`,
        `Alright, back to it. Here's the next part of ${podcastTitle}.`,
      ][partNumber % 3];
      await buildAndSpeak(prompt, fallback);
    },
    [buildAndSpeak]
  );

  const speakPodcastOutro = useCallback(
    async (episode: PodcastEpisode, nextTrack: WavlakeTrack): Promise<void> => {
      const isNews = isNewsShow(episode.feedTitle, episode.title);
      const isDateDump = episodeTitleIsDateDump(episode.title);
      const cleanNextTitle = cleanTrackTitle(nextTrack.name);
      const podcastRef = isNews || isDateDump ? episode.feedTitle : episode.feedTitle;

      const prompt =
        `You're a radio host transitioning back from a podcast segment to music. ` +
        `The podcast was from ${podcastRef}. ` +
        `Now going back to music, next up: ${nextTrack.artist} with ${cleanNextTitle}. ` +
        `Keep it to 1 to 2 sentences. Sound natural. Do not mention dates or episode titles.`;

      const fallback = `That was ${episode.feedTitle}. Back to music now, here's ${nextTrack.artist} with ${cleanNextTitle}.`;

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
