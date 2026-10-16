// Deterministic sidebar stars and keyboard-accessible signature-heart effects.
// Closure-scoped classic script: no shared lexical globals.
window.VENOM_RENDERER = window.VENOM_RENDERER || {};
window.VENOM_RENDERER.effects = (() => {
  'use strict';
  function mountSidebarStars() {
    const nav = document.querySelector('.shell-nav');
    if (!nav || nav.querySelector('.shell-stars')) return;
    let seed = 20260926;
    const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    const sky = document.createElement('div');
    sky.className = 'shell-stars';
    sky.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 16; i++) {
      const star = document.createElement('span');
      star.className = 'shell-star';
      const size = (1 + rand() * 1.4).toFixed(2);
      star.style.cssText = [
        `left:${(8 + rand() * 84).toFixed(1)}%`,
        `bottom:${(4 + rand() * 88).toFixed(1)}%`,
        `--size:${size}px`,
        `--rise:${(-18 - rand() * 26).toFixed(0)}px`,
        `--drift:${(16 + rand() * 14).toFixed(1)}s`,
        `--twinkle:${(2.4 + rand() * 2.8).toFixed(2)}s`,
        `--delay:${(-rand() * 20).toFixed(2)}s`,
        `--peak:${(0.35 + rand() * 0.45).toFixed(2)}`,
      ].join(';');
      if (rand() < 0.4) star.classList.add('tinted');
      star.appendChild(document.createElement('i'));
      sky.appendChild(star);
    }
    const meteor = document.createElement('span');
    meteor.className = 'shell-meteor';
    sky.appendChild(meteor);
    nav.prepend(sky);
  }

  // The heart answers a click: a big beat, and a burst of small hearts and
  // sparks that fly out and fade. Reduced motion keeps only a gentle beat.
  function bindSignatureHeart() {
    const heart = document.querySelector('.shell-heart');
    if (!heart) return;
    heart.setAttribute('tabindex', '0');
    heart.setAttribute('role', 'button');
    heart.setAttribute('aria-label', 'Crafted with love');
    const mini = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7.5-4.6-10-9.3C.3 8.4 2.1 4.5 5.9 4.1c2.3-.2 4.3 1 5.4 2.9h1.4c1.1-1.9 3.1-3.1 5.4-2.9 3.8.4 5.6 4.3 3.9 7.6C19.5 16.4 12 21 12 21z"/></svg>';
    const burst = () => {
      heart.classList.remove('pop');
      void heart.getBoundingClientRect(); // restart the animation on a quick second click
      heart.classList.add('pop');
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const r = heart.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const n = 12;
      for (let i = 0; i < n; i++) {
        const p = document.createElement('span');
        const isHeart = i % 3 !== 2;
        p.className = `heart-particle${isHeart ? '' : ' spark'}`;
        if (isHeart) p.innerHTML = mini;
        // Spread over the upper half-circle, so the burst rises out of the footer.
        const angle = Math.PI + (Math.PI * (i + 0.5)) / n + (Math.random() - 0.5) * 0.35;
        const dist = 34 + Math.random() * 38;
        p.style.cssText = [
          `left:${cx}px`, `top:${cy}px`,
          `--dx:${(Math.cos(angle) * dist).toFixed(1)}px`,
          `--dy:${(Math.sin(angle) * dist).toFixed(1)}px`,
          `--rot:${((Math.random() - 0.5) * 70).toFixed(0)}deg`,
          `--scale:${(0.55 + Math.random() * 0.6).toFixed(2)}`,
          `--dur:${(750 + Math.random() * 450).toFixed(0)}ms`,
        ].join(';');
        p.addEventListener('animationend', () => p.remove(), { once: true });
        document.body.appendChild(p);
      }
    };
    heart.addEventListener('click', burst);
    heart.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); burst(); } });
    heart.addEventListener('animationend', (e) => { if (e.animationName === 'shell-heart-pop') heart.classList.remove('pop'); });
  }

  return { mountSidebarStars, bindSignatureHeart };
})();
