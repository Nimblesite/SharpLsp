document.addEventListener("DOMContentLoaded", () => {
  initDrawer("mobile-menu-toggle", "nav-menu");
  // [WEB-DESIGN-DOCS-NAV] The docs sidebar is a drawer on a phone.
  initDrawer("docs-menu-toggle", "docs-sidebar");
  initThemeToggle();
  initLanguageSwitcher();
  initBlogSearch();
  initReducedMotionVideos();
});

// Implements [WEB-DESIGN-MEDIA]: autoplaying films hold still for readers who ask for less motion.
function initReducedMotionVideos() {
  if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  document.querySelectorAll("video[autoplay]").forEach((video) => {
    video.removeAttribute("autoplay");
    video.pause();
    video.controls = true;
  });
}

function setDisclosure(button, target, expanded) {
  button.setAttribute("aria-expanded", String(expanded));
  target.classList.toggle("open", expanded);
}

// A phone menu: its button toggles it, and Escape or a tap anywhere outside it closes it.
function initDrawer(buttonId, drawerId) {
  const button = document.getElementById(buttonId);
  const drawer = document.getElementById(drawerId);
  if (!button || !drawer) return;
  button.addEventListener("click", () => {
    setDisclosure(button, drawer, button.getAttribute("aria-expanded") !== "true");
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setDisclosure(button, drawer, false);
  });
  document.addEventListener("click", (event) => {
    if (!button.contains(event.target) && !drawer.contains(event.target)) setDisclosure(button, drawer, false);
  });
}

function initThemeToggle() {
  const button = document.getElementById("theme-toggle");
  if (!button) return;
  button.addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme");
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("theme", next);
    document.dispatchEvent(new CustomEvent("themechange"));
  });
}

function initLanguageSwitcher() {
  const button = document.querySelector(".language-btn");
  const dropdown = document.querySelector(".language-dropdown");
  if (!button || !dropdown) return;
  button.addEventListener("click", () => {
    button.setAttribute("aria-expanded", String(button.getAttribute("aria-expanded") !== "true"));
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".language-switcher")) button.setAttribute("aria-expanded", "false");
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") button.setAttribute("aria-expanded", "false");
  });
}

function initBlogSearch() {
  const search = document.querySelector(".search-box input");
  const cards = Array.from(document.querySelectorAll(".blog-grid .post-card"));
  const empty = document.getElementById("blog-search-empty");
  if (!search || cards.length === 0) return;
  search.addEventListener("input", () => filterCards(search, cards, empty));
}

function filterCards(search, cards, empty) {
  const query = search.value.trim().toLocaleLowerCase();
  let visibleCards = 0;
  cards.forEach((card) => {
    card.hidden = query.length > 0 && !card.textContent.toLocaleLowerCase().includes(query);
    if (!card.hidden) visibleCards += 1;
  });
  if (empty) empty.hidden = query.length === 0 || visibleCards > 0;
}
