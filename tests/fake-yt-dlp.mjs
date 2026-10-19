#!/usr/bin/env node
/* A stand-in for yt-dlp, for the download service's tests: it answers the
   three ways the service runs yt-dlp (a lookup with -J, one stream to
   standard output, a download into a folder) for a few made-up links, and
   writes what it was asked to `calls.log` beside the job folders. */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
appendFileSync(join(process.cwd(), 'calls.log'), JSON.stringify(args) + '\n');

const video = { format_id: '137', url: 'https://cdn.example/137.mp4', ext: 'mp4', container: 'mp4_dash', protocol: 'https', vcodec: 'avc1.640028', acodec: 'none', width: 1920, height: 1080, filesize: 3000 };
const audio = { format_id: '140', url: 'https://cdn.example/140.m4a', ext: 'm4a', container: 'm4a_dash', protocol: 'https', vcodec: 'none', acodec: 'mp4a.40.2', filesize: 1000 };
const whole = { format_id: '18', url: 'https://cdn.example/18.mp4', ext: 'mp4', protocol: 'https', vcodec: 'avc1.42001E', acodec: 'mp4a.40.2', width: 640, height: 360, filesize: 2000,
  cookies: 'session=1; Domain=.cdn.example' };
const hls = { format_id: 'hls-720', url: 'https://cdn.example/720.m3u8', ext: 'mp4', protocol: 'm3u8_native', vcodec: 'avc1.4d401f', acodec: 'mp4a.40.2', height: 720 };
const base = { id: 'x1', title: 'A clip: "quoted" / slashed', extractor: 'example', extractor_key: 'Example', duration: 61 };

function info(link) {
  const path = new URL(link).pathname;
  if (path === '/two') return { ...base, requested_formats: [video, audio], formats: [video, audio] };
  if (path === '/one') return { ...base, ...whole, formats: [whole] };
  if (path === '/hls') return { ...base, ...hls, formats: [hls] };
  if (path === '/hls-locked') return { ...base, ...hls, http_headers: { Referer: 'https://video.example/' }, formats: [hls] };
  if (path === '/long') return { ...base, ...whole, duration: 4 * 3600 };
  if (path === '/live') return { ...base, ...whole, is_live: true };
  if (path === '/playlist') return { _type: 'playlist', entries: [{ ...base, title: 'first', ...whole }] };
  if (path === '/proxy') return { ...base, ...whole, title: value('--proxy') };
  return null;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

if (args.includes('-J')) {
  const link = args[args.length - 1];
  if (link.includes('/slow')) await sleep(3000);
  if (link.includes('/private')) { process.stderr.write('ERROR: [example] x1: This video is private\n'); process.exit(1); }
  const found = info(link);
  if (!found) { process.stderr.write(`ERROR: Unsupported URL: ${link}\n`); process.exit(1); }
  process.stdout.write(JSON.stringify(found));
} else if (value('-o') === '-') {
  const saved = JSON.parse(readFileSync(value('--load-info-json'), 'utf8'));
  const format = (saved.requested_formats || [saved]).find(f => f.format_id === value('-f'));
  if (!format) { process.stderr.write('ERROR: [example] x1: Requested format is not available\n'); process.exit(1); }
  process.stdout.write(Buffer.alloc(format.filesize, format.format_id));
  /* yt-dlp takes a moment to exit after its last byte. */
  await sleep(300);
} else if (args.includes('-P')) {
  const saved = JSON.parse(readFileSync(value('--load-info-json'), 'utf8'));
  const ext = args.includes('--audio-format') ? value('--audio-format') : saved.ext || 'mp4';
  process.stdout.write('[download] Destination: media.part\n[eyes] 500 1000 NA\n');
  await sleep(300);
  process.stdout.write('[eyes] 1000 1000 NA\n[eyes] processing\n');
  writeFileSync(join(value('-P'), 'media.' + ext), 'finished ' + ext);
}
