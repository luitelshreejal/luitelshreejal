document.addEventListener('DOMContentLoaded', () => {
  renderMathInElement(document.body, {
    delimiters: [
      { left: '\\[', right: '\\]', display: true },
      { left: '\\(', right: '\\)', display: false },
    ],
    throwOnError: false,
  });

  // Smooth scroll for TOC links
  document.querySelectorAll('.toc-link, .inline-link').forEach(link => {
    link.addEventListener('click', (e) => {
      const id = link.getAttribute('href');
      if (!id || id[0] !== '#') return;
      const target = document.querySelector(id);
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      history.pushState(null, '', id);
    });
  });

  // Scrollspy: highlight the TOC entry for the section currently in view
  const sections = Array.from(document.querySelectorAll('.paper-section'));
  const tocLinks = Array.from(document.querySelectorAll('.toc-link'));
  const linkFor = (id) => tocLinks.find(l => l.getAttribute('href') === `#${id}`);

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      const link = linkFor(entry.target.id);
      if (!link) return;
      link.classList.toggle('active', entry.isIntersecting);
    });
  }, { rootMargin: '-40% 0px -55% 0px', threshold: 0 });

  sections.forEach(sec => observer.observe(sec));
});
