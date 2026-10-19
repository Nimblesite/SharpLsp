// [WEB-DESIGN-MEDIA-DISCOVERY] A watch page and its embed take their language,
// title and description from the video they show.
export default {
  eleventyComputed: {
    lang: (data) => data.watch.lang,
    title: (data) => data.watch.label,
    description: (data) => data.watch.caption,
  },
};
