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

// Language helper

function getStoredLanguage(): string {
  try { return localStorage.getItem('pr:language') || 'English'; } catch { return 'English'; }
}

// Shakespeare AI script generator

async function generateScript(prompt: string, longForm = false): Promise<string | null> {
  const language = getStoredLanguage();
  console.log(`[Moderator] language="${language}" | longForm=${longForm} | prompt: ${prompt.slice(0, 80)}…`);
  const lengthInstruction = longForm
    ? 'Be a bit more elaborate this time: use 3 to 4 sentences.'
    : 'Keep it to 1 to 2 sentences.';
  try {
    const response = await fetch('/.netlify/functions/claude-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        system:
          `You are a warm, natural-sounding AI radio host for PR, Personal Radio. ` +
          `You MUST respond exclusively in ${language}. Never use any other language. ` +
          'Speak exactly as you would on air: no stage directions, no quotation marks around spoken titles, no asterisks, ' +
          'no parenthetical notes. Just pure, natural radio speech. No emojis. ' +
          'RULES: ' +
          '(1) Never read out dates, times, episode numbers, or version tags. ' +
          '(2) For podcast episodes where the title is just a date or timestamp, ignore it and use the show name only. ' +
          '(3) For music, drop parenthetical suffixes like acoustic version or feat X, just say the clean title and artist. ' +
          '(4) Sound like a real DJ who knows what is worth saying on air.',
        messages: [
          { role: 'user', content: `${prompt}\n${lengthInstruction}` },
        ],
        max_tokens: longForm ? 200 : 120,
      }),
    });
    if (!response.ok) { console.warn('[Moderator] claude-proxy error:', response.status); return null; }
    const data = await response.json();
    const text = data?.content?.[0]?.text;
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
      // 20% of calls: ask the AI to be more elaborate (3-4 sentences)
      const longForm = Math.random() < 0.2;
      const aiScript = await generateScript(prompt, longForm);
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

  /**
   * Brief hardcoded reaction spoken when the listener manually skips or
   * jumps directly to a podcast episode. No AI call — instant playback.
   */
  const speakUserControlReaction = useCallback(async (): Promise<void> => {
    const lines = [
      'Your radio, your rules.',
      'Bold choice — I like it.',
      'Great idea, I was just thinking the same.',
      'Alright, we do it your way.',
      'Taking matters into your own hands — respect.',
    ];
    const line = lines[Math.floor(Math.random() * lines.length)];
    await sayScript(line);
  }, [sayScript]);

  const speakPodcastTransition = useCallback(
    async (episodeTitle: string, showName: string, description?: string, author?: string): Promise<void> => {
      const isNews = isNewsShow(showName, episodeTitle);
      const isDateDump = episodeTitleIsDateDump(episodeTitle);

      // Optional context from the RSS feed to enrich the AI prompt
      const rssContext = [
        author ? `Host/author: ${author}.` : '',
        description ? `Episode description: "${description}"` : '',
      ].filter(Boolean).join(' ');

      let prompt: string;
      if (isNews) {
        prompt =
          `You're a radio host transitioning from music to a news segment. ` +
          `The news show is called ${showName}. ` +
          (rssContext ? `${rssContext} ` : '') +
          `Say something brief and natural to bridge to the news, like time to check in with the headlines or let's see what's happening in the world. ` +
          `Mention the show name. Never mention dates, times, or episode numbers.`;
      } else if (isDateDump) {
        prompt =
          `You're a radio host transitioning from music to a podcast segment. ` +
          `The show is called ${showName}. ` +
          (rssContext ? `${rssContext} ` : '') +
          `Introduce it naturally using only the show name, do not mention the episode title at all. ` +
          `Keep it smooth and conversational.`;
      } else {
        prompt =
          `You're transitioning from a music set to a podcast segment. ` +
          `Show name: ${showName}. Episode: ${episodeTitle}. ` +
          (rssContext ? `${rssContext} ` : '') +
          `Give a smooth natural on-air handoff. ` +
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

      const rssContext = [
        episode.author ? `Host/author: ${episode.author}.` : '',
        episode.description ? `Episode description: "${episode.description}"` : '',
      ].filter(Boolean).join(' ');

      let prompt: string;
      if (isNews) {
        prompt =
          `You're a radio host introducing a news segment. ` +
          `The show is ${episode.feedTitle}. ` +
          (rssContext ? `${rssContext} ` : '') +
          `Say something like time for the news or let's check in with the latest headlines. ` +
          `Mention the show name. Never read out dates, times, or timestamps.`;
      } else if (isDateDump) {
        prompt =
          `You're a radio host introducing a podcast segment. ` +
          `Show: ${episode.feedTitle}. ` +
          (rssContext ? `${rssContext} ` : '') +
          `The episode title is just a date or time, ignore it completely. ` +
          `Introduce the show by name only. Sound warm and natural.`;
      } else {
        prompt =
          `You're a radio host transitioning from music to a podcast segment. ` +
          `Show: ${episode.feedTitle}. Episode: ${episode.title}. ` +
          (rssContext ? `${rssContext} ` : '') +
          `Sound warm and natural. Do not say here's at the start. ` +
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

  /**
   * Brief "skipping ahead" line spoken after the user presses ⏭ while the
   * moderator was speaking. Interrupts gracefully and introduces the next item.
   */
  const speakSkipTransition = useCallback(
    async (next: WavlakeTrack | PodcastEpisode): Promise<void> => {
      let nextLabel: string;
      if ('name' in next) {
        nextLabel = `${next.artist} with ${cleanTrackTitle(next.name)}`;
      } else {
        nextLabel = next.feedTitle;
      }
      const prompts = [
        `Skipping ahead — here's ${nextLabel}.`,
        `Sure, let's move on. Here's ${nextLabel}.`,
        `Alright, jumping to ${nextLabel}.`,
        `Moving right along — ${nextLabel} is up.`,
      ];
      const fallback = prompts[Math.floor(Math.random() * prompts.length)];
      const aiScript = await generateScript(
        `You are a radio host. The listener just skipped the current track. ` +
        `Say something very brief (one short sentence) acknowledging the skip ` +
        `and introducing the next item: ${nextLabel}. ` +
        `Sound natural and unbothered, not apologetic. No stage directions.`,
      );
      await sayScript(aiScript ?? fallback);
    },
    [sayScript],
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
    speakSkipTransition,
    speakUserControlReaction,
    stop,
    isSpeaking,
    isGenerating,
    currentScript: currentScriptRef.current,
    error,
  };
}
