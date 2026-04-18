// Geocoding helpers (free services)
// - Nominatim (OpenStreetMap) — 1 req/s, require User-Agent
// - BrasilAPI CEP v2 — sometimes includes coordinates
// - ViaCEP — fallback for address data

const UA = 'Lavandery-Inspection/1.0 (contato@lavandery.com.br)';

async function tryNominatim(q) {
  try {
    const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=br&q=' + encodeURIComponent(q);
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language':'pt-BR' } });
    if (!r.ok) return null;
    const arr = await r.json();
    if (arr[0]) return { lat: parseFloat(arr[0].lat), lng: parseFloat(arr[0].lon) };
  } catch(e) {}
  return null;
}

async function viaCep(cep) {
  try {
    const clean = cep.replace(/\D/g,'');
    const r = await fetch(`https://viacep.com.br/ws/${clean}/json/`, { headers: { 'User-Agent': UA } });
    if (r.ok) return await r.json();
  } catch(e) {}
  return null;
}

async function brasilApi(cep) {
  try {
    const clean = cep.replace(/\D/g,'');
    const r = await fetch(`https://brasilapi.com.br/api/cep/v2/${clean}`, { headers: { 'User-Agent': UA } });
    if (r.ok) return await r.json();
  } catch(e) {}
  return null;
}

export async function geocodeAddress({ address, city, cep }) {
  // 1) BrasilAPI CEP — sometimes has coords from IBGE
  if (cep) {
    const j = await brasilApi(cep);
    const lat = j?.location?.coordinates?.latitude;
    const lng = j?.location?.coordinates?.longitude;
    if (lat && lng) return { lat: parseFloat(lat), lng: parseFloat(lng), source: 'brasilapi' };
    // Use ViaCEP to enrich address context (bairro, cidade, UF)
    if (j?.neighborhood && j?.city && j?.state) {
      const q = [address, j.neighborhood, j.city, j.state].filter(Boolean).join(', ') + ', Brasil';
      const h = await tryNominatim(q);
      if (h) return { ...h, source: 'cep+nominatim' };
    }
  }
  // 2) ViaCEP fallback (when BrasilAPI fails)
  if (cep) {
    const v = await viaCep(cep);
    if (v && v.localidade && !v.erro) {
      const q = [address, v.bairro, v.localidade, v.uf].filter(Boolean).join(', ') + ', Brasil';
      const h = await tryNominatim(q);
      if (h) return { ...h, source: 'viacep+nominatim' };
      // CEP-only query
      const h2 = await tryNominatim(`${v.logradouro||''}, ${v.localidade}, ${v.uf}, Brasil`);
      if (h2) return { ...h2, source: 'viacep-street' };
    }
  }
  // 3) Address + city
  const q = [address, city].filter(Boolean).join(', ') + ', Brasil';
  const h = await tryNominatim(q);
  if (h) return { ...h, source: 'nominatim' };
  // 4) Just CEP
  if (cep) {
    const h2 = await tryNominatim(`CEP ${cep}, Brasil`);
    if (h2) return { ...h2, source: 'nominatim-cep' };
  }
  // 5) Just city
  if (city) {
    const h2 = await tryNominatim(city + ', Brasil');
    if (h2) return { ...h2, source: 'nominatim-city' };
  }
  return null;
}

// Haversine distance between two lat/lng points, in km
export function distanceKm(a, b) {
  const R = 6371;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const la1 = toRad(a.lat); const la2 = toRad(b.lat);
  const x = Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
}

// Nearest-neighbor ordering from a starting point
export function orderByNearest(start, points) {
  const remaining = [...points];
  const ordered = [];
  let cur = start;
  while (remaining.length) {
    let best = 0, bestDist = Infinity;
    for (let i=0; i<remaining.length; i++) {
      const d = distanceKm(cur, remaining[i]);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    const next = remaining.splice(best, 1)[0];
    ordered.push({ ...next, distanceFromPrev: bestDist });
    cur = next;
  }
  return ordered;
}
