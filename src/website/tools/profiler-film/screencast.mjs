// Records a page through CDP's screencast and encodes it as a constant-rate clip.
// The screencast only emits a frame when the compositor paints, so each frame is
// held until the next one's timestamp: the encoded clip runs in real time.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const FPS = 30;

/** Start recording `cdp`'s page into `dir`; resolves to a `stop(outFile)` that encodes the clip. */
export async function startScreencast(cdp, dir) {
  const { frames, onFrame } = frameWriter(cdp, dir);
  cdp.on('Page.screencastFrame', onFrame);
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 95,
    maxWidth: 3200,
    maxHeight: 2000,
    everyNthFrame: 1,
  });
  return async (outFile) => {
    await cdp.send('Page.stopScreencast');
    cdp.off('Page.screencastFrame', onFrame);
    encode(frames, Date.now() / 1000, outFile);
    return outFile;
  };
}

/** Writes each screencast frame to `dir` with its timestamp, and acknowledges it. */
function frameWriter(cdp, dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const frames = [];
  const onFrame = ({ data, metadata, sessionId }) => {
    const file = path.join(dir, `${String(frames.length).padStart(6, '0')}.jpg`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    frames.push({ file, at: metadata.timestamp });
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => undefined);
  };
  return { frames, onFrame };
}

/** One concat-demuxer entry per frame, each held until the next frame (the last until `endAt`). */
function concatList(frames, endAt) {
  const lines = ['ffconcat version 1.0'];
  frames.forEach((frame, index) => {
    const next = frames[index + 1]?.at ?? endAt;
    lines.push(`file '${frame.file}'`, `duration ${Math.max(next - frame.at, 1 / FPS).toFixed(4)}`);
  });
  lines.push(`file '${frames.at(-1).file}'`);
  return `${lines.join('\n')}\n`;
}

function encode(frames, endAt, outFile) {
  if (frames.length === 0) throw new Error(`no screencast frames for ${outFile}`);
  const list = path.join(path.dirname(frames[0].file), 'frames.ffconcat');
  fs.writeFileSync(list, concatList(frames, endAt));
  const args = ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list];
  const video = ['-vf', `fps=${FPS},format=yuv420p`, '-c:v', 'libx264', '-preset', 'slow', '-crf', '12'];
  const result = spawnSync('ffmpeg', [...args, ...video, '-movflags', '+faststart', outFile], {
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`ffmpeg failed for ${outFile}: ${result.stderr}`);
}
