# Editorial Design Guidelines: High-Density Extension Interface

## 0. CRITICAL: What Belongs to VS Code, NOT the Panel

> ⚠️ **READ THIS FIRST. The mockups in `code.html` and `screen.png` show a
> full IDE window for context. They are NOT a spec for what the webview panel
> should render. The chrome shown in the mockups is VS Code itself — the
> webview must NEVER reimplement it.**

The mockups include the following elements **that VS Code already provides**.
A SharpLsp webview panel **must not** render any of them:

- ❌ **Activity Bar** — the leftmost icon column (folder, search, layers, settings, avatar). VS Code has this. Don't draw it.
- ❌ **Status Bar** — the blue bar at the bottom showing git branch, ready state, encoding (`main*`, `Ready`, `UTF-8`, `NuGet v6.8.0`). VS Code has this. Don't draw it.
- ❌ **Title Bar / Window Chrome** — VS Code provides this.
- ❌ **Terminal icon, settings cog in the bottom-left, user avatar** — these are VS Code workbench affordances.
- ❌ **Any decorative button without a real handler.** If a control doesn't do anything, delete it. No "for the design" exceptions.

A webview panel renders **only the panel-specific content** — the package list,
the details panel, the header tabs, the search box. Nothing else. If you find
yourself drawing anything that lives outside the workbench area, stop.

**Why this rule exists**: A webview is a child of the editor area. Drawing a
fake activity bar or fake status bar inside it produces a duplicated,
nonsensical UI ("two status bars stacked, two sidebars side-by-side, etc."),
wastes vertical and horizontal space, and confuses the user about which
controls are real.

**Mockup-to-panel translation rule of thumb**: Take the mockup, mentally erase
the activity bar on the left and the status bar at the bottom. What's left
inside the editor area is your panel.

---

## 1. Overview & Creative North Star
**Creative North Star: The Precision Architect**

This design system is built for the professional developer who demands clarity amidst complexity. It moves away from the "legacy" look of crowded package managers and toward a high-end, editorial experience that feels like a natural evolution of the VS Code workbench. 

By leveraging **intentional asymmetry**, we break the rigid boredom of standard data tables. We utilize **tonal depth** instead of structural lines to create a UI that feels carved from a single block of obsidian. The experience is not just functional—it is an authoritative tool that celebrates the "craft of code" through sophisticated layering and a hierarchy that whispers rather than screams.

---

## 2. Colors & Surface Philosophy

The palette is rooted in deep, ink-like grays and vibrant technical blues. However, the application is where the distinction lies.

### The "No-Line" Rule
To achieve a premium "Editorial" feel, **1px solid borders are prohibited for sectioning.** Do not use lines to separate a sidebar from a main content area. Instead, define boundaries through background shifts:
- Use `surface` (#131313) for the primary workbench area.
- Use `surface_container_low` (#1B1B1C) for secondary side panels.
- Use `surface_container_highest` (#353535) for active, elevated states.

### Surface Hierarchy & Nesting
Think of the UI as physical layers of tech-inspired materials. 
1. **Base Layer:** `surface` (#131313).
2. **Nesting:** When placing a list of packages or extensions, use `surface_container` (#202020) for the container. 
3. **Internal Logic:** Use `surface_container_low` for search bars or input areas to create an "etched-in" look.

### The "Glass & Gradient" Rule
For floating elements like command palettes or hover-menus, use Glassmorphism. Apply `surface_variant` (#353535) at 80% opacity with a `20px` backdrop-blur. 
For primary action buttons, use a subtle linear gradient from `primary_container` (#007ACC) to `primary` (#9FCAFF) at a 45-degree angle. This provides a "soul" to the action that a flat hex code cannot match.

---

## 3. Typography: Editorial Logic

We utilize a clean, sans-serif approach (Inter/Segoe UI) but manipulate scale to drive focus.

*   **Display & Headline (The Narrative):** Use `headline-sm` (1.5rem) for main page titles. They should be typeset with tight letter-spacing (-0.02em) to feel authoritative.
*   **Title (The Structure):** `title-md` (1.125rem) is reserved for package names or section headers. 
*   **Body (The Data):** `body-sm` (0.75rem) is our workhorse. In high-density displays, use `on_surface_variant` (#C0C7D3) for secondary data to reduce visual noise.
*   **Label (The Meta):** `label-sm` (0.6875rem) in All-Caps with +0.05em letter-spacing for metadata (e.g., VERSION, AUTHOR) to create a technical, "blueprint" aesthetic.

---

## 4. Elevation & Depth

Forget traditional "Drop Shadows." This system uses light and tone to define space.

*   **Tonal Layering:** Depth is achieved by "stacking." A card using `surface_container_highest` placed on a `surface_dim` background provides an immediate, soft lift.
*   **Ambient Shadows:** If an element must float (e.g., a context menu), use a shadow color derived from `surface_container_lowest` (#0E0E0E) with a 24px blur and 10% opacity. It should look like an eclipse, not a smudge.
*   **The "Ghost Border" Fallback:** In high-density data where tonal shifts aren't enough, use the `outline_variant` token (#404751) at **15% opacity**. This creates a "hairline" guide that is felt rather than seen.

---

## 5. Components

### Buttons
*   **Primary:** High-contrast `primary_container` (#007ACC). Use `md` (0.375rem) roundedness. No borders.
*   **Secondary:** `surface_container_high` (#2A2A2A) with `on_surface` text.
*   **States:** On hover, primary buttons should transition to `primary` (#9FCAFF).

### Cards & Lists (Package Items)
*   **Construction:** Forbid divider lines between list items. Use 8px of vertical whitespace and a subtle background change (`surface_container_low`) on hover.
*   **Focus State:** Use a 2px left-accent bar of `primary` (#9FCAFF) to indicate the active selection, mimicking the VS Code editor's active tab logic.

### Input Fields (Search & Filtering)
*   **Style:** Background `surface_container_lowest` (#0E0E0E).
*   **Border:** Use a "Ghost Border" of `outline` (#8A919D) at 20% opacity. 
*   **Focus:** Transition the border to 100% `primary` (#9FCAFF) with a 2px outer "glow" using the same color at 10% opacity.

### Chips (Tags & Dependencies)
*   **Action Chips:** `surface_container_high` with `label-md` text. Roundedness `full` (9999px) for a soft, pill-shaped contrast against the otherwise rectangular UI.

---

## 6. Do’s and Don’ts

### Do
*   **Do** embrace negative space. High-density doesn't mean "crammed"; it means "efficiently organized."
*   **Do** use `on_surface_variant` for less important text (descriptions) to keep the primary data (package names) dominant.
*   **Do** use `sm` (0.125rem) roundedness for technical elements like code snippets and `md` (0.375rem) for interactive elements like buttons.

### Don’t
*   **Don't** use pure black (#000000). It kills the "frosted" depth of the dark theme. Use `surface_container_lowest` (#0E0E0E).
*   **Don't** use default 1px dividers. If you feel the need for a line, try adding 4px more padding instead.
*   **Don't** use "Electric" neon colors for anything other than critical errors (`error`: #FFB4AB) or primary actions. Keep the workbench professional.