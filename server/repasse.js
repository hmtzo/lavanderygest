// REPASSE INTELIGENTE — lê planilhas Google Sheets, classifica abas,
// parseia dados e calcula repasse financeiro automaticamente.

// Extrai ID da planilha de uma URL do Google Sheets / Drive
export function extractSheetId(url) {
  if (!url) return null;
  const m = String(url).match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/) || String(url).match(/\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

// Lista abas via HTML público do Sheets (funciona sem OAuth pra planilhas "anyone with link")
export async function listTabs(sheetId) {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/htmlview`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 Lavandery/1.0' } });
  if (!r.ok) throw new Error(`Planilha inacessível (HTTP ${r.status}). Garanta "qualquer pessoa com o link pode ler".`);
  const html = await r.text();
  // Estratégia 1: htmlview contém links <a> por aba com o nome
  const tabs = [];
  const re = /<li[^>]*id="sheet-button-(\d+)"[^>]*>.*?>([^<]+)</gs;
  let m;
  while ((m = re.exec(html))) {
    tabs.push({ gid: m[1], name: m[2].trim() });
  }
  // Estratégia 2: fallback via regex nos scripts do edit view
  if (!tabs.length) {
    const editUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
    const r2 = await fetch(editUrl, { headers: { 'User-Agent': 'Mozilla/5.0 Lavandery/1.0' } });
    const html2 = await r2.text();
    // O bootstrap contém pares "sheetId":N,"name":"..."
    const re2 = /"sheetId"\s*:\s*(\d+)[^}]*?"name"\s*:\s*"([^"]+)"/g;
    let m2;
    const seen = new Set();
    while ((m2 = re2.exec(html2))) {
      const gid = m2[1], name = m2[2];
      if (!seen.has(gid)) { tabs.push({ gid, name }); seen.add(gid); }
    }
  }
  if (!tabs.length) throw new Error('Não foi possível listar abas da planilha (verifique permissão).');
  return tabs;
}

// Baixa CSV de uma aba específica
export async function fetchTabCsv(sheetId, gid) {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
  const r = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 Lavandery/1.0' } });
  if (!r.ok) throw new Error(`CSV HTTP ${r.status} gid=${gid}`);
  return await r.text();
}

// Parser CSV simples tolerante a aspas
export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i+1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else cell += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\r') {}
      else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += c;
    }
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// Converte "1.234,56" ou "R$ 1.234,56" ou "1,234.56" em número
export function parseBRNumber(s) {
  if (s == null) return null;
  let str = String(s).trim();
  if (!str) return null;
  str = str.replace(/R\$\s*/g, '').replace(/\s/g, '');
  // detecta formato: tem vírgula decimal se houver vírgula após último ponto
  const lastComma = str.lastIndexOf(',');
  const lastDot = str.lastIndexOf('.');
  if (lastComma > lastDot) {
    // BR: 1.234,56 → 1234.56
    str = str.replace(/\./g, '').replace(',', '.');
  } else if (lastDot > lastComma && lastComma !== -1) {
    // EN: 1,234.56 → 1234.56
    str = str.replace(/,/g, '');
  } else if (lastDot !== -1 && lastComma === -1 && str.split('.').length > 2) {
    // 1.234.567 (milhares) sem decimal
    str = str.replace(/\./g, '');
  }
  const n = parseFloat(str);
  return isNaN(n) ? null : n;
}

// ---------- Classificação de abas ----------
const IGNORE_PATTERNS = [/resumo/i, /dashboard/i, /controle/i, /^base/i, /modelo/i, /template/i, /^$/];

export function classifyTab(tab, rows, forcedNames = []) {
  const name = (tab.name || '').trim();

  // Prioridade 1 — prefixo numérico (001, 002...)
  if (/^0?\d{1,4}[\s._-]/.test(name)) return { valid: true, reason: 'numeric_prefix' };

  // Lista forçada
  if (forcedNames.some(n => n && name.toLowerCase().includes(n.toLowerCase()))) {
    return { valid: true, reason: 'forced' };
  }

  // Exclusões
  if (IGNORE_PATTERNS.some(rx => rx.test(name))) return { valid: false, reason: 'ignore_pattern' };

  // Prioridade 2 — conteúdo: procura keywords + números
  if (!rows || !rows.length) return { valid: false, reason: 'empty' };
  const flat = rows.slice(0, 15).map(r => r.join(' ').toLowerCase()).join(' ');
  const hasKeywords = /(lavage|lavagem|secage|secagem|ciclo|repasse|condomin|valor|faturamento)/i.test(flat);
  const hasNumbers = rows.slice(0, 40).some(r => r.some(c => /\d+[,.]?\d*/.test(c) && parseBRNumber(c) > 1));
  if (hasKeywords && hasNumbers) return { valid: true, reason: 'content' };

  return { valid: false, reason: 'no_match' };
}

// ---------- Parser Template "Relatório Mensal" (novo modelo Lavandery) ----------
// Detecta: cabeçalho "Relatório – Mês/Ano – NomeCondo" + tabela de transações (MAQUINA, USUARIO, DATA)
export function parseMonthlyReport(rows) {
  // 1. Header info
  let title = null, month = null, condoNameFromTitle = null;
  for (let i = 0; i < Math.min(rows.length, 6); i++) {
    const cell = (rows[i][0] || '').trim();
    if (/relat[óo]rio/i.test(cell)) {
      title = cell;
      const mm = cell.match(/(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)[a-zçãéêíôú]*[\/\s-]+(\d{4})/i);
      if (mm) {
        const meses = { jan:'01',fev:'02',mar:'03',abr:'04',mai:'05',jun:'06',jul:'07',ago:'08',set:'09',out:'10',nov:'11',dez:'12' };
        month = `${mm[2]}-${meses[mm[1].slice(0,3).toLowerCase()]}`;
      }
      const condoMatch = cell.split(/[–-]/).map(s=>s.trim()).filter(Boolean);
      if (condoMatch.length >= 3) condoNameFromTitle = condoMatch[condoMatch.length-1];
      break;
    }
  }

  // 2. Valores do resumo
  let reimbursePerCycle = null, taxRate = null;
  for (const r of rows.slice(0, 30)) {
    const line = r.join('|').toLowerCase();
    if (/reembolso.*ciclo|valor.*ciclo|por ciclo/i.test(line) && reimbursePerCycle == null) {
      for (const c of r) {
        const n = parseBRNumber(c);
        if (n != null && n > 0.5 && n < 50) { reimbursePerCycle = n; break; }
      }
    }
    if (/icms|imposto|cofins|iss/i.test(line) && taxRate == null) {
      for (const c of r) {
        if (/%/.test(c)) { const n = parseBRNumber(c.replace('%','')); if (n != null && n > 5 && n < 60) { taxRate = n; break; } }
      }
    }
  }

  // 3. Transações — procura header "MAQUINA | USUARIO | DATA"
  let dataStart = -1, cm = {};
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r.length) continue;
    const joined = r.join('|').toLowerCase();
    if (/m[áa]quina/.test(joined) && /usu[áa]rio/.test(joined) && /data/.test(joined)) {
      dataStart = i + 1;
      r.forEach((h, idx) => {
        const lh = (h||'').toLowerCase();
        if (/m[áa]quina/.test(lh)) cm.machine = idx;
        else if (/usu[áa]rio/.test(lh)) cm.user = idx;
        else if (/data/.test(lh)) cm.date = idx;
      });
      break;
    }
  }

  const transactions = [];
  let washes = 0, dries = 0;
  if (dataStart >= 0) {
    for (let i = dataStart; i < rows.length; i++) {
      const r = rows[i];
      const machine = (r[cm.machine]||'').trim();
      if (!machine) continue;
      const user = (r[cm.user]||'').trim();
      const date = (r[cm.date]||'').trim();
      const isLavadora = /lavadora/i.test(machine);
      const isSecadora = /secadora/i.test(machine);
      if (!isLavadora && !isSecadora) continue;
      transactions.push({ machine, user, date, type: isLavadora ? 'lavagem' : 'secagem' });
      if (isLavadora) washes++; else dries++;
    }
  }

  return {
    title, month, condoNameFromTitle,
    reimbursePerCycle: reimbursePerCycle || 2.50,
    taxRate: taxRate || 32.25,
    washes, dries,
    cycles: washes + dries,
    transactions,
  };
}

// Detecta configuração (rate, price, tax) de uma aba no modelo Lavandery
export function detectCondoRates(rows) {
  const result = { cycle_rate: null, cycle_price: null, tax_rate: null };
  const parseBR = s => { if (s==null||s==='') return null; const str=String(s).replace(/R\$\s*/g,'').replace(/,/g,'').replace(/\s/g,''); const n=parseFloat(str); return isNaN(n)?null:n; };
  let washesCount = 0, dryesCount = 0, washValue = 0, dryValue = 0;

  for (const r of rows) {
    const cells = r.map(x => String(x||'').trim());
    const line = cells.join('|').toLowerCase();

    // REEMBOLSO POR CICLO
    if (/reembolso.*ciclo/i.test(line) && !result.cycle_rate) {
      for (const c of cells) { const n = parseBR(c); if (n != null && n > 0.5 && n < 50) { result.cycle_rate = n; break; } }
    }
    // Imposto %
    if (/icms|imposto/i.test(line) && !result.tax_rate) {
      for (const c of cells) { if (/%/.test(c)) { const n = parseBR(c.replace('%','')); if (n != null && n > 5 && n < 60) { result.tax_rate = n; break; } } }
    }
    // Total lavagens/secagens
    if (/total.*ciclos.*lavage/i.test(line)) {
      const nums = cells.map(parseBR).filter(n => n != null);
      if (nums.length >= 2) { washesCount = nums[0] || 0; washValue = nums[1] || 0; }
    }
    if (/total.*ciclos.*secage/i.test(line)) {
      const nums = cells.map(parseBR).filter(n => n != null);
      if (nums.length >= 2) { dryesCount = nums[0] || 0; dryValue = nums[1] || 0; }
    }
  }

  // Preço/ciclo calculado: (washValue + dryValue) / (washes + dries)
  const totalCycles = washesCount + dryesCount;
  if (totalCycles > 0) {
    const totalValue = washValue + dryValue;
    if (totalValue > 0) result.cycle_price = totalValue / totalCycles;
  }

  // Formato complexo (Vibra): REPASSE X,YY em cada linha → pega a média
  if (!result.cycle_rate) {
    const repasses = [];
    for (const r of rows) {
      for (const c of r) {
        const m = String(c||'').match(/REPASSE\s*([\d,]+)/i);
        if (m) { const n = parseFloat(m[1].replace(',','.')); if (n > 0) repasses.push(n); }
      }
    }
    if (repasses.length) {
      // Usa mediana pra robustez
      repasses.sort((a,b) => a-b);
      result.cycle_rate = repasses[Math.floor(repasses.length/2)];
      result.rate_mixed = true;
    }
  }

  // Nome condo do título
  for (const r of rows.slice(0,3)) {
    const t = r.map(x=>String(x||'')).join(' ');
    const m = t.match(/Relat[óo]rio\s*[–-]\s*[^–-]+[–-]\s*(.+)/i);
    if (m) { result.condo_name = m[1].trim(); break; }
  }

  return result;
}

// Calcula valores financeiros de um relatório mensal
export function calcMonthlyReport(parsed) {
  const rate = parsed.reimbursePerCycle || 2.50;
  const tax = (parsed.taxRate || 32.25) / 100;
  const washValue = parsed.washes * rate;
  const dryValue = parsed.dries * rate;
  const gross = washValue + dryValue;
  const taxAmount = gross * tax;
  const repasse = gross - taxAmount;
  return {
    ...parsed,
    washValue, dryValue, gross, taxAmount, repasse,
  };
}

// ---------- Parser de aba de condomínio (modelo antigo consolidado) ----------
// Tenta detectar linha de cabeçalho e extrair dados mensais
export function parseCondoTab(rows) {
  // Encontra a linha de header: contém "MÊS" ou "MES" + pelo menos uma keyword financeira
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const joined = rows[i].join('|').toLowerCase();
    if (/m[êe]s/i.test(joined) && /(ciclos?|lavage|secage|repasse|faturamento|valor|bruto)/i.test(joined)) {
      headerIdx = i; break;
    }
  }
  if (headerIdx < 0) return { header: null, rows: [] };

  const header = rows[headerIdx].map(h => (h||'').trim());
  const colMap = {};
  header.forEach((h, i) => {
    const lh = h.toLowerCase();
    if (/m[êe]s|data/.test(lh)) colMap.month = i;
    else if (/ciclo/.test(lh) && !colMap.cycles) colMap.cycles = i;
    else if (/lavage|lavada/.test(lh)) colMap.washes = i;
    else if (/secage/.test(lh)) colMap.dries = i;
    else if (/valor.*bruto|bruto.*maq|faturamento/.test(lh)) colMap.gross = i;
    else if (/entrega/.test(lh)) colMap.delivery = i;
    else if (/produto|insumo/.test(lh) && !colMap.products) colMap.products = i;
    else if (/sistema/.test(lh)) colMap.system = i;
    else if (/pe[çc]a/.test(lh)) colMap.parts = i;
    else if (/t[ée]cnico/.test(lh)) colMap.tech = i;
    else if (/taxa.*maq|taxa.*ciclo/.test(lh)) colMap.machineFee = i;
    else if (/repasse.*condom[ií]nio/.test(lh)) colMap.payout = i;
    else if (/repasse.*bruto/.test(lh) && colMap.payout == null) colMap.payoutGross = i;
    else if (/imposto/.test(lh) && !/%/.test(lh)) colMap.tax = i;
    else if (/l[ií]quido|lavandery/.test(lh)) colMap.net = i;
    else if (/obra|implan/.test(lh)) colMap.installation = i;
    else if (/adesiv/.test(lh)) colMap.stickers = i;
  });

  const out = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r.length || !r[colMap.month]) continue;
    const monthRaw = r[colMap.month]?.trim();
    if (!monthRaw) continue;
    // Detecta data válida (30/01/2024 ou 2024-01 ou Janeiro/24)
    const iso = toIsoMonth(monthRaw);
    if (!iso) continue;
    out.push({
      month: iso,
      raw_month: monthRaw,
      cycles: int(r[colMap.cycles]),
      washes: int(r[colMap.washes]),
      dries: int(r[colMap.dries]),
      gross: parseBRNumber(r[colMap.gross]),
      delivery: parseBRNumber(r[colMap.delivery]),
      products: parseBRNumber(r[colMap.products]),
      system: parseBRNumber(r[colMap.system]),
      parts: parseBRNumber(r[colMap.parts]),
      tech: parseBRNumber(r[colMap.tech]),
      machineFee: parseBRNumber(r[colMap.machineFee]),
      payoutGross: parseBRNumber(r[colMap.payoutGross]),
      tax: parseBRNumber(r[colMap.tax]),
      payout: parseBRNumber(r[colMap.payout]),
      net: parseBRNumber(r[colMap.net]),
      installation: parseBRNumber(r[colMap.installation]),
      stickers: parseBRNumber(r[colMap.stickers]),
    });
  }
  return { header, colMap, rows: out };
}
function int(s) { const n = parseBRNumber(s); return n == null ? null : Math.round(n); }

// Normaliza mês em formato YYYY-MM
function toIsoMonth(s) {
  if (!s) return null;
  const str = String(s).trim();
  // 30/01/2024 ou 01/24
  let m = str.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? ('20' + m[3]) : m[3];
    return `${y}-${m[2].padStart(2,'0')}`;
  }
  // 2024-01 ou 2024-01-30
  m = str.match(/(\d{4})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2,'0')}`;
  // Janeiro/2024, Jan/24
  const meses = { jan:'01',fev:'02',mar:'03',abr:'04',mai:'05',jun:'06',jul:'07',ago:'08',set:'09',out:'10',nov:'11',dez:'12' };
  m = str.toLowerCase().match(/([a-zçãôéêíú]{3,})\/?(\d{2,4})/);
  if (m && meses[m[1].slice(0,3)]) {
    const y = m[2].length === 2 ? ('20' + m[2]) : m[2];
    return `${y}-${meses[m[1].slice(0,3)]}`;
  }
  return null;
}

// ---------- Motor Financeiro ----------
// config: { model, cycleValueWash, cycleValueDry, percent, fixedPerCycle, taxRate, costOverrides }
export function calculateRepasse(data, config) {
  const model = config.model || 'detectar';
  const pct = (config.percent || 0) / 100;
  const taxRate = config.taxRate != null ? config.taxRate / 100 : 0.3225;
  const vW = config.cycleValueWash || 0;
  const vD = config.cycleValueDry || 0;
  const fixed = config.fixedPerCycle || 0;

  const washes = data.washes || 0;
  const dries = data.dries || 0;
  const cycles = data.cycles || (washes + dries);

  // Faturamento: usa valor da planilha se houver, senão calcula
  const gross = data.gross != null ? data.gross
    : (washes * vW + dries * vD) || (cycles * (vW || fixed));

  // Base líquida = gross - custos
  const costs = (data.machineFee||0) + (data.products||0) + (data.system||0)
    + (data.parts||0) + (data.tech||0) + (data.delivery||0) + (data.installation||0);
  const baseLiquida = gross - costs;

  let repasse = 0, tax = 0;
  if (model === 'fixo') {
    repasse = cycles * fixed;
  } else if (model === 'percentual') {
    repasse = gross * pct;
  } else if (model === 'hibrido') {
    repasse = baseLiquida * pct;
  } else {
    // auto-detect: se tem payout na planilha usa ele; se não, híbrido 50%
    if (data.payout != null) repasse = data.payout;
    else repasse = baseLiquida * (pct || 0.5);
  }

  tax = repasse * taxRate;
  const repasseLiq = repasse - tax;
  const liqLavandery = gross - costs - repasse;
  const margem = gross > 0 ? (liqLavandery / gross) : 0;

  return {
    ...data,
    gross, cycles, costs, baseLiquida,
    repasse_bruto: repasse,
    imposto: tax,
    repasse_liquido: repasseLiq,
    liquido_lavandery: liqLavandery,
    margem: +(margem * 100).toFixed(2),
  };
}

// Validações de sanidade
export function validateCalc(row) {
  const issues = [];
  if ((row.cycles||0) > 500 && (row.gross||0) < 500) issues.push('ciclos altos com faturamento baixo');
  if ((row.gross||0) < 0) issues.push('faturamento negativo');
  if (row.margem != null && (row.margem < -50 || row.margem > 95)) issues.push('margem fora do esperado');
  return issues;
}

// Detecta modelo automaticamente a partir de amostra de linhas
export function detectModel(rows) {
  if (!rows.length) return 'hibrido';
  const withPayout = rows.filter(r => r.payout != null && r.payout > 0);
  if (withPayout.length < 3) return 'hibrido';
  // Se repasse_condomínio = % fixo do faturamento → percentual
  const ratios = withPayout.map(r => r.gross > 0 ? r.payout / r.gross : 0).filter(x => x > 0);
  const avg = ratios.reduce((a,b) => a+b, 0) / ratios.length;
  const stddev = Math.sqrt(ratios.map(x => (x-avg)**2).reduce((a,b)=>a+b,0) / ratios.length);
  if (stddev < 0.05) return 'percentual';
  // Se repasse = cycles * constante → fixo
  const perCycle = withPayout.filter(r => r.cycles > 0).map(r => r.payout / r.cycles);
  if (perCycle.length > 3) {
    const a = perCycle.reduce((x,y)=>x+y,0) / perCycle.length;
    const sd = Math.sqrt(perCycle.map(x => (x-a)**2).reduce((x,y)=>x+y,0) / perCycle.length);
    if (sd < 0.5) return 'fixo';
  }
  return 'hibrido';
}
