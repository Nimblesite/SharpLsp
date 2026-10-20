// Implements [WEB-DESIGN-MEDIA]. What every page kit/frames.mjs steps shares: the
// frame rate, and the easing that sets each element from t alone. A page loads
// it before its own script (the profiler's film.html, the lesson's deck.html).
'use strict';

const FPS = 30;
const $ = (id) => document.getElementById(id);
const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const ease = {
  linear: (p) => p,
  inOut: (p) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2),
  out: (p) => 1 - (1 - p) ** 3,
  expo: (p) => (p === 1 ? 1 : 1 - 2 ** (-10 * p)),
  /** Overshoots by `s` before it settles. */
  back: (p, s = 1.2) => 1 + (s + 1) * (p - 1) ** 3 + s * (p - 1) ** 2,
};
/** From `a` at t0 to `b` at t1, held at either end. */
const tween = (t, t0, t1, a, b, e = ease.inOut) => a + (b - a) * e(clamp((t - t0) / (t1 - t0)));
