#!/usr/bin/env node
// Gera tecnico.html: o app do técnico inteiro num arquivo só.
// Junta index.html + styles.css + app.js + bubbles.js + logo.svg e injeta o
// runtime que descobre onde está a API (e o modo demonstração offline).
// Rode depois de mexer em app.js/styles.css:  node tools/build-tecnico.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

const shell = read('index.html');
const css = read('styles.css');
const app = read('app.js');
const bubbles = read('bubbles.js');
const logo = 'data:image/svg+xml;base64,' + Buffer.from(read('logo.svg'), 'utf8').toString('base64');

// Runtime: resolve a URL da API e trata o modo demonstração.
const runtime = `
// ---------- Runtime do arquivo único (gerado por tools/build-tecnico.mjs) ----------
(function () {
  var qs = new URLSearchParams(location.search);
  var KEY = 'lavandery.api';
  var base = qs.get('api');
  if (base !== null) { try { base ? localStorage.setItem(KEY, base) : localStorage.removeItem(KEY); } catch (e) {} }
  else { try { base = localStorage.getItem(KEY); } catch (e) { base = null; } }
  if (!base) base = location.protocol === 'file:' ? '' : location.origin;
  base = String(base).replace(/\\/+$/, '');

  // Demonstração: ligada com ?demo=1, ou sozinha quando o arquivo é aberto
  // direto do disco (file://), onde não existe servidor nenhum pra chamar.
  var demo = qs.has('demo') ? qs.get('demo') !== '0' : (!base || location.protocol === 'file:');
  window.LV = { base: base, demo: demo, version: '__BUILT_AT__' };

  function reply(status, body) {
    return Promise.resolve(new Response(JSON.stringify(body), {
      status: status, headers: { 'Content-Type': 'application/json' }
    }));
  }

  // Login local do modo demonstração: confere contra os técnicos de exemplo
  // que o próprio app semeia (senha = PIN). Nunca roda com a API ligada.
  function demoLogin(init) {
    var body = {};
    try { body = JSON.parse((init && init.body) || '{}'); } catch (e) {}
    var email = String(body.email || '').trim().toLowerCase();
    var pass = String(body.password || '');
    var techs = (typeof SEED !== 'undefined' && SEED.technicians) || [];
    var t = techs.find(function (x) { return x.email.toLowerCase() === email; });
    if (!t || pass !== t.pin) return reply(401, { error: 'invalid_credentials' });
    return reply(200, { user: { id: t.id, name: t.name, email: t.email } });
  }

  var real = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.indexOf('/api/') !== 0) return real(input, init);
    if (!demo) return real(base + url, init);
    if (url.indexOf('/api/auth/login') === 0) return demoLogin(init);
    // Sem servidor: o app já trata isso como "offline" e segue com o banco local.
    return Promise.reject(new Error('modo_demonstracao_sem_servidor'));
  };

  if (demo) {
    document.addEventListener('DOMContentLoaded', function () {
      var tag = document.createElement('div');
      tag.textContent = 'MODO DEMONSTRAÇÃO · dados locais';
      tag.setAttribute('role', 'status');
      tag.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);z-index:9999;' +
        'bottom:calc(8px + env(safe-area-inset-bottom,0px));background:#533C9D;color:#fff;' +
        'font:600 10px/1 Inter,system-ui,sans-serif;letter-spacing:.09em;padding:6px 12px;' +
        'border-radius:999px;box-shadow:0 6px 20px -6px rgba(11,10,26,.55);pointer-events:none;opacity:.92;white-space:nowrap';
      document.body.appendChild(tag);
    });
  }
})();
`.replace('__BUILT_AT__', new Date().toISOString().slice(0, 10));

let out = shell;

// 1) CSS externo vira <style> inline
out = out.replace('<link rel="stylesheet" href="styles.css" />', () =>
  '<style>\n/* ---------- styles.css ---------- */\n' + css + '\n</style>');

// 2) app.js e bubbles.js viram <script> inline, com o runtime na frente
out = out.replace('<script src="app.js"></script>', () =>
  '<script>' + runtime + '\n// ---------- app.js ----------\n' + app + '\n</script>');
out = out.replace('<script src="/bubbles.js" defer></script>', () =>
  '<script>\n// ---------- bubbles.js ----------\n' + bubbles + '\n</script>');

// 3) logo vira data URI (não existe /logo.svg num arquivo solto)
out = out.replace(/src="\/logo\.svg"/g, () => 'src="' + logo + '"');

// 4) o link do painel administrativo aponta pro servidor configurado
out = out.replace('href="/login.html"', () => 'href="${(window.LV&&window.LV.base)||\'\'}/login.html"');

const missing = [];
if (out.includes('src="app.js"')) missing.push('app.js');
if (out.includes('href="styles.css"')) missing.push('styles.css');
if (out.includes('/logo.svg')) missing.push('logo.svg');
if (missing.length) { console.error('ERRO: não inlinou:', missing.join(', ')); process.exit(1); }

fs.writeFileSync(path.join(ROOT, 'tecnico.html'), out);
console.log('tecnico.html gerado ·', (Buffer.byteLength(out) / 1024).toFixed(0) + 'KB');
