# Design System

Forge's visual identity and component guidelines. All colors were generated via random color wheel selection — zero hand-picked "designer" colors, zero LLM defaults.

## Color Palette

### Generation Method

Primary hue selected by RNG from 0-359 color wheel (excluding 240-330 to avoid purple/magenta). Accent hue offset by a random triadic interval. Neutrals are desaturated tints of the primary.

### Primary — Hue 151 (Teal-Green)

| Token | Hex | Usage |
|-------|-----|-------|
| `--color-primary-300` | `#84d6ae` | Hover backgrounds, light accents |
| `--color-primary-400` | `#49d491` | Secondary buttons, links on dark bg |
| `--color-primary-500` | `#19d078` | **Primary brand color**, buttons, links |
| `--color-primary-600` | `#14a35e` | Hover state for primary actions |
| `--color-primary-700` | `#0f7f49` | Active/pressed states, dark accents |

### Accent — Hue 16 (Burnt Sienna)

| Token | Hex | Usage |
|-------|-----|-------|
| `--color-accent-400` | `#c67456` | Hover state for accent elements |
| `--color-accent-500` | `#b54f2a` | **Accent color**, callouts, badges |
| `--color-accent-600` | `#8c3d20` | Hover state for accent actions |

### Neutrals

| Token | Hex | Usage |
|-------|-----|-------|
| `--color-neutral-50` | `#f6f7f7` | Page background (light) |
| `--color-neutral-100` | `#eef0ef` | Card/surface background (light) |
| `--color-neutral-200` | `#dee1e0` | Borders (light) |
| `--color-neutral-300` | `#c4c9c6` | Disabled text, subtle borders |
| `--color-neutral-400` | `#8b928e` | Muted text, placeholders |
| `--color-neutral-500` | `#6c7370` | Secondary text |
| `--color-neutral-600` | `#48504c` | Body text (dark mode) |
| `--color-neutral-700` | `#2a312e` | Headings (dark mode), borders (dark) |
| `--color-neutral-800` | `#161c19` | Surface background (dark) |
| `--color-neutral-900` | `#0d110f` | Page background (dark) |

### Semantic

| Token | Hex | Usage |
|-------|-----|-------|
| `--color-success` | `#249c64` | Success states, passing tests |
| `--color-warning` | `#e29d12` | Warnings, deprecation notices |
| `--color-error` | `#c72e23` | Errors, breaking changes |
| `--color-info` | `#277cb9` | Informational callouts |

## Typography

### Font Stack

```css
font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
  "Helvetica Neue", Arial, sans-serif;
```

System fonts only. No external font requests. Instant rendering.

### Monospace Stack

```css
font-family: "SF Mono", "Cascadia Code", "Fira Code", Consolas,
  "Liberation Mono", Menlo, monospace;
```

### Scale

| Element | Size | Weight | Line Height |
|---------|------|--------|-------------|
| `h1` | 2rem | 700 | 1.2 |
| `h2` | 1.4rem | 700 | 1.3 |
| `h3` | 1.1rem | 600 | 1.4 |
| Body | 1rem | 400 | 1.7 |
| Small / Muted | 0.925rem | 400 | 1.6 |
| Code | 0.875rem | 400 | 1.6 |

## Spacing

All spacing uses a 4px base unit. Prefer multiples: 4, 8, 12, 16, 24, 32, 48, 64.

| Token | Value | Usage |
|-------|-------|-------|
| `--space-1` | 0.25rem (4px) | Tight gaps, inline padding |
| `--space-2` | 0.5rem (8px) | Button padding, small gaps |
| `--space-3` | 0.75rem (12px) | Card padding, nav items |
| `--space-4` | 1rem (16px) | Standard spacing |
| `--space-6` | 1.5rem (24px) | Section gaps |
| `--space-8` | 2rem (32px) | Page padding |
| `--space-12` | 3rem (48px) | Section padding |
| `--space-16` | 4rem (64px) | Major section breaks |

## Border Radius

| Token | Value | Usage |
|-------|-------|-------|
| `--radius-sm` | 3px | Code inline, small badges |
| `--radius-md` | 6px | Buttons, inputs |
| `--radius-lg` | 8px | Cards, code blocks |

## Layout

### Max Widths

| Context | Width |
|---------|-------|
| Content area | 1100px |
| Blog / prose | 700px |
| Docs sidebar | 240px |

### Breakpoints

| Name | Width | Behavior |
|------|-------|----------|
| Mobile | ≤768px | Single column, collapsed nav |
| Desktop | >768px | Multi-column, full nav |

## Components

### Buttons

```html
<a href="#" class="btn btn-primary">Primary Action</a>
<a href="#" class="btn btn-secondary">Secondary Action</a>
```

- Primary: `--color-primary-500` background, white text
- Secondary: transparent background, border, current text color
- All buttons: 6px radius, 600 weight, 0.75rem/1.75rem padding

### Feature Cards

```html
<div class="feature-card">
  <h3>Title</h3>
  <p>Description</p>
</div>
```

- 1px border using `--color-border`
- 8px radius
- 1.5rem padding
- Surface background

### Code Blocks

- Background: `--color-code-bg`
- 1px border
- 6px radius
- Syntax highlighting via Prism (eleventy-plugin-syntaxhighlight)

## Dark Mode

Dark mode is toggled via `data-theme="dark"` on `<html>`. The theme toggle persists to `localStorage`.

Every color token must have both light and dark values defined in `:root` and `[data-theme="dark"]` respectively. Never hardcode hex values outside CSS custom properties.

## Favicon

SVG favicon at `/assets/favicon.svg`. The `site.json` data file drives the `<link rel="icon">` tag via the theme's `base.njk` template.

## Rules

1. **No purple.** Not even a little. Not even "it's more of a violet." No.
2. **No external font/icon CDN requests.** System fonts, inline SVGs.
3. **Name CSS classes after what the element IS**, not what section it's in.
4. **Minimize CSS classes.** Consolidate where possible.
5. All colors via CSS custom properties. Zero hardcoded hex in component styles.
6. Mobile-first: single column is the default, multi-column is the enhancement.
