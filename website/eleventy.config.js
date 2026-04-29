import { HtmlBasePlugin } from "@11ty/eleventy";
import techdoc from "eleventy-plugin-techdoc";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginLayouts = join(__dirname, "node_modules/eleventy-plugin-techdoc/templates/layouts");
const pluginPages = join(__dirname, "node_modules/eleventy-plugin-techdoc/templates/pages");
const localLayouts = join(__dirname, "src/_includes/layouts");
const localOverrides = join(__dirname, "src/_includes/overrides");

// Patch plugin layouts with local overrides before Eleventy registers virtual templates
for (const file of ["base.njk", "blog.njk", "docs.njk", "prose.njk", "author.njk"]) {
  const local = join(localLayouts, file);
  if (existsSync(local)) {
    writeFileSync(join(pluginLayouts, file), readFileSync(local, "utf-8"));
  }
}

// Patch plugin page templates (tags, categories) with blog-grid style overrides
for (const file of ["tags-pages.njk", "categories-pages.njk"]) {
  const local = join(localOverrides, file);
  if (existsSync(local)) {
    writeFileSync(join(pluginPages, "blog", file), readFileSync(local, "utf-8"));
  }
}

export default function (eleventyConfig) {
  eleventyConfig.addPlugin(techdoc, {
    site: {
      name: "SharpLsp",
      url: "https://sharplsp.dev",
      description: "Open-source .NET language server for C# and F#. One server, every editor.",
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
    const original = `&copy; ${year} Forge`;
    const replacement = `&copy; ${year} <a href="https://nimblesite.co">NIMBLESITE</a>`;
    return content.replace(original, replacement);
  });

  return {
    dir: { input: "src", output: "_site" },
    markdownTemplateEngine: "njk",
    pathPrefix: "/",
  };
}
