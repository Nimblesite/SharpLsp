// Tests for [WEB-DESIGN-MEDIA-CAMERA]: the one camera every walkthrough is cut
// through, fed tracks sampled the way kit/track.mjs samples a shoot, every 50 ms.
import { test, expect } from '@playwright/test';
import { CAMERA, cropScript, focusOf, movesOf, paced, shotsOf, viewAt } from '../tools/video/kit/zoom.mjs';

const SIZE = [1600, 1000];
const STEP = 0.05;
const HOVER = 0;

/** A clip's track from just before its first frame to `to` seconds, `at(t)` saying where things are at each sample. */
function track(to, at) {
  const samples = Array.from({ length: Math.round((to + 0.2) / STEP) + 1 }, (_, i) => {
    const t = Number((i * STEP - 0.2).toFixed(3));
    return { t, p: null, c: null, w: [], ...at(t) };
  });
  return { size: SIZE, samples, captions: [] };
}

/** The camera along `clip` played at `speed`: its shots, its moves, and its view at any second. */
function shoot(clip, speed = 1) {
  const timing = paced(speed);
  const shots = shotsOf(focusOf(clip), SIZE, timing);
  const moves = movesOf(shots, timing);
  return { shots, moves, at: (t) => viewAt(moves, t, shots[0].view) };
}

const zoomOf = (view) => SIZE[0] / view.w;
const heightOf = (view) => (view.w * SIZE[1]) / SIZE[0];
const seconds = (from, to) => Array.from({ length: Math.round((to - from) * 10) + 1 }, (_, i) => from + i / 10);

/** `[x, y]` is in `view`, above the caption band at its foot. */
const shows = (view, [x, y]) => x >= view.x && x <= view.x + view.w && y >= view.y && y <= view.y + heightOf(view) * (1 - CAMERA.caption);

/** The pointer glides from (900, 400) to (700, 600) at 1 s, and the hover it opens stays from 2 s to the clip's end. */
const hovering = track(12, (t) => ({
  p: t < 1 ? null : t < 1.65 ? [Math.round(900 - ((t - 1) / 0.65) * 200), Math.round(400 + ((t - 1) / 0.65) * 200)] : [700, 600],
  w: t >= 2 ? [[HOVER, 650, 350, 400, 200]] : [],
}));

/** The text cursor sits at (500, 700) of a focused editor, then a line is typed between `from` and `to` seconds. */
const typing = (end, runs) =>
  track(end, (t) => {
    const typed = runs.reduce((x, [from, to]) => x + Math.max(0, Math.min(t, to) - from) * 160, 0);
    return { c: [Math.round(500 + typed), 700, 2, 19] };
  });

test.describe('The film camera', () => {
  test('opens wide, then pushes in on the pointer a beat early and frames the hover it opens', () => {
    const camera = shoot(hovering);
    expect(camera.at(0), 'a clip opens on the whole workbench').toEqual({ x: 0, y: 0, w: 1600 });
    expect(camera.moves[0].t0, 'the push-in starts a beat before the pointer moves').toBeCloseTo(1 - CAMERA.lead, 1);
    expect(camera.moves[0].t1 - camera.moves[0].t0, 'every move takes CAMERA.move').toBeCloseTo(CAMERA.move, 5);
    const settled = camera.at(4);
    expect(zoomOf(settled), 'pushed in on the action').toBeGreaterThan(1.3);
    expect(zoomOf(settled), 'never past the deepest zoom').toBeLessThanOrEqual(CAMERA.deepest);
    for (const point of [[700, 600], [650, 350], [1050, 550]]) {
      expect(shows(settled, point), `the pointer and the hover's corners, clear of the caption: ${point}`).toBe(true);
    }
    expect(zoomOf(camera.at(11.9)), 'an open hover keeps the camera in, however quiet the clip').toBeGreaterThan(1.3);
  });

  test('follows a typed line without being dragged along, then pulls back out once the clip goes quiet', () => {
    const camera = shoot(typing(12, [[1, 4]]));
    expect(camera.at(0.5), 'still wide before anything moves').toEqual({ x: 0, y: 0, w: 1600 });
    for (const t of seconds(1.5, 4.5)) {
      const cursor = [Math.round(500 + Math.min(Math.max(t - 1, 0), 3) * 160), 709];
      expect(shows(camera.at(t), cursor), `the text cursor stays in frame at ${t.toFixed(1)}s`).toBe(true);
    }
    const typingShots = camera.shots.filter((shot) => shot.t >= 1 && shot.t <= 4);
    expect(typingShots.length, 'a few framings across 480 pixels of typing, not one per keystroke').toBeLessThanOrEqual(3);
    expect(typingShots.length, 'the camera does push in on the typing').toBeGreaterThanOrEqual(1);
    const out = camera.shots.find((shot) => shot.t > 4 && shot.out);
    expect(out?.t, 'two quiet seconds with nothing open pull the camera back out').toBeCloseTo(4 + CAMERA.quiet, 1);
    expect(camera.at(out.t + CAMERA.move), 'back on the whole workbench').toEqual({ x: 0, y: 0, w: 1600 });
  });

  test('holds through a short pause, and never moves for a cursor that never moves', () => {
    const paused = shoot(typing(12, [[1, 3], [6, 8]]));
    for (const t of seconds(3.5, 6)) {
      expect(zoomOf(paused.at(t)), `a three-second pause is not long enough to pull out: ${t.toFixed(1)}s`).toBeGreaterThan(1.3);
    }
    expect(paused.shots.some((shot) => shot.t > 3 && shot.t < 6 && shot.out), 'no pull-back inside the pause').toBe(false);
    const still = shoot(track(10, () => ({ c: [500, 700, 2, 19] })));
    expect(still.shots, 'a cursor that sits still all clip is never framed').toHaveLength(1);
    expect(still.at(9), 'so the clip stays wide').toEqual({ x: 0, y: 0, w: 1600 });
  });

  test('never shows past the workbench edge, even for action in its corner', () => {
    const corner = shoot(track(6, (t) => ({ p: t < 1 ? null : [Math.round(4 + t * 4), Math.round(4 + t * 4)], w: t >= 2 ? [[HOVER, 0, 30, 300, 120]] : [] })));
    expect(zoomOf(corner.at(3)), 'it pushes in on the corner').toBeGreaterThan(1.3);
    for (const t of seconds(0, 6)) {
      const view = corner.at(t);
      expect(view.x, `left edge at ${t.toFixed(1)}s`).toBeGreaterThanOrEqual(0);
      expect(view.y, `top edge at ${t.toFixed(1)}s`).toBeGreaterThanOrEqual(0);
      expect(view.x + view.w, `right edge at ${t.toFixed(1)}s`).toBeLessThanOrEqual(SIZE[0] + 1e-6);
      expect(view.y + heightOf(view), `bottom edge at ${t.toFixed(1)}s`).toBeLessThanOrEqual(SIZE[1] + 1e-6);
    }
  });

  test('frames where a gliding pointer comes to rest, not the whole way it travelled', () => {
    // Parked top right, the pointer glides 1000 pixels to a word at (500, 600) and rests there.
    const glide = shoot(track(6, (t) => {
      const p = Math.min(Math.max((t - 1) / 0.65, 0), 1);
      return { p: [Math.round(1400 - p * 900), Math.round(100 + p * 500)] };
    }));
    expect(glide.moves.filter((move) => move.t0 < 3), 'one move takes the camera there').toHaveLength(1);
    expect(zoomOf(glide.moves[0].to), 'and it is already close').toBeGreaterThanOrEqual(1.8);
    const landed = glide.at(2.5);
    expect(zoomOf(landed), 'pushed well in on where it landed, not drawn out over its path').toBeGreaterThanOrEqual(1.8);
    expect(shows(landed, [500, 600]), 'the word it rests on is in frame').toBe(true);
    expect(shows(landed, [1400, 100]), 'where it set off from is not').toBe(false);
    expect(glide.moves[0].t0, 'the move still starts a beat before the first sample the pointer moved in').toBeCloseTo(1.05 - CAMERA.lead, 5);
  });

  test('holds on action against the workbench edge instead of chasing it every sample', () => {
    // The cursor types on the first line, framed past the top edge; the pointer then heads down the file.
    const edge = shoot(track(8, (t) => ({ c: [t < 1 ? 450 : 466, 103, 2, 24], p: t < 4.5 ? null : [450, 300 + Math.round(Math.min(t - 4.5, 0.65) * 300)] })));
    const early = edge.shots.filter((shot) => shot.t >= 1 && shot.t < 4.5);
    expect(early, 'one push-in on the first line, held while the pointer is still to come').toHaveLength(1);
    expect(edge.at(3).y, 'the view meets the top edge').toBe(0);
    expect(shows(edge.at(3), [466, 115]), 'and shows the cursor').toBe(true);
    expect(edge.shots.length, 'a handful of shots for the whole clip, not one per sample').toBeLessThanOrEqual(4);
  });

  test('paces a fast-forwarded clip so its moves look the same on screen', () => {
    const real = shoot(hovering);
    const fast = shoot(hovering, 4);
    expect(fast.moves[0].t1 - fast.moves[0].t0, 'a 4× clip moves over four times the footage').toBeCloseTo(4 * CAMERA.move, 5);
    expect(fast.moves[0].t1 - fast.moves[0].t0, 'which plays back in the same time as a move at 1×').toBeCloseTo(4 * (real.moves[0].t1 - real.moves[0].t0), 5);
    expect(paced(4).lead, 'its beat of anticipation is paced too').toBeCloseTo(4 * CAMERA.lead, 5);
  });

  test('crops the full-resolution footage in the frame’s own shape, one entry per frame that changes', () => {
    const camera = shoot(hovering);
    const script = cropScript(camera.moves, camera.shots[0].view, { name: 'camera0', frames: 360, fps: 30, scale: 2, size: SIZE });
    const entries = script.split('\n').map((line) => {
      const [time, ...commands] = line.replace(/;$/, '').split(' crop@camera0 ');
      return { time: Number(time), crop: Object.fromEntries(commands.map((command) => command.replace(/,$/, '').split(' ')).map(([key, value]) => [key, Number(value)])) };
    });
    expect(entries[0], 'the first frame is the whole 3200×2000 footage').toEqual({ time: 0, crop: { w: 3200, h: 2000, x: 0, y: 0 } });
    expect(entries.length, 'held frames send nothing').toBeLessThan(360);
    for (const { time, crop } of entries) {
      expect(crop.w / crop.h, `the crop at ${time}s keeps the frame's shape`).toBeCloseTo(1.6, 2);
      expect(crop.x + crop.w <= 3200 && crop.y + crop.h <= 2000 && crop.x >= 0 && crop.y >= 0, `the crop at ${time}s stays on the footage`).toBe(true);
      expect(crop.w, `the crop at ${time}s is never deeper than the deepest zoom`).toBeGreaterThanOrEqual(3200 / CAMERA.deepest - 1);
    }
    expect(entries.every((entry, i) => i === 0 || entry.time > entries[i - 1].time), 'entries run forward in time').toBe(true);
  });
});
