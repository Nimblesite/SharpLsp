// Implements [WEB-DESIGN-MEDIA-CAMERA]. The one camera every walkthrough is cut
// through, framed from each clip's track (kit/track.mjs) alone, so no film keys
// a shot by hand. A clip opens wide. The camera pushes in on the pointer or the
// text cursor, whichever moved last, with every widget the editor has open, and
// frames the next moments' action too, so typing does not drag it along. It
// holds while the action stays in frame, moves when it leaves, and pulls back
// out once the clip goes quiet with nothing open. Each move eases over
// CAMERA.move seconds, starting a beat before the action it frames. The path is
// sent to ffmpeg's crop filter as one crop per frame of the full-resolution
// footage, so even the deepest zoom stays sharp.
import fs from 'node:fs';
import { WIDGETS } from './track.mjs';

/** Framing in workbench pixels and shares of the view; timing in seconds of footage played at 1×. */
export const CAMERA = {
  /** The deepest zoom. */
  deepest: 2,
  /** The share of the view kept clear on each side of what it frames. */
  margin: 0.08,
  /** How close the action may come to the view's edge before the camera follows it. */
  safe: 0.04,
  /** The area framed around the pointer's tip: width and height. */
  pointer: [400, 220],
  /** Faster than this, in pixels a second, the pointer or cursor is on its way somewhere: framed where it comes to rest. */
  transit: 400,
  /** The area framed around the text cursor: to its left, to its right, and above and below it. */
  caret: [220, 420, 130],
  /** The share of the frame's foot the step caption covers, kept clear of what the camera frames. */
  caption: 0.13,
  /** A view this many times wider than the action needs pushes in closer. */
  tighten: 1.3,
  /** A framing also covers what happens this long after it. */
  lookAhead: 1.5,
  /** A move starts this long before the action it frames. */
  lead: 0.35,
  /** How long a move takes. */
  move: 0.8,
  /** Quiet this long, with nothing open, and the camera pulls back out ... */
  quiet: 2,
  /** ... when the quiet lasts at least this much longer. */
  stayWide: 2.5,
};

const TIMING = ['lookAhead', 'lead', 'move', 'quiet', 'stayWide'];

/** The camera's timing for footage played back at `speed`, so every move looks the same length on screen. */
export const paced = (speed = 1) => Object.fromEntries(TIMING.map((key) => [key, CAMERA[key] * speed]));

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const lerp = (from, to, p) => from + (to - from) * p;

/** Smootherstep: a move starts and ends at rest, with no jolt in its speed. */
const ease = (p) => p * p * p * (p * (6 * p - 15) + 10);

/** The smallest box `{ x, y, w, h }` around every box in `boxes`; null for none. */
export function union(boxes) {
  if (boxes.length === 0) return null;
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.w));
  const bottom = Math.max(...boxes.map((box) => box.y + box.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** `box` cut to the workbench, `size`: the camera can show nothing beyond it. */
function clipped(box, [width, height]) {
  if (!box) return null;
  const [x, y] = [Math.max(0, box.x), Math.max(0, box.y)];
  return { x, y, w: Math.min(width, box.x + box.w) - x, h: Math.min(height, box.y + box.h) - y };
}

const same = (a, b) => a !== null && b !== null && Math.abs(a[0] - b[0]) <= 1 && Math.abs(a[1] - b[1]) <= 1;

/**
 * For each sample, the pointer (`p`) or the text cursor (`c`), whichever moved
 * last, while it is on screen: `{ kind, at }`, or null before either moves.
 */
function anchors(samples) {
  return samples.reduce(
    ({ last, list }, sample, i) => {
      const before = samples[i - 1] ?? sample;
      const kind = ['p', 'c'].filter((name) => sample[name] && !same(sample[name], before[name])).at(-1) ?? last;
      return { last: kind, list: [...list, kind && sample[kind] ? { kind, at: sample[kind] } : null] };
    },
    { last: null, list: [] },
  ).list;
}

/** What the camera frames around an anchor: the pointer's surroundings, or the text cursor with room to type. */
function around({ kind, at }) {
  if (kind === 'p') {
    const [width, height] = CAMERA.pointer;
    return { x: at[0] - width / 2, y: at[1] - height / 2, w: width, h: height };
  }
  const [left, right, half] = CAMERA.caret;
  return { x: at[0] - left, y: at[1] + at[3] / 2 - half, w: left + right, h: 2 * half };
}

/** For each sample, the widgets open long enough to frame (WIDGETS says how long), as boxes. */
function settled(samples) {
  return samples.reduce(
    ({ opened, list }, sample) => {
      const since = Object.fromEntries(sample.w.map(([index]) => [index, opened[index] ?? sample.t]));
      const boxes = sample.w.filter(([index]) => sample.t - since[index] >= WIDGETS[index][1]).map(([, x, y, w, h]) => ({ x, y, w, h }));
      return { opened: since, list: [...list, boxes] };
    },
    { opened: {}, list: [] },
  ).list;
}

const moved = (now, before) => now !== null && (before === null || now.kind !== before.kind || !same(now.at, before.at));

/** The anchor at sample `i` is gliding or jumping somewhere, not resting where the action is. */
function inTransit(anchored, samples, i) {
  const now = anchored[i];
  const before = now && samples[i - 1]?.[now.kind];
  if (!before) return false;
  const distance = Math.hypot(now.at[0] - before[0], now.at[1] - before[1]);
  return distance / (samples[i].t - samples[i - 1].t) > CAMERA.transit;
}
const changed = (now, before) => JSON.stringify(now) !== JSON.stringify(before);

/** For each sample, the time of the last action at or before it, and of the next one after it. */
function stretches(samples, active) {
  const last = active.reduce((times, on, i) => [...times, on ? samples[i].t : (times.at(-1) ?? -Infinity)], []);
  const next = active.reduceRight((times, on, i) => [on ? samples[i].t : (times[0] ?? Infinity), ...times], []);
  return samples.map((_, i) => ({ last: last[i], next: next[i + 1] ?? Infinity }));
}

/**
 * The track as the camera reads it: for each sample, its time `t`, the `box` to
 * keep in frame (the anchor's surroundings and every settled widget), the
 * `rest` of it to frame ahead (the same, less an anchor in transit), whether a
 * widget is `open`, how long `since` the last action, and how long the `quiet`
 * stretch it sits in lasts.
 */
export function focusOf({ size, samples }) {
  const anchored = anchors(samples);
  const widgets = settled(samples);
  const active = samples.map((_, i) => i > 0 && (moved(anchored[i], anchored[i - 1]) || changed(widgets[i], widgets[i - 1])));
  const quiet = stretches(samples, active);
  const boxed = (anchor, i) => clipped(union([...(anchor ? [around(anchor)] : []), ...widgets[i]]), size);
  return samples.map((sample, i) => ({
    t: sample.t,
    box: boxed(anchored[i], i),
    rest: boxed(inTransit(anchored, samples, i) ? null : anchored[i], i),
    open: widgets[i].length > 0,
    since: sample.t - quiet[i].last,
    quiet: quiet[i].next - quiet[i].last,
  }));
}

/** The whole workbench. A view is `{ x, y, w }` in workbench pixels; its height keeps the frame's shape. */
export const wide = ([width]) => ({ x: 0, y: 0, w: width });

/** The view that frames `box` as closely as CAMERA.deepest allows, centred above the caption band. */
export function frame(box, [width, height]) {
  const usable = 1 - 2 * CAMERA.margin;
  const zoom = clamp(Math.min((width * usable) / box.w, (height * (usable - CAMERA.caption)) / box.h), 1, CAMERA.deepest);
  const [w, h] = [width / zoom, height / zoom];
  const middle = box.y + box.h / 2 + (h * CAMERA.caption) / 2;
  return { x: clamp(box.x + box.w / 2 - w / 2, 0, width - w), y: clamp(middle - h / 2, 0, height - h), w };
}

/**
 * `box` sits inside `view`, clear of its edges and of the caption band, except
 * where the view already meets the workbench's edge and could go no further.
 */
function within(box, view, [width, height]) {
  const h = (view.w * height) / width;
  const [dx, dy] = [view.w * CAMERA.safe, h * CAMERA.safe];
  const left = view.x <= 0 ? 0 : view.x + dx;
  const top = view.y <= 0 ? 0 : view.y + dy;
  const right = view.x + view.w >= width ? width : view.x + view.w - dx;
  const bottom = view.y + h >= height ? height : view.y + h * (1 - CAMERA.caption) - dy;
  return box.x >= left && box.y >= top && box.x + box.w <= right && box.y + box.h <= bottom;
}

const alike = (a, b) => Math.abs(a.x - b.x) < 2 && Math.abs(a.y - b.y) < 2 && Math.abs(a.w - b.w) < 2;

/** Where the action comes to rest from sample `i` until `lookAhead` seconds later; while it is all in transit, where it has got to. */
function ahead(focus, i, lookAhead) {
  const window = focus.slice(i).filter((sample) => sample.t <= focus[i].t + lookAhead);
  return union(window.map((sample) => sample.rest).filter(Boolean)) ?? window.findLast((sample) => sample.box).box;
}

/** The shot sample `i` calls for, if any: out once quiet, across when the action leaves the view, in when it can be framed closer. */
function shotAt(focus, i, current, size, timing) {
  const { t, box, open, since, quiet } = focus[i];
  if (!box) return null;
  const out = !open && since >= timing.quiet && quiet >= timing.quiet + timing.stayWide;
  const view = out ? wide(size) : frame(ahead(focus, i, timing.lookAhead), size);
  const needed = out || !within(box, current.view, size) || view.w * CAMERA.tighten < current.view.w;
  return needed && !alike(view, current.view) ? { t, view, out } : null;
}

/** The clip's shots, from its wide opening on: `{ t, view, out }`. */
export function shotsOf(focus, size, timing) {
  return focus.reduce(
    (shots, sample, i) => {
      const shot = sample.t >= 0 ? shotAt(focus, i, shots.at(-1), size, timing) : null;
      return shot ? [...shots, shot] : shots;
    },
    [{ t: 0, view: wide(size), out: true }],
  );
}

/** The camera at `t`: the last move begun by then, eased along from where it began. */
export function viewAt(moves, t, first) {
  const move = moves.findLast((each) => each.t0 <= t);
  if (!move) return first;
  const p = ease(clamp((t - move.t0) / (move.t1 - move.t0), 0, 1));
  return { x: lerp(move.from.x, move.to.x, p), y: lerp(move.from.y, move.to.y, p), w: lerp(move.from.w, move.to.w, p) };
}

/** Each shot's move, `{ t0, t1, from, to }`: a beat early unless it pulls out, never before the move before it began. */
export function movesOf(shots, timing) {
  return shots.slice(1).reduce((moves, shot) => {
    const start = Math.max(shot.out ? shot.t : shot.t - timing.lead, moves.at(-1)?.t0 ?? 0);
    return [...moves, { t0: start, t1: start + timing.move, from: viewAt(moves, start, shots[0].view), to: shot.view }];
  }, []);
}

/** `view` as a crop of the footage, `[w, h, x, y]` in its pixels: `scale` of them per workbench pixel. */
function cropOf(view, [width, height], scale) {
  const [w, h] = [Math.round(view.w * scale), Math.round(((view.w * height) / width) * scale)];
  const [right, bottom] = [Math.round(width * scale) - w, Math.round(height * scale) - h];
  return [w, h, clamp(Math.round(view.x * scale), 0, right), clamp(Math.round(view.y * scale), 0, bottom)];
}

/** The sendcmd script that moves `crop@<name>` along `moves`: an entry for each frame whose crop changes. */
export function cropScript(moves, first, { name, frames, fps, scale, size }) {
  const crops = Array.from({ length: frames }, (_, frame) => cropOf(viewAt(moves, frame / fps, first), size, scale));
  return crops
    .map((crop, frame) => [crop, frame])
    .filter(([crop, frame]) => frame === 0 || crop.join() !== crops[frame - 1].join())
    .map(([[w, h, x, y], frame]) => {
      const at = Math.max(0, (frame - 0.5) / fps).toFixed(4);
      return `${at} crop@${name} w ${w}, crop@${name} h ${h}, crop@${name} x ${x}, crop@${name} y ${y};`;
    })
    .join('\n');
}

/**
 * Frame a clip from its `track` and write the camera to `file`, the sendcmd
 * script for `crop@<name>`; `frames` at `fps`, `scale` footage pixels per
 * workbench pixel, played back at `speed`. Resolves to the clip's shots.
 */
export function writeCamera(track, { file, name, frames, fps, scale, speed }) {
  const timing = paced(speed);
  const shots = shotsOf(focusOf(track), track.size, timing);
  fs.writeFileSync(file, `${cropScript(movesOf(shots, timing), shots[0].view, { name, frames, fps, scale, size: track.size })}\n`);
  return shots;
}
