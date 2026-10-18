// Implements [WEB-DESIGN-MEDIA]. A local voice model speaks a film's reviewed
// narration, and the captions follow the measured speech in every site language.
// Nothing leaves this machine: kokoro-js runs Kokoro-82M (Apache-2.0) on the CPU.
import fs from 'node:fs';
import path from 'node:path';
import { wav } from './score.mjs';

const model = { id: 'onnx-community/Kokoro-82M-v1.0-ONNX', dtype: 'fp32', device: 'cpu', silence: 0.01 };
export const pacing = { opening: 1.2, lead: 0.35, gap: 0.4, tail: 0.5, hold: 0.3, closing: 2.5 };
const clock = { minute: 60, digits: 3, minuteWidth: 2, secondWidth: 6 };

function trim(samples) {
  const audible = (value) => Math.abs(value) > model.silence;
  return samples.slice(samples.findIndex(audible), samples.findLastIndex(audible) + 1);
}

/** The line as spoken: each `say` word in the script replaced by how it should sound. */
const spoken = (script, text) => Object.entries(script.say).reduce((words, [word, sound]) => words.replaceAll(word, sound), text);

/** Speak one line into `file`. */
async function take(tts, script, line, file) {
  const speech = await tts.generate(spoken(script, line.en), { voice: script.voice });
  const samples = trim(speech.audio);
  await wav(file, [samples], speech.sampling_rate);
  return { ...line, path: file, length: samples.length / speech.sampling_rate };
}

/** Every line of `script` spoken into `dir`, in order: `{ scene, en, ja, zh, path, length }`. */
export async function speak(script, dir) {
  // Loaded only to speak: its phonemizer hooks uncaught errors and would print itself over a failed shoot's.
  const { KokoroTTS } = await import('kokoro-js');
  const tts = await KokoroTTS.from_pretrained(model.id, { dtype: model.dtype, device: model.device });
  const takes = [];
  for (const [index, line] of script.lines.entries()) takes.push(await take(tts, script, line, path.join(dir, `line${index}.wav`)));
  return takes;
}

function stamp(seconds) {
  const minutes = String(Math.floor(seconds / clock.minute)).padStart(clock.minuteWidth, '0');
  return `${minutes}:${(seconds % clock.minute).toFixed(clock.digits).padStart(clock.secondWidth, '0')}`;
}

/** One WebVTT cue per spoken line in `lang`; the first also names the music that opens the film. */
export function captions(script, lines, lang) {
  const cue = (line, index) =>
    [`${stamp(index === 0 ? 0 : line.start)} --> ${stamp(line.end + pacing.hold)}`, ...(index === 0 ? [script.music[lang]] : []), line[lang]].join('\n');
  return `${['WEBVTT', ...lines.map(cue)].join('\n\n')}\n`;
}

/** `<name>.<lang>.vtt` beside the video, for each language the script is written in. */
export function writeCaptions(script, lines, videos, name) {
  for (const lang of Object.keys(script.music)) fs.writeFileSync(path.join(videos, `${name}.${lang}.vtt`), captions(script, lines, lang));
}
