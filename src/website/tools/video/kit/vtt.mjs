// Implements [WEB-DESIGN-MEDIA]. WebVTT, the text tracks a film publishes beside
// its video: captions ([WEB-DESIGN-MEDIA]) and chapters ([WEB-DESIGN-MEDIA-CHAPTERS]).
const clock = { minute: 60, digits: 3, minuteWidth: 2, secondWidth: 6 };

/** `seconds` as a WebVTT timestamp, `mm:ss.ttt`. */
export function stamp(seconds) {
  const minutes = String(Math.floor(seconds / clock.minute)).padStart(clock.minuteWidth, '0');
  return `${minutes}:${(seconds % clock.minute).toFixed(clock.digits).padStart(clock.secondWidth, '0')}`;
}

/** The cue lines from `from` to `to` seconds: an optional identifier, the timing, then the text. */
export const cue = ({ id, from, to, text }) => [...(id ? [id] : []), `${stamp(from)} --> ${stamp(to)}`, ...[text].flat()].join('\n');

/** A WebVTT file of `cues`. */
export const webVtt = (cues) => `${['WEBVTT', ...cues.map(cue)].join('\n\n')}\n`;
