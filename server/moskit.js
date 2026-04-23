// Integração Moskit CRM — https://docs.moskitcrm.com/reference
// Auth: header `apikey: XXXX`
const BASE = 'https://api.moskitcrm.com/v2';

async function moskitFetch(cfg, endpoint, options = {}) {
  if (!cfg?.api_key) throw new Error('Moskit: api_key não configurada');
  const url = endpoint.startsWith('http') ? endpoint : `${BASE}${endpoint}`;
  const r = await fetch(url, {
    ...options,
    headers: {
      'apikey': cfg.api_key,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await r.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!r.ok) {
    const msg = body?.message || body?.error || text || ('HTTP ' + r.status);
    throw new Error(`Moskit ${r.status}: ${msg}`);
  }
  return body;
}

export async function moskitTest(cfg) {
  try {
    if (!cfg?.api_key) return { ok: false, reason: 'no_api_key' };
    const users = await moskitFetch(cfg, '/users');
    return { ok: true, users_count: Array.isArray(users) ? users.length : 0 };
  } catch (e) {
    return { ok: false, reason: String(e.message || e) };
  }
}

// Helper genérico: busca todos os registros paginando até acabar
async function fetchAllPaginated(cfg, endpoint, pageSize = 100) {
  const all = [];
  let offset = 0;
  const MAX_PAGES = 200; // proteção contra loop infinito
  for (let p = 0; p < MAX_PAGES; p++) {
    const sep = endpoint.includes('?') ? '&' : '?';
    const page = await moskitFetch(cfg, `${endpoint}${sep}limit=${pageSize}&offset=${offset}`);
    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
    await new Promise(r => setTimeout(r, 120)); // respeita rate limit
  }
  return all;
}

// Lista empresas (companies) — paginado
export async function moskitListCompanies(cfg, opts = {}) {
  if (opts.noAll) return moskitFetch(cfg, `/companies?limit=${opts.limit||100}&offset=${opts.offset||0}`);
  return fetchAllPaginated(cfg, '/companies');
}

// Busca empresa por CNPJ ou nome
export async function moskitFindCompany(cfg, { cnpj, name }) {
  if (cnpj) {
    try {
      const r = await moskitFetch(cfg, `/companies?cnpj=${encodeURIComponent(cnpj)}`);
      if (Array.isArray(r) && r.length) return r[0];
    } catch {}
  }
  if (name) {
    try {
      const r = await moskitFetch(cfg, `/companies?name=${encodeURIComponent(name)}`);
      if (Array.isArray(r) && r.length) return r[0];
    } catch {}
  }
  return null;
}

// Cria ou atualiza empresa
export async function moskitUpsertCompany(cfg, data) {
  // data: { name, cnpj, address, city, phone, email }
  const existing = await moskitFindCompany(cfg, { cnpj: data.cnpj, name: data.name });
  const payload = {
    name: data.name,
    cnpj: data.cnpj || undefined,
    phone: data.phone || undefined,
    email: data.email || undefined,
    address: data.address || undefined,
    city: data.city || undefined,
    zip: data.cep || undefined,
    state: data.state || undefined,
    comments: data.notes || undefined,
  };
  // Remove undefined
  Object.keys(payload).forEach(k => payload[k] === undefined && delete payload[k]);
  if (existing && existing.id) {
    const updated = await moskitFetch(cfg, `/companies/${existing.id}`, {
      method: 'PUT', body: JSON.stringify(payload),
    });
    return { ...updated, __action: 'updated' };
  }
  const created = await moskitFetch(cfg, '/companies', {
    method: 'POST', body: JSON.stringify(payload),
  });
  return { ...created, __action: 'created' };
}

// Cria oportunidade (deal)
export async function moskitCreateDeal(cfg, data) {
  // data: { title, value, companyId, stageId, ownerId, description }
  const payload = {
    name: data.title,
    value: data.value,
    companyId: data.company_id,
    stageId: data.stage_id,
    ownerId: data.owner_id,
    description: data.description || undefined,
  };
  Object.keys(payload).forEach(k => payload[k] === undefined && delete payload[k]);
  return moskitFetch(cfg, '/deals', { method: 'POST', body: JSON.stringify(payload) });
}

// Cria atividade / tarefa
export async function moskitCreateActivity(cfg, data) {
  const payload = {
    type: data.type || 'NOTE',
    comments: data.comments || data.notes,
    companyId: data.company_id,
    dealId: data.deal_id,
    dueDate: data.due_date,
  };
  Object.keys(payload).forEach(k => payload[k] === undefined && delete payload[k]);
  return moskitFetch(cfg, '/activities', { method: 'POST', body: JSON.stringify(payload) });
}

// Lista pipelines/stages
export async function moskitListPipelines(cfg) {
  return moskitFetch(cfg, '/pipelines');
}

// Lista deals — paginado
export async function moskitListDeals(cfg, opts = {}) {
  if (opts.noAll) return moskitFetch(cfg, `/deals?limit=${opts.limit||100}&offset=${opts.offset||0}`);
  return fetchAllPaginated(cfg, '/deals');
}

// Lista contatos — paginado
export async function moskitListContacts(cfg, opts = {}) {
  if (opts.noAll) return moskitFetch(cfg, `/contacts?limit=${opts.limit||100}&offset=${opts.offset||0}`);
  return fetchAllPaginated(cfg, '/contacts');
}

// Lista atividades — paginado
export async function moskitListActivities(cfg, opts = {}) {
  if (opts.noAll) return moskitFetch(cfg, `/activities?limit=${opts.limit||100}&offset=${opts.offset||0}`);
  return fetchAllPaginated(cfg, '/activities');
}

// Lista usuários
export async function moskitListUsers(cfg) {
  return moskitFetch(cfg, '/users');
}

// Stats consolidados (faz várias chamadas em paralelo)
export async function moskitStats(cfg) {
  const [companies, contacts, deals, activities, users] = await Promise.allSettled([
    moskitListCompanies(cfg, { limit: 1 }),
    moskitListContacts(cfg, { limit: 1 }),
    moskitListDeals(cfg, { limit: 1 }),
    moskitListActivities(cfg, { limit: 1 }),
    moskitListUsers(cfg),
  ]);
  return {
    companies: companies.status === 'fulfilled' ? (Array.isArray(companies.value) ? companies.value.length : 0) : 0,
    contacts: contacts.status === 'fulfilled' ? (Array.isArray(contacts.value) ? contacts.value.length : 0) : 0,
    deals: deals.status === 'fulfilled' ? (Array.isArray(deals.value) ? deals.value.length : 0) : 0,
    activities: activities.status === 'fulfilled' ? (Array.isArray(activities.value) ? activities.value.length : 0) : 0,
    users: users.status === 'fulfilled' ? (Array.isArray(users.value) ? users.value.length : 0) : 0,
    errors: [companies, contacts, deals, activities, users]
      .map((r, i) => r.status === 'rejected' ? { kind: ['companies','contacts','deals','activities','users'][i], err: String(r.reason?.message || r.reason) } : null)
      .filter(Boolean),
  };
}
