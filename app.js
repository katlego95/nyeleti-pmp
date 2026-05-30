// === UPDATE THESE TWO NUMBERS AS DONATIONS COME IN ===
const RAISED_ZAR = 6500;     // current amount raised (check BackaBuddy dashboard)
const GOAL_ZAR = 10000;      // total goal
// =====================================================

const STRIP_H  = 56;   // must match --strip-h in style.css

const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const prefersReducedMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const formatRand = (n) =>
  'R' + Math.round(n).toLocaleString('en-ZA', { maximumFractionDigits: 0 });

// Bar-fill animation timing must match the CSS transition on .hero__fill /
// .strip__fill: width var(--t-bar) ease-out, delayed --t-bar-delay so it fires
// after the staged hero arrival completes.
const BAR_DELAY_MS = 1000;
const BAR_DURATION_MS = 1400;

function renderProgress() {
  const percent = GOAL_ZAR > 0
    ? Math.min(100, Math.round((RAISED_ZAR / GOAL_ZAR) * 100))
    : 0;
  // iOS Safari transition race: setting style.width synchronously at
  // DOMContentLoaded can cause the engine to skip the CSS width transition
  // entirely (the initial 0% state from the stylesheet hasn't been committed
  // to a paint frame yet). Double-rAF defers the change until after first
  // paint so the transition fires correctly on mobile Safari. Desktop sees
  // an imperceptible ~32ms shift; transition timing is otherwise identical.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      $$('[data-bar-fill]').forEach((el) => { el.style.width = percent + '%'; });
    });
  });
  $$('[data-bar]').forEach((el)      => { el.setAttribute('aria-valuenow', String(percent)); });
  $$('[data-goal]').forEach((el)     => { el.textContent = formatRand(GOAL_ZAR); });
  if (prefersReducedMotion()) {
    $$('[data-raised]').forEach((el) => { el.textContent = formatRand(RAISED_ZAR); });
  } else {
    animateCountUp(RAISED_ZAR, BAR_DELAY_MS, BAR_DURATION_MS);
  }
  if (percent >= 100) {
    document.body.classList.add('goal-reached');
    $$('[data-contribute]').forEach((el) => { el.textContent = 'Thank you'; });
  }
}

// Count-up from R0 to target, synced with the bar-fill CSS transition.
// Cubic ease-out matches the CSS `cubic-bezier(0.16, 1, 0.3, 1)` closely enough
// that the number and bar arrive together visually.
function animateCountUp(targetN, delay, duration) {
  const els = $$('[data-raised]');
  if (!els.length) return;
  // Seed at R0 so the eye registers the starting state before the animation.
  els.forEach((el) => { el.textContent = formatRand(0); });
  setTimeout(() => {
    const start = performance.now();
    function tick(now) {
      const t = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      const value = targetN * eased;
      els.forEach((el) => { el.textContent = formatRand(value); });
      if (t < 1) requestAnimationFrame(tick);
      else els.forEach((el) => { el.textContent = formatRand(targetN); });
    }
    requestAnimationFrame(tick);
  }, delay);
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
