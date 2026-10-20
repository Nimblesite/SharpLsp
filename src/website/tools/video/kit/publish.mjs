// Implements [WEB-DESIGN-MEDIA]. What every film does once its picture exists: the
// site's MP4 and WebM, and, for a narrated film, the voice, score and captions
// laid under it. Walkthroughs cut their picture from clips, lessons render theirs
// from slides; both publish through here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AAC, H264, OPUS, VP9, audible, ffmpeg, videos } from './encode.mjs';
import { soundtrack } from './sound/soundtrack.mjs';
import { writeCaptions } from './sound/voice.mjs';

/** The site's MP4 and WebM of `master`, with `audio` as their soundtrack when there is one. */
export function publishEncodes(name, master, audio) {
  for (const [video, sound, extension] of [[H264, AAC, 'mp4'], [VP9, OPUS, 'webm']]) {
    const inputs = audio ? ['-i', master, '-i', audio, '-map', '0:v', '-map', '1:a', ...audible(video), ...sound, '-shortest'] : ['-i', master, ...video];
    ffmpeg([...inputs, path.join(videos, `${name}.${extension}`)], `${name} ${extension}`);
  }
}

/**
 * Speak `script` over `shots`, then publish the picture `picture(film)` makes from
 * the timed film (each shot held until its lines end) with that soundtrack and
 * its captions. Resolves to the film's length in seconds.
 */
export async function narrated(name, script, shots, picture) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-sound-`));
  try {
    const film = await soundtrack(script, shots, dir);
    publishEncodes(name, await picture(film), film.audio);
    writeCaptions(script, film.lines, videos, name);
    return film.duration;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
