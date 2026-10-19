// [WEB-DESIGN-MEDIA-DISCOVERY] The film a page shares as its social preview, if any:
// base.njk turns it into og:video, the X player card and the page's card image.
import { socialVideo } from "../../video-pages.js";

export default {
  socialVideo: (data) => socialVideo(data.page.url),
  // When a page was published: a watch page when its video was uploaded, for it has
  // no file of its own whose date means anything, and every other page on its own date.
  published: (data) => {
    const film = socialVideo(data.page.url);
    return film?.watch === data.page.url ? film.uploadDate : data.page.date;
  },
};
