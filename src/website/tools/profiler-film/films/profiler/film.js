// Implements [WEB-DESIGN-MEDIA]. The profiler film's timeline. renderFrame(t) sets every element from t alone
// and resolves once the frame's images are decoded, so render.mjs can step it.
// FILM_DATA (injected by render.mjs) carries each clip's frame count and the
// click cues capture.mjs recorded; SHOTS below are focus points in the
// 1600x1000 workbench the stills and clips were shot at.
'use strict';

const DATA = window.FILM_DATA;
const FPS = 30;
const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const ease = {
  linear: (p) => p,
  inOut: (p) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2),
  out: (p) => 1 - (1 - p) ** 3,
  expo: (p) => (p === 1 ? 1 : 1 - 2 ** (-10 * p)),
  back: (p) => 1 + 2.2 * (p - 1) ** 3 + 1.2 * (p - 1) ** 2,
};
const tween = (t, t0, t1, a, b, e = ease.inOut) => a + (b - a) * e(clamp((t - t0) / (t1 - t0), 0, 1));
const window01 = (t, t0, t1, fade = 0.4) => Math.min(tween(t, t0, t0 + fade, 0, 1), tween(t, t1 - fade, t1, 1, 0));

/** Scene boundaries, seconds. */
const S = { cold: 0, title: 3.6, cpu: 7.9, heat: 0, flame: 0, mem: 0, leaks: 0, montage: 0, end: 0, out: 0 };

/** Camera focus points in workbench CSS pixels: [cx, cy, zoom]. */
const SHOTS = {
  full: [800, 500, 1],
  live: [430, 720, 1.85],
  heat: [560, 370, 1.6],
  heatEnd: [560, 700, 1.6],
  results: [950, 400, 1.3],
  timeline: [1215, 560, 2.1],
  leakCode: [470, 330, 1.8],
  leaks: [1210, 640, 1.6],
};

/** Highlight boxes: [from, until, [x, y, w, h] in workbench CSS pixels]. */
const FOCUS = [
  [() => S.heat + 2.9, () => S.heat + 4.5, [182, 272, 612, 34]],
  [() => S.leaks + 1.4, () => S.leaks + 3.0, [588, 322, 236, 32]],
  [() => S.leaks + 3.9, () => S.montage - 0.3, [838, 372, 742, 78]],
];

// ── Clip time remapping: real time around each click, fast-forward between ──

/** Piecewise-linear map from scene time to clip time; `points` are [sceneT, clipT]. */
function remap(points, t) {
  const index = points.findIndex(([sceneT]) => sceneT > t);
  if (index === 0) return points[0][1];
  if (index < 0) return points.at(-1)[1];
  const [[s0, c0], [s1, c1]] = [points[index - 1], points[index]];
  return c0 + ((t - s0) / (s1 - s0)) * (c1 - c0);
}

/** Scene-time → clip-time knots for a clip: real time near cues, `fast`x elsewhere. */
function knots(clip, start, fast, tail) {
  const duration = clip.frames / FPS;
  const points = [[start, 0]];
  const advance = (clipT, rate) => {
    const [scene, at] = points.at(-1);
    if (clipT <= at) return;
    // A short gap plays in real time: a sub-second fast-forward only flickers the speed chip.
    const speed = clipT - at < 1.5 ? 1 : rate;
    points.push([scene + (clipT - at) / speed, clipT]);
  };
  for (const cue of clip.cues) {
    advance(cue.t - 1.6, fast);
    advance(Math.min(duration, cue.t + 2.4), 1);
  }
  advance(duration - tail, fast);
  advance(duration, 1);
  return points;
}

const CPU = knots(DATA.cpu, S.cpu + 0.9, 3, 3.2);
S.heat = CPU.at(-1)[0];
S.flame = S.heat + 6.2;
const MEM = knots(DATA.memory, S.flame + 6.6, 5, 1.5);
S.mem = S.flame + 6.4;
S.leaks = MEM.at(-1)[0];
S.montage = S.leaks + 6.4;
S.end = S.montage + 5.2;
S.out = S.end + 5;
window.FILM_DURATION = S.out;
window.FILM_SCENES = S;

/** The scene time at which a clip reaches `clipT` (the remap inverted). */
function sceneAt(points, clipT) {
  const i = Math.max(1, points.findIndex(([, c]) => c >= clipT));
  const [[s0, c0], [s1, c1]] = [points[i - 1], points[i]];
  return s0 + ((clipT - c0) / (c1 - c0 || 1)) * (s1 - s0);
}

/** Playback rate of the clip segment playing at scene time t (1 = real time). */
function rateAt(points, t) {
  const i = points.findIndex(([sceneT]) => sceneT > t);
  if (i <= 0) return 1;
  const [[s0, c0], [s1, c1]] = [points[i - 1], points[i]];
  return (c1 - c0) / (s1 - s0);
}

/** A clip's click cues with their scene time (`at`), inverted through the remap. */
function cuesOf(points, clip) {
  return clip.cues.map((cue) => {
    const i = points.findIndex(([, clipT]) => clipT >= cue.t);
    const [[s0, c0], [s1, c1]] = [points[Math.max(i - 1, 0)], points[Math.max(i, 1)]];
    return { ...cue, at: s0 + ((cue.t - c0) / (c1 - c0 || 1)) * (s1 - s0) };
  });
}
const CPU_CUES = cuesOf(CPU, DATA.cpu);
const MEM_CUES = cuesOf(MEM, DATA.memory);

// ── Image plumbing ──

const pending = [];
function show(img, src) {
  if (img.dataset.src === src) return;
  img.dataset.src = src;
  img.src = src;
  pending.push(img.decode().catch(() => undefined));
}
const clipFrame = (name, clipT) =>
  `../../out/film/${name}/${String(clamp(Math.round(clipT * FPS) + 1, 1, DATA[name].frames)).padStart(5, '0')}.jpg`;
const still = (name) => `../../out/stills/${name}.png`;

// ── Camera ──

const WIN = { left: 260, top: 166, width: 1400, height: 875 };
const BASE = WIN.width / 1600;

/** Blend two shots; clamps so the camera never shows past the workbench edge. */
function camera(a, b, p) {
  const [cx0, cy0, z0] = SHOTS[a];
  const [cx1, cy1, z1] = SHOTS[b];
  const zoom = z0 + (z1 - z0) * p;
  const halfW = 800 / zoom;
  const halfH = 500 / zoom;
  return {
    zoom,
    cx: clamp(cx0 + (cx1 - cx0) * p, halfW, 1600 - halfW),
    cy: clamp(cy0 + (cy1 - cy0) * p, halfH, 1000 - halfH),
  };
}

function applyCamera(cam) {
  const scale = cam.zoom * BASE;
  $('screen').style.transform =
    `translate(${WIN.width / 2 - cam.cx * scale}px, ${WIN.height / 2 - cam.cy * scale}px) scale(${scale})`;
}

/** One axis of `project`: the window's centre plus the scaled offset from the camera. */
const along = (start, size, value, focus, scale) => start + size / 2 + (value - focus) * scale;

/** Where a workbench point lands in the film frame under `cam`. */
const project = (cam, x, y) => ({
  x: along(WIN.left, WIN.width, x, cam.cx, cam.zoom * BASE),
  y: along(WIN.top, WIN.height, y, cam.cy, cam.zoom * BASE),
});

/** A camera path: list of [time, shot] keys, eased between consecutive keys. */
function cameraAt(t, path) {
  const next = path.findIndex(([time]) => time > t);
  if (next === 0) return camera(path[0][1], path[0][1], 0);
  if (next < 0) return camera(path.at(-1)[1], path.at(-1)[1], 0);
  const [[t0, a], [t1, b]] = [path[next - 1], path[next]];
  return camera(a, b, ease.inOut((t - t0) / (t1 - t0)));
}

// ── Scene: cold open + title ──

/** Eased 0→1 progress of a reveal that starts at `from` and lasts `length` seconds. */
const reveal = (t, from, length) => ease.out(clamp((t - from) / length, 0, 1));

/** Fade an element up into place: at `p` = 1 it rests, at 0 it sits `distance` px lower and clear. */
function rise(element, p, distance) {
  element.style.opacity = p;
  element.style.transform = `translateY(${(1 - p) * distance}px)`;
}

function coldOpen(t) {
  [...document.querySelectorAll('#coldLine span')].forEach((word, i) => {
    const p = reveal(t, 0.25 + i * 0.2, 0.5);
    rise(word, p, 42);
    word.style.filter = `blur(${(1 - p) * 12}px)`;
  });
  const slow = $('slow');
  slow.classList.toggle('hot', t > 1.45);
  slow.style.transform = `scale(${1 + 0.12 * Math.max(0, 1 - Math.abs(t - 1.55) * 5)})`;
  rise($('coldSub'), reveal(t, 1.9, 0.6), 22);
  const exit = tween(t, 3.1, S.title + 0.25, 0, 1);
  $('cold').style.opacity = 1 - exit;
  $('cold').style.transform = `scale(${1 + exit * 0.1})`;
  $('cold').style.filter = `blur(${exit * 10}px)`;
}

function titleCard(t) {
  const local = t - S.title;
  const exit = tween(t, S.cpu - 0.5, S.cpu + 0.3, 0, 1);
  const pop = ease.back(clamp(local / 0.75, 0, 1));
  $('title').style.opacity = local < 0 ? 0 : clamp(local / 0.25, 0, 1) * (1 - exit);
  $('title').style.transform = `scale(${1 - exit * 0.08})`;
  $('title').style.filter = `blur(${exit * 8}px)`;
  $('logo').style.transform = `scale(${0.35 + 0.65 * pop}) rotate(${(1 - pop) * -28}deg)`;
  rise(document.querySelector('#title .wordmark'), reveal(local, 0.35, 0.7), 36);
  document.querySelector('#title .profiler').style.backgroundPosition = `${tween(local, 0.4, 2.6, 100, 0)}% 0`;
  rise($('titleSub'), reveal(local, 1.1, 0.6), 20);
}

// ── Scene: the workbench window and what it shows ──

const SCREENS = [
  [() => S.cpu, (t) => clipFrame('cpu', remap(CPU, t))],
  [() => S.heat, () => still('profiler-heatmap')],
  [() => S.flame, () => still('profiler-results')],
  [() => S.mem, (t) => clipFrame('memory', remap(MEM, t))],
  [() => S.leaks, () => still('profiler-leaks')],
];

function screenContent(t) {
  const index = Math.max(0, SCREENS.findLastIndex(([start]) => start() <= t));
  const [start, current] = SCREENS[index];
  show($('frameA'), current(t));
  const fade = index > 0 ? 1 - ease.inOut(clamp((t - start()) / 0.6, 0, 1)) : 0;
  $('frameB').style.opacity = fade;
  if (fade > 0) show($('frameB'), SCREENS[index - 1][1](t));
}

function cameraPath() {
  const [profile, stop] = CPU_CUES;
  // The dashboard opens ~5s into the memory clip and the side bar folds by ~8s.
  const dashboard = sceneAt(MEM, 8);
  return [
    [S.cpu, 'full'], [profile.at + 0.5, 'full'], [profile.at + 1.9, 'live'],
    [stop.at - 1.5, 'live'], [stop.at - 0.3, 'full'],
    [S.heat + 0.5, 'full'], [S.heat + 2.6, 'heat'], [S.heat + 4.6, 'heat'], [S.flame, 'heatEnd'],
    [S.flame + 0.2, 'full'], [S.flame + 1.2, 'results'], [S.mem - 0.4, 'results'], [S.mem, 'full'],
    [dashboard, 'full'], [dashboard + 1.6, 'timeline'], [S.leaks - 0.3, 'timeline'], [S.leaks, 'full'],
    [S.leaks + 0.3, 'full'], [S.leaks + 1.3, 'leakCode'], [S.leaks + 3.0, 'leakCode'], [S.leaks + 3.8, 'leaks'],
  ];
}
let PATH = [];

function windowFrame(t) {
  const enter = ease.out(clamp((t - S.cpu) / 1.1, 0, 1));
  const exit = tween(t, S.montage - 0.3, S.montage + 0.5, 0, 1);
  const on = t >= S.cpu && t < S.montage + 0.5;
  $('window').style.display = on ? 'block' : 'none';
  if (!on) return null;
  $('window').style.opacity = enter * (1 - exit);
  $('window').style.transform =
    `perspective(2600px) translateY(${(1 - enter) * 200}px) rotateX(${(1 - enter) * 24}deg) scale(${0.9 + 0.1 * enter - 0.1 * exit})`;
  const dim = window01(t, S.flame + 1.6, S.mem - 0.1, 0.6);
  $('window').style.filter = `brightness(${1 - 0.68 * dim}) blur(${dim * 3}px)`;
  screenContent(t);
  const cam = cameraAt(t, PATH);
  applyCamera(cam);
  return cam;
}

// ── Scene: the flame graph panel over the dimmed results ──

function flamePanel(t) {
  const on = window01(t, S.flame + 1.5, S.mem - 0.1, 0.6);
  $('panel').style.display = on > 0 ? 'block' : 'none';
  if (on <= 0) return;
  const rise = ease.out(clamp((t - S.flame - 1.5) / 0.9, 0, 1));
  $('panel').style.opacity = on;
  $('panel').style.transform = `translateY(${(1 - rise) * 120}px) scale(${0.94 + 0.06 * rise})`;
  show($('panelA'), still('profiler-flamegraph'));
  show($('panelB'), still('profiler-flamegraph-zoom'));
  $('panelB').style.opacity = ease.inOut(clamp((t - S.flame - 3.6) / 0.5, 0, 1));
}

// ── The cursor: glides to each recorded click, presses, ripples ──

const REST = { x: 1840, y: 1060 };

function cursorTrack() {
  return [
    { from: S.cpu + 0.9, cues: CPU_CUES, until: CPU_CUES.at(-1).at + 1.1 },
    { from: S.mem + 0.1, cues: MEM_CUES.slice(0, 1), until: MEM_CUES[0].at + 1.1 },
  ];
}

function cursorPosition(t, cam, track) {
  const targets = track.cues.map((cue) => ({ ...project(cam, cue.x, cue.y), at: cue.at }));
  const next = targets.findIndex((target) => target.at - 0.1 > t);
  const target = targets[next < 0 ? targets.length - 1 : next];
  const prior = next <= 0 ? (next < 0 ? target : REST) : targets[next - 1];
  const p = ease.inOut(clamp((t - (target.at - 1.05)) / 0.9, 0, 1));
  return { x: prior.x + (target.x - prior.x) * p, y: prior.y + (target.y - prior.y) * p };
}

function cursor(t, cam) {
  const track = cursorTrack().find((entry) => t >= entry.from && t < entry.until);
  $('cursor').style.display = track && cam ? 'block' : 'none';
  $('ripple').style.display = 'none';
  if (!track || !cam) return;
  const at = cursorPosition(t, cam, track);
  const press = track.cues.some((cue) => Math.abs(t - cue.at) < 0.09) ? 0.82 : 1;
  const fade = window01(t, track.from, track.until, 0.3);
  $('cursor').style.opacity = fade;
  $('cursor').style.transform = `translate(${at.x - 7}px, ${at.y - 4}px) scale(${press})`;
  const click = track.cues.find((cue) => t >= cue.at && t < cue.at + 0.6);
  if (!click) return;
  const p = (t - click.at) / 0.6;
  const spot = project(cam, click.x, click.y);
  $('ripple').style.display = 'block';
  $('ripple').style.opacity = 0.95 * (1 - p);
  $('ripple').style.transform = `translate(${spot.x}px, ${spot.y}px) scale(${0.3 + ease.out(p) * 1.4})`;
}

// ── Highlights, captions, watermark ──

function focusBox(t, cam) {
  const box = FOCUS.find(([from, until]) => t >= from() && t < until());
  $('focus').style.display = box && cam ? 'block' : 'none';
  if (!box || !cam) return;
  const [from, until, [x, y, w, h]] = box;
  const a = project(cam, x, y);
  const b = project(cam, x + w, y + h);
  $('focus').style.opacity = window01(t, from(), until(), 0.35);
  Object.assign($('focus').style, {
    left: `${a.x - WIN.left}px`,
    top: `${a.y - WIN.top}px`,
    width: `${b.x - a.x}px`,
    height: `${b.y - a.y}px`,
  });
}

function captions() {
  const [profile, stop] = CPU_CUES;
  return [
    [S.cpu + 0.5, profile.at + 1.6, '01 · CPU', 'Profile any running .NET process. One click.'],
    [profile.at + 1.6, stop.at - 0.2, '01 · CPU', 'Attach to the live process. No restart.'],
    [stop.at - 0.2, S.heat, '01 · CPU', 'Stop. Results land instantly.'],
    [S.heat, S.flame, '02 · Heat map', 'Hot lines light up, right in your code.'],
    [S.flame, S.mem, '03 · Flame graph', 'Every call stack, one click from source.'],
    [S.mem, S.leaks, '04 · Memory', 'Watch the heap climb, live.'],
    [S.leaks, S.leaks + 3.3, '05 · Leaks', 'Flagged right on the leaking type.'],
    [S.leaks + 3.3, S.montage, '05 · Leaks', 'Suspects, ranked by steady growth.'],
    [S.montage + 0.3, S.end - 0.1, 'CPU · Memory · Leaks', 'One profiler for every .NET process.'],
  ];
}

function caption(t) {
  const entry = captions().find(([from, until]) => t >= from && t < until);
  $('caption').style.display = entry ? 'block' : 'none';
  if (!entry) return;
  const [from, until, eyebrow, headline] = entry;
  $('eyebrow').textContent = eyebrow;
  $('headline').textContent = headline;
  const p = ease.out(clamp((t - from) / 0.45, 0, 1));
  const q = clamp((until - t) / 0.3, 0, 1);
  $('caption').style.opacity = Math.min(p, q);
  $('caption').style.transform = `translateY(${(1 - p) * 18 - (1 - q) * 8}px)`;
  $('caption').style.left = `${t >= S.montage ? 248 : WIN.left + 2}px`;
}

/** An honest fast-forward marker whenever a clip plays faster than real time. */
function speedChip(t) {
  const clip = t >= S.cpu && t < S.heat ? CPU : t >= S.mem && t < S.leaks ? MEM : null;
  const rate = clip ? rateAt(clip, t) : 1;
  $('speed').style.opacity = rate > 1.05 ? 1 : 0;
  $('speed').textContent = `${Math.round(rate)}× ▸▸`;
}

function watermark(t) {
  $('mark').style.opacity = 0.92 * window01(t, S.cpu + 0.4, S.end - 0.1, 0.5);
}

function background(t) {
  $('grid').style.backgroundPosition = `${t * 14}px ${t * 9}px`;
  $('glow').style.setProperty('--gx', `${50 + 18 * Math.sin(t / 5)}%`);
  $('glow').style.setProperty('--gy', `${42 + 10 * Math.cos(t / 7)}%`);
  $('glow').style.opacity = 0.75 + 0.25 * Math.sin(t * 1.3);
}

// ── Montage, end card ──

/** Montage tiles: still, and the [x%, y%, zoom] each one crops to. */
const TILES = [
  ['profiler-heatmap', [30, 32, 1.7]],
  ['profiler-results', [100, 22, 1.45]],
  ['profiler-memory', [100, 20, 1.75]],
  ['profiler-leaks', [100, 52, 1.6]],
];

function buildTiles() {
  TILES.forEach(([name, [fx, fy, zoom]], i) => {
    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.style.left = `${246 + (i % 2) * 728}px`;
    tile.style.top = `${168 + Math.floor(i / 2) * 456}px`;
    const img = document.createElement('img');
    img.src = still(name);
    img.style.transformOrigin = `${fx}% ${fy}%`;
    img.style.transform = `scale(${zoom})`;
    tile.append(img);
    $('tiles').append(tile);
  });
}

function montage(t) {
  const on = t >= S.montage - 0.2 && t < S.end + 0.4;
  $('tiles').style.display = on ? 'block' : 'none';
  if (!on) return;
  [...document.querySelectorAll('.tile')].forEach((tile, i) => {
    const p = ease.out(clamp((t - S.montage - 0.1 - i * 0.11) / 0.8, 0, 1));
    const q = ease.inOut(clamp((t - S.end + 0.7 - i * 0.05) / 0.6, 0, 1));
    tile.style.opacity = p * (1 - q);
    tile.style.transform = `perspective(1800px) translateY(${(1 - p) * 90 - q * 40}px) rotateX(${(1 - p) * 28}deg) scale(${0.86 + 0.14 * p - 0.08 * q})`;
  });
}

function endCard(t) {
  const local = t - S.end;
  $('end').style.display = local > -0.1 ? 'flex' : 'none';
  if (local <= -0.1) return;
  const pop = ease.back(clamp(local / 0.7, 0, 1));
  $('endLogo').style.transform = `scale(${0.3 + 0.7 * pop})`;
  $('end').style.opacity = clamp(local / 0.3, 0, 1);
  [...$('end').children].slice(1).forEach((child, i) => rise(child, reveal(local, 0.35 + i * 0.28, 0.6), 28));
}

function fadeToBlack(t) {
  document.body.style.opacity = 1 - tween(t, S.out - 0.6, S.out, 0, 1);
}

// ── Frame entry point ──

function init() {
  PATH = cameraPath();
  buildTiles();
}

window.renderFrame = (t) => {
  pending.length = 0;
  background(t);
  coldOpen(t);
  titleCard(t);
  const cam = windowFrame(t);
  flamePanel(t);
  cursor(t, cam);
  focusBox(t, cam);
  caption(t);
  speedChip(t);
  watermark(t);
  montage(t);
  endCard(t);
  fadeToBlack(t);
  return Promise.all(pending).then(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));
};

init();
