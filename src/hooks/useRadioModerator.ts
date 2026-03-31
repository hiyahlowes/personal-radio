import { useCallback, useRef } from 'react';
import { useElevenLabs } from './useElevenLabs';
import { useNostrKey } from './useNostrKey';
import { useNIP90 } from './useNIP90';
import { nip19 } from 'nostr-tools';
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
  const lang   = getLangCode();
  const locale = lang === 'de' ? 'de-DE' : lang === 'fr' ? 'fr-FR' : 'en-US';
  return new Date().toLocaleDateString(locale, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

/** Returns the current time-of-day label in the listener's language. */
function todLabel(): string {
  const tod  = getTimeOfDay();
  const lang = getLangCode();
  const map: Record<'en' | 'de' | 'fr', Record<TimeOfDay, string>> = {
    en: { morning: 'morning', afternoon: 'afternoon', evening: 'evening', night: 'late-night' },
    de: { morning: 'Morgen',  afternoon: 'Nachmittag', evening: 'Abend',  night: 'Nacht'      },
    fr: { morning: 'matin',   afternoon: 'après-midi', evening: 'soir',   night: 'nuit tardive' },
  };
  return map[lang][tod];
}

/**
 * Pick a prompt string based on the current language.
 * All AI prompts must be written in the listener's language so Claude doesn't
 * revert to English despite the CRITICAL system-prompt header.
 */
function lp(en: string, de: string, fr: string): string {
  const lang = getLangCode();
  if (lang === 'de') return de;
  if (lang === 'fr') return fr;
  return en;
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

function fallbackTechnicalDifficulty(): string {
  const lang = getLangCode();
  const t: Record<'en' | 'de' | 'fr', string[]> = {
    en: [
      "We're having some technical difficulties — let's keep the music going.",
      "That episode seems to be having issues — back to the music for now.",
      "Technical glitch on that one — no worries, here's some music instead.",
    ],
    de: [
      'Wir haben gerade technische Schwierigkeiten — weiter mit Musik.',
      'Diese Folge macht Probleme — zurück zur Musik für jetzt.',
      'Technischer Fehler — kein Problem, hier ist Musik stattdessen.',
    ],
    fr: [
      "On a quelques difficultés techniques — on continue avec la musique.",
      "Cet épisode semble avoir des problèmes — retour à la musique pour l'instant.",
      "Problème technique sur celui-là — pas de souci, voici de la musique à la place.",
    ],
  };
  const list = t[lang];
  return list[Math.floor(Math.random() * list.length)];
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

// NIP-90 helpers

/** Convert an npub or hex public key to its hex form. */
function npubToHex(npubOrHex: string): string {
  try {
    const decoded = nip19.decode(npubOrHex);
    if (decoded.type === 'npub') return decoded.data;
  } catch { /* not an npub — assume hex */ }
  return npubOrHex;
}

function lsGet(key: string, fallback = ''): string {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}

// Shakespeare AI script generator

/** Maps the stored display name (e.g. "Deutsch") to the English language name Claude understands. */
function toClangName(stored: string): string {
  if (stored === 'Deutsch')  return 'German';
  if (stored === 'Français') return 'French';
  return 'English';
}

async function generateScript(
  prompt: string,
  longForm = false,
  memoryContext = '',
): Promise<string | null> {
  const storedLang = getStoredLanguage();
  const language   = toClangName(storedLang);
  console.log(`[Moderator] storedLang="${storedLang}" → claudeLang="${language}" | longForm=${longForm} | prompt: ${prompt.slice(0, 80)}…`);
  const lengthInstruction = longForm
    ? 'Be a bit more elaborate this time: use 3 to 4 sentences.'
    : 'Keep it to 1 to 2 sentences.';
  try {
    const systemPrompt =
          `CRITICAL: You MUST respond ONLY in ${language}. ` +
          `Every single word of your response must be in ${language}. ` +
          `Never switch to English or any other language, even for artist names, song titles, or technical terms. ` +
          `If the artist name or song title is in English, still introduce it in ${language}. ` +
          `You are a real radio host for PR, Personal Radio — not an announcer, not a corporate voice. ` +
          'You are a Bitcoin maxi, podcast nerd, and radio host who talks like a good friend. ' +
          'Casual, warm, real. You have strong opinions and you share them. ' +
          'You genuinely care about Bitcoin, open podcasting, and the music you play. ' +
          'Speak like a human, not a script: no stage directions, no quotation marks around spoken titles, no asterisks, ' +
          'no parenthetical notes. Just pure, natural radio speech. No emojis. ' +
          'DELIVERY RULES: ' +
          '(1) Use contractions naturally: "that\'s", "it\'s", "you\'ve", "we\'re". ' +
          '(2) Start sentences mid-thought sometimes: "And honestly...", "You know what...", "Look...". ' +
          '(3) React genuinely — if something is interesting, say WHY it\'s interesting to you specifically. ' +
          '(4) Vary sentence length: short punchy sentences. Then longer ones that build on the thought. ' +
          '(5) Never say "Welcome back", "Stay tuned", or "Up next" — dead radio clichés. ' +
          '(6) Never summarize what you just said. ' +
          '(7) One thought per moderation — go deep on one thing, not broad on three things. ' +
          '(8) You have opinions. Share them. You are not neutral. ' +
          'CONTENT RULES: ' +
          '(9) Never read out dates, times, episode numbers, or version tags. ' +
          '(10) For podcast episodes where the title is just a date or timestamp, ignore it and use the show name only. ' +
          '(11) For music, drop parenthetical suffixes like acoustic version or feat X, just say the clean title and artist. ' +
          '(12) Never mention Wavlake, sats, charts, streaming numbers, or Bitcoin tips in a music intro. Talk about the music itself, the artist, or how it sounds — not where it comes from. ' +
          (() => {
            const provider = (() => { try { return localStorage.getItem('pr:tts-provider') === 'fish' ? 'fish' : 'elevenlabs'; } catch { return 'elevenlabs'; } })();
            if (provider === 'fish') {
              return (
                'EXPRESSIVE TAGS — Fish Audio S2-Pro supports FREE-FORM natural language tags in [brackets]. ' +
                'Use them creatively and generously to bring the delivery to life. ' +
                'Examples: [laughing] [super excited] [whisper] [can\'t believe it] [genuinely impressed] ' +
                '[low conspiratorial voice] [hyped up] [radio host voice] [slightly mind-blown] [warm and friendly] ' +
                '[dramatic pause] [casually dropping a bomb] [mock serious]. ' +
                'Embed tags naturally wherever they add life — one or two per sentence max. ' +
                'Do not save them all for the end. Scatter them where they feel right. ' +
                'Example: "[super excited] This track is seriously something else — [warm and friendly] I\'ve had it on repeat all week." ' +
                (storedLang === 'Deutsch'
                  ? '\n\nDEUTSCH: Gleiche Energie, gleiche Authentizität auf Deutsch. ' +
                    'Slang wie "Alter", "krass", "ehrlich gesagt", "das ist heftig" ist willkommen. ' +
                    'Tags auf Englisch lassen (Fish Audio versteht sie). Sei ein Freund, kein Nachrichtensprecher.'
                  : '')
              );
            } else {
              return (
                'EXPRESSIVE TAGS: You can use ElevenLabs expressive tags inline in your spoken text. ' +
                'Available tags (turbo model — only these 5 work): ' +
                '[laughs] for genuine humor or amusement, [excited] for energetic song intros or big announcements, ' +
                '[sighs] for relaxed or late-night chill vibes, [whispers] for intimate or mysterious moments, ' +
                '[slow] for emphasis on an important word or phrase. ' +
                'Each tag affects only the next 4-5 words, then returns to normal. ' +
                'Use them sparingly — max 2 tags per response, only when it feels natural. ' +
                'Never stack multiple tags back to back. ' +
                'Example: "Coming up next — [excited] this one is absolutely incredible — Layer One by Richard."' +
                (storedLang === 'Deutsch'
                  ? '\n\nDEUTSCHE MODERATIONSREGEL: Sei lebendig, persönlich und ausdrucksstark. ' +
                    'Nutze [excited], [laughs], [sighs] großzügig. ' +
                    'Sprich wie ein echter Radiomoderator — nicht wie ein Nachrichtensprecher.'
                  : '')
              );
            }
          })() +
          (memoryContext ? `\n\nLISTENER CONTEXT: ${memoryContext}` : '');

    console.log('[Moderator] system prompt language header:', systemPrompt.slice(0, 120));

    const response = await fetch('/.netlify/functions/claude-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        system: systemPrompt,
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

export interface ResumeContext {
  lastPosition: number;   // seconds already heard
  topics: string[];       // topics covered so far (from EpisodeRecord.topics)
}

export interface ModeratorState {
  isSpeaking: boolean;
  isGenerating: boolean;
  currentScript: string;
  error: string | null;
}

export function useRadioModerator() {
  const { speak, stop, generate, playUrl, isSpeaking, isGenerating, error } = useElevenLabs();
  const nostrKey = useNostrKey();
  const { sendJob } = useNIP90();
  const currentScriptRef = useRef('');
  const memoryContextRef = useRef('');

  const setMemoryContext = useCallback((ctx: string) => {
    memoryContextRef.current = ctx;
  }, []);

  /**
   * Resolve a moderator script: tries the user's NIP-90 agent first (if
   * pr:nip90-enabled === "true"), falls back to Claude Haiku silently.
   */
  const resolveScript = useCallback(
    async (prompt: string, longForm = false): Promise<string | null> => {
      if (lsGet('pr:nip90-enabled') === 'true') {
        const agentNpub = lsGet('pr:agent-npub');
        if (agentNpub) {
          const relay              = lsGet('pr:agent-relay', 'wss://relay.damus.io');
          const agentPubkeyHex    = npubToHex(agentNpub);
          const listenerNpubRaw   = lsGet('pr:listener-npub');
          const listenerPubkeyHex = listenerNpubRaw ? npubToHex(listenerNpubRaw) : undefined;
          const listenerName      = lsGet('pr:name', 'Listener');

          const agentResult = await sendJob({
            prompt,
            listenerInfo: `Listener: ${listenerName}, Language: ${getStoredLanguage()}`,
            agentPubkeyHex,
            listenerPubkeyHex,
            relay,
            privateKey: nostrKey.privateKey,
          });

          if (agentResult) {
            console.log('[Moderator] using agent response');
            return agentResult;
          }
          console.log('[Moderator] agent timeout — using Claude fallback');
        }
      }
      return generateScript(prompt, longForm, memoryContextRef.current);
    },
    [sendJob, nostrKey.privateKey],
  );

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
      const aiScript = await resolveScript(prompt, longForm);
      await sayScript(aiScript ?? fallback);
    },
    [resolveScript, sayScript]
  );

  /**
   * Generate script + TTS audio without playing.
   * Returns a blob URL (caller owns it — call URL.revokeObjectURL when done),
   * or null on failure. Used for parallel pre-generation.
   */
  const buildAndGenerate = useCallback(
    async (prompt: string, fallback: string): Promise<string | null> => {
      console.log('[TTS-Pre] generating silently — no duck');
      const longForm = Math.random() < 0.2;
      const aiScript = await resolveScript(prompt, longForm);
      return generate(aiScript ?? fallback);
    },
    [resolveScript, generate]
  );

  /** Pre-generate greeting audio without playing it. */
  const generateGreetingAudio = useCallback(
    async (listenerName: string): Promise<string | null> => {
      const firstName = listenerName.split(' ')[0];
      const date = getDateString();
      const tod  = todLabel();
      const prompt = lp(
        `Write a ${tod} on-air greeting for a listener named ${firstName}. ` +
        `Today is ${date}. ` +
        `Sound warm, personal and authentic, like a real radio host welcoming them to their favourite station. ` +
        `Reference the time of day naturally. 2 to 3 sentences.`,

        `Schreibe eine ${tod}-Begrüßung auf Sendung für einen Hörer namens ${firstName}. ` +
        `Heute ist ${date}. ` +
        `Klinge warm, persönlich und authentisch, wie ein echter Radiosprecher der seinen Lieblingshörer begrüßt. ` +
        `Erwähne die Tageszeit auf natürliche Weise. 2 bis 3 Sätze.`,

        `Écris une salutation de ${tod} à l'antenne pour un auditeur prénommé ${firstName}. ` +
        `Aujourd'hui, nous sommes le ${date}. ` +
        `Sois chaleureux, personnel et authentique, comme un vrai animateur de radio accueillant son auditeur. ` +
        `Mentionne le moment de la journée naturellement. 2 à 3 phrases.`,
      );
      return buildAndGenerate(prompt, fallbackGreeting(listenerName));
    },
    [buildAndGenerate]
  );

  /** Pre-generate track intro audio without playing it. */
  const generateTrackIntroAudio = useCallback(
    async (track: WavlakeTrack, isTopChart = false, isLiked = false): Promise<string | null> => {
      void isTopChart;
      const cleanTitle = cleanTrackTitle(track.name);
      const likedEn = isLiked ? `The listener has liked this song before. You may acknowledge that naturally — e.g. a favourite returning — but only if it fits and feels genuine. Do not force it. ` : '';
      const likedDe = isLiked ? `Der Hörer hat diesen Song bereits geliked. Erwähne das natürlich — z.B. ein Favorit der zurückkommt — aber nur wenn es sich organisch anfühlt. Nicht erzwingen. ` : '';
      const likedFr = isLiked ? `L'auditeur a déjà aimé ce morceau. Tu peux le mentionner naturellement — ex. un favori qui revient — seulement si ça s'intègre bien. Ne force pas. ` : '';
      const prompt = lp(
        `Introduce the next song on air. ` +
        `Artist: ${track.artist}. Song title: ${cleanTitle}. ` +
        `Album: ${track.albumTitle || 'their latest work'}. ` +
        likedEn +
        `Sound like a natural radio DJ handing off to the track. Keep it to 1 to 2 sentences. ` +
        `Vary your phrasing, do not start with Here's. Do not put the title in quotes. ` +
        `Do not add version tags or extra info, just the artist and clean title.`,

        `Moderiere den nächsten Song an. ` +
        `Künstler: ${track.artist}. Songtitel: ${cleanTitle}. ` +
        `Album: ${track.albumTitle || 'ihr aktuelles Werk'}. ` +
        likedDe +
        `Klinge wie ein natürlicher Radio-DJ der zum Track übergeht. 1 bis 2 Sätze. ` +
        `Variiere die Formulierung, beginne nicht mit Hier ist. Keine Anführungszeichen um den Titel. ` +
        `Keine Versions-Tags oder Extra-Infos, nur Künstler und Titel.`,

        `Présente le prochain morceau à l'antenne. ` +
        `Artiste : ${track.artist}. Titre : ${cleanTitle}. ` +
        `Album : ${track.albumTitle || 'leur dernier travail'}. ` +
        likedFr +
        `Sois naturel comme un vrai DJ radio qui passe au morceau. 1 à 2 phrases. ` +
        `Varie ta formulation, ne commence pas par Voici. Pas de guillemets autour du titre. ` +
        `Pas d'infos de version, juste l'artiste et le titre.`,
      );
      return buildAndGenerate(prompt, fallbackTrackIntro(track));
    },
    [buildAndGenerate]
  );

  /** Play a pre-generated blob URL (from generateGreetingAudio / generateTrackIntroAudio). */
  const playAudio = useCallback(
    async (blobUrl: string): Promise<void> => {
      currentScriptRef.current = '(pre-generated)';
      await playUrl(blobUrl);
    },
    [playUrl]
  );

  /**
   * Pre-generate podcast transition audio (no resume context — fresh episode).
   * Returns a blob URL or null. Caller is responsible for revoking when done.
   */
  const generatePodcastTransitionAudio = useCallback(
    async (
      episodeTitle: string,
      showName: string,
      description?: string,
      author?: string,
    ): Promise<string | null> => {
      const isNews     = isNewsShow(showName, episodeTitle);
      const isDateDump = episodeTitleIsDateDump(episodeTitle);

      const noSongRule = lp(
        'Do NOT mention what song was just playing or what music comes next. Focus only on the podcast. No "coming up after this" or "stay tuned for more music".',
        'Erwähne NICHT welcher Song gerade gespielt wurde oder welche Musik als nächstes kommt. Fokussiere dich nur auf den Podcast.',
        "Ne mentionnez PAS quelle chanson venait de jouer ou quelle musique vient ensuite. Concentrez-vous uniquement sur le podcast.",
      );

      const rssContext = [
        author      ? lp(`Host/author: ${author}.`, `Moderator/Autor: ${author}.`, `Présentateur/auteur : ${author}.`) : '',
        description ? lp(`Episode description: "${description}"`, `Episodenbeschreibung: "${description}"`, `Description de l'épisode : "${description}"`) : '',
      ].filter(Boolean).join(' ');

      let prompt: string;
      if (isNews) {
        prompt = lp(
          `You're a radio host transitioning from music to a news segment. ` +
          `The news show is called ${showName}. ` +
          (rssContext ? `${rssContext} ` : '') +
          `Say something like "time to check in with the headlines". Mention the show name. Never mention dates, times, or episode numbers. ${noSongRule}`,

          `Du bist ein Radiosprecher der von Musik zu einem Nachrichtensegment übergeht. ` +
          `Die Nachrichtensendung heißt ${showName}. ` +
          (rssContext ? `${rssContext} ` : '') +
          `Sage etwas wie "Zeit für die aktuellen Nachrichten". Erwähne den Sendungsnamen. Niemals Datum, Uhrzeit oder Episodennummern. ${noSongRule}`,

          `Tu es un animateur radio qui passe de la musique à un segment d'actualités. ` +
          `L'émission de nouvelles s'appelle ${showName}. ` +
          (rssContext ? `${rssContext} ` : '') +
          `Dis quelque chose comme "l'heure de faire le point sur l'actualité". Mentionne le nom de l'émission. ${noSongRule}`,
        );
      } else if (isDateDump) {
        prompt = lp(
          `You're a radio host transitioning from music to a podcast. ` +
          `The show is called ${showName}. ` +
          (rssContext ? `${rssContext} ` : '') +
          `Introduce using only the show name, skip the episode title entirely. Keep it smooth, max 2 sentences. ${noSongRule}`,

          `Du bist ein Radiosprecher der von Musik zu einem Podcast übergeht. ` +
          `Die Sendung heißt ${showName}. ` +
          (rssContext ? `${rssContext} ` : '') +
          `Führe nur mit dem Sendungsnamen ein, Episodentitel weglassen. Flüssig, max. 2 Sätze. ${noSongRule}`,

          `Tu es un animateur radio qui passe de la musique à un podcast. ` +
          `L'émission s'appelle ${showName}. ` +
          (rssContext ? `${rssContext} ` : '') +
          `Présente uniquement avec le nom de l'émission, pas le titre de l'épisode. Maximum 2 phrases. ${noSongRule}`,
        );
      } else {
        prompt = lp(
          `You're a radio host transitioning from music to a podcast episode. ` +
          `Show: ${showName}. Episode: ${isDateDump ? '' : `"${episodeTitle}"`}. ` +
          (rssContext ? `${rssContext} ` : '') +
          `Write a smooth intro — max 2–3 sentences. Reference the show name and episode if it's meaningful. ${noSongRule}`,

          `Du bist ein Radiosprecher der von Musik zu einer Podcast-Episode übergeht. ` +
          `Sendung: ${showName}. Episode: ${isDateDump ? '' : `"${episodeTitle}"`}. ` +
          (rssContext ? `${rssContext} ` : '') +
          `Schreibe eine flüssige Ansage — max. 2–3 Sätze. Sendungsname und Episode wenn sinnvoll erwähnen. ${noSongRule}`,

          `Tu es un animateur radio qui passe de la musique à un épisode de podcast. ` +
          `Émission : ${showName}. Épisode : ${isDateDump ? '' : `"${episodeTitle}"`}. ` +
          (rssContext ? `${rssContext} ` : '') +
          `Écris une intro fluide — maximum 2–3 phrases. Mentionne l'émission et l'épisode si pertinent. ${noSongRule}`,
        );
      }

      console.log(`[TTS-Pre] pre-generating podcast intro for: "${showName}"`);
      return buildAndGenerate(prompt, lp(
        `Up next: ${showName}.`,
        `Als nächstes: ${showName}.`,
        `Ensuite : ${showName}.`,
      ));
    },
    [buildAndGenerate],
  );

  /**
   * Pre-generate commentary audio for a podcast interruption.
   * Just wraps generate() — the script is already determined by the segmenter.
   * Returns a blob URL or null. Caller revokes when done.
   */
  const generateCommentaryAudio = useCallback(
    async (script: string): Promise<string | null> => {
      console.log('[TTS-Pre] pre-generating interrupt commentary');
      return generate(script);
    },
    [generate],
  );

  const speakGreeting = useCallback(
    async (listenerName: string): Promise<void> => {
      const firstName = listenerName.split(' ')[0];
      const date = getDateString();
      const tod  = todLabel();
      const prompt = lp(
        `Write a ${tod} on-air greeting for a listener named ${firstName}. ` +
        `Today is ${date}. ` +
        `Sound warm, personal and authentic, like a real radio host welcoming them to their favourite station. ` +
        `Reference the time of day naturally. 2 to 3 sentences.`,

        `Schreibe eine ${tod}-Begrüßung auf Sendung für einen Hörer namens ${firstName}. ` +
        `Heute ist ${date}. ` +
        `Klinge warm, persönlich und authentisch, wie ein echter Radiosprecher der seinen Lieblingshörer begrüßt. ` +
        `Erwähne die Tageszeit auf natürliche Weise. 2 bis 3 Sätze.`,

        `Écris une salutation de ${tod} à l'antenne pour un auditeur prénommé ${firstName}. ` +
        `Aujourd'hui, nous sommes le ${date}. ` +
        `Sois chaleureux, personnel et authentique, comme un vrai animateur de radio accueillant son auditeur. ` +
        `Mentionne le moment de la journée naturellement. 2 à 3 phrases.`,
      );
      await buildAndSpeak(prompt, fallbackGreeting(listenerName));
    },
    [buildAndSpeak]
  );

  const speakTrackIntro = useCallback(
    async (track: WavlakeTrack, isTopChart = false, isLiked = false): Promise<void> => {
      void isTopChart; // chart status intentionally not passed to Claude — rule (12)
      const cleanTitle = cleanTrackTitle(track.name);
      const likedEn = isLiked ? `The listener has liked this song before. You may acknowledge that naturally — e.g. a favourite returning — but only if it fits and feels genuine. Do not force it. ` : '';
      const likedDe = isLiked ? `Der Hörer hat diesen Song bereits geliked. Erwähne das natürlich — z.B. ein Favorit der zurückkommt — aber nur wenn es sich organisch anfühlt. Nicht erzwingen. ` : '';
      const likedFr = isLiked ? `L'auditeur a déjà aimé ce morceau. Tu peux le mentionner naturellement — ex. un favori qui revient — seulement si ça s'intègre bien. Ne force pas. ` : '';
      const prompt = lp(
        `Introduce the next song on air. ` +
        `Artist: ${track.artist}. Song title: ${cleanTitle}. ` +
        `Album: ${track.albumTitle || 'their latest work'}. ` +
        likedEn +
        `Sound like a natural radio DJ handing off to the track. Keep it to 1 to 2 sentences. ` +
        `Vary your phrasing, do not start with Here's. Do not put the title in quotes. ` +
        `Do not add version tags or extra info, just the artist and clean title.`,

        `Moderiere den nächsten Song an. ` +
        `Künstler: ${track.artist}. Songtitel: ${cleanTitle}. ` +
        `Album: ${track.albumTitle || 'ihr aktuelles Werk'}. ` +
        likedDe +
        `Klinge wie ein natürlicher Radio-DJ der zum Track übergeht. 1 bis 2 Sätze. ` +
        `Variiere die Formulierung, beginne nicht mit Hier ist. Keine Anführungszeichen um den Titel. ` +
        `Keine Versions-Tags oder Extra-Infos, nur Künstler und Titel.`,

        `Présente le prochain morceau à l'antenne. ` +
        `Artiste : ${track.artist}. Titre : ${cleanTitle}. ` +
        `Album : ${track.albumTitle || 'leur dernier travail'}. ` +
        likedFr +
        `Sois naturel comme un vrai DJ radio qui passe au morceau. 1 à 2 phrases. ` +
        `Varie ta formulation, ne commence pas par Voici. Pas de guillemets autour du titre. ` +
        `Pas d'infos de version, juste l'artiste et le titre.`,
      );
      await buildAndSpeak(prompt, fallbackTrackIntro(track));
    },
    [buildAndSpeak]
  );

  const speakReviewAndIntro = useCallback(
    async (played: WavlakeTrack[], next: WavlakeTrack, isNextTopChart = false, isNextLiked = false): Promise<void> => {
      void isNextTopChart; // chart status intentionally not passed to Claude — rule (12)
      const playedList = played
        .map(t => `${t.artist} with ${cleanTrackTitle(t.name)}`)
        .join(' and then ');
      const cleanNextTitle = cleanTrackTitle(next.name);
      const likedEn = isNextLiked ? `The listener has liked the next track before. You may acknowledge that naturally if it fits. ` : '';
      const likedDe = isNextLiked ? `Der Hörer hat den nächsten Track bereits geliked. Erwähne das natürlich wenn es passt. ` : '';
      const likedFr = isNextLiked ? `L'auditeur a déjà aimé le prochain morceau. Tu peux le mentionner naturellement si ça s'intègre. ` : '';
      const prompt = lp(
        `You just played ${playedList} on air without commentary. ` +
        `Give a brief warm reaction to that music, one sentence. ` +
        `Then introduce the next track: ${next.artist} with ${cleanNextTitle}. ` +
        likedEn +
        `Keep the whole thing to 2 to 3 sentences. Sound like a natural radio DJ, not a robot. ` +
        `Do not put titles in quotes or add version tags.`,

        `Du hast gerade ${playedList} auf Sendung gespielt, ohne Kommentar. ` +
        `Gib eine kurze, warme Reaktion auf diese Musik, ein Satz. ` +
        `Dann kündige den nächsten Track an: ${next.artist} mit ${cleanNextTitle}. ` +
        likedDe +
        `Insgesamt 2 bis 3 Sätze. Klinge wie ein natürlicher Radio-DJ, nicht wie ein Roboter. ` +
        `Keine Anführungszeichen um Titel, keine Versions-Tags.`,

        `Tu viens de passer ${playedList} à l'antenne sans commentaire. ` +
        `Donne une brève réaction chaleureuse à cette musique, une phrase. ` +
        `Puis présente le prochain morceau : ${next.artist} avec ${cleanNextTitle}. ` +
        likedFr +
        `En tout, 2 à 3 phrases. Sois naturel comme un vrai DJ radio, pas un robot. ` +
        `Pas de guillemets autour des titres, pas de tags de version.`,
      );
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
    const prompt = lp(
      'The listener just manually skipped or selected a track. ' +
      'React in one short, casual sentence — like a real radio host who respects the listener taking control. ' +
      'Sound natural and unbothered. No stage directions, no emojis.',

      'Der Hörer hat gerade manuell einen Track übersprungen oder ausgewählt. ' +
      'Reagiere mit einem kurzen, lockeren Satz — wie ein echter Radiosprecher der es respektiert wenn der Hörer die Kontrolle übernimmt. ' +
      'Klingt natürlich und entspannt. Keine Regieanweisungen, keine Emojis.',

      "L'auditeur vient de passer ou sélectionner manuellement un morceau. " +
      "Réagis en une courte phrase décontractée — comme un vrai animateur radio qui respecte que l'auditeur prenne le contrôle. " +
      'Sois naturel et détendu. Pas de didascalies, pas d\'emojis.',
    );
    // resolveScript tries the agent first, then falls back to Claude.
    // If the call fails, skip silently — better than speaking in the wrong language.
    const aiScript = await resolveScript(prompt);
    if (aiScript) await sayScript(aiScript);
  }, [resolveScript, sayScript]);

  const speakPodcastTransition = useCallback(
    async (
      episodeTitle: string,
      showName: string,
      description?: string,
      author?: string,
      resumeCtx?: ResumeContext,
    ): Promise<void> => {
      const isResuming = !!resumeCtx && resumeCtx.lastPosition > 60;
      const isNews     = isNewsShow(showName, episodeTitle);
      const isDateDump = episodeTitleIsDateDump(episodeTitle);

      const noSongRule = lp(
        'Do NOT mention what song was just playing or what music comes next. Focus only on the podcast. No "coming up after this" or "stay tuned for more music".',
        'Erwähne NICHT welcher Song gerade gespielt wurde oder welche Musik als nächstes kommt. Fokussiere dich nur auf den Podcast.',
        "Ne mentionnez PAS quelle chanson venait de jouer ou quelle musique vient ensuite. Concentrez-vous uniquement sur le podcast.",
      );

      let prompt: string;

      if (isResuming) {
        const minutesHeard  = Math.floor(resumeCtx.lastPosition / 60);
        const recentTopics  = resumeCtx.topics.slice(-2);
        const lastTopic     = recentTopics[recentTopics.length - 1];
        const topicsContext = recentTopics.length > 0
          ? lp(`Topics covered so far: ${recentTopics.join(', ')}.`, `Bisher behandelte Themen: ${recentTopics.join(', ')}.`, `Sujets abordés jusqu'ici : ${recentTopics.join(', ')}.`)
          : '';

        prompt = lp(
          `You're a radio host picking up a podcast the listener was already partway through. ` +
          `Show: ${showName}. ` +
          `The listener has already heard ${minutesHeard} minute${minutesHeard !== 1 ? 's' : ''} of this episode. ` +
          (lastTopic ? `Last known topic: ${lastTopic}. ` : '') +
          (topicsContext ? `${topicsContext} ` : '') +
          `Write a SHORT resume intro — max 25 words. Reference the show name and how far in they are. ` +
          `If there's a known topic, reference something specific from it. ` +
          `Do NOT introduce the episode as if it's new. Sound like a host who remembers where you left off. ${noSongRule}`,

          `Du bist ein Radiosprecher der einen Podcast wieder aufnimmt, den der Hörer bereits teilweise gehört hat. ` +
          `Sendung: ${showName}. ` +
          `Der Hörer hat bereits ${minutesHeard} Minute${minutesHeard !== 1 ? 'n' : ''} dieser Episode gehört. ` +
          (lastTopic ? `Letztes bekanntes Thema: ${lastTopic}. ` : '') +
          (topicsContext ? `${topicsContext} ` : '') +
          `Schreibe eine kurze Wiederaufnahme-Ansage — max. 25 Wörter. Erwähne den Sendungsnamen und wie weit der Hörer ist. ` +
          `Falls ein Thema bekannt ist, erwähne etwas Konkretes daraus. ` +
          `Führe die Episode NICHT als neu ein. Klinge wie ein Moderator der sich erinnert wo aufgehört wurde. ${noSongRule}`,

          `Tu es un animateur radio qui reprend un podcast que l'auditeur écoutait déjà. ` +
          `Émission : ${showName}. ` +
          `L'auditeur a déjà entendu ${minutesHeard} minute${minutesHeard !== 1 ? 's' : ''} de cet épisode. ` +
          (lastTopic ? `Dernier sujet connu : ${lastTopic}. ` : '') +
          (topicsContext ? `${topicsContext} ` : '') +
          `Écris une courte intro de reprise — max 25 mots. Mentionne le nom de l'émission et l'avancement. ` +
          `S'il y a un sujet connu, fais-y référence concrètement. ` +
          `Ne présente PAS l'épisode comme nouveau. Semble te souvenir de là où on s'était arrêté. ${noSongRule}`,
        );
      } else {
        // Optional context from the RSS feed to enrich the AI prompt
        const rssContext = [
          author      ? lp(`Host/author: ${author}.`, `Moderator/Autor: ${author}.`, `Présentateur/auteur : ${author}.`) : '',
          description ? lp(`Episode description: "${description}"`, `Episodenbeschreibung: "${description}"`, `Description de l'épisode : "${description}"`) : '',
        ].filter(Boolean).join(' ');

        if (isNews) {
          prompt = lp(
            `You're a radio host transitioning from music to a news segment. ` +
            `The news show is called ${showName}. ` +
            (rssContext ? `${rssContext} ` : '') +
            `Say something like "time to check in with the headlines" or "let's see what's happening in the world". ` +
            `Mention the show name. Never mention dates, times, or episode numbers. ${noSongRule}`,

            `Du bist ein Radiosprecher der von Musik zu einem Nachrichtensegment übergeht. ` +
            `Die Nachrichtensendung heißt ${showName}. ` +
            (rssContext ? `${rssContext} ` : '') +
            `Sage etwas wie "Zeit für die aktuellen Nachrichten" oder "Schauen wir, was in der Welt passiert". ` +
            `Erwähne den Sendungsnamen. Niemals Datum, Uhrzeit oder Episodennummern erwähnen. ${noSongRule}`,

            `Tu es un animateur radio qui passe de la musique à un segment d'actualités. ` +
            `L'émission de nouvelles s'appelle ${showName}. ` +
            (rssContext ? `${rssContext} ` : '') +
            `Dis quelque chose comme "l'heure de faire le point sur l'actualité" ou "voyons ce qui se passe dans le monde". ` +
            `Mentionne le nom de l'émission. Ne mentionne jamais de dates, d'heures ou de numéros d'épisode. ${noSongRule}`,
          );
        } else if (isDateDump) {
          prompt = lp(
            `You're a radio host transitioning from music to a podcast segment. ` +
            `The show is called ${showName}. ` +
            (rssContext ? `${rssContext} ` : '') +
            `Introduce it naturally using only the show name, do not mention the episode title at all. ` +
            `Keep it smooth and conversational. ${noSongRule}`,

            `Du bist ein Radiosprecher der von Musik zu einem Podcast-Segment übergeht. ` +
            `Die Sendung heißt ${showName}. ` +
            (rssContext ? `${rssContext} ` : '') +
            `Führe die Sendung natürlich ein, nur mit dem Namen — den Episodentitel gar nicht erwähnen. ` +
            `Bleib flüssig und gesprächig. ${noSongRule}`,

            `Tu es un animateur radio qui passe de la musique à un segment podcast. ` +
            `L'émission s'appelle ${showName}. ` +
            (rssContext ? `${rssContext} ` : '') +
            `Présente-la naturellement en utilisant uniquement le nom de l'émission, sans mentionner le titre de l'épisode. ` +
            `Reste fluide et conversationnel. ${noSongRule}`,
          );
        } else {
          prompt = lp(
            `You're a radio host transitioning from music to a podcast segment. ` +
            `Show: ${showName}. Episode: ${episodeTitle}. ` +
            (rssContext ? `${rssContext} ` : '') +
            `Give a warm, natural on-air introduction — like "let's check in on ${showName}" or "time for some ${showName}". ` +
            `Use the show name primarily. Only mention the episode title if it is genuinely descriptive and adds real value. ` +
            `Never mention dates, times, or episode numbers. ${noSongRule}`,

            `Du bist ein Radiosprecher der zu einem Podcast-Segment übergeht. ` +
            `Sendung: ${showName}. Episode: ${episodeTitle}. ` +
            (rssContext ? `${rssContext} ` : '') +
            `Gib eine warme, natürliche On-Air-Einführung — wie "Schauen wir bei ${showName} rein" oder "Zeit für ${showName}". ` +
            `Nutze vor allem den Sendungsnamen. Erwähne den Episodentitel nur wenn er wirklich beschreibend ist und echten Mehrwert hat. ` +
            `Niemals Datum, Uhrzeit oder Episodennummern. ${noSongRule}`,

            `Tu es un animateur radio qui passe à un segment podcast. ` +
            `Émission : ${showName}. Épisode : ${episodeTitle}. ` +
            (rssContext ? `${rssContext} ` : '') +
            `Donne une introduction chaleureuse et naturelle — comme "on jette un œil à ${showName}" ou "l'heure de ${showName}". ` +
            `Utilise principalement le nom de l'émission. Ne mentionne le titre de l'épisode que s'il est vraiment descriptif et apporte une vraie valeur. ` +
            `Jamais de dates, d'heures ou de numéros d'épisode. ${noSongRule}`,
          );
        }
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
        prompt = lp(
          `You're a radio host introducing a news segment. ` +
          `The show is ${episode.feedTitle}. ` +
          (rssContext ? `${rssContext} ` : '') +
          `Say something like time for the news or let's check in with the latest headlines. ` +
          `Mention the show name. Never read out dates, times, or timestamps.`,

          `Du bist ein Radiosprecher der ein Nachrichtensegment einführt. ` +
          `Die Sendung ist ${episode.feedTitle}. ` +
          (rssContext ? `${rssContext} ` : '') +
          `Sage etwas wie "Zeit für die Nachrichten" oder "Schauen wir auf die aktuellen Schlagzeilen". ` +
          `Erwähne den Sendungsnamen. Niemals Datum, Uhrzeit oder Zeitstempel vorlesen.`,

          `Tu es un animateur radio qui présente un segment d'actualités. ` +
          `L'émission est ${episode.feedTitle}. ` +
          (rssContext ? `${rssContext} ` : '') +
          `Dis quelque chose comme "l'heure des informations" ou "faisons le point sur les dernières nouvelles". ` +
          `Mentionne le nom de l'émission. Ne lis jamais de dates, d'heures ou d'horodatages.`,
        );
      } else if (isDateDump) {
        prompt = lp(
          `You're a radio host introducing a podcast segment. ` +
          `Show: ${episode.feedTitle}. ` +
          (rssContext ? `${rssContext} ` : '') +
          `The episode title is just a date or time, ignore it completely. ` +
          `Introduce the show by name only. Sound warm and natural.`,

          `Du bist ein Radiosprecher der ein Podcast-Segment einführt. ` +
          `Sendung: ${episode.feedTitle}. ` +
          (rssContext ? `${rssContext} ` : '') +
          `Der Episodentitel ist nur ein Datum oder eine Uhrzeit — ignoriere ihn vollständig. ` +
          `Führe die Sendung nur mit dem Namen ein. Klingt warm und natürlich.`,

          `Tu es un animateur radio qui présente un segment podcast. ` +
          `Émission : ${episode.feedTitle}. ` +
          (rssContext ? `${rssContext} ` : '') +
          `Le titre de l'épisode est juste une date ou une heure — ignore-le complètement. ` +
          `Présente l'émission uniquement par son nom. Sois chaleureux et naturel.`,
        );
      } else {
        prompt = lp(
          `You're a radio host transitioning from music to a podcast segment. ` +
          `Show: ${episode.feedTitle}. Episode: ${episode.title}. ` +
          (rssContext ? `${rssContext} ` : '') +
          `Sound warm and natural. Do not say here's at the start. ` +
          `Refer to the show by name. Only use the episode title if it is genuinely descriptive. ` +
          `Never mention dates, times, or episode numbers.`,

          `Du bist ein Radiosprecher der von Musik zu einem Podcast-Segment übergeht. ` +
          `Sendung: ${episode.feedTitle}. Episode: ${episode.title}. ` +
          (rssContext ? `${rssContext} ` : '') +
          `Klingt warm und natürlich. Beginne nicht mit Hier ist. ` +
          `Beziehe dich auf die Sendung beim Namen. Nutze den Episodentitel nur wenn er wirklich beschreibend ist. ` +
          `Niemals Datum, Uhrzeit oder Episodennummern erwähnen.`,

          `Tu es un animateur radio qui passe de la musique à un segment podcast. ` +
          `Émission : ${episode.feedTitle}. Épisode : ${episode.title}. ` +
          (rssContext ? `${rssContext} ` : '') +
          `Sois chaleureux et naturel. Ne commence pas par Voici. ` +
          `Réfère-toi à l'émission par son nom. N'utilise le titre de l'épisode que s'il est vraiment descriptif. ` +
          `Ne mentionne jamais de dates, d'heures ou de numéros d'épisode.`,
        );
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
      const prompt = lp(
        `You're a radio host returning from a music break back to a podcast. ` +
        `Podcast: ${podcastTitle}. This is part ${partNumber} of the episode. ` +
        `Say something warm and brief, 1 sentence, like And we're back, here's part ${partNumber} of ${podcastTitle}. ` +
        `Vary the phrasing. Sound natural, not scripted.`,

        `Du bist ein Radiosprecher der nach einer Musikpause zum Podcast zurückkehrt. ` +
        `Podcast: ${podcastTitle}. Das ist Teil ${partNumber} der Episode. ` +
        `Sage etwas Warmes und Kurzes, 1 Satz, wie "Und wir sind zurück — hier ist Teil ${partNumber} von ${podcastTitle}". ` +
        `Variiere die Formulierung. Klingt natürlich, nicht abgelesen.`,

        `Tu es un animateur radio qui revient d'une pause musicale au podcast. ` +
        `Podcast : ${podcastTitle}. C'est la partie ${partNumber} de l'épisode. ` +
        `Dis quelque chose de chaleureux et bref, 1 phrase, comme "Et nous voilà de retour — voici la partie ${partNumber} de ${podcastTitle}". ` +
        `Varie la formulation. Sois naturel, pas récité.`,
      );
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

      const prompt = lp(
        `You're a radio host transitioning back from a podcast segment to music. ` +
        `The podcast was from ${podcastRef}. ` +
        `Now going back to music, next up: ${nextTrack.artist} with ${cleanNextTitle}. ` +
        `Keep it to 1 to 2 sentences. Sound natural. Do not mention dates or episode titles.`,

        `Du bist ein Radiosprecher der vom Podcast-Segment zurück zur Musik übergeht. ` +
        `Der Podcast war von ${podcastRef}. ` +
        `Jetzt zurück zur Musik — als nächstes: ${nextTrack.artist} mit ${cleanNextTitle}. ` +
        `1 bis 2 Sätze. Klingt natürlich. Kein Datum, keine Episodentitel erwähnen.`,

        `Tu es un animateur radio qui passe du segment podcast à la musique. ` +
        `Le podcast venait de ${podcastRef}. ` +
        `Retour à la musique — prochain morceau : ${nextTrack.artist} avec ${cleanNextTitle}. ` +
        `1 à 2 phrases. Sois naturel. Ne mentionne pas de dates ni de titres d'épisode.`,
      );

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
      const aiScript = await generateScript(lp(
        `You are a radio host. The listener just skipped the current track. ` +
        `Say something very brief (one short sentence) acknowledging the skip ` +
        `and introducing the next item: ${nextLabel}. ` +
        `Sound natural and unbothered, not apologetic. No stage directions.`,

        `Du bist ein Radiosprecher. Der Hörer hat gerade den aktuellen Track übersprungen. ` +
        `Sage etwas sehr Kurzes (ein kurzer Satz) der den Skip bestätigt ` +
        `und das nächste Element ankündigt: ${nextLabel}. ` +
        `Klingt natürlich und entspannt, nicht entschuldigend. Keine Regieanweisungen.`,

        `Tu es un animateur radio. L'auditeur vient de passer le morceau en cours. ` +
        `Dis quelque chose de très bref (une courte phrase) qui reconnaît le saut ` +
        `et présente l'élément suivant : ${nextLabel}. ` +
        `Sois naturel et détendu, pas apologétique. Pas de didascalies.`,
      ));
      await sayScript(aiScript ?? fallbackSkipTransition(nextLabel));
    },
    [sayScript],
  );

  const speakTechnicalDifficulty = useCallback(async (): Promise<void> => {
    const aiScript = await resolveScript(lp(
      'A podcast episode failed to load due to a technical error. ' +
      'Say one short, casual sentence letting the listener know and that you\'re switching back to music. ' +
      'Sound unbothered. No stage directions.',

      'Eine Podcast-Folge konnte wegen eines technischen Fehlers nicht geladen werden. ' +
      'Sage einen kurzen, lockeren Satz der den Hörer informiert und ankündigt dass es mit Musik weitergeht. ' +
      'Klingt entspannt. Keine Regieanweisungen.',

      'Un épisode de podcast n\'a pas pu se charger suite à une erreur technique. ' +
      'Dis une courte phrase décontractée pour informer l\'auditeur et annoncer qu\'on reprend la musique. ' +
      'Sois détendu. Pas de didascalies.',
    ));
    await sayScript(aiScript ?? fallbackTechnicalDifficulty());
  }, [resolveScript, sayScript]);

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
    speakTechnicalDifficulty,
    setMemoryContext,
    stop,
    isSpeaking,
    isGenerating,
    currentScript: currentScriptRef.current,
    error,
    // Parallel pre-generation API
    generateGreetingAudio,
    generateTrackIntroAudio,
    generatePodcastTransitionAudio,
    generateCommentaryAudio,
    playAudio,
  };
}
