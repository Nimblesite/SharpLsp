document.addEventListener('DOMContentLoaded', () => {
  initMobileMenu();
  initBlogSearch();
});

function initMobileMenu() {
  const toggle = document.getElementById('mobile-menu-toggle');
  const navLinks = document.querySelector('.nav-links');
  if (!toggle || !navLinks) return;

  toggle.addEventListener('click', () => {
    navLinks.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(navLinks.classList.contains('open')));
  });
}

function initBlogSearch() {
  const search = document.querySelector('.search-box input');
  const cards = Array.from(document.querySelectorAll('.blog-grid .post-card'));
  if (!search || cards.length === 0) return;

  const filterCards = () => {
    const query = search.value.trim().toLowerCase();
    cards.forEach((card) => {
      const content = card.textContent.toLowerCase();
      const matches = query.length === 0 || content.includes(query);
      card.style.display = matches ? '' : 'none';
    });
  };

  search.addEventListener('input', filterCards);
  filterCards();
}
