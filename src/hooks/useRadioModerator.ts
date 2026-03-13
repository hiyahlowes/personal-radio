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
  const templates = [
    `Up next — "${track.name}" by ${track.artist}. This one's a great listen.`,
    `Here's "${track.name}" from ${track.artist}. Enjoy.`,
    `Coming up — ${track.artist} with "${track.name}". Let it play.`,
    `Next on the playlist — "${track.name}" by ${track.artist}.`,
    `And now, from ${track.artist} — "${track.name}".`,
  ];
  // Pick deterministically based on track id to avoid randomness on re-render
  const idx = track.id.charCodeAt(0) % templates.length;
  return templates[idx];
}

function fallbackPodcastTransition(podcastTitle: string, hostName: string): string {
  const templates = [
    `Coming up — we're switching gears for a moment. ${hostName} joins us with "${podcastTitle}". Stay with us.`,
    `That's the music for now. Next up — "${podcastTitle}" with ${hostName}. Don't go anywhere.`,
    `And now for something a little different. ${hostName} is here with "${podcastTitle}". Take a listen.`,
  ];
  const idx = podcastTitle.charCodeAt(0) % templates.length;
  return templates[idx];
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
              'Speak exactly as you would on air: no stage directions, no quotation marks, no asterisks, ' +
              'no parenthetical notes. Just pure, natural radio speech. ' +
              'Keep it short — 2 to 3 sentences maximum. No emojis.',
          },
          { role: 'user', content: prompt },
        ],
        max_tokens: 100,
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
      const chartContext = isTopChart
        ? `This track is one of the top-earning songs on Wavlake, ranked by Bitcoin Lightning tips from listeners. Mention this naturally — something like it's a listener favourite or topping the Lightning charts. `
        : '';

      const prompt =
        `Introduce the next song on air. ` +
        `Song title: "${track.name}". Artist: "${track.artist}". ` +
        `Album: "${track.albumTitle || 'their latest work'}". ` +
        chartContext +
        `Sound like a natural radio DJ handing off to the track. Keep it to 1–2 sentences. ` +
        `Don't say "here's" at the start — vary your phrasing.`;

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
        .map(t => `"${t.name}" by ${t.artist}`)
        .join(' and then ');

      const chartContext = isNextTopChart
        ? `The next track is one of the top-earning songs on Wavlake, ranked by Bitcoin Lightning tips from listeners. Work that in naturally. `
        : '';

      const prompt =
        `You just played ${playedList} on air without commentary. ` +
        `Give a brief, warm reaction to that music — one sentence. ` +
        `Then introduce the next track: "${next.name}" by ${next.artist}. ` +
        chartContext +
        `Keep the whole thing to 2–3 sentences. Sound like a natural radio DJ, not a robot.`;

      const fallback = played.length > 1
        ? `Great music from ${played.map(t => t.artist).join(' and ')} — hope you enjoyed that. ` +
          `Coming up next — "${next.name}" by ${next.artist}.`
        : `That was "${played[0].name}" by ${played[0].artist}. ` +
          `Now let's keep it going — here's "${next.name}" by ${next.artist}.`;

      await buildAndSpeak(prompt, fallback);
    },
    [buildAndSpeak]
  );

  /**
   * Short transition bridge between a music segment and a podcast segment.
   */
  const speakPodcastTransition = useCallback(
    async (podcastTitle: string, hostName: string): Promise<void> => {
      const prompt =
        `You're transitioning from a music set to a podcast segment. ` +
        `Podcast title: "${podcastTitle}". Host: "${hostName}". ` +
        `Give a smooth, natural on-air handoff — 1–2 sentences. Make it feel seamless.`;

      await buildAndSpeak(
        prompt,
        fallbackPodcastTransition(podcastTitle, hostName)
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
      const prompt =
        `You're a radio host transitioning from music to a podcast segment. ` +
        `Introduce the following podcast episode on air: ` +
        `Show: "${episode.feedTitle}". Episode title: "${episode.title}". ` +
        `Brief description: "${episode.description.slice(0, 120)}". ` +
        `Sound warm and natural — 1 to 2 sentences. Don't say "here's" at the start.`;

      const fallback =
        `Coming up — a podcast episode for you. From ${episode.feedTitle}: "${episode.title}". ` +
        `Sit back and enjoy.`;

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
      const prompt =
        `You're a radio host transitioning back from a podcast segment to music. ` +
        `The podcast was "${episode.title}" from ${episode.feedTitle}. ` +
        `Now you're going back to music — next up: "${nextTrack.name}" by ${nextTrack.artist}. ` +
        `Keep it to 1–2 sentences. Sound natural.`;

      const fallback =
        `That was "${episode.title}" from ${episode.feedTitle}. ` +
        `Back to music now — here's ${nextTrack.artist} with "${nextTrack.name}".`;

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
