import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sendDocumentForSignature, getDocument, listDocuments, listAllDocuments, downloadFile } from './autentique.js';
import { extractFromPdf } from './contracts.js';
import { geocodeAddress, distanceKm, orderByNearest } from './geocode.js';
import { sendEmail, waLink, statusLabel, buildTicketMessage } from './notify.js';
import { waStatus, waConnect, waDisconnect, waSendText, waAutoStart } from './whatsapp.js';
import { gmapsTest, gmapsGeocode, gmapsRoute, s3Test, s3PresignUpload, s3PutObject, asaasTest, asaasCreateCustomer, asaasCreateCharge, asaasListCharges, sentryInit, sentryCapture, sentryTest } from './integrations-services.js';
import { firebaseTest, firebaseUpload } from './firebase.js';
import { driveTest, driveUpload } from './gdrive.js';
import { moskitTest, moskitListCompanies, moskitUpsertCompany, moskitCreateDeal, moskitCreateActivity, moskitListPipelines, moskitListDeals, moskitListContacts, moskitListActivities, moskitListUsers, moskitStats } from './moskit.js';
import { generateDeliveryReceipt, generateSurveyChecklist, generateInstallationReport, generateEquipmentDeliveryTerm } from './pdf-templates.js';
import { setupAuth, authMiddleware, requireAuth, authRoutes, publicMiddleware, PUBLIC_PATHS } from './auth.js';
import { fetchCalendars } from './calendar.js';
import multer from 'multer';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// Lavandery HQ — starting point for route optimization
const HQ = { lat: -23.4416, lng: -46.9185 }; // Santana de Parnaíba / SP

// Minimal .env loader (avoids extra dep)
(() => {
  const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
})();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.LAVANDERY_DB || path.join(__dirname, 'lavandery.db');
const SCHEMA = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(SCHEMA);

// Seed if empty
const countTechs = db.prepare('SELECT COUNT(*) c FROM technicians').get().c;
if (countTechs === 0) {
  const t = db.prepare('INSERT INTO technicians (id,name,email,pin) VALUES (?,?,?,?)');
  t.run('t1','Rafael Costa','rafael@lavandery.com','1234');
  t.run('t2','Marina Alves','marina@lavandery.com','1234');
  t.run('t3','Lucas Pereira','lucas@lavandery.com','1234');

  const c = db.prepare('INSERT INTO condominiums (id,name,address,city) VALUES (?,?,?,?)');
  c.run('c1','Edifício Atlântico','Av. Beira Mar, 1200','Fortaleza/CE');
  c.run('c2','Residencial Solar','Rua das Flores, 45','Fortaleza/CE');
  c.run('c3','Condomínio Jardins','Av. Washington Soares, 909','Fortaleza/CE');

  const m = db.prepare('INSERT INTO machines (id,condo_id,code,type,brand,capacity) VALUES (?,?,?,?,?,?)');
  m.run('m1','c1','LVD-001','Lavadora','LG','15kg');
  m.run('m2','c1','LVD-002','Lavadora','Electrolux','15kg');
  m.run('m3','c1','SCR-001','Secadora','Samsung','12kg');
  m.run('m4','c2','LVD-010','Lavadora','LG','15kg');
  m.run('m5','c2','SCR-010','Secadora','LG','12kg');
  m.run('m6','c3','LVD-020','Lavadora','Electrolux','18kg');
  m.run('m7','c3','LVD-021','Lavadora','Electrolux','18kg');
  m.run('m8','c3','SCR-020','Secadora','Samsung','14kg');
  m.run('m9','c3','SCR-021','Secadora','Samsung','14kg');
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));

// Setup auth (tables + seed admin) + middleware
setupAuth(db);
app.use(authMiddleware(db));
app.use(publicMiddleware());
authRoutes(app, db);

// Guard de rotas de página: admin.html exige auth
app.get(/^\/admin(?:\.html)?$/, (req, res, next) => {
  if (!req.user) return res.redirect('/login.html?next=' + encodeURIComponent(req.originalUrl));
  next();
});

// Guard global para todas as /api/* não-públicas
app.use('/api', (req, res, next) => {
  const full = req.baseUrl + req.path;  // ex: /api/condominiums
  if (PUBLIC_PATHS.some(rx => rx.test(full))) return next();
  if (!req.user) return res.status(401).json({ error: 'unauthorized', hint: 'login required' });
  next();
});

app.use(express.static(path.join(__dirname, '..')));

// Uploads persistentes (disco /data no Render) — também serve como /uploads/*
const UPLOADS_DIR = process.env.UPLOADS_DIR || (process.env.NODE_ENV === 'production' ? '/data/uploads' : path.join(__dirname, '..', 'uploads'));
try { fs.mkdirSync(UPLOADS_DIR, { recursive: true }); } catch {}
app.use('/uploads', express.static(UPLOADS_DIR));

// ----- Auth (simple) -----
app.post('/api/auth/login', (req,res) => {
  const { email, pin } = req.body||{};
  const t = db.prepare('SELECT id,name,email FROM technicians WHERE email=? AND pin=?').get((email||'').toLowerCase(), pin||'');
  if (!t) return res.status(401).json({ error:'invalid_credentials' });
  res.json({ user: t });
});

// ----- Reference data -----
app.get('/api/technicians', (_,res) => res.json(db.prepare('SELECT id,name,email FROM technicians').all()));
app.post('/api/technicians', (req,res) => {
  const { id, name, email, pin } = req.body || {};
  if (!name) return res.status(400).json({ error: 'missing_name' });
  const tid = id || ('t_' + Math.random().toString(36).slice(2,8));
  db.prepare('INSERT INTO technicians (id,name,email,pin) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,email=excluded.email,pin=COALESCE(excluded.pin,technicians.pin)')
    .run(tid, name, (email||'').toLowerCase(), pin||'0000');
  res.json({ ok: true, id: tid });
});
app.delete('/api/technicians/:id', (req,res) => {
  db.prepare('UPDATE visits_schedule SET technician_id=NULL WHERE technician_id=?').run(req.params.id);
  db.prepare('DELETE FROM technicians WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});
app.get('/api/condominiums', (_,res) => {
  const condos = db.prepare('SELECT * FROM condominiums').all();
  const machines = db.prepare('SELECT * FROM machines').all();
  // Busca nome oficial do CONTRATANTE do contrato (se veio do Autentique)
  const cache = db.prepare('SELECT document_id, extracted FROM contract_cache').all();
  const contractNames = {};
  for (const r of cache) {
    try {
      const ex = JSON.parse(r.extracted || 'null');
      if (ex?.name) contractNames[r.document_id] = ex.name;
    } catch {}
  }
  res.json(condos.map(c => ({
    ...c,
    contract_name: c.autentique_doc_id ? (contractNames[c.autentique_doc_id] || null) : null,
    machines: machines.filter(m => m.condo_id === c.id),
  })));
});

// Padroniza todos os nomes em MAIÚSCULAS + limpa prefixos + corrige numerais romanos
app.post('/api/condominiums/uppercase-all', (req, res) => {
  if (!req.user || !['admin','gestor'].includes(req.user.role)) return res.status(403).json({ error:'forbidden' });
  const rows = db.prepare('SELECT id, name FROM condominiums').all();
  const stmt = db.prepare('UPDATE condominiums SET name=? WHERE id=?');
  let updated = 0;
  for (const r of rows) {
    let n = String(r.name || '').trim();
    // Remove prefixos inúteis
    n = n.replace(/^contrato[-\s_]+(comodato|gest[ãa]o|servi[çc]o)[-\s_]+/i, '')
         .replace(/^contrato[-\s_]+/i, '')
         .replace(/\s*\(\d+\)\s*$/g, '')
         .replace(/\s*atualizado\s*$/i, '')
         .replace(/\s*ver\.\s*\d+\s*$/i, '')
         .replace(/\s*-\s*rev\.[^-]*$/i, '')
         .replace(/\s+/g, ' ').trim();
    // UTF-8 safe uppercase
    let up = n.toLocaleUpperCase('pt-BR');
    // Corrige numerais romanos comumente bagunçados: "Ii" → "II", "Iii" → "III"
    up = up.replace(/\bII\b/g, 'II').replace(/\bIII\b/g, 'III')
           .replace(/\b(\w+)\s+II\s+/gi, (_, w) => `${w.toLocaleUpperCase('pt-BR')} II `)
           .replace(/\bIi\b/gi, 'II')
           .replace(/\bIii\b/gi, 'III');
    if (up !== r.name) { stmt.run(up, r.id); updated++; }
  }
  res.json({ ok: true, updated });
});

// Merge condos duplicados criados pelo import (c_impl_*) com os originais existentes
app.post('/api/condominiums/merge-duplicates', (req, res) => {
  if (!req.user || !['admin','gestor'].includes(req.user.role)) return res.status(403).json({ error:'forbidden' });
  const { dry_run } = req.body || {};

  const all = db.prepare('SELECT * FROM condominiums').all();
  const imported = all.filter(c => String(c.id||'').startsWith('c_impl_'));
  const others = all.filter(c => !String(c.id||'').startsWith('c_impl_'));

  // Matcher mais agressivo: token overlap (palavras em comum)
  const tokenize = s => String(s||'').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/\b(condominio|condomínio|edificio|edifício|residencial|clube|cond|ed|res)\b/gi,' ')
    .replace(/[^a-z0-9]+/g,' ')
    .trim().split(/\s+/).filter(t => t.length >= 3);

  function bestMatch(name) {
    const aTokens = new Set(tokenize(name));
    if (!aTokens.size) return null;
    let best = null, bestScore = 0;
    for (const c of others) {
      const bTokens = new Set(tokenize(c.name));
      if (!bTokens.size) continue;
      // Jaccard / min
      let hits = 0;
      for (const t of aTokens) if (bTokens.has(t)) hits++;
      const score = hits / Math.min(aTokens.size, bTokens.size);
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return bestScore >= 0.6 ? { condo: best, score: bestScore } : null;
  }

  const copy = db.prepare(`UPDATE condominiums SET
    bank_name = COALESCE(bank_name, ?),
    bank_agency = COALESCE(bank_agency, ?),
    bank_account = COALESCE(bank_account, ?),
    contract_sign_date = COALESCE(contract_sign_date, ?),
    implantation_date = COALESCE(implantation_date, ?),
    installation_owner = COALESCE(installation_owner, ?),
    seller_name = COALESCE(seller_name, ?)
    WHERE id = ?`);
  const del = db.prepare('DELETE FROM condominiums WHERE id = ?');

  const results = [];
  let merged = 0, kept = 0;
  for (const imp of imported) {
    const m = bestMatch(imp.name);
    if (m) {
      results.push({ from: imp.name, to: m.condo.name, score: +m.score.toFixed(2), action: 'merge' });
      if (!dry_run) {
        copy.run(imp.bank_name, imp.bank_agency, imp.bank_account, imp.contract_sign_date, imp.implantation_date, imp.installation_owner, imp.seller_name, m.condo.id);
        del.run(imp.id);
      }
      merged++;
    } else {
      results.push({ from: imp.name, action: 'keep' });
      kept++;
    }
  }
  res.json({ ok:true, imported: imported.length, merged, kept, dry_run: !!dry_run, results });
});

// Importa dados de implantação (banco/obra/vendedor) e match fuzzy por nome
app.post('/api/condominiums/bulk-import-implanted', (req, res) => {
  if (!req.user || !['admin','gestor'].includes(req.user.role)) return res.status(403).json({ error:'forbidden' });
  const { rows, auto_create } = req.body || {};
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'no_rows' });

  const condos = db.prepare('SELECT id, name FROM condominiums').all();
  const norm = s => String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'');
  function matchCondo(name) {
    const q = norm(name); if (!q) return null;
    let best = null, bs = 0;
    for (const c of condos) {
      const n = norm(c.name); if (!n) continue;
      if (q.includes(n) || n.includes(q)) {
        const s = Math.min(q.length, n.length) / Math.max(q.length, n.length);
        if (s > bs) { bs = s; best = c; }
      }
    }
    return bs > 0.35 ? best : null;
  }

  // Normaliza data: aceita MM/DD/YY ou DD/MM/YYYY ou "ASSINADO" → deixa como string
  function normDate(s) {
    if (!s) return null;
    const str = String(s).trim();
    if (!str || str === '—' || str === '-') return null;
    // Datas formato MM/DD/YY
    const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (m) {
      // Excel geralmente exporta MM/DD/YY
      const [_, a, b, y] = m;
      const year = y.length === 2 ? ('20' + y) : y;
      // Heurística: se primeiro > 12, provavelmente DD/MM; senão MM/DD
      const month = parseInt(a) > 12 ? b.padStart(2,'0') : a.padStart(2,'0');
      const day = parseInt(a) > 12 ? a.padStart(2,'0') : b.padStart(2,'0');
      return `${year}-${month}-${day}`;
    }
    // Strings como "ASSINADO", "EM ANDAMENTO", "PARADA" ficam como estão
    return str;
  }
  function cleanBank(s) {
    if (!s) return null;
    const str = String(s).trim();
    if (!str || /n[ãa]o\s+(encontrado|cadastrado)/i.test(str) || str === '—' || str === '-') return null;
    return str;
  }

  const insertCondo = db.prepare(`INSERT INTO condominiums (id, name, is_contract, bank_name, bank_agency, bank_account, contract_sign_date, implantation_date, installation_owner, seller_name) VALUES (?,?,1,?,?,?,?,?,?,?)`);
  const updateCondo = db.prepare(`UPDATE condominiums SET
    bank_name = COALESCE(?, bank_name),
    bank_agency = COALESCE(?, bank_agency),
    bank_account = COALESCE(?, bank_account),
    contract_sign_date = COALESCE(?, contract_sign_date),
    implantation_date = COALESCE(?, implantation_date),
    installation_owner = COALESCE(?, installation_owner),
    seller_name = COALESCE(?, seller_name)
    WHERE id = ?`);

  const results = [];
  for (const row of rows) {
    const name = row.condominio || row.condo || row.nome;
    if (!name) { results.push({ name:'(vazio)', ok:false, reason:'no_name' }); continue; }
    const data = {
      bank_name: cleanBank(row.banco),
      bank_agency: cleanBank(row.agencia || row['agência']),
      bank_account: cleanBank(row.conta),
      contract_sign_date: normDate(row['data de assinatura'] || row.data_assinatura),
      implantation_date: normDate(row['data de implantação'] || row.data_implantacao),
      installation_owner: row.obra ? String(row.obra).toUpperCase().trim() : null,
      seller_name: row.vendedor ? String(row.vendedor).toUpperCase().trim() : null,
    };
    const matched = matchCondo(name);
    if (matched) {
      updateCondo.run(data.bank_name, data.bank_agency, data.bank_account, data.contract_sign_date, data.implantation_date, data.installation_owner, data.seller_name, matched.id);
      results.push({ name, ok:true, matched: matched.name, action: 'updated' });
    } else if (auto_create) {
      const id = 'c_impl_' + norm(name).slice(0,20);
      try {
        insertCondo.run(id, name.toUpperCase().trim(), data.bank_name, data.bank_agency, data.bank_account, data.contract_sign_date, data.implantation_date, data.installation_owner, data.seller_name);
        condos.push({ id, name });
        results.push({ name, ok:true, action: 'created', id });
      } catch (e) {
        results.push({ name, ok:false, reason: 'insert_failed', error: String(e.message||e) });
      }
    } else {
      results.push({ name, ok:false, reason: 'no_match' });
    }
  }
  const ok = results.filter(r => r.ok).length;
  const fail = results.filter(r => !r.ok).length;
  const created = results.filter(r => r.action==='created').length;
  const updated = results.filter(r => r.action==='updated').length;
  res.json({ ok:true, total: rows.length, processed: ok, failed: fail, updated, created, results });
});

// Remove registros que não são condomínios (lixo do Autentique)
app.post('/api/condominiums/cleanup-non-condos', (req, res) => {
  if (!req.user || !['admin','gestor'].includes(req.user.role)) return res.status(403).json({ error:'forbidden' });
  // Marca como condo válido: nome contém CONDOMÍNIO, EDIFÍCIO, RESIDENCIAL, CONJUNTO, HABITAT
  // Remove: "Ferias Coletivas", "Registrobr", "Contrato Gestão", "Contrato Lavandery" (contratos duplicados sem condo claro), etc.
  const all = db.prepare('SELECT id, name FROM condominiums').all();
  const isCondo = n => {
    const s = String(n||'').toUpperCase();
    const hasCondoWord = /CONDOM[ÍI]NIO|EDIF[ÍI]CIO|RESIDENCIAL|EDILICIO|CONJUNTO|HABITAT|BRERA|VIBRA|VIVAZ|VIVABENX|METROCASA|THERA|SAMPA|TERRA[ÇC]O|ATLANT|SKY|URBAN|FOR\s+LIFE|RAIZES|RAI[ZS]ES|NYC|NOW|BENX|VIEW|PORTO|PIAZZA|STATION|STUDIO|MAX\s|MOOV|ARIZONA|TURIASSU|UPPER|ALL\s+LIBER|BORGES|CUPE[CÇ]|VILL[AE]|PARK|HOUSE|HOUX|HELLO|FLOR|JARDIM|JARDINS|SALE|HOME|GAMELINHA|MUNDO\s+APTO|VN\s+|SIDE|CYRELA|DNA|AMBIENCE|COMPOSITE|INNOVA|MISTRAL|NEX\s+ONE|MOEMA|ALPHAVIEW|BOM\s+FIM|DONA\s+LINDU|GRAVURA|APLAUSO|EXALT|IBIRAPUERA|CAMINHO|STAR|VIVART|VINTAGE|FAMILIA|FAM[IÍ]LIA|DOT|UPTOWN|DOMUS|TANGAR[ÁA]|ASSUMIR[ÁA]|PAULICEIA|GOLDEN|MASTINS|INDUSTRIAL|JARDINS|ESPLANADA|PALACETE|CAMBUCY|CAMBUCI|PORTINARI|ALEGRO|LOOK|CURSINO|PERDIZES|CUNHA|ZOOM|CIDADE|OLIMPIA|GUILHERMINA|VIVA|LUMIS|WELCONX|MARRQCOS|TUCUNA|DA\s+S[ÉE]|ANDORINHAS|JURITIS|SIX\s+SANTA|MERCHTE|SUBCONDOMINIO|CLUBE|STUDIOS|KONECT|SPAZIO|METRO\s+CASA|SAINT|TSS|DECIDA|MAX\s+CARNEIROS|COMODATO/i.test(s);
    const isJunk = /FERIAS\s+COLETIVAS|REGISTRO\s*BR|REGISTROBR|TESTE\s+DE|CANCELAMENTO|APENAS\s+TESTE|PROPOSTA|SEM\s+CONTRATO|CONTRATO\s+CANCELADO|MINUTA|^-$|^\s*$/i.test(s);
    return hasCondoWord && !isJunk;
  };
  const toRemove = all.filter(c => !isCondo(c.name));
  const del = db.prepare('DELETE FROM condominiums WHERE id=?');
  for (const c of toRemove) del.run(c.id);
  res.json({ ok:true, removed: toRemove.length, kept: all.length - toRemove.length, removedNames: toRemove.map(c=>c.name) });
});

// Condomínios CRUD
app.post('/api/condominiums', (req,res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'name_required' });
  const id = b.id || 'c_' + Math.random().toString(36).slice(2,10);
  db.prepare(`INSERT INTO condominiums (id,name,address,city,cep,cnpj,washers,dryers,contract_source,
    maintenance_interval_months,maintenance_label,cycles_per_week,
    soap_ml_per_cycle,softener_ml_per_cycle,gallon_ml,
    soap_gallons_on_site,softener_gallons_on_site,contact_email,is_contract)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, b.name, b.address||'', b.city||'', b.cep||null, b.cnpj||null,
    b.washers|0, b.dryers|0, b.contract_source||'manual',
    b.maintenance_interval_months||6, b.maintenance_label||null,
    b.cycles_per_week||null, b.soap_ml_per_cycle||50, b.softener_ml_per_cycle||50, b.gallon_ml||5000,
    b.soap_gallons_on_site||0, b.softener_gallons_on_site||0, b.contact_email||null,
    b.is_contract===false?0:1
  );
  res.json({ ok:true, id });
});

app.get('/api/condominiums/:id', (req,res) => {
  const c = db.prepare('SELECT * FROM condominiums WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error:'not_found' });
  c.machines = db.prepare('SELECT * FROM machines WHERE condo_id=? ORDER BY code').all(c.id);
  c.deliveries = db.prepare('SELECT * FROM deliveries WHERE condo_id=? ORDER BY delivered_at DESC LIMIT 30').all(c.id);
  c.tickets = db.prepare('SELECT * FROM tickets WHERE condo_id=? ORDER BY created_at DESC LIMIT 30').all(c.id);
  c.schedule = db.prepare('SELECT * FROM visits_schedule WHERE condo_id=? ORDER BY date LIMIT 30').all(c.id);
  c.forecast = forecastCondo(c);
  res.json(c);
});


app.patch('/api/condominiums/:id', (req,res) => {
  const b = req.body || {};
  const fields = ['name','address','city','cep','cnpj','washers','dryers',
    'maintenance_interval_months','maintenance_label','cycles_per_week',
    'soap_ml_per_cycle','softener_ml_per_cycle','gallon_ml',
    'soap_gallons_on_site','softener_gallons_on_site','contact_email',
    'cycle_rate','cycle_price','tax_rate',
    'bank_name','bank_agency','bank_account','contract_sign_date',
    'implantation_date','installation_owner','seller_name'];
  const sets = [], args = [];
  fields.forEach(f => { if (b[f] !== undefined) { sets.push(`${f}=?`); args.push(b[f]); } });
  if (!sets.length) return res.json({ ok:true, changed:0 });
  args.push(req.params.id);
  db.prepare(`UPDATE condominiums SET ${sets.join(', ')} WHERE id=?`).run(...args);
  res.json({ ok:true });
});

// Machines CRUD (nested under condo)
app.post('/api/condominiums/:condoId/machines', (req,res) => {
  const b = req.body||{}; const id = b.id || 'm_'+Math.random().toString(36).slice(2,10);
  db.prepare(`INSERT INTO machines (id,condo_id,code,type,brand,capacity) VALUES (?,?,?,?,?,?)`)
    .run(id, req.params.condoId, b.code||'', b.type||'Lavadora', b.brand||'', b.capacity||'');
  res.json({ ok:true, id });
});
app.patch('/api/machines/:id', (req,res) => {
  const b = req.body||{};
  db.prepare(`UPDATE machines SET code=COALESCE(?,code), type=COALESCE(?,type), brand=COALESCE(?,brand), capacity=COALESCE(?,capacity) WHERE id=?`)
    .run(b.code, b.type, b.brand, b.capacity, req.params.id);
  res.json({ ok:true });
});
app.delete('/api/machines/:id', (req,res) => {
  db.prepare('DELETE FROM machines WHERE id=?').run(req.params.id);
  res.json({ ok:true });
});

// Geocode single condo (triggerable per row)
app.post('/api/condominiums/:id/geocode', async (req, res) => {
  const c = db.prepare('SELECT * FROM condominiums WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error:'not_found' });
  try {
    const g = await geocodeAddress({ address: c.address, city: c.city, cep: c.cep });
    if (g) {
      db.prepare('UPDATE condominiums SET lat=?, lng=?, geocoded_at=? WHERE id=?').run(g.lat, g.lng, Date.now(), c.id);
      res.json({ ok:true, ...g });
    } else res.status(404).json({ error:'not_found' });
  } catch(e) { res.status(500).json({ error:'geocode_failed', detail: String(e.message||e) }); }
});

// Manual schedule add / update
app.post('/api/schedule', (req,res) => {
  const b = req.body||{};
  if (!b.condo_id || !b.date || !b.technician_id) return res.status(400).json({ error:'missing_fields' });
  const id = b.id || 'sch_'+Math.random().toString(36).slice(2,11);
  db.prepare(`INSERT INTO visits_schedule (id,condo_id,technician_id,date,scheduled_time,type,status)
              VALUES (?,?,?,?,?,?,?)`).run(id, b.condo_id, b.technician_id, b.date, b.scheduled_time||'09:00', b.type||'Preventiva', b.status||'scheduled');
  res.json({ ok:true, id });
});
app.patch('/api/schedule/:id', (req,res) => {
  const b = req.body||{};
  db.prepare(`UPDATE visits_schedule SET
    date=COALESCE(?,date), scheduled_time=COALESCE(?,scheduled_time),
    technician_id=COALESCE(?,technician_id), type=COALESCE(?,type), status=COALESCE(?,status)
    WHERE id=?`).run(b.date, b.scheduled_time, b.technician_id, b.type, b.status, req.params.id);
  res.json({ ok:true });
});

app.delete('/api/condominiums/:id', (req,res) => {
  db.prepare('DELETE FROM machines WHERE condo_id=?').run(req.params.id);
  db.prepare('DELETE FROM condominiums WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ----- Schedule generator -----
db.exec(`CREATE TABLE IF NOT EXISTS visits_schedule (
  id TEXT PRIMARY KEY,
  condo_id TEXT REFERENCES condominiums(id) ON DELETE CASCADE,
  technician_id TEXT REFERENCES technicians(id),
  date TEXT NOT NULL,
  scheduled_time TEXT,
  type TEXT,
  status TEXT DEFAULT 'scheduled',
  created_at INTEGER DEFAULT (strftime('%s','now')*1000)
);`);

app.get('/api/schedule', (req,res) => {
  const { technician, from, to } = req.query;
  const where = [], args = [];
  if (technician) { where.push('technician_id=?'); args.push(technician); }
  if (from) { where.push('date>=?'); args.push(from); }
  if (to) { where.push('date<=?'); args.push(to); }
  const sql = `SELECT s.*, c.name as condo_name FROM visits_schedule s
               LEFT JOIN condominiums c ON c.id=s.condo_id` +
              (where.length?' WHERE '+where.join(' AND '):'') +
              ' ORDER BY date, scheduled_time LIMIT 500';
  res.json(db.prepare(sql).all(...args));
});

app.post('/api/schedule/generate', (req,res) => {
  const { startDate, days = 30, type = 'Preventiva', onlyWithoutVisits = false } = req.body || {};
  const start = startDate ? new Date(startDate) : new Date();
  const techs = db.prepare('SELECT id FROM technicians').all();
  if (!techs.length) return res.status(400).json({ error: 'no_technicians' });
  let condos = db.prepare('SELECT id FROM condominiums').all();
  if (onlyWithoutVisits) {
    const have = new Set(db.prepare('SELECT DISTINCT condo_id FROM visits_schedule').all().map(r=>r.condo_id));
    condos = condos.filter(c => !have.has(c.id));
  }
  // Distribute condos across `days` business days (Mon-Fri), 5 slots/day (09, 10:30, 13, 14:30, 16)
  const slots = ['09:00','10:30','13:00','14:30','16:00'];
  const dates = [];
  const d = new Date(start);
  while (dates.length < days) {
    const day = d.getDay();
    if (day !== 0 && day !== 6) dates.push(new Date(d));
    d.setDate(d.getDate()+1);
  }
  const ins = db.prepare(`INSERT INTO visits_schedule (id,condo_id,technician_id,date,scheduled_time,type) VALUES (?,?,?,?,?,?)`);
  const tx = db.transaction(() => {
    condos.forEach((c, i) => {
      const dayIdx = Math.floor(i / slots.length) % dates.length;
      const slotIdx = i % slots.length;
      const dateStr = dates[dayIdx].toISOString().slice(0,10);
      const time = slots[slotIdx];
      const tech = techs[i % techs.length].id;
      ins.run('sch_'+Math.random().toString(36).slice(2,10), c.id, tech, dateStr, time, type);
    });
  });
  tx();
  res.json({ ok: true, generated: condos.length });
});

// Generate a full-year schedule based on each condo's maintenance frequency,
// distributed between provided technicians (default: all).
// Body: { year?: 2026, defaultIntervalMonths?: 3, technicianIds?: [...], clear?: true }
app.post('/api/schedule/generate-annual', (req,res) => {
  const year = parseInt(req.body?.year, 10) || (new Date()).getFullYear();
  const defaultInterval = parseInt(req.body?.defaultIntervalMonths, 10) || 3; // trimestral if unknown
  const clear = req.body?.clear !== false;
  const techIds = Array.isArray(req.body?.technicianIds) && req.body.technicianIds.length
    ? req.body.technicianIds
    : db.prepare('SELECT id FROM technicians ORDER BY name').all().map(r=>r.id);
  if (!techIds.length) return res.status(400).json({ error: 'no_technicians' });

  const condos = db.prepare('SELECT id, name, maintenance_interval_months FROM condominiums').all();
  if (!condos.length) return res.status(400).json({ error: 'no_condos' });

  // Visit slots per business day — 4 slots (09:00 / 10:30 / 13:00 / 14:30)
  const SLOTS = ['09:00','10:30','13:00','14:30'];
  // Starting base date per condo — spread across the first month so visits don't pile up
  const firstBusinessDay = (y, m) => { const d = new Date(y, m-1, 1); while([0,6].includes(d.getDay())) d.setDate(d.getDate()+1); return d; };
  const addBusinessDays = (d, n) => { const r = new Date(d); let added = 0; while (added < n) { r.setDate(r.getDate()+1); if (![0,6].includes(r.getDay())) added++; } return r; };
  const ymd = (d) => d.toISOString().slice(0,10);

  const ins = db.prepare(`INSERT INTO visits_schedule (id,condo_id,technician_id,date,scheduled_time,type) VALUES (?,?,?,?,?,?)`);

  // Occupancy map to distribute slots: key = `${date}|${tech}` -> count (max 4)
  const occupancy = new Map();

  const tx = db.transaction(() => {
    if (clear) db.prepare(`DELETE FROM visits_schedule WHERE date LIKE ?`).run(`${year}-%`);

    condos.forEach((c, idx) => {
      const interval = c.maintenance_interval_months || defaultInterval;
      const count = Math.max(1, Math.round(12 / interval));
      // Assign tech round-robin (by condo order) so each condo stays with the same tech all year
      const tech = techIds[idx % techIds.length];
      // First visit: spread condos across first `interval` months, business days
      const monthOffset = idx % interval;
      const dayOffset = Math.floor(idx / interval) % 22; // ~business days in a month
      const baseDate = addBusinessDays(firstBusinessDay(year, 1 + monthOffset), dayOffset);

      for (let i = 0; i < count; i++) {
        // Target date: baseDate + i*interval months, keep to a business day
        const target = new Date(baseDate);
        target.setMonth(target.getMonth() + i * interval);
        // Push to next business day if weekend
        while ([0,6].includes(target.getDay())) target.setDate(target.getDate()+1);

        // Find a slot on this day, then nearby, so this tech doesn't exceed 4 visits/day
        let assigned = false;
        for (let push = 0; push < 10 && !assigned; push++) {
          const dateStr = ymd(target);
          const key = `${dateStr}|${tech}`;
          const used = occupancy.get(key) || 0;
          if (used < SLOTS.length) {
            occupancy.set(key, used + 1);
            ins.run('sch_'+Math.random().toString(36).slice(2,11), c.id, tech, dateStr, SLOTS[used], 'Preventiva');
            assigned = true;
          } else {
            // try next business day
            do { target.setDate(target.getDate()+1); } while ([0,6].includes(target.getDay()));
          }
        }
      }
    });
  });
  tx();

  const generated = db.prepare(`SELECT COUNT(*) c FROM visits_schedule WHERE date LIKE ?`).get(`${year}-%`).c;
  res.json({ ok: true, year, generated, technicians: techIds.length });
});

// ----- Supplies forecast -----
// Formula: gallons_left * gallon_ml / ml_per_cycle = cycles_left
//          cycles_left / (cycles_per_week/7) = days_left
// cycles_per_week default = max(washers,1) * 15  (estimate)
function forecastCondo(c, leadTimeDays = 5) {
  const cyclesPerWeek = c.cycles_per_week || Math.max((c.washers||1), 1) * 15;
  const cyclesPerDay = cyclesPerWeek / 7;
  const out = { cycles_per_week: cyclesPerWeek, cycles_per_day: Math.round(cyclesPerDay*10)/10 };

  for (const prod of ['soap','softener']) {
    const perCycle = prod === 'soap' ? (c.soap_ml_per_cycle||50) : (c.softener_ml_per_cycle||50);
    const gallons = prod === 'soap' ? (c.soap_gallons_on_site||0) : (c.softener_gallons_on_site||0);
    const gallonMl = c.gallon_ml || 5000;
    const cyclesLeft = (gallons * gallonMl) / perCycle;
    const daysLeft = cyclesPerDay > 0 ? Math.round(cyclesLeft / cyclesPerDay) : Infinity;
    const mlPerCycle = perCycle;
    const mlPerWeek = perCycle * cyclesPerWeek;
    const gallonsPerMonth = (mlPerWeek * 4.33) / gallonMl;
    let urgency = 'ok';
    if (daysLeft <= leadTimeDays) urgency = 'urgente';
    else if (daysLeft <= leadTimeDays + 7) urgency = 'atencao';
    else if (daysLeft <= 30) urgency = 'planejar';
    out[prod] = {
      gallons_on_site: gallons,
      ml_per_cycle: mlPerCycle,
      ml_per_week: Math.round(mlPerWeek),
      gallons_per_month: Math.round(gallonsPerMonth*100)/100,
      cycles_left: Math.round(cyclesLeft),
      days_left: daysLeft,
      depletion_date: isFinite(daysLeft) ? new Date(Date.now() + daysLeft*864e5).toISOString().slice(0,10) : null,
      delivery_date: isFinite(daysLeft) ? new Date(Date.now() + Math.max(0,(daysLeft-leadTimeDays))*864e5).toISOString().slice(0,10) : null,
      urgency,
    };
  }
  return out;
}

app.get('/api/supplies/forecast', (req, res) => {
  const urgencyFilter = req.query.urgency;
  const condos = db.prepare('SELECT * FROM condominiums WHERE is_contract=1').all();
  const rows = condos.map(c => {
    const f = forecastCondo(c);
    return { condo_id: c.id, condo_name: c.name, city: c.city, ...f };
  });
  const combined = rows.map(r => ({
    ...r,
    worst_days_left: Math.min(r.soap.days_left, r.softener.days_left),
    worst_urgency: (r.soap.urgency === 'urgente' || r.softener.urgency === 'urgente') ? 'urgente'
                 : (r.soap.urgency === 'atencao' || r.softener.urgency === 'atencao') ? 'atencao'
                 : (r.soap.urgency === 'planejar' || r.softener.urgency === 'planejar') ? 'planejar' : 'ok',
  }));
  const filtered = urgencyFilter ? combined.filter(r => r.worst_urgency === urgencyFilter) : combined;
  filtered.sort((a,b) => a.worst_days_left - b.worst_days_left);
  res.json({ leadTimeDays: 5, data: filtered });
});

// Register a delivery (updates gallons_on_site)
app.post('/api/deliveries', (req,res) => {
  const { condo_id, product, gallons, note } = req.body || {};
  if (!condo_id || !['soap','softener'].includes(product) || !(gallons>0)) return res.status(400).json({ error:'invalid' });
  const id = 'dlv_'+Math.random().toString(36).slice(2,10);
  db.prepare(`INSERT INTO deliveries (id,condo_id,product,gallons,note) VALUES (?,?,?,?,?)`).run(id, condo_id, product, gallons, note||null);
  const col = product === 'soap' ? 'soap_gallons_on_site' : 'softener_gallons_on_site';
  db.prepare(`UPDATE condominiums SET ${col} = COALESCE(${col},0) + ?, last_delivery_at=? WHERE id=?`).run(gallons, Date.now(), condo_id);
  emitEvent('delivery.registered', { id, condo_id, product, gallons }).catch(()=>{});
  res.json({ ok:true, id });
});

app.get('/api/deliveries/:condoId', (req,res) => {
  const rows = db.prepare('SELECT * FROM deliveries WHERE condo_id=? ORDER BY delivered_at DESC LIMIT 100').all(req.params.condoId);
  res.json(rows);
});

// ---------- Implantações endpoints ----------
app.get('/api/implantations', (req, res) => {
  const { status, condo_id } = req.query;
  const where = [], args = [];
  if (status) { where.push('i.status=?'); args.push(status); }
  if (condo_id) { where.push('i.condo_id=?'); args.push(condo_id); }
  const sql = `SELECT i.*, c.name as condo_name, c.city as condo_city, t.name as technician_name,
      (SELECT COUNT(*) FROM implantation_steps WHERE implantation_id=i.id) total,
      (SELECT COUNT(*) FROM implantation_steps WHERE implantation_id=i.id AND completed=1) done
    FROM implantations i
    LEFT JOIN condominiums c ON c.id=i.condo_id
    LEFT JOIN technicians t ON t.id=i.technician_id`
    + (where.length?' WHERE '+where.join(' AND '):'')
    + ` ORDER BY CASE i.status WHEN 'em_andamento' THEN 1 WHEN 'agendada' THEN 2 WHEN 'concluida' THEN 3 ELSE 4 END, i.target_date`;
  res.json(db.prepare(sql).all(...args));
});

app.get('/api/implantations/:id', (req, res) => {
  const i = db.prepare(`SELECT i.*, c.name as condo_name, c.city as condo_city, c.address as condo_address, t.name as technician_name
    FROM implantations i
    LEFT JOIN condominiums c ON c.id=i.condo_id
    LEFT JOIN technicians t ON t.id=i.technician_id
    WHERE i.id=?`).get(req.params.id);
  if (!i) return res.status(404).json({ error: 'not_found' });
  i.steps = db.prepare('SELECT * FROM implantation_steps WHERE implantation_id=? ORDER BY step_number').all(i.id);
  // hidratar cada passo com seus sub-itens + status computado
  const today = new Date().toISOString().slice(0,10);
  i.steps.forEach(s => {
    s.items = db.prepare('SELECT * FROM implantation_checklist_items WHERE step_id=? ORDER BY position').all(s.id);
    const total = s.items.length, done = s.items.filter(x=>x.done).length;
    if (s.completed) s.status = 'concluida';
    else if (done > 0) s.status = 'em_andamento';
    else s.status = s.status || 'pendente';
  });
  // Files
  i.files = db.prepare('SELECT * FROM implantation_files WHERE implantation_id=? ORDER BY uploaded_at DESC LIMIT 100').all(i.id);
  // Logs
  i.logs = db.prepare('SELECT * FROM implantation_logs WHERE implantation_id=? ORDER BY at DESC LIMIT 100').all(i.id);
  // SLA — dias restantes
  if (i.target_date) {
    const dd = Math.round((new Date(i.target_date+'T00:00:00').getTime() - Date.now()) / 864e5);
    i.days_to_deadline = dd;
  }
  res.json(i);
});

// Checklist sub-items CRUD
app.post('/api/implantation-steps/:stepId/items', (req,res) => {
  const { title, position } = req.body||{};
  if (!title) return res.status(400).json({ error:'title_required' });
  const max = db.prepare('SELECT MAX(position) p FROM implantation_checklist_items WHERE step_id=?').get(req.params.stepId);
  const id = 'it_'+Math.random().toString(36).slice(2,10);
  db.prepare(`INSERT INTO implantation_checklist_items (id,step_id,position,title) VALUES (?,?,?,?)`)
    .run(id, req.params.stepId, position || (max?.p||0)+1, title);
  res.json({ ok:true, id });
});
app.patch('/api/implantation-checklist-items/:id', (req,res) => {
  const b = req.body||{};
  const fields = ['done','photo_url','note','title','position','completed_by'];
  const sets=[], args=[];
  fields.forEach(f => { if (b[f] !== undefined) { sets.push(`${f}=?`); args.push(b[f]); }});
  if (b.done === 1 || b.done === true) { sets.push('completed_at=?'); args.push(Date.now()); }
  if (b.done === 0 || b.done === false) { sets.push('completed_at=?'); args.push(null); }
  if (!sets.length) return res.json({ ok:true });
  args.push(req.params.id);
  db.prepare(`UPDATE implantation_checklist_items SET ${sets.join(', ')} WHERE id=?`).run(...args);
  // auto-complete step if all items done
  const item = db.prepare('SELECT step_id FROM implantation_checklist_items WHERE id=?').get(req.params.id);
  if (item) {
    const stats = db.prepare(`SELECT COUNT(*) total, SUM(done) done FROM implantation_checklist_items WHERE step_id=?`).get(item.step_id);
    if (stats.total > 0 && stats.total === stats.done) {
      db.prepare(`UPDATE implantation_steps SET completed=1, completed_at=?, status='concluida' WHERE id=?`).run(Date.now(), item.step_id);
      const step = db.prepare('SELECT implantation_id, title, step_number FROM implantation_steps WHERE id=?').get(item.step_id);
      if (step) notifyImplantation({ implantationId: step.implantation_id, action:'step.completed', data:{ title: step.title, step_number: step.step_number, auto: true } });
    } else if (stats.done > 0) {
      db.prepare(`UPDATE implantation_steps SET status='em_andamento', started_at=COALESCE(started_at,?) WHERE id=?`).run(Date.now(), item.step_id);
    }
    // Recalcula status geral da implantação
    const step = db.prepare('SELECT implantation_id FROM implantation_steps WHERE id=?').get(item.step_id);
    if (step) {
      const g = db.prepare(`SELECT COUNT(*) total, SUM(completed) done FROM implantation_steps WHERE implantation_id=?`).get(step.implantation_id);
      if (g.total > 0 && g.total === g.done) {
        const was = db.prepare('SELECT status FROM implantations WHERE id=?').get(step.implantation_id);
        db.prepare(`UPDATE implantations SET status='concluida', completed_at=? WHERE id=? AND status != 'concluida'`).run(Date.now(), step.implantation_id);
        if (was && was.status !== 'concluida') notifyImplantation({ implantationId: step.implantation_id, action:'implantation.completed', data:{} });
      } else if (g.done > 0) {
        db.prepare(`UPDATE implantations SET status='em_andamento', started_at=COALESCE(started_at,?) WHERE id=? AND status='agendada'`).run(Date.now(), step.implantation_id);
      }
    }
    // Notificação leve por item
    const it = db.prepare(`SELECT ci.*, s.title as step_title, s.implantation_id FROM implantation_checklist_items ci JOIN implantation_steps s ON s.id=ci.step_id WHERE ci.id=?`).get(req.params.id);
    if (it) notifyImplantation({ implantationId: it.implantation_id, action:'item.completed', data:{ item_title: it.title, step_title: it.step_title } });
  }
  res.json({ ok:true });
});
app.delete('/api/implantation-checklist-items/:id', (req,res) => {
  db.prepare('DELETE FROM implantation_checklist_items WHERE id=?').run(req.params.id);
  res.json({ ok:true });
});

// Marcar várias implantações como concluídas (bulk, pulando passo a passo)
app.post('/api/implantations/bulk-complete', (req, res) => {
  if (!req.user || !['admin','gestor','tecnico'].includes(req.user.role)) return res.status(403).json({ error:'forbidden' });
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error:'no_ids' });
  const now = Date.now();
  const updImp = db.prepare(`UPDATE implantations SET status='concluida', completed_at=COALESCE(completed_at,?) WHERE id=?`);
  const updSteps = db.prepare(`UPDATE implantation_steps SET completed=1, completed_at=COALESCE(completed_at,?), status='concluida' WHERE implantation_id=? AND completed=0`);
  const insLog = db.prepare(`INSERT INTO implantation_logs (id, implantation_id, actor, action, target_type, target_id, data, at) VALUES (?,?,?,?,?,?,?,?)`);
  let completed = 0;
  const errors = [];
  const tx = db.transaction(() => {
    for (const id of ids) {
      try {
        const r = updImp.run(now, id);
        if (r.changes > 0) {
          updSteps.run(now, id);
          completed++;
          try {
            insLog.run('log_'+Math.random().toString(36).slice(2,10), id, req.user.name||'admin', 'bulk_completed', 'implantation', id, JSON.stringify({ via:'bulk' }), now);
          } catch {}
        }
      } catch (e) { errors.push({ id, error: String(e.message||e) }); }
    }
  });
  try { tx(); } catch (e) { return res.status(500).json({ error:'tx_failed', detail: String(e.message||e) }); }
  res.json({ ok:true, completed, requested: ids.length, errors });
});

// Reset template v2 para uma implantação existente
app.post('/api/implantations/:id/reset-template', (req, res) => {
  const i = db.prepare('SELECT * FROM implantations WHERE id=?').get(req.params.id);
  if (!i) return res.status(404).json({ error:'not_found' });
  // Wipes steps + items mas MANTÉM a implantação e o log
  db.prepare('DELETE FROM implantation_steps WHERE implantation_id=?').run(i.id);
  const insStep = db.prepare(`INSERT INTO implantation_steps (id,implantation_id,step_number,title,description,stage,status) VALUES (?,?,?,?,?,?,?)`);
  const insItem = db.prepare(`INSERT INTO implantation_checklist_items (id,step_id,position,title) VALUES (?,?,?,?)`);
  IMPLANTATION_TEMPLATE_V2.forEach((s, idx) => {
    const stepId = 'st_'+Math.random().toString(36).slice(2,10);
    insStep.run(stepId, i.id, idx+1, s.title, s.description, s.stage||null, 'pendente');
    (s.items||[]).forEach((t, j) => insItem.run('it_'+Math.random().toString(36).slice(2,10), stepId, j+1, t));
  });
  notifyImplantation({ implantationId: i.id, action:'template.reset', data:{ template:'v2' } });
  res.json({ ok:true });
});

// Upload de mídia por implantação (ou por passo)
app.post('/api/implantations/:id/files', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error:'no_file' });
  const step_id = req.body?.step_id || null;
  // Tenta usar Google Drive ou Firebase se configurado
  let url = null, kind = req.file.mimetype?.startsWith('image') ? 'photo' : 'other';
  const filename = `impl-${req.params.id}-${Date.now()}-${Math.random().toString(36).slice(2,6)}.${(req.file.mimetype||'').includes('png')?'png':'jpg'}`;

  const gdrive = getIntegration('gdrive');
  const firebase = getIntegration('firebase');
  try {
    if (gdrive && (gdrive.folder_id || gdrive.service_account_json)) {
      const r = await driveUpload(gdrive, { name: filename, mimeType: req.file.mimetype, body: req.file.buffer });
      url = r.url;
    } else if (firebase) {
      const r = await firebaseUpload(firebase, { key: `implantations/${req.params.id}/${filename}`, body: req.file.buffer, contentType: req.file.mimetype });
      url = r.url;
    } else {
      return res.status(400).json({ error:'no_upload_backend', hint:'Configure Google Drive ou Firebase em Integrações' });
    }
  } catch(e) { return res.status(500).json({ error:'upload_failed', detail:String(e.message||e) }); }

  const id = 'fil_'+Math.random().toString(36).slice(2,10);
  db.prepare(`INSERT INTO implantation_files (id,implantation_id,step_id,url,kind,name) VALUES (?,?,?,?,?,?)`)
    .run(id, req.params.id, step_id, url, kind, req.file.originalname||filename);
  notifyImplantation({ implantationId: req.params.id, action:'file.uploaded', data:{ url, step_id } });
  res.json({ ok:true, id, url });
});

// ---------- Módulo: Entrega de Equipamentos ----------
const UNIT_VALUE_DEFAULT = 52000;

function edHydrate(row) {
  if (!row) return null;
  row.condition_new = !!row.condition_new;
  row.condition_no_damage = !!row.condition_no_damage;
  row.condition_tested = !!row.condition_tested;
  return row;
}
function edIsLocked(row) { return row && row.status === 'finalizada'; }
function edValidate(row) {
  const errors = [];
  if (!row.condo_id && !row.condo_name) errors.push('Condomínio obrigatório');
  if (!row.responsible_name) errors.push('Nome do responsável obrigatório');
  if (!row.responsible_cpf) errors.push('CPF obrigatório');
  else if (row.responsible_cpf.replace(/\D/g,'').length !== 11) errors.push('CPF inválido');
  if (!row.responsible_phone) errors.push('Telefone obrigatório');
  else if (row.responsible_phone.replace(/\D/g,'').length < 10) errors.push('Telefone inválido');
  if (!row.delivery_date) errors.push('Data obrigatória');
  if (!row.delivery_time) errors.push('Hora obrigatória');
  if (!row.delivery_location) errors.push('Local obrigatório');
  if (!row.conjuntos_qty || row.conjuntos_qty < 1) errors.push('Quantidade de conjuntos deve ser ≥ 1');
  if (!row.signature_data_url) errors.push('Assinatura obrigatória');
  return errors;
}

app.get('/api/equipment-deliveries', (req, res) => {
  const { status, condo_id, q, from, to } = req.query;
  const where = [], args = [];
  if (status) { where.push('status=?'); args.push(status); }
  if (condo_id) { where.push('condo_id=?'); args.push(condo_id); }
  if (from) { where.push('delivery_date>=?'); args.push(from); }
  if (to) { where.push('delivery_date<=?'); args.push(to); }
  if (q) { where.push('(condo_name LIKE ? OR responsible_name LIKE ?)'); args.push('%'+q+'%', '%'+q+'%'); }
  const sql = 'SELECT * FROM equipment_deliveries' + (where.length?' WHERE '+where.join(' AND '):'') + ' ORDER BY created_at DESC LIMIT 500';
  res.json(db.prepare(sql).all(...args).map(edHydrate));
});

app.get('/api/equipment-deliveries/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM equipment_deliveries WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error:'not_found' });
  res.json(edHydrate(row));
});

// Criar rascunho (em_andamento)
app.post('/api/equipment-deliveries', (req, res) => {
  const b = req.body || {};
  const id = 'ed_' + Math.random().toString(36).slice(2,10);
  let condo = null;
  if (b.condo_id) condo = db.prepare('SELECT id, name, cnpj, address FROM condominiums WHERE id=?').get(b.condo_id);
  const unit = b.unit_value || UNIT_VALUE_DEFAULT;
  const total = (b.conjuntos_qty || 0) * unit;
  const today = new Date();
  db.prepare(`INSERT INTO equipment_deliveries (
      id, condo_id, condo_name, condo_cnpj, condo_address,
      responsible_name, responsible_cpf, responsible_phone,
      delivery_date, delivery_time, delivery_location,
      conjuntos_qty, unit_value, total_value, equipment_brand,
      condition_new, condition_no_damage, condition_tested, notes,
      signature_data_url, status, created_by
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, b.condo_id||null,
    b.condo_name || condo?.name || null,
    b.condo_cnpj || condo?.cnpj || null,
    b.condo_address || condo?.address || null,
    b.responsible_name || null, b.responsible_cpf || null, b.responsible_phone || null,
    b.delivery_date || today.toISOString().slice(0,10),
    b.delivery_time || today.toTimeString().slice(0,5),
    b.delivery_location || null,
    b.conjuntos_qty || 0, unit, total, b.equipment_brand || 'Speed Queen',
    b.condition_new?1:0, b.condition_no_damage?1:0, b.condition_tested?1:0, b.notes||null,
    b.signature_data_url || null, 'em_andamento', b.created_by || 'admin'
  );
  res.json({ ok:true, id });
});

// Atualizar rascunho (somente se em_andamento)
app.patch('/api/equipment-deliveries/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM equipment_deliveries WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error:'not_found' });
  if (edIsLocked(row)) return res.status(403).json({ error:'finalized_locked' });
  const b = req.body || {};
  // Resync snapshot do condo se condo_id mudar
  if (b.condo_id && b.condo_id !== row.condo_id) {
    const condo = db.prepare('SELECT name, cnpj, address FROM condominiums WHERE id=?').get(b.condo_id);
    if (condo) { b.condo_name = condo.name; b.condo_cnpj = condo.cnpj; b.condo_address = condo.address; }
  }
  const unit = b.unit_value != null ? b.unit_value : row.unit_value;
  const qty = b.conjuntos_qty != null ? b.conjuntos_qty : row.conjuntos_qty;
  if (b.conjuntos_qty != null || b.unit_value != null) b.total_value = unit * qty;
  const allowed = ['condo_id','condo_name','condo_cnpj','condo_address','responsible_name','responsible_cpf','responsible_phone','delivery_date','delivery_time','delivery_location','conjuntos_qty','unit_value','total_value','equipment_brand','condition_new','condition_no_damage','condition_tested','notes','signature_data_url'];
  const sets=[], args=[];
  allowed.forEach(f => { if (b[f] !== undefined) {
    sets.push(`${f}=?`);
    if (['condition_new','condition_no_damage','condition_tested'].includes(f)) args.push(b[f]?1:0);
    else args.push(b[f]);
  }});
  if (!sets.length) return res.json({ ok:true });
  args.push(req.params.id);
  db.prepare(`UPDATE equipment_deliveries SET ${sets.join(', ')} WHERE id=?`).run(...args);
  res.json({ ok:true });
});

// Finalizar (valida, gera PDF, faz lock)
app.post('/api/equipment-deliveries/:id/finalize', async (req, res) => {
  const row = db.prepare('SELECT * FROM equipment_deliveries WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error:'not_found' });
  if (edIsLocked(row)) return res.status(403).json({ error:'already_finalized', pdf_url: row.pdf_url });
  const errors = edValidate(row);
  if (errors.length) return res.status(400).json({ error:'validation_failed', details: errors });

  db.prepare(`UPDATE equipment_deliveries SET status='finalizada', finalized_at=? WHERE id=?`).run(Date.now(), row.id);

  // Gera PDF + tenta subir em GDrive/Firebase
  let pdf_url = null;
  try {
    const updated = db.prepare('SELECT * FROM equipment_deliveries WHERE id=?').get(row.id);
    const pdfBuf = generateEquipmentDeliveryTerm(updated);
    const filename = `termo-entrega-${row.id.slice(-6)}.pdf`;
    const gdrive = getIntegration('gdrive');
    const firebase = getIntegration('firebase');
    if (gdrive && (gdrive.folder_id || gdrive.service_account_json)) {
      const r = await driveUpload(gdrive, { name: filename, mimeType: 'application/pdf', body: pdfBuf });
      pdf_url = r.url;
    } else if (firebase) {
      const r = await firebaseUpload(firebase, { key: `deliveries/${row.id}/${filename}`, body: pdfBuf, contentType: 'application/pdf' });
      pdf_url = r.url;
    }
  } catch (e) { console.error('[ed finalize pdf upload]', e); }
  if (pdf_url) db.prepare('UPDATE equipment_deliveries SET pdf_url=? WHERE id=?').run(pdf_url, row.id);

  emitEvent('equipment_delivery.finalized', { id: row.id, condo_id: row.condo_id, total: row.total_value }).catch(()=>{});
  res.json({ ok:true, pdf_url, inline_pdf: `/api/equipment-deliveries/${row.id}/pdf` });
});

// PDF (gerado sob demanda — sempre atualizado com o signature/data mais recentes)
app.get('/api/equipment-deliveries/:id/pdf', (req, res) => {
  const row = db.prepare('SELECT * FROM equipment_deliveries WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error:'not_found' });
  try {
    const buf = generateEquipmentDeliveryTerm(row);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="termo-entrega-${row.id.slice(-6)}.pdf"`);
    res.send(buf);
  } catch (e) { res.status(500).json({ error:'pdf_failed', detail:String(e.message||e) }); }
});

// Excluir rascunho (só se não finalizado)
app.delete('/api/equipment-deliveries/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM equipment_deliveries WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error:'not_found' });
  if (edIsLocked(row)) return res.status(403).json({ error:'finalized_locked' });
  db.prepare('DELETE FROM equipment_deliveries WHERE id=?').run(req.params.id);
  res.json({ ok:true });
});

// Stats pra dashboard do módulo
app.get('/api/equipment-deliveries/stats/summary', (_req, res) => {
  const year = new Date().getFullYear();
  const month = String(new Date().getMonth()+1).padStart(2,'0');
  const total = db.prepare("SELECT COUNT(*) c FROM equipment_deliveries WHERE status='finalizada'").get().c;
  const inProgress = db.prepare("SELECT COUNT(*) c FROM equipment_deliveries WHERE status='em_andamento'").get().c;
  const thisMonth = db.prepare("SELECT COUNT(*) c FROM equipment_deliveries WHERE status='finalizada' AND delivery_date LIKE ?").get(`${year}-${month}-%`).c;
  const totals = db.prepare("SELECT SUM(conjuntos_qty) qty, SUM(total_value) val FROM equipment_deliveries WHERE status='finalizada'").get();
  const perMonth = db.prepare(`SELECT strftime('%Y-%m', delivery_date) ym, COUNT(*) c, SUM(total_value) v, SUM(conjuntos_qty) qty
    FROM equipment_deliveries WHERE status='finalizada' AND delivery_date LIKE ? GROUP BY ym ORDER BY ym`).all(`${year}-%`);
  res.json({
    total, in_progress: inProgress, this_month: thisMonth,
    total_conjuntos: totals.qty||0, total_value: totals.val||0,
    per_month: perMonth,
  });
});

// PDFs automáticos por implantação
app.get('/api/implantations/:id/pdf/:kind', (req, res) => {
  const kind = req.params.kind;
  const impl = db.prepare(`SELECT i.*, c.name as condo_name FROM implantations i LEFT JOIN condominiums c ON c.id=i.condo_id WHERE i.id=?`).get(req.params.id);
  if (!impl) return res.status(404).json({ error:'not_found' });
  impl.steps = db.prepare('SELECT * FROM implantation_steps WHERE implantation_id=? ORDER BY step_number').all(impl.id);
  impl.steps.forEach(s => { s.items = db.prepare('SELECT * FROM implantation_checklist_items WHERE step_id=? ORDER BY position').all(s.id); });
  const condo = db.prepare('SELECT * FROM condominiums WHERE id=?').get(impl.condo_id) || {};
  const machines = db.prepare('SELECT * FROM machines WHERE condo_id=?').all(impl.condo_id);
  try {
    let buf;
    if (kind === 'delivery') buf = generateDeliveryReceipt(impl, condo, machines);
    else if (kind === 'survey') {
      const surveyStep = impl.steps.find(s => s.stage === 'site_survey') || impl.steps[2];
      buf = generateSurveyChecklist(impl, condo, surveyStep);
    }
    else if (kind === 'installation') buf = generateInstallationReport(impl, condo);
    else return res.status(400).json({ error:'invalid_kind', valid:['delivery','survey','installation'] });
    logImplantation(impl.id, { action:'pdf.generated', targetType:'implantation', targetId:impl.id, data:{ kind } });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="lavandery-${kind}-${impl.id.slice(-6)}.pdf"`);
    res.send(buf);
  } catch(e) { res.status(500).json({ error:'pdf_failed', detail: String(e.message||e) }); }
});

// KPIs específicos de implantações
app.get('/api/implantations/stats/summary', (_req, res) => {
  const all = db.prepare(`SELECT i.*,
      (SELECT COUNT(*) FROM implantation_steps WHERE implantation_id=i.id) total,
      (SELECT COUNT(*) FROM implantation_steps WHERE implantation_id=i.id AND completed=1) done
    FROM implantations i`).all();
  const today = new Date().toISOString().slice(0,10);
  const stats = {
    total: all.length,
    agendada: 0, em_andamento: 0, concluida: 0, cancelada: 0,
    atrasadas: 0,
    total_dias_concluidas: 0, count_dias_concluidas: 0,
    within_deadline: 0, out_of_deadline: 0,
  };
  const stageDelays = {}; // contagem por estágio de quão atrasado
  all.forEach(i => {
    stats[i.status] = (stats[i.status]||0) + 1;
    const atrasada = (i.status==='agendada'||i.status==='em_andamento') && i.target_date && i.target_date < today;
    if (atrasada) stats.atrasadas++;
    if (i.status === 'concluida' && i.contract_signed_at && i.completed_at) {
      const dias = Math.round((i.completed_at - i.contract_signed_at)/864e5);
      stats.total_dias_concluidas += dias;
      stats.count_dias_concluidas++;
      if (i.target_date && new Date(i.completed_at).toISOString().slice(0,10) <= i.target_date) stats.within_deadline++;
      else stats.out_of_deadline++;
    }
  });
  stats.avg_days = stats.count_dias_concluidas ? Math.round(stats.total_dias_concluidas/stats.count_dias_concluidas) : null;
  stats.pct_on_time = (stats.within_deadline+stats.out_of_deadline) ? Math.round(stats.within_deadline/(stats.within_deadline+stats.out_of_deadline)*100) : null;

  // Etapas que mais atrasam (média de dias de atraso por stage)
  const rows = db.prepare(`SELECT s.stage, s.title,
      AVG(CASE WHEN s.completed=1 AND s.started_at IS NOT NULL THEN (s.completed_at - s.started_at)/86400000.0 ELSE NULL END) avg_duration,
      COUNT(CASE WHEN s.completed=0 AND i.status IN ('agendada','em_andamento') AND i.target_date < ? THEN 1 END) pending_delayed
    FROM implantation_steps s JOIN implantations i ON i.id=s.implantation_id
    WHERE s.stage IS NOT NULL GROUP BY s.stage ORDER BY pending_delayed DESC, avg_duration DESC LIMIT 5`).all(today);
  stats.top_delays = rows;

  res.json(stats);
});

app.post('/api/implantations', (req, res) => {
  const { condo_id, target_date, technician_id, contract_signed_at } = req.body || {};
  if (!condo_id) return res.status(400).json({ error: 'condo_id_required' });
  const id = createImplantationForCondo(condo_id, { targetDate: target_date, technicianId: technician_id, contractSignedAt: contract_signed_at });
  res.json({ ok: true, id });
});

app.patch('/api/implantations/:id', (req, res) => {
  const b = req.body || {};
  const prev = db.prepare('SELECT * FROM implantations WHERE id=?').get(req.params.id);
  const fields = ['status','target_date','technician_id','notes','started_at','completed_at','type'];
  const sets = [], args = [];
  fields.forEach(f => { if (b[f] !== undefined) { sets.push(`${f}=?`); args.push(b[f]); } });
  if (b.status === 'em_andamento' && !b.started_at) { sets.push('started_at=?'); args.push(Date.now()); }
  if (b.status === 'concluida' && !b.completed_at) { sets.push('completed_at=?'); args.push(Date.now()); }
  if (!sets.length) return res.json({ ok: true });
  args.push(req.params.id);
  db.prepare(`UPDATE implantations SET ${sets.join(', ')} WHERE id=?`).run(...args);
  // notificações por mudança
  if (b.status && prev && prev.status !== b.status) {
    notifyImplantation({ implantationId: req.params.id, action:'status.changed', data:{ from: prev.status, to: b.status } });
    if (b.status === 'concluida') notifyImplantation({ implantationId: req.params.id, action:'implantation.completed', data:{} });
  }
  if (b.technician_id !== undefined && prev && prev.technician_id !== b.technician_id) {
    notifyImplantation({ implantationId: req.params.id, action:'technician.changed', data:{ from: prev.technician_id, to: b.technician_id } });
  }
  if (b.type !== undefined && prev && prev.type !== b.type) {
    notifyImplantation({ implantationId: req.params.id, action:'type.changed', data:{ from: prev.type, to: b.type } });
  }
  if (b.target_date !== undefined && prev && prev.target_date !== b.target_date) {
    notifyImplantation({ implantationId: req.params.id, action:'deadline.changed', data:{ from: prev.target_date, to: b.target_date } });
  }
  res.json({ ok: true });
});

app.delete('/api/implantations/:id', (req, res) => {
  db.prepare('DELETE FROM implantations WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.patch('/api/implantation-steps/:id', (req, res) => {
  const b = req.body || {};
  const prev = db.prepare('SELECT * FROM implantation_steps WHERE id=?').get(req.params.id);
  const fields = ['completed','completed_by','photo_url','notes','title','description','status','responsible_id','started_at'];
  const sets = [], args = [];
  fields.forEach(f => { if (b[f] !== undefined) { sets.push(`${f}=?`); args.push(b[f]); } });
  if (b.completed === 1 || b.completed === true) { sets.push('completed_at=?'); args.push(Date.now()); sets.push('status=?'); args.push('concluida'); }
  if (b.completed === 0 || b.completed === false) { sets.push('completed_at=?'); args.push(null); }
  if (!sets.length) return res.json({ ok: true });
  args.push(req.params.id);
  if (prev && b.completed !== undefined && !!b.completed !== !!prev.completed) {
    notifyImplantation({
      implantationId: prev.implantation_id,
      action: b.completed ? 'step.completed' : 'step.reopened',
      data: { title: prev.title, step_number: prev.step_number, step_id: prev.id },
    });
  }
  db.prepare(`UPDATE implantation_steps SET ${sets.join(', ')} WHERE id=?`).run(...args);
  // If all steps completed, mark implantation as concluida
  const step = db.prepare('SELECT implantation_id FROM implantation_steps WHERE id=?').get(req.params.id);
  if (step) {
    const stats = db.prepare(`SELECT COUNT(*) total, SUM(completed) done FROM implantation_steps WHERE implantation_id=?`).get(step.implantation_id);
    if (stats.total === stats.done && stats.total > 0) {
      db.prepare(`UPDATE implantations SET status='concluida', completed_at=? WHERE id=? AND status != 'concluida'`).run(Date.now(), step.implantation_id);
    } else if (stats.done > 0) {
      db.prepare(`UPDATE implantations SET status='em_andamento', started_at=COALESCE(started_at,?) WHERE id=? AND status='agendada'`).run(Date.now(), step.implantation_id);
    }
  }
  res.json({ ok: true });
});

app.post('/api/implantations/:id/steps', (req, res) => {
  const { title, description } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title_required' });
  const max = db.prepare('SELECT MAX(step_number) mx FROM implantation_steps WHERE implantation_id=?').get(req.params.id);
  const id = 'st_' + Math.random().toString(36).slice(2,10);
  db.prepare(`INSERT INTO implantation_steps (id,implantation_id,step_number,title,description) VALUES (?,?,?,?,?)`)
    .run(id, req.params.id, (max?.mx||0)+1, title, description||null);
  res.json({ ok: true, id });
});

app.delete('/api/implantation-steps/:id', (req, res) => {
  db.prepare('DELETE FROM implantation_steps WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- Cycle logs ----------
app.post('/api/cycle-logs', (req,res) => {
  const { condo_id, period_start, period_type, cycles, note } = req.body || {};
  if (!condo_id || !period_start || !period_type || cycles == null) return res.status(400).json({ error:'missing_fields' });
  const id = 'cyc_' + Math.random().toString(36).slice(2,10);
  db.prepare(`INSERT INTO cycle_logs (id,condo_id,period_start,period_type,cycles,note) VALUES (?,?,?,?,?,?)`)
    .run(id, condo_id, period_start, period_type, cycles|0, note||null);
  res.json({ ok:true, id });
});
app.delete('/api/cycle-logs/:id', (req,res) => {
  db.prepare('DELETE FROM cycle_logs WHERE id=?').run(req.params.id);
  res.json({ ok:true });
});
app.get('/api/cycle-logs/:condoId', (req,res) => {
  const rows = db.prepare('SELECT * FROM cycle_logs WHERE condo_id=? ORDER BY period_start DESC LIMIT 500').all(req.params.condoId);
  res.json(rows);
});

// ---------- Supplies history (aggregated, time series) ----------
// period=day|week|month|year · condo_id optional · from/to opcional
app.get('/api/supplies/history', (req,res) => {
  const period = (req.query.period || 'month');
  const condoFilter = req.query.condo_id || null;
  const from = req.query.from || null;
  const to = req.query.to || null;

  const fmtByPeriod = {
    day: `%Y-%m-%d`,
    week: `%Y-W%W`,      // ISO-ish
    month: `%Y-%m`,
    year: `%Y`,
  }[period] || `%Y-%m`;

  const whereD = ["1=1"], argsD = [];
  const whereC = ["1=1"], argsC = [];
  if (condoFilter) { whereD.push('condo_id=?'); argsD.push(condoFilter); whereC.push('condo_id=?'); argsC.push(condoFilter); }
  if (from) { whereD.push('delivered_at>=?'); argsD.push(new Date(from).getTime()); whereC.push('period_start>=?'); argsC.push(from); }
  if (to)   { whereD.push('delivered_at<=?'); argsD.push(new Date(to+'T23:59:59').getTime()); whereC.push('period_start<=?'); argsC.push(to); }

  // Deliveries per bucket
  const deliveries = db.prepare(`
    SELECT strftime('${fmtByPeriod}', delivered_at/1000, 'unixepoch') as bucket,
           product,
           SUM(gallons) as gallons
    FROM deliveries WHERE ${whereD.join(' AND ')}
    GROUP BY bucket, product
    ORDER BY bucket ASC`).all(...argsD);

  // Cycles per bucket
  const cycles = db.prepare(`
    SELECT strftime('${fmtByPeriod}', period_start) as bucket,
           SUM(cycles) as cycles
    FROM cycle_logs WHERE ${whereC.join(' AND ')}
    GROUP BY bucket
    ORDER BY bucket ASC`).all(...argsC);

  // Build combined series
  const buckets = new Set([...deliveries.map(d=>d.bucket), ...cycles.map(c=>c.bucket)]);
  const ordered = Array.from(buckets).sort();
  const series = ordered.map(b => {
    const s = deliveries.find(d => d.bucket===b && d.product==='soap');
    const a = deliveries.find(d => d.bucket===b && d.product==='softener');
    const c = cycles.find(x => x.bucket===b);
    return {
      bucket: b,
      soap_gallons: s?.gallons || 0,
      softener_gallons: a?.gallons || 0,
      cycles: c?.cycles || 0,
    };
  });

  // Totals
  const totals = series.reduce((acc, r) => ({
    soap_gallons: acc.soap_gallons + r.soap_gallons,
    softener_gallons: acc.softener_gallons + r.softener_gallons,
    cycles: acc.cycles + r.cycles,
  }), { soap_gallons:0, softener_gallons:0, cycles:0 });

  res.json({ period, condo_id: condoFilter, from, to, totals, series });
});

// ----- Public endpoints for ticket-opening page (only reveal single condo) -----
// Fuzzy search across name + address + city + cep. Requires a query with min length
// and returns at most N matches — avoids dumping the whole list.
// IMPORTANT: declared BEFORE /:slug so the "search" segment isn't matched as slug.
app.get('/api/public/condominium/search', (req,res) => {
  const q = normalize(req.query.q||'').trim();
  if (q.length < 3) return res.json({ results: [], hint:'min 3 chars' });
  const tokens = q.split(/\s+/).filter(t => t.length >= 2);
  if (!tokens.length) return res.json({ results: [] });

  const rows = db.prepare(`SELECT id, slug, name, address, city, cep FROM condominiums WHERE is_contract=1`).all();
  const scored = [];
  for (const r of rows) {
    const hay = normalize(`${r.name} ${r.address||''} ${r.city||''} ${(r.cep||'').replace(/\D/g,'')}`);
    let score = 0;
    // Every token must appear somewhere; score higher if early / whole-word.
    let allFound = true;
    for (const t of tokens) {
      const idx = hay.indexOf(t);
      if (idx < 0) { allFound = false; break; }
      score += 10 - Math.min(9, Math.floor(idx / Math.max(1, hay.length/10)));
      // bonus if token matches start of name
      if (normalize(r.name).startsWith(t)) score += 5;
      if ((r.cep||'').replace(/\D/g,'').includes(t)) score += 20; // CEP hit is very strong
    }
    if (allFound) scored.push({ ...r, _score: score });
  }
  scored.sort((a,b) => b._score - a._score);
  res.json({ results: scored.slice(0, 8).map(({_score,...r}) => r) });
});

// Get a single condo by slug (minimal public fields) — used when QR/link has slug param
app.get('/api/public/condominium/:slug', (req,res) => {
  const c = db.prepare('SELECT id, slug, name, address, city FROM condominiums WHERE slug=? AND is_contract=1').get(req.params.slug);
  if (!c) return res.status(404).json({ error:'not_found' });
  res.json(c);
});

// ----- Tickets -----
app.post('/api/tickets', (req,res) => {
  const { condo_id, title, description, category, priority, opened_by_name, opened_by_email, opened_by_phone } = req.body || {};
  if (!title || !condo_id) return res.status(400).json({ error:'missing_fields' });
  const id = 'tkt_'+Math.random().toString(36).slice(2,11);
  db.prepare(`INSERT INTO tickets (id,condo_id,title,description,category,priority,opened_by_name,opened_by_email,opened_by_phone)
              VALUES (?,?,?,?,?,?,?,?,?)`).run(
    id, condo_id, title, description||null, category||'outro', priority||'media',
    opened_by_name||null, opened_by_email||null, opened_by_phone||null
  );
  emitEvent('ticket.created', { id, condo_id, title, priority, category }).catch(()=>{});
  res.json({ ok:true, id });
});

app.get('/api/tickets', (req,res) => {
  const { status, condo, tech, priority } = req.query;
  const where = [], args = [];
  if (status) { where.push('t.status=?'); args.push(status); }
  if (condo) { where.push('t.condo_id=?'); args.push(condo); }
  if (tech) { where.push('t.assigned_to=?'); args.push(tech); }
  if (priority) { where.push('t.priority=?'); args.push(priority); }
  const sql = `SELECT t.*, c.name as condo_name, c.city as condo_city FROM tickets t
               LEFT JOIN condominiums c ON c.id=t.condo_id`
             + (where.length?' WHERE '+where.join(' AND '):'')
             + ` ORDER BY
                 CASE t.priority WHEN 'urgente' THEN 1 WHEN 'alta' THEN 2 WHEN 'media' THEN 3 ELSE 4 END,
                 t.created_at DESC LIMIT 500`;
  res.json(db.prepare(sql).all(...args));
});

app.patch('/api/tickets/:id', async (req,res) => {
  const { status, priority, assigned_to, resolution, notify } = req.body || {};
  const prev = db.prepare('SELECT * FROM tickets WHERE id=?').get(req.params.id);
  if (!prev) return res.status(404).json({ error:'not_found' });
  db.prepare(`UPDATE tickets SET
    status=COALESCE(?,status), priority=COALESCE(?,priority),
    assigned_to=COALESCE(?,assigned_to), resolution=COALESCE(?,resolution),
    updated_at=?
    WHERE id=?`).run(status, priority, assigned_to, resolution, Date.now(), req.params.id);

  const notification = { channels: [], email: null, wa_url: null };

  // Auto-notify on status change (if caller asked for it)
  const statusChanged = status && status !== prev.status;
  if (statusChanged && notify !== false) {
    const ticket = db.prepare('SELECT * FROM tickets WHERE id=?').get(req.params.id);
    const condo = db.prepare('SELECT * FROM condominiums WHERE id=?').get(ticket.condo_id);
    const msg = buildTicketMessage(ticket, condo, prev.status, status);
    const subject = `Lavandery · Chamado ${ticket.id.slice(-6)} — ${statusLabel(status)}`;

    // Email — prefer condo contact, fallback to ticket opener
    const email = condo?.contact_email || ticket.opened_by_email;
    if (email) {
      try {
        const r = await sendEmail({ to: email, subject, text: msg }, getIntegration);
        db.prepare(`INSERT INTO notifications (id,ticket_id,channel,target,subject,body,status)
                    VALUES (?,?,?,?,?,?,?)`).run('ntf_'+Math.random().toString(36).slice(2,10),
          ticket.id, 'email', email, subject, msg, r.sent?'sent':'queued');
        notification.email = { target: email, sent: r.sent, reason: r.reason };
        notification.channels.push('email');
      } catch(e) {
        db.prepare(`INSERT INTO notifications (id,ticket_id,channel,target,subject,body,status)
                    VALUES (?,?,?,?,?,?,?)`).run('ntf_'+Math.random().toString(36).slice(2,10),
          ticket.id, 'email', email, subject, msg, 'failed');
        notification.email = { target: email, sent: false, error: String(e.message||e) };
      }
    }

    // WhatsApp — tenta enviar via Baileys (WhatsApp Web). Fallback: link wa.me
    const phone = ticket.opened_by_phone;
    if (phone) {
      const url = waLink({ phone, message: msg });
      let sent = false, reason = null;
      if (waStatus().status === 'connected') {
        const r = await waSendText({ phone, message: msg });
        sent = !!r.sent; reason = r.reason;
      } else {
        reason = 'wa_not_connected';
      }
      db.prepare(`INSERT INTO notifications (id,ticket_id,channel,target,subject,body,status,wa_link)
                  VALUES (?,?,?,?,?,?,?,?)`).run('ntf_'+Math.random().toString(36).slice(2,10),
        ticket.id, 'whatsapp', phone, subject, msg, sent?'sent':'queued', url);
      notification.whatsapp = { target: phone, sent, reason };
      notification.wa_url = url;
      notification.channels.push('whatsapp');
    }
  }

  emitEvent('ticket.status_changed', { id: req.params.id, from: prev.status, to: status, priority }).catch(()=>{});
  res.json({ ok:true, notification });
});

app.get('/api/tickets/:id/notifications', (req,res) => {
  res.json(db.prepare('SELECT * FROM notifications WHERE ticket_id=? ORDER BY created_at DESC').all(req.params.id));
});

app.delete('/api/tickets/:id', (req,res) => {
  db.prepare('DELETE FROM tickets WHERE id=?').run(req.params.id);
  res.json({ ok:true });
});

// ----- Geocoding -----
// Batch geocode all condos without coords. Slow (respects Nominatim 1req/s).
app.post('/api/condominiums/geocode', async (req, res) => {
  const force = req.body?.force === true;
  const limit = Math.min(parseInt(req.body?.limit||'500',10), 500);
  const rows = db.prepare(`SELECT id, address, city, cep FROM condominiums
                           WHERE is_contract=1 AND (? OR lat IS NULL OR lng IS NULL)
                           LIMIT ?`).all(force?1:0, limit);
  const upd = db.prepare('UPDATE condominiums SET lat=?, lng=?, geocoded_at=? WHERE id=?');
  let ok = 0, fail = 0;
  for (const r of rows) {
    try {
      const g = await geocodeAddress({ address: r.address, city: r.city, cep: r.cep });
      if (g) { upd.run(g.lat, g.lng, Date.now(), r.id); ok++; }
      else fail++;
    } catch(e) { fail++; }
    await new Promise(r=>setTimeout(r, 1100)); // respect 1 req/s
  }
  res.json({ ok: true, processed: rows.length, geocoded: ok, failed: fail });
});

// ----- Route for a tech on a specific date -----
app.get('/api/route', (req, res) => {
  const { date, technician } = req.query;
  if (!date || !technician) return res.status(400).json({ error: 'missing date or technician' });
  const rows = db.prepare(`
    SELECT s.id, s.date, s.scheduled_time, s.type, s.condo_id,
           c.name as condo_name, c.address, c.city, c.lat, c.lng
    FROM visits_schedule s
    JOIN condominiums c ON c.id = s.condo_id
    WHERE s.date = ? AND s.technician_id = ?
    ORDER BY s.scheduled_time`).all(date, technician);
  const withCoords = rows.filter(r => r.lat != null && r.lng != null);
  const withoutCoords = rows.filter(r => r.lat == null || r.lng == null);
  const ordered = orderByNearest(HQ, withCoords);
  // Compute totals
  let totalKm = 0;
  ordered.forEach(o => { totalKm += o.distanceFromPrev || 0; });
  res.json({
    date, technician,
    start: HQ,
    stops: ordered,
    unmapped: withoutCoords,
    totalKm: Math.round(totalKm * 10) / 10,
  });
});

app.delete('/api/schedule/:id', (req,res) => {
  db.prepare('DELETE FROM visits_schedule WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ----- Visits -----
app.post('/api/visits', (req,res) => {
  const v = req.body;
  if (!v?.id) return res.status(400).json({ error:'missing_id' });
  const upsertVisit = db.prepare(`
    INSERT INTO visits (id,technician_id,condo_id,visit_type,status,score,started_at,finished_at,checkin_geo,general,conclusion,updated_at)
    VALUES (@id,@technician_id,@condo_id,@visit_type,@status,@score,@started_at,@finished_at,@checkin_geo,@general,@conclusion,@updated_at)
    ON CONFLICT(id) DO UPDATE SET
      status=excluded.status, score=excluded.score, finished_at=excluded.finished_at,
      general=excluded.general, conclusion=excluded.conclusion, updated_at=excluded.updated_at
  `);
  const tx = db.transaction(() => {
    upsertVisit.run({
      id: v.id,
      technician_id: v.technicianId,
      condo_id: v.condoId,
      visit_type: v.visitType,
      status: v.status,
      score: v.score ?? null,
      started_at: v.startedAt ?? null,
      finished_at: v.finishedAt ?? null,
      checkin_geo: JSON.stringify(v.checkin?.geo || null),
      general: JSON.stringify(v.general || {}),
      conclusion: JSON.stringify(v.conclusion || {}),
      updated_at: v.updatedAt ?? Date.now(),
    });
    db.prepare('DELETE FROM visit_infrastructure WHERE visit_id=?').run(v.id);
    if (v.infrastructure) db.prepare(`INSERT INTO visit_infrastructure (visit_id,energy,internet,lighting,exhaust,drainage,cleaning,notes) VALUES (?,?,?,?,?,?,?,?)`)
      .run(v.id, v.infrastructure.energy, v.infrastructure.internet, v.infrastructure.lighting, v.infrastructure.exhaust, v.infrastructure.drainage, v.infrastructure.cleaning, v.infrastructure.notes);

    db.prepare('DELETE FROM visit_machines WHERE visit_id=?').run(v.id);
    const insM = db.prepare(`INSERT INTO visit_machines (visit_id,machine_id,code,type,status,problem,notes) VALUES (?,?,?,?,?,?,?)`);
    (v.machines||[]).forEach(m => insM.run(v.id, m.machineId, m.code, m.type, m.status, m.problem, m.notes));

    db.prepare('DELETE FROM visit_supplies WHERE visit_id=?').run(v.id);
    if (v.supplies) db.prepare('INSERT INTO visit_supplies (visit_id,soap,softener,doser,replenish_needed,notes) VALUES (?,?,?,?,?,?)')
      .run(v.id, v.supplies.soap, v.supplies.softener, v.supplies.doser, v.supplies.replenishNeeded?1:0, v.supplies.notes);
  });
  tx();
  res.json({ ok:true, id:v.id });
});

app.get('/api/visits', (req,res) => {
  const { technician, condo, from, to, status } = req.query;
  const where = [], args = [];
  if (technician) { where.push('technician_id=?'); args.push(technician); }
  if (condo) { where.push('condo_id=?'); args.push(condo); }
  if (status) { where.push('status=?'); args.push(status); }
  if (from) { where.push('started_at>=?'); args.push(new Date(from).getTime()); }
  if (to) { where.push('started_at<=?'); args.push(new Date(to+'T23:59:59').getTime()); }
  const sql = 'SELECT * FROM visits' + (where.length?' WHERE '+where.join(' AND '):'') + ' ORDER BY updated_at DESC LIMIT 200';
  res.json(db.prepare(sql).all(...args));
});

app.get('/api/visits/:id', (req,res) => {
  const v = db.prepare('SELECT * FROM visits WHERE id=?').get(req.params.id);
  if (!v) return res.status(404).json({ error:'not_found' });
  v.infrastructure = db.prepare('SELECT * FROM visit_infrastructure WHERE visit_id=?').get(v.id) || null;
  v.machines = db.prepare('SELECT * FROM visit_machines WHERE visit_id=?').all(v.id);
  v.supplies = db.prepare('SELECT * FROM visit_supplies WHERE visit_id=?').get(v.id) || null;
  v.photos = db.prepare('SELECT * FROM visit_photos WHERE visit_id=?').all(v.id);
  res.json(v);
});

// ----- Autentique contract import -----
try { db.exec(`ALTER TABLE condominiums ADD COLUMN autentique_doc_id TEXT`); } catch(e){}
try { db.exec(`ALTER TABLE condominiums ADD COLUMN cep TEXT`); } catch(e){}
try { db.exec(`ALTER TABLE condominiums ADD COLUMN cnpj TEXT`); } catch(e){}
try { db.exec(`ALTER TABLE condominiums ADD COLUMN washers INTEGER DEFAULT 0`); } catch(e){}
try { db.exec(`ALTER TABLE condominiums ADD COLUMN dryers INTEGER DEFAULT 0`); } catch(e){}
try { db.exec(`ALTER TABLE condominiums ADD COLUMN contract_source TEXT`); } catch(e){}
try { db.exec(`ALTER TABLE condominiums ADD COLUMN maintenance_interval_months INTEGER`); } catch(e){}
try { db.exec(`ALTER TABLE condominiums ADD COLUMN maintenance_label TEXT`); } catch(e){}
try { db.exec(`ALTER TABLE condominiums ADD COLUMN lat REAL`); } catch(e){}
try { db.exec(`ALTER TABLE condominiums ADD COLUMN lng REAL`); } catch(e){}
try { db.exec(`ALTER TABLE condominiums ADD COLUMN geocoded_at INTEGER`); } catch(e){}
try { db.exec(`ALTER TABLE condominiums ADD COLUMN is_contract INTEGER DEFAULT 1`); } catch(e){}
// Supply configuration & inventory (per condo)
try { db.exec(`ALTER TABLE condominiums ADD COLUMN cycles_per_week INTEGER`); } catch(e){}
try { db.exec(`ALTER TABLE condominiums ADD COLUMN soap_ml_per_cycle REAL DEFAULT 50`); } catch(e){}
try { db.exec(`ALTER TABLE condominiums ADD COLUMN softener_ml_per_cycle REAL DEFAULT 50`); } catch(e){}
try { db.exec(`ALTER TABLE condominiums ADD COLUMN gallon_ml INTEGER DEFAULT 5000`); } catch(e){}
try { db.exec(`ALTER TABLE condominiums ADD COLUMN soap_gallons_on_site REAL DEFAULT 0`); } catch(e){}
try { db.exec(`ALTER TABLE condominiums ADD COLUMN softener_gallons_on_site REAL DEFAULT 0`); } catch(e){}
try { db.exec(`ALTER TABLE condominiums ADD COLUMN last_delivery_at INTEGER`); } catch(e){}
try { db.exec(`ALTER TABLE condominiums ADD COLUMN contact_email TEXT`); } catch(e){}
try { db.exec(`ALTER TABLE condominiums ADD COLUMN slug TEXT`); } catch(e){}
try { db.exec(`ALTER TABLE condominiums ADD COLUMN cycle_rate REAL`); } catch(e){}  // R$ repasse / ciclo
try { db.exec(`ALTER TABLE condominiums ADD COLUMN cycle_price REAL`); } catch(e){} // R$ cobrado do usuário / ciclo
try { db.exec(`ALTER TABLE condominiums ADD COLUMN tax_rate REAL`); } catch(e){}
// Dados comerciais/bancários da implantação
try { db.exec(`ALTER TABLE condominiums ADD COLUMN bank_name TEXT`); } catch(e){}
try { db.exec(`ALTER TABLE condominiums ADD COLUMN bank_agency TEXT`); } catch(e){}
try { db.exec(`ALTER TABLE condominiums ADD COLUMN bank_account TEXT`); } catch(e){}
try { db.exec(`ALTER TABLE condominiums ADD COLUMN contract_sign_date TEXT`); } catch(e){}
try { db.exec(`ALTER TABLE condominiums ADD COLUMN implantation_date TEXT`); } catch(e){}
try { db.exec(`ALTER TABLE condominiums ADD COLUMN installation_owner TEXT`); } catch(e){} // LAVANDERY | CONDOMINIO
try { db.exec(`ALTER TABLE condominiums ADD COLUMN seller_name TEXT`); } catch(e){}

function makeSlug(s) {
  return (s||'').toString()
    .normalize('NFD').replace(/\p{Diacritic}/gu,'')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g,'-')
    .replace(/^-+|-+$/g,'')
    .slice(0, 60);
}
function normalize(s) {
  return (s||'').toString().normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase();
}
// Backfill slugs (one-time)
(() => {
  const rows = db.prepare('SELECT id, name, slug FROM condominiums').all();
  const used = new Set(rows.map(r => r.slug).filter(Boolean));
  const upd = db.prepare('UPDATE condominiums SET slug=? WHERE id=?');
  for (const r of rows) {
    if (r.slug) continue;
    let base = makeSlug(r.name) || r.id;
    let s = base; let n = 1;
    while (used.has(s)) { n++; s = `${base}-${n}`; }
    used.add(s);
    upd.run(s, r.id);
  }
})();

// Deliveries log
db.exec(`CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  condo_id TEXT REFERENCES condominiums(id) ON DELETE CASCADE,
  product TEXT NOT NULL,               -- soap | softener
  gallons REAL NOT NULL,
  delivered_at INTEGER DEFAULT (strftime('%s','now')*1000),
  note TEXT
);`);

// Cycle logs — número real de ciclos rodados num período
db.exec(`CREATE TABLE IF NOT EXISTS cycle_logs (
  id TEXT PRIMARY KEY,
  condo_id TEXT REFERENCES condominiums(id) ON DELETE CASCADE,
  period_start TEXT NOT NULL,          -- ISO date (YYYY-MM-DD ou YYYY-MM-01)
  period_type TEXT NOT NULL,           -- day | week | month
  cycles INTEGER NOT NULL,
  note TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now')*1000)
);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_cycle_condo ON cycle_logs(condo_id, period_start)`);

// ---------- Implantações ----------
db.exec(`CREATE TABLE IF NOT EXISTS implantations (
  id TEXT PRIMARY KEY,
  condo_id TEXT REFERENCES condominiums(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'agendada',     -- agendada | em_andamento | concluida | cancelada
  target_date TEXT,                   -- ISO date; prazo contratual de conclusão
  started_at INTEGER,
  completed_at INTEGER,
  technician_id TEXT REFERENCES technicians(id),
  contract_signed_at INTEGER,         -- preenchido automaticamente do Autentique
  notes TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now')*1000)
);
CREATE INDEX IF NOT EXISTS idx_impl_status ON implantations(status);
CREATE INDEX IF NOT EXISTS idx_impl_condo ON implantations(condo_id);`);

db.exec(`CREATE TABLE IF NOT EXISTS implantation_steps (
  id TEXT PRIMARY KEY,
  implantation_id TEXT REFERENCES implantations(id) ON DELETE CASCADE,
  step_number INTEGER,
  title TEXT NOT NULL,
  description TEXT,
  required INTEGER DEFAULT 1,
  completed INTEGER DEFAULT 0,
  completed_at INTEGER,
  completed_by TEXT,
  photo_url TEXT,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_step_impl ON implantation_steps(implantation_id, step_number);`);

// ---------- Módulo: Entrega de Equipamentos ----------
db.exec(`CREATE TABLE IF NOT EXISTS equipment_deliveries (
  id TEXT PRIMARY KEY,
  condo_id TEXT REFERENCES condominiums(id) ON DELETE SET NULL,
  -- snapshot dos dados do condo no momento da entrega (integridade histórica)
  condo_name TEXT,
  condo_cnpj TEXT,
  condo_address TEXT,
  -- responsável pelo recebimento
  responsible_name TEXT,
  responsible_cpf TEXT,
  responsible_phone TEXT,
  -- dados da entrega
  delivery_date TEXT,
  delivery_time TEXT,
  delivery_location TEXT,
  -- equipamentos
  conjuntos_qty INTEGER DEFAULT 0,
  unit_value REAL DEFAULT 53000,
  total_value REAL DEFAULT 0,
  equipment_brand TEXT DEFAULT 'Speed Queen',
  -- condição
  condition_new INTEGER DEFAULT 0,
  condition_no_damage INTEGER DEFAULT 0,
  condition_tested INTEGER DEFAULT 0,
  notes TEXT,
  -- assinatura (data URL base64 PNG)
  signature_data_url TEXT,
  -- PDF
  pdf_url TEXT,
  -- controle
  status TEXT DEFAULT 'em_andamento',
  created_by TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now')*1000),
  finalized_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ed_condo ON equipment_deliveries(condo_id, delivery_date DESC);
CREATE INDEX IF NOT EXISTS idx_ed_status ON equipment_deliveries(status, created_at DESC);`);

// ---- Extensões aditivas (safe ALTER: colunas novas em tabelas já existentes)
try { db.exec(`ALTER TABLE implantations ADD COLUMN type TEXT DEFAULT 'sem_obra'`); } catch(e){}
try { db.exec(`ALTER TABLE implantation_steps ADD COLUMN stage TEXT`); } catch(e){}
try { db.exec(`ALTER TABLE implantation_steps ADD COLUMN status TEXT`); } catch(e){}
try { db.exec(`ALTER TABLE implantation_steps ADD COLUMN started_at INTEGER`); } catch(e){}
try { db.exec(`ALTER TABLE implantation_steps ADD COLUMN responsible_id TEXT`); } catch(e){}

// Sub-itens de checklist por passo (ex: "validar ponto elétrico")
db.exec(`CREATE TABLE IF NOT EXISTS implantation_checklist_items (
  id TEXT PRIMARY KEY,
  step_id TEXT REFERENCES implantation_steps(id) ON DELETE CASCADE,
  position INTEGER,
  title TEXT NOT NULL,
  done INTEGER DEFAULT 0,
  photo_url TEXT,
  note TEXT,
  completed_at INTEGER,
  completed_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_impl_items_step ON implantation_checklist_items(step_id, position);`);

// Log de atividades
db.exec(`CREATE TABLE IF NOT EXISTS implantation_logs (
  id TEXT PRIMARY KEY,
  implantation_id TEXT REFERENCES implantations(id) ON DELETE CASCADE,
  actor TEXT,                -- nome do usuário
  action TEXT NOT NULL,      -- step.completed | step.reopened | status.changed | checklist.completed | file.uploaded
  target_type TEXT,          -- step | item | implantation | file
  target_id TEXT,
  data TEXT,                 -- JSON com detalhes
  at INTEGER DEFAULT (strftime('%s','now')*1000)
);
CREATE INDEX IF NOT EXISTS idx_impl_log ON implantation_logs(implantation_id, at DESC);`);

// Arquivos/mídia por implantação
db.exec(`CREATE TABLE IF NOT EXISTS implantation_files (
  id TEXT PRIMARY KEY,
  implantation_id TEXT REFERENCES implantations(id) ON DELETE CASCADE,
  step_id TEXT REFERENCES implantation_steps(id) ON DELETE SET NULL,
  url TEXT NOT NULL,
  kind TEXT,                 -- photo | pdf | other
  name TEXT,
  uploaded_by TEXT,
  uploaded_at INTEGER DEFAULT (strftime('%s','now')*1000)
);
CREATE INDEX IF NOT EXISTS idx_impl_files ON implantation_files(implantation_id, uploaded_at DESC);`);

function logImplantation(implantationId, { actor, action, targetType, targetId, data }) {
  try {
    db.prepare(`INSERT INTO implantation_logs (id,implantation_id,actor,action,target_type,target_id,data) VALUES (?,?,?,?,?,?,?)`)
      .run('lg_'+Math.random().toString(36).slice(2,10), implantationId, actor||'sistema', action, targetType||null, targetId||null, data?JSON.stringify(data):null);
  } catch(e) {}
}

// Eventos de implantação que disparam notificação (default)
const DEFAULT_IMPL_EVENTS_NOTIFY = ['step.completed','status.changed','implantation.completed','file.uploaded','template.reset','deadline.changed'];

// Notifica um evento de implantação pelos canais configurados (admin + condo)
async function notifyImplantation({ implantationId, action, data, actor }) {
  try {
    // Registra sempre no log interno
    logImplantation(implantationId, { actor: actor||'sistema', action, targetType:'implantation', targetId: implantationId, data });
    // Webhook sempre
    emitEvent(`implantation.${action}`, { implantation_id: implantationId, ...data }).catch(()=>{});

    const cfg = getIntegration('impl_notify') || {};
    let enabledEvents = cfg.events;
    if (typeof enabledEvents === 'string') enabledEvents = enabledEvents.split(',').map(s=>s.trim()).filter(Boolean);
    if (!Array.isArray(enabledEvents) || !enabledEvents.length) enabledEvents = DEFAULT_IMPL_EVENTS_NOTIFY;
    if (!enabledEvents.includes(action) && !enabledEvents.includes('*')) return;

    const impl = db.prepare(`SELECT i.*, c.name as condo_name, c.contact_email as condo_email, c.city as condo_city
      FROM implantations i LEFT JOIN condominiums c ON c.id=i.condo_id WHERE i.id=?`).get(implantationId);
    if (!impl) return;

    const admin = getIntegration('admin_contacts') || {};
    const adminEmails = (admin.emails || admin.email || '').split(',').map(s=>s.trim()).filter(Boolean);
    const adminPhones = (admin.phones || admin.phone || '').split(',').map(s=>s.trim()).filter(Boolean);
    const notifyCondo = cfg.notify_condo !== false; // default: sim

    const title = buildImplSubject(action, impl, data);
    const body = buildImplBody(action, impl, data);

    // Admin
    for (const email of adminEmails) {
      try { await sendEmail({ to: email, subject: title, text: body }, getIntegration); } catch {}
    }
    for (const phone of adminPhones) {
      try { await waSendText({ phone, message: body }); } catch {}
    }

    // Condomínio (opcional, só pra eventos relevantes pro cliente)
    const condoRelevant = ['status.changed','implantation.completed','deadline.changed'].includes(action);
    if (notifyCondo && condoRelevant && impl.condo_email) {
      try { await sendEmail({ to: impl.condo_email, subject: title, text: body }, getIntegration); } catch {}
    }
  } catch (e) { console.error('[notifyImplantation]', e); }
}

function buildImplSubject(action, impl, data) {
  const condo = impl.condo_name || 'Implantação';
  const map = {
    'step.completed': `✓ Etapa concluída · ${condo}`,
    'step.reopened': `↩️ Etapa reaberta · ${condo}`,
    'item.completed': `✓ Item concluído · ${condo}`,
    'status.changed': `🔁 Status da implantação · ${condo}`,
    'deadline.changed': `📅 Prazo alterado · ${condo}`,
    'implantation.completed': `🎉 Implantação concluída · ${condo}`,
    'file.uploaded': `📎 Nova foto na implantação · ${condo}`,
    'template.reset': `🛠 Template resetado · ${condo}`,
    'type.changed': `🏗 Tipo de obra alterado · ${condo}`,
    'technician.changed': `👷 Técnico alterado · ${condo}`,
  };
  return `Lavandery · ${map[action] || action}`;
}
function buildImplBody(action, impl, data) {
  const condo = impl.condo_name || '';
  const base = `Implantação: ${condo}\nProtocolo: ${impl.id}\nSLA: ${impl.target_date || '—'}\n\n`;
  const detail = {
    'step.completed': `Etapa "${data?.title||''}" marcada como concluída.`,
    'step.reopened': `Etapa "${data?.title||''}" foi reaberta.`,
    'item.completed': `Item "${data?.item_title||''}" concluído (etapa: ${data?.step_title||'—'}).`,
    'status.changed': `Status alterado de ${data?.from||'—'} para ${data?.to||'—'}.`,
    'deadline.changed': `Prazo alterado de ${data?.from||'—'} para ${data?.to||'—'}.`,
    'implantation.completed': `🎉 Todas as etapas foram concluídas. Implantação finalizada.`,
    'file.uploaded': `Nova foto/documento anexado à implantação.`,
    'template.reset': `O template de etapas foi resetado (${data?.template||'v2'}).`,
    'type.changed': `Tipo de obra alterado de ${data?.from||'—'} para ${data?.to||'—'}.`,
    'technician.changed': `Técnico responsável foi alterado.`,
  }[action] || action;
  return base + detail + `\n\nAcompanhe em tempo real no painel Lavandery.`;
}

// Template v1 (legado — mantido pra compatibilidade com implantações já criadas)
const IMPLANTATION_TEMPLATE = [
  { title: 'Vistoria técnica inicial', description: 'Verificar espaço, pontos de água, energia, exaustão e acesso.' },
  { title: 'Validar infraestrutura', description: 'Alinhar com o condomínio o que precisa ser adequado antes da instalação.' },
  { title: 'Agendar entrega dos equipamentos', description: 'Confirmar data e acesso ao prédio com síndico/zelador.' },
  { title: 'Transporte e descarga', description: 'Entregar lavadoras, secadoras, dosadoras e insumos iniciais.' },
  { title: 'Instalação das máquinas', description: 'Posicionar, conectar hidráulica, elétrica e exaustão.' },
  { title: 'Configuração do app Lavandery', description: 'Cadastrar máquinas no sistema, emparelhar controladoras, QR codes.' },
  { title: 'Testes de ciclo completo', description: 'Rodar ciclo de lavagem e secagem completo em cada máquina.' },
  { title: 'Treinamento do responsável', description: 'Explicar uso do app, tabela de preços, abertura de chamados.' },
  { title: 'Primeira carga de insumos', description: 'Abastecer sabão e amaciante (registrar no sistema).' },
  { title: 'Entrega e termo de aceite', description: 'Assinar termo de instalação concluída com o condomínio.' },
];

// Template v2 — 11 etapas canônicas com sub-checklists operacionais
const IMPLANTATION_TEMPLATE_V2 = [
  { stage: 'contract_signed', title: 'Contrato assinado', description: 'Marco inicial — dispara o SLA de 60 dias.', items: [
    'Contrato registrado no sistema', 'Cópia PDF arquivada', 'Data de assinatura validada'
  ]},
  { stage: 'condo_setup', title: 'Cadastro do condomínio', description: 'Dados completos para contato e operação.', items: [
    'Endereço completo confirmado', 'CEP / CNPJ validados', 'Síndico / zelador cadastrado', 'E-mail do responsável', 'Telefone de contato', 'Link público de chamados gerado'
  ]},
  { stage: 'site_survey', title: 'Vistoria técnica', description: 'Avaliação in loco da viabilidade do espaço.', items: [
    'Ponto elétrico validado', 'Hidráulica validada', 'Esgoto validado', 'Ventilação / exaustão validadas', 'Espaço dimensionado', 'Fotos do local subidas'
  ]},
  { stage: 'layout', title: 'Definição de layout', description: 'Projeto de posicionamento das máquinas.', items: [
    'Layout proposto', 'Fluxo de uso mapeado', 'Aprovação do condomínio', 'Plantas arquivadas'
  ]},
  { stage: 'construction', title: 'Obra (se aplicável)', description: 'Adequações estruturais antes da instalação.', items: [
    'Orçamento aprovado', 'Empresa contratada', 'Início da obra', 'Conclusão da obra', 'Vistoria pós-obra'
  ]},
  { stage: 'equipment_purchase', title: 'Compra de equipamentos', description: 'Pedido com fornecedor.', items: [
    'Lavadoras pedidas', 'Secadoras pedidas', 'Dosadoras pedidas', 'Nota fiscal emitida', 'Previsão de entrega'
  ]},
  { stage: 'logistics', title: 'Logística / entrega', description: 'Transporte até o condomínio.', items: [
    'Data agendada com condomínio', 'Transportadora contratada', 'Guincho/elevador reservado', 'Equipamentos entregues no local'
  ]},
  { stage: 'installation', title: 'Instalação', description: 'Montagem física das máquinas.', items: [
    'Hidráulica conectada', 'Elétrica conectada', 'Exaustão instalada', 'Dosadoras conectadas', 'Testes iniciais OK'
  ]},
  { stage: 'system_setup', title: 'Configuração do sistema', description: 'Pareamento no aplicativo Lavandery.', items: [
    'Máquinas cadastradas no app', 'QR codes impressos e afixados', 'Controladoras emparelhadas', 'Preços configurados', 'Meios de pagamento ativos'
  ]},
  { stage: 'training', title: 'Comunicação e treinamento', description: 'Engajamento de quem usa e administra.', items: [
    'Treinamento do síndico/zelador', 'Material impresso entregue', 'Comunicado aos moradores', 'Link de chamados divulgado', 'QR code afixado em todas as máquinas'
  ]},
  { stage: 'completed', title: 'Implantação concluída', description: 'Entrega formal e início da operação.', items: [
    'Termo de aceite assinado', 'Ciclo de teste real com morador', 'Primeira carga de insumos abastecida', 'Status operacional ativado'
  ]},
];

function createImplantationForCondo(condoId, { targetDate = null, contractSignedAt = null, technicianId = null, type = 'sem_obra', template = 'v2' } = {}) {
  const existing = db.prepare('SELECT id FROM implantations WHERE condo_id=? AND status != ?').get(condoId, 'cancelada');
  if (existing) return existing.id;

  const id = 'imp_' + Math.random().toString(36).slice(2,10);
  // Default target: 60 dias corridos após a assinatura do contrato (SLA)
  if (!targetDate) {
    const base = contractSignedAt ? new Date(contractSignedAt) : new Date();
    const target = new Date(base);
    target.setDate(target.getDate() + 60);
    targetDate = target.toISOString().slice(0,10);
  }
  db.prepare(`INSERT INTO implantations (id,condo_id,status,target_date,contract_signed_at,technician_id,type)
              VALUES (?,?,?,?,?,?,?)`).run(id, condoId, 'agendada', targetDate, contractSignedAt, technicianId, type);

  const tpl = template === 'v2' ? IMPLANTATION_TEMPLATE_V2 : IMPLANTATION_TEMPLATE;
  const insStep = db.prepare(`INSERT INTO implantation_steps (id,implantation_id,step_number,title,description,stage,status) VALUES (?,?,?,?,?,?,?)`);
  const insItem = db.prepare(`INSERT INTO implantation_checklist_items (id,step_id,position,title) VALUES (?,?,?,?)`);
  tpl.forEach((s, i) => {
    const stepId = 'st_'+Math.random().toString(36).slice(2,10);
    insStep.run(stepId, id, i+1, s.title, s.description, s.stage||null, 'pendente');
    if (Array.isArray(s.items)) s.items.forEach((t, j) => insItem.run('it_'+Math.random().toString(36).slice(2,10), stepId, j+1, t));
  });
  logImplantation(id, { action: 'implantation.created', targetType: 'implantation', targetId: id, data: { template, type, target_date: targetDate } });
  return id;
}

// Tickets
db.exec(`CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  condo_id TEXT REFERENCES condominiums(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT,                      -- máquina | infraestrutura | insumos | outro
  priority TEXT DEFAULT 'media',       -- baixa | media | alta | urgente
  status TEXT DEFAULT 'aberto',        -- aberto | em_andamento | resolvido | fechado
  opened_by_name TEXT,
  opened_by_email TEXT,
  opened_by_phone TEXT,
  assigned_to TEXT,                    -- technician id
  resolution TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now')*1000),
  updated_at INTEGER DEFAULT (strftime('%s','now')*1000)
);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_tickets_condo ON tickets(condo_id);`);

// ---------- Portal do Condomínio: pedidos de insumos + pagamentos + fotos ----------
db.exec(`CREATE TABLE IF NOT EXISTS supply_requests (
  id TEXT PRIMARY KEY,
  condo_id TEXT REFERENCES condominiums(id) ON DELETE CASCADE,
  items TEXT NOT NULL,            -- JSON: [{type:'sabao',qty:5,unit:'L'}, ...]
  note TEXT,
  status TEXT DEFAULT 'pendente', -- pendente | aprovado | entregue | cancelado
  requested_by TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now')*1000),
  updated_at INTEGER DEFAULT (strftime('%s','now')*1000)
);
CREATE INDEX IF NOT EXISTS idx_sr_condo ON supply_requests(condo_id);
CREATE INDEX IF NOT EXISTS idx_sr_status ON supply_requests(status);

CREATE TABLE IF NOT EXISTS condo_payments (
  id TEXT PRIMARY KEY,
  condo_id TEXT REFERENCES condominiums(id) ON DELETE CASCADE,
  period TEXT,                    -- '2026-04'
  type TEXT,                      -- repasse | comprovante
  amount REAL,
  reference TEXT,
  file_url TEXT,
  note TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now')*1000)
);
CREATE INDEX IF NOT EXISTS idx_cp_condo ON condo_payments(condo_id);

CREATE TABLE IF NOT EXISTS ticket_photos (
  id TEXT PRIMARY KEY,
  ticket_id TEXT REFERENCES tickets(id) ON DELETE CASCADE,
  data_url TEXT NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s','now')*1000)
);
CREATE INDEX IF NOT EXISTS idx_tp_ticket ON ticket_photos(ticket_id);`);

// ---------- Repasse por condomínio (módulo mensal) ----------
db.exec(`CREATE TABLE IF NOT EXISTS condo_repasse (
  id TEXT PRIMARY KEY,
  condo_id TEXT REFERENCES condominiums(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  washes INTEGER DEFAULT 0,
  dries INTEGER DEFAULT 0,
  cycles INTEGER,
  type TEXT,
  value REAL,
  tax_pct REAL,
  price REAL,
  receita_maquina REAL,
  repasse_bruto REAL,
  imposto REAL,
  repasse_liquido REAL,
  liquido_lavandery REAL,
  attachment_url TEXT,
  attachment_name TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now')*1000),
  updated_at INTEGER DEFAULT (strftime('%s','now')*1000),
  UNIQUE(condo_id, month)
);
CREATE INDEX IF NOT EXISTS idx_cr_condo ON condo_repasse(condo_id);`);

app.get('/api/condominiums/:id/repasse', (req, res) => {
  if (!req.user) return res.status(401).json({ error:'unauthorized' });
  const rows = db.prepare('SELECT * FROM condo_repasse WHERE condo_id=? ORDER BY month DESC').all(req.params.id);
  res.json(rows);
});

// Endpoint consolidado: TODOS os repasses de TODOS os condos em uma chamada
app.get('/api/repasses/all', (req, res) => {
  if (!req.user || !['admin','gestor'].includes(req.user.role)) return res.status(403).json({ error:'forbidden' });
  const year = req.query.year;
  let sql = `SELECT cr.*, c.name as condo_name
    FROM condo_repasse cr
    LEFT JOIN condominiums c ON c.id=cr.condo_id`;
  const args = [];
  if (year) { sql += ` WHERE cr.month LIKE ?`; args.push(year+'%'); }
  sql += ` ORDER BY cr.month DESC`;
  const rows = db.prepare(sql).all(...args);
  res.json(rows);
});
app.post('/api/condominiums/:id/repasse', (req, res) => {
  if (!req.user || !['admin','gestor'].includes(req.user.role)) return res.status(403).json({ error:'forbidden' });
  const b = req.body || {};
  if (!b.month) return res.status(400).json({ error:'missing_month' });
  const w = parseInt(b.washes)||0, d = parseInt(b.dries)||0;
  const cycles = w + d;
  const type = b.type || 'fixed';
  const value = parseFloat(b.value)||0;
  const tax_pct = parseFloat(b.tax)||0;
  const price = parseFloat(b.price)||0;
  const receita = cycles * price;
  let repasse_bruto = 0;
  if (type === 'fixed') repasse_bruto = cycles * value;
  else repasse_bruto = receita * (value/100);
  const imposto = repasse_bruto * (tax_pct/100);
  const repasse_liq = repasse_bruto - imposto;
  const liq_lav = price > 0 ? receita - repasse_bruto : null;
  const id = `rep_${req.params.id}_${b.month}`;
  let attUrl = null, attName = null;
  if (b.attachment && b.attachment.startsWith('data:') && b.attachment.length < 6_000_000) {
    try {
      const dir = path.join(UPLOADS_DIR, 'repasse');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const ext = (b.attachment_name||'anexo').split('.').pop().toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,5) || 'bin';
      const fname = `${id}_${Date.now()}.${ext}`;
      const data = Buffer.from(b.attachment.split(',')[1], 'base64');
      fs.writeFileSync(path.join(dir, fname), data);
      attUrl = `/uploads/repasse/${fname}`;
      attName = b.attachment_name || fname;
    } catch(e) { console.error('attachment save fail', e); }
  }
  db.prepare(`INSERT INTO condo_repasse
    (id,condo_id,month,washes,dries,cycles,type,value,tax_pct,price,receita_maquina,repasse_bruto,imposto,repasse_liquido,liquido_lavandery,attachment_url,attachment_name,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(condo_id,month) DO UPDATE SET
      washes=excluded.washes, dries=excluded.dries, cycles=excluded.cycles, type=excluded.type,
      value=excluded.value, tax_pct=excluded.tax_pct, price=excluded.price,
      receita_maquina=excluded.receita_maquina, repasse_bruto=excluded.repasse_bruto,
      imposto=excluded.imposto, repasse_liquido=excluded.repasse_liquido,
      liquido_lavandery=excluded.liquido_lavandery,
      attachment_url=COALESCE(excluded.attachment_url, condo_repasse.attachment_url),
      attachment_name=COALESCE(excluded.attachment_name, condo_repasse.attachment_name),
      updated_at=?`)
    .run(id, req.params.id, b.month, w, d, cycles, type, value, tax_pct, price, receita, repasse_bruto, imposto, repasse_liq, liq_lav, attUrl, attName, Date.now(), Date.now());
  db.prepare(`INSERT INTO condo_payments (id,condo_id,period,type,amount,reference,note)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET amount=excluded.amount, note=excluded.note, reference=excluded.reference`)
    .run(`pay_${id}`, req.params.id, b.month, 'repasse', repasse_liq,
      type==='fixed' ? `R$ ${value.toFixed(2)}/ciclo` : `${value}% sobre receita`,
      `${cycles} ciclos (${w} lav + ${d} sec) · Repasse bruto R$ ${repasse_bruto.toFixed(2)} · Imposto ${tax_pct}% · Repasse líquido`);
  if (type === 'fixed' && value > 0) db.prepare('UPDATE condominiums SET cycle_rate=? WHERE id=?').run(value, req.params.id);
  if (price > 0) db.prepare('UPDATE condominiums SET cycle_price=? WHERE id=?').run(price, req.params.id);
  if (tax_pct > 0) db.prepare('UPDATE condominiums SET tax_rate=? WHERE id=?').run(tax_pct, req.params.id);
  res.json({ ok:true, id, receita, repasse_bruto, imposto, repasse_liquido: repasse_liq, liquido_lavandery: liq_lav });
});
// Relatório PDF consolidado de repasses do mês
app.get('/api/repasses/report.pdf', async (req, res) => {
  if (!req.user || !['admin','gestor'].includes(req.user.role)) return res.status(403).json({ error:'forbidden' });
  const month = req.query.month;
  if (!month) return res.status(400).json({ error:'missing_month' });
  const rows = db.prepare(`SELECT cr.*, c.name as condo_name
    FROM condo_repasse cr
    LEFT JOIN condominiums c ON c.id=cr.condo_id
    WHERE cr.month=? ORDER BY c.name`).all(month);
  try {
    const { default: jsPDF } = await import('jspdf');
    const doc = new jsPDF({ unit:'pt', format:'a4', orientation:'landscape' });
    const W = 842, pad = 30;
    doc.setFillColor(83,60,157); doc.rect(0,0,W,60,'F');
    doc.setTextColor(255); doc.setFont('helvetica','bold'); doc.setFontSize(18);
    doc.text('LAVANDERY · Relatório de Repasses', pad, 38);
    const [y, m] = month.split('-');
    const meses = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
    doc.setFontSize(11); doc.setFont('helvetica','normal');
    doc.text(`${meses[parseInt(m,10)-1]} / ${y}`, W-pad, 38, { align:'right' });

    doc.setTextColor(40);
    let yy = 90;
    const money = n => 'R$ ' + (+n||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});

    // Cabeçalho da tabela
    doc.setFillColor(246,243,250); doc.rect(pad, yy-14, W-2*pad, 22, 'F');
    doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.setTextColor(80);
    const cols = [
      { label:'Condomínio', x: pad+4, w: 220 },
      { label:'Lav', x: pad+226, w: 40, align:'right' },
      { label:'Sec', x: pad+266, w: 40, align:'right' },
      { label:'Ciclos', x: pad+306, w: 50, align:'right' },
      { label:'Tipo', x: pad+360, w: 50 },
      { label:'Valor', x: pad+414, w: 60, align:'right' },
      { label:'Imp%', x: pad+478, w: 40, align:'right' },
      { label:'Rep. Bruto', x: pad+522, w: 70, align:'right' },
      { label:'Imposto', x: pad+596, w: 60, align:'right' },
      { label:'Rep. Líq.', x: pad+660, w: 70, align:'right' },
      { label:'Líq. Lav.', x: pad+734, w: 70, align:'right' },
    ];
    for (const c of cols) doc.text(c.label, c.x + (c.align==='right'?c.w:0), yy, { align: c.align||'left' });
    yy += 18;
    doc.setFont('helvetica','normal'); doc.setFontSize(9);

    let totalBruto = 0, totalLiq = 0, totalLav = 0, totalImp = 0;
    for (const r of rows) {
      if (yy > 540) { doc.addPage({ orientation:'landscape' }); yy = 40; }
      doc.setDrawColor(230); doc.line(pad, yy+3, W-pad, yy+3);
      doc.setTextColor(40);
      const vals = [
        (r.condo_name||'—').slice(0,40),
        String(r.washes||0),
        String(r.dries||0),
        String((r.washes||0)+(r.dries||0)),
        r.type==='fixed'?'R$/ciclo':'%',
        r.type==='fixed'?money(r.value):`${r.value}%`,
        `${(r.tax_pct||0).toFixed(2)}%`,
        money(r.repasse_bruto),
        money(r.imposto),
        money(r.repasse_liquido),
        r.liquido_lavandery!=null ? money(r.liquido_lavandery) : '—',
      ];
      cols.forEach((c, i) => doc.text(vals[i], c.x + (c.align==='right'?c.w:0), yy, { align: c.align||'left' }));
      yy += 16;
      totalBruto += r.repasse_bruto||0; totalLiq += r.repasse_liquido||0; totalLav += r.liquido_lavandery||0; totalImp += r.imposto||0;
    }

    // Totais
    yy += 8;
    doc.setFillColor(246,243,250); doc.rect(pad, yy-12, W-2*pad, 30, 'F');
    doc.setFont('helvetica','bold'); doc.setFontSize(10); doc.setTextColor(83,60,157);
    doc.text('TOTAIS', pad+4, yy+4);
    doc.text(money(totalBruto), cols[7].x+cols[7].w, yy+4, { align:'right' });
    doc.text(money(totalImp), cols[8].x+cols[8].w, yy+4, { align:'right' });
    doc.text(money(totalLiq), cols[9].x+cols[9].w, yy+4, { align:'right' });
    doc.text(money(totalLav), cols[10].x+cols[10].w, yy+4, { align:'right' });

    // Rodapé
    doc.setFont('helvetica','italic'); doc.setFontSize(8); doc.setTextColor(120);
    doc.text(`${rows.length} condomínios · Gerado em ${new Date().toLocaleString('pt-BR')}`, pad, 580);

    const buffer = Buffer.from(doc.output('arraybuffer'));
    res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="repasses-${month}.pdf"`);
    res.send(buffer);
  } catch (e) {
    console.error('[report]', e);
    res.status(500).json({ error:'pdf_failed', detail: String(e.message||e) });
  }
});

// Relatório PDF analítico por condomínio (ano)
app.get('/api/condominiums/:id/repasse-report.pdf', async (req, res) => {
  if (!req.user || !['admin','gestor'].includes(req.user.role)) return res.status(403).json({ error:'forbidden' });
  const year = req.query.year || String(new Date().getFullYear());
  const cid = req.params.id;
  const condo = db.prepare('SELECT * FROM condominiums WHERE id=?').get(cid);
  if (!condo) return res.status(404).json({ error: 'not_found' });
  const rows = db.prepare(`SELECT * FROM condo_repasse WHERE condo_id=? AND month LIKE ? ORDER BY month`).all(cid, year+'%');
  try {
    const { default: jsPDF } = await import('jspdf');
    const doc = new jsPDF({ unit:'pt', format:'a4' });
    const W = 595, pad = 40;
    doc.setFillColor(83,60,157); doc.rect(0,0,W,70,'F');
    doc.setTextColor(255); doc.setFont('helvetica','bold'); doc.setFontSize(18);
    doc.text('LAVANDERY · Análise Financeira', pad, 38);
    doc.setFontSize(10); doc.setFont('helvetica','normal');
    doc.text(`Período: Janeiro a Dezembro / ${year}`, pad, 56);
    const money = n => 'R$ ' + (+n||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});

    doc.setTextColor(40);
    doc.setFont('helvetica','bold'); doc.setFontSize(14);
    doc.text((condo.name||'').toUpperCase(), pad, 100);
    doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(100);
    if (condo.address) doc.text(condo.address, pad, 116);
    doc.text(`${condo.washers||0} lavadoras · ${condo.dryers||0} secadoras`, pad, 130);

    // KPIs
    const totCiclos = rows.reduce((s,r) => s + (r.cycles||0), 0);
    const totLav = rows.reduce((s,r) => s + (r.washes||0), 0);
    const totSec = rows.reduce((s,r) => s + (r.dries||0), 0);
    const totRepasse = rows.reduce((s,r) => s + (r.repasse_liquido||0), 0);
    const totLavandery = rows.reduce((s,r) => s + (r.liquido_lavandery||0), 0);
    const totBruto = rows.reduce((s,r) => s + (r.repasse_bruto||0), 0);
    const totImposto = rows.reduce((s,r) => s + (r.imposto||0), 0);
    const totReceita = rows.reduce((s,r) => s + (r.receita_maquina||0), 0);

    let yy = 160;
    doc.setDrawColor(220); doc.line(pad, yy-5, W-pad, yy-5);
    doc.setFont('helvetica','bold'); doc.setFontSize(11); doc.setTextColor(30);
    doc.text('RESUMO DO ANO', pad, yy+10); yy += 24;
    doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(60);
    const kpis = [
      ['Total de ciclos', totCiclos.toLocaleString('pt-BR')],
      ['  Lavagens', totLav.toLocaleString('pt-BR')],
      ['  Secagens', totSec.toLocaleString('pt-BR')],
      ['Receita bruta (máquina)', money(totReceita)],
      ['Repasse bruto', money(totBruto)],
      ['Imposto recolhido', money(totImposto)],
      ['REPASSE PAGO AO CONDOMÍNIO', money(totRepasse)],
      ['Líquido Lavandery', money(totLavandery)],
    ];
    for (const [a,b] of kpis) {
      const isHighlight = a.startsWith('REPASSE');
      if (isHighlight) { doc.setFillColor(246,243,250); doc.rect(pad-4, yy-10, W-2*pad+8, 22, 'F'); doc.setFont('helvetica','bold'); doc.setTextColor(83,60,157); }
      else { doc.setFont('helvetica','normal'); doc.setTextColor(60); }
      doc.text(a, pad, yy);
      doc.text(b, W-pad, yy, { align:'right' });
      yy += 20;
    }

    // Tabela mensal
    yy += 10;
    doc.setFillColor(246,243,250); doc.rect(pad, yy, W-2*pad, 22, 'F');
    doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.setTextColor(80);
    const cols = [
      { l:'Mês', x: pad+4, a:'left' },
      { l:'Ciclos', x: pad+80, a:'right' },
      { l:'Bruto', x: pad+140, a:'right' },
      { l:'Imposto', x: pad+220, a:'right' },
      { l:'Repasse', x: pad+310, a:'right' },
      { l:'Lavandery', x: pad+400, a:'right' },
    ];
    yy += 14;
    cols.forEach(c => doc.text(c.l, c.x, yy, { align: c.a }));
    yy += 18;
    doc.setFont('helvetica','normal'); doc.setFontSize(9);
    const meses = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
    for (const r of rows) {
      if (yy > 760) { doc.addPage(); yy = 40; }
      const mo = parseInt((r.month||'').slice(5,7),10);
      doc.setDrawColor(235); doc.line(pad, yy+3, W-pad, yy+3); doc.setTextColor(50);
      doc.text(`${meses[mo-1]||'-'} ${r.month?.slice(0,4)||''}`, cols[0].x, yy, { align: cols[0].a });
      doc.text(String(r.cycles||0), cols[1].x, yy, { align: cols[1].a });
      doc.text(money(r.repasse_bruto), cols[2].x, yy, { align: cols[2].a });
      doc.setTextColor(200,50,50); doc.text(money(r.imposto), cols[3].x, yy, { align: cols[3].a });
      doc.setTextColor(83,60,157); doc.text(money(r.repasse_liquido), cols[4].x, yy, { align: cols[4].a });
      doc.setTextColor(30,150,100); doc.text(r.liquido_lavandery!=null?money(r.liquido_lavandery):'—', cols[5].x, yy, { align: cols[5].a });
      yy += 16;
    }

    doc.setFont('helvetica','italic'); doc.setFontSize(8); doc.setTextColor(120);
    doc.text(`Gerado em ${new Date().toLocaleString('pt-BR')}`, pad, 820);
    doc.text('Lavandery · Inova Tecnologia e Serviços', W-pad, 820, { align:'right' });

    const buffer = Buffer.from(doc.output('arraybuffer'));
    res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="analise_${cid}_${year}.pdf"`);
    res.send(buffer);
  } catch (e) {
    console.error('[repasse-report]', e);
    res.status(500).json({ error:'pdf_failed', detail: String(e.message||e) });
  }
});

app.delete('/api/condominiums/:id/repasse/:month', (req, res) => {
  if (!req.user || !['admin','gestor'].includes(req.user.role)) return res.status(403).json({ error:'forbidden' });
  db.prepare('DELETE FROM condo_repasse WHERE condo_id=? AND month=?').run(req.params.id, req.params.month);
  res.json({ ok:true });
});

// Helpers
function requireCondo(req, res) {
  if (!req.user || req.user.role !== 'condo' || !req.user.condo_id) {
    res.status(401).json({ error: 'unauthorized' });
    return null;
  }
  return req.user.condo_id;
}
function rid(prefix) { return prefix + '_' + Math.random().toString(36).slice(2, 10); }

// Info do condo logado
app.get('/api/condo/me', (req, res) => {
  const cid = requireCondo(req, res); if (!cid) return;
  const c = db.prepare('SELECT id, name, address, city, washers, dryers, maintenance_label FROM condominiums WHERE id=?').get(cid);
  res.json({ user: req.user, condo: c });
});

// Pedidos de insumos
app.get('/api/condo/supply-requests', (req, res) => {
  const cid = requireCondo(req, res); if (!cid) return;
  const rows = db.prepare('SELECT * FROM supply_requests WHERE condo_id=? ORDER BY created_at DESC').all(cid);
  res.json(rows.map(r => ({ ...r, items: JSON.parse(r.items||'[]') })));
});
app.post('/api/condo/supply-requests', (req, res) => {
  const cid = requireCondo(req, res); if (!cid) return;
  const { items, note } = req.body || {};
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error:'missing_items' });
  const id = rid('sr');
  db.prepare('INSERT INTO supply_requests (id,condo_id,items,note,requested_by) VALUES (?,?,?,?,?)').run(id, cid, JSON.stringify(items), note||'', req.user.name||'');
  res.json({ ok:true, id });
});

// Chamados do condo
app.get('/api/condo/tickets', (req, res) => {
  const cid = requireCondo(req, res); if (!cid) return;
  const rows = db.prepare('SELECT * FROM tickets WHERE condo_id=? ORDER BY created_at DESC').all(cid);
  const photoStmt = db.prepare('SELECT data_url FROM ticket_photos WHERE ticket_id=?');
  res.json(rows.map(r => ({ ...r, photos: photoStmt.all(r.id).map(p => p.data_url) })));
});
app.post('/api/condo/tickets', (req, res) => {
  const cid = requireCondo(req, res); if (!cid) return;
  const { title, description, category, priority, photos } = req.body || {};
  if (!title) return res.status(400).json({ error:'missing_title' });
  const id = rid('tk');
  db.prepare('INSERT INTO tickets (id,condo_id,title,description,category,priority,opened_by_name) VALUES (?,?,?,?,?,?,?)')
    .run(id, cid, title, description||'', category||'outro', priority||'media', req.user.name||'');
  if (Array.isArray(photos)) {
    const ins = db.prepare('INSERT INTO ticket_photos (id,ticket_id,data_url) VALUES (?,?,?)');
    for (const p of photos.slice(0, 8)) {
      if (typeof p === 'string' && p.startsWith('data:image/') && p.length < 4_000_000) {
        ins.run(rid('tkp'), id, p);
      }
    }
  }
  res.json({ ok:true, id });
});

// Pagamentos (condo vê seus comprovantes)
app.get('/api/condo/payments', (req, res) => {
  const cid = requireCondo(req, res); if (!cid) return;
  const rows = db.prepare('SELECT * FROM condo_payments WHERE condo_id=? ORDER BY created_at DESC').all(cid);
  res.json(rows);
});

// Admin: listar/criar/atualizar pedidos e pagamentos
app.get('/api/supply-requests', (req, res) => {
  if (!req.user || !['admin','gestor'].includes(req.user.role)) return res.status(403).json({ error:'forbidden' });
  const rows = db.prepare(`SELECT sr.*, c.name AS condo_name FROM supply_requests sr
    LEFT JOIN condominiums c ON c.id=sr.condo_id ORDER BY sr.created_at DESC LIMIT 500`).all();
  res.json(rows.map(r => ({ ...r, items: JSON.parse(r.items||'[]') })));
});
app.patch('/api/supply-requests/:id', (req, res) => {
  if (!req.user || !['admin','gestor'].includes(req.user.role)) return res.status(403).json({ error:'forbidden' });
  const { status, note } = req.body || {};
  db.prepare('UPDATE supply_requests SET status=COALESCE(?,status), note=COALESCE(?,note), updated_at=? WHERE id=?').run(status, note, Date.now(), req.params.id);
  res.json({ ok:true });
});

app.post('/api/condo-payments', (req, res) => {
  if (!req.user || !['admin','gestor'].includes(req.user.role)) return res.status(403).json({ error:'forbidden' });
  const { condo_id, period, type, amount, reference, file_url, note } = req.body || {};
  if (!condo_id) return res.status(400).json({ error:'missing_condo' });
  const id = rid('pay');
  db.prepare('INSERT INTO condo_payments (id,condo_id,period,type,amount,reference,file_url,note) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, condo_id, period||'', type||'repasse', amount||0, reference||'', file_url||'', note||'');
  res.json({ ok:true, id });
});
app.get('/api/condo-payments', (req, res) => {
  if (!req.user || !['admin','gestor'].includes(req.user.role)) return res.status(403).json({ error:'forbidden' });
  const rows = db.prepare(`SELECT p.*, c.name AS condo_name FROM condo_payments p
    LEFT JOIN condominiums c ON c.id=p.condo_id ORDER BY p.created_at DESC LIMIT 500`).all();
  res.json(rows);
});

// ---------- Integrations store (key/value, overlay over .env) ----------
db.exec(`CREATE TABLE IF NOT EXISTS integrations (
  key TEXT PRIMARY KEY,
  value TEXT,                 -- JSON blob
  enabled INTEGER DEFAULT 1,
  updated_at INTEGER DEFAULT (strftime('%s','now')*1000)
);`);
function getIntegration(key) {
  const r = db.prepare('SELECT value, enabled FROM integrations WHERE key=?').get(key);
  if (!r) return null;
  try { return { ...JSON.parse(r.value||'{}'), enabled: !!r.enabled }; } catch { return null; }
}
// Resolve a config value: integrations DB > process.env
function getConfig(key, envKey) {
  const env = process.env[envKey||key];
  const row = db.prepare('SELECT value, enabled FROM integrations WHERE key=?').get(key);
  if (row && row.enabled) {
    try { const v = JSON.parse(row.value||'{}'); if (Object.keys(v).length) return v; } catch {}
  }
  return env ? { value: env } : null;
}

// ---------- API tokens (Bearer auth for /api/v1) ----------
db.exec(`CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  name TEXT,
  token TEXT UNIQUE NOT NULL,
  scopes TEXT,                 -- JSON array (e.g. ["read:condos","write:tickets"])
  last_used_at INTEGER,
  created_at INTEGER DEFAULT (strftime('%s','now')*1000)
);`);

// ---------- Webhooks (outgoing subscriptions + incoming logs) ----------
db.exec(`CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  secret TEXT,
  events TEXT,                 -- JSON array
  active INTEGER DEFAULT 1,
  created_at INTEGER DEFAULT (strftime('%s','now')*1000)
);`);
db.exec(`CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  subscription_id TEXT,
  event TEXT,
  payload TEXT,
  response_status INTEGER,
  response_body TEXT,
  direction TEXT,              -- out | in
  source TEXT,                 -- incoming source name
  created_at INTEGER DEFAULT (strftime('%s','now')*1000)
);`);

function hmacSig(secret, body) { return crypto.createHmac('sha256', secret||'').update(body).digest('hex'); }
async function emitEvent(event, payload) {
  const subs = db.prepare("SELECT * FROM webhook_subscriptions WHERE active=1").all()
    .filter(s => { try { const evs = JSON.parse(s.events||'[]'); return !evs.length || evs.includes(event) || evs.includes('*'); } catch { return false; } });
  const body = JSON.stringify({ event, payload, ts: Date.now() });
  for (const s of subs) {
    let status = 0, respBody = '';
    try {
      const r = await fetch(s.url, { method:'POST', headers: { 'Content-Type':'application/json', 'X-Lavandery-Signature': hmacSig(s.secret, body), 'X-Lavandery-Event': event }, body });
      status = r.status; respBody = (await r.text()).slice(0,1000);
    } catch (e) { respBody = String(e.message||e); }
    db.prepare(`INSERT INTO webhook_events (id,subscription_id,event,payload,response_status,response_body,direction) VALUES (?,?,?,?,?,?,?)`)
      .run('evt_'+Math.random().toString(36).slice(2,10), s.id, event, body, status, respBody, 'out');
  }
}

// Wire events into existing flows (fire-and-forget)
function after(fn, event, pickPayload) {
  return async (...args) => {
    const result = await fn(...args);
    try {
      const req = args[0], res = args[1];
      const p = pickPayload ? pickPayload(req, res, result) : { id: req.params.id };
      emitEvent(event, p).catch(()=>{});
    } catch {}
    return result;
  };
}

// Notifications log (every email/WhatsApp we tried to deliver)
db.exec(`CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  ticket_id TEXT,
  channel TEXT,             -- email | whatsapp
  target TEXT,              -- email or phone
  subject TEXT,
  body TEXT,
  status TEXT,              -- sent | failed | queued
  wa_link TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now')*1000)
);`);

// List contracts from Autentique with extracted data (cached per document)
db.exec(`CREATE TABLE IF NOT EXISTS contract_cache (
  document_id TEXT PRIMARY KEY,
  name TEXT, created_at TEXT,
  extracted TEXT, raw_file_url TEXT,
  fetched_at INTEGER
);`);

app.get('/api/autentique/contracts', async (req, res) => {
  try {
    const refresh = req.query.refresh === '1';
    const context = (req.query.context || 'ORGANIZATION').toUpperCase();
    const all = req.query.all !== '0'; // default: fetch all pages
    const page = parseInt(req.query.page||'1',10);
    const limit = Math.min(parseInt(req.query.limit||'60',10), 60);
    const docs = all
      ? await listAllDocuments({ context, pageSize: limit })
      : await listDocuments({ page, limit, context });
    docs.current_page = docs.current_page || 1;
    const cached = db.prepare('SELECT document_id, extracted FROM contract_cache').all();
    const cacheMap = Object.fromEntries(cached.map(c => [c.document_id, JSON.parse(c.extracted||'null')]));

    const result = [];
    for (const d of docs.data) {
      let extracted = cacheMap[d.id];
      if (refresh || !extracted || !extracted.raw) {
        try {
          // Prefer Google Cloud Storage URL (anonymous, fast, no rate limit)
          const url = d.files?.original || d.files?.signed;
          if (url) {
            const buf = await downloadFile(url);
            extracted = await extractFromPdf(buf, d.name);
            db.prepare(`INSERT OR REPLACE INTO contract_cache (document_id,name,created_at,extracted,raw_file_url,fetched_at)
                        VALUES (?,?,?,?,?,?)`)
              .run(d.id, d.name, d.created_at, JSON.stringify(extracted), url, Date.now());
            await new Promise(r=>setTimeout(r, 200)); // throttle
          }
        } catch(e) { extracted = { error: String(e.message||e) }; }
      }
      result.push({ id: d.id, name: d.name, created_at: d.created_at, signatures: d.signatures, extracted });
    }
    res.json({ total: docs.total, page: docs.current_page, last_page: docs.last_page, data: result });
  } catch (e) {
    console.error('[contracts]', e);
    res.status(500).json({ error: 'fetch_failed', detail: String(e.message||e) });
  }
});

// Bulk import condos from selected Autentique contracts (with optional overrides)
// Apaga TUDO: condomínios + relacionados (máquinas, visitas, chamados, implantações, repasses etc via CASCADE)
app.post('/api/condominiums/wipe-all', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error:'admin_only' });
  const { confirm } = req.body || {};
  if (confirm !== 'SIM APAGAR TUDO') return res.status(400).json({ error:'missing_confirmation', hint:'envie body={"confirm":"SIM APAGAR TUDO"}' });
  const before = db.prepare('SELECT COUNT(*) c FROM condominiums').get().c;
  db.prepare('DELETE FROM condominiums').run();
  // Limpa também dados que não têm FK
  db.prepare('DELETE FROM cycle_logs').run();
  db.prepare('DELETE FROM condo_payments').run();
  db.prepare('DELETE FROM condo_repasse').run();
  db.prepare('DELETE FROM visits_schedule').run();
  db.prepare('DELETE FROM tickets').run();
  db.prepare('DELETE FROM implantations').run();
  db.prepare('DELETE FROM supply_requests').run();
  // Cria usuários condo também some (mantém admin/tecnico)
  db.prepare("DELETE FROM users WHERE role='condo'").run();
  res.json({ ok:true, deleted: before });
});

// Importa do Autentique: contratos assinados pelo CONTRATANTE, dedup por nome, classifica implantado por data
app.post('/api/condominiums/auto-import-signed', async (req, res) => {
  if (!req.user || !['admin','gestor'].includes(req.user.role)) return res.status(403).json({ error:'forbidden' });
  try {
    // 1) Busca contratos da organização inteira (ambos contextos)
    const [orgDocs, userDocs] = await Promise.all([
      listAllDocuments({ context: 'ORGANIZATION', pageSize: 60 }).catch(() => ({ data: [] })),
      listAllDocuments({ context: 'USER', pageSize: 60 }).catch(() => ({ data: [] })),
    ]);
    const seenIds = new Set();
    const all = [];
    for (const d of [...orgDocs.data, ...userDocs.data]) {
      if (!seenIds.has(d.id)) { seenIds.add(d.id); all.push(d); }
    }

    const cache = Object.fromEntries(
      db.prepare('SELECT document_id, extracted FROM contract_cache').all()
        .map(c => [c.document_id, JSON.parse(c.extracted||'null')])
    );

    // Normalização pro UPPERCASE sem acento
    const stripAccent = s => String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'');
    const toUpperNoAccent = s => stripAccent(String(s||'')).toUpperCase().replace(/\s+/g,' ').trim();
    const slug = s => stripAccent(String(s||'')).toLowerCase().replace(/[^a-z0-9]/g,'');

    // Verifica se é nome de condomínio real
    const isCondoName = n => {
      const s = toUpperNoAccent(n);
      if (!s) return false;
      if (/FERIAS|REGISTRO\s*BR|REGISTROBR|^TESTE|MINUTA|CANCELAMENTO|^APENAS|PROPOSTA\s*MODELO/i.test(s)) return false;
      // Precisa ter keyword típica de condomínio
      return /CONDOMINIO|EDIFICIO|RESIDENCIAL|EDILICIO|CONJUNTO|HABITAT|HELBOR|BRERA|CYRELA|VIBRA|VIVAZ|VIVA\s*BENX|VIVABENX|METROCASA|THERA|SAMPA|TERRACO|SKY\s|URBAN|NYC|BENX|NOW|VIEW\s|STATION|STUDIO|MAX\s|MOOV|ARIZONA|TURIASSU|UPPER|BORGES|CUPECE|VILL[AE]|PARK|HOUSE|HOUX|HELLO|FLOR\s+DE|JARDIM|SALE|HOME\s|JARDINS|ATLANTICO|ALPHA|ALEGRO|MARROCOS|EXALT|IBIRAPUERA|PERDIZES|CIDADE|OLIMPIA|GUILHERMINA|LUMIS|WELCONX|DOMUS|TANGARA|ASSUMIRA|PAULICEIA|GOLDEN|PALACETE|STUDIOS|CAMBUCI|BOM\s*FIM|DONA\s*LINDU|GRAVURA|APLAUSO|CAMINHO|PORTAL|CASA\s|VN\s|NUN\s|DOT\s|VIVA\s+BENX|APICE|BUTANTA|CONCEIC[AO]ES|CONCEICAO|ONZE\s|SANTA\s|TUCUNA|MUNDO\s+APTO|LAST|ALL\s|PORTO|MERITO|MOEMA|ALPHAVIEW|N\s*URBAN|NEX\s*ONE|SAINT|SERENO|ZOOM|GIGRAN|MARE\s+ALTA|MISTRAL|COMPOSITE|INNOVA|TODAY|CORAZ|UPSIDE|ATMOSFERA|UPTOWN|ESTILO\s+BARROCO|VIVART|FACTO|ESQUINA|BENX\s*II|DEZ\s|NOVO\s|HELLO|METRO\s+CASA|MODERN|AMBIENCE|CYRELA\s+FOR|SIDE|FOR\s+LIFE|FOR\s+YOU|FOR\s+CONSOLAC|PRIME|HELBOR|CAPOTE|OSCAR|CASA\s+ALVARO|CHACARA|CHACRA|VILA\s|RAIZES|FAMILIA|TSS|CYRELLA|PIAZZA|VIEW|CLUBE|ROOKIE|BALIMC/i.test(s);
    };

    // Contratante assinou? (signatário que não é @lavandery / @inova)
    const LAVANDERY_EMAIL_RE = /@(lavandery|inovalavandery|inovatec|inova\.)|\.lavandery\./i;
    function contratanteSigned(doc) {
      if (!doc.signatures || !doc.signatures.length) return null;
      for (const s of doc.signatures) {
        if (!s.signed || !s.signed.created_at) continue;
        if (s.email && LAVANDERY_EMAIL_RE.test(s.email)) continue;
        // Este é o contratante e assinou
        return s.signed.created_at;
      }
      return null;
    }

    // 2) Classifica candidatos
    const NOV_2025 = new Date('2025-11-01T00:00:00Z').getTime();
    const candidates = [];
    for (const doc of all) {
      const ext = cache[doc.id] || {};
      // Nome primário = extraído do PDF (CONTRATANTE), fallback = doc.name
      const rawName = (ext.name && ext.name.trim()) || doc.name || '';
      if (!isCondoName(rawName)) continue;
      const signedAt = contratanteSigned(doc);
      if (!signedAt) continue;
      const signedTs = new Date(signedAt).getTime();
      const cleanedName = toUpperNoAccent(rawName)
        .replace(/^CONTRATO[-\s_]+(COMODATO|GESTAO|GESTÃO|SERVICO|SERVIÇO)[-\s_]+/i,'')
        .replace(/^CONTRATO[-\s_]+/i,'')
        .replace(/\s*\(\d+\)\s*$/g,'')
        .replace(/\s+(ATUALIZADO|VER\.?\s*\d+|REV\.?\s*\d+).*$/i,'')
        .replace(/\s+/g,' ').trim();
      candidates.push({
        doc, ext, name: cleanedName, key: slug(cleanedName),
        signedAt: signedTs,
        implanted: signedTs < NOV_2025,
      });
    }

    // 3) Dedup por slug — mantém o mais antigo (primeira assinatura)
    const byKey = new Map();
    for (const c of candidates) {
      if (!c.key) continue;
      const prev = byKey.get(c.key);
      if (!prev || c.signedAt < prev.signedAt) byKey.set(c.key, c);
    }
    const finalList = [...byKey.values()];

    // 4) Upsert condos
    const upsertCondo = db.prepare(`INSERT INTO condominiums
      (id,name,address,city,cep,cnpj,washers,dryers,contract_source,autentique_doc_id,maintenance_interval_months,maintenance_label,is_contract,contract_sign_date)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, autentique_doc_id=excluded.autentique_doc_id,
        contract_sign_date=excluded.contract_sign_date,
        address=COALESCE(excluded.address, condominiums.address),
        city=COALESCE(excluded.city, condominiums.city),
        cep=COALESCE(excluded.cep, condominiums.cep),
        cnpj=COALESCE(excluded.cnpj, condominiums.cnpj)`);
    const insMachine = db.prepare(`INSERT OR IGNORE INTO machines (id,condo_id,code,type,brand,capacity) VALUES (?,?,?,?,?,?)`);
    const insImpl = db.prepare(`INSERT OR REPLACE INTO implantations (id, condo_id, status, target_date, started_at, completed_at, contract_signed_at)
      VALUES (?,?,?,?,?,?,?)`);

    let imported = 0, markedImplanted = 0, markedPending = 0;
    for (const c of finalList) {
      const id = 'c_' + c.key.slice(0, 28);
      const ext = c.ext;
      const w = ext.washers|0, d = ext.dryers|0;
      const freq = ext.maintenance?.intervalMonths || null;
      const label = ext.maintenance?.label || null;
      const signDateStr = new Date(c.signedAt).toISOString().slice(0,10);
      upsertCondo.run(id, c.name, ext.address||'', ext.city||'', ext.cep||null, ext.cnpj||null,
        w, d, 'autentique', c.doc.id, freq, label, signDateStr);
      for (let i=1;i<=w;i++) insMachine.run(`${id}_lvd${i}`, id, `LVD-${String(i).padStart(3,'0')}`, 'Lavadora', '', '');
      for (let i=1;i<=d;i++) insMachine.run(`${id}_scr${i}`, id, `SCR-${String(i).padStart(3,'0')}`, 'Secadora', '', '');

      // Cria implantação: concluída (antes de nov/2025) ou em_andamento (a partir de nov/2025)
      const implId = 'impl_' + id;
      const target = new Date(c.signedAt + 60*86400_000).toISOString().slice(0,10); // SLA 60d
      if (c.implanted) {
        insImpl.run(implId, id, 'concluida', target, c.signedAt, c.signedAt + 30*86400_000, c.signedAt);
        markedImplanted++;
      } else {
        insImpl.run(implId, id, 'agendada', target, null, null, c.signedAt);
        markedPending++;
      }
      imported++;
    }

    res.json({
      ok:true,
      total_contracts: all.length,
      signed_contratante: candidates.length,
      unique_condos: finalList.length,
      imported,
      implanted_pre_nov2025: markedImplanted,
      pending_from_nov2025: markedPending,
    });
  } catch (e) {
    console.error('[auto-import-signed]', e);
    res.status(500).json({ error:'import_failed', detail: String(e.message||e) });
  }
});

app.post('/api/condominiums/import', (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: 'no_items' });
  const upsertCondo = db.prepare(`INSERT INTO condominiums (id,name,address,city,cep,cnpj,washers,dryers,contract_source,autentique_doc_id,maintenance_interval_months,maintenance_label,is_contract)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,address=excluded.address,city=excluded.city,cep=excluded.cep,cnpj=excluded.cnpj,washers=excluded.washers,dryers=excluded.dryers,autentique_doc_id=excluded.autentique_doc_id,maintenance_interval_months=excluded.maintenance_interval_months,maintenance_label=excluded.maintenance_label,is_contract=excluded.is_contract`);
  const insertMachine = db.prepare(`INSERT OR IGNORE INTO machines (id,condo_id,code,type,brand,capacity) VALUES (?,?,?,?,?,?)`);
  const tx = db.transaction(() => {
    for (const it of items) {
      const id = it.id || ('c_' + Math.random().toString(36).slice(2,10));
      upsertCondo.run(id, it.name||'Condomínio', it.address||'', it.city||'', it.cep||null, it.cnpj||null,
        it.washers|0, it.dryers|0, 'autentique', it.autentique_doc_id||null,
        Number.isInteger(it.maintenance_interval_months)?it.maintenance_interval_months:null,
        it.maintenance_label||null,
        it.is_contract===false ? 0 : 1);
      // Auto-cria implantação se este condo veio de um contrato Autentique
      if (it.is_contract !== false && it.autentique_doc_id) {
        const cachedDoc = db.prepare('SELECT created_at FROM contract_cache WHERE document_id=?').get(it.autentique_doc_id);
        const signedAt = cachedDoc?.created_at ? new Date(cachedDoc.created_at).getTime() : null;
        try { createImplantationForCondo(id, { contractSignedAt: signedAt }); } catch(e) { /* já existe ou falha silenciosa */ }
      }
      // Seed machine stubs (LVD-001.., SCR-001..)
      for (let i=1; i<=(it.washers|0); i++) insertMachine.run(`${id}_lvd${i}`, id, `LVD-${String(i).padStart(3,'0')}`, 'Lavadora', '', '');
      for (let i=1; i<=(it.dryers|0); i++) insertMachine.run(`${id}_scr${i}`, id, `SCR-${String(i).padStart(3,'0')}`, 'Secadora', '', '');
    }
  });
  tx();
  res.json({ ok: true, imported: items.length });
});

// One-shot: relê contract_cache e atualiza nomes dos condos com o CONTRATANTE extraído
app.post('/api/condominiums/refresh-names', (req, res) => {
  const cleanName = (n) => {
    if (!n) return null;
    let s = String(n).trim();
    // Remove prefixos comuns
    s = s.replace(/^contrato[-\s_]+comodato[-\s_]+/i, '')
         .replace(/\s*\(\d+\)\s*$/g, '').trim();
    // Title case Unicode-aware (split por espaços, capitaliza primeira letra de cada palavra)
    s = s.toLowerCase().split(/\s+/).map(w => {
      if (!w) return w;
      // primeira letra (mesmo se for acentuada) maiúscula, resto minúsculo
      return w.charAt(0).toLocaleUpperCase('pt-BR') + w.slice(1);
    }).join(' ');
    // Preposições/artigos minúsculos no meio
    s = s.replace(/(\s)(De|Da|Do|Dos|Das|E|Em|Na|No)(?=\s)/g, (_,sp,w) => sp + w.toLowerCase());
    // Siglas comuns SEMPRE em caixa alta (BY EZ, SP, RJ, etc)
    s = s.replace(/\bBy\b/g, 'BY').replace(/\bEz\b/g, 'EZ');
    // Primeira letra sempre maiúscula
    s = s.charAt(0).toLocaleUpperCase('pt-BR') + s.slice(1);
    return s.trim();
  };
  const rows = db.prepare(`SELECT c.id, c.name as old_name, cc.extracted
    FROM condominiums c
    JOIN contract_cache cc ON cc.document_id = c.autentique_doc_id
    WHERE c.autentique_doc_id IS NOT NULL`).all();
  const upd = db.prepare('UPDATE condominiums SET name=? WHERE id=?');
  const out = [];
  const tx = db.transaction(() => {
    for (const r of rows) {
      let extracted = null;
      try { extracted = JSON.parse(r.extracted||'null'); } catch {}
      const newName = cleanName(extracted?.name);
      if (newName && newName !== r.old_name) {
        upd.run(newName, r.id);
        out.push({ id: r.id, from: r.old_name, to: newName });
      }
    }
  });
  tx();
  res.json({ updated: out.length, samples: out.slice(0, 10) });
});

// ----- Autentique tracking table -----
db.exec(`CREATE TABLE IF NOT EXISTS autentique_docs (
  visit_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  name TEXT,
  status TEXT,              -- sent | viewed | signed | rejected
  tech_link TEXT,
  responsible_link TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now')*1000),
  raw TEXT
);`);

// Send visit PDF to Autentique
app.post('/api/visits/:id/autentique', async (req, res) => {
  try {
    const { pdfBase64, name, signers } = req.body || {};
    if (!pdfBase64 || !Array.isArray(signers) || signers.length === 0) {
      return res.status(400).json({ error: 'missing_fields' });
    }
    const buf = Buffer.from(pdfBase64.replace(/^data:.*;base64,/, ''), 'base64');
    const doc = await sendDocumentForSignature({
      name: name || `Relatório ${req.params.id}`,
      pdfBuffer: buf,
      signers: signers.filter(s => s.email && s.name),
    });
    const tech = doc.signatures.find(s => signers[0] && s.email === signers[0].email);
    const resp = doc.signatures.find(s => signers[1] && s.email === signers[1].email);
    db.prepare(`INSERT INTO autentique_docs (visit_id,document_id,name,status,tech_link,responsible_link,raw)
                VALUES (?,?,?,?,?,?,?)
                ON CONFLICT(visit_id) DO UPDATE SET document_id=excluded.document_id, status=excluded.status,
                  tech_link=excluded.tech_link, responsible_link=excluded.responsible_link, raw=excluded.raw`)
      .run(req.params.id, doc.id, doc.name, 'sent', tech?.link?.short_link || null, resp?.link?.short_link || null, JSON.stringify(doc));
    res.json({ ok: true, document: doc });
  } catch (e) {
    console.error('[autentique]', e);
    res.status(500).json({ error: 'autentique_failed', detail: String(e.message||e) });
  }
});

app.get('/api/visits/:id/autentique', async (req, res) => {
  const row = db.prepare('SELECT * FROM autentique_docs WHERE visit_id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  try {
    const live = await getDocument(row.document_id);
    res.json({ ...row, live });
  } catch (e) { res.json(row); }
});

// Webhook (optional — configure in Autentique dashboard pointing here)
app.post('/api/autentique/webhook', (req, res) => {
  const body = req.body || {};
  const docId = body?.document?.id || body?.data?.document?.id;
  if (docId) {
    const signed = body?.data?.event === 'signature.signed' || body?.event === 'signature.signed';
    const rejected = body?.data?.event === 'signature.rejected';
    const status = rejected ? 'rejected' : signed ? 'signed' : 'viewed';
    db.prepare('UPDATE autentique_docs SET status=? WHERE document_id=?').run(status, docId);
  }
  res.json({ ok: true });
});

// ---------- Agenda Geral (integração Google Calendar + Microsoft via iCal) ----------
// GET /api/calendar/events?from=YYYY-MM-DD&to=YYYY-MM-DD
// Lê URLs configuradas em integrations.calendar_feeds.urls (CSV) e retorna eventos unificados.
app.get('/api/calendar/events', async (req, res) => {
  const cfg = getIntegration('calendar_feeds');
  const urlsRaw = (cfg?.urls || process.env.CAL_FEEDS || '').toString();
  // Inclui também visitas internas (manutenções) como eventos se quiser unificar
  const urls = urlsRaw.split(/[,\n]/).map(s=>s.trim()).filter(Boolean);
  const { events, errors } = await fetchCalendars(urls, { from: req.query.from, to: req.query.to });

  // Opcionalmente injeta eventos internos (visitas agendadas + implantações + entregas)
  const extras = [];
  if (req.query.include_internal !== '0') {
    const fromD = req.query.from || new Date().toISOString().slice(0,10);
    const toD = req.query.to || new Date(Date.now()+60*864e5).toISOString().slice(0,10);
    const visits = db.prepare(`SELECT s.id, s.date, s.scheduled_time, s.type, c.name as condo, t.name as tech
      FROM visits_schedule s LEFT JOIN condominiums c ON c.id=s.condo_id LEFT JOIN technicians t ON t.id=s.technician_id
      WHERE s.date BETWEEN ? AND ?`).all(fromD, toD);
    visits.forEach(v => extras.push({
      uid: 'visit-'+v.id, provider: 'internal', source: 'Manutenções',
      title: `🔧 ${v.type||'Manutenção'} · ${v.condo||'—'}`,
      location: v.tech ? 'Técnico: '+v.tech : '',
      start: new Date(`${v.date}T${v.scheduled_time||'09:00'}:00`).toISOString(),
      end: new Date(`${v.date}T${(v.scheduled_time||'09:00')}:00`).toISOString(),
    }));
  }

  res.json({ events: [...events, ...extras], errors, urls_configured: urls.length });
});

// ---------- Feed público .ics (Outlook/Google subscrevem) ----------
// Protegido por token simples (integrations.calendar_export.token)
function icsEscape(s) {
  return String(s||'').replace(/\\/g,'\\\\').replace(/\n/g,'\\n').replace(/,/g,'\\,').replace(/;/g,'\\;');
}
function icsDate(iso) {
  // 2026-04-18T13:00:00.000Z → 20260418T130000Z
  const d = new Date(iso);
  const p = n => String(n).padStart(2,'0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth()+1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}
app.get('/api/public/calendar.ics', (req, res) => {
  const cfg = getIntegration('calendar_export') || {};
  const token = cfg.token || process.env.CAL_EXPORT_TOKEN;
  if (token && req.query.token !== token) return res.status(401).send('Invalid token');

  const rows = db.prepare(`SELECT s.id, s.date, s.scheduled_time, s.type,
      c.name as condo, c.address as address, t.name as tech
    FROM visits_schedule s
    LEFT JOIN condominiums c ON c.id=s.condo_id
    LEFT JOIN technicians t ON t.id=s.technician_id
    WHERE s.date >= date('now','-30 days') AND s.date <= date('now','+365 days')
    ORDER BY s.date`).all();

  const now = icsDate(new Date().toISOString());
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Lavandery//Manutencoes//PT-BR',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Lavandery - Manutenções',
    'X-WR-TIMEZONE:America/Sao_Paulo',
  ];
  for (const v of rows) {
    const time = v.scheduled_time || '09:00';
    // Considerar horário local (America/Sao_Paulo = UTC-3) → converter para UTC somando 3h
    const startLocal = new Date(`${v.date}T${time}:00-03:00`);
    const endLocal = new Date(startLocal.getTime() + 60*60*1000); // 1h default
    lines.push(
      'BEGIN:VEVENT',
      `UID:visit-${v.id}@lavandery`,
      `DTSTAMP:${now}`,
      `DTSTART:${icsDate(startLocal.toISOString())}`,
      `DTEND:${icsDate(endLocal.toISOString())}`,
      `SUMMARY:${icsEscape(`🔧 ${v.type||'Manutenção'} · ${v.condo||'—'}`)}`,
      `DESCRIPTION:${icsEscape(`Técnico: ${v.tech||'—'}\nCondomínio: ${v.condo||'—'}`)}`,
      `LOCATION:${icsEscape(v.address||'')}`,
      'END:VEVENT'
    );
  }
  lines.push('END:VCALENDAR');
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline; filename="lavandery.ics"');
  res.send(lines.join('\r\n'));
});

// ---------- Central de Alertas ----------
db.exec(`CREATE TABLE IF NOT EXISTS alerts_fired (
  id TEXT PRIMARY KEY,
  severity TEXT,
  first_seen INTEGER DEFAULT (strftime('%s','now')*1000),
  last_notified INTEGER,
  email_sent INTEGER DEFAULT 0,
  wa_sent INTEGER DEFAULT 0,
  ack_at INTEGER
);`);

async function dispatchAlertNotifications(alerts) {
  const contacts = getIntegration('admin_contacts') || {};
  const emails = (contacts.emails || contacts.email || '').split(',').map(s=>s.trim()).filter(Boolean);
  const phones = (contacts.phones || contacts.phone || '').split(',').map(s=>s.trim()).filter(Boolean);
  const escalationMinutes = parseInt(contacts.escalation_minutes||'0', 10) || 0; // 0 = one-shot

  for (const a of alerts) {
    if (a.severity === 'info') continue; // só dispara coisa importante
    const row = db.prepare('SELECT * FROM alerts_fired WHERE id=?').get(a.id);
    const now = Date.now();
    const isNew = !row;
    const shouldEscalate = row && !row.ack_at && escalationMinutes > 0 &&
      (!row.last_notified || (now - row.last_notified) > escalationMinutes*60000) &&
      a.severity === 'critical';
    if (!isNew && !shouldEscalate) continue;

    const subject = `🚨 Lavandery · ${a.severity.toUpperCase()} · ${a.title}`;
    const body = `${a.title}\n${a.body}\n\n— Alerta automático do painel Lavandery.`;

    // Email (para todos os admins cadastrados)
    let emailSent = 0;
    for (const to of emails) {
      try {
        const r = await sendEmail({ to, subject, text: body }, getIntegration);
        if (r.sent) emailSent++;
      } catch {}
    }
    // WhatsApp (para todos os telefones)
    let waSent = 0;
    for (const phone of phones) {
      try {
        const r = await waSendText({ phone, message: body });
        if (r.sent) waSent++;
      } catch {}
    }

    if (isNew) {
      db.prepare(`INSERT INTO alerts_fired (id,severity,last_notified,email_sent,wa_sent) VALUES (?,?,?,?,?)`)
        .run(a.id, a.severity, now, emailSent, waSent);
    } else {
      db.prepare(`UPDATE alerts_fired SET last_notified=?, email_sent=email_sent+?, wa_sent=wa_sent+? WHERE id=?`)
        .run(now, emailSent, waSent, a.id);
    }
  }
  // Clean-up: remove alerts_fired rows that are no longer active (so they can refire if recur)
  const activeIds = new Set(alerts.map(a=>a.id));
  const oldRows = db.prepare('SELECT id FROM alerts_fired').all();
  for (const r of oldRows) if (!activeIds.has(r.id)) db.prepare('DELETE FROM alerts_fired WHERE id=?').run(r.id);
}

app.post('/api/alerts/:id/ack', (req,res) => {
  db.prepare('UPDATE alerts_fired SET ack_at=? WHERE id=?').run(Date.now(), req.params.id);
  res.json({ ok:true });
});
app.post('/api/alerts/ack-all', (_req, res) => {
  const r = db.prepare('UPDATE alerts_fired SET ack_at=? WHERE ack_at IS NULL').run(Date.now());
  res.json({ ok:true, acked: r.changes });
});

// ---------- Central de Alertas ----------
// Agrega TUDO que precisa de atenção: insumos urgentes, chamados abertos, visitas de hoje.
app.get('/api/alerts', async (_req, res) => {
  const alerts = [];
  const today = new Date().toISOString().slice(0,10);

  const condos = db.prepare('SELECT * FROM condominiums WHERE is_contract=1').all();
  condos.forEach(c => {
    const f = forecastCondo(c);
    const worst = Math.min(f.soap.days_left, f.softener.days_left);
    if (worst <= 12) {
      const which = f.soap.days_left < f.softener.days_left ? 'soap' : 'softener';
      const prod = which === 'soap' ? 'sabão' : 'amaciante';
      alerts.push({
        id: `sup-${c.id}-${which}`,
        type: 'supply',
        severity: worst <= 5 ? 'critical' : worst <= 8 ? 'high' : 'medium',
        title: `${c.name}`,
        body: `${prod} acaba em ${worst} dia${worst!==1?'s':''} — ${f[which].gallons_on_site.toFixed(1)} gal no local`,
        action_tab: 'supplies',
        action_id: c.id,
        ts: Date.now() - (30-worst)*60000,
      });
    }
  });

  const tickets = db.prepare(`SELECT t.*, c.name as condo_name FROM tickets t LEFT JOIN condominiums c ON c.id=t.condo_id
    WHERE t.status IN ('aberto','em_andamento') ORDER BY
      CASE t.priority WHEN 'urgente' THEN 1 WHEN 'alta' THEN 2 WHEN 'media' THEN 3 ELSE 4 END,
      t.created_at DESC LIMIT 30`).all();
  tickets.forEach(t => {
    alerts.push({
      id: `tkt-${t.id}`,
      type: 'ticket',
      severity: t.priority === 'urgente' ? 'critical' : t.priority === 'alta' ? 'high' : 'medium',
      title: t.title,
      body: `${t.condo_name||'—'} · ${t.status === 'aberto' ? 'aberto' : 'em andamento'} · ${t.priority}`,
      action_tab: 'tickets',
      action_id: t.id,
      ts: t.created_at,
    });
  });

  // 3b) Implantações atrasadas ou pendentes próximas do prazo
  const implRows = db.prepare(`SELECT i.*, c.name as condo_name,
      (SELECT COUNT(*) FROM implantation_steps WHERE implantation_id=i.id) total,
      (SELECT COUNT(*) FROM implantation_steps WHERE implantation_id=i.id AND completed=1) done
    FROM implantations i LEFT JOIN condominiums c ON c.id=i.condo_id
    WHERE i.status IN ('agendada','em_andamento')`).all();
  implRows.forEach(i => {
    if (!i.target_date) return;
    const target = new Date(i.target_date+'T00:00:00').getTime();
    const diffDays = Math.round((target - Date.now()) / 864e5);
    const pct = i.total ? Math.round((i.done/i.total)*100) : 0;
    const name = i.condo_name||'—';
    // Regras SLA: atrasado / 0 dias / 7 dias / 15 dias
    if (diffDays < 0) {
      alerts.push({ id:`imp-${i.id}`, type:'implantation', severity:'critical',
        title:`🚨 Implantação ATRASADA · ${name}`,
        body:`Prazo era ${new Date(target).toLocaleDateString('pt-BR')} · ${pct}% concluído · ${Math.abs(diffDays)}d de atraso`,
        action_tab:'implantations', action_id:i.id, ts:target });
    } else if (diffDays === 0) {
      alerts.push({ id:`imp-${i.id}`, type:'implantation', severity:'critical',
        title:`Implantação VENCE HOJE · ${name}`, body:`${pct}% concluído (${i.done}/${i.total} passos)`, action_tab:'implantations', action_id:i.id, ts:target });
    } else if (diffDays <= 7) {
      alerts.push({ id:`imp-${i.id}`, type:'implantation', severity:'high',
        title:`Implantação em ${diffDays}d · ${name}`, body:`SLA de 60 dias acabando · ${pct}% concluído`, action_tab:'implantations', action_id:i.id, ts:target });
    } else if (diffDays <= 15) {
      alerts.push({ id:`imp-${i.id}`, type:'implantation', severity:'medium',
        title:`Implantação em ${diffDays}d · ${name}`, body:`Aproximando do prazo · ${pct}% concluído`, action_tab:'implantations', action_id:i.id, ts:target });
    }
  });

  const todayVisits = db.prepare(`SELECT s.*, c.name as condo_name, t.name as tech_name FROM visits_schedule s
    LEFT JOIN condominiums c ON c.id=s.condo_id
    LEFT JOIN technicians t ON t.id=s.technician_id
    WHERE s.date=? ORDER BY s.scheduled_time`).all(today);
  todayVisits.forEach(v => {
    alerts.push({
      id: `vis-${v.id}`,
      type: 'visit',
      severity: 'info',
      title: `Visita hoje · ${v.condo_name||'—'}`,
      body: `${v.scheduled_time||'09:00'} · ${v.tech_name||'sem técnico'}`,
      action_tab: 'schedule',
      ts: new Date(`${v.date}T${v.scheduled_time||'09:00'}:00`).getTime(),
    });
  });

  const sevOrder = { critical: 0, high: 1, medium: 2, info: 3 };
  alerts.sort((a,b) => (sevOrder[a.severity]-sevOrder[b.severity]) || (b.ts-a.ts));
  const counts = alerts.reduce((acc,a) => { acc[a.severity] = (acc[a.severity]||0)+1; return acc; }, {});
  counts.total = alerts.length;

  // Anota quais estão reconhecidos + fire notifications em background
  const ackMap = Object.fromEntries(db.prepare('SELECT id, ack_at FROM alerts_fired').all().map(r => [r.id, r.ack_at]));
  alerts.forEach(a => { a.ack_at = ackMap[a.id] || null; });

  res.json({ counts, alerts: alerts.slice(0, 50) });

  // Não bloqueia resposta
  dispatchAlertNotifications(alerts).catch(e => console.error('[alerts dispatch]', e));
});

// ----- Executive dashboard -----
app.get('/api/dashboard', (_, res) => {
  const year = new Date().getFullYear();
  const today = new Date().toISOString().slice(0,10);
  const in7 = new Date(Date.now()+7*864e5).toISOString().slice(0,10);
  const in30 = new Date(Date.now()+30*864e5).toISOString().slice(0,10);

  // Totals
  const totalCondos = db.prepare("SELECT COUNT(*) c FROM condominiums WHERE is_contract=1").get().c;
  const totalGeocoded = db.prepare("SELECT COUNT(*) c FROM condominiums WHERE is_contract=1 AND lat IS NOT NULL").get().c;
  const totalMachines = db.prepare("SELECT COUNT(*) c FROM machines").get().c;
  const totalWashers = db.prepare("SELECT SUM(washers) s FROM condominiums WHERE is_contract=1").get().s || 0;
  const totalDryers = db.prepare("SELECT SUM(dryers) s FROM condominiums WHERE is_contract=1").get().s || 0;

  // Schedule / visits
  const visitsYear = db.prepare("SELECT COUNT(*) c FROM visits_schedule WHERE date LIKE ?").get(`${year}-%`).c;
  const visitsNext7 = db.prepare("SELECT COUNT(*) c FROM visits_schedule WHERE date BETWEEN ? AND ?").get(today, in7).c;
  const visitsNext30 = db.prepare("SELECT COUNT(*) c FROM visits_schedule WHERE date BETWEEN ? AND ?").get(today, in30).c;
  const perMonth = db.prepare(`
    SELECT strftime('%m', date) as m, COUNT(*) as c
    FROM visits_schedule WHERE date LIKE ? GROUP BY m ORDER BY m`).all(`${year}-%`);
  const perTech = db.prepare(`
    SELECT t.name, COUNT(*) as c FROM visits_schedule s
    LEFT JOIN technicians t ON t.id=s.technician_id GROUP BY t.id`).all();

  // Supplies urgency (compute in JS using forecastCondo)
  const condos = db.prepare("SELECT * FROM condominiums WHERE is_contract=1").all();
  const supplyCounts = { urgente:0, atencao:0, planejar:0, ok:0 };
  condos.forEach(c => {
    const f = forecastCondo(c);
    const w = (f.soap.urgency === 'urgente' || f.softener.urgency === 'urgente') ? 'urgente'
            : (f.soap.urgency === 'atencao' || f.softener.urgency === 'atencao') ? 'atencao'
            : (f.soap.urgency === 'planejar' || f.softener.urgency === 'planejar') ? 'planejar' : 'ok';
    supplyCounts[w]++;
  });
  const deliveriesNext7 = Object.values(supplyCounts).reduce((n,_)=>n,0) && supplyCounts.urgente;

  // Tickets
  const ticketStatus = db.prepare(`SELECT status, COUNT(*) c FROM tickets GROUP BY status`).all();
  const ticketPriority = db.prepare(`SELECT priority, COUNT(*) c FROM tickets WHERE status IN ('aberto','em_andamento') GROUP BY priority`).all();
  const ticketsOpen = db.prepare(`SELECT COUNT(*) c FROM tickets WHERE status IN ('aberto','em_andamento')`).get().c;

  // Cities
  const cities = db.prepare(`
    SELECT city, COUNT(*) c FROM condominiums WHERE is_contract=1 AND city IS NOT NULL AND city != ''
    GROUP BY city ORDER BY c DESC LIMIT 8`).all();

  // Recent activity: last 10 tickets + last 10 deliveries
  const recentTickets = db.prepare(`
    SELECT t.id, t.title, t.priority, t.status, t.created_at, c.name as condo
    FROM tickets t LEFT JOIN condominiums c ON c.id=t.condo_id
    ORDER BY t.created_at DESC LIMIT 8`).all();
  const recentDeliveries = db.prepare(`
    SELECT d.id, d.product, d.gallons, d.delivered_at, c.name as condo
    FROM deliveries d LEFT JOIN condominiums c ON c.id=d.condo_id
    ORDER BY d.delivered_at DESC LIMIT 8`).all();

  res.json({
    year,
    totals: { condos: totalCondos, geocoded: totalGeocoded, machines: totalMachines, washers: totalWashers, dryers: totalDryers },
    visits: { year: visitsYear, next7: visitsNext7, next30: visitsNext30, perMonth, perTech },
    supplies: supplyCounts,
    tickets: { open: ticketsOpen, byStatus: ticketStatus, byPriority: ticketPriority },
    cities,
    recent: { tickets: recentTickets, deliveries: recentDeliveries },
  });
});

// ----- KPIs -----
app.get('/api/kpis', (_,res) => {
  const finalized = db.prepare("SELECT COUNT(*) c FROM visits WHERE status='finalized'").get().c;
  const failing = db.prepare("SELECT COUNT(*) c FROM visit_machines WHERE status='fail'").get().c;
  const avg = db.prepare("SELECT ROUND(AVG(score)) a FROM visits WHERE status='finalized'").get().a || 0;
  res.json({ visitsFinalized: finalized, machinesFailing: failing, avgScore: avg });
});

// ---------- Integrations admin API ----------
app.get('/api/integrations', (_req, res) => {
  const rows = db.prepare('SELECT key, enabled, updated_at FROM integrations').all();
  // Return keys + enabled, NEVER the secrets (masked)
  res.json(rows.map(r => {
    const v = getIntegration(r.key) || {};
    const masked = {};
    Object.entries(v).forEach(([k, val]) => {
      if (k === 'enabled') return;
      if (typeof val === 'string' && val.length > 8) masked[k] = val.slice(0,3) + '···' + val.slice(-3);
      else masked[k] = val;
    });
    return { key: r.key, enabled: !!r.enabled, updated_at: r.updated_at, preview: masked };
  }));
});

app.put('/api/integrations/:key', (req, res) => {
  const { value, enabled } = req.body || {};
  if (typeof value !== 'object') return res.status(400).json({ error: 'value_object_required' });
  db.prepare(`INSERT INTO integrations (key,value,enabled,updated_at) VALUES (?,?,?,?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value, enabled=excluded.enabled, updated_at=excluded.updated_at`)
    .run(req.params.key, JSON.stringify(value), enabled===false?0:1, Date.now());
  res.json({ ok: true });
});

app.delete('/api/integrations/:key', (req, res) => {
  db.prepare('DELETE FROM integrations WHERE key=?').run(req.params.key);
  res.json({ ok: true });
});

// ---------- WhatsApp (Baileys, no official API) ----------
app.get('/api/whatsapp/status', (_req, res) => res.json(waStatus()));
app.post('/api/whatsapp/connect', async (_req, res) => { try { res.json(await waConnect()); } catch(e) { res.status(500).json({ error:String(e.message||e) }); } });
app.post('/api/whatsapp/disconnect', async (req, res) => { try { res.json(await waDisconnect({ wipeSession: req.query.wipe==='1' })); } catch(e) { res.status(500).json({ error:String(e.message||e) }); } });
app.post('/api/whatsapp/send', async (req, res) => {
  const { phone, message } = req.body || {};
  if (!phone || !message) return res.status(400).json({ sent:false, reason:'missing_fields' });
  res.json(await waSendText({ phone, message }));
});

// ---------- Google Maps endpoints ----------
app.post('/api/integrations/google_maps/test', async (_req, res) => {
  const cfg = getIntegration('google_maps');
  res.json(await gmapsTest({ apiKey: cfg?.api_key }));
});
app.post('/api/maps/geocode', async (req, res) => {
  const cfg = getIntegration('google_maps');
  const { address } = req.body || {};
  res.json(await gmapsGeocode({ apiKey: cfg?.api_key, address }));
});
app.post('/api/maps/route', async (req, res) => {
  const cfg = getIntegration('google_maps');
  const { origin, destinations } = req.body || {};
  if (!origin || !destinations?.length) return res.status(400).json({ ok:false, reason:'missing_fields' });
  res.json(await gmapsRoute({ apiKey: cfg?.api_key, origin, destinations }));
});

// ---------- Google Drive endpoints (preferred) ----------
app.post('/api/integrations/gdrive/test', async (_req, res) => {
  const cfg = getIntegration('gdrive');
  res.json(await driveTest(cfg));
});

// Upload photo — local storage (prioridade), fallback Drive → Firebase
app.post('/api/uploads/photo', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  const visitId = (req.body?.visit_id || 'misc').replace(/[^\w-]/g, '').slice(0, 40);
  const tag = (req.body?.tag || 'foto').replace(/[^\w-]/g, '').slice(0, 30);
  const ext = (req.file.mimetype||'').split('/')[1]?.replace(/[^a-z0-9]/g,'').slice(0,4) || 'jpg';
  const filename = `${visitId}-${tag}-${Date.now()}-${Math.random().toString(36).slice(2,6)}.${ext}`;

  // 1) Tenta salvar local no disco persistente (/data/uploads em prod)
  try {
    const dir = path.join(UPLOADS_DIR, 'photos', visitId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), req.file.buffer);
    const url = `/uploads/photos/${visitId}/${filename}`;
    return res.json({ ok: true, provider: 'local', url, name: filename });
  } catch (e) { console.error('[upload] local failed, trying cloud:', e.message); }

  // 2) Fallback Google Drive
  const gdrive = getIntegration('gdrive');
  if (gdrive && (gdrive.folder_id || gdrive.service_account_json)) {
    try {
      const r = await driveUpload(gdrive, { name: filename, mimeType: req.file.mimetype || 'image/jpeg', body: req.file.buffer });
      return res.json({ ok: true, provider: 'gdrive', ...r });
    } catch (e) { console.error('[upload] gdrive failed:', e.message); }
  }

  // 3) Fallback Firebase
  const firebase = getIntegration('firebase');
  if (firebase) {
    try {
      const key = `visits/${visitId}/${filename}`;
      const r = await firebaseUpload(firebase, { key, body: req.file.buffer, contentType: req.file.mimetype || 'image/jpeg' });
      return res.json({ ok: true, provider: 'firebase', ...r });
    } catch (e) { console.error('[upload] firebase failed:', e.message); }
  }

  res.status(500).json({ error: 'all_backends_failed' });
});

// Backward-compat
app.post('/api/integrations/firebase/test', async (_req, res) => {
  const cfg = getIntegration('firebase');
  res.json(await firebaseTest(cfg));
});

// Kept for backward compat (if someone configures S3 instead)
app.post('/api/integrations/s3/test', async (_req, res) => {
  const cfg = getIntegration('s3');
  res.json(await s3Test(cfg));
});

// ---------- Moskit CRM ----------
// Cache server-side atualizado automaticamente a cada 30min
db.exec(`CREATE TABLE IF NOT EXISTS moskit_cache (
  kind TEXT PRIMARY KEY,
  data TEXT,
  synced_at INTEGER,
  error TEXT
);`);

async function moskitRefreshCache() {
  const cfg = getIntegration('moskit');
  if (!cfg?.api_key) return;
  const now = Date.now();
  const upsert = db.prepare('INSERT INTO moskit_cache (kind,data,synced_at,error) VALUES (?,?,?,?) ON CONFLICT(kind) DO UPDATE SET data=excluded.data, synced_at=excluded.synced_at, error=excluded.error');
  const kinds = [
    ['companies', () => moskitListCompanies(cfg, { limit: 500 })],
    ['contacts', () => moskitListContacts(cfg, { limit: 500 })],
    ['deals', () => moskitListDeals(cfg, { limit: 500 })],
    ['activities', () => moskitListActivities(cfg, { limit: 500 })],
    ['pipelines', () => moskitListPipelines(cfg)],
    ['users', () => moskitListUsers(cfg)],
  ];
  for (const [kind, fn] of kinds) {
    try {
      const data = await fn();
      upsert.run(kind, JSON.stringify(data), now, null);
      await new Promise(r => setTimeout(r, 150));
    } catch (e) {
      upsert.run(kind, null, now, String(e.message || e));
    }
  }
}
function moskitCacheGet(kind) {
  const row = db.prepare('SELECT data, synced_at, error FROM moskit_cache WHERE kind=?').get(kind);
  if (!row) return { data: null, synced_at: null, error: 'not_synced' };
  return { data: row.data ? JSON.parse(row.data) : null, synced_at: row.synced_at, error: row.error };
}
// Agenda refresh a cada 30min (produção) ou 5min (dev)
const MOSKIT_INTERVAL = (process.env.NODE_ENV === 'production' ? 30 : 5) * 60_000;
setInterval(() => moskitRefreshCache().catch(e => console.error('[moskit-cron]', e.message)), MOSKIT_INTERVAL);
// Refresh inicial 5s após start (dá tempo do DB subir)
setTimeout(() => moskitRefreshCache().catch(() => {}), 5000);

app.post('/api/integrations/moskit/test', async (_req, res) => {
  const cfg = getIntegration('moskit');
  const r = await moskitTest(cfg);
  if (r.ok) moskitRefreshCache().catch(() => {}); // dispara refresh ao salvar
  res.json(r);
});

// Força sincronização manual
app.post('/api/moskit/refresh', async (req, res) => {
  if (!req.user || !['admin','gestor'].includes(req.user.role)) return res.status(403).json({ error:'forbidden' });
  try {
    await moskitRefreshCache();
    res.json({ ok: true, synced_at: Date.now() });
  } catch (e) { res.status(500).json({ error: String(e.message||e) }); }
});

// Helper: responde com cache (rápido) e agenda refresh se cache velho (stale-while-revalidate)
function cacheHandler(kind) {
  return (req, res) => {
    if (!req.user || !['admin','gestor'].includes(req.user.role)) return res.status(403).json({ error:'forbidden' });
    const cached = moskitCacheGet(kind);
    // Se cache tem >30min, dispara refresh em background
    if (cached.synced_at && (Date.now() - cached.synced_at) > 30*60_000) {
      moskitRefreshCache().catch(() => {});
    }
    res.json({
      data: cached.data,
      synced_at: cached.synced_at,
      error: cached.error,
      stale: cached.synced_at ? (Date.now() - cached.synced_at) > 5*60_000 : true,
    });
  };
}

app.get('/api/moskit/companies', cacheHandler('companies'));
app.get('/api/moskit/contacts', cacheHandler('contacts'));
app.get('/api/moskit/deals', cacheHandler('deals'));
app.get('/api/moskit/activities', cacheHandler('activities'));
app.get('/api/moskit/pipelines', cacheHandler('pipelines'));
app.get('/api/moskit/users', cacheHandler('users'));

app.get('/api/moskit/stats', (req, res) => {
  if (!req.user || !['admin','gestor'].includes(req.user.role)) return res.status(403).json({ error:'forbidden' });
  const stats = {
    companies: moskitCacheGet('companies').data?.length || 0,
    contacts: moskitCacheGet('contacts').data?.length || 0,
    deals: moskitCacheGet('deals').data?.length || 0,
    activities: moskitCacheGet('activities').data?.length || 0,
    users: moskitCacheGet('users').data?.length || 0,
    synced_at: moskitCacheGet('companies').synced_at,
  };
  res.json(stats);
});

// Sincroniza 1 condomínio como empresa no Moskit
app.post('/api/moskit/sync-condo/:id', async (req, res) => {
  if (!req.user || !['admin','gestor'].includes(req.user.role)) return res.status(403).json({ error:'forbidden' });
  try {
    const c = db.prepare('SELECT * FROM condominiums WHERE id=?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'condo_not_found' });
    const r = await moskitUpsertCompany(getIntegration('moskit'), {
      name: c.name, cnpj: c.cnpj, address: c.address, city: c.city, cep: c.cep,
      email: c.contact_email,
      notes: `Sincronizado do sistema Lavandery · ${c.washers||0}L + ${c.dryers||0}S · ${c.maintenance_label||''}`,
    });
    res.json({ ok: true, moskit: r });
  } catch (e) { res.status(500).json({ error: String(e.message||e) }); }
});

// Sincroniza TODOS os condomínios
app.post('/api/moskit/sync-all-condos', async (req, res) => {
  if (!req.user || !['admin','gestor'].includes(req.user.role)) return res.status(403).json({ error:'forbidden' });
  try {
    const cfg = getIntegration('moskit');
    const condos = db.prepare('SELECT * FROM condominiums WHERE is_contract=1').all();
    let created = 0, updated = 0, failed = 0;
    const errs = [];
    for (const c of condos) {
      try {
        const r = await moskitUpsertCompany(cfg, {
          name: c.name, cnpj: c.cnpj, address: c.address, city: c.city, cep: c.cep,
          email: c.contact_email,
          notes: `Sincronizado do sistema Lavandery · ${c.washers||0}L + ${c.dryers||0}S`,
        });
        if (r.__action === 'created') created++; else updated++;
        await new Promise(r => setTimeout(r, 200)); // rate limit suave
      } catch (e) { failed++; errs.push({ condo: c.name, error: String(e.message||e) }); }
    }
    res.json({ ok: true, total: condos.length, created, updated, failed, errors: errs.slice(0,10) });
  } catch (e) { res.status(500).json({ error: String(e.message||e) }); }
});

// Cria atividade (chamado → activity) no Moskit automaticamente
app.post('/api/moskit/sync-ticket/:id', async (req, res) => {
  if (!req.user || !['admin','gestor'].includes(req.user.role)) return res.status(403).json({ error:'forbidden' });
  try {
    const cfg = getIntegration('moskit');
    const ticket = db.prepare('SELECT * FROM tickets WHERE id=?').get(req.params.id);
    if (!ticket) return res.status(404).json({ error: 'ticket_not_found' });
    const condo = db.prepare('SELECT * FROM condominiums WHERE id=?').get(ticket.condo_id);
    if (!condo) return res.status(404).json({ error: 'condo_not_found' });
    // Garante company no Moskit
    const company = await moskitUpsertCompany(cfg, { name: condo.name, cnpj: condo.cnpj });
    const act = await moskitCreateActivity(cfg, {
      type: 'TASK',
      comments: `[${ticket.priority}] ${ticket.title}\n\n${ticket.description||''}`,
      company_id: company.id,
    });
    res.json({ ok:true, activity: act, company });
  } catch (e) { res.status(500).json({ error: String(e.message||e) }); }
});

// ---------- Asaas endpoints ----------
app.post('/api/integrations/asaas/test', async (_req, res) => {
  const cfg = getIntegration('asaas');
  res.json(await asaasTest(cfg));
});
app.post('/api/asaas/customers/from-condo/:id', async (req, res) => {
  const cfg = getIntegration('asaas');
  const condo = db.prepare('SELECT * FROM condominiums WHERE id=?').get(req.params.id);
  if (!condo) return res.status(404).json({ error:'not_found' });
  const r = await asaasCreateCustomer(cfg, condo);
  res.status(r.ok?200:400).json(r);
});
app.post('/api/asaas/charges', async (req, res) => {
  const cfg = getIntegration('asaas');
  const { customer, value, dueDate, description, billingType } = req.body||{};
  if (!customer || !value || !dueDate) return res.status(400).json({ error:'missing_fields' });
  const r = await asaasCreateCharge(cfg, { customer, value, dueDate, description, billingType });
  res.status(r.ok?200:400).json(r);
});
app.get('/api/asaas/charges', async (req, res) => {
  const cfg = getIntegration('asaas');
  res.json(await asaasListCharges(cfg, { customer: req.query.customer }));
});

// ---------- Sentry endpoints ----------
app.post('/api/integrations/sentry/test', async (_req, res) => {
  const cfg = getIntegration('sentry');
  res.json(await sentryTest(cfg?.dsn));
});

app.post('/api/integrations/calendar_feeds/test', async (_req, res) => {
  const cfg = getIntegration('calendar_feeds');
  const urls = (cfg?.urls || '').split(/[,\n]/).map(s=>s.trim()).filter(Boolean);
  if (!urls.length) return res.json({ ok:false, reason:'no_urls' });
  const r = await fetchCalendars(urls, { from: new Date().toISOString().slice(0,10), to: new Date(Date.now()+30*864e5).toISOString().slice(0,10) });
  res.json({ ok: !r.errors.length, total: r.events.length, errors: r.errors });
});

// Test SMTP (Microsoft 365 friendly)
app.post('/api/integrations/smtp/test', async (req, res) => {
  const { to } = req.body || {};
  if (!to) return res.status(400).json({ sent: false, reason: 'missing_to' });
  const r = await sendEmail({
    to,
    subject: 'Lavandery · Teste de SMTP',
    text: 'Este é um e-mail de teste. Se você recebeu, o SMTP está funcionando 🎉',
  }, getIntegration);
  res.json(r);
});

// ---------- API tokens ----------
app.get('/api/tokens', (_req, res) => {
  const rows = db.prepare('SELECT id, name, scopes, last_used_at, created_at, SUBSTR(token,1,6)||"..."||SUBSTR(token,-4) as preview FROM api_tokens').all();
  res.json(rows);
});
app.post('/api/tokens', (req, res) => {
  const { name, scopes } = req.body || {};
  const token = 'lvk_' + crypto.randomBytes(24).toString('base64url');
  const id = 'tk_' + Math.random().toString(36).slice(2,10);
  db.prepare('INSERT INTO api_tokens (id,name,token,scopes) VALUES (?,?,?,?)').run(id, name||'default', token, JSON.stringify(scopes||['*']));
  res.json({ id, name, token, scopes: scopes||['*'] }); // token returned ONCE
});
app.delete('/api/tokens/:id', (req, res) => {
  db.prepare('DELETE FROM api_tokens WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// Bearer middleware for /api/v1/*
function requireBearer(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing_token' });
  const row = db.prepare('SELECT id, scopes FROM api_tokens WHERE token=?').get(token);
  if (!row) return res.status(401).json({ error: 'invalid_token' });
  db.prepare('UPDATE api_tokens SET last_used_at=? WHERE id=?').run(Date.now(), row.id);
  req.apiToken = row;
  next();
}

// ---------- Public API v1 (Bearer-protected, stable surface) ----------
app.get('/api/v1/condominiums', requireBearer, (_, res) => {
  const rows = db.prepare('SELECT id, slug, name, address, city, cep, cnpj, washers, dryers, lat, lng, maintenance_label FROM condominiums WHERE is_contract=1').all();
  res.json({ data: rows });
});
app.get('/api/v1/condominiums/:id', requireBearer, (req, res) => {
  const c = db.prepare('SELECT * FROM condominiums WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'not_found' });
  c.machines = db.prepare('SELECT * FROM machines WHERE condo_id=?').all(c.id);
  res.json(c);
});
app.get('/api/v1/tickets', requireBearer, (req, res) => {
  const { status, condo } = req.query;
  const where = [], args = [];
  if (status) { where.push('status=?'); args.push(status); }
  if (condo) { where.push('condo_id=?'); args.push(condo); }
  const sql = 'SELECT * FROM tickets' + (where.length?' WHERE '+where.join(' AND '):'') + ' ORDER BY created_at DESC LIMIT 500';
  res.json({ data: db.prepare(sql).all(...args) });
});
app.post('/api/v1/tickets', requireBearer, async (req, res) => {
  const { condo_id, title, description, category, priority, opened_by_name, opened_by_email, opened_by_phone } = req.body || {};
  if (!title || !condo_id) return res.status(400).json({ error: 'missing_fields' });
  const id = 'tkt_' + Math.random().toString(36).slice(2,11);
  db.prepare(`INSERT INTO tickets (id,condo_id,title,description,category,priority,opened_by_name,opened_by_email,opened_by_phone)
              VALUES (?,?,?,?,?,?,?,?,?)`).run(id, condo_id, title, description||null, category||'outro', priority||'media', opened_by_name||null, opened_by_email||null, opened_by_phone||null);
  emitEvent('ticket.created', { id, condo_id, title }).catch(()=>{});
  res.json({ ok: true, id });
});
app.get('/api/v1/schedule', requireBearer, (req, res) => {
  const { from, to, technician } = req.query;
  const where = [], args = [];
  if (from) { where.push('date>=?'); args.push(from); }
  if (to) { where.push('date<=?'); args.push(to); }
  if (technician) { where.push('technician_id=?'); args.push(technician); }
  const sql = `SELECT s.*, c.name as condo_name FROM visits_schedule s LEFT JOIN condominiums c ON c.id=s.condo_id`
    + (where.length?' WHERE '+where.join(' AND '):'') + ' ORDER BY date LIMIT 500';
  res.json({ data: db.prepare(sql).all(...args) });
});
app.get('/api/v1/supplies/forecast', requireBearer, (_req, res) => {
  const condos = db.prepare('SELECT * FROM condominiums WHERE is_contract=1').all();
  res.json({ data: condos.map(c => ({ id: c.id, name: c.name, ...forecastCondo(c) })) });
});

// ---------- Webhooks (outgoing subscriptions) ----------
app.get('/api/webhooks', (_req, res) => {
  res.json(db.prepare('SELECT * FROM webhook_subscriptions ORDER BY created_at DESC').all());
});
app.post('/api/webhooks', (req, res) => {
  const { url, secret, events, active } = req.body || {};
  if (!url) return res.status(400).json({ error:'url_required' });
  const id = 'whs_'+Math.random().toString(36).slice(2,10);
  db.prepare('INSERT INTO webhook_subscriptions (id,url,secret,events,active) VALUES (?,?,?,?,?)')
    .run(id, url, secret||crypto.randomBytes(16).toString('hex'), JSON.stringify(events||['*']), active===false?0:1);
  res.json({ ok:true, id });
});
app.patch('/api/webhooks/:id', (req,res) => {
  const b = req.body||{};
  db.prepare('UPDATE webhook_subscriptions SET url=COALESCE(?,url), secret=COALESCE(?,secret), events=COALESCE(?,events), active=COALESCE(?,active) WHERE id=?')
    .run(b.url, b.secret, b.events?JSON.stringify(b.events):null, b.active==null?null:(b.active?1:0), req.params.id);
  res.json({ ok:true });
});
app.delete('/api/webhooks/:id', (req,res) => {
  db.prepare('DELETE FROM webhook_subscriptions WHERE id=?').run(req.params.id);
  res.json({ ok:true });
});
app.get('/api/webhooks/:id/deliveries', (req,res) => {
  res.json(db.prepare('SELECT * FROM webhook_events WHERE subscription_id=? ORDER BY created_at DESC LIMIT 100').all(req.params.id));
});
app.post('/api/webhooks/:id/test', async (req,res) => {
  const s = db.prepare('SELECT * FROM webhook_subscriptions WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error:'not_found' });
  const body = JSON.stringify({ event:'webhook.test', payload:{ hello:'world' }, ts: Date.now() });
  try {
    const r = await fetch(s.url, { method:'POST', headers:{'Content-Type':'application/json','X-Lavandery-Signature':hmacSig(s.secret,body),'X-Lavandery-Event':'webhook.test'}, body });
    const txt = (await r.text()).slice(0,1000);
    db.prepare('INSERT INTO webhook_events (id,subscription_id,event,payload,response_status,response_body,direction) VALUES (?,?,?,?,?,?,?)').run('evt_'+Math.random().toString(36).slice(2,10), s.id, 'webhook.test', body, r.status, txt, 'out');
    res.json({ ok:r.ok, status:r.status, body: txt });
  } catch(e) { res.status(500).json({ error:'delivery_failed', detail: String(e.message||e) }); }
});

// Generic incoming webhook — stores payload + emits an event tagged `incoming.<source>`
app.post('/api/webhooks/incoming/:source', async (req,res) => {
  const id = 'evt_'+Math.random().toString(36).slice(2,10);
  const body = JSON.stringify(req.body||{});
  db.prepare('INSERT INTO webhook_events (id,event,payload,direction,source,response_status) VALUES (?,?,?,?,?,?)')
    .run(id, `incoming.${req.params.source}`, body, 'in', req.params.source, 200);
  emitEvent(`incoming.${req.params.source}`, req.body).catch(()=>{});
  res.json({ ok:true, id });
});

// Health endpoint (used by Docker/Render/Fly healthchecks)
app.get('/health', (_req, res) => {
  try {
    const r = db.prepare('SELECT 1 v').get();
    res.json({ ok: true, db: r.v === 1, uptime: process.uptime() });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message||e) }); }
});

// Global error handler (also forwards to Sentry when configured)
app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  sentryCapture(err).catch(()=>{});
  res.status(500).json({ error: 'internal_error', detail: err?.message||String(err) });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`[lavandery] API on http://localhost:${PORT} · db=${DB_PATH}`);
  waAutoStart().catch(e => console.error('[wa] autostart', e));
  // Init Sentry if DSN configured
  const sCfg = getIntegration('sentry');
  if (sCfg?.dsn) { await sentryInit(sCfg.dsn).catch(()=>{}); console.log('[sentry] initialized'); }
});
