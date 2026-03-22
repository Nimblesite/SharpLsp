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
      i18n: false,
    },
  });

  eleventyConfig.addPlugin(HtmlBasePlugin);
  eleventyConfig.addPassthroughCopy("src/assets");

  return {
    dir: { input: "src", output: "_site" },
    markdownTemplateEngine: "njk",
    pathPrefix: "/forge/",
  };
}
