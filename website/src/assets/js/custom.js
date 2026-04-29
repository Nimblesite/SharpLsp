document.addEventListener('DOMContentLoaded', () => {
  const toggle = document.getElementById('mobile-menu-toggle');
  const navLinks = document.querySelector('.nav-links');
  if (!toggle || !navLinks) return;

  toggle.addEventListener('click', () => {
    navLinks.classList.toggle('open');
  });
});
