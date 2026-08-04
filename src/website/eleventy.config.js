import { HtmlBasePlugin } from "@11ty/eleventy";
import techdoc from "eleventy-plugin-techdoc";
import markdownIt from "markdown-it";
import { existsSync, lstatSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginLayouts = join(__dirname, "node_modules/eleventy-plugin-techdoc/templates/layouts");
const pluginPages = join(__dirname, "node_modules/eleventy-plugin-techdoc/templates/pages");
const localLayouts = join(__dirname, "src/_includes/layouts");
const localOverrides = join(__dirname, "src/_includes/overrides");
const outputDir = join(__dirname, "_site");

function removeOutputSymlinks(directory) {
  if (!existsSync(directory)) {
    return;
  }

  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      unlinkSync(path);
    } else if (stat.isDirectory()) {
      removeOutputSymlinks(path);
    }
  }
}

// Techdoc 0.2 registers virtual templates without an override hook. Keep the
// site-owned sources durable and copy only the templates the plugin registers.
for (const file of ["base.njk", "blog.njk", "docs.njk"]) {
  const local = join(localLayouts, file);
  if (existsSync(local)) {
    writeFileSync(join(pluginLayouts, file), readFileSync(local, "utf-8"));
  }
}

// Patch the virtual blog pages from stable, site-owned override files. Never
// delete or move these sources: repeated builds must produce identical output.
for (const [target, source] of [
  ["index.njk", "blog-index.njk"],
  ["tags.njk", "tags-index.njk"],
  ["tags-pages.njk", "tags-pages.njk"],
  ["categories.njk", "categories-index.njk"],
  ["categories-pages.njk", "categories-pages.njk"],
]) {
  const local = join(localOverrides, source);
  if (existsSync(local)) {
    writeFileSync(join(pluginPages, "blog", target), readFileSync(local, "utf-8"));
  }
}

export default function (eleventyConfig) {
  eleventyConfig.on("eleventy.before", () => {
    removeOutputSymlinks(outputDir);
  });

  eleventyConfig.addPlugin(techdoc, {
    site: {
      name: "SharpLsp",
      url: "https://sharplsp.dev",
      description: "A complete open-source C# and F# development experience for every editor.",
      stylesheet: "/assets/css/styles.css",
    },
    features: {
      blog: true,
      docs: true,
      darkMode: true,
      i18n: true,
    },
    i18n: {
      defaultLanguage: 'en',
      languages: ['en', 'zh', 'ja'],
    },
  });

  eleventyConfig.addPlugin(HtmlBasePlugin);

  // Renders GitHub release notes (Markdown) on the /releases/ page. Raw HTML is
  // disabled so untrusted content carried in auto-generated notes (PR titles,
  // contributor handles) can never inject markup; linkify turns bare URLs into
  // links.
  const releaseNotesMd = markdownIt({ html: false, linkify: true, breaks: false });
  eleventyConfig.addFilter("releaseNotes", (body) =>
    body ? releaseNotesMd.render(body) : "",
  );

  eleventyConfig.addPassthroughCopy("src/assets");
  eleventyConfig.addPassthroughCopy("src/favicon.ico");
  eleventyConfig.addPassthroughCopy("src/favicon.svg");
  eleventyConfig.addPassthroughCopy("src/favicon-16x16.png");
  eleventyConfig.addPassthroughCopy("src/favicon-32x32.png");
  eleventyConfig.addPassthroughCopy("src/apple-touch-icon.png");
  eleventyConfig.addPassthroughCopy("src/android-chrome-192x192.png");
  eleventyConfig.addPassthroughCopy("src/android-chrome-512x512.png");

  // Build a map of author name -> author page data, keyed by the author's title field
  eleventyConfig.addCollection("authorsByName", (api) => {
    const map = {};
    api.getFilteredByGlob("src/author/*.md").forEach((page) => {
      if (page.data.title) map[page.data.title] = page.data;
    });
    return map;
  });

  eleventyConfig.addCollection("authorsByNameByLang", (api) => {
    const map = {};
    const pages = [
      ...api.getFilteredByGlob("src/author/*.md"),
      ...api.getFilteredByGlob("src/*/author/*.md"),
    ];
    pages.forEach((page) => {
      const pageLang = page.data.lang || "en";
      if (page.data.title) map[`${pageLang}:${page.data.title}`] = page.data;
      if (page.data.authorSlug) map[`${pageLang}:${page.data.authorSlug}`] = page.data;
    });
    return map;
  });

  eleventyConfig.addTransform("nimblesite-footer", function (content) {
    if (!this.page.outputPath?.endsWith(".html")) {
      return content;
    }
    const year = new Date().getFullYear();
    const original = `&copy; ${year} SharpLsp`;
    const replacement = `&copy; ${year} <a href="https://nimblesite.co">NIMBLESITE</a>`;
    return content.replace(original, replacement);
  });

  return {
    dir: { input: "src", output: "_site" },
    markdownTemplateEngine: "njk",
    pathPrefix: "/",
  };
}
