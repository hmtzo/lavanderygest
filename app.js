/* Lavandery — Inspection Web App
   Mobile-first SPA. Zero build step. */

// ---------- Storage ----------
const DB = {
  visits: localforage.createInstance({ name: 'lavandery', storeName: 'visits' }),
  photos: localforage.createInstance({ name: 'lavandery', storeName: 'photos' }),
  meta:   localforage.createInstance({ name: 'lavandery', storeName: 'meta' }),
  queue:  localforage.createInstance({ name: 'lavandery', storeName: 'queue' }),
};

// ---------- Seed (condomínios, técnicos, máquinas) ----------
const SEED = {
  technicians: [
    { id: 't1', name: 'Rafael Costa',  email: 'rafael@lavandery.com',  pin: '1234' },
    { id: 't2', name: 'Marina Alves',  email: 'marina@lavandery.com',  pin: '1234' },
    { id: 't3', name: 'Lucas Pereira', email: 'lucas@lavandery.com',   pin: '1234' },
  ],
  condominiums: [
    { id: 'c1', name: 'Edifício Atlântico',   address: 'Av. Beira Mar, 1200', city: 'Fortaleza/CE', machines: ['m1','m2','m3'] },
    { id: 'c2', name: 'Residencial Solar',    address: 'Rua das Flores, 45',  city: 'Fortaleza/CE', machines: ['m4','m5'] },
    { id: 'c3', name: 'Condomínio Jardins',   address: 'Av. Washington Soares, 909', city: 'Fortaleza/CE', machines: ['m6','m7','m8','m9'] },
  ],
  machines: {
    m1: { id:'m1', code:'LVD-001', type:'Lavadora',  brand:'LG',       capacity:'15kg' },
    m2: { id:'m2', code:'LVD-002', type:'Lavadora',  brand:'Electrolux',capacity:'15kg' },
    m3: { id:'m3', code:'SCR-001', type:'Secadora',  brand:'Samsung',  capacity:'12kg' },
    m4: { id:'m4', code:'LVD-010', type:'Lavadora',  brand:'LG',       capacity:'15kg' },
    m5: { id:'m5', code:'SCR-010', type:'Secadora',  brand:'LG',       capacity:'12kg' },
    m6: { id:'m6', code:'LVD-020', type:'Lavadora',  brand:'Electrolux',capacity:'18kg' },
    m7: { id:'m7', code:'LVD-021', type:'Lavadora',  brand:'Electrolux',capacity:'18kg' },
    m8: { id:'m8', code:'SCR-020', type:'Secadora',  brand:'Samsung',  capacity:'14kg' },
    m9: { id:'m9', code:'SCR-021', type:'Secadora',  brand:'Samsung',  capacity:'14kg' },
  },
  visitsQueue: [ // agenda de visitas pendentes
    { id: 'v1', condoId: 'c1', date: '2026-04-17', scheduledTime: '09:00', type: 'Preventiva' },
    { id: 'v2', condoId: 'c2', date: '2026-04-17', scheduledTime: '14:30', type: 'Corretiva' },
    { id: 'v3', condoId: 'c3', date: '2026-04-18', scheduledTime: '10:00', type: 'Preventiva' },
  ],
};

// ---------- State ----------
const state = {
  route: 'login',   // login | list | visit | summary | history
  user: null,
  visit: null,      // current visit draft
  step: 0,          // 0..5
};

// ---------- Utilities ----------
const $app = document.getElementById('app');
const uid = () => 'id_' + Math.random().toString(36).slice(2,10) + Date.now().toString(36);
const fmtDateTime = (d) => new Date(d).toLocaleString('pt-BR', { dateStyle:'short', timeStyle:'short' });
const fmtDate = (d) => new Date(d).toLocaleDateString('pt-BR');

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast'; el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(()=> el.classList.add('show'));
  setTimeout(()=>{ el.classList.remove('show'); setTimeout(()=>el.remove(), 300); }, 1800);
}

function h(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }

function render(view) { $app.innerHTML = ''; $app.appendChild(view); window.scrollTo({ top: 0, behavior: 'instant' }); }

// Debounced auto-save
let saveTimer;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveDraft, 300);
}
async function saveDraft() {
  if (!state.visit) return;
  state.visit.updatedAt = Date.now();
  await DB.visits.setItem(state.visit.id, state.visit);
}

// ---------- Initial boot ----------
(async function boot() {
  const seeded = await DB.meta.getItem('seeded');
  if (!seeded) {
    await DB.meta.setItem('technicians', SEED.technicians);
    await DB.meta.setItem('condominiums', SEED.condominiums);
    await DB.meta.setItem('machines', SEED.machines);
    await DB.meta.setItem('visitsQueue', SEED.visitsQueue);
    await DB.meta.setItem('seeded', true);
  }
  // Try to sync condos + schedule from backend
  try {
    const [rc, rs] = await Promise.all([
      fetch('/api/condominiums', { cache: 'no-store' }),
      fetch('/api/schedule?from=' + new Date(Date.now()-7*864e5).toISOString().slice(0,10), { cache:'no-store' }).catch(()=>null),
    ]);
    if (rc && rc.ok) {
      const condos = await rc.json();
      if (Array.isArray(condos) && condos.length) {
        const normalized = condos.map(c => ({
          id: c.id, name: c.name, address: c.address||'', city: c.city||'',
          machines: (c.machines||[]).map(m => m.id),
        }));
        const machineMap = {};
        condos.forEach(c => (c.machines||[]).forEach(m => { machineMap[m.id] = { id:m.id, code:m.code, type:m.type, brand:m.brand||'', capacity:m.capacity||'' }; }));
        await DB.meta.setItem('condominiums', normalized);
        await DB.meta.setItem('machines', machineMap);
      }
    }
    if (rs && rs.ok) {
      const rows = await rs.json();
      if (Array.isArray(rows) && rows.length) {
        const queue = rows.map(r => ({ id:r.id, condoId:r.condo_id, date:r.date, scheduledTime:r.scheduled_time, type:r.type }));
        await DB.meta.setItem('visitsQueue', queue);
      }
    }
  } catch(e) { /* offline: use local seed */ }

  const user = await DB.meta.getItem('user');
  if (user) { state.user = user; state.route = 'list'; }
  renderRoute();
})();

function renderRoute() {
  if (state.route === 'login') return render(LoginView());
  if (state.route === 'list') return render(ListView());
  if (state.route === 'visit') return render(VisitView());
  if (state.route === 'summary') return render(SummaryView());
  if (state.route === 'route') return render(RouteView());
  if (state.route === 'history') return render(HistoryView());
}

// ---------- Icons (inline SVG) ----------
const Icon = {
  back: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>`,
  chevron:`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>`,
  check:`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  camera:`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>`,
  trash:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>`,
  plus:`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
  location:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`,
  pdf:`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`,
  share:`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.6" y1="13.5" x2="15.4" y2="17.5"/><line x1="15.4" y1="6.5" x2="8.6" y2="10.5"/></svg>`,
};

// ---------- Views ----------
function LoginView() {
  const view = h(`
    <main style="min-height:100vh;position:relative;overflow:hidden;background:#0B0A1A;color:#fff">
      <style>
        @keyframes wa-float { 0%,100%{transform:translate(0,0) scale(1)} 33%{transform:translate(30px,-20px) scale(1.08)} 66%{transform:translate(-20px,15px) scale(.95)} }
        @keyframes wa-slide { from{opacity:0;transform:translateY(12px)} to{opacity:1;transform:translateY(0)} }
        .wa-blob{position:absolute;border-radius:50%;filter:blur(60px);pointer-events:none;animation:wa-float 18s ease-in-out infinite}
        .wa-in{animation:wa-slide 600ms cubic-bezier(.16,1,.3,1) both}
      </style>
      <div class="wa-blob" style="width:400px;height:400px;background:#A292D5;top:-10%;left:-20%;opacity:.55"></div>
      <div class="wa-blob" style="width:320px;height:320px;background:#654ABA;bottom:-10%;right:-15%;opacity:.55;animation-delay:-8s"></div>
      <div class="wa-blob" style="width:220px;height:220px;background:#fff;top:40%;left:50%;opacity:.1;animation-delay:-14s"></div>

      <div class="safe-top" style="position:relative;z-index:2;padding:36px 24px 20px;display:flex;align-items:center;gap:10px">
        <img src="/logo.svg" alt="Lavandery" style="height:28px;filter:brightness(0) invert(1)"/>
        <span style="color:rgba(255,255,255,.7);font-size:13px;letter-spacing:.01em">· App do Técnico</span>
      </div>

      <section style="position:relative;z-index:2;padding:0 24px;margin-top:40px" class="wa-in">
        <div style="font-size:11px;font-weight:700;letter-spacing:.18em;color:rgba(255,255,255,.65);text-transform:uppercase">Vistorias técnicas</div>
        <h1 style="font-size:36px;font-weight:700;line-height:1.08;letter-spacing:-0.03em;margin:14px 0 10px;background:linear-gradient(180deg,#fff,rgba(255,255,255,.82));-webkit-background-clip:text;background-clip:text;color:transparent">
          Olá, técnico 👷‍♂️<br/>vamos começar?
        </h1>
        <p style="color:rgba(255,255,255,.72);font-size:15px;line-height:1.5;max-width:320px">Acesse sua agenda do dia, faça vistorias e gere relatórios com assinatura em minutos.</p>
      </section>

      <form id="loginForm" style="position:relative;z-index:2;padding:40px 24px 32px;display:flex;flex-direction:column;flex:1;margin-top:30px" class="wa-in" style="animation-delay:120ms">
        <div style="background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);backdrop-filter:blur(12px);border-radius:20px;padding:22px">
          <label style="font-size:11px;font-weight:600;color:rgba(255,255,255,.7);letter-spacing:.05em;text-transform:uppercase;display:block;margin-bottom:6px">E-mail</label>
          <input class="input" style="background:rgba(255,255,255,.95);border:none;color:#0B0A1A;margin-bottom:14px" type="email" name="email" placeholder="seu@lavandery.com.br" required autocomplete="email"/>
          <label style="font-size:11px;font-weight:600;color:rgba(255,255,255,.7);letter-spacing:.05em;text-transform:uppercase;display:block;margin-bottom:6px">Senha</label>
          <input class="input" style="background:rgba(255,255,255,.95);border:none;color:#0B0A1A" type="password" name="password" placeholder="••••••••" required autocomplete="current-password"/>
        </div>

        <div style="margin-top:auto;padding-top:28px">
          <button class="btn" style="width:100%;min-height:54px;background:linear-gradient(135deg,#fff,rgba(255,255,255,.92));color:#533C9D;border-radius:14px;font-weight:700;font-size:15px;box-shadow:0 12px 32px -8px rgba(255,255,255,.3);letter-spacing:-0.01em">
            Entrar e começar o dia
          </button>
          <a href="/login.html" style="display:block;text-align:center;margin-top:16px;color:rgba(255,255,255,.7);font-size:13px;text-decoration:none">Sou gestor · acessar painel administrativo</a>
        </div>
      </form>
    </main>
  `);

  view.querySelector('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const email = (f.get('email')||'').toString().trim().toLowerCase();
    const password = (f.get('password')||'').toString();
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ email, password })
      });
      const d = await r.json();
      if (!r.ok) { toast(r.status === 401 ? 'E-mail ou senha inválidos' : (d.error||'Erro')); return; }
      // Compat: popular state local
      const condos = await DB.meta.getItem('condominiums');
      const techs = await DB.meta.getItem('technicians') || [];
      const t = techs.find(x => x.email.toLowerCase() === email);
      state.user = t || { id: d.user.id, name: d.user.name, email: d.user.email };
      await DB.meta.setItem('user', state.user);
      state.route = 'list'; renderRoute();
    } catch(ex) { toast('Erro de conexão'); }
  });

  return view;
}

function ListView() {
  const view = h(`<main class="min-h-screen">
    <header class="topbar safe-top px-5 py-3 flex items-center justify-between">
      <div>
        <div class="text-xs text-gray-500">Olá,</div>
        <div class="font-semibold tracking-tight">${state.user.name}</div>
      </div>
      <button id="logout" class="text-sm text-gray-500">Sair</button>
    </header>

    <section class="px-5 pt-4 pb-2 flex items-start justify-between">
      <div>
        <h1 class="step-title">Visitas de hoje</h1>
        <p class="step-sub">${fmtDate(new Date())}</p>
      </div>
      <button id="routeBtn" class="chip chip-success" aria-pressed="true" style="align-self:center">🗺️ Rota</button>
    </section>

    <section id="list" class="px-5 pb-28 space-y-3"></section>

    <section class="px-5 pt-2 pb-6">
      <div class="hairline my-5"></div>
      <h2 class="font-semibold tracking-tight mb-2">Outras unidades</h2>
      <div id="otherList" class="space-y-3"></div>
    </section>

    <div id="pendingBar" class="bottombar safe-bottom px-5 py-3 hidden">
      <button id="continueDraft" class="btn btn-ghost">Retomar visita em andamento ${Icon.chevron}</button>
    </div>
  </main>`);

  view.querySelector('#routeBtn').addEventListener('click', () => { state.route='route'; renderRoute(); });

  view.querySelector('#logout').addEventListener('click', async () => {
    await DB.meta.removeItem('user'); state.user=null; state.route='login'; renderRoute();
  });

  (async () => {
    const condos = await DB.meta.getItem('condominiums');
    const queue = await DB.meta.getItem('visitsQueue');
    const drafts = [];
    await DB.visits.iterate(v => { if (v.status==='draft' && v.technicianId===state.user.id) drafts.push(v); });

    const todayQueue = queue.filter(q => q.date === new Date().toISOString().slice(0,10));
    const listEl = view.querySelector('#list');
    if (todayQueue.length === 0) {
      listEl.appendChild(h(`<div class="card text-center text-gray-500 text-sm">Nenhuma visita agendada para hoje.</div>`));
    }
    for (const q of todayQueue) {
      const condo = condos.find(c => c.id === q.condoId);
      const row = h(`
        <button class="card w-full text-left active:scale-[.99] transition">
          <div class="flex items-center justify-between">
            <div>
              <div class="font-semibold tracking-tight">${condo.name}</div>
              <div class="text-sm text-gray-500 mt-0.5">${condo.address}</div>
              <div class="flex items-center gap-2 mt-3 flex-wrap">
                <span class="chip" aria-pressed="true">${q.type}</span>
                <span class="chip"><span class="dot dot-yellow"></span>Agendada · ${q.scheduledTime||'—'}</span>
              </div>
            </div>
            <span class="text-gray-400">${Icon.chevron}</span>
          </div>
        </button>
      `);
      row.addEventListener('click', () => startVisit(condo.id, q.type, q.id, q.scheduledTime, q.date));
      listEl.appendChild(row);
    }

    const otherEl = view.querySelector('#otherList');
    for (const c of condos) {
      const row = h(`<button class="row w-full text-left active:scale-[.99] transition">
        <div class="flex-1">
          <div class="font-medium">${c.name}</div>
          <div class="text-xs text-gray-500">${c.city}</div>
        </div>
        <span class="text-gray-400">${Icon.chevron}</span>
      </button>`);
      row.addEventListener('click', () => startVisit(c.id, 'Avulsa', null, null, null));
      otherEl.appendChild(row);
    }

    if (drafts.length) {
      const bar = view.querySelector('#pendingBar');
      bar.classList.remove('hidden');
      bar.querySelector('#continueDraft').addEventListener('click', () => {
        state.visit = drafts.sort((a,b)=>b.updatedAt-a.updatedAt)[0];
        state.step = state.visit.lastStep || 0;
        state.route = 'visit'; renderRoute();
      });
    }
  })();

  return view;
}

async function startVisit(condoId, type, queueId, scheduledTime, scheduledDate) {
  const condos = await DB.meta.getItem('condominiums');
  const machines = await DB.meta.getItem('machines');
  const condo = condos.find(c => c.id === condoId);
  const machineList = (condo.machines||[]).map(id => ({
    machineId: id, code: machines[id].code, type: machines[id].type,
    status: 'ok', problem: '', notes: '', requiresPhoto: false
  }));

  const visit = {
    id: uid(),
    status: 'draft',
    technicianId: state.user.id,
    technicianName: state.user.name,
    condoId,
    condoName: condo.name,
    visitType: type,
    queueId,
    scheduledAt: (scheduledDate && scheduledTime) ? new Date(`${scheduledDate}T${scheduledTime}:00`).getTime() : null,
    startedAt: Date.now(),
    checkin: { datetime: Date.now(), geo: null },
    checkout: { datetime: null, geo: null },
    general: { overall: '', notes: '' },
    infrastructure: { energy:'ok', internet:'ok', lighting:'ok', exhaust:'ok', drainage:'ok', cleaning:'ok', notes:'' },
    machines: machineList,
    supplies: { soap:'ok', softener:'ok', doser:'ok', replenishNeeded:false, notes:'' },
    photos: [], // {id, tag, ts, thumb}
    conclusion: { summary:'', pending:'', action:'', deadline:'', needsReturn:false, techSignature:null, responsibleSignature:null, responsibleName:'' },
    score: 100,
    updatedAt: Date.now(),
    lastStep: 0,
  };

  // Geolocation (optional)
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (p) => { visit.checkin.geo = { lat:p.coords.latitude, lng:p.coords.longitude, acc:p.coords.accuracy }; saveDraft(); },
      () => {}, { timeout: 4000, maximumAge: 60000 }
    );
  }

  state.visit = visit; state.step = 0;
  await saveDraft();
  state.route = 'visit'; renderRoute();
}

// ---------- Visit flow ----------
const STEPS = [
  { key:'general', title:'Dados gerais',    sub:'Informações da visita' },
  { key:'infra',   title:'Infraestrutura',  sub:'Instalações do local'  },
  { key:'machines',title:'Máquinas',        sub:'Equipamentos cadastrados' },
  { key:'supplies',title:'Insumos',         sub:'Consumíveis em estoque' },
  { key:'photos',  title:'Fotos',           sub:'Registro visual' },
  { key:'conclude',title:'Conclusão',       sub:'Pendências e assinatura' },
];

function VisitView() {
  const total = STEPS.length;
  const pct = Math.round(((state.step) / (total-1)) * 100);
  const step = STEPS[state.step];
  const view = h(`<main class="min-h-screen flex flex-col">
    <header class="topbar safe-top px-5 pt-3 pb-3">
      <div class="flex items-center justify-between mb-3">
        <button id="back" class="text-gray-600 w-10 h-10 -ml-2 flex items-center justify-center rounded-full active:bg-gray-100">${Icon.back}</button>
        <div class="text-sm text-gray-500">Etapa ${state.step+1} de ${total}</div>
        <button id="saveExit" class="text-sm text-gray-500">Salvar</button>
      </div>
      <div class="progress"><div class="progress-fill" style="width:${pct}%"></div></div>
      <div class="mt-4">
        <div class="step-title">${step.title}</div>
        <div class="step-sub">${state.visit.condoName} · ${step.sub}</div>
      </div>
    </header>

    <section id="stepBody" class="px-5 py-5 flex-1"></section>

    <footer class="bottombar safe-bottom px-5 py-3 flex gap-3">
      <button id="prev" class="btn btn-ghost ${state.step===0?'hidden':''}">Voltar</button>
      <button id="next" class="btn btn-primary">${state.step === total-1 ? 'Revisar' : 'Continuar'}</button>
    </footer>
  </main>`);

  view.querySelector('#back').addEventListener('click', async () => {
    await saveDraft(); state.route='list'; renderRoute();
  });
  view.querySelector('#saveExit').addEventListener('click', async () => {
    await saveDraft(); toast('Rascunho salvo'); state.route='list'; renderRoute();
  });
  view.querySelector('#prev')?.addEventListener('click', () => { state.step--; state.visit.lastStep=state.step; scheduleSave(); renderRoute(); });
  view.querySelector('#next').addEventListener('click', async () => {
    const err = validateStep(state.step);
    if (err) { toast(err); return; }
    if (state.step === STEPS.length - 1) { state.route = 'summary'; renderRoute(); return; }
    state.step++; state.visit.lastStep=state.step; await saveDraft(); renderRoute();
  });

  const body = view.querySelector('#stepBody');
  body.appendChild(renderStep(state.step));
  return view;
}

function renderStep(i) {
  return [StepGeneral, StepInfra, StepMachines, StepSupplies, StepPhotos, StepConclude][i]();
}

// ---------- Step 1: General ----------
function StepGeneral() {
  const v = state.visit;
  const el = h(`<div class="space-y-5">
    <div class="card">
      <div class="flex items-center gap-2 text-xs text-gray-500 mb-3">${Icon.location}<span>Check-in</span></div>
      ${v.scheduledAt ? `<div class="text-sm"><span class="text-gray-500">Agendada para: </span><b>${fmtDateTime(v.scheduledAt)}</b></div>`:''}
      <div class="text-sm mt-1"><span class="text-gray-500">Chegada: </span><b>${fmtDateTime(v.checkin.datetime)}</b></div>
      <div class="text-sm mt-1"><span class="text-gray-500">Técnico: </span><b>${v.technicianName}</b></div>
      <div id="geo" class="text-sm mt-1"><span class="text-gray-500">Local: </span>${v.checkin.geo ? `${v.checkin.geo.lat.toFixed(4)}, ${v.checkin.geo.lng.toFixed(4)}` : '<span class="text-gray-400">aguardando…</span>'}</div>
    </div>

    <div>
      <label class="label">Condomínio</label>
      <input class="input" value="${v.condoName}" disabled />
    </div>

    <div>
      <label class="label">Tipo de visita</label>
      <div class="flex flex-wrap gap-2" id="typeChips">
        ${['Preventiva','Corretiva','Instalação','Avulsa'].map(t => `<button type="button" class="chip" data-t="${t}" aria-pressed="${v.visitType===t}">${t}</button>`).join('')}
      </div>
    </div>

    <div>
      <label class="label">Status geral da lavanderia</label>
      <div class="flex flex-wrap gap-2" id="overallChips">
        ${[['Excelente','success'],['Boa','success'],['Regular',''],['Crítica','danger']].map(([t,cls]) =>
          `<button type="button" class="chip ${cls?'chip-'+cls:''}" data-o="${t}" aria-pressed="${v.general.overall===t}">${t}</button>`).join('')}
      </div>
    </div>

    <div>
      <label class="label">Observações</label>
      <textarea class="textarea" id="notes" placeholder="Descreva o estado geral, acesso, condições de trabalho...">${v.general.notes||''}</textarea>
    </div>
  </div>`);

  el.querySelectorAll('#typeChips .chip').forEach(ch => ch.addEventListener('click', () => {
    v.visitType = ch.dataset.t;
    el.querySelectorAll('#typeChips .chip').forEach(c => c.setAttribute('aria-pressed', c.dataset.t === v.visitType));
    scheduleSave();
  }));
  el.querySelectorAll('#overallChips .chip').forEach(ch => ch.addEventListener('click', () => {
    v.general.overall = ch.dataset.o;
    el.querySelectorAll('#overallChips .chip').forEach(c => c.setAttribute('aria-pressed', c.dataset.o === v.general.overall));
    scheduleSave();
  }));
  el.querySelector('#notes').addEventListener('input', e => { v.general.notes = e.target.value; scheduleSave(); });
  return el;
}

// ---------- Step 2: Infrastructure ----------
function StepInfra() {
  const v = state.visit;
  const items = [
    ['energy','Energia'],['internet','Internet'],['lighting','Iluminação'],
    ['exhaust','Exaustão'],['drainage','Drenagem'],['cleaning','Limpeza']
  ];
  const el = h(`<div class="space-y-4">
    ${items.map(([k,label]) => `
      <div class="card">
        <div class="flex items-center justify-between">
          <div class="font-medium">${label}</div>
          <div class="flex gap-2" data-key="${k}">
            <button type="button" class="chip chip-success" data-s="ok" aria-pressed="${v.infrastructure[k]==='ok'}">OK</button>
            <button type="button" class="chip" data-s="warn" aria-pressed="${v.infrastructure[k]==='warn'}">Atenção</button>
            <button type="button" class="chip chip-danger" data-s="fail" aria-pressed="${v.infrastructure[k]==='fail'}">Problema</button>
          </div>
        </div>
      </div>
    `).join('')}
    <div>
      <label class="label">Observações de infraestrutura</label>
      <textarea class="textarea" id="infraNotes" placeholder="Detalhes adicionais...">${v.infrastructure.notes||''}</textarea>
    </div>
  </div>`);
  el.querySelectorAll('[data-key]').forEach(group => {
    const k = group.dataset.key;
    group.querySelectorAll('.chip').forEach(ch => ch.addEventListener('click', () => {
      v.infrastructure[k] = ch.dataset.s;
      group.querySelectorAll('.chip').forEach(c => c.setAttribute('aria-pressed', c.dataset.s === v.infrastructure[k]));
      scheduleSave();
    }));
  });
  el.querySelector('#infraNotes').addEventListener('input', e => { v.infrastructure.notes = e.target.value; scheduleSave(); });
  return el;
}

// ---------- Step 3: Machines ----------
function StepMachines() {
  const v = state.visit;
  const el = h(`<div class="space-y-4" id="machines"></div>`);
  const render = () => {
    el.innerHTML = '';
    v.machines.forEach((m, idx) => {
      const card = h(`<div class="card">
        <div class="flex items-center justify-between mb-3">
          <div>
            <div class="font-semibold tracking-tight">${m.code}</div>
            <div class="text-xs text-gray-500">${m.type}</div>
          </div>
          <span class="chip ${m.status==='ok'?'chip-success':m.status==='fail'?'chip-danger':''}" aria-pressed="true">
            <span class="dot ${m.status==='ok'?'dot-green':m.status==='fail'?'dot-red':m.status==='warn'?'dot-yellow':'dot-gray'}"></span>
            ${m.status==='ok'?'Operando':m.status==='warn'?'Com alerta':m.status==='fail'?'Inoperante':'—'}
          </span>
        </div>
        <div class="flex gap-2 mb-3" data-idx="${idx}">
          <button type="button" class="chip chip-success flex-1" data-s="ok" aria-pressed="${m.status==='ok'}">OK</button>
          <button type="button" class="chip flex-1" data-s="warn" aria-pressed="${m.status==='warn'}">Alerta</button>
          <button type="button" class="chip chip-danger flex-1" data-s="fail" aria-pressed="${m.status==='fail'}">Inoperante</button>
        </div>
        ${m.status !== 'ok' ? `
          <label class="label">Problema</label>
          <select class="select mb-3" data-field="problem">
            <option value="">Selecione…</option>
            ${['Mau uso','Falha técnica','Infraestrutura','Internet','Insumos','Outro'].map(p=>`<option ${m.problem===p?'selected':''}>${p}</option>`).join('')}
          </select>
          <label class="label">Descrição</label>
          <textarea class="textarea" data-field="notes" placeholder="Descreva o problema...">${m.notes||''}</textarea>
          ${m.status==='fail' ? `<p class="kbd mt-2">⚠ Foto obrigatória na etapa 5.</p>` : ''}
        ` : ''}
      </div>`);
      card.querySelectorAll('[data-s]').forEach(btn => btn.addEventListener('click', () => {
        m.status = btn.dataset.s;
        if (m.status === 'ok') { m.problem = ''; m.notes=''; }
        m.requiresPhoto = (m.status === 'fail');
        scheduleSave();
        render();
      }));
      card.querySelectorAll('[data-field]').forEach(inp => inp.addEventListener('input', () => {
        m[inp.dataset.field] = inp.value; scheduleSave();
      }));
      el.appendChild(card);
    });
  };
  render();
  return el;
}

// ---------- Step 4: Supplies ----------
function StepSupplies() {
  const v = state.visit;
  const items = [['soap','Sabão'],['softener','Amaciante'],['doser','Dosadora']];
  const el = h(`<div class="space-y-4">
    ${items.map(([k,label])=>`
      <div class="card">
        <div class="flex items-center justify-between">
          <div class="font-medium">${label}</div>
          <div class="flex gap-2" data-key="${k}">
            <button type="button" class="chip chip-success" data-s="ok" aria-pressed="${v.supplies[k]==='ok'}">OK</button>
            <button type="button" class="chip" data-s="low" aria-pressed="${v.supplies[k]==='low'}">Baixo</button>
            <button type="button" class="chip chip-danger" data-s="out" aria-pressed="${v.supplies[k]==='out'}">Acabou</button>
          </div>
        </div>
      </div>
    `).join('')}
    <div class="card flex items-center justify-between">
      <div>
        <div class="font-medium">Necessita reposição</div>
        <div class="text-xs text-gray-500">Abre pedido logístico</div>
      </div>
      <button id="replenish" class="chip ${v.supplies.replenishNeeded?'chip-danger':''}" aria-pressed="${v.supplies.replenishNeeded}">${v.supplies.replenishNeeded?'Sim':'Não'}</button>
    </div>
    <div>
      <label class="label">Observações</label>
      <textarea class="textarea" id="supplyNotes" placeholder="Ex: sabão até sexta, dosadora vazando...">${v.supplies.notes||''}</textarea>
    </div>
  </div>`);
  el.querySelectorAll('[data-key]').forEach(group => {
    const k = group.dataset.key;
    group.querySelectorAll('.chip').forEach(ch => ch.addEventListener('click', () => {
      v.supplies[k] = ch.dataset.s;
      group.querySelectorAll('.chip').forEach(c => c.setAttribute('aria-pressed', c.dataset.s === v.supplies[k]));
      // auto-mark replenish
      if (['low','out'].includes(ch.dataset.s)) {
        v.supplies.replenishNeeded = true;
        const btn = el.querySelector('#replenish'); btn.setAttribute('aria-pressed','true'); btn.classList.add('chip-danger'); btn.textContent='Sim';
      }
      scheduleSave();
    }));
  });
  el.querySelector('#replenish').addEventListener('click', (e) => {
    v.supplies.replenishNeeded = !v.supplies.replenishNeeded;
    e.target.setAttribute('aria-pressed', v.supplies.replenishNeeded);
    e.target.classList.toggle('chip-danger', v.supplies.replenishNeeded);
    e.target.textContent = v.supplies.replenishNeeded ? 'Sim' : 'Não';
    scheduleSave();
  });
  el.querySelector('#supplyNotes').addEventListener('input', e => { v.supplies.notes = e.target.value; scheduleSave(); });
  return el;
}

// ---------- Step 5: Photos ----------
function StepPhotos() {
  const v = state.visit;
  const el = h(`<div class="space-y-4">
    <div class="flex items-center gap-2 overflow-x-auto -mx-5 px-5 pb-1" id="tags">
      ${['lavanderia','máquina','erro','infraestrutura'].map(t=>`<button class="chip" data-tag="${t}" aria-pressed="${(window._currentTag||'lavanderia')===t}">${t}</button>`).join('')}
    </div>

    <div class="grid grid-cols-3 gap-3" id="grid"></div>

    <div class="pt-2">
      <label class="btn btn-ghost" for="fileInput">${Icon.camera} Adicionar fotos</label>
      <input id="fileInput" type="file" accept="image/*" capture="environment" multiple class="hidden"/>
    </div>

    <p class="kbd">Dica: fotos são comprimidas automaticamente e carimbadas com data/hora.</p>
  </div>`);

  window._currentTag = window._currentTag || 'lavanderia';
  const rerenderGrid = async () => {
    const grid = el.querySelector('#grid');
    grid.innerHTML = '';
    if (!v.photos.length) {
      grid.innerHTML = `<div class="col-span-3 text-center text-sm text-gray-400 py-10 border border-dashed border-gray-200 rounded-xl">Nenhuma foto ainda</div>`;
      return;
    }
    for (const p of v.photos) {
      const tile = h(`<div class="photo-tile">
        <img src="${p.thumb}" alt="">
        <span class="tag">${p.tag}</span>
        <span class="ts">${fmtDateTime(p.ts)}</span>
        <button class="rm" data-id="${p.id}">${Icon.trash}</button>
      </div>`);
      tile.querySelector('.rm').addEventListener('click', async (e) => {
        e.stopPropagation();
        v.photos = v.photos.filter(x => x.id !== p.id);
        await DB.photos.removeItem(p.id);
        scheduleSave();
        rerenderGrid();
      });
      grid.appendChild(tile);
    }
  };

  el.querySelectorAll('#tags .chip').forEach(ch => ch.addEventListener('click', () => {
    window._currentTag = ch.dataset.tag;
    el.querySelectorAll('#tags .chip').forEach(c => c.setAttribute('aria-pressed', c.dataset.tag === window._currentTag));
  }));

  el.querySelector('#fileInput').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    for (const f of files) {
      const { thumb, full } = await processImage(f);
      const id = uid();
      const photo = { id, tag: window._currentTag, ts: Date.now(), thumb };
      await DB.photos.setItem(id, { full });
      v.photos.push(photo);
      scheduleSave();
    }
    e.target.value = '';
    rerenderGrid();
  });

  rerenderGrid();
  return el;
}

// Upload visit photos to Firebase Storage (fire-and-forget; safe to fail offline)
async function uploadPhotosToFirebase(v) {
  if (!v || !Array.isArray(v.photos) || !v.photos.length) return;
  const pending = v.photos.filter(p => !p.remote_url);
  if (!pending.length) return;
  for (const p of pending) {
    try {
      const rec = await DB.photos.getItem(p.id);
      if (!rec?.full) continue;
      // dataURL → Blob
      const resp = await fetch(rec.full);
      const blob = await resp.blob();
      const fd = new FormData();
      fd.append('file', blob, `${p.tag||'foto'}.jpg`);
      fd.append('visit_id', v.id);
      fd.append('tag', p.tag||'foto');
      const up = await fetch('/api/uploads/photo', { method:'POST', body: fd });
      if (!up.ok) throw new Error('upload_failed_'+up.status);
      const j = await up.json();
      p.remote_url = j.url;
      p.remote_key = j.key;
    } catch (e) { p.upload_error = String(e?.message||e); }
  }
  await DB.visits.setItem(v.id, v);
}

async function processImage(file) {
  const dataUrl = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(file); });
  const img = await new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = dataUrl; });
  const maxW = 1600, scale = Math.min(1, maxW / img.width);
  const cv = document.createElement('canvas'); cv.width = img.width*scale|0; cv.height = img.height*scale|0;
  const ctx = cv.getContext('2d'); ctx.drawImage(img, 0, 0, cv.width, cv.height);
  // Timestamp watermark
  const ts = new Date().toLocaleString('pt-BR');
  ctx.font = `${Math.max(16, cv.width*0.02)}px Inter, system-ui, sans-serif`;
  ctx.textBaseline = 'bottom';
  const label = `Lavandery · ${ts}`;
  const tw = ctx.measureText(label).width;
  ctx.fillStyle = 'rgba(0,0,0,.55)';
  ctx.fillRect(cv.width - tw - 24, cv.height - 36, tw + 20, 30);
  ctx.fillStyle = '#fff'; ctx.fillText(label, cv.width - tw - 14, cv.height - 12);

  const full = cv.toDataURL('image/jpeg', 0.78);
  // thumb
  const tc = document.createElement('canvas'); const ts2 = 360; tc.width = ts2; tc.height = ts2;
  const s = Math.min(cv.width, cv.height); const sx = (cv.width-s)/2, sy=(cv.height-s)/2;
  tc.getContext('2d').drawImage(cv, sx, sy, s, s, 0, 0, ts2, ts2);
  const thumb = tc.toDataURL('image/jpeg', 0.72);
  return { thumb, full };
}

// ---------- Step 6: Conclusion ----------
function StepConclude() {
  const v = state.visit;
  const el = h(`<div class="space-y-5">
    <div>
      <label class="label">Resumo técnico</label>
      <textarea class="textarea" id="summary" placeholder="Resumo do que foi feito na visita...">${v.conclusion.summary||''}</textarea>
    </div>
    <div>
      <label class="label">Pendências</label>
      <textarea class="textarea" id="pending" placeholder="O que ficou pendente?">${v.conclusion.pending||''}</textarea>
    </div>
    <div>
      <label class="label">Ação necessária</label>
      <textarea class="textarea" id="action" placeholder="Próxima ação recomendada...">${v.conclusion.action||''}</textarea>
    </div>
    <div class="grid grid-cols-2 gap-3">
      <div>
        <label class="label">Prazo</label>
        <input class="input" type="date" id="deadline" value="${v.conclusion.deadline||''}"/>
      </div>
      <div>
        <label class="label">Retorno?</label>
        <button id="needsReturn" class="chip ${v.conclusion.needsReturn?'chip-danger':''} w-full justify-center" style="min-height:52px" aria-pressed="${v.conclusion.needsReturn}">${v.conclusion.needsReturn?'Sim':'Não'}</button>
      </div>
    </div>

    <div class="card">
      <div class="font-medium mb-2">Assinatura do técnico</div>
      <div class="sig-wrap" id="sigTechWrap"><canvas id="sigTech"></canvas>${v.conclusion.techSignature?'':'<div class="hint">Assine aqui</div>'}</div>
      <div class="flex gap-2 mt-2">
        <button class="btn btn-ghost" id="clearTech">Limpar</button>
      </div>
    </div>

    <div class="card">
      <label class="label">Nome do responsável</label>
      <input class="input mb-3" id="respName" value="${v.conclusion.responsibleName||''}" placeholder="Síndico, zelador, etc."/>
      <label class="label">E-mail do responsável <span class="text-gray-400 font-normal">(para Autentique)</span></label>
      <input class="input mb-3" id="respEmail" type="email" value="${v.conclusion.responsibleEmail||''}" placeholder="sindico@condominio.com"/>
      <div class="font-medium mb-2">Assinatura do responsável</div>
      <div class="sig-wrap" id="sigRespWrap"><canvas id="sigResp"></canvas>${v.conclusion.responsibleSignature?'':'<div class="hint">Assine aqui</div>'}</div>
      <div class="flex gap-2 mt-2">
        <button class="btn btn-ghost" id="clearResp">Limpar</button>
      </div>
    </div>
  </div>`);

  ['summary','pending','action'].forEach(k => el.querySelector('#'+k).addEventListener('input', e => { v.conclusion[k] = e.target.value; scheduleSave(); }));
  el.querySelector('#deadline').addEventListener('change', e => { v.conclusion.deadline = e.target.value; scheduleSave(); });
  const nr = el.querySelector('#needsReturn');
  nr.addEventListener('click', () => {
    v.conclusion.needsReturn = !v.conclusion.needsReturn;
    nr.setAttribute('aria-pressed', v.conclusion.needsReturn);
    nr.classList.toggle('chip-danger', v.conclusion.needsReturn);
    nr.textContent = v.conclusion.needsReturn ? 'Sim' : 'Não';
    scheduleSave();
  });
  el.querySelector('#respName').addEventListener('input', e => { v.conclusion.responsibleName = e.target.value; scheduleSave(); });
  el.querySelector('#respEmail').addEventListener('input', e => { v.conclusion.responsibleEmail = e.target.value; scheduleSave(); });

  // Signature pads (init after mount)
  requestAnimationFrame(() => {
    [['sigTech','techSignature','clearTech'],['sigResp','responsibleSignature','clearResp']].forEach(([cid, key, bid]) => {
      const canvas = el.querySelector('#'+cid);
      const wrap = canvas.parentElement;
      const ratio = Math.max(window.devicePixelRatio || 1, 1);
      canvas.width = wrap.clientWidth * ratio;
      canvas.height = wrap.clientHeight * ratio;
      canvas.getContext('2d').scale(ratio, ratio);
      const pad = new SignaturePad(canvas, { backgroundColor: 'rgba(255,255,255,0)', penColor: '#111827' });
      if (v.conclusion[key]) { pad.fromDataURL(v.conclusion[key]); wrap.querySelector('.hint')?.remove(); }
      pad.addEventListener('beginStroke', () => { wrap.querySelector('.hint')?.remove(); });
      pad.addEventListener('endStroke', () => { v.conclusion[key] = pad.toDataURL('image/png'); scheduleSave(); });
      el.querySelector('#'+bid).addEventListener('click', () => { pad.clear(); v.conclusion[key] = null; scheduleSave(); });
    });
  });

  return el;
}

// ---------- Validation (dynamic required fields) ----------
function validateStep(i) {
  const v = state.visit;
  if (i === 0) {
    if (!v.visitType) return 'Selecione o tipo de visita';
    if (!v.general.overall) return 'Selecione o status geral';
  }
  if (i === 2) {
    for (const m of v.machines) {
      if (m.status !== 'ok') {
        if (!m.problem) return `Selecione o problema em ${m.code}`;
        if (!m.notes || m.notes.trim().length < 5) return `Descreva o problema em ${m.code}`;
      }
    }
  }
  if (i === 4) {
    // If any machine is inoperante, require a photo with tag "máquina" or "erro"
    const failing = v.machines.filter(m => m.status === 'fail');
    if (failing.length) {
      const hasProof = v.photos.some(p => p.tag === 'máquina' || p.tag === 'erro');
      if (!hasProof) return 'Fotos obrigatórias: adicione imagens da máquina ou do erro';
    }
  }
  if (i === 5) {
    const c = v.conclusion;
    if (!c.summary || c.summary.trim().length < 10) return 'Escreva um resumo técnico (10+ caracteres)';
    if (!c.techSignature) return 'Assinatura do técnico é obrigatória';
  }
  return null;
}

// ---------- Summary / Finalize ----------
function computeScore(v) {
  let s = 100;
  s -= v.machines.filter(m=>m.status==='fail').length * 15;
  s -= v.machines.filter(m=>m.status==='warn').length * 6;
  const infraFails = Object.entries(v.infrastructure).filter(([k,val]) => k!=='notes' && val==='fail').length;
  s -= infraFails * 8;
  const supOut = ['soap','softener','doser'].filter(k => v.supplies[k]==='out').length;
  const supLow = ['soap','softener','doser'].filter(k => v.supplies[k]==='low').length;
  s -= supOut * 7 + supLow * 3;
  if (v.conclusion.needsReturn) s -= 5;
  return Math.max(0, Math.min(100, s));
}

function classifyIssues(v) {
  const buckets = { 'Mau uso':0, 'Falha técnica':0, 'Infraestrutura':0, 'Internet':0, 'Insumos':0, 'Outro':0 };
  v.machines.forEach(m => { if (m.problem) buckets[m.problem] = (buckets[m.problem]||0)+1; });
  if (Object.values(v.infrastructure).some(x=>x==='fail')) buckets['Infraestrutura'] += 1;
  if (v.infrastructure.internet === 'fail') buckets['Internet'] += 1;
  if (['low','out'].some(s => [v.supplies.soap, v.supplies.softener].includes(s))) buckets['Insumos'] += 1;
  return buckets;
}

function SummaryView() {
  const v = state.visit;
  v.score = computeScore(v);
  const issues = classifyIssues(v);
  const failing = v.machines.filter(m=>m.status!=='ok');

  const view = h(`<main class="min-h-screen">
    <header class="topbar safe-top px-5 py-3 flex items-center justify-between">
      <button id="back" class="text-gray-600 w-10 h-10 -ml-2 flex items-center justify-center rounded-full active:bg-gray-100">${Icon.back}</button>
      <div class="text-sm text-gray-500">Revisão</div>
      <span></span>
    </header>

    <section class="px-5 pt-2 pb-4">
      <h1 class="step-title">Resumo da visita</h1>
      <p class="step-sub">${v.condoName} · ${fmtDateTime(v.checkin.datetime)}</p>
    </section>

    <section class="px-5 space-y-4 pb-28">
      <div class="card text-center">
        <div class="text-xs uppercase tracking-widest text-gray-500">Score da lavanderia</div>
        <div class="text-5xl font-bold tracking-tight mt-2" style="color:${v.score>=80?'#16A34A':v.score>=60?'#F59E0B':'#DC2626'}">${v.score}</div>
        <div class="text-sm text-gray-500 mt-1">${v.score>=80?'Ótimo estado':v.score>=60?'Requer atenção':'Crítico'}</div>
      </div>

      <div class="card">
        <div class="font-semibold mb-2">Máquinas</div>
        ${v.machines.map(m => `<div class="flex items-center justify-between py-1.5 text-sm"><span>${m.code} · <span class="text-gray-500">${m.type}</span></span><span><span class="dot ${m.status==='ok'?'dot-green':m.status==='fail'?'dot-red':'dot-yellow'}"></span> ${m.status==='ok'?'OK':m.status==='fail'?'Inoperante':'Alerta'}</span></div>`).join('')}
      </div>

      ${failing.length ? `<div class="card">
        <div class="font-semibold mb-2">Problemas relatados</div>
        ${failing.map(m=>`<div class="text-sm mb-2"><b>${m.code}:</b> ${m.problem} — <span class="text-gray-600">${m.notes}</span></div>`).join('')}
      </div>`:''}

      <div class="card">
        <div class="font-semibold mb-2">Classificação</div>
        <div class="flex flex-wrap gap-2">
          ${Object.entries(issues).filter(([,n])=>n>0).map(([k,n])=>`<span class="chip" aria-pressed="true">${k} · ${n}</span>`).join('') || '<span class="text-sm text-gray-500">Nenhum problema</span>'}
        </div>
      </div>

      <div class="card">
        <div class="font-semibold mb-2">Fotos (${v.photos.length})</div>
        <div class="grid grid-cols-4 gap-2">
          ${v.photos.map(p=>`<div class="photo-tile" style="aspect-ratio:1/1"><img src="${p.thumb}"/></div>`).join('') || '<div class="text-sm text-gray-500">Sem fotos</div>'}
        </div>
      </div>

      <div class="card">
        <div class="font-semibold mb-2">Conclusão</div>
        <div class="text-sm text-gray-600 whitespace-pre-wrap">${v.conclusion.summary||'—'}</div>
        ${v.conclusion.needsReturn ? '<div class="mt-2 text-sm text-red-600">Necessita retorno · prazo '+(v.conclusion.deadline||'não definido')+'</div>':''}
      </div>
    </section>

    <footer class="bottombar safe-bottom px-5 py-3 flex gap-3">
      <button id="editBtn" class="btn btn-ghost">Editar</button>
      <button id="finishBtn" class="btn btn-success">${Icon.check} Finalizar</button>
    </footer>
  </main>`);

  view.querySelector('#back').addEventListener('click', () => { state.route='visit'; renderRoute(); });
  view.querySelector('#editBtn').addEventListener('click', () => { state.route='visit'; renderRoute(); });
  view.querySelector('#finishBtn').addEventListener('click', finalizeVisit);
  return view;
}

async function finalizeVisit() {
  const v = state.visit;
  v.status = 'finalized';
  v.finishedAt = Date.now();
  v.checkout = v.checkout || {};
  v.checkout.datetime = Date.now();
  if (navigator.geolocation) {
    try {
      await new Promise((res) => navigator.geolocation.getCurrentPosition(
        (p) => { v.checkout.geo = { lat:p.coords.latitude, lng:p.coords.longitude, acc:p.coords.accuracy }; res(); },
        () => res(), { timeout: 3000, maximumAge: 60000 }
      ));
    } catch(e){}
  }
  v.score = computeScore(v);
  await saveDraft();
  await uploadPhotosToFirebase(v).catch(e => console.warn('photo upload skipped:', e?.message));
  // Queue sync
  await DB.queue.setItem(v.id, { id: v.id, type:'visit.finalize', ts: Date.now() });
  attemptSync();

  // Generate PDF
  const pdfBlob = await generatePDF(v);
  const url = URL.createObjectURL(pdfBlob);
  await showDoneScreen(url, pdfBlob);
}

async function showDoneScreen(pdfUrl, pdfBlob) {
  const v = state.visit;
  const view = h(`<main class="min-h-screen safe-top px-5 pt-10 pb-10 flex flex-col">
    <div class="flex-1 flex flex-col items-center justify-center text-center">
      <div class="w-16 h-16 rounded-full bg-green-50 text-success flex items-center justify-center mb-6">
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      </div>
      <h1 class="step-title">Visita finalizada</h1>
      <p class="step-sub mt-2 max-w-xs">Seu relatório foi salvo e o PDF está pronto para ser compartilhado.</p>
      <div class="mt-8 card w-full max-w-sm text-left">
        <div class="text-xs text-gray-500">Relatório</div>
        <div class="font-semibold">${v.condoName}</div>
        <div class="text-sm text-gray-500">${fmtDateTime(v.finishedAt)} · Score ${v.score}</div>
      </div>
    </div>
    <div class="space-y-3">
      <a id="downloadBtn" class="btn btn-primary" href="${pdfUrl}" download="relatorio-${v.condoName.replace(/\s+/g,'-')}-${v.id}.pdf">${Icon.pdf} Baixar PDF</a>
      <button id="autentiqueBtn" class="btn btn-ghost">✍️ Enviar para assinatura digital (Autentique)</button>
      <div id="autentiqueStatus" class="text-sm text-gray-500 text-center hidden"></div>
      <button id="shareBtn" class="btn btn-ghost">${Icon.share} Compartilhar</button>
      <button id="newBtn" class="btn btn-ghost">Voltar ao início</button>
    </div>
  </main>`);

  view.querySelector('#autentiqueBtn').addEventListener('click', async () => {
    const btn = view.querySelector('#autentiqueBtn');
    const statusEl = view.querySelector('#autentiqueStatus');
    const email = v.conclusion.responsibleEmail;
    if (!email || !/.+@.+\..+/.test(email)) {
      toast('Preencha o e-mail do responsável (Etapa 6) para enviar'); return;
    }
    btn.disabled = true; btn.textContent = 'Enviando...';
    statusEl.classList.remove('hidden'); statusEl.textContent = 'Enviando documento ao Autentique…';
    try {
      const pdfBase64 = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(pdfBlob); });
      const signers = [
        { name: v.technicianName, email: state.user?.email || 'tecnico@lavandery.com' },
        { name: v.conclusion.responsibleName || 'Responsável', email },
      ];
      const r = await fetch('/api/visits/' + v.id + '/autentique', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pdfBase64, name: `Relatório ${v.condoName} - ${fmtDate(v.finishedAt||Date.now())}`, signers }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.detail || data.error || 'falha');
      const respLink = data.document?.signatures?.find(s => s.email === email)?.link?.short_link;
      statusEl.innerHTML = `Enviado. <a class="underline" href="${respLink||'#'}" target="_blank">Abrir link do responsável</a>`;
      btn.textContent = '✅ Enviado ao Autentique';
      toast('Documento enviado para assinatura');
    } catch (e) {
      statusEl.textContent = 'Erro: ' + e.message;
      btn.disabled = false; btn.textContent = '✍️ Enviar para assinatura digital (Autentique)';
    }
  });

  view.querySelector('#shareBtn').addEventListener('click', async () => {
    const file = new File([pdfBlob], `relatorio-${v.id}.pdf`, { type:'application/pdf' });
    try {
      if (navigator.canShare && navigator.canShare({ files:[file] })) {
        await navigator.share({ title:'Relatório Lavandery', files:[file] });
      } else {
        await navigator.clipboard.writeText(pdfUrl);
        toast('Link copiado');
      }
    } catch(e){}
  });
  view.querySelector('#newBtn').addEventListener('click', () => { state.visit=null; state.step=0; state.route='list'; renderRoute(); });
  render(view);
}

// ---------- PDF (branded Lavandery report) ----------
async function generatePDF(v) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit:'pt', format:'a4' });
  const W = doc.internal.pageSize.getWidth(); // 595
  const H = doc.internal.pageSize.getHeight(); // 842
  const M = 40;

  // Brand palette (Lavandery)
  const BRAND = [83,60,157];      // #533C9D
  const BRAND2 = [101,74,186];    // #654ABA
  const BRAND_LIGHT = [240,237,249]; // #F0EDF9
  const BRAND_LIGHT2 = [224,219,241]; // #E0DBF1
  const INK = [28,25,45];
  const MUTED = [110,108,130];
  const OK = [22,163,74];
  const WARN = [234,160,23];
  const BAD = [220,38,38];

  const setFill = (c) => doc.setFillColor(c[0],c[1],c[2]);
  const setText = (c) => doc.setTextColor(c[0],c[1],c[2]);
  const setDraw = (c) => doc.setDrawColor(c[0],c[1],c[2]);

  const durationFmt = (ms) => {
    if (!ms || ms<0) return '—';
    const min = Math.round(ms/60000);
    const h = Math.floor(min/60); const m = min%60;
    return h ? `${h}h${m.toString().padStart(2,'0')}` : `${m} min`;
  };
  const timeFmt = (ts) => ts ? new Date(ts).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}) : '—';
  const dateFmt = (ts) => ts ? new Date(ts).toLocaleDateString('pt-BR',{day:'2-digit',month:'long',year:'numeric'}) : '—';

  // ===== Page footer (called on each page) =====
  const drawFooter = (pageNum, totalPages) => {
    setDraw([235,232,245]); doc.setLineWidth(0.6);
    doc.line(M, H-44, W-M, H-44);
    doc.setFont('helvetica','normal'); doc.setFontSize(8); setText(MUTED);
    doc.text(`Relatório ${v.id.slice(-6).toUpperCase()}`, M, H-28);
    doc.text(`Página ${pageNum}${totalPages?' de '+totalPages:''}`, W/2, H-28, { align:'center' });
    doc.text(fmtDateTime(v.finishedAt||Date.now()), W-M, H-28, { align:'right' });
  };

  // ===== COVER PAGE =====
  // Top bar
  setFill(BRAND); doc.rect(0, 0, W, 200, 'F');
  // Subtle decorative circle
  setFill(BRAND2); doc.circle(W-60, 60, 120, 'F');
  setFill([255,255,255,]); // logo chip
  doc.roundedRect(M, 40, 44, 44, 10, 10, 'F');
  doc.setFont('helvetica','bold'); doc.setFontSize(24); setText(BRAND);
  doc.text('L', M+22, 72, { align:'center' });

  doc.setFont('helvetica','bold'); doc.setFontSize(11); setText([255,255,255]);
  doc.text('LAVANDERY', M+56, 58);
  doc.setFont('helvetica','normal'); doc.setFontSize(9); setText([224,219,241]);
  doc.text('Lavanderia compartilhada inteligente', M+56, 72);

  doc.setFont('helvetica','bold'); doc.setFontSize(26); setText([255,255,255]);
  doc.text('Relatório de Inspeção', M, 130);
  doc.setFont('helvetica','normal'); doc.setFontSize(12); setText([224,219,241]);
  doc.text('Visita técnica em lavanderia de condomínio', M, 150);

  // Status pill
  const pillX = M, pillY = 172;
  setFill([255,255,255]); doc.roundedRect(pillX, pillY, 110, 22, 11, 11, 'F');
  doc.setFont('helvetica','bold'); doc.setFontSize(9); setText(BRAND);
  doc.text(`VISITA ${v.visitType?.toUpperCase()||'—'}`, pillX+55, pillY+14, { align:'center' });

  // ===== Identification card =====
  let y = 230;
  setFill([252,251,255]); setDraw(BRAND_LIGHT2); doc.setLineWidth(0.8);
  doc.roundedRect(M, y, W-M*2, 110, 10, 10, 'FD');

  doc.setFont('helvetica','bold'); doc.setFontSize(14); setText(INK);
  doc.text(v.condoName, M+18, y+28);
  doc.setFont('helvetica','normal'); doc.setFontSize(10); setText(MUTED);
  doc.text(`Emitido em ${fmtDateTime(v.finishedAt||Date.now())}`, M+18, y+44);

  // 2-col info
  const col1 = M+18, col2 = W/2 + 10;
  doc.setFontSize(9); setText(MUTED);
  doc.text('TÉCNICO RESPONSÁVEL', col1, y+66);
  doc.text('STATUS GERAL', col2, y+66);
  doc.setFont('helvetica','bold'); doc.setFontSize(11); setText(INK);
  doc.text(v.technicianName, col1, y+82);
  const status = v.general?.overall || '—';
  const statusColor = /crítica/i.test(status) ? BAD : /regular/i.test(status) ? WARN : status!=='—' ? OK : MUTED;
  setFill(statusColor); doc.circle(col2+4, y+78, 3.5, 'F');
  setText(INK); doc.text(status, col2+14, y+82);

  doc.setFont('helvetica','normal'); doc.setFontSize(9); setText(MUTED);
  doc.text('ID DO RELATÓRIO', col1, y+98);
  doc.text('SCORE', col2, y+98);

  // ===== Score donut =====
  y = 360;
  setFill([252,251,255]); setDraw(BRAND_LIGHT2);
  doc.roundedRect(M, y, W-M*2, 130, 10, 10, 'FD');
  const score = v.score ?? 0;
  const scoreColor = score>=80?OK : score>=60?WARN : BAD;
  // circle frame
  const cx = M+80, cy = y+65;
  setDraw([240,237,249]); doc.setLineWidth(10);
  doc.circle(cx, cy, 36, 'S');
  // arc approximation (draw segments)
  const pct = Math.max(0, Math.min(1, score/100));
  setDraw(scoreColor); doc.setLineWidth(10);
  const steps = Math.round(pct*60);
  for (let i=0;i<steps;i++){
    const a0 = -Math.PI/2 + (i/60)*Math.PI*2;
    const a1 = -Math.PI/2 + ((i+1)/60)*Math.PI*2;
    doc.line(cx+36*Math.cos(a0), cy+36*Math.sin(a0), cx+36*Math.cos(a1), cy+36*Math.sin(a1));
  }
  doc.setFont('helvetica','bold'); doc.setFontSize(22); setText(scoreColor);
  doc.text(String(score), cx, cy+7, { align:'center' });

  doc.setFont('helvetica','bold'); doc.setFontSize(14); setText(INK);
  doc.text('Score da lavanderia', cx+70, y+45);
  doc.setFont('helvetica','normal'); doc.setFontSize(10); setText(MUTED);
  const scoreLabel = score>=80?'Excelente — funcionamento pleno' : score>=60?'Atenção — requer acompanhamento' : 'Crítico — ação imediata recomendada';
  doc.text(scoreLabel, cx+70, y+62);
  // small metrics
  const failing = (v.machines||[]).filter(m=>m.status==='fail').length;
  const warning = (v.machines||[]).filter(m=>m.status==='warn').length;
  const ok = (v.machines||[]).filter(m=>m.status==='ok').length;
  const metrics = [['Operando',ok,OK],['Alerta',warning,WARN],['Inoperante',failing,BAD]];
  metrics.forEach(([lb, val, c], i) => {
    const x = cx+70 + i*100;
    setFill(c); doc.circle(x+4, y+86, 3, 'F');
    doc.setFont('helvetica','bold'); doc.setFontSize(11); setText(INK);
    doc.text(String(val), x+12, y+90);
    doc.setFont('helvetica','normal'); doc.setFontSize(8); setText(MUTED);
    doc.text(lb, x+12, y+102);
  });

  // ===== Timeline card =====
  y = 510;
  setFill([252,251,255]); setDraw(BRAND_LIGHT2);
  doc.roundedRect(M, y, W-M*2, 150, 10, 10, 'FD');
  doc.setFont('helvetica','bold'); doc.setFontSize(12); setText(INK);
  doc.text('Linha do tempo da visita', M+18, y+24);
  doc.setFont('helvetica','normal'); doc.setFontSize(9); setText(MUTED);
  doc.text(dateFmt(v.checkin?.datetime), W-M-18, y+24, { align:'right' });

  // Timeline rail
  const railY = y+72;
  setDraw(BRAND_LIGHT2); doc.setLineWidth(2);
  doc.line(M+40, railY, W-M-40, railY);

  const waited = (v.scheduledAt && v.checkin?.datetime) ? v.checkin.datetime - v.scheduledAt : null;
  const duration = (v.checkin?.datetime && v.checkout?.datetime) ? v.checkout.datetime - v.checkin.datetime : null;

  const nodes = [
    { x: M+60,  color: MUTED,  label: 'Agendada',  val: v.scheduledAt ? timeFmt(v.scheduledAt) : '—', sub: v.scheduledAt ? dateFmt(v.scheduledAt).split(' de ').slice(0,2).join(' ') : '' },
    { x: W/2-30, color: BRAND,  label: 'Chegada',   val: timeFmt(v.checkin?.datetime), sub: waited!=null ? (waited>=0?`+${durationFmt(waited)}`:`${durationFmt(-waited)} adiant.`) : '' },
    { x: W/2+80, color: BRAND2, label: 'Conclusão', val: timeFmt(v.checkout?.datetime), sub: '' },
    { x: W-M-60, color: OK,     label: 'Duração',   val: durationFmt(duration), sub: v.conclusion?.needsReturn?'Requer retorno':'' },
  ];
  nodes.forEach(n => {
    setFill([255,255,255]); setDraw(n.color); doc.setLineWidth(3);
    doc.circle(n.x, railY, 7, 'FD');
    setFill(n.color); doc.circle(n.x, railY, 3, 'F');
    doc.setFont('helvetica','normal'); doc.setFontSize(8); setText(MUTED);
    doc.text(n.label.toUpperCase(), n.x, railY-16, { align:'center' });
    doc.setFont('helvetica','bold'); doc.setFontSize(11); setText(INK);
    doc.text(n.val, n.x, railY+22, { align:'center' });
    if (n.sub) { doc.setFont('helvetica','normal'); doc.setFontSize(8); setText(MUTED); doc.text(n.sub, n.x, railY+34, { align:'center' }); }
  });

  drawFooter(1);

  // ===== Page 2: Infrastructure + Machines + Supplies =====
  doc.addPage();
  y = M + 10;
  const section = (title, sub) => {
    doc.setFont('helvetica','bold'); doc.setFontSize(13); setText(INK);
    doc.text(title, M, y);
    if (sub) { doc.setFont('helvetica','normal'); doc.setFontSize(9); setText(MUTED); doc.text(sub, W-M, y, { align:'right' }); }
    y += 6;
    setDraw(BRAND); doc.setLineWidth(1.2); doc.line(M, y, M+28, y);
    setDraw([240,237,249]); doc.setLineWidth(0.6); doc.line(M+30, y, W-M, y);
    y += 16; doc.setFont('helvetica','normal'); doc.setFontSize(10); setText(INK);
  };
  const statusPill = (x, yy, label, kind) => {
    const w = 62, h = 16;
    const bg = kind==='ok'?[236,253,243]:kind==='warn'?[255,247,233]:kind==='fail'?[254,242,242]:[240,237,249];
    const fg = kind==='ok'?OK:kind==='warn'?WARN:kind==='fail'?BAD:BRAND;
    setFill(bg); doc.roundedRect(x, yy-11, w, h, 8, 8, 'F');
    doc.setFont('helvetica','bold'); doc.setFontSize(8); setText(fg);
    doc.text(label, x+w/2, yy, { align:'center' });
  };
  const kindOf = (s) => s==='ok'?'ok':s==='warn'?'warn':s==='fail'||s==='out'?'fail':s==='low'?'warn':'';
  const labelOf = (s) => ({ok:'OK',warn:'ATENÇÃO',fail:'PROBLEMA',low:'BAIXO',out:'ACABOU'})[s]||'—';

  section('Infraestrutura', v.infrastructure?.notes ? 'Com observações' : '');
  const infraItems = [['energy','Energia'],['internet','Internet'],['lighting','Iluminação'],['exhaust','Exaustão'],['drainage','Drenagem'],['cleaning','Limpeza']];
  const colW = (W - M*2) / 2;
  infraItems.forEach((it,i)=>{
    const cx2 = M + (i%2)*colW;
    const ry = y + Math.floor(i/2)*28;
    doc.setFont('helvetica','normal'); doc.setFontSize(10); setText(INK);
    doc.text(it[1], cx2+6, ry+12);
    const s = v.infrastructure?.[it[0]] || '';
    statusPill(cx2+colW-76, ry+10, labelOf(s), kindOf(s));
  });
  y += Math.ceil(infraItems.length/2)*28 + 4;
  if (v.infrastructure?.notes) {
    doc.setFont('helvetica','italic'); doc.setFontSize(9); setText(MUTED);
    const lines = doc.splitTextToSize('“'+v.infrastructure.notes+'”', W-M*2);
    doc.text(lines, M, y); y += lines.length*11 + 6;
  }
  y += 10;

  section('Máquinas', `${(v.machines||[]).length} cadastradas`);
  (v.machines||[]).forEach(m => {
    if (y > H-120) { drawFooter(doc.internal.getNumberOfPages()); doc.addPage(); y = M + 10; }
    setFill([252,251,255]); setDraw(BRAND_LIGHT2);
    doc.roundedRect(M, y, W-M*2, 48, 8, 8, 'FD');
    doc.setFont('helvetica','bold'); doc.setFontSize(11); setText(INK);
    doc.text(m.code, M+14, y+20);
    doc.setFont('helvetica','normal'); doc.setFontSize(9); setText(MUTED);
    doc.text(m.type, M+14, y+34);
    statusPill(W-M-80, y+20, labelOf(m.status), kindOf(m.status));
    if (m.problem) {
      doc.setFont('helvetica','bold'); doc.setFontSize(9); setText(INK);
      doc.text(m.problem, M+120, y+20);
    }
    if (m.notes) {
      doc.setFont('helvetica','normal'); doc.setFontSize(9); setText(MUTED);
      const nl = doc.splitTextToSize(m.notes, W-M*2-210);
      doc.text(nl[0]||'', M+120, y+34);
    }
    y += 54;
  });

  y += 10;
  if (y > H-160) { drawFooter(doc.internal.getNumberOfPages()); doc.addPage(); y = M + 10; }
  section('Insumos', v.supplies?.replenishNeeded ? 'Reposição solicitada' : '');
  [['soap','Sabão'],['softener','Amaciante'],['doser','Dosadora']].forEach(([k,label],i) => {
    const x = M + i*((W-M*2)/3);
    const w = (W-M*2)/3 - 8;
    setFill([252,251,255]); setDraw(BRAND_LIGHT2);
    doc.roundedRect(x, y, w, 60, 8, 8, 'FD');
    doc.setFont('helvetica','normal'); doc.setFontSize(9); setText(MUTED);
    doc.text(label.toUpperCase(), x+12, y+18);
    doc.setFont('helvetica','bold'); doc.setFontSize(12); setText(INK);
    doc.text(labelOf(v.supplies?.[k]), x+12, y+38);
    setFill(kindOf(v.supplies?.[k])==='ok'?OK:kindOf(v.supplies?.[k])==='warn'?WARN:kindOf(v.supplies?.[k])==='fail'?BAD:MUTED);
    doc.circle(x+w-14, y+30, 5, 'F');
  });
  y += 72;

  drawFooter(doc.internal.getNumberOfPages());

  // ===== Page 3: Conclusion + Signatures =====
  doc.addPage();
  y = M + 10;
  section('Conclusão técnica', `Prazo: ${v.conclusion?.deadline ? new Date(v.conclusion.deadline).toLocaleDateString('pt-BR') : 'não definido'}`);

  const block = (title, val) => {
    doc.setFont('helvetica','bold'); doc.setFontSize(10); setText(MUTED);
    doc.text(title.toUpperCase(), M, y); y += 14;
    doc.setFont('helvetica','normal'); doc.setFontSize(11); setText(INK);
    const lines = doc.splitTextToSize(val||'—', W-M*2);
    doc.text(lines, M, y); y += lines.length*14 + 12;
  };
  block('Resumo', v.conclusion?.summary);
  block('Pendências', v.conclusion?.pending);
  block('Ação recomendada', v.conclusion?.action);

  // Retorno banner
  if (v.conclusion?.needsReturn) {
    setFill([254,242,242]); setDraw([254,202,202]);
    doc.roundedRect(M, y, W-M*2, 36, 8, 8, 'FD');
    doc.setFont('helvetica','bold'); doc.setFontSize(10); setText(BAD);
    doc.text('RETORNO NECESSÁRIO', M+14, y+15);
    doc.setFont('helvetica','normal'); doc.setFontSize(10); setText(INK);
    doc.text(`Prazo: ${v.conclusion.deadline ? new Date(v.conclusion.deadline).toLocaleDateString('pt-BR') : 'a definir'}`, M+14, y+28);
    y += 48;
  }

  // Signatures
  y = Math.max(y, 560);
  setDraw([240,237,249]); doc.line(M, y, W-M, y); y += 16;
  doc.setFont('helvetica','bold'); doc.setFontSize(11); setText(INK);
  doc.text('Assinaturas', M, y); y += 14;

  const sigW = (W-M*2-20)/2, sigH = 80;
  setDraw(BRAND_LIGHT2);
  doc.roundedRect(M, y, sigW, sigH+34, 8, 8, 'S');
  doc.roundedRect(M+sigW+20, y, sigW, sigH+34, 8, 8, 'S');
  if (v.conclusion?.techSignature) try { doc.addImage(v.conclusion.techSignature, 'PNG', M+10, y+8, sigW-20, sigH-10); } catch(e){}
  if (v.conclusion?.responsibleSignature) try { doc.addImage(v.conclusion.responsibleSignature, 'PNG', M+sigW+30, y+8, sigW-20, sigH-10); } catch(e){}
  setDraw([230,228,240]); doc.line(M+10, y+sigH, M+sigW-10, y+sigH);
  doc.line(M+sigW+30, y+sigH, M+sigW*2+10, y+sigH);
  doc.setFont('helvetica','bold'); doc.setFontSize(10); setText(INK);
  doc.text(v.technicianName, M+10, y+sigH+14);
  doc.text(v.conclusion?.responsibleName || 'Responsável', M+sigW+30, y+sigH+14);
  doc.setFont('helvetica','normal'); doc.setFontSize(8); setText(MUTED);
  doc.text('Técnico Lavandery', M+10, y+sigH+26);
  doc.text('Responsável pelo condomínio', M+sigW+30, y+sigH+26);

  drawFooter(doc.internal.getNumberOfPages());

  // ===== Photos pages =====
  const fullPhotos = [];
  for (const p of v.photos) {
    const rec = await DB.photos.getItem(p.id);
    if (rec?.full) fullPhotos.push({ ...p, full: rec.full });
  }
  if (fullPhotos.length) {
    doc.addPage();
    y = M + 10;
    section('Registro fotográfico', `${fullPhotos.length} ${fullPhotos.length===1?'foto':'fotos'}`);
    const cellW = (W - M*2 - 14) / 2; const cellH = cellW * 0.72;
    let col = 0;
    for (const p of fullPhotos) {
      if (y + cellH + 30 > H-60) { drawFooter(doc.internal.getNumberOfPages()); doc.addPage(); y = M+10; col = 0; }
      const x = M + col*(cellW+14);
      try { doc.addImage(p.full, 'JPEG', x, y, cellW, cellH); } catch(e){}
      setFill([83,60,157]); doc.roundedRect(x+8, y+8, 60, 16, 6, 6, 'F');
      doc.setFont('helvetica','bold'); doc.setFontSize(8); setText([255,255,255]);
      doc.text((p.tag||'').toUpperCase(), x+38, y+18, { align:'center' });
      doc.setFont('helvetica','normal'); doc.setFontSize(8); setText(MUTED);
      doc.text(fmtDateTime(p.ts), x, y + cellH + 12);
      col++;
      if (col === 2) { col = 0; y += cellH + 26; }
    }
    if (col===1) y += cellH + 26;
    drawFooter(doc.internal.getNumberOfPages());
  }

  // Fill page numbers (re-draw footer with total count would need re-render; leave as is)
  return doc.output('blob');
}

// ---------- Sync ----------
async function attemptSync() {
  if (!navigator.onLine) return;
  // Try to POST each queued item to /api/visits
  await DB.queue.iterate(async (item) => {
    try {
      const v = await DB.visits.getItem(item.id);
      await fetch('/api/visits', {
        method: 'POST', headers: { 'Content-Type':'application/json' },
        body: JSON.stringify(v)
      });
      await DB.queue.removeItem(item.id);
    } catch(e) { /* will retry */ }
  });
}
window.addEventListener('online', attemptSync);

// ---------- Route of the day ----------
function RouteView() {
  const today = new Date().toISOString().slice(0,10);
  const view = h(`<main class="min-h-screen flex flex-col">
    <header class="topbar safe-top px-5 py-3 flex items-center justify-between">
      <button id="back" class="text-gray-600 w-10 h-10 -ml-2 flex items-center justify-center rounded-full active:bg-gray-100">${Icon.back}</button>
      <div class="font-semibold">Rota do dia</div>
      <input type="date" id="rd" value="${today}" class="input" style="min-height:36px;padding:6px 10px;width:140px"/>
    </header>
    <section class="px-5 pt-3 pb-2">
      <div id="stats" class="text-sm text-gray-500">Carregando...</div>
    </section>
    <div id="map" style="height:300px;margin:0 20px;border-radius:14px;overflow:hidden;border:1px solid #F1F2F4"></div>
    <section class="px-5 py-4 flex-1 space-y-2" id="stops"></section>
  </main>`);

  view.querySelector('#back').addEventListener('click', () => { state.route='list'; renderRoute(); });

  async function load() {
    const date = view.querySelector('#rd').value;
    view.querySelector('#stats').textContent = 'Carregando...';
    try {
      const r = await fetch(`/api/route?date=${date}&technician=${state.user.id}`);
      const data = await r.json();
      const stops = data.stops || [];
      view.querySelector('#stats').textContent = stops.length
        ? `${stops.length} paradas · ${data.totalKm} km no total`
        : 'Nenhuma visita agendada para este dia.';
      renderMap(data);
      renderStops(stops);
    } catch(e) {
      view.querySelector('#stats').textContent = 'Erro carregando rota.';
    }
  }

  function renderStops(stops) {
    const host = view.querySelector('#stops');
    if (!stops.length) { host.innerHTML = ''; return; }
    host.innerHTML = stops.map((s, i) => {
      const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}&travelmode=driving`;
      return `<div class="card">
        <div class="flex items-start gap-3">
          <div style="background:#533C9D;color:#fff;width:28px;height:28px;border-radius:50%;display:grid;place-items:center;font-weight:700;font-size:13px;flex-shrink:0">${i+1}</div>
          <div class="flex-1">
            <div class="font-semibold">${s.condo_name}</div>
            <div class="text-xs text-gray-500 mt-0.5">${s.address||''}</div>
            <div class="text-xs text-gray-500">${s.scheduled_time||''} · ${s.distanceFromPrev.toFixed(1)} km desde a parada anterior</div>
          </div>
        </div>
        <div class="flex gap-2 mt-3">
          <a href="${mapsUrl}" target="_blank" class="chip" aria-pressed="true">📍 Abrir no Maps</a>
          <button class="chip startVisit" data-condo="${s.condo_id}">Iniciar visita</button>
        </div>
      </div>`;
    }).join('');
    host.querySelectorAll('.startVisit').forEach(b => b.addEventListener('click', () => {
      startVisit(b.dataset.condo, 'Preventiva', null, null, null);
    }));
  }

  let mapRef;
  function renderMap(data) {
    if (!window.L) { return; }
    const el = view.querySelector('#map');
    if (!mapRef) {
      mapRef = L.map(el).setView([data.start.lat, data.start.lng], 11);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution:'© OpenStreetMap' }).addTo(mapRef);
    }
    mapRef.eachLayer(l => { if (l instanceof L.Marker || l instanceof L.Polyline) mapRef.removeLayer(l); });
    if (!data.stops?.length) return;
    L.marker([data.start.lat, data.start.lng]).addTo(mapRef).bindPopup('Início');
    const coords = [[data.start.lat, data.start.lng]];
    data.stops.forEach((s, i) => {
      coords.push([s.lat, s.lng]);
      L.marker([s.lat, s.lng], {
        icon: L.divIcon({ className:'', html: `<div style="background:#533C9D;color:#fff;width:26px;height:26px;border-radius:50%;display:grid;place-items:center;font-weight:700;font-size:12px;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.3)">${i+1}</div>`, iconSize:[26,26], iconAnchor:[13,13] })
      }).addTo(mapRef).bindPopup(`<b>${s.condo_name}</b>`);
    });
    const line = L.polyline(coords, { color:'#533C9D', weight:3, opacity:.7 }).addTo(mapRef);
    mapRef.fitBounds(line.getBounds().pad(.15));
    // Fix size when map is inside hidden parent
    setTimeout(()=>mapRef.invalidateSize(), 100);
  }

  view.querySelector('#rd').addEventListener('change', load);
  // Ensure leaflet CSS/JS loaded
  if (!document.querySelector('link[href*="leaflet.css"]')) {
    const cssTag = document.createElement('link'); cssTag.rel='stylesheet'; cssTag.href='https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'; document.head.appendChild(cssTag);
  }
  if (!window.L) {
    const s = document.createElement('script'); s.src='https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'; s.onload = load; document.head.appendChild(s);
  } else {
    setTimeout(load, 50);
  }

  return view;
}

// ---------- History (placeholder) ----------
function HistoryView() { return h('<main class="p-5">History</main>'); }
