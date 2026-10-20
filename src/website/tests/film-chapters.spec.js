// Tests for [WEB-DESIGN-MEDIA-CHAPTERS]: the chapters a walkthrough's scenes mark,
// timed in its cut and published as the WebVTT track the VS Code tutorial plays.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { chaptersOf, chaptersTrack, startOf } from '../tools/video/kit/chapters.mjs';
import { captions } from '../tools/video/kit/sound/voice.mjs';
import { stamp, webVtt } from '../tools/video/kit/vtt.mjs';

const videos = path.resolve(import.meta.dirname, '../src/assets/videos');

/** A shot of `length` seconds, held `hold` more, marked with `chapter`. */
const shot = (clip, length, chapter, hold) => ({ clip, length, hold, chapter, title: chapter && `${clip} caption` });

const FILM = [
  shot('intro', 4),
  shot('fsharp', 6.5, 'FSharp.Hover', 1.25),
  shot('union', 5, 'FSharp.Hover'),
  shot('csharp', 7, 'CSharp.Hover', 0.5),
  shot('outro', 3),
];

/** Each cue of a WebVTT file: its identifier, its times in seconds, its text. */
function cuesOf(vtt) {
  const seconds = (time) => time.split(':').reduce((total, part) => total * 60 + Number(part), 0);
  return vtt
    .trimEnd()
    .split('\n\n')
    .slice(1)
    .map((block) => block.split('\n'))
    .map(([id, timing, ...text]) => {
      const [from, to] = timing.split(' --> ').map(seconds);
      return { id, from, to, text: text.join('\n') };
    });
}

test.describe('Film chapters [WEB-DESIGN-MEDIA-CHAPTERS]', () => {
  test('consecutive shots of one chapter make one span, timed with every hold before it', () => {
    const chapters = chaptersOf(FILM);
    expect(chapters.map((chapter) => chapter.id)).toEqual(['FSharp.Hover', 'CSharp.Hover']);
    expect(chapters[0]).toEqual({ id: 'FSharp.Hover', title: 'fsharp caption', from: 4, to: 16.75 });
    expect(chapters[1]).toEqual({ id: 'CSharp.Hover', title: 'csharp caption', from: 16.75, to: 24.25 });
    expect(startOf(FILM, FILM.length)).toBe(27.25);
  });

  test('unmarked shots belong to no chapter, and a chapter marked twice apart fails the film', () => {
    expect(chaptersOf([shot('a', 3), shot('b', 2)])).toEqual([]);
    const split = [shot('a', 2, 'FSharp.Hover'), shot('b', 2), shot('c', 2, 'FSharp.Hover')];
    expect(() => chaptersOf(split)).toThrow('chapter "FSharp.Hover" marks shots that are not consecutive');
    const untitled = chaptersOf([{ clip: 'a', length: 2, chapter: 'SolutionExplorer' }]);
    expect(untitled).toEqual([{ id: 'SolutionExplorer', title: 'SolutionExplorer', from: 0, to: 2 }]);
  });

  test('the track names each cue by its chapter, so the tutorial finds its step by id', () => {
    const track = chaptersTrack(chaptersOf(FILM));
    expect(track.startsWith('WEBVTT\n\nFSharp.Hover\n00:04.000 --> 00:16.750\nfsharp caption\n\n')).toBe(true);
    const cues = cuesOf(track);
    expect(cues).toEqual([
      { id: 'FSharp.Hover', from: 4, to: 16.75, text: 'fsharp caption' },
      { id: 'CSharp.Hover', from: 16.75, to: 24.25, text: 'csharp caption' },
    ]);
    expect(track.endsWith('\n')).toBe(true);
  });

  test('timestamps run past the minute, and captions share the one WebVTT writer', () => {
    expect(stamp(0)).toBe('00:00.000');
    expect(stamp(83.5)).toBe('01:23.500');
    expect(webVtt([{ from: 1, to: 2, text: ['music', 'line'] }])).toBe('WEBVTT\n\n00:01.000 --> 00:02.000\nmusic\nline\n');
    const script = { music: { en: '[music]' }, pacing: { hold: 0.3 } };
    const lines = [{ start: 1, end: 2, en: 'One.' }, { start: 2.1, end: 3, en: 'Two.' }];
    expect(captions(script, lines, 'en')).toBe('WEBVTT\n\n00:00.000 --> 00:02.100\n[music]\nOne.\n\n00:02.100 --> 00:03.300\nTwo.\n');
  });

  test('every published chapters track is well formed: ordered, non-overlapping spans with unique ids', () => {
    const tracks = fs.readdirSync(videos).filter((file) => file.endsWith('.chapters.vtt'));
    for (const file of tracks) {
      const cues = cuesOf(fs.readFileSync(path.join(videos, file), 'utf8'));
      expect(cues.length, file).toBeGreaterThan(0);
      expect(new Set(cues.map((cue) => cue.id)).size, file).toBe(cues.length);
      cues.forEach((cue, index) => {
        expect(cue.to, `${file} ${cue.id}`).toBeGreaterThan(cue.from);
        expect(cue.from, `${file} ${cue.id}`).toBeGreaterThanOrEqual(cues[index - 1]?.to ?? 0);
        expect(cue.id, file).toMatch(/^((FSharp|CSharp)\.)?[A-Z][A-Za-z]+$/);
      });
    }
  });
});
