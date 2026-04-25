import { HtmlBasePlugin } from "@11ty/eleventy";
import techdoc from "eleventy-plugin-techdoc";

export default function (eleventyConfig) {
  eleventyConfig.addPlugin(techdoc, {
    site: {
      name: "Forge",
      url: "https://forge-lsp.dev",
      description:
        "Open-source .NET LSP for C# and F#. One server, every editor.",
    },
    features: {
      blog: true,
      docs: true,
      darkMode: true,
      i18n: true,
    },
    i18n: {
      defaultLanguage: 'en',
      languages: ['en', 'zh'],
    },
  });

  eleventyConfig.addPlugin(HtmlBasePlugin);
  eleventyConfig.addPassthroughCopy("src/assets");

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
    pathPrefix: "/forge/",
  };
}
