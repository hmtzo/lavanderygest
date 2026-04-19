// Bolhas flutuantes globais — aparecem em todas as páginas (admin, app, login etc)
(function() {
  if (window.__bubblesMounted) return;
  window.__bubblesMounted = true;

  // CSS injetado uma vez
  if (!document.querySelector('#globalBubblesCss')) {
    const css = document.createElement('style');
    css.id = 'globalBubblesCss';
    css.textContent = `
      .global-bubbles {
        position: fixed; inset: 0; width: 100vw; height: 100vh;
        pointer-events: none; z-index: 9999; overflow: hidden;
        mix-blend-mode: multiply;
      }
      .global-bubbles svg { width: 100%; height: 100%; display: block; }
      .global-bubbles circle {
        transform-origin: center;
        animation: gbBubbleFloat var(--gb-d, 14s) ease-in-out infinite alternate;
      }
      @keyframes gbBubbleFloat {
        0%   { opacity: var(--gb-op, .35); transform: translate(0,0) scale(1); }
        50%  { opacity: calc(var(--gb-op, .35) * .55); transform: translate(var(--gb-x, 30px), var(--gb-y, -25px)) scale(1.12); }
        100% { opacity: var(--gb-op, .35); transform: translate(calc(var(--gb-x, 30px) * -.5), calc(var(--gb-y, -25px) * .8)) scale(0.96); }
      }
    `;
    document.head.appendChild(css);
  }

  // Container SVG
  const wrap = document.createElement('div');
  wrap.className = 'global-bubbles';
  wrap.setAttribute('aria-hidden', 'true');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('viewBox', '0 0 1600 1000');
  wrap.appendChild(svg);

  const COUNT = 35;
  // Tons de roxo/lilás suaves pra combinar com o fundo claro
  const palette = [
    'rgba(168,134,235,', 'rgba(196,168,242,', 'rgba(122,82,210,',
    'rgba(214,196,250,', 'rgba(149,108,222,'
  ];
  for (let i = 0; i < COUNT; i++) {
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    const x = Math.random() * 1600;
    const y = Math.random() * 1000;
    const r = 6 + Math.random() * 28;
    const op = 0.18 + Math.random() * 0.22; // mix-blend-mode multiply precisa mais opacidade
    const col = palette[Math.floor(Math.random() * palette.length)] + op + ')';
    c.setAttribute('cx', x);
    c.setAttribute('cy', y);
    c.setAttribute('r', r);
    c.setAttribute('fill', col);
    c.style.setProperty('--gb-d', (10 + Math.random() * 16) + 's');
    c.style.setProperty('--gb-x', (Math.random() * 100 - 50) + 'px');
    c.style.setProperty('--gb-y', (Math.random() * 100 - 50) + 'px');
    c.style.setProperty('--gb-op', op);
    c.style.animationDelay = (-Math.random() * 12) + 's';
    svg.appendChild(c);
  }

  // Insere como primeiro filho do body pra ficar atrás do conteúdo
  if (document.body.firstChild) {
    document.body.insertBefore(wrap, document.body.firstChild);
  } else {
    document.body.appendChild(wrap);
  }
})();
