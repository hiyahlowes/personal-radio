#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const port = Number(process.env.PORT || 8899);
const host = process.env.HOST || '0.0.0.0';

// Load a simple KEY=VALUE .env file without printing secrets.
try {
  const env = await fs.readFile(path.join(root, '.env'), 'utf8');
  for (const line of env.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const [key, ...rest] = trimmed.split('=');
    if (!process.env[key]) process.env[key] = rest.join('=').trim().replace(/^['"]|['"]$/g, '');
  }
} catch {}

const { handler: podcastProxy } = await import(pathToFileURL(path.join(root, 'netlify/functions/podcast-proxy.mjs')).href);
const { handler: wavlakeCharts } = await import(pathToFileURL(path.join(root, 'netlify/functions/wavlake-charts.mjs')).href);
const { handler: wavlakePay } = await import(pathToFileURL(path.join(root, 'netlify/functions/wavlake-pay.mjs')).href);
const { default: claudeProxy } = await import(pathToFileURL(path.join(root, 'netlify/functions/claude-proxy.mjs')).href);

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

function send(res, status, headers, body = '') {
  res.writeHead(status, headers);
  res.end(body);
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleNetlifyHandler(handler, req, res, url) {
  const body = await collectBody(req);
  const event = {
    httpMethod: req.method,
    path: url.pathname,
    headers: req.headers,
    rawUrl: `http://localhost:${port}${req.url}`,
    queryStringParameters: Object.fromEntries(url.searchParams.entries()),
    body: body.length ? body.toString('utf8') : null,
    isBase64Encoded: false,
  };
  const out = await handler(event);
  const headers = out.headers || {};
  const responseBody = out.isBase64Encoded ? Buffer.from(out.body || '', 'base64') : (out.body || '');
  send(res, out.statusCode || 200, headers, responseBody);
}

async function handlePodcastProxy(req, res, url) {
  return handleNetlifyHandler(podcastProxy, req, res, url);
}

async function handleClaudeProxy(req, res) {
  const body = await collectBody(req);
  const request = new Request(`http://localhost:${port}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: ['GET', 'HEAD'].includes(req.method || '') ? undefined : body,
  });
  const out = await claudeProxy(request);
  const headers = Object.fromEntries(out.headers.entries());
  const responseBody = Buffer.from(await out.arrayBuffer());
  send(res, out.status, headers, responseBody);
}

async function handlePodcastStream(req, res, url) {
  const target = url.searchParams.get('url');
  if (!target || !/^https?:\/\//i.test(target)) {
    return send(res, 400, { 'content-type': 'application/json' }, JSON.stringify({ error: 'Missing or invalid url' }));
  }
  const headers = { 'User-Agent': 'PersonalRadio/1.0 (local stream)' };
  if (req.headers.range) headers.Range = req.headers.range;
  const upstream = await fetch(target, { headers, redirect: 'follow' });
  const outHeaders = {
    'access-control-allow-origin': '*',
    'content-type': upstream.headers.get('content-type') || 'audio/mpeg',
    'accept-ranges': upstream.headers.get('accept-ranges') || 'bytes',
  };
  for (const h of ['content-length', 'content-range', 'cache-control']) {
    const v = upstream.headers.get(h);
    if (v) outHeaders[h] = v;
  }
  res.writeHead(upstream.status, outHeaders);
  if (upstream.body) {
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  }
  res.end();
}

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  let file = path.normalize(path.join(dist, rel));
  if (!file.startsWith(dist)) return send(res, 403, { 'content-type': 'text/plain' }, 'Forbidden');
  if (!existsSync(file)) file = path.join(dist, 'index.html');
  const ext = path.extname(file);
  res.writeHead(200, { 'content-type': mime[ext] || 'application/octet-stream' });
  createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://localhost:${port}`);
    if (url.pathname === '/health') return send(res, 200, { 'content-type': 'application/json' }, JSON.stringify({ ok: true }));
    if (url.pathname === '/.netlify/functions/podcast-proxy') return await handlePodcastProxy(req, res, url);
    if (url.pathname === '/.netlify/functions/wavlake-charts') return await handleNetlifyHandler(wavlakeCharts, req, res, url);
    if (url.pathname === '/.netlify/functions/wavlake-pay') return await handleNetlifyHandler(wavlakePay, req, res, url);
    if (url.pathname === '/.netlify/functions/claude-proxy') return await handleClaudeProxy(req, res);
    if (url.pathname === '/podcast-stream') return await handlePodcastStream(req, res, url);
    return await serveStatic(req, res, url);
  } catch (err) {
    console.error('[via-radio-server]', err);
    return send(res, 500, { 'content-type': 'application/json' }, JSON.stringify({ error: String(err?.message || err) }));
  }
});

server.listen(port, host, () => {
  console.log(`[via-radio-server] listening on http://${host}:${port}`);
});
