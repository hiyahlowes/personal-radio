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
  const tod  = getTimeOfDay();
  const lang = getLangCode();
  const n    = name.split(' ')[0];
  const scripts: Record<'en' | 'de' | 'fr', Record<TimeOfDay, string>> = {
    en: {
      morning:   `Good morning, ${n}. You're tuned in to PR, your personal radio station. It's a great morning for music, so let's kick things off right.`,
      afternoon: `Good afternoon, ${n}. Welcome back to PR. The afternoon playlist is ready and it's a good one. Let's get into it.`,
      evening:   `Good evening, ${n}. You're listening to PR. The day is winding down and the evening set is ready. This one's for you.`,
      night:     `Hey, ${n}. Late night, good music. You're tuned in to PR. Let's go.`,
    },
    de: {
      morning:   `Guten Morgen, ${n}. Du hörst PR, deinen persönlichen Radiosender. Ein toller Morgen für Musik — lass uns loslegen.`,
      afternoon: `Guten Tag, ${n}. Willkommen zurück bei PR. Die Nachmittagsplaylist ist bereit. Lass uns einsteigen.`,
      evening:   `Guten Abend, ${n}. Du hörst PR. Der Tag neigt sich dem Ende — das Abendprogramm ist bereit. Für dich.`,
      night:     `Hey, ${n}. Später Abend, gute Musik. Du hörst PR. Los geht's.`,
    },
    fr: {
      morning:   `Bonjour, ${n}. Vous écoutez PR, votre radio personnelle. C'est une belle matinée pour la musique — c'est parti.`,
      afternoon: `Bon après-midi, ${n}. Bienvenue sur PR. La playlist de l'après-midi est prête. On y va.`,
      evening:   `Bonsoir, ${n}. Vous êtes sur PR. La journée se termine — la sélection du soir est prête. Elle est pour vous.`,
      night:     `Salut, ${n}. Nuit tardive, bonne musique. Vous écoutez PR. C'est parti.`,
    },
  };
  return scripts[lang][tod];
}

function fallbackTrackIntro(track: WavlakeTrack): string {
  const title = cleanTrackTitle(track.name);
  const lang  = getLangCode();
  const a     = track.artist;
  const t     = title;
  const templates: Record<'en' | 'de' | 'fr', string[]> = {
    en: [
      `Up next, ${a} with ${t}.`,
      `Here's ${t} from ${a}.`,
      `Coming up, ${a} with ${t}.`,
      `Next on the playlist, ${t} by ${a}.`,
      `And now from ${a}, ${t}.`,
    ],
    de: [
      `Als nächstes: ${a} mit ${t}.`,
      `Hier ist ${t} von ${a}.`,
      `Gleich: ${a} mit ${t}.`,
      `Als nächstes in der Playlist: ${t} von ${a}.`,
      `Und jetzt von ${a}: ${t}.`,
    ],
    fr: [
      `Tout de suite, ${a} avec ${t}.`,
      `Voici ${t} par ${a}.`,
      `Ensuite, ${a} avec ${t}.`,
      `Prochain sur la playlist, ${t} par ${a}.`,
      `Et maintenant, ${a} avec ${t}.`,
    ],
  };
  const list = templates[lang];
  return list[track.id.charCodeAt(0) % list.length];
}

function fallbackPodcastTransition(showName: string, episodeTitle: string): string {
  const lang = getLangCode();
  const idx  = showName.charCodeAt(0);
  const s    = showName;

  if (isNewsShow(showName, episodeTitle)) {
    const t: Record<'en' | 'de' | 'fr', string[]> = {
      en: [`Time to check in with the latest. Here's ${s}.`, `Let's see what's happening in the world. ${s} is up next.`, `Time for the news. Here's ${s}.`],
      de: [`Zeit für die neuesten Nachrichten. Hier ist ${s}.`, `Schauen wir, was in der Welt passiert. ${s} kommt als nächstes.`, `Zeit für die Nachrichten. Hier ist ${s}.`],
      fr: [`L'heure de faire le point sur l'actualité. Voici ${s}.`, `Voyons ce qui se passe dans le monde. ${s} arrive tout de suite.`, `Place aux informations. Voici ${s}.`],
    };
    return t[lang][idx % 3];
  }
  if (episodeTitleIsDateDump(episodeTitle)) {
    const t: Record<'en' | 'de' | 'fr', string[]> = {
      en: [`Coming up, the latest from ${s}. Stay with us.`, `That's the music for now. Here's ${s}.`, `And now for something a little different. Here's ${s}.`],
      de: [`Gleich kommt das Neueste von ${s}. Bleibt dran.`, `Das war die Musik für jetzt. Hier ist ${s}.`, `Und jetzt etwas anderes. Hier ist ${s}.`],
      fr: [`Dans un instant, les dernières nouvelles de ${s}. Restez avec nous.`, `C'est tout pour la musique pour l'instant. Voici ${s}.`, `Et maintenant, quelque chose de différent. Voici ${s}.`],
    };
    return t[lang][idx % 3];
  }
  const t: Record<'en' | 'de' | 'fr', string[]> = {
    en: [`Let's check in with ${s}.`, `Time for some ${s}.`, `And now for something a little different. Here's ${s}.`],
    de: [`Schauen wir mal rein bei ${s}.`, `Zeit für ${s}.`, `Und jetzt etwas anderes. Hier ist ${s}.`],
    fr: [`On fait un tour du côté de ${s}.`, `L'heure de ${s}.`, `Et maintenant, quelque chose de différent. Voici ${s}.`],
  };
  return t[lang][idx % 3];
}

// Language helpers

function getStoredLanguage(): string {
  try { return localStorage.getItem('pr:language') || 'English'; } catch { return 'English'; }
}

function getLangCode(): 'en' | 'de' | 'fr' {
  const lang = getStoredLanguage();
  if (lang === 'Deutsch')  return 'de';
  if (lang === 'Français') return 'fr';
  return 'en';
}

function fallbackReviewAndIntro(played: WavlakeTrack[], next: WavlakeTrack, cleanNextTitle: string): string {
  const lang = getLangCode();
  const artists = played.map(t => t.artist).join(lang === 'fr' ? ' et ' : ' and ');
  const first   = played[0];
  if (played.length > 1) {
    const t: Record<'en' | 'de' | 'fr', string> = {
      en: `Great music from ${artists}, hope you enjoyed that. Coming up next, ${next.artist} with ${cleanNextTitle}.`,
      de: `Tolle Musik von ${artists} — hoffe, das hat euch gefallen. Als nächstes: ${next.artist} mit ${cleanNextTitle}.`,
      fr: `Belle musique de ${artists}, j'espère que vous avez apprécié. Ensuite, ${next.artist} avec ${cleanNextTitle}.`,
    };
    return t[lang];
  }
  const t: Record<'en' | 'de' | 'fr', string> = {
    en: `That was ${first.artist} with ${cleanTrackTitle(first.name)}. Now let's keep it going, here's ${next.artist} with ${cleanNextTitle}.`,
    de: `Das war ${first.artist} mit ${cleanTrackTitle(first.name)}. Und weiter geht's — ${next.artist} mit ${cleanNextTitle}.`,
    fr: `C'était ${first.artist} avec ${cleanTrackTitle(first.name)}. On continue avec ${next.artist} et ${cleanNextTitle}.`,
  };
  return t[lang];
}

function fallbackPodcastIntro(episode: { feedTitle: string; title: string }, isNewsOrDateDump: boolean): string {
  const lang = getLangCode();
  if (isNewsOrDateDump) {
    const t: Record<'en' | 'de' | 'fr', string> = {
      en: `Up next, ${episode.feedTitle}. Take a listen.`,
      de: `Als nächstes: ${episode.feedTitle}. Hör rein.`,
      fr: `Tout de suite, ${episode.feedTitle}. Bonne écoute.`,
    };
    return t[lang];
  }
  const t: Record<'en' | 'de' | 'fr', string> = {
    en: `Coming up, from ${episode.feedTitle}: ${episode.title}. Sit back and enjoy.`,
    de: `Gleich: ${episode.feedTitle} mit der Episode ${episode.title}. Lehn dich zurück.`,
    fr: `Dans un instant, ${episode.feedTitle} : ${episode.title}. Installez-vous confortablement.`,
  };
  return t[lang];
}

function fallbackPodcastReturn(podcastTitle: string, partNumber: number): string {
  const lang = getLangCode();
  const t: Record<'en' | 'de' | 'fr', string[]> = {
    en: [
      `And we're back, here's part ${partNumber} of ${podcastTitle}.`,
      `Welcome back. Picking up where we left off, ${podcastTitle}, part ${partNumber}.`,
      `Alright, back to it. Here's the next part of ${podcastTitle}.`,
    ],
    de: [
      `Und wir sind zurück — hier ist Teil ${partNumber} von ${podcastTitle}.`,
      `Willkommen zurück. Weiter geht es mit ${podcastTitle}, Teil ${partNumber}.`,
      `Gut, weiter. Hier ist der nächste Teil von ${podcastTitle}.`,
    ],
    fr: [
      `Et nous revoilà, voici la partie ${partNumber} de ${podcastTitle}.`,
      `Bienvenue de retour. On reprend là où on s'est arrêté — ${podcastTitle}, partie ${partNumber}.`,
      `Allez, on reprend. Voici la suite de ${podcastTitle}.`,
    ],
  };
  return t[lang][partNumber % 3];
}

function fallbackPodcastOutro(feedTitle: string, nextArtist: string, cleanNextTitle: string): string {
  const lang = getLangCode();
  const t: Record<'en' | 'de' | 'fr', string> = {
    en: `That was ${feedTitle}. Back to music now, here's ${nextArtist} with ${cleanNextTitle}.`,
    de: `Das war ${feedTitle}. Zurück zur Musik — hier ist ${nextArtist} mit ${cleanNextTitle}.`,
    fr: `C'était ${feedTitle}. Retour à la musique avec ${nextArtist} et ${cleanNextTitle}.`,
  };
  return t[lang];
}

function fallbackSkipTransition(nextLabel: string): string {
  const lang = getLangCode();
  const t: Record<'en' | 'de' | 'fr', string[]> = {
    en: [`Skipping ahead — here's ${nextLabel}.`, `Sure, let's move on. Here's ${nextLabel}.`, `Alright, jumping to ${nextLabel}.`, `Moving right along — ${nextLabel} is up.`],
    de: [`Weiter — hier ist ${nextLabel}.`, `Klar, machen wir weiter. Hier ist ${nextLabel}.`, `Gut, springen wir zu ${nextLabel}.`, `Gleich weiter — ${nextLabel} kommt.`],
    fr: [`On avance — voici ${nextLabel}.`, `Bien sûr, on passe à la suite. Voici ${nextLabel}.`, `D'accord, on saute à ${nextLabel}.`, `On avance — ${nextLabel} arrive.`],
  };
  const list = t[lang];
  return list[Math.floor(Math.random() * list.length)];
}

// Shakespeare AI script generator

async function generateScript(
  prompt: string,
  longForm = false,
  memoryContext = '',
): Promise<string | null> {
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
          `CRITICAL: You MUST respond ONLY in ${language}. ` +
          `Every single word of your response must be in ${language}. ` +
          `Never switch to English or any other language, even for artist names, song titles, or technical terms. ` +
          `If the artist name or song title is in English, still introduce it in ${language}. ` +
          `You are a warm, natural-sounding AI radio host for PR, Personal Radio. ` +
          'Speak exactly as you would on air: no stage directions, no quotation marks around spoken titles, no asterisks, ' +
          'no parenthetical notes. Just pure, natural radio speech. No emojis. ' +
          'RULES: ' +
          '(1) Never read out dates, times, episode numbers, or version tags. ' +
          '(2) For podcast episodes where the title is just a date or timestamp, ignore it and use the show name only. ' +
          '(3) For music, drop parenthetical suffixes like acoustic version or feat X, just say the clean title and artist. ' +
          '(4) Sound like a real DJ who knows what is worth saying on air. ' +
          'EXPRESSIVE TAGS: You can use ElevenLabs expressive tags inline in your spoken text to sound more like a real radio host. ' +
          'Available tags: [laughs] for genuine humor or amusement, [excited] for energetic song intros or big announcements, ' +
          '[sighs] for relaxed or late-night chill vibes, [whispers] for intimate or mysterious moments, ' +
          '[slow] for emphasis on an important word or phrase. ' +
          'Each tag affects only the next 4-5 words, then returns to normal. ' +
          'Use them sparingly — max 1-2 tags per moderation, only when it feels natural. ' +
          'Never stack multiple tags back to back. ' +
          'A real radio host uses these moments deliberately, not constantly. ' +
          'Example: "Coming up next — [excited] this one is absolutely incredible — Layer One by Richard."' +
          (memoryContext ? `\n\nLISTENER CONTEXT: ${memoryContext}` : ''),
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
  const memoryContextRef = useRef('');

  const setMemoryContext = useCallback((ctx: string) => {
    memoryContextRef.current = ctx;
  }, []);

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
      const aiScript = await generateScript(prompt, longForm, memoryContextRef.current);
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
      await buildAndSpeak(prompt, fallbackReviewAndIntro(played, next, cleanNextTitle));
    },
    [buildAndSpeak]
  );

  /**
   * Brief reaction spoken when the listener manually skips or jumps directly
   * to a podcast episode. Uses the AI with the CRITICAL language rule so the
   * line is always spoken in the listener's chosen language.
   */
  const speakUserControlReaction = useCallback(async (): Promise<void> => {
    const prompt =
      'The listener just manually skipped or selected a track. ' +
      'React in one short, casual sentence — like a real radio host who respects the listener taking control. ' +
      'Sound natural and unbothered. No stage directions, no emojis.';
    // generateScript already applies the CRITICAL language rule (reads localStorage).
    // If the AI call fails, skip silently — better than speaking in the wrong language.
    const aiScript = await generateScript(prompt);
    if (aiScript) await sayScript(aiScript);
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
      const noSongRule =
        'Do NOT mention what song was just playing or what music comes next. ' +
        'Focus only on the podcast. No "coming up after this" or "stay tuned for more music".';

      if (isNews) {
        prompt =
          `You're a radio host transitioning from music to a news segment. ` +
          `The news show is called ${showName}. ` +
          (rssContext ? `${rssContext} ` : '') +
          `Say something like "time to check in with the headlines" or "let's see what's happening in the world". ` +
          `Mention the show name. Never mention dates, times, or episode numbers. ${noSongRule}`;
      } else if (isDateDump) {
        prompt =
          `You're a radio host transitioning from music to a podcast segment. ` +
          `The show is called ${showName}. ` +
          (rssContext ? `${rssContext} ` : '') +
          `Introduce it naturally using only the show name, do not mention the episode title at all. ` +
          `Keep it smooth and conversational. ${noSongRule}`;
      } else {
        prompt =
          `You're a radio host transitioning from music to a podcast segment. ` +
          `Show: ${showName}. Episode: ${episodeTitle}. ` +
          (rssContext ? `${rssContext} ` : '') +
          `Give a warm, natural on-air introduction — like "let's check in on ${showName}" or "time for some ${showName}". ` +
          `Use the show name primarily. Only mention the episode title if it is genuinely descriptive and adds real value. ` +
          `Never mention dates, times, or episode numbers. ${noSongRule}`;
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

      await buildAndSpeak(prompt, fallbackPodcastIntro(episode, isNews || isDateDump));
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
      await buildAndSpeak(prompt, fallbackPodcastReturn(podcastTitle, partNumber));
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

      await buildAndSpeak(prompt, fallbackPodcastOutro(episode.feedTitle, nextTrack.artist, cleanNextTitle));
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
      const aiScript = await generateScript(
        `You are a radio host. The listener just skipped the current track. ` +
        `Say something very brief (one short sentence) acknowledging the skip ` +
        `and introducing the next item: ${nextLabel}. ` +
        `Sound natural and unbothered, not apologetic. No stage directions.`,
      );
      await sayScript(aiScript ?? fallbackSkipTransition(nextLabel));
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
    setMemoryContext,
    stop,
    isSpeaking,
    isGenerating,
    currentScript: currentScriptRef.current,
    error,
  };
}
