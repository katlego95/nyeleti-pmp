// === UPDATE THESE TWO NUMBERS AS DONATIONS COME IN ===
const RAISED_ZAR = 0;        // current amount raised (check BackaBuddy dashboard)
const GOAL_ZAR = 10000;      // total goal
// =====================================================

const STRIP_H  = 56;   // must match --strip-h in style.css

const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const prefersReducedMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const formatRand = (n) =>
  'R' + Math.round(n).toLocaleString('en-ZA', { maximumFractionDigits: 0 });

function renderProgress() {
  const percent = GOAL_ZAR > 0
    ? Math.min(100, Math.round((RAISED_ZAR / GOAL_ZAR) * 100))
    : 0;
  $$('[data-bar-fill]').forEach((el) => { el.style.width = percent + '%'; });
  $$('[data-bar]').forEach((el)      => { el.setAttribute('aria-valuenow', String(percent)); });
  $$('[data-raised]').forEach((el)   => { el.textContent = formatRand(RAISED_ZAR); });
  $$('[data-goal]').forEach((el)     => { el.textContent = formatRand(GOAL_ZAR); });
  if (percent >= 100) {
    document.body.classList.add('goal-reached');
    $$('[data-contribute]').forEach((el) => { el.textContent = 'Thank you'; });
  }
}

// Hero-bar → sticky-strip transition. The signature motion.
function wireStripToggle() {
  const heroBar = $('[data-hero-bar]');
  const strip = $('.strip');
  if (!heroBar || !strip) return;
  if (!('IntersectionObserver' in window)) {
    strip.classList.add('strip--visible');
    return;
  }
  const io = new IntersectionObserver(([entry]) => {
    if (entry.isIntersecting) {
      strip.classList.remove('strip--visible');
    } else {
      strip.classList.add('strip--visible');
    }
  }, {
    rootMargin: `-${STRIP_H}px 0px 0px 0px`,
    threshold: 0,
  });
  io.observe(heroBar);
}

// Reveal observer: handles [data-reveal] (single element) and
// [data-reveal-stagger] (parent triggers staggered children).
function observeReveal() {
  const els = $$('[data-reveal], [data-reveal-stagger]');
  if (!els.length) return;
  if (!('IntersectionObserver' in window) || prefersReducedMotion()) {
    els.forEach((el) => el.classList.add('in-view'));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add('in-view');
        io.unobserve(entry.target);
      }
    }
  }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
  els.forEach((el) => io.observe(el));
}

// Section-rule observer: draws in the hairline above each section
// (the ::before pseudo on [data-reveal-rule] elements).
function observeSectionRules() {
  const els = $$('[data-reveal-rule]');
  if (!els.length) return;
  if (!('IntersectionObserver' in window) || prefersReducedMotion()) {
    els.forEach((el) => el.classList.add('section--seen'));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add('section--seen');
        io.unobserve(entry.target);
      }
    }
  }, { threshold: 0, rootMargin: '0px 0px -8% 0px' });
  els.forEach((el) => io.observe(el));
}

// Hero arrival sequence — adds .is-loaded to <body>, CSS handles the rest.
// Double rAF ensures the initial opacity:0 state has painted before the
// transition kicks off, so the sequence is reliable.
function triggerLoadSequence() {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      document.body.classList.add('is-loaded');
    });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  renderProgress();
  wireStripToggle();
  observeReveal();
  observeSectionRules();
  triggerLoadSequence();
});
