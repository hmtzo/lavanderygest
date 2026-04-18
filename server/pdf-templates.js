// PDFs gerados server-side — 3 templates brandados Lavandery
import { jsPDF } from 'jspdf';

const BRAND = [83,60,157];      // #533C9D
const BRAND2 = [101,74,186];    // #654ABA
const LIGHT = [240,237,249];
const LIGHT2 = [224,219,241];
const INK = [28,25,45];
const MUTED = [110,108,130];
const OK = [22,163,74];
const DANGER = [220,38,38];

function fmt(d) { return d ? new Date(d).toLocaleString('pt-BR', { dateStyle:'long', timeStyle:'short' }) : '—'; }
function fmtDate(d) { return d ? new Date(d).toLocaleDateString('pt-BR') : '—'; }

function header(doc, subtitle) {
  const W = doc.internal.pageSize.getWidth();
  doc.setFillColor(...BRAND); doc.rect(0, 0, W, 110, 'F');
  // Purple glow
  doc.setFillColor(...BRAND2); doc.circle(W-60, 40, 90, 'F');
  // Logo circle
  doc.setFillColor(255,255,255); doc.roundedRect(40, 32, 40, 40, 8, 8, 'F');
  doc.setFont('helvetica','bold'); doc.setFontSize(22); doc.setTextColor(...BRAND);
  doc.text('L', 60, 60, { align:'center' });
  // Texts
  doc.setFont('helvetica','bold'); doc.setFontSize(10); doc.setTextColor(255,255,255);
  doc.text('LAVANDERY', 96, 52);
  doc.setFont('helvetica','normal'); doc.setFontSize(8); doc.setTextColor(...LIGHT);
  doc.text('Lavanderia compartilhada inteligente', 96, 64);
  doc.setFont('helvetica','bold'); doc.setFontSize(20); doc.setTextColor(255,255,255);
  doc.text(subtitle, 40, 100);
}

function footer(doc, id, pageNum, totalPages) {
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  doc.setDrawColor(230,228,240); doc.setLineWidth(0.5);
  doc.line(40, H-40, W-40, H-40);
  doc.setFont('helvetica','normal'); doc.setFontSize(8); doc.setTextColor(...MUTED);
  doc.text(`Documento ${id}`, 40, H-24);
  doc.text(`Página ${pageNum}${totalPages?' de '+totalPages:''}`, W/2, H-24, { align:'center' });
  doc.text(fmtDate(Date.now()), W-40, H-24, { align:'right' });
}

function condoBlock(doc, condo, impl, y) {
  const W = doc.internal.pageSize.getWidth();
  doc.setFillColor(252,251,255); doc.setDrawColor(...LIGHT2);
  doc.roundedRect(40, y, W-80, 100, 10, 10, 'FD');
  doc.setFont('helvetica','bold'); doc.setFontSize(14); doc.setTextColor(...INK);
  doc.text(condo.name || '—', 56, y+22);
  doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(...MUTED);
  const addr = [condo.address, condo.city, condo.cep].filter(Boolean).join(' · ');
  doc.text(addr || '—', 56, y+38);
  if (condo.cnpj) doc.text('CNPJ: '+condo.cnpj, 56, y+52);

  doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.setTextColor(...MUTED);
  doc.text('IMPLANTAÇÃO', 56, y+70);
  doc.text('SLA', W/2, y+70);
  doc.setFont('helvetica','normal'); doc.setFontSize(11); doc.setTextColor(...INK);
  doc.text(impl.id.slice(-8).toUpperCase(), 56, y+86);
  doc.text(fmtDate(impl.target_date), W/2, y+86);
  return y + 110;
}

function section(doc, title, y) {
  const W = doc.internal.pageSize.getWidth();
  doc.setFont('helvetica','bold'); doc.setFontSize(12); doc.setTextColor(...INK);
  doc.text(title, 40, y);
  doc.setDrawColor(...BRAND); doc.setLineWidth(1.4);
  doc.line(40, y+5, 68, y+5);
  doc.setDrawColor(240,237,249); doc.setLineWidth(0.6);
  doc.line(70, y+5, W-40, y+5);
  return y + 18;
}

function checkbox(doc, x, y, checked) {
  doc.setDrawColor(...INK); doc.setLineWidth(0.6);
  doc.roundedRect(x, y-8, 10, 10, 1, 1);
  if (checked) {
    doc.setDrawColor(...OK); doc.setLineWidth(1.8);
    doc.line(x+2, y-3, x+4, y);
    doc.line(x+4, y, x+8, y-6);
  }
}

function signatureBlock(doc, y, leftLabel, rightLabel) {
  const W = doc.internal.pageSize.getWidth();
  const half = (W-100)/2;
  doc.setDrawColor(...MUTED); doc.setLineWidth(0.5);
  doc.line(50, y, 50+half, y);
  doc.line(W-50-half, y, W-50, y);
  doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(...MUTED);
  doc.text(leftLabel, 50+half/2, y+12, { align:'center' });
  doc.text(rightLabel, W-50-half/2, y+12, { align:'center' });
}

// ---------- 1) Termo de entrega de máquinas ----------
export function generateDeliveryReceipt(impl, condo, machines = []) {
  const doc = new jsPDF({ unit:'pt', format:'a4' });
  const W = doc.internal.pageSize.getWidth();
  header(doc, 'Termo de entrega de equipamentos');

  let y = condoBlock(doc, condo, impl, 130);

  y = section(doc, 'Equipamentos entregues', y);
  doc.setFont('helvetica','normal'); doc.setFontSize(11); doc.setTextColor(...INK);
  const washers = condo.washers || 0, dryers = condo.dryers || 0;
  const list = [
    { name: 'Lavadoras', qty: washers },
    { name: 'Secadoras', qty: dryers },
    { name: 'Dosadoras', qty: Math.max(1, Math.floor((washers+dryers)/2)) },
  ];
  list.forEach(it => {
    checkbox(doc, 50, y+10, true);
    doc.text(`${it.qty} × ${it.name}`, 68, y+10);
    y += 20;
  });
  (machines||[]).forEach(m => {
    doc.setFontSize(9); doc.setTextColor(...MUTED);
    doc.text(`• ${m.code} (${m.type}${m.brand?' · '+m.brand:''}${m.capacity?' · '+m.capacity:''})`, 68, y);
    y += 14;
  });

  y += 10;
  y = section(doc, 'Declaração', y);
  doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(...INK);
  const decl = `Declaramos que os equipamentos listados acima foram entregues em perfeito estado de funcionamento ao CONDOMÍNIO, sob responsabilidade da LAVANDERY (INOVA TECNOLOGIA E SERVIÇOS E REPRESENTAÇÃO LTDA, CNPJ 45.061.358/0001-62), em regime de comodato, conforme contrato vigente.`;
  doc.text(doc.splitTextToSize(decl, W-80), 40, y);
  y += 70;

  doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(...MUTED);
  doc.text(`Entrega realizada em: ${fmtDate(Date.now())}`, 40, y);

  y = Math.max(y, doc.internal.pageSize.getHeight() - 110);
  signatureBlock(doc, y, 'Responsável Lavandery', 'Responsável pelo condomínio');
  footer(doc, impl.id.slice(-8).toUpperCase(), 1);
  return Buffer.from(doc.output('arraybuffer'));
}

// ---------- 2) Checklist de vistoria técnica ----------
export function generateSurveyChecklist(impl, condo, surveyStep) {
  const doc = new jsPDF({ unit:'pt', format:'a4' });
  header(doc, 'Checklist de vistoria técnica');

  let y = condoBlock(doc, condo, impl, 130);

  y = section(doc, 'Itens vistoriados', y);
  const items = (surveyStep?.items) || [];
  if (!items.length) {
    doc.setFont('helvetica','italic'); doc.setFontSize(10); doc.setTextColor(...MUTED);
    doc.text('Nenhum item registrado. Use o app mobile para preencher a vistoria técnica.', 40, y+10);
    y += 30;
  } else {
    doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(...INK);
    items.forEach((it) => {
      checkbox(doc, 50, y+8, !!it.done);
      doc.text(it.title, 68, y+8);
      if (it.completed_at) {
        doc.setTextColor(...OK); doc.setFontSize(8);
        doc.text(`✓ ${fmt(it.completed_at)}`, 68, y+20);
        doc.setFontSize(10); doc.setTextColor(...INK);
      }
      if (it.note) {
        doc.setFontSize(9); doc.setTextColor(...MUTED);
        doc.text(doc.splitTextToSize('Obs: '+it.note, W-120), 68, y+ (it.completed_at ? 32 : 22));
        doc.setFontSize(10); doc.setTextColor(...INK);
        y += 10;
      }
      y += it.completed_at ? 28 : 22;
      if (y > 720) { footer(doc, impl.id.slice(-8).toUpperCase(), 1); doc.addPage(); y = 60; }
    });
  }

  y += 20;
  const W = doc.internal.pageSize.getWidth();
  y = Math.max(y, doc.internal.pageSize.getHeight() - 110);
  signatureBlock(doc, y, 'Técnico Lavandery', 'Responsável pelo condomínio');
  footer(doc, impl.id.slice(-8).toUpperCase(), 1);
  return Buffer.from(doc.output('arraybuffer'));
}

// ---------- 4) Termo de entrega de equipamentos (módulo dedicado) ----------
export function generateEquipmentDeliveryTerm(d) {
  const doc = new jsPDF({ unit:'pt', format:'a4' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  header(doc, 'Termo de entrega de equipamentos');

  let y = 130;

  // Contratada (fixa)
  y = section(doc, 'CONTRATADA', y);
  doc.setFont('helvetica','bold'); doc.setFontSize(12); doc.setTextColor(...INK);
  doc.text('LAVANDERY', 40, y+12);
  doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(...MUTED);
  doc.text('(INOVA TECNOLOGIA E SERVIÇOS E REPRESENTAÇÃO LTDA.)', 40, y+28);
  doc.text('CNPJ: 45.061.358/0001-62', 40, y+42);
  y += 60;

  // Contratante
  y = section(doc, 'CONTRATANTE', y);
  doc.setFont('helvetica','bold'); doc.setFontSize(11); doc.setTextColor(...INK);
  doc.text(d.condo_name || '—', 40, y+12);
  doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(...MUTED);
  if (d.condo_cnpj) doc.text('CNPJ: ' + d.condo_cnpj, 40, y+26);
  if (d.condo_address) {
    const addr = doc.splitTextToSize('Endereço: ' + d.condo_address, W-80);
    doc.text(addr, 40, y+40);
    y += 40 + addr.length*12;
  } else { y += 40; }

  // Responsável
  y = section(doc, 'RESPONSÁVEL PELO RECEBIMENTO', y);
  doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(...INK);
  doc.text(`Nome: ${d.responsible_name||'—'}`, 40, y+12);
  doc.text(`CPF: ${d.responsible_cpf||'—'}`, 40, y+26);
  doc.text(`Telefone: ${d.responsible_phone||'—'}`, 40, y+40);
  y += 56;

  // Dados da entrega
  y = section(doc, 'DADOS DA ENTREGA', y);
  doc.text(`Data: ${d.delivery_date ? new Date(d.delivery_date).toLocaleDateString('pt-BR') : '—'}`, 40, y+12);
  doc.text(`Hora: ${d.delivery_time || '—'}`, 200, y+12);
  doc.text(`Local da instalação: ${d.delivery_location || '—'}`, 40, y+28);
  y += 46;

  // Equipamentos
  y = section(doc, 'EQUIPAMENTOS ENTREGUES', y);
  doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(...INK);
  const brand = d.equipment_brand || 'Speed Queen';
  doc.text(`Marca: ${brand}`, 40, y+12);
  doc.text(`Definição do conjunto: 1 lavadora + 1 secadora`, 40, y+26);
  doc.setFont('helvetica','bold');
  doc.text(`Quantidade de conjuntos: ${d.conjuntos_qty||0}`, 40, y+44);
  doc.setFont('helvetica','normal');
  doc.text(`Valor unitário por conjunto: R$ ${(d.unit_value||53000).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2})}`, 40, y+58);
  doc.setFont('helvetica','bold'); doc.setTextColor(...BRAND);
  doc.text(`Valor total: R$ ${(d.total_value||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2})}`, 40, y+74);
  doc.setTextColor(...INK);
  y += 94;

  // Condição
  y = section(doc, 'CONDIÇÃO DOS EQUIPAMENTOS', y);
  doc.setFont('helvetica','normal'); doc.setFontSize(10);
  const conds = [
    ['Novos', !!d.condition_new],
    ['Sem avarias aparentes', !!d.condition_no_damage],
    ['Testados', !!d.condition_tested],
  ];
  conds.forEach(([label, checked], i) => {
    checkbox(doc, 50, y+12+i*18, checked);
    doc.text(label, 68, y+12+i*18);
  });
  y += 72;

  if (d.notes) {
    y = section(doc, 'OBSERVAÇÕES', y);
    const split = doc.splitTextToSize(d.notes, W-80);
    doc.text(split, 40, y+10);
    y += 10 + split.length*12 + 10;
  }

  // Quebra página se não couber declaração + assinatura
  if (y > H - 260) { footer(doc, d.id.slice(-8).toUpperCase(), 1); doc.addPage(); y = 60; }

  // Declaração
  y = section(doc, 'DECLARAÇÃO', y);
  doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(...INK);
  const decl = '"O CONDOMÍNIO / CONTRATANTE declara, para os devidos fins, que recebeu nesta data os equipamentos acima descritos em perfeito estado de conservação e funcionamento, comprometendo-se com sua guarda, zelo e uso adequado, ficando ciente de que os bens permanecem de propriedade da LAVANDERY (INOVA TECNOLOGIA E SERVIÇOS E REPRESENTAÇÃO LTDA.)."';
  const declLines = doc.splitTextToSize(decl, W-80);
  doc.text(declLines, 40, y+10);
  y += 10 + declLines.length*12 + 20;

  // Assinatura
  y = section(doc, 'ASSINATURA DO RESPONSÁVEL', y);
  const sigW = 260, sigH = 80;
  const sigX = (W-sigW)/2;
  doc.setDrawColor(...MUTED); doc.setLineWidth(0.5);
  doc.roundedRect(sigX, y+10, sigW, sigH, 6, 6);
  if (d.signature_data_url) {
    try { doc.addImage(d.signature_data_url, 'PNG', sigX+4, y+14, sigW-8, sigH-8); } catch {}
  }
  // linha abaixo
  doc.line(sigX, y+10+sigH+12, sigX+sigW, y+10+sigH+12);
  doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(...INK);
  doc.text(d.responsible_name || '—', W/2, y+10+sigH+26, { align:'center' });
  doc.setFontSize(8); doc.setTextColor(...MUTED);
  doc.text('Responsável pelo recebimento', W/2, y+10+sigH+38, { align:'center' });

  // Rodapé customizado (substitui o footer padrão)
  const finalizedAt = d.finalized_at || Date.now();
  doc.setDrawColor(230,228,240); doc.setLineWidth(0.5);
  doc.line(40, H-48, W-40, H-48);
  doc.setFont('helvetica','normal'); doc.setFontSize(8); doc.setTextColor(...MUTED);
  doc.text(`Documento gerado automaticamente pelo sistema Lavandery.`, 40, H-32);
  doc.text(`Entrega ${d.id.slice(-8).toUpperCase()} · Data de geração: ${new Date(finalizedAt).toLocaleString('pt-BR')}`, 40, H-18);
  return Buffer.from(doc.output('arraybuffer'));
}

// ---------- 3) Relatório de instalação ----------
export function generateInstallationReport(impl, condo) {
  const doc = new jsPDF({ unit:'pt', format:'a4' });
  const W = doc.internal.pageSize.getWidth();
  header(doc, 'Relatório de instalação');

  let y = condoBlock(doc, condo, impl, 130);

  // Progress overview
  y = section(doc, 'Resumo', y);
  const total = impl.steps?.length || 0;
  const done = (impl.steps||[]).filter(s=>s.completed).length;
  const pct = total ? Math.round(done/total*100) : 0;
  doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(...INK);
  doc.text(`Progresso: ${done}/${total} etapas concluídas (${pct}%)`, 40, y+12);
  doc.text(`Contrato assinado em: ${fmtDate(impl.contract_signed_at)}`, 40, y+28);
  doc.text(`Prazo contratual (SLA 60 dias): ${fmtDate(impl.target_date)}`, 40, y+44);
  doc.text(`Concluída em: ${fmtDate(impl.completed_at)}`, 40, y+60);
  // Progress bar
  doc.setFillColor(...LIGHT); doc.roundedRect(40, y+74, W-80, 8, 4, 4, 'F');
  doc.setFillColor(...BRAND); doc.roundedRect(40, y+74, (W-80)*(pct/100), 8, 4, 4, 'F');
  y += 100;

  // Etapas
  y = section(doc, 'Etapas da implantação', y);
  (impl.steps||[]).forEach(s => {
    if (y > 720) { footer(doc, impl.id.slice(-8).toUpperCase(), doc.internal.getNumberOfPages()); doc.addPage(); y = 60; }
    const color = s.completed ? OK : s.status === 'em_andamento' ? [245,158,11] : MUTED;
    checkbox(doc, 50, y+8, !!s.completed);
    doc.setFont('helvetica','bold'); doc.setFontSize(10); doc.setTextColor(...INK);
    doc.text(`${s.step_number}. ${s.title}`, 68, y+8);
    doc.setFont('helvetica','normal'); doc.setFontSize(8); doc.setTextColor(...color);
    doc.text((s.status || (s.completed?'concluida':'pendente')).toUpperCase(), W-80, y+8, { align:'right' });
    const totalItems = s.items?.length||0;
    const doneItems = (s.items||[]).filter(i=>i.done).length;
    if (totalItems) {
      doc.setTextColor(...MUTED); doc.setFontSize(8);
      doc.text(`${doneItems}/${totalItems} itens`, 68, y+20);
      y += 28;
    } else y += 20;
    if (s.completed_at) {
      doc.setTextColor(...OK); doc.setFontSize(8);
      doc.text(`✓ Concluída em ${fmt(s.completed_at)}`, 68, y);
      y += 12;
    }
  });

  y += 20;
  if (y > doc.internal.pageSize.getHeight() - 120) { footer(doc, impl.id.slice(-8).toUpperCase(), doc.internal.getNumberOfPages()); doc.addPage(); y = 60; }
  y = Math.max(y, doc.internal.pageSize.getHeight() - 110);
  signatureBlock(doc, y, 'Técnico Lavandery', 'Responsável pelo condomínio');
  footer(doc, impl.id.slice(-8).toUpperCase(), doc.internal.getNumberOfPages());
  return Buffer.from(doc.output('arraybuffer'));
}
