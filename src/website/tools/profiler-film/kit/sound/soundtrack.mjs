// Implements [WEB-DESIGN-MEDIA]. A narrated film's soundtrack: each spoken line
// starts just after its scene's cut, a scene holds its last frame until its line
// has finished, and the original score ducks under the voice.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { compose, rate, room, wav } from './score.mjs';
import { pacing, speak } from './voice.mjs';

const sound = {
  voice: 'highpass=f=70,acompressor=threshold=0.1:ratio=3:attack=5:release=120:makeup=2',
  music: 'highpass=f=40,equalizer=f=280:t=q:w=1.2:g=-3,volume=0.2',
  wet: 0.35,
  duck: 'threshold=0.03:ratio=5:attack=40:release=500',
  gain: 1.15,
  limit: 0.84,
  /** Web loudness: -16 LUFS integrated, true peak under -1.5 dBTP. */
  loudness: 'loudnorm=I=-16:TP=-1.5:LRA=11',
};

/** Place `spoken` after the scene's cut and after the line before it; returns the placed lines. */
function placeLines(spoken, cut, lead, before) {
  return spoken.reduce((lines, line) => {
    const start = Math.max(cut + lead, ((lines.at(-1) ?? before)?.end ?? 0) + pacing.gap);
    return [...lines, { ...line, start, end: start + line.length }];
  }, []);
}

/** Each shot gets the `hold` its lines need; returns the shots, the placed lines and the film's length. */
export function timeline(shots, takes) {
  return shots.reduce(
    (film, shot, index) => {
      const lead = index === 0 ? pacing.opening : pacing.lead;
      const placed = placeLines(takes.filter((line) => line.scene === shot.clip), film.duration, lead, film.lines.at(-1));
      const tail = index === shots.length - 1 ? pacing.closing : pacing.tail;
      const hold = Math.max(0, (placed.at(-1)?.end ?? 0) + tail - (film.duration + shot.length));
      return { shots: [...film.shots, { ...shot, hold }], lines: [...film.lines, ...placed], duration: film.duration + shot.length + hold };
    },
    { shots: [], lines: [], duration: 0 },
  );
}

/** Inputs: 0 is the score, 1 its room, then one per spoken line. The score ducks under the voice. */
function mix(lines, duration) {
  const voices = lines.map((line, i) => `[${i + 2}:a]aresample=${rate},adelay=${Math.round(line.start * 1000)}:all=1[v${i}]`).join(';');
  const labels = lines.map((_, i) => `[v${i}]`).join('');
  const voice = `${labels}amix=inputs=${lines.length}:normalize=0,${sound.voice},aformat=channel_layouts=stereo,asplit[voice][trigger];[trigger]apad[key]`;
  const bed = `[0:a]asplit[dry][send];[send][1:a]afir[wet];[dry][wet]amix=inputs=2:weights=1 ${sound.wet}:normalize=0,${sound.music}[bed]`;
  const master = `[voice][ducked]amix=inputs=2:normalize=0,volume=${sound.gain},alimiter=limit=${sound.limit}:level=0,${sound.loudness},aresample=${rate},atrim=end=${duration}[mix]`;
  return `${voices};${voice};${bed};[bed][key]sidechaincompress=${sound.duck}[ducked];${master}`;
}

/** Speak `script`, score the film around it and mix both into `<dir>/soundtrack.wav`. */
export async function soundtrack(script, shots, dir) {
  const film = timeline(shots, await speak(script, dir));
  const [score, space, output] = ['score', 'room', 'soundtrack'].map((name) => path.join(dir, `${name}.wav`));
  await wav(score, compose({ resolve: film.lines.at(-1).start, duration: film.duration }));
  await wav(space, room());
  const inputs = [score, space, ...film.lines.map((line) => line.path)].flatMap((file) => ['-i', file]);
  execFileSync('ffmpeg', ['-y', '-v', 'error', ...inputs, '-filter_complex', mix(film.lines, film.duration), '-map', '[mix]', output], { stdio: 'inherit' });
  return { ...film, audio: output };
}
