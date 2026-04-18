// Notification helpers: email (nodemailer — Microsoft 365 / generic SMTP) + WhatsApp (wa.me URL)
import nodemailer from 'nodemailer';

// Resolve SMTP config from DB integrations first, then .env.
// `getIntegrationFn` optional — called with ('smtp') and returns the object (or null).
function smtpConfig(getIntegrationFn) {
  const fromDb = typeof getIntegrationFn === 'function' ? getIntegrationFn('smtp') : null;
  const src = (fromDb && (fromDb.host || fromDb.user))
    ? { host: fromDb.host, port: fromDb.port, user: fromDb.user, pass: fromDb.pass, from: fromDb.from }
    : { host: process.env.SMTP_HOST, port: process.env.SMTP_PORT, user: process.env.SMTP_USER, pass: process.env.SMTP_PASS, from: process.env.SMTP_FROM };
  if (!src.host || !src.user || !src.pass) return null;
  const port = parseInt(src.port||'587', 10);
  return {
    host: src.host, port, secure: port === 465,
    auth: { user: src.user, pass: src.pass },
    from: src.from || src.user,
    // Microsoft 365 / Exchange Online use STARTTLS on 587 — nodemailer default works.
    // Require modern TLS to avoid downgrades.
    tls: { minVersion: 'TLSv1.2' },
  };
}

export async function sendEmail({ to, subject, text, html }, getIntegrationFn) {
  if (!to) return { sent: false, reason: 'no_recipient' };
  const cfg = smtpConfig(getIntegrationFn);
  if (!cfg) return { sent: false, reason: 'smtp_not_configured', to, subject };
  try {
    const transporter = nodemailer.createTransport({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, tls: cfg.tls });
    await transporter.sendMail({ from: cfg.from, to, subject, text, html });
    return { sent: true, to, subject };
  } catch (e) {
    return { sent: false, reason: String(e.message||e), to, subject };
  }
}

// WhatsApp: build wa.me URL (admin/user clicks to send). Requires phone with country code.
export function waLink({ phone, message }) {
  if (!phone) return null;
  const clean = String(phone).replace(/\D/g, '');
  const withCountry = clean.length === 10 || clean.length === 11 ? '55' + clean : clean;
  return `https://wa.me/${withCountry}?text=${encodeURIComponent(message||'')}`;
}


export function statusLabel(s) {
  return { aberto:'Aberto', em_andamento:'Em andamento', resolvido:'Resolvido', fechado:'Fechado' }[s] || s;
}

export function buildTicketMessage(ticket, condo, oldStatus, newStatus) {
  const lines = [
    `Olá! Aqui é da Lavandery.`,
    ``,
    `Atualização no chamado "${ticket.title}" do condomínio ${condo?.name||''}:`,
    `Status: ${statusLabel(oldStatus)} → ${statusLabel(newStatus)}`,
  ];
  if (ticket.resolution) lines.push(``, `Resolução: ${ticket.resolution}`);
  lines.push(``, `Protocolo: ${ticket.id}`);
  return lines.join('\n');
}
