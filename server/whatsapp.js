// WhatsApp via Baileys — unofficial, uses WhatsApp Web protocol directly
// Connect once via QR, session persists in ./wa-session/
import pino from 'pino';
import QRCode from 'qrcode';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Baileys is ESM — load lazily on first connect (dynamic import).
let _baileys = null;
async function loadBaileys() {
  if (_baileys) return _baileys;
  const m = await import('@whiskeysockets/baileys');
  _baileys = {
    makeWASocket: m.default || m.makeWASocket,
    useMultiFileAuthState: m.useMultiFileAuthState,
    DisconnectReason: m.DisconnectReason,
    fetchLatestBaileysVersion: m.fetchLatestBaileysVersion,
  };
  return _baileys;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_DIR = process.env.WA_SESSION_DIR || path.join(__dirname, 'wa-session');

let sock = null;
let currentQR = null;       // data URL (PNG) ready to render in <img>
let qrExpiresAt = null;
let status = 'disconnected'; // disconnected | connecting | qr | connected | error
let lastError = null;
let selfJid = null;
let stopping = false;

const log = pino({ level: process.env.WA_LOG_LEVEL || 'silent' });

export function waStatus() {
  return {
    status,
    qr: status === 'qr' ? currentQR : null,
    qr_expires_at: qrExpiresAt,
    me: selfJid,
    last_error: lastError,
  };
}

export async function waConnect() {
  if (sock && status === 'connected') return waStatus();
  if (status === 'connecting' || status === 'qr') return waStatus();
  stopping = false;
  if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
  const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = await loadBaileys();
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  status = 'connecting';
  lastError = null;
  sock = makeWASocket({
    version,
    auth: state,
    logger: log,
    printQRInTerminal: false,
    browser: ['Lavandery Admin', 'Chrome', '120.0'],
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      currentQR = await QRCode.toDataURL(qr, { margin: 1, width: 256 });
      qrExpiresAt = Date.now() + 60_000;
      status = 'qr';
    }
    if (connection === 'open') {
      currentQR = null; qrExpiresAt = null;
      selfJid = sock?.user?.id || null;
      status = 'connected';
      lastError = null;
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === _baileys.DisconnectReason.loggedOut;
      if (loggedOut) {
        status = 'disconnected';
        selfJid = null;
        // wipe session so next connect shows a fresh QR
        try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); } catch {}
      } else if (!stopping) {
        status = 'connecting';
        setTimeout(() => { try { waConnect(); } catch {} }, 2000);
      } else {
        status = 'disconnected';
      }
    }
  });
  return waStatus();
}

export async function waDisconnect({ wipeSession = false } = {}) {
  stopping = true;
  try { await sock?.logout?.(); } catch {}
  try { sock?.ws?.close?.(); } catch {}
  sock = null;
  status = 'disconnected';
  selfJid = null;
  currentQR = null;
  if (wipeSession) { try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); } catch {} }
  return waStatus();
}

function toJid(phone) {
  const clean = String(phone||'').replace(/\D/g, '');
  if (!clean) return null;
  const withCountry = clean.length === 10 || clean.length === 11 ? '55' + clean : clean;
  return `${withCountry}@s.whatsapp.net`;
}

export async function waSendText({ phone, message }) {
  if (status !== 'connected' || !sock) return { sent: false, reason: 'not_connected', status };
  const jid = toJid(phone);
  if (!jid) return { sent: false, reason: 'invalid_phone' };
  try {
    // Verify the number is on WhatsApp
    const check = await sock.onWhatsApp(jid).catch(()=>null);
    const exists = Array.isArray(check) && check.some(x => x.exists);
    if (!exists) return { sent: false, reason: 'not_on_whatsapp', jid };
    await sock.sendMessage(jid, { text: message });
    return { sent: true, jid };
  } catch (e) {
    lastError = String(e.message||e);
    return { sent: false, reason: lastError };
  }
}

// Auto-reconnect on boot if session exists
export async function waAutoStart() {
  try {
    if (fs.existsSync(path.join(SESSION_DIR, 'creds.json'))) {
      await waConnect();
    }
  } catch (e) { lastError = String(e.message||e); }
}
