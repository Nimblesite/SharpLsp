// Implements [WEB-DESIGN-MEDIA]. Renders a catalogued video (src/_data/videos.json)
// as a figure plus its schema.org VideoObject, so every page that shows a video
// is also eligible for video results in search.
//
// The catalogue lists every video on the site once: its encodings, size, length,
// the page that explains it, and the words that describe it in each language. A
// page names a video with `{% video "<id>" %}` and never repeats its markup; files
// live at /assets/videos/<id>.<encoding> beside /assets/videos/<id>-poster.webp
// and <id>-card.jpg, and a narrated video's captions at /assets/videos/<id>.<lang>.vtt.
// The profiler media is shot and published by tools/profiler-film (film.mjs and
// films/profiler/render.mjs). The tour is
// the Marketplace GIF (assets/images/marketplace/sharplsp-tour.gif) re-encoded
// with the same H.264/VP9 settings, because a GIF is eight times the bytes.
// MP4 comes first in the catalogue: Windows Chrome/Edge can accept the VP9
// source then fail decoding it, without falling back to the next source.
import markdownIt from "markdown-it";
import i18n from "./src/_data/i18n.json" with { type: "json" };
import languages from "./src/_data/languages.json" with { type: "json" };
import site from "./src/_data/site.json" with { type: "json" };
import { asset, catalogued, embedPath, textOf, transcript, watchPath } from "./video-pages.js";

const { escapeHtml } = markdownIt().utils;

/**
 * A narrated video's captions, one track per language its `captions` lists,
 * at /assets/videos/<id>.<lang>.vtt; the page's own language shows by default.
 */
const tracks = (id, video, lang) =>
  (video.captions ?? []).map(
    (code) => `<track kind="captions" src="${asset(id, `.${code}.vtt`)}" srclang="${code}" label="${languages[code].nativeName}"${code === lang ? " default" : ""}>`,
  );

/**
 * The `<video>` element alone: a figure's player, and the whole of a video's
 * embed page. Docs and articles get a still film with controls, its narration
 * audible. A marketing page may pass `autoplay` for a muted loop; custom.js
 * stills it under reduced motion.
 */
export function videoPlayer(id, lang, { autoplay = false } = {}) {
  const video = catalogued(id);
  return [
    `<video ${autoplay ? "autoplay loop muted" : "controls"} playsinline preload="metadata" poster="${asset(id, "-poster.webp")}" width="${video.width}" height="${video.height}" aria-label="${escapeHtml(textOf(video, lang).label)}">`,
    ...video.encodings.map((encoding) => `<source src="${asset(id, `.${encoding}`)}" type="video/${encoding}">`),
    ...tracks(id, video, lang),
    "</video>",
  ].join("\n");
}

/**
 * A docs or article figure links to the video's own watch page
 * ([WEB-DESIGN-MEDIA-DISCOVERY]); the watch page itself, and a marketing loop, do not.
 */
const watchLink = (id, lang, linked) =>
  linked ? ` <a href="${watchPath(id, lang)}">${escapeHtml(i18n[lang].video.watchPage)}</a>` : "";

export function videoFigure(id, lang, { caption, autoplay = false, watch = false } = {}) {
  const video = catalogued(id);
  const text = textOf(video, lang);
  return [
    `<figure class="${autoplay ? "product-shot" : "article-figure"}">`,
    videoPlayer(id, lang, { autoplay }),
    `<figcaption>${caption ?? escapeHtml(text.caption)}${watchLink(id, lang, !autoplay && !watch)}</figcaption>`,
    "</figure>",
    `<script type="application/ld+json">${structuredData(id, video, lang, watch)}</script>`,
  ].join("\n");
}

/**
 * What only a watch page claims: Google's key moments, seeking through `?t=`
 * (custom.js), and the narration as text.
 */
function watchOnly(id, lang) {
  const spoken = transcript(id, lang);
  return {
    potentialAction: {
      "@type": "SeekToAction",
      target: `${site.url}${watchPath(id, lang)}?t={seek_to_second_number}`,
      "startOffset-input": "required name=seek_to_second_number",
    },
    ...(spoken.length > 0 ? { transcript: spoken.join(" ") } : {}),
  };
}

// `<` is escaped so no description can close the script element early.
function structuredData(id, video, lang, watch) {
  const text = textOf(video, lang);
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "VideoObject",
    name: text.label,
    description: text.caption,
    thumbnailUrl: `${site.url}${asset(id, "-poster.webp")}`,
    contentUrl: `${site.url}${asset(id, `.${video.encodings[0]}`)}`,
    embedUrl: `${site.url}${embedPath(id, lang)}`,
    uploadDate: video.uploadDate,
    duration: video.duration,
    width: video.width,
    height: video.height,
    ...(watch ? watchOnly(id, lang) : {}),
  }).replaceAll("<", "\\u003c");
}
