#!/usr/bin/env node
import { spawn } from 'node:child_process';
import process from 'node:process';

const WAVLAKE_BASE = 'https://catalog.wavlake.com/v1';
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

function shuffle(xs) {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function fetchTrack(id) {
  const res = await fetch(`${WAVLAKE_BASE}/tracks/${id}`);
  if (!res.ok) throw new Error(`Wavlake ${id}: ${res.status}`);
  const json = await res.json();
  const t = json.data;
  if (!t?.liveUrl) throw new Error(`Wavlake ${id}: no liveUrl`);
  return { id: t.id, title: t.title, artist: t.artist, liveUrl: t.liveUrl, duration: t.duration };
}

async function play(track) {
  console.log(`PLAY ${track.artist} — ${track.title}`);
  const child = spawn('ffplay', ['-nodisp', '-autoexit', '-loglevel', 'warning', track.liveUrl], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, PULSE_SINK: process.env.PULSE_SINK || 'via_pi2_deck_anlage' },
  });
  const code = await new Promise(resolve => child.on('close', resolve));
  console.log(`DONE ${track.artist} — ${track.title} exit=${code}`);
}

while (true) {
  for (const id of shuffle(TOP_40_IDS)) {
    try {
      const track = await fetchTrack(id);
      if (track.duration > 30 && track.duration <= 360) await play(track);
    } catch (err) {
      console.error(err?.message || err);
    }
  }
}
