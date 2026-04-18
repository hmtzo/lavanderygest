// Parser iCal simples (RFC 5545) — Google Calendar e Outlook/Microsoft 365
// suportam exportar secret ICS URL. Lemos, parseamos VEVENTs e mesclamos.

function unfold(text) {
  return text.replace(/\r?\n[\t ]/g, '');
}
function parseDate(val, tz) {
  // Formatos: 20260420T090000Z  |  20260420T090000  |  20260420
  if (/^\d{8}$/.test(val)) {
    return new Date(val.slice(0,4)+'-'+val.slice(4,6)+'-'+val.slice(6,8)+'T00:00:00').toISOString();
  }
  const m = val.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7]==='Z'?'Z':''}`;
  return new Date(iso).toISOString();
}
function unescapeText(s) {
  return (s||'').replace(/\\n/g,'\n').replace(/\\,/g,',').replace(/\\;/g,';').replace(/\\\\/g,'\\');
}

export function parseIcs(ics) {
  const events = [];
  const text = unfold(String(ics));
  const blocks = text.split(/\r?\nBEGIN:VEVENT\r?\n/);
  for (let i = 1; i < blocks.length; i++) {
    const chunk = blocks[i].split(/\r?\nEND:VEVENT/)[0];
    const ev = { raw: {} };
    for (const line of chunk.split(/\r?\n/)) {
      const idx = line.indexOf(':'); if (idx < 0) continue;
      const keyPart = line.slice(0, idx); const value = line.slice(idx+1);
      const [key] = keyPart.split(';');
      ev.raw[key] = value;
      switch (key) {
        case 'UID': ev.uid = value; break;
        case 'SUMMARY': ev.title = unescapeText(value); break;
        case 'DESCRIPTION': ev.description = unescapeText(value); break;
        case 'LOCATION': ev.location = unescapeText(value); break;
        case 'DTSTART': ev.start = parseDate(value); ev.allDay = /^\d{8}$/.test(value); break;
        case 'DTEND': ev.end = parseDate(value); break;
        case 'STATUS': ev.status = value; break;
        case 'ORGANIZER': {
          const m = value.match(/mailto:(.+)/i); if (m) ev.organizer = m[1];
          const cn = keyPart.match(/CN=([^;:]+)/i); if (cn) ev.organizer_name = cn[1];
          break;
        }
      }
    }
    if (ev.start) events.push(ev);
  }
  return events;
}

// Detecta provider pelo domínio da URL
export function providerFor(url) {
  if (/google\.com|googleusercontent/.test(url)) return 'google';
  if (/outlook\.|office\.com|live\.com|microsoft/.test(url)) return 'microsoft';
  return 'other';
}

// Baixa e parseia múltiplas feeds, retorna eventos agrupados
export async function fetchCalendars(urls, { from, to } = {}) {
  const all = [];
  const errors = [];
  const fromMs = from ? new Date(from).getTime() : null;
  const toMs = to ? new Date(to).getTime() : null;
  for (const url of urls) {
    if (!url) continue;
    try {
      // Aceita URLs http(s) e webcal:// (troca pra https)
      const fetchUrl = url.replace(/^webcal:/i, 'https:');
      const r = await fetch(fetchUrl, { headers: { 'User-Agent': 'Lavandery/1.0' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const text = await r.text();
      const events = parseIcs(text);
      const provider = providerFor(fetchUrl);
      for (const e of events) {
        const t = new Date(e.start).getTime();
        if (fromMs && t < fromMs) continue;
        if (toMs && t > toMs) continue;
        all.push({ ...e, provider, source_url: fetchUrl });
      }
    } catch (e) {
      errors.push({ url, error: String(e.message||e) });
    }
  }
  all.sort((a,b) => new Date(a.start) - new Date(b.start));
  return { events: all, errors };
}
