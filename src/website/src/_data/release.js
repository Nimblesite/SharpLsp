import markdownIt from "markdown-it";

const REPO = "Nimblesite/SharpLsp";
// Full set powers the on-site /releases/ page; the homepage shows `recent` only.
const MAX_RELEASES = 30;
const RECENT_COUNT = 2;
const API_URL = `https://api.github.com/repos/${REPO}/releases?per_page=${MAX_RELEASES}`;
const RELEASES_URL = `https://github.com/${REPO}/releases`;
const releaseMarkdown = markdownIt({ html: false, linkify: true });

function fallback(reason) {
  if (reason) console.warn(`[_data/release] using fallback — ${reason}`);
  return {
    available: false,
    tag: null,
    version: null,
    url: RELEASES_URL,
    releasesUrl: RELEASES_URL,
    publishedAt: null,
    publishedDate: null,
    items: [],
    recent: [],
  };
}

function versionFromTag(tag) {
  if (!tag) return null;
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

function formatDate(value) {
  if (!value) return null;
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(value));
}

function inlineText(token) {
  return (token.children || [])
    .filter((child) => ["text", "code_inline"].includes(child.type))
    .map((child) => child.content)
    .join(" ")
    .trim();
}

function linkedText(token) {
  const start = (token.children || []).findIndex((child) => child.type === "link_open");
  const linked = start < 0 ? [] : token.children.slice(start + 1);
  const end = linked.findIndex((child) => child.type === "link_close");
  return inlineText({ children: end < 0 ? linked : linked.slice(0, end) });
}

function truncateSummary(summary) {
  return summary.length > 180 ? `${summary.slice(0, 177).trimEnd()}…` : summary;
}

function isWebUrl(value) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function summarizeRelease(body) {
  const tokens = releaseMarkdown.parse(body, {});
  const token = tokens.find((item, index) =>
    item.type === "inline" && tokens[index - 1]?.type !== "heading_open" && inlineText(item),
  );
  const summary = token ? linkedText(token) || inlineText(token) : null;
  return summary && !isWebUrl(summary) ? truncateSummary(summary) : null;
}

function mapRelease(data) {
  const tag = data.tag_name;
  const publishedAt = data.published_at || null;
  return {
    tag,
    version: versionFromTag(tag),
    title: data.name || tag,
    url: data.html_url || RELEASES_URL,
    publishedAt,
    publishedDate: formatDate(publishedAt),
    prerelease: Boolean(data.prerelease),
    summary: summarizeRelease(data.body || ""),
    // Raw GitHub release notes (Markdown). Rendered at build time by the
    // `releaseNotes` filter with raw HTML disabled, so untrusted PR-title
    // content in generated notes cannot inject markup.
    body: data.body || "",
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
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
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
    const items = data.filter((item) => !item.draft).map(mapRelease);
    const latest = items.find((item) => !item.prerelease) || items[0];
    if (!latest) {
      return fallback("response missing releases");
    }

    return {
      available: true,
      tag: latest.tag,
      version: latest.version,
      url: latest.url,
      releasesUrl: RELEASES_URL,
      publishedAt: latest.publishedAt,
      publishedDate: latest.publishedDate,
      items,
      recent: items.slice(0, RECENT_COUNT),
    };
  } catch (err) {
    return fallback(err.message);
  }
}
