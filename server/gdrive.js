// Google Drive uploader — usa uma conta de serviço + pasta compartilhada.
// Usuário cria pasta no Drive, compartilha com o e-mail do service account (Editor),
// cola o ID da pasta + o JSON do service account. Pronto — sem cobrança.
import { google } from 'googleapis';
import { Readable } from 'node:stream';

function parseCreds(cfg) {
  if (!cfg) return null;
  let creds = cfg;
  if (cfg.service_account_json) {
    try { creds = JSON.parse(cfg.service_account_json); }
    catch { throw new Error('invalid_service_account_json'); }
  }
  const { client_email, private_key } = creds;
  if (!client_email || !private_key) throw new Error('credentials_missing');
  return {
    client_email,
    private_key: String(private_key).replace(/\\n/g, '\n'),
    folder_id: cfg.folder_id,
  };
}

function driveClient(cfg) {
  const c = parseCreds(cfg);
  if (!c) throw new Error('not_configured');
  const auth = new google.auth.JWT(c.client_email, null, c.private_key, [
    'https://www.googleapis.com/auth/drive',
  ]);
  return { drive: google.drive({ version: 'v3', auth }), folderId: c.folder_id, email: c.client_email };
}

export async function driveTest(cfg) {
  try {
    const { drive, folderId, email } = driveClient(cfg);
    if (!folderId) return { ok: false, reason: 'missing_folder_id', service_account: email };
    // Tenta ler a pasta compartilhada — valida credenciais + ID + permissão
    const r = await drive.files.get({ fileId: folderId, fields: 'id,name,mimeType,owners' });
    return { ok: true, folder: r.data.name, id: r.data.id, service_account: email };
  } catch (e) {
    return { ok: false, reason: String(e.response?.data?.error?.message || e.message || e) };
  }
}

export async function driveUpload(cfg, { name, mimeType = 'image/jpeg', body }) {
  const { drive, folderId } = driveClient(cfg);
  if (!folderId) throw new Error('missing_folder_id');
  const stream = Buffer.isBuffer(body) ? Readable.from(body) : body;
  const { data } = await drive.files.create({
    requestBody: { name, parents: [folderId], mimeType },
    media: { mimeType, body: stream },
    fields: 'id, name, webViewLink, webContentLink',
  });
  // Garante que qualquer pessoa com link consegue ver (permissão reader)
  try {
    await drive.permissions.create({
      fileId: data.id,
      requestBody: { role: 'reader', type: 'anyone' },
    });
  } catch {}
  const directUrl = `https://drive.google.com/uc?export=view&id=${data.id}`;
  return { id: data.id, name: data.name, url: directUrl, view: data.webViewLink };
}
