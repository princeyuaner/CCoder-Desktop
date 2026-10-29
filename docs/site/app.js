/* CCoder landing page — motion, reveal, theme lab */

(() => {
  'use strict';

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const finePointer = window.matchMedia('(pointer: fine)').matches;

  /* ------------------------------------------------------------
     Scroll progress + nav state
     ------------------------------------------------------------ */
  const head = document.getElementById('siteHead');
  const progress = document.getElementById('progressBar');
  let ticking = false;

  function updateScroll() {
    const y = window.scrollY || document.documentElement.scrollTop;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const ratio = max > 0 ? Math.min(1, Math.max(0, y / max)) : 0;
    if (progress) progress.style.transform = `scaleX(${ratio})`;
    if (head) head.classList.toggle('is-scrolled', y > 14);
    ticking = false;
  }

  function requestScroll() {
    if (!ticking) {
      ticking = true;
      window.requestAnimationFrame(updateScroll);
    }
  }

  window.addEventListener('scroll', requestScroll, { passive: true });
  window.addEventListener('resize', requestScroll);
  updateScroll();

  /* ------------------------------------------------------------
     Reveal on scroll
     ------------------------------------------------------------ */
  const revealItems = Array.from(document.querySelectorAll('.reveal'));

  if (reduced || !('IntersectionObserver' in window)) {
    revealItems.forEach((el) => el.classList.add('is-in'));
  } else {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-in');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -7% 0px' });

    revealItems.forEach((el) => io.observe(el));
  }

  /* ------------------------------------------------------------
     Hero: subtle pointer parallax
     ------------------------------------------------------------ */
  const hero = document.querySelector('.hero');
  const stageFigure = document.getElementById('stageFigure');

  if (hero && stageFigure && !reduced && finePointer) {
    let frame = 0;
    let targetX = 0;
    let targetY = 0;

    const apply = () => {
      frame = 0;
      stageFigure.style.setProperty('--ry', `${targetX.toFixed(2)}deg`);
      stageFigure.style.setProperty('--rx', `${targetY.toFixed(2)}deg`);
    };

    hero.addEventListener('pointermove', (event) => {
      const rect = hero.getBoundingClientRect();
      const px = (event.clientX - rect.left) / rect.width - 0.5;
      const py = (event.clientY - rect.top) / rect.height - 0.5;
      targetX = px * 2.2;
      targetY = -py * 1.6;
      if (!frame) frame = window.requestAnimationFrame(apply);
    }, { passive: true });

    hero.addEventListener('pointerleave', () => {
      targetX = 0;
      targetY = 0;
      if (!frame) frame = window.requestAnimationFrame(apply);
    });
  }

  /* ------------------------------------------------------------
     Theme lab
     ------------------------------------------------------------ */
  const THEMES = {
    dark: {
      name: '深色', hex: '#0B0B0B',
      vars: { bg: '#0b0b0b', panel: '#161616', side: '#101010', fg: '#e8e8e8', dim: '#9a9a9a', line: '#2a2a2a', accent: '#4ade80', ink: '#06130a' }
    },
    light: {
      name: '浅色', hex: '#FFFFFF',
      vars: { bg: '#ffffff', panel: '#f2f2f2', side: '#f8f8f8', fg: '#1a1a1a', dim: '#6b6b6b', line: '#d9d9d9', accent: '#16a34a', ink: '#ffffff' }
    },
    midnight: {
      name: '午夜蓝', hex: '#0A1020',
      vars: { bg: '#0a1020', panel: '#141f36', side: '#0d1526', fg: '#dbe6ff', dim: '#8a9bc0', line: '#23314d', accent: '#60a5fa', ink: '#04122a' }
    },
    forest: {
      name: '森林绿', hex: '#0A130F',
      vars: { bg: '#0a130f', panel: '#12241a', side: '#0c1a13', fg: '#d9f0e2', dim: '#87a695', line: '#1e3328', accent: '#34d399', ink: '#04160d' }
    },
    mist: {
      name: '雾紫', hex: '#14121F',
      vars: { bg: '#14121f', panel: '#221d38', side: '#181428', fg: '#e6e0ff', dim: '#9c94c0', line: '#302a4b', accent: '#a78bfa', ink: '#150c2e' }
    },
    coffee: {
      name: '咖啡棕', hex: '#140F0B',
      vars: { bg: '#140f0b', panel: '#251b13', side: '#19120d', fg: '#f0e2d4', dim: '#a89a8a', line: '#3a2b1e', accent: '#e08b62', ink: '#1f0f05' }
    },
    moss: {
      name: '苔原', hex: '#101110',
      vars: { bg: '#101110', panel: '#1b1e1b', side: '#141614', fg: '#d8d8d4', dim: '#9a9d97', line: '#2c302c', accent: '#b7c0a8', ink: '#101408' }
    },
    contrast: {
      name: '高对比', hex: '#000000',
      vars: { bg: '#000000', panel: '#121212', side: '#060606', fg: '#ffffff', dim: '#b8b8b8', line: '#3a3a3a', accent: '#ffd400', ink: '#000000' }
    },
    sepia: {
      name: '暖纸', hex: '#F5EFE3',
      vars: { bg: '#f5efe3', panel: '#e9dfcd', side: '#f0e8da', fg: '#3a3226', dim: '#6d6252', line: '#d3c6b2', accent: '#b45309', ink: '#fff8ec' }
    }
  };

  const preview = document.getElementById('themePreview');
  const swatchList = document.getElementById('swatches');
  const nameLabel = document.getElementById('themeName');
  const hexLabel = document.getElementById('themeHex');
  const swatches = swatchList ? Array.from(swatchList.querySelectorAll('.swatch')) : [];

  let current = 'dark';
  let autoTimer = 0;
  let autoCount = 0;
  let autoStopped = reduced;
  let themesVisible = false;

  function applyTheme(key) {
    const theme = THEMES[key];
    if (!theme || !preview) return;
    current = key;
    const v = theme.vars;
    preview.style.setProperty('--pv-bg', v.bg);
    preview.style.setProperty('--pv-panel', v.panel);
    preview.style.setProperty('--pv-side', v.side);
    preview.style.setProperty('--pv-fg', v.fg);
    preview.style.setProperty('--pv-dim', v.dim);
    preview.style.setProperty('--pv-line', v.line);
    preview.style.setProperty('--pv-accent', v.accent);
    preview.style.setProperty('--pv-accent-ink', v.ink);
    if (nameLabel) nameLabel.textContent = theme.name;
    if (hexLabel) hexLabel.textContent = theme.hex;
    swatches.forEach((button) => {
      const active = button.dataset.theme === key;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function stopAuto() {
    autoStopped = true;
    if (autoTimer) {
      window.clearInterval(autoTimer);
      autoTimer = 0;
    }
  }

  function nextTheme() {
    const index = swatches.findIndex((button) => button.dataset.theme === current);
    const next = swatches[(index + 1) % swatches.length];
    if (next) applyTheme(next.dataset.theme);
  }

  function startAuto() {
    if (autoStopped || reduced || !themesVisible || autoTimer) return;
    autoTimer = window.setInterval(() => {
      nextTheme();
      autoCount += 1;
      if (autoCount >= 3) stopAuto();
    }, 4200);
  }

  swatches.forEach((button) => {
    button.addEventListener('click', () => {
      stopAuto();
      applyTheme(button.dataset.theme);
    });
  });

  if (preview) {
    preview.addEventListener('pointerdown', stopAuto);
    preview.addEventListener('keydown', stopAuto);
  }

  const themesSection = document.getElementById('themes');
  if (themesSection && 'IntersectionObserver' in window && !reduced) {
    const themeIO = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        themesVisible = entry.isIntersecting;
        if (themesVisible) startAuto();
        else if (autoTimer) {
          window.clearInterval(autoTimer);
          autoTimer = 0;
        }
      });
    }, { threshold: 0.25 });
    themeIO.observe(themesSection);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (autoTimer) {
        window.clearInterval(autoTimer);
        autoTimer = 0;
      }
    } else {
      startAuto();
    }
  });

  applyTheme('dark');
})();
