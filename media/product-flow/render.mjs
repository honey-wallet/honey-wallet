// Deterministic renderer: loads a page that exposes window.seek(t), paints every
// frame headless, pipes it to ffmpeg. The page owns time; nothing here animates.
//
//   node render.mjs [film.html] [--out out.mp4] [--fps 30] [--w 1920 --h 1080]
//                   [--duration 15] [--audio score.wav] [--scale 0.5]
//                   [--sub 4]                subframes per frame, blended for motion blur
//                   [--contact beats.json]   one frame per beat → contact.jpg
//                   [--at 0,1.5,3]           contact sheet of these exact times instead
//                   [--still 4.2]            one full-size frame
//                   [--text copy.json]       visible on-screen text over time (for jev.mjs copy)
//                   [--from 3 --to 6]        render only part of the film (re-render a fixed section)
// The page may set window.CUTS = [seconds...]: hard cuts never get motion-blurred across.
//
// Pages are served over http from this folder (fetch() and decode() don't work on file://).
//
// Audio is loudness-normalised to -14 LUFS in two passes (measure, then linear gain).
//
// The page may set window.DURATION (seconds) and window.SIZE = [w, h].
// It is loaded with ?render=1 so it can disable any preview-only RAF loop.
const { chromium } = await import(process.env.HONEY_PLAYWRIGHT_MODULE || 'playwright');

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const flag = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i < 0 ? d : argv[i + 1];
};
const input = resolve(
  argv.find((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--')) ?? 'index.html',
);
const fps = +flag('fps', 30);
const sub = +flag('sub', 1);
const scale = +flag('scale', 1);
const contact = flag('contact');
const audio = flag('audio');
const at = flag('at')?.split(',').map(Number);
const out = flag('out', contact || at ? 'contact.jpg' : 'out.mp4');

// Static server rooted at the studio, so films can fetch() their data and assets.
const ROOT = dirname(fileURLToPath(import.meta.url));
const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.css': 'text/css',
  '.glb': 'model/gltf-binary',
  '.hdr': 'application/octet-stream',
};
const server = createServer((req, res) => {
  const file = resolve(ROOT, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname));
  try {
    if (!file.startsWith(ROOT + sep) || !statSync(file).isFile()) throw 0;
    const type = TYPES[extname(file)] ?? 'application/octet-stream',
      data = readFileSync(file);
    // byte ranges, so films can seek <video> elements (Chrome won't seek without them)
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (range) {
      const start = range[1] ? +range[1] : data.length - +range[2],
        end = range[1] && range[2] ? +range[2] : data.length - 1;
      res.writeHead(206, {
        'content-type': type,
        'accept-ranges': 'bytes',
        'content-range': `bytes ${start}-${end}/${data.length}`,
        'content-length': end - start + 1,
      });
      return res.end(data.subarray(start, end + 1));
    }
    res.writeHead(200, {
      'content-type': type,
      'accept-ranges': 'bytes',
      'content-length': data.length,
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const inside = input.startsWith(ROOT + sep);
const url = inside
  ? `http://127.0.0.1:${server.address().port}/${relative(ROOT, input).split(sep).join('/')}`
  : pathToFileURL(input).href;

// GPU WebGL (Metal on macOS) for three.js films; without these flags headless falls back to SwiftShader.
const browser = await chromium.launch({
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('page error:', e.message));
await page.goto(url + '?render=1');
await page.waitForFunction(() => typeof window.seek === 'function');
await page.evaluate(() => document.fonts.ready);
const meta = await page.evaluate(() => ({ d: window.DURATION, s: window.SIZE }));
const w = +flag('w', meta.s?.[0] ?? 1920),
  h = +flag('h', meta.s?.[1] ?? 1080);
const duration = +flag('duration', meta.d ?? 10);
await page.setViewportSize({ width: w, height: h });

const t0 = +flag('from', 0),
  t1 = +flag('to', duration);
const times =
  at ??
  (contact
    ? JSON.parse(readFileSync(contact, 'utf8')).beats.filter((t) => t < duration)
    : Array.from({ length: Math.round((t1 - t0) * fps * sub) }, (_, i) => t0 + i / (fps * sub)));

// Hard cuts (window.CUTS, seconds) must never blend: if a frame's subframes straddle a cut, they all
// move to the side holding most of them, so motion blur never mixes two shots into one grey frame.
if (!contact && !at && sub > 1) {
  const cuts = await page.evaluate(() => window.CUTS ?? []);
  for (let k = 0; k + sub <= times.length; k += sub) {
    const a = times[k],
      b = times[k + sub - 1];
    for (const c of cuts)
      if (a < c && c <= b) {
        const after = times.slice(k, k + sub).filter((x) => x >= c).length;
        for (let j = k; j < k + sub; j++)
          times[j] = after * 2 >= sub ? Math.max(times[j], c) : Math.min(times[j], c - 1e-4);
      }
  }
}

// --text copy.json [--step 0.25]: every line of DOM text that is actually visible (opacity, viewport, and
// overflow masks all checked), sampled through the film, merged into [{text, from, to}]. Text baked into
// images or canvas is not seen. Feed it to `node jev.mjs copy` for claim and copy checks.
const textOut = flag('text');
if (textOut != null) {
  const step = +flag('step', 0.25),
    seen = new Map();
  for (let t = t0; t < t1; t += step) {
    await page.evaluate((t) => window.seek(t), t);
    const lines = await page.evaluate(() => {
      const W = innerWidth,
        H = innerHeight,
        words = [];
      const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const txt = n.textContent.replace(/\s+/g, ' ').trim();
        if (!txt) continue;
        const el = n.parentElement;
        if (!el || el.closest('script,style')) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        const r = range.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        let x0 = r.left,
          y0 = r.top,
          x1 = r.right,
          y1 = r.bottom,
          op = 1,
          ok = true;
        for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
          const cs = getComputedStyle(e);
          if (cs.display === 'none' || cs.visibility === 'hidden') {
            ok = false;
            break;
          }
          op *= +cs.opacity;
          if (cs.overflow !== 'visible' || cs.clipPath !== 'none') {
            const c = e.getBoundingClientRect();
            x0 = Math.max(x0, c.left);
            y0 = Math.max(y0, c.top);
            x1 = Math.min(x1, c.right);
            y1 = Math.min(y1, c.bottom);
          }
        }
        x0 = Math.max(x0, 0);
        y0 = Math.max(y0, 0);
        x1 = Math.min(x1, W);
        y1 = Math.min(y1, H);
        const vis = (Math.max(0, x1 - x0) * Math.max(0, y1 - y0)) / (r.width * r.height);
        if (ok && op > 0.2 && vis > 0.5)
          words.push({ txt, x: r.left, y: (r.top + r.bottom) / 2, h: r.height });
      }
      words.sort((a, b) => a.y - b.y || a.x - b.x);
      const rows = [];
      for (const w of words) {
        const row = rows.find((r) => Math.abs(r.y - w.y) < Math.min(r.h, w.h) * 0.45);
        row ? row.w.push(w) : rows.push({ y: w.y, h: w.h, w: [w] });
      }
      return rows.map((r) =>
        r.w
          .sort((a, b) => a.x - b.x)
          .map((w) => w.txt)
          .join(' ')
          .replace(/\s+([.,!?])/g, '$1'),
      );
    });
    for (const l of lines) {
      const e = seen.get(l);
      if (e) e.to = +(t + step).toFixed(2);
      else seen.set(l, { text: l, from: +t.toFixed(2), to: +(t + step).toFixed(2) });
    }
  }
  const { writeFileSync } = await import('node:fs');
  writeFileSync(textOut, JSON.stringify([...seen.values()], null, 1));
  await browser.close();
  server.close();
  console.log(`${seen.size} lines → ${textOut}`);
  process.exit(0);
}

// --still 4.2: one full-size frame (png/jpg by extension) for close inspection.
const still = flag('still');
if (still != null) {
  await page.evaluate((t) => window.seek(t), +still);
  await page.screenshot({
    path: out.endsWith('.mp4') ? out.replace(/\.mp4$/, '.png') : out,
    type: out.endsWith('.jpg') ? 'jpeg' : 'png',
  });
  await browser.close();
  server.close();
  console.log(`still ${still}s → ${out}`);
  process.exit(0);
}

if (contact || at) {
  // Contact sheet is laid out in the browser: one tile per beat, labelled with its time.
  const tiles = [];
  for (const t of times) {
    await page.evaluate((t) => window.seek(t), t);
    tiles.push([t, (await page.screenshot({ type: 'jpeg', quality: 80 })).toString('base64')]);
  }
  const tw = h > w ? 240 : 400;
  await page.setViewportSize({ width: 6 * (tw + 6) + 6, height: 100 });
  await page.setContent(
    `<body style="margin:0;padding:6px;background:#000;display:grid;grid-template-columns:repeat(6,${tw}px);gap:6px;font:12px ui-monospace,monospace;color:#fff">${tiles
      .map(
        ([t, b], i) =>
          `<figure style="margin:0;position:relative"><img style="width:100%;display:block" src="data:image/jpeg;base64,${b}"><figcaption style="position:absolute;left:4px;top:4px;background:#000a;padding:1px 4px">${i + 1} · ${t.toFixed(2)}s</figcaption></figure>`,
      )
      .join('')}</body>`,
  );
  await page.screenshot({ path: out, fullPage: true, type: out.endsWith('.png') ? 'png' : 'jpeg' });
  await browser.close();
  server.close();
  console.log(`${times.length} frames → ${out}`);
  process.exit(0);
}

// tmix averages each group of `sub` subframes; select keeps one output per group.
const blur =
  sub > 1 ? `tmix=frames=${sub},select='eq(mod(n\\,${sub})\\,${sub - 1})',setpts=N/${fps}/TB,` : '';
const vf = [
  '-r',
  String(fps),
  '-vf',
  `${blur}scale=${Math.round((w * scale) / 2) * 2}:-2`,
  '-c:v',
  'libx264',
  '-crf',
  '16',
  '-preset',
  'slow',
  '-pix_fmt',
  'yuv420p',
  '-movflags',
  '+faststart',
];
const LN = 'loudnorm=I=-14:TP=-1:LRA=11';
const measure = (f) =>
  JSON.parse(
    /\{[^{}]*"input_i"[^{}]*\}/.exec(
      spawnSync(
        'ffmpeg',
        ['-hide_banner', '-i', f, '-af', `${LN}:print_format=json`, '-f', 'null', '-'],
        { encoding: 'utf8' },
      ).stderr,
    )[0],
  );
const m = audio && measure(audio);
const aud = audio
  ? [
      '-i',
      audio,
      '-map',
      '0:v',
      '-map',
      '1:a',
      '-af',
      `${LN}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:` +
        `measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`,
      '-ar',
      '48000',
      '-c:a',
      'aac',
      '-b:a',
      '320k',
      '-shortest',
    ]
  : [];
const ff = spawn(
  'ffmpeg',
  [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'image2pipe',
    '-framerate',
    String(fps * sub),
    '-i',
    '-',
    ...aud,
    ...vf,
    out,
  ],
  { stdio: ['pipe', 'inherit', 'inherit'] },
);
// If ffmpeg dies mid-render, stop instead of waiting forever on a full pipe.
const died = new Promise((_, j) => ff.on('exit', (c) => c && j(new Error(`ffmpeg exit ${c}`))));
died.catch(async (e) => {
  console.error(`\n${e.message}`);
  await browser.close();
  server.close();
  process.exit(1);
});
ff.stdin.on('error', () => {});

for (const [i, t] of times.entries()) {
  await page.evaluate((t) => window.seek(t), t);
  const png = await page.screenshot({ type: 'png' });
  if (!ff.stdin.write(png))
    await Promise.race([new Promise((r) => ff.stdin.once('drain', r)), died]);
  if (i % (fps * sub) === 0) process.stdout.write(`\r${i + 1}/${times.length}`);
}
ff.stdin.end();
await new Promise((r, j) => ff.on('close', (c) => (c ? j(new Error(`ffmpeg exit ${c}`)) : r())));
await browser.close();
server.close();
console.log(`\r${times.length} frames → ${out}`);
