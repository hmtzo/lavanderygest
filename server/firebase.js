// Firebase Storage (Google Cloud Storage) — upload de fotos
import admin from 'firebase-admin';

let _app = null;
let _cfgHash = '';

function cfgHash(cfg) {
  return [cfg?.project_id, cfg?.client_email, cfg?.bucket].join('|');
}

function getApp(cfg) {
  if (!cfg?.bucket) throw new Error('firebase_bucket_missing');
  // Accept either separate fields or a `service_account_json` textarea (string)
  let creds = cfg;
  if (cfg.service_account_json) {
    try { creds = { ...JSON.parse(cfg.service_account_json), bucket: cfg.bucket }; }
    catch { throw new Error('invalid_service_account_json'); }
  }
  const { project_id, client_email, private_key } = creds;
  if (!project_id || !client_email || !private_key) throw new Error('firebase_credentials_missing');
  const hash = cfgHash({ project_id, client_email, bucket: cfg.bucket });
  if (_app && _cfgHash === hash) return _app;
  // Reset if config changed
  if (_app) { try { _app.delete(); } catch {} _app = null; }
  _app = admin.initializeApp({
    credential: admin.credential.cert({
      projectId: project_id,
      clientEmail: client_email,
      privateKey: String(private_key).replace(/\\n/g, '\n'),
    }),
    storageBucket: cfg.bucket,
  }, 'lavandery-' + Date.now());
  _cfgHash = hash;
  return _app;
}

export async function firebaseTest(cfg) {
  try {
    const app = getApp(cfg);
    const bucket = admin.storage(app).bucket();
    const [exists] = await bucket.exists();
    if (!exists) return { ok: false, reason: 'bucket_not_found', bucket: cfg.bucket };
    return { ok: true, bucket: cfg.bucket, project: cfg.project_id };
  } catch (e) { return { ok: false, reason: String(e.message||e) }; }
}

export async function firebaseUpload(cfg, { key, body, contentType = 'image/jpeg', makePublic = false }) {
  const app = getApp(cfg);
  const bucket = admin.storage(app).bucket();
  const file = bucket.file(key);
  await file.save(body, {
    contentType,
    metadata: { contentType, cacheControl: 'public, max-age=31536000' },
    resumable: false,
    validation: false,
  });
  if (makePublic) {
    try { await file.makePublic(); } catch {}
    return { key, url: `https://storage.googleapis.com/${cfg.bucket}/${key}` };
  }
  // Default: signed URL that expires in 30 days
  const [signed] = await file.getSignedUrl({ action: 'read', expires: Date.now() + 30*24*60*60*1000 });
  return { key, url: signed, gs: `gs://${cfg.bucket}/${key}` };
}
