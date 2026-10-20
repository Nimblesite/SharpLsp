// Implements [WEB-DESIGN-MEDIA]. The lessons' score, synthesised from code like the
// walkthroughs' calm one, but quick: 124 BPM, a pluck arpeggio and a pumping pad
// over a one-bar A minor loop (Am, F, C, G); a four-on-the-floor kick, claps, hats
// and an offbeat bass come in after the intro, and everything stops on the
// closing line for a C major strum that rings out. Voices are one-cycle
// wavetables, rendered event by event, so a three-minute score takes seconds.
import { fade, gain, harmonics, noise, pitch, rate, sides } from './score.mjs';

const beat = 60 / 124;
const bar = 4 * beat;
const sixteenth = beat / 4;
/** One bar each; the first note is the bass. */
const progression = [[45, 57, 60, 64, 67], [41, 57, 60, 65, 69], [48, 55, 60, 64, 67], [43, 55, 59, 62, 67]];
const resolution = [48, 55, 60, 64, 67, 72];
const intro = 2;
const SIZE = 4096;
const tau = 2 * Math.PI;
const arp = { pattern: [0, 1, 2, 3, 2, 1, 3, 2, 0, 2, 1, 3, 2, 3, 1, 2], octave: 12, level: 0.16, accent: 1.5, pan: 0.4, decay: 0.2, ring: 1.6 };
const kit = { kick: 0.95, clap: 0.18, hat: 0.075, ghost: 0.028, crash: 0.045, bass: 0.26, pad: 0.06 };
const pump = { depth: 0.6, release: 0.13 };
const master = { fadeIn: 0.25, fadeOut: 2.4, drive: 1.25 };

const wavetable = (weights) =>
  Float32Array.from({ length: SIZE }, (_, i) => weights.reduce((sum, weight, k) => sum + weight * Math.sin((tau * (k + 1) * i) / SIZE), 0));
const SAW = wavetable(harmonics(8, 1));
const SOFT = wavetable(harmonics(4, 1.8));
const osc = (wave, cycles) => wave[Math.floor((cycles - Math.floor(cycles)) * SIZE)];
const attack = (age, seconds) => Math.min(1, age / seconds);
const crackle = (index, seed) => noise(index, seed) - noise(index - 1, seed);

const kick = (age) => Math.sin(tau * (45 * age + 3.3 * (1 - Math.exp(-age / 0.03)))) * Math.exp(-age / 0.16);
const clap = (age, index) => crackle(index, 3) * Math.exp(-age / 0.08) * (age < 0.025 ? 1.4 : 1);
const hat = (age, index) => crackle(index, 7) * Math.exp(-age / 0.028);
const crash = (age, index) => crackle(index, 11) * Math.exp(-age / 0.9);
const bassNote = (frequency) => (age) => osc(SAW, frequency * age) * attack(age, 0.004) * Math.exp(-age / 0.3);
const pluck = (frequency, decay) => (age) => osc(SOFT, frequency * age) * attack(age, 0.003) * Math.exp(-age / decay);
const padNote = (frequency, length) => (age) => osc(SOFT, frequency * age) * fade(age, length, { fadeIn: 0.3, fadeOut: 0.4 });

const event = (time, length, level, voice, pan = 0) => ({ time, length, level, voice, pan });

/** The chord loop up to the closing line, one bar a chord. */
function bars(resolve) {
  return Array.from({ length: Math.max(1, Math.ceil(resolve / bar)) }, (_, index) => ({ index, start: index * bar, chord: progression[index % progression.length] }));
}

/** Kick on every beat, clap on two and four, hats on the offbeats with ghost sixteenths: every bar after the intro. */
function drums(grid, resolve) {
  const beats = grid.filter((item) => item.index >= intro).flatMap((item) => [0, 1, 2, 3].map((n) => item.start + n * beat)).filter((time) => time < resolve);
  return [
    ...beats.map((time) => event(time, 0.4, kit.kick, kick)),
    ...beats.filter((_, n) => n % 2 === 1).map((time) => event(time, 0.3, kit.clap, clap)),
    ...beats.map((time) => event(time + beat / 2, 0.15, kit.hat, hat, 0.25)),
    ...beats.flatMap((time) => [1, 3].map((n) => event(time + n * sixteenth, 0.1, kit.ghost, hat, -0.25))),
    ...(beats.length ? [event(beats[0], 3, kit.crash, crash, 0.1)] : []),
  ];
}

/** The bass on every offbeat eighth, from the drums' entry. */
const bass = (grid) =>
  grid.filter((item) => item.index >= intro).flatMap((item) => [0, 1, 2, 3].map((n) => event(item.start + n * beat + beat / 2, beat / 2, kit.bass, bassNote(pitch(item.chord[0])))));

/** Sixteenth-note plucks over each bar's upper notes, an octave up, accented on the beat. */
const arpeggio = (grid, resolve) =>
  grid.flatMap((item) =>
    arp.pattern.map((step, n) => ({ time: item.start + n * sixteenth, note: item.chord[1 + (step % (item.chord.length - 1))], n }))
      .filter(({ time }) => time < resolve)
      .map(({ time, note, n }) => event(time, 1, arp.level * (n % 4 === 0 ? arp.accent : 1), pluck(pitch(note + arp.octave), arp.decay), (n % 2 ? 1 : -1) * arp.pan)));

/** A detuned pad per bar, spread wide; the resolution's pad holds to the end. */
function pads(grid, { resolve, duration }) {
  const chord = (notes, start, length) =>
    notes.slice(1).flatMap((note) => [-1, 1].map((side) => event(start, length, kit.pad, padNote(pitch(note) * 2 ** ((side * 6) / 1200), length), side * 0.6)));
  return [...grid.flatMap((item) => chord(item.chord, item.start, Math.min(bar + 0.3, resolve - item.start + 0.3))), ...chord(resolution, resolve, duration - resolve)];
}

/** The closing strum: the resolution chord, an octave up, ringing out. */
const strum = ({ resolve }) =>
  resolution.map((note, n) => event(resolve + n * 0.05, 4, arp.level * 1.2, pluck(pitch(note + arp.octave), arp.ring), (n % 2 ? 1 : -1) * arp.pan));

/** Add each event's voice into a stereo buffer of `frames`. */
function render(events, frames) {
  const out = sides.map(() => new Float32Array(frames));
  for (const item of events) {
    const start = Math.round(item.time * rate);
    const end = Math.min(frames, start + Math.round(item.length * rate));
    for (let index = Math.max(0, start); index < end; index++) {
      const value = item.voice((index - start) / rate, index) * item.level;
      sides.forEach((side, channel) => (out[channel][index] += value * gain(item.pan, side)));
    }
  }
  return out;
}

/** The side-chain: the music bus dips under every kick and swells back. */
function pumping(kicks, frames) {
  const times = kicks.map((item) => item.time);
  let next = 0;
  return Float32Array.from({ length: frames }, (_, index) => {
    const t = index / rate;
    while (next < times.length && times[next] <= t) next++;
    return next === 0 ? 1 : 1 - pump.depth * Math.exp(-(t - times[next - 1]) / pump.release);
  });
}

/** The stereo score for a film of `duration` seconds whose closing line starts at `resolve`. */
function compose(timeline) {
  const frames = Math.round(timeline.duration * rate);
  const grid = bars(timeline.resolve);
  const beatEvents = drums(grid, timeline.resolve);
  const duck = pumping(beatEvents.filter((item) => item.voice === kick), frames);
  const music = render([...bass(grid), ...arpeggio(grid, timeline.resolve), ...pads(grid, timeline), ...strum(timeline)], frames);
  const hits = render(beatEvents, frames);
  return sides.map((_, channel) =>
    Float32Array.from({ length: frames }, (_, index) => Math.tanh(master.drive * (music[channel][index] * duck[index] + hits[channel][index])) * fade(index / rate, timeline.duration, master)));
}

/** The lessons' score: up front, so it sits higher in the mix and drier than the calm one. Its beat and the drums' entry let a picture move with it. */
export const drive = { compose, level: 0.3, wet: 0.12, beat, drums: intro * bar };
