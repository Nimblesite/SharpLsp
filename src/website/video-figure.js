// Implements [WEB-DESIGN-MEDIA]. Renders a catalogued video (src/_data/videos.json)
// as a figure plus its schema.org VideoObject, so every page that shows a video
// is also eligible for video results in search.
//
// The catalogue lists every video on the site once: its encodings, size, length
// and the words that describe it in each language. A page names a video with
// `{% video "<id>" %}` and never repeats its markup; files live at
// /assets/videos/<id>.<encoding> beside /assets/videos/<id>-poster.webp.
// The profiler media is rendered by tools/profiler-film/render.mjs. The tour is
// the Marketplace GIF (assets/images/marketplace/sharplsp-tour.gif) re-encoded
// with the same H.264/VP9 settings, because a GIF is eight times the bytes.
import markdownIt from "markdown-it";
import site from "./src/_data/site.json" with { type: "json" };
import videos from "./src/_data/videos.json" with { type: "json" };

const { escapeHtml } = markdownIt().utils;

const asset = (id, suffix) => `/assets/videos/${id}${suffix}`;

/**
 * Docs and articles get a still film with controls. A marketing page may pass
 * `autoplay` for a muted loop; custom.js stills it under reduced motion.
 */
export function videoFigure(id, lang, { caption, autoplay = false } = {}) {
  const video = videos[id];
  if (!video) throw new Error(`No video "${id}" in src/_data/videos.json`);
  const text = video.text[lang] ?? video.text.en;
  return [
    `<figure class="${autoplay ? "product-shot" : "article-figure"}">`,
    `<video ${autoplay ? "autoplay loop" : "controls"} muted playsinline preload="metadata" poster="${asset(id, "-poster.webp")}" width="${video.width}" height="${video.height}" aria-label="${escapeHtml(text.label)}">`,
    ...video.encodings.map((encoding) => `<source src="${asset(id, `.${encoding}`)}" type="video/${encoding}">`),
    "</video>",
    `<figcaption>${caption ?? escapeHtml(text.caption)}</figcaption>`,
    "</figure>",
    `<script type="application/ld+json">${structuredData(id, video, text)}</script>`,
  ].join("\n");
}

// `<` is escaped so no description can close the script element early.
function structuredData(id, video, text) {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "VideoObject",
    name: text.label,
    description: text.caption,
    thumbnailUrl: `${site.url}${asset(id, "-poster.webp")}`,
    contentUrl: `${site.url}${asset(id, `.${video.encodings.at(-1)}`)}`,
    uploadDate: video.uploadDate,
    duration: video.duration,
    width: video.width,
    height: video.height,
  }).replaceAll("<", "\\u003c");
}
