// [WEB-DESIGN-MEDIA-DISCOVERY] The film a page shares as its social preview, if any:
// base.njk turns it into og:video, the X player card and the page's card image.
import { socialVideo } from "../../video-pages.js";

export default {
  socialVideo: (data) => socialVideo(data.page.url),
};
