// Implementations for every integration card
import { S3Client, PutObjectCommand, GetObjectCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// ---------- Google Maps ----------
export async function gmapsGeocode({ apiKey, address }) {
  if (!apiKey) return { ok: false, reason: 'no_api_key' };
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&region=br&key=${apiKey}`;
    const r = await fetch(url);
    const j = await r.json();
    if (j.status !== 'OK' || !j.results?.length) return { ok: false, reason: j.status, error: j.error_message };
    const top = j.results[0];
    return { ok: true, lat: top.geometry.location.lat, lng: top.geometry.location.lng, formatted: top.formatted_address };
  } catch (e) { return { ok: false, reason: String(e.message||e) }; }
}

export async function gmapsRoute({ apiKey, origin, destinations }) {
  if (!apiKey) return { ok: false, reason: 'no_api_key' };
  // Use Distance Matrix (simpler than Directions with waypoints)
  try {
    const dests = destinations.map(d => `${d.lat},${d.lng}`).join('|');
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${origin.lat},${origin.lng}&destinations=${encodeURIComponent(dests)}&mode=driving&key=${apiKey}`;
    const r = await fetch(url);
    const j = await r.json();
    if (j.status !== 'OK') return { ok: false, reason: j.status };
    const elements = j.rows[0].elements;
    return {
      ok: true,
      data: elements.map((e, i) => ({
        ...destinations[i],
        distance_m: e.distance?.value || null,
        duration_s: e.duration?.value || null,
        status: e.status,
      })),
    };
  } catch (e) { return { ok: false, reason: String(e.message||e) }; }
}

export async function gmapsTest({ apiKey }) {
  return gmapsGeocode({ apiKey, address: 'Av. Paulista, 1000, São Paulo' });
}

// ---------- S3 / R2 ----------
function s3Client(cfg) {
  const endpoint = cfg.endpoint || undefined; // undefined = AWS
  return new S3Client({
    region: cfg.region || 'us-east-1',
    endpoint,
    forcePathStyle: !!endpoint, // R2/MinIO want path-style
    credentials: { accessKeyId: cfg.access_key, secretAccessKey: cfg.secret_key },
  });
}
export async function s3Test(cfg) {
  if (!cfg?.access_key || !cfg?.secret_key || !cfg?.bucket) return { ok: false, reason: 'not_configured' };
  try {
    const s3 = s3Client(cfg);
    await s3.send(new HeadBucketCommand({ Bucket: cfg.bucket }));
    return { ok: true, bucket: cfg.bucket };
  } catch (e) { return { ok: false, reason: e.name || String(e.message||e) }; }
}
export async function s3PresignUpload(cfg, { key, contentType = 'image/jpeg', expiresIn = 600 }) {
  const s3 = s3Client(cfg);
  const cmd = new PutObjectCommand({ Bucket: cfg.bucket, Key: key, ContentType: contentType });
  return getSignedUrl(s3, cmd, { expiresIn });
}
export async function s3PutObject(cfg, { key, body, contentType = 'image/jpeg' }) {
  const s3 = s3Client(cfg);
  await s3.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: key, Body: body, ContentType: contentType }));
  const base = cfg.endpoint || `https://${cfg.bucket}.s3.${cfg.region||'us-east-1'}.amazonaws.com`;
  const publicUrl = cfg.endpoint ? `${cfg.endpoint}/${cfg.bucket}/${key}` : `${base}/${key}`;
  return { key, url: publicUrl };
}

// ---------- Asaas (billing) ----------
function asaasBase(cfg) {
  const env = cfg?.env === 'production' ? 'https://www.asaas.com/api/v3' : 'https://sandbox.asaas.com/api/v3';
  return { url: env, key: cfg?.api_key };
}
async function asaasFetch(cfg, method, path, body) {
  const { url, key } = asaasBase(cfg);
  if (!key) return { ok: false, reason: 'no_api_key' };
  const r = await fetch(`${url}${path}`, {
    method,
    headers: { 'Content-Type':'application/json', 'access_token': key, 'User-Agent': 'Lavandery/1.0' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(()=>({}));
  return { ok: r.ok, status: r.status, data: j };
}
export async function asaasTest(cfg) {
  const r = await asaasFetch(cfg, 'GET', '/customers?limit=1');
  if (!r.ok) return { ok:false, reason: r.data?.errors || r.status };
  return { ok:true, total: r.data?.totalCount ?? 0 };
}
export async function asaasCreateCustomer(cfg, condo) {
  return asaasFetch(cfg, 'POST', '/customers', {
    name: condo.name,
    cpfCnpj: (condo.cnpj||'').replace(/\D/g,''),
    email: condo.contact_email || undefined,
    mobilePhone: condo.contact_phone || undefined,
    address: condo.address, postalCode: (condo.cep||'').replace(/\D/g,''),
    city: condo.city?.split('/')[0], state: condo.city?.split('/')[1],
    externalReference: condo.id,
  });
}
export async function asaasCreateCharge(cfg, { customer, value, dueDate, description, billingType='BOLETO' }) {
  return asaasFetch(cfg, 'POST', '/payments', {
    customer, value, dueDate, description, billingType,
  });
}
export async function asaasListCharges(cfg, { customer } = {}) {
  const q = customer ? `?customer=${customer}` : '';
  return asaasFetch(cfg, 'GET', `/payments${q}`);
}

// ---------- Sentry ----------
let _sentryInited = false;
export async function sentryInit(dsn) {
  if (_sentryInited || !dsn) return;
  const Sentry = await import('@sentry/node');
  Sentry.init({ dsn, tracesSampleRate: 0.1, environment: process.env.NODE_ENV || 'development' });
  _sentryInited = true;
  return Sentry;
}
export async function sentryCapture(err) {
  if (!_sentryInited) return;
  const Sentry = await import('@sentry/node');
  Sentry.captureException(err);
}
export async function sentryTest(dsn) {
  const Sentry = await sentryInit(dsn);
  if (!Sentry) return { ok: false, reason: 'init_failed' };
  Sentry.captureMessage('Lavandery · Teste de Sentry', 'info');
  return { ok: true };
}
