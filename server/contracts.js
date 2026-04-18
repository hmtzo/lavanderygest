// Extract condo data from a Lavandery contract PDF (pt-BR).
// Strategy: slice the text to the CONTRATANTE block only, then extract.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

const CEP_RE = /\b(\d{5}-?\d{3})\b/;
const CNPJ_RE = /\b(\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2})\b/;
const CPF_RE = /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/;

const UF_RE = /(AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)/;
const CITY_UF_RE = new RegExp(`([A-ZÁ-Ú][\\wÁ-Úá-ú'\\s.-]{1,40})[\\s,/-]+${UF_RE.source}\\b`);

const NUM_WORDS = {
  'um':1,'uma':1,'dois':2,'duas':2,'três':3,'tres':3,'quatro':4,'cinco':5,
  'seis':6,'sete':7,'oito':8,'nove':9,'dez':10,'onze':11,'doze':12,
  'treze':13,'catorze':14,'quatorze':14,'quinze':15,'dezesseis':16,
  'dezessete':17,'dezoito':18,'dezenove':19,'vinte':20,
};

function clean(s) { return (s||'').replace(/\s+/g, ' ').trim(); }
function stripAccents(s){ return s.normalize('NFD').replace(/\p{Diacritic}/gu,''); }

function numFromTokenLower(tok) {
  if (!tok) return null;
  if (/^\d+$/.test(tok)) return parseInt(tok,10);
  const k = stripAccents(tok.toLowerCase());
  return NUM_WORDS[k] ?? null;
}

// Known Lavandery (CONTRATADA) fingerprints — we reject these if extracted
const LAVANDERY = {
  cnpj: '45.061.358/0001-62',
  cep: '06515-240',
  city: /santana\s+de\s+parna[íi]ba/i,
  address: /(rua\s+calif[óo]rnia(?:,\s*40)?)|inova\s+tecnologia/i,
};

// Strip the CONTRATADA block so we never read its address/city/CEP/CNPJ.
// Then return the CONTRATANTE block specifically.
function contratanteBlock(rawText) {
  // Normalize whitespace for block detection (keep a copy)
  let text = rawText;

  // Remove everything from "CONTRATADA:" up to (but not including) "CONTRATANTE:"
  // Supports both "CONTRATADA:" and "CONTRATADA " variants.
  text = text.replace(/CONTRATAD[AO][:\s]+[\s\S]+?(?=CONTRATANTE[:\s])/i, ' ');

  // Now extract after CONTRATANTE until a natural boundary
  const m = text.match(/CONTRATANTE[:\s]+([\s\S]+?)(?=\n\s*(?:As\s+partes|CL[ÁA]USULA|TESTEMUNHAS|1\.\s*DO\s+OBJETO|\bCONTRATAD[AO]\b))/i);
  let block = m ? m[1] : '';

  // Safety: if the block still contains Lavandery fingerprints, strip those sentences
  if (block) {
    block = block
      .split(/(?<=[.;])\s+/)
      .filter(sentence => !LAVANDERY.city.test(sentence) && !LAVANDERY.address.test(sentence) && !sentence.includes(LAVANDERY.cnpj) && !sentence.includes(LAVANDERY.cep))
      .join(' ');
  }
  return block;
}

const BAD_NAME_RE = /que\s+(receber[áa]|possui|adquir)|maquin[áa]rio|equipamento|se\s+compromete|a\s+ser\s+definid|do\s+im[óo]vel/i;

function cleanName(raw) {
  if (!raw) return null;
  let s = clean(raw);
  // Cut at common contract-body tokens
  s = s.split(/\s+(?:situad[oa]|inscrito|neste\s+ato|CNPJ|CEP|,)/)[0];
  s = s.replace(/\s*[.,;:]+$/,'').trim();
  if (s.length < 4 || s.length > 100) return null;
  if (BAD_NAME_RE.test(s)) return null;
  return s;
}

function nameFromDoc(docName) {
  if (!docName) return null;
  let s = docName
    .replace(/^\s*Contrato[\s-_]*Comodato[\s-_]*/i, '')
    .replace(/\s*\(\d+\)\s*$/,'')
    .replace(/[-_]+/g,' ')
    .replace(/\s+/g,' ')
    .trim();
  return s || null;
}

function extractName(block, docName, fullText) {
  // 1) Strong match inside CONTRATANTE block
  let m = block.match(/(CONDOM[ÍI]NIO|EDIF[ÍI]CIO|RESIDENCIAL)\s+([^\n,]{2,80})/i);
  if (m) {
    const name = cleanName(`${m[1]} ${m[2]}`);
    if (name) return name;
  }
  // 2) Same pattern but scanning full text (sometimes CONTRATANTE label missing)
  if (fullText) {
    for (const mm of fullText.matchAll(/(CONDOM[ÍI]NIO|EDIF[ÍI]CIO|RESIDENCIAL)\s+([^\n,]{2,80})/gi)) {
      const candidate = cleanName(`${mm[1]} ${mm[2]}`);
      if (candidate) return candidate;
    }
  }
  // 3) Document name fallback
  return nameFromDoc(docName);
}

function extractAddress(block) {
  // Capture up to 3 comma-separated chunks after "situado/a" to include number and neighborhood
  const m = block.match(/situad[oa]\s+(?:na|no|em)\s+((?:[^\n,]+,\s*){0,3}[^\n,]+)/i);
  if (m) {
    // Cut at legal boilerplate
    return clean(m[1]).replace(/\s*(?:CEP|inscrito|neste\s+ato|CNPJ|s[ií]ndico).*$/i,'').replace(/[,.;]+$/,'');
  }
  const m2 = block.match(/endere[çc]o[:\s]+((?:[^\n,]+,\s*){0,3}[^\n,]+)/i);
  if (m2) return clean(m2[1]).replace(/\s*(?:CEP|inscrito).*$/i,'').replace(/[,.;]+$/,'');
  // street keyword fallback (include number and maybe neighborhood)
  const m3 = block.match(/\b(?:rua|avenida|av\.|alameda|al\.|rodovia|rod\.|travessa|estrada)\s+((?:[^\n,]+,\s*){0,2}[^\n,]+)/i);
  if (m3) return clean(m3[0]).replace(/\s*(?:CEP|inscrito).*$/i,'').replace(/[,.;]+$/,'');
  return null;
}

function extractCityUf(block) {
  const m = block.match(CITY_UF_RE);
  if (!m) return {};
  // Skip if the city is clearly part of an address noise (e.g., "CEP 01234-567 São Paulo/SP")
  return { city: clean(m[1]).replace(/^[-,\s]+|[-,\s]+$/g,''), state: m[2] };
}

// Count machines — handles "2 lavadoras", "02 (duas) secadoras", "dois conjuntos"
function extractMachineCounts(text) {
  let washers = 0, dryers = 0, sets = 0;

  // Direct: "\d+ lavadoras?" etc.
  for (const m of text.matchAll(/(\b\d{1,3})\s*(?:\(\s*[\wá-ú]+\s*\)\s*)?\b(lavadora|secadora|m[áa]quina|conjunto)s?/gi)) {
    const n = parseInt(m[1], 10);
    const kind = stripAccents(m[2].toLowerCase());
    if (kind.startsWith('lavadora')) washers = Math.max(washers, n);
    else if (kind.startsWith('secadora')) dryers = Math.max(dryers, n);
    else if (kind.startsWith('conjunto')) sets = Math.max(sets, n);
  }

  // By extenso: "dois (02) conjuntos", "três lavadoras"
  for (const m of text.matchAll(/\b(um|uma|dois|duas|tr[eê]s|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|treze|quatorze|catorze|quinze)\s*(?:\(\s*\d{1,2}\s*\)\s*)?(lavadora|secadora|m[áa]quina|conjunto)s?/gi)) {
    const n = numFromTokenLower(m[1]);
    if (!n) continue;
    const kind = stripAccents(m[2].toLowerCase());
    if (kind.startsWith('lavadora')) washers = Math.max(washers, n);
    else if (kind.startsWith('secadora')) dryers = Math.max(dryers, n);
    else if (kind.startsWith('conjunto')) sets = Math.max(sets, n);
  }

  // A "conjunto" typically = 1 lavadora + 1 secadora
  if (sets && !washers) washers = sets;
  if (sets && !dryers) dryers = sets;

  return { washers, dryers, sets };
}

// ---------- Maintenance frequency ----------
// Returns { intervalMonths, perYear, label, source } or null if unknown.
function extractMaintenanceFrequency(text) {
  const t = text.toLowerCase();
  // Capture every occurrence of "manutenção preventiva" (or technical visit) and
  // look BEFORE and AFTER each one (±400 chars) for a frequency word.
  const scopes = [];
  const anchorRe = /manuten\S{2,6}\s*(?:preventiv[ao]s?|t[ée]cnicas?|peri[óo]dicas?)|visitas?\s+t[ée]cnicas?|periodicidade/g;
  let m;
  while ((m = anchorRe.exec(t)) !== null) {
    const s = Math.max(0, m.index - 400);
    const e = Math.min(t.length, m.index + 400);
    scopes.push(t.slice(s, e));
  }
  const scope = scopes.length ? scopes.join(' ') : t;

  const tests = [
    { re: /\b(mensal(?:mente)?|cada\s+m[êe]s|todo\s+m[êe]s|a\s+cada\s+30\s*dias?|a\s+cada\s+um\s+m[êe]s|12\s*vezes\s+(?:ao|por)\s+ano)\b/, m: 1 },
    { re: /\bbimestral(?:mente)?|a\s+cada\s+2\s*meses|a\s+cada\s+dois\s+meses|a\s+cada\s+60\s*dias?|6\s*vezes\s+(?:ao|por)\s+ano\b/, m: 2 },
    { re: /\btrimestral(?:mente)?|a\s+cada\s+3\s*meses|a\s+cada\s+tr[êe]s\s+meses|a\s+cada\s+90\s*dias?|4\s*vezes\s+(?:ao|por)\s+ano\b/, m: 3 },
    { re: /\bquadrimestral(?:mente)?|a\s+cada\s+4\s*meses|a\s+cada\s+quatro\s+meses|a\s+cada\s+120\s*dias?|3\s*vezes\s+(?:ao|por)\s+ano\b/, m: 4 },
    { re: /\bsemestral(?:mente)?|a\s+cada\s+6\s*meses|a\s+cada\s+seis\s+meses|a\s+cada\s+180\s*dias?|(?:2|duas)\s*vezes\s+(?:ao|por)\s+ano\b/, m: 6 },
    { re: /\b(?:anual(?:mente)?|a\s+cada\s+12\s*meses|a\s+cada\s+doze\s+meses|a\s+cada\s+ano|uma\s*vez\s+(?:ao|por)\s+ano)\b/, m: 12 },
  ];
  for (const tst of tests) {
    if (tst.re.test(scope)) {
      const labels = {1:'Mensal',2:'Bimestral',3:'Trimestral',4:'Quadrimestral',6:'Semestral',12:'Anual'};
      return { intervalMonths: tst.m, perYear: Math.round(12/tst.m), label: labels[tst.m], source: 'contract' };
    }
  }
  return null;
}

// Decide if the document is an actual condo service contract (not an addendum,
// signup page, CNPJ registry record, employee holidays etc.).
function isContractDocument(text, docName) {
  const n = (docName||'').toLowerCase();
  const t = (text||'').toLowerCase();
  // Hard NO from document name
  if (/aditivo|f[eé]rias\s+coletivas|registrobr|\bassinatura\b|termo\s+de\s+encerramento|distrato/.test(n)) return false;
  // Positive signals in the text
  const hasParties = /contratante.*contratad[ao]|contratad[ao].*contratante/s.test(t);
  const hasObject = /gest[ãa]o\s+de\s+lavanderia|comodato\s+de\s+equipamentos|servi[çc]os\s+de\s+gest[ãa]o|lavanderia\s+compartilhada/.test(t);
  const hasCondoKeyword = /condom[íi]nio|edif[íi]cio|residencial/.test(t);
  return hasParties && hasObject && hasCondoKeyword;
}

export async function extractFromPdf(buffer, docName='') {
  let text = '';
  try { const parsed = await pdfParse(buffer); text = parsed.text || ''; }
  catch (e) { return { error: String(e.message||e), raw: '' }; }

  const block = contratanteBlock(text) || text;
  const out = { raw: text.slice(0, 40000) };

  out.name = extractName(block, docName, text);
  out.address = (extractAddress(block)||'').replace(/\s*,\s*(CEP|inscrito|neste\s+ato|CNPJ|s[ií]ndico)[\s\S]*$/i,'').replace(/\s*[.,;]+$/,'').trim() || null;
  const cityUf = extractCityUf(block);
  out.city = cityUf.city || null;
  out.state = cityUf.state || null;

  // CEP and CNPJ within the CONTRATANTE block (not Lavandery's)
  const cep = block.match(CEP_RE);
  if (cep && cep[1] !== LAVANDERY.cep) out.cep = cep[1];
  const cnpj = block.match(CNPJ_RE);
  if (cnpj && cnpj[1] !== LAVANDERY.cnpj) out.cnpj = cnpj[1];

  // Defense: if address or city matches Lavandery, clear them
  if (out.address && LAVANDERY.address.test(out.address)) out.address = null;
  if (out.city && LAVANDERY.city.test(out.city)) { out.city = null; out.state = null; }

  const mc = extractMachineCounts(text);
  out.washers = mc.washers;
  out.dryers = mc.dryers;
  out.sets = mc.sets;
  out.totalMachines = mc.washers + mc.dryers;

  const freq = extractMaintenanceFrequency(text);
  if (freq) out.maintenance = freq;

  out.isContract = isContractDocument(text, docName);

  return out;
}
