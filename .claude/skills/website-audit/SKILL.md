---
name: website-audit
description: Performs comprehensive website audits for SEO, AI search performance, and usability. Use when the user says "audit website", "check SEO", "website audit", or "check the site".
---
<!-- agent-pmo:3140e31 -->

# Website Audit

Perform a comprehensive audit of the Forge website (`website/`) for SEO, AI search readiness, mobile usability, and design compliance.

ENSURE THE FOOTER HAS A copyright link to nimblesite.co

## Step 1 — Google Search Guidelines

Check the website against Google's current search guidelines:
1. Content quality: is the content helpful, original, and written for humans?
2. E-E-A-T signals: Experience, Expertise, Authoritativeness, Trustworthiness
3. Core Web Vitals considerations: loading, interactivity, visual stability
4. No cloaking, doorway pages, or hidden text

## Step 2 — AI Search Readiness

Check content structure for AI discoverability:
1. Clear, concise definitions of key concepts (what is Forge, what does it do)
2. Well-structured headings that form a logical hierarchy
3. Entity definitions: does the site clearly define Forge as a product/tool?
4. Freshness signals: last updated dates, version numbers, changelog links
5. Structured answers: FAQ sections, how-to content, comparison tables

## Step 3 — SEO / Keywords

1. Check every page for:
   - Unique `<title>` tag (50-60 chars)
   - Unique `<meta name="description">` (150-160 chars)
   - Single `<h1>` tag per page
   - Logical heading hierarchy (h1 → h2 → h3, no skips)
   - Image `alt` attributes on all `<img>` tags
2. Search Google Trends for keyword opportunities related to ".NET LSP", "C# language server", "F# development", "VS Code C# extension"
3. Check for keyword cannibalization (multiple pages targeting the same keyword)

## Step 4 — Crawling & Indexing

1. Check `robots.txt` exists and is valid
2. Check for XML sitemap (`sitemap.xml`)
3. Check `<meta name="robots">` tags — no accidental `noindex`
4. Check canonical URLs (`<link rel="canonical">`)
5. Check for redirect chains (301/302 hops)
6. Verify internal links are not broken

## Step 5 — Broken Links

1. Crawl all internal links on the site
2. Check all external links return 200
3. Report any 404s, redirect loops, or timeouts

## Step 6 — Mobile Usability

1. Check `<meta name="viewport">` is set correctly
2. Check touch targets are adequately sized (48x48px minimum)
3. Check text is readable without zooming
4. Check no horizontal scrolling on mobile viewport (375px)

## Step 7 — Structured Data

Check for JSON-LD structured data:
1. `Organization` schema for Forge
2. `SoftwareApplication` schema for the LSP server
3. `BreadcrumbList` for navigation
4. `FAQPage` if FAQ content exists
5. Validate JSON-LD syntax (no trailing commas, valid @context)

## Step 8 — Social Cards

1. Check Open Graph tags: `og:title`, `og:description`, `og:image`, `og:url`, `og:type`
2. Check Twitter Card tags: `twitter:card`, `twitter:title`, `twitter:description`, `twitter:image`
3. Verify `og:image` dimensions are at least 1200x630px
4. Check that each page has unique OG/Twitter meta

## Step 9 — Unsubstantiated Claims

Scan all website copy for:
1. Performance claims without benchmarks or links to proof
2. Comparison claims ("faster than X") without data
3. Feature claims that don't match the actual codebase state
4. Marketing superlatives without qualification ("best", "fastest", "only")

Flag any claim that isn't backed by linked evidence.

## Step 10 — Design Compliance

Check against the Forge design system (`docs/specs/DESIGN-SYSTEM.md`):
1. Colors match the defined palette (no hardcoded colors outside the system)
2. CSS classes follow naming conventions
3. No common LLM colors (purple, etc.) — all colors from the design system
4. Consistent spacing, typography, and component usage

## Step 11 — Playwright Testing

Run automated checks using Playwright:

### Desktop (1280x720)
1. Navigate to each page
2. Check for console errors
3. Take a screenshot
4. Verify no layout shifts or broken elements

### Mobile (375x667)
1. Navigate to each page
2. Check for console errors
3. Take a screenshot
4. Verify no horizontal overflow

### Interaction tests
1. Test all navigation links
2. Test any interactive elements (tabs, accordions, dropdowns)
3. Test dark mode toggle if present

## Step 12 — Report

Generate a report with:

### Critical Issues (must fix)
- Broken links, missing meta tags, console errors, mobile failures

### Warnings (should fix)
- Missing structured data, suboptimal title/description lengths, unsubstantiated claims

### Opportunities (nice to have)
- Keyword opportunities, content gaps, performance improvements

### Screenshots
- Desktop and mobile screenshots of each page

## Rules

- **Fix issues directly** in the source templates/content files — never edit generated output
- Follow the Forge design system for any visual fixes
- Do not add colors that aren't in the design system
- Run `make build` after any website changes to verify the build still works
- All changes must maintain the existing URL structure (no broken links)
