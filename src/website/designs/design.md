---
name: High-Tech Developer System
colors:
  surface: '#131313'
  surface-dim: '#131313'
  surface-bright: '#3a3939'
  surface-container-lowest: '#0e0e0e'
  surface-container-low: '#1c1b1b'
  surface-container: '#201f1f'
  surface-container-high: '#2a2a2a'
  surface-container-highest: '#353534'
  on-surface: '#e5e2e1'
  on-surface-variant: '#bacbb9'
  inverse-surface: '#e5e2e1'
  inverse-on-surface: '#313030'
  outline: '#859585'
  outline-variant: '#3b4a3d'
  surface-tint: '#00e475'
  primary: '#75ff9e'
  on-primary: '#003918'
  primary-container: '#00e676'
  on-primary-container: '#00612e'
  inverse-primary: '#006d35'
  secondary: '#c8c6c5'
  on-secondary: '#313030'
  secondary-container: '#474746'
  on-secondary-container: '#b7b5b4'
  tertiary: '#e7e4e3'
  on-tertiary: '#303030'
  tertiary-container: '#cac8c7'
  on-tertiary-container: '#545453'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#62ff96'
  primary-fixed-dim: '#00e475'
  on-primary-fixed: '#00210b'
  on-primary-fixed-variant: '#005226'
  secondary-fixed: '#e5e2e1'
  secondary-fixed-dim: '#c8c6c5'
  on-secondary-fixed: '#1c1b1b'
  on-secondary-fixed-variant: '#474746'
  tertiary-fixed: '#e4e2e1'
  tertiary-fixed-dim: '#c8c6c5'
  on-tertiary-fixed: '#1b1c1c'
  on-tertiary-fixed-variant: '#474746'
  background: '#131313'
  on-background: '#e5e2e1'
  surface-variant: '#353534'
typography:
  headline-xl:
    fontFamily: Space Grotesk
    fontSize: 48px
    fontWeight: '700'
    lineHeight: '1.1'
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Space Grotesk
    fontSize: 32px
    fontWeight: '600'
    lineHeight: '1.2'
    letterSpacing: -0.01em
  body-md:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: '1.6'
    letterSpacing: '0'
  body-sm:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: '1.5'
    letterSpacing: '0'
  code-md:
    fontFamily: monospace
    fontSize: 14px
    fontWeight: '450'
    lineHeight: '1.6'
    letterSpacing: '0'
  label-caps:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '600'
    lineHeight: '1'
    letterSpacing: 0.05em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  unit: 4px
  gutter: 16px
  margin: 24px
  density: compact
  container-max: 1440px
---

## Brand & Style

This design system is engineered for developers who value speed, precision, and clarity. The aesthetic combines **Minimalism** with **Glassmorphism** to create a sophisticated, high-performance environment. 

The brand personality is authoritative yet open, reflecting its open-source roots. It uses a "Terminal-Plus" approach—taking the efficiency of a command-line interface and elevating it with modern UI affordances. Depth is used sparingly to maintain a focused, high-density workspace, while vibrant emerald accents guide the user's eye toward critical actions and real-time status updates.

## Colors

The palette is anchored by a "True Dark" foundation. Deep charcoal (#0D0D0D) serves as the primary canvas, reducing eye strain during long coding sessions.

*   **Primary Accent:** Emerald Green (#00E676) is used exclusively for primary calls-to-action, success states, and active indicators.
*   **Surface Tiers:** Secondary (#1A1A1A) and Tertiary (#262626) charcoals define component backgrounds and borders, creating a subtle hierarchy without breaking the dark theme.
*   **Typography:** Pure white (#FFFFFF) is reserved for headers and high-emphasis text. Secondary text uses a muted grey to maintain visual balance in data-heavy views.

## Typography

This design system utilizes a dual-font strategy to balance technical grit with modern readability. 

*   **Headlines:** Space Grotesk provides a geometric, futuristic feel for large display text. Its distinct letterforms reinforce the "high-tech" vibe.
*   **Body & UI:** Inter is used for all functional text. It is chosen for its exceptional legibility at small sizes, which is critical for high-density technical layouts.
*   **Code:** Monospaced fonts must have high contrast against the charcoal background. Syntax highlighting should use the primary emerald green for keywords and a muted purple/blue palette for variables and strings to ensure the UI remains the primary focus.

## Layout & Spacing

The layout follows a **Fluid Grid** model with a high-density rhythm. A 4px baseline grid ensures mathematical precision across all components.

*   **Grid:** A 12-column layout is used for marketing and dashboard views. 
*   **Density:** Padding is intentionally tight (8px-12px internally for components) to maximize the "information-per-pixel" ratio, catering to power users.
*   **Margins:** Generous outer margins (24px+) contrast with the tight internal spacing to give the interface a sophisticated, intentional feel.

## Elevation & Depth

Depth in this design system is achieved through **Glassmorphism** and **Tonal Layers** rather than heavy shadows.

*   **Layer 0 (Background):** #0D0D0D.
*   **Layer 1 (Cards/Panels):** #1A1A1A with a 1px border of #262626.
*   **Layer 2 (Modals/Popovers):** Semi-transparent charcoal with a `backdrop-filter: blur(12px)`. This creates a "glass" effect that maintains context of the layer beneath.
*   **Shadows:** When necessary, use a single, highly-diffused ambient shadow: `0 8px 32px rgba(0, 0, 0, 0.5)`. No colored shadows are permitted except for a subtle green "glow" on active primary buttons.

## Shapes

The shape language is disciplined and consistent. A **Soft (8px)** corner radius is the standard for cards and main containers, providing a modern feel without looking "bubbly."

*   **Standard Components:** 8px radius (buttons, inputs, cards).
*   **Small Components:** 4px radius (tooltips, tags/chips).
*   **Interactive States:** On hover, borders may slightly brighten, but the shape remains static to maintain a sense of stability and precision.

## Components

*   **Buttons:** Primary buttons use a solid Emerald Green (#00E676) background with black text for maximum contrast. Secondary buttons use a ghost style with a 1px charcoal border and white text.
*   **Input Fields:** Darker than the surface layer (#050505) with a 1px border. On focus, the border transitions to Emerald Green with a subtle outer glow.
*   **Chips/Tags:** Used for metadata like "v1.0.4" or "MIT License." These should be small, capitalized, and use a dark background with white or green text.
*   **Cards:** Use the "Layer 1" tonal layer. Headers within cards should have a subtle 1px bottom border to separate them from the content.
*   **Code Blocks:** Encased in a Tertiary (#262626) container with a "Copy" icon always visible in the top-right corner.
*   **Status Indicators:** Small 8px circles. Use Emerald Green for "Online/Success," Amber for "Warning," and Red for "Critical."