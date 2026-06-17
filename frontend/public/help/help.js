/* ============================================================
   GoWarmCRM — Help Center shared behavior
   Vanilla JS, no dependencies. Safe to drop in under any CSP.
   ============================================================ */
(function () {
  'use strict';

  /* ---------- Mobile nav toggle ---------- */
  var shell   = document.querySelector('.help-shell');
  var menuBtn = document.querySelector('.help-menu-btn');
  var scrim   = document.querySelector('.help-scrim');
  function closeNav() { if (shell) shell.classList.remove('nav-open'); }
  if (menuBtn && shell) {
    menuBtn.addEventListener('click', function () { shell.classList.toggle('nav-open'); });
  }
  if (scrim) scrim.addEventListener('click', closeNav);

  /* ---------- Section nav: smooth scroll + close mobile ---------- */
  var navLinks = Array.prototype.slice.call(document.querySelectorAll('.help-nav a[href^="#"]'));
  navLinks.forEach(function (a) {
    a.addEventListener('click', function () { closeNav(); });
  });

  /* ---------- Scroll-spy: highlight active section in nav ---------- */
  var sections = Array.prototype.slice.call(document.querySelectorAll('.help-section[id]'));
  var byId = {};
  navLinks.forEach(function (a) {
    var id = a.getAttribute('href').slice(1);
    byId[id] = a;
  });

  function setActive(id) {
    navLinks.forEach(function (a) { a.classList.remove('active'); });
    if (byId[id]) byId[id].classList.add('active');
  }

  if ('IntersectionObserver' in window && sections.length) {
    var visible = {};
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { visible[e.target.id] = e.isIntersecting ? e.intersectionRatio : 0; });
      var best = null, bestR = 0;
      sections.forEach(function (s) {
        var r = visible[s.id] || 0;
        if (r > bestR) { bestR = r; best = s.id; }
      });
      if (best) setActive(best);
    }, { rootMargin: '-64px 0px -55% 0px', threshold: [0, .15, .35, .6, 1] });
    sections.forEach(function (s) { io.observe(s); });
  }

  /* ---------- Search / filter sections ---------- */
  var search = document.querySelector('.help-search input');
  var empty  = document.querySelector('.search-empty');
  if (search && sections.length) {
    var debounce;
    search.addEventListener('input', function () {
      clearTimeout(debounce);
      debounce = setTimeout(runFilter, 120);
    });
    function runFilter() {
      var q = search.value.trim().toLowerCase();
      var anyVisible = false;
      sections.forEach(function (s) {
        if (!q) { s.classList.remove('is-hidden'); anyVisible = true; return; }
        var hit = (s.textContent || '').toLowerCase().indexOf(q) !== -1;
        s.classList.toggle('is-hidden', !hit);
        if (hit) anyVisible = true;
      });
      // dim nav items whose section is hidden
      navLinks.forEach(function (a) {
        var id = a.getAttribute('href').slice(1);
        var sec = document.getElementById(id);
        a.style.display = (!q || (sec && !sec.classList.contains('is-hidden'))) ? '' : 'none';
      });
      if (empty) empty.classList.toggle('show', !!q && !anyVisible);
    }
  }

  /* ---------- Back to top ---------- */
  var toTop = document.querySelector('.to-top');
  if (toTop) {
    window.addEventListener('scroll', function () {
      toTop.classList.toggle('show', window.scrollY > 600);
    }, { passive: true });
    toTop.addEventListener('click', function () {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }
})();
