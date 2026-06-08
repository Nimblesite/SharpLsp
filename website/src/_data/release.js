const REPO = "Nimblesite/SharpLsp";
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_URL = `https://github.com/${REPO}/releases`;

function fallback(reason) {
  if (reason) console.warn(`[_data/release] using fallback — ${reason}`);
  return {
    available: false,
    tag: null,
    version: null,
    url: RELEASES_URL,
    publishedAt: null,
  };
}

export default async function () {
  if (process.env.SHARPLSP_SKIP_RELEASE_FETCH === "1") {
    return fallback("SHARPLSP_SKIP_RELEASE_FETCH=1");
  }

  const headers = {
    "User-Agent": "sharplsp-website-build",
    Accept: "application/vnd.github+json",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(API_URL, { headers, signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) {
      return fallback(`GitHub API responded ${response.status}`);
    }

    const data = await response.json();
    if (!data.tag_name) {
      return fallback("response missing tag_name");
    }

    return {
      available: true,
      tag: data.tag_name,
      version: data.tag_name.replace(/^v/, ""),
      url: data.html_url || RELEASES_URL,
      publishedAt: data.published_at || null,
    };
  } catch (err) {
    return fallback(err.message);
  }
}
