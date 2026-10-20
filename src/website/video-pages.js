// Implements [WEB-DESIGN-MEDIA-DISCOVERY]. Where each catalogued video
// (src/_data/videos.json) lives beyond the page that shows it: a watch page per
// video and language at /videos/<id>/, the bare player at /videos/<id>/embed/
// that X cards and Google's embedUrl load, its social card at
// /assets/videos/<id>-card.jpg, and the transcript read from its captions.
import { readFileSync } from "fs";
import languages from "./src/_data/languages.json" with { type: "json" };
import videos from "./src/_data/videos.json" with { type: "json" };

export const asset = (id, suffix) => `/assets/videos/${id}${suffix}`;

/** `path` in `lang`: English at the root, every other language under /<lang>. */
export const localized = (lang, path) => (lang === "en" ? path : `/${lang}${path}`);

export const watchPath = (id, lang) => localized(lang, `/videos/${id}/`);
export const embedPath = (id, lang) => `${watchPath(id, lang)}embed/`;

/** A catalogued video, or a build error naming the missing id. */
export function catalogued(id) {
  const video = videos[id];
  if (!video) throw new Error(`No video "${id}" in src/_data/videos.json`);
  return video;
}

/** The label and caption of `video` in `lang`, English when it has no translation. */
export const textOf = (video, lang) => video.text[lang] ?? video.text.en;

/** An ISO 8601 duration such as `PT1M4S`, in whole seconds. */
export function seconds(duration) {
  const [, minutes = "0", rest] = duration.match(/^PT(?:(\d+)M)?(\d+)S$/);
  return Number(minutes) * 60 + Number(rest);
}

/** Everything a page needs to show, share and describe video `id` in `lang`. */
export function videoMeta(id, lang) {
  const video = catalogued(id);
  const { label, caption } = textOf(video, lang);
  return {
    id, lang, label, caption,
    width: video.width, height: video.height, uploadDate: video.uploadDate, seconds: seconds(video.duration),
    poster: asset(id, "-poster.webp"), card: asset(id, "-card.jpg"), stream: asset(id, ".mp4"),
    watch: watchPath(id, lang), embed: embedPath(id, lang), page: localized(lang, video.page),
  };
}

/** One cue's spoken words; a sound cue such as `[Gentle music]` says nothing. */
const cueText = (cue) =>
  cue.split(/\r?\n/).filter((line) => !line.includes("-->") && !/^\[.*\]$/.test(line.trim())).join(" ").trim();

/** The narration of `id` in `lang`, one entry per caption cue; empty when it has no captions there. */
export function transcript(id, lang) {
  if (!(catalogued(id).captions ?? []).includes(lang)) return [];
  const vtt = readFileSync(new URL(`./src${asset(id, `.${lang}.vtt`)}`, import.meta.url), "utf8");
  return vtt.split(/\r?\n\r?\n/).slice(1).map(cueText).filter(Boolean);
}

/** Every watch page: each catalogued video in each site language. */
export const watchPages = () =>
  Object.keys(languages).flatMap((lang) =>
    Object.keys(videos).map((id) => ({ ...videoMeta(id, lang), transcript: transcript(id, lang) })),
  );

/**
 * The film a page shares as its social preview: a watch page its own video, a
 * docs page the first catalogued video whose `page` it is. The docs entries are
 * reversed so that, as the Map keeps the last value per key, the first one wins.
 */
function previewEntries(lang) {
  const docs = Object.entries(videos)
    .filter(([, video]) => video.page.startsWith("/docs/"))
    .map(([id, video]) => [localized(lang, video.page), id])
    .reverse();
  const watches = Object.keys(videos).map((id) => [watchPath(id, lang), id]);
  return [...docs, ...watches].map(([url, id]) => [url, videoMeta(id, lang)]);
}

const previews = new Map(Object.keys(languages).flatMap(previewEntries));

/** The social-preview film for the page at `url`, if it has one. */
export const socialVideo = (url) => previews.get(url);
