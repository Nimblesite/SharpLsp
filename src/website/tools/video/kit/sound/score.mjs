// Implements [WEB-DESIGN-MEDIA]. An original score synthesised from code, so a film
// carries no licensed or sampled music: a warm pad and bass on a two-bar chord
// grid, felt-bell eighth notes once the story starts, and a shimmer that resolves
// as the closing line begins. Stems are written as 16-bit PCM WAV.
import { writeFile } from 'node:fs/promises';

export const rate = 48_000;
const tau = 2 * Math.PI;
const tuning = { pitch: 440, note: 69, octave: 12, cents: 1_200 };
const beat = 60 / 76;
const eighth = beat / 2;
const bar = 4 * beat;
/** C major: Cmaj9, Am9, Fmaj9 and G sus, two bars each, resolving to Cmaj9. The first note is the bass. */
const progression = [[36, 52, 55, 59, 62, 64], [33, 52, 55, 59, 60, 64], [41, 52, 57, 60, 64, 67], [31, 50, 55, 57, 60, 62]];
const resolution = [36, 52, 55, 59, 62, 67];
const pad = { detune: [-7, 0, 7], pan: [-0.6, 0, 0.6], weights: harmonics(6, 1.7), attack: 1.4, release: 1.8, level: 0.05, bars: 2 };
const bass = { weights: harmonics(3, 1.2), level: 0.07 };
const bell = { partials: [[1, 1, 1.1], [2, 0.3, 0.5], [3, 0.1, 0.25]], attack: 0.004, life: 4, level: 0.09, pan: 0.35,
  pattern: [0, 2, 4, 3, 1, 3, 2, 4], offbeat: 0.65, octave: 12, strum: 0.08, ring: 2.5, entry: 2 };
const master = { fadeIn: 1.2, fadeOut: 2.4, drive: 1.4, peak: 0.89 };
const space = { length: 2.6, decay: 0.6, preDelay: 0.018, stretch: 12.9898, seed: 78.233, scale: 43_758.5453 };
const pcm = { format: 1, width: Int16Array.BYTES_PER_ELEMENT, full: 32_767, chunk: 16, bitsPerByte: 8 };
export const sides = [-1, 1];
const ratios = pad.detune.map((cents) => 2 ** (cents / tuning.cents));

export function harmonics(count, rolloff) {
  return Array.from({ length: count }, (_, index) => 1 / (index + 1) ** rolloff);
}

export const pitch = (note) => tuning.pitch * 2 ** ((note - tuning.note) / tuning.octave);
export const smooth = (x) => x * x * (3 - 2 * x);
export const clamp = (x) => Math.min(1, Math.max(0, x));
/** A score's level at `t`: up over `fadeIn`, down over the last `fadeOut` of `duration`. */
export const fade = (t, duration, { fadeIn, fadeOut }) => smooth(clamp(t / fadeIn)) * smooth(clamp((duration - t) / fadeOut));
export const gain = (pan, side) => (1 + pan * side) / 2;
const alternate = (step) => (step % 2 === 0 ? 1 : -1);

export const timbre = (frequency, t, weights) =>
  weights.reduce((sum, weight, index) => sum + weight * Math.sin(tau * frequency * (index + 1) * t), 0);

const swell = (t, section) => smooth(clamp((t - section.start) / pad.attack)) * smooth(clamp(1 - (t - section.end) / pad.release));

function chord(section, t, side) {
  const voices = (frequency) => ratios.reduce((sum, ratio, index) => sum + gain(pad.pan[index], side) * timbre(frequency * ratio, t, pad.weights), 0);
  return section.pad.reduce((sum, frequency) => sum + voices(frequency), 0) * pad.level + timbre(section.bass, t, bass.weights) * bass.level;
}

const section = ([root, ...upper], start, end) => ({ start, end, bass: pitch(root), pad: upper.map(pitch), upper });

/** The chord grid up to the closing line, then the resolution held to the end. */
function sections({ resolve, duration }) {
  const length = pad.bars * bar;
  const count = Math.max(1, Math.round(resolve / length));
  const span = resolve / count;
  const grid = Array.from({ length: count }, (_, index) => section(progression[index % progression.length], index * span, (index + 1) * span));
  return [...grid, section(resolution, resolve, duration + pad.release)];
}

/** Felt-bell eighth notes from the second chord until the closing line. */
function arpeggio(chords, { resolve }) {
  const start = chords[Math.min(bell.entry - 1, chords.length - 1)].start;
  return Array.from({ length: Math.max(0, Math.floor((resolve - start) / eighth)) }, (_, step) => {
    const time = start + step * eighth;
    const note = chords.findLast((item) => item.start <= time).upper[bell.pattern[step % bell.pattern.length]];
    return { time, frequency: pitch(note + bell.octave), level: bell.level * (step % 2 === 0 ? 1 : bell.offbeat), pan: alternate(step) * bell.pan, ring: 1 };
  });
}

const shimmer = (chords, { resolve }) =>
  chords.at(-1).upper.map((note, index) => ({ time: resolve + index * bell.strum, frequency: pitch(note + bell.octave), level: bell.level, pan: alternate(index) * bell.pan, ring: bell.ring }));

function strike(event, t, side) {
  const age = t - event.time;
  const body = bell.partials.reduce((sum, [ratio, level, decay]) => sum + level * Math.exp(-age / (decay * event.ring)) * Math.sin(tau * event.frequency * ratio * age), 0);
  return body * Math.min(1, age / bell.attack) * event.level * gain(event.pan, side);
}

const ringing = (events, t, side) =>
  events.reduce((sum, event) => (t >= event.time && t < event.time + bell.life * event.ring ? sum + strike(event, t, side) : sum), 0);

function sample(score, t, side) {
  const harmony = score.chords.reduce((sum, item) => {
    const level = swell(t, item);
    return level > 0 ? sum + level * chord(item, t, side) : sum;
  }, 0);
  return Math.tanh(master.drive * (harmony + ringing(score.bells, t, side))) * fade(t, score.duration, master);
}

/** The stereo score for a film of `duration` seconds whose closing line starts at `resolve`. */
function compose(timeline) {
  const chords = sections(timeline);
  const score = { duration: timeline.duration, chords, bells: [...arpeggio(chords, timeline), ...shimmer(chords, timeline)] };
  const frames = Math.round(timeline.duration * rate);
  return sides.map((side) => Float32Array.from({ length: frames }, (_, index) => sample(score, index / rate, side)));
}

export function noise(index, seed) {
  const value = Math.sin(index * space.stretch + seed * space.seed) * space.scale;
  return 2 * (value - Math.floor(value)) - 1;
}

/** The walkthroughs' score: gentle, and mixed low under the voice. */
export const calm = { compose, level: 0.2, wet: 0.35 };

/** A decaying stereo noise impulse response: a small, warm room for the score. */
export function room() {
  const frames = Math.round(space.length * rate);
  return sides.map((side) =>
    Float32Array.from({ length: frames }, (_, index) => {
      const t = index / rate - space.preDelay;
      return t < 0 ? 0 : noise(index, side) * Math.exp(-t / space.decay);
    }),
  );
}

const ascii = (value) => Buffer.from(value, 'ascii');

function unsigned(value, width) {
  const field = Buffer.alloc(width);
  field.writeUIntLE(value, 0, width);
  return field;
}

function header(count, sampleRate, bytes) {
  const block = count * pcm.width;
  const [short, long] = [Uint16Array.BYTES_PER_ELEMENT, Uint32Array.BYTES_PER_ELEMENT];
  const body = Buffer.concat([ascii('WAVE'), ascii('fmt '), unsigned(pcm.chunk, long), unsigned(pcm.format, short), unsigned(count, short),
    unsigned(sampleRate, long), unsigned(sampleRate * block, long), unsigned(block, short), unsigned(pcm.width * pcm.bitsPerByte, short),
    ascii('data'), unsigned(bytes, long)]);
  return Buffer.concat([ascii('RIFF'), unsigned(body.length + bytes, long), body]);
}

/** Writes 16-bit PCM, peak-normalised so every stem reaches the mix at the same headroom. */
export async function wav(path, channels, sampleRate = rate) {
  const peak = channels.reduce((top, samples) => samples.reduce((most, value) => Math.max(most, Math.abs(value)), top), 0);
  const scale = peak > 0 ? (master.peak * pcm.full) / peak : 0;
  const count = channels.length;
  const samples = Int16Array.from({ length: channels[0].length * count }, (_, index) => Math.round(channels[index % count][Math.floor(index / count)] * scale));
  const data = Buffer.from(samples.buffer);
  await writeFile(path, Buffer.concat([header(count, sampleRate, data.length), data]));
}
