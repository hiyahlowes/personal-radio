#!/usr/bin/env node
import http from 'node:http';
import { spawn } from 'node:child_process';
import process from 'node:process';

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8910);
const BITRATE = process.env.STREAM_BITRATE || '128k';
const WAVLAKE_BASE = 'https://catalog.wavlake.com/v1';
const PODCAST_FEED_URL = process.env.PODCAST_FEED_URL || 'https://feeds.fountain.fm/UZSKQcrOnhqYS1JopxGg';
let podcastAfterSongs = Number(process.env.PODCAST_AFTER_SONGS || 2);

const TOP_40_IDS = [
  '4d3443ba-4ec9-41a7-bf0a-78dc35896aa4',
  '1b4df345-2f99-425d-9ed4-23102bbce147',
  '1c500b27-d0c0-4e67-abb9-c0eecda5af53',
  '47aab0a2-1cc0-46ac-b569-053dc90ee286',
  'dac15380-8384-4b8d-9074-ff06c99f6813',
  '8fe63588-86f4-4ac8-aff4-4c9e0b88a164',
  '565c5057-4809-4e75-a4e7-faf6daa08e58',
  'e33d0f0b-76ed-493e-9801-433e7649d2d0',
  'ecad286b-e9d0-485e-b63c-28b9caebaeb0',
  'ab1af6c6-8ff5-4317-8497-9699341f30de',
  '8df3f2f2-998a-4f8a-acef-650aa3eee538',
  '8dd2d1a8-1658-49e2-a74a-e720e252b080',
  '06335d63-0667-4bd8-8a20-636434d1d379',
  'a76b684b-994a-4eba-8f5f-eccddd473ced',
  '4e6eb303-ce33-416d-afea-e10291b03901',
  'a27e6d74-f53a-4eca-acb4-aa20ad97e0dd',
  '5c33d104-67fb-4750-9dd6-5a66974860ba',
  'db8c251d-5982-448c-b30d-8194d7021791',
  'b5735454-89f6-4860-946a-9b86bd1d2188',
  'a6094897-0a5c-49e3-b72b-08ba6bcb4f4d',
];

const clients = new Set();
let currentTrack = null;
let ffmpeg = null;
let playOrder = [];
let startedAt = null;
let bytesSent = 0;
let restarting = false;
let songsSincePodcast = 0;

function shuffle(xs) {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function fetchTrack(id) {
  const res = await fetch(`${WAVLAKE_BASE}/tracks/${id}`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Wavlake ${id}: ${res.status}`);
  const data = (await res.json()).data;
  if (!data?.liveUrl) throw new Error(`Wavlake ${id}: missing liveUrl`);
  return {
    id: data.id,
    title: data.title,
    artist: data.artist,
    albumTitle: data.albumTitle || '',
    liveUrl: data.liveUrl,
    duration: data.duration || 0,
  };
}


function decodeXml(s = '') {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

async function fetchLatestPodcastEpisode() {
  const res = await fetch(PODCAST_FEED_URL, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`podcast feed ${res.status}`);
  const xml = await res.text();
  const item = xml.match(/<item\b[\s\S]*?<\/item>/i)?.[0];
  if (!item) throw new Error('podcast feed: no item');
  const enclosure = item.match(/<enclosure\b[^>]*url=["']([^"']+)["'][^>]*>/i)?.[1]
    || item.match(/<media:content\b[^>]*url=["']([^"']+)["'][^>]*>/i)?.[1];
  if (!enclosure) throw new Error('podcast feed: no enclosure url');
  const title = decodeXml(item.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || 'Podcast');
  const feedTitle = decodeXml(xml.match(/<channel[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || 'Podcast');
  return { id: enclosure, title, artist: feedTitle, albumTitle: feedTitle, liveUrl: decodeXml(enclosure), duration: 0, kind: 'podcast' };
}

function nextId() {
  if (playOrder.length === 0) playOrder = shuffle(TOP_40_IDS);
  return playOrder.shift();
}

function broadcast(chunk) {
  bytesSent += chunk.length;
  for (const res of [...clients]) {
    if (res.destroyed || res.writableEnded) {
      clients.delete(res);
      continue;
    }
    const ok = res.write(chunk);
    if (!ok) {
      // Let Node buffer a little; slow clients are ordinary phones, not a crisis.
    }
  }
}

async function startNextTrack() {
  if (restarting) return;
  restarting = true;
  try {
    if (ffmpeg && !ffmpeg.killed) ffmpeg.kill('SIGTERM');
    ffmpeg = null;

    const shouldPlayPodcast = Number.isFinite(podcastAfterSongs) && songsSincePodcast >= podcastAfterSongs;
    let track = null;
    if (shouldPlayPodcast) {
      try {
        track = await fetchLatestPodcastEpisode();
        songsSincePodcast = 0;
      } catch (err) {
        console.warn('[stream] fetch podcast failed:', err?.message || err);
      }
    }
    if (!track) {
      for (let attempt = 0; attempt < TOP_40_IDS.length; attempt++) {
        try {
          track = await fetchTrack(nextId());
          track.kind = 'music';
          songsSincePodcast++;
          break;
        } catch (err) {
          console.warn('[stream] fetch track failed:', err?.message || err);
        }
      }
    }
    if (!track) throw new Error('no playable Wavlake track found');

    currentTrack = track;
    startedAt = new Date().toISOString();
    console.log(`[stream] PLAY ${track.kind || 'music'} ${track.artist} — ${track.title}`);

    ffmpeg = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'warning',
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
      '-re',
      '-i', track.liveUrl,
      '-vn',
      '-acodec', 'libmp3lame',
      '-b:a', BITRATE,
      '-ar', '44100',
      '-ac', '2',
      '-f', 'mp3',
      'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    ffmpeg.stdout.on('data', broadcast);
    ffmpeg.stderr.on('data', d => {
      const s = d.toString().trim();
      if (s) console.warn('[ffmpeg]', s);
    });
    ffmpeg.on('close', (code, signal) => {
      console.log(`[stream] DONE ${track.artist} — ${track.title} code=${code} signal=${signal || ''}`);
      ffmpeg = null;
      setTimeout(() => startNextTrack().catch(err => console.error('[stream] restart failed:', err)), 500);
    });
  } finally {
    restarting = false;
  }
}

function status() {
  return {
    ok: true,
    mount: '/live.mp3',
    clients: clients.size,
    currentTrack,
    startedAt,
    bytesSent,
    ffmpegPid: ffmpeg?.pid || null,
    songsSincePodcast,
    podcastAfterSongs,
    podcastFeed: PODCAST_FEED_URL,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/health' || url.pathname === '/status') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(status(), null, 2));
    return;
  }

  if (url.pathname === '/skip') {
    res.writeHead(202, { 'content-type': 'application/json; charset=utf-8' });
    const skipped = currentTrack;
    if (ffmpeg && !ffmpeg.killed) ffmpeg.kill('SIGTERM');
    res.end(JSON.stringify({ ok: true, skipped }));
    return;
  }


  if (url.pathname === '/after') {
    const songs = Number(url.searchParams.get('songs') || 2);
    podcastAfterSongs = Number.isFinite(songs) ? Math.max(0, songs) : 2;
    // If a song is already playing, count it as the first song in "after N songs".
    songsSincePodcast = currentTrack?.kind === 'music' ? 1 : 0;
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, podcastAfterSongs, podcastFeed: PODCAST_FEED_URL }));
    return;
  }

  if (url.pathname === '/' || url.pathname === '/live.mp3') {
    res.writeHead(200, {
      'content-type': 'audio/mpeg',
      'cache-control': 'no-cache, no-store, must-revalidate',
      'pragma': 'no-cache',
      'expires': '0',
      'connection': 'close',
      'icy-name': 'Via Personal Radio',
      'icy-genre': 'Personal Radio',
      'icy-pub': '0',
      'icy-br': BITRATE.replace('k', ''),
    });
    clients.add(res);
    console.log(`[stream] client connected (${clients.size}) from ${req.socket.remoteAddress}`);
    req.on('close', () => {
      clients.delete(res);
      console.log(`[stream] client disconnected (${clients.size})`);
    });
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found\n');
});

server.listen(PORT, HOST, () => {
  console.log(`[stream] listening on http://${HOST}:${PORT}/live.mp3`);
});

function scheduleStart(reason = 'retry') {
  startNextTrack().catch(err => {
    console.error(`[stream] ${reason} start failed:`, err);
    setTimeout(() => scheduleStart('retry'), 10_000);
  });
}

scheduleStart('initial');

process.on('SIGTERM', () => {
  console.log('[stream] SIGTERM');
  if (ffmpeg && !ffmpeg.killed) ffmpeg.kill('SIGTERM');
  for (const res of clients) res.end();
  server.close(() => process.exit(0));
});
