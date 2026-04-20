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

// ---------- 1) Termo de entrega (delega pro template oficial Lavandery) ----------
export function generateDeliveryReceipt(impl, condo, machines = []) {
  const washers = condo.washers || (machines||[]).filter(m=>m.type==='Lavadora').length || 0;
  const dryers = condo.dryers || (machines||[]).filter(m=>m.type==='Secadora').length || 0;
  // Usa o número de conjuntos = min(lavadoras, secadoras). Cada conjunto = 1 lav + 1 sec.
  const conjuntos = Math.max(1, Math.min(washers, dryers) || Math.max(washers, dryers) || 1);
  const unitValue = 52000;
  return generateEquipmentDeliveryTerm({
    id: impl.id || ('impl_' + Date.now()),
    condo_name: (condo.name||'').toUpperCase(),
    condo_cnpj: condo.cnpj || '',
    condo_address: [condo.address, condo.city, condo.cep].filter(Boolean).join(' · '),
    conjuntos_qty: conjuntos,
    unit_value: unitValue,
    total_value: unitValue * conjuntos,
    equipment_brand: 'SPEED QUEEN',
    condition_new: true,
    delivery_date: impl.completed_at || Date.now(),
    finalized_at: Date.now(),
    responsible_name: '',
    signature_data_url: null,
  });
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
  const margin = 50;
  const contentW = W - 2*margin;

  // Cabeçalho Lavandery (barra roxa com logo)
  doc.setFillColor(...BRAND); doc.rect(0, 0, W, 70, 'F');
  doc.setTextColor(255); doc.setFont('helvetica','bold'); doc.setFontSize(20);
  doc.text('LAVANDERY', margin, 40);
  doc.setFont('helvetica','normal'); doc.setFontSize(10);
  doc.text('Inova Tecnologia e Serviços e Representação Ltda.', margin, 56);

  // Título centralizado
  let y = 110;
  doc.setTextColor(...INK);
  doc.setFont('helvetica','bold'); doc.setFontSize(16);
  doc.text('TERMO DE ENTREGA DE CONJUNTOS DE MÁQUINAS', W/2, y, { align:'center' });
  y += 20;
  doc.setFont('helvetica','normal'); doc.setFontSize(11); doc.setTextColor(...MUTED);
  doc.text('Lavanderia Compartilhada — Regime de Comodato', W/2, y, { align:'center' });
  y += 24;

  // Linha divisória
  doc.setDrawColor(...LIGHT); doc.setLineWidth(1);
  doc.line(margin, y, W-margin, y);
  y += 20;

  // Bloco CONTRATADA
  doc.setFont('helvetica','bold'); doc.setFontSize(11); doc.setTextColor(...BRAND);
  doc.text('CONTRATADA', margin, y); y += 16;
  doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(...INK);
  const contratadaText = 'INOVA TECNOLOGIA E SERVIÇOS E REPRESENTAÇÃO LTDA, inscrita no CNPJ sob nº 45.061.358/0001-62, com sede na Rua Califórnia, 40 — Santana de Parnaíba/SP, doravante denominada LAVANDERY, neste ato representada por seu sócio Heitor Henrique Alves Pereira.';
  const cLines = doc.splitTextToSize(contratadaText, contentW);
  doc.text(cLines, margin, y);
  y += cLines.length * 14 + 18;

  // Linha divisória
  doc.setDrawColor(...LIGHT); doc.line(margin, y, W-margin, y); y += 16;

  // Bloco CONTRATANTE
  doc.setFont('helvetica','bold'); doc.setFontSize(11); doc.setTextColor(...BRAND);
  doc.text('CONTRATANTE', margin, y); y += 16;
  doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(...INK);
  const condoName = (d.condo_name || '—').toUpperCase();
  const cnpjStr = d.condo_cnpj ? `${condoName}, inscrito no CNPJ sob nº ${d.condo_cnpj}, neste ato representado por seu síndico(a) ou representante legal, conforme contrato firmado entre as partes.` : `${condoName}, neste ato representado por seu síndico(a) ou representante legal, conforme contrato firmado entre as partes.`;
  const ctLines = doc.splitTextToSize(cnpjStr, contentW);
  doc.text(ctLines, margin, y);
  y += ctLines.length * 14 + 20;

  // Seção 1 — OBJETO
  y = sectionNum(doc, '1.', 'OBJETO', y, margin);
  doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(...INK);
  const obj = 'O presente Termo formaliza a entrega, instalação e disponibilização para uso de equipamentos de lavanderia compartilhada fornecidos pela CONTRATADA em regime de comodato.';
  const objLines = doc.splitTextToSize(obj, contentW);
  doc.text(objLines, margin, y);
  y += objLines.length * 14 + 14;

  // Seção 2 — EQUIPAMENTOS ENTREGUES
  y = sectionNum(doc, '2.', 'EQUIPAMENTOS ENTREGUES', y, margin);
  doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(...INK);
  doc.text('Foram entregues e devidamente instalados:', margin, y); y += 16;
  const qty = d.conjuntos_qty || 0;
  const qtyExt = numberToPortuguese(qty);
  const brand = (d.equipment_brand || 'SPEED QUEEN').toUpperCase();
  const bulletX = margin + 14;
  [
    `${String(qty).padStart(2,'0')} (${qtyExt}) conjuntos de máquinas de lavar e secar roupas`,
    `Marca: ${brand}`,
    `Estado: ${d.condition_new ? 'Novos' : 'Em bom estado'}`,
    `Propriedade: LAVANDERY`,
  ].forEach(line => {
    doc.text('•', bulletX, y);
    doc.text(line, bulletX + 12, y);
    y += 14;
  });
  y += 10;

  // Seção 3 — VALOR PATRIMONIAL
  y = sectionNum(doc, '3.', 'VALOR PATRIMONIAL', y, margin);
  doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(...INK);
  const unitValue = d.unit_value || 52000;
  const totalValue = d.total_value || (unitValue * qty);
  const fmt = n => 'R$ ' + (+n||0).toLocaleString('pt-BR', {minimumFractionDigits:2, maximumFractionDigits:2});
  doc.text('•', bulletX, y); doc.text(`Valor unitário por conjunto: ${fmt(unitValue)}`, bulletX + 12, y); y += 14;
  doc.setFont('helvetica','bold');
  doc.text('•', bulletX, y); doc.text(`Valor total dos ${String(qty).padStart(2,'0')} conjuntos: ${fmt(totalValue)}`, bulletX + 12, y); y += 18;
  doc.setFont('helvetica','normal'); doc.setTextColor(...MUTED);
  const note = 'Os valores acima possuem natureza exclusivamente patrimonial, para fins de responsabilidade civil, indenização por dano, furto ou sinistro, não caracterizando venda ou transferência de propriedade.';
  const nLines = doc.splitTextToSize(note, contentW);
  doc.text(nLines, margin, y);
  y += nLines.length * 13 + 14;

  // Verifica se precisa quebrar página
  if (y > H - 320) { doc.addPage(); y = 50; }

  // Seção 4 — DECLARAÇÃO DE INSTALAÇÃO
  y = sectionNum(doc, '4.', 'DECLARAÇÃO DE INSTALAÇÃO', y, margin);
  doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(...INK);
  doc.text('A CONTRATADA declara que:', margin, y); y += 16;
  [
    'Os equipamentos foram devidamente instalados;',
    'Foram realizados testes operacionais;',
    'As máquinas encontram-se em pleno funcionamento;',
    'Estão aptas para operação conforme especificação técnica.',
  ].forEach(line => { doc.text('•', bulletX, y); doc.text(line, bulletX + 12, y); y += 14; });
  y += 10;

  // Seção 5 — RESPONSABILIDADE
  y = sectionNum(doc, '5.', 'RESPONSABILIDADE', y, margin);
  doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(...INK);
  const resp = 'Os equipamentos permanecem de propriedade exclusiva da LAVANDERY durante todo o período contratual, cabendo ao CONDOMÍNIO zelar pela integridade física dos equipamentos instalados em suas dependências.';
  const rLines = doc.splitTextToSize(resp, contentW);
  doc.text(rLines, margin, y);
  y += rLines.length * 14 + 14;

  // Seção 6 — DECLARAÇÃO DE RECEBIMENTO
  y = sectionNum(doc, '6.', 'DECLARAÇÃO DE RECEBIMENTO', y, margin);
  doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(...INK);
  const decl = 'O CONDOMÍNIO declara que recebeu os equipamentos acima descritos em perfeito estado de funcionamento, nada tendo a reclamar quanto à instalação e operacionalidade inicial.';
  const dLines = doc.splitTextToSize(decl, contentW);
  doc.text(dLines, margin, y);
  y += dLines.length * 14 + 18;

  // Local e data
  if (y > H - 220) { doc.addPage(); y = 50; }
  const deliveryDate = d.delivery_date ? new Date(d.delivery_date) : new Date();
  const dia = String(deliveryDate.getDate()).padStart(2,'0');
  const meses = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
  const mes = meses[deliveryDate.getMonth()];
  const ano = deliveryDate.getFullYear();
  doc.setFont('helvetica','normal'); doc.setFontSize(11); doc.setTextColor(...INK);
  doc.text(`São Paulo, ${dia} de ${mes} de ${ano}.`, W/2, y, { align:'center' });
  y += 40;

  // Assinaturas
  const sigY = Math.max(y, H - 180);
  const sigW = 220;

  // CONTRATADA (esquerda)
  const leftX = margin + 30;
  doc.setDrawColor(...INK); doc.setLineWidth(0.8);
  doc.line(leftX, sigY + 60, leftX + sigW, sigY + 60);
  doc.setFont('helvetica','bold'); doc.setFontSize(10); doc.setTextColor(...INK);
  doc.text('CONTRATADA', leftX + sigW/2, sigY + 76, { align:'center' });
  doc.setFont('helvetica','normal'); doc.setFontSize(8); doc.setTextColor(...MUTED);
  doc.text('INOVA TECNOLOGIA E SERVIÇOS', leftX + sigW/2, sigY + 90, { align:'center' });
  doc.text('E REPRESENTAÇÃO LTDA', leftX + sigW/2, sigY + 102, { align:'center' });

  // CONTRATANTE (direita)
  const rightX = W - margin - sigW - 30;
  doc.setDrawColor(...INK);
  doc.line(rightX, sigY + 60, rightX + sigW, sigY + 60);
  if (d.signature_data_url) {
    try { doc.addImage(d.signature_data_url, 'PNG', rightX + 10, sigY, sigW - 20, 60); } catch {}
  }
  doc.setFont('helvetica','bold'); doc.setFontSize(10); doc.setTextColor(...INK);
  doc.text('CONTRATANTE', rightX + sigW/2, sigY + 76, { align:'center' });
  doc.setFont('helvetica','normal'); doc.setFontSize(8); doc.setTextColor(...MUTED);
  const condoSigName = doc.splitTextToSize(condoName, sigW - 20);
  doc.text(condoSigName, rightX + sigW/2, sigY + 90, { align:'center' });
  if (d.responsible_name) {
    doc.text(d.responsible_name, rightX + sigW/2, sigY + 90 + condoSigName.length*10, { align:'center' });
  }

  // Rodapé
  doc.setDrawColor(...LIGHT); doc.setLineWidth(0.5);
  doc.line(margin, H-40, W-margin, H-40);
  doc.setFont('helvetica','normal'); doc.setFontSize(8); doc.setTextColor(...MUTED);
  doc.text(`Documento gerado pelo sistema Lavandery · ID: ${(d.id||'').slice(-8).toUpperCase()}`, margin, H-26);
  doc.text(new Date(d.finalized_at || Date.now()).toLocaleString('pt-BR'), W-margin, H-26, { align:'right' });
  return Buffer.from(doc.output('arraybuffer'));
}

// Helper: seção numerada
function sectionNum(doc, num, title, y, margin) {
  doc.setFont('helvetica','bold'); doc.setFontSize(11); doc.setTextColor(...BRAND);
  doc.text(`${num} ${title}`, margin, y);
  return y + 18;
}

// Helper: número por extenso (1–20) pra português
function numberToPortuguese(n) {
  const map = ['zero','um','dois','três','quatro','cinco','seis','sete','oito','nove','dez','onze','doze','treze','quatorze','quinze','dezesseis','dezessete','dezoito','dezenove','vinte'];
  return map[n] || String(n);
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
