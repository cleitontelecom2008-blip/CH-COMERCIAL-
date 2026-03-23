/**
 * @fileoverview CH Geladas PDV — Financeiro Module v6.0.0
 *
 * v6: dataCurta agora sempre armazenada em ISO (YYYY-MM-DD).
 *     Lógica de conversão DD/MM↔ISO eliminada — código 60% mais simples.
 *     Backward-compat: _dataVenda() ainda suporta registros legados DD/MM.
 */
'use strict';

/* ═══════════════════════════════════════════════════════════════════
   FINANCE CALC — Agregações por período
═══════════════════════════════════════════════════════════════════ */
const FinanceCalc = (() => {

  /* ─── Helpers de data (todos retornam YYYY-MM-DD) ─────────── */

  /**
   * Retorna data ISO local sem conversão UTC.
   * Usa Utils.todayISO() para consistência com o resto do app.
   * @param {Date} [date]
   * @returns {string} YYYY-MM-DD
   */
  function _localISO(date) {
    if (!date) return Utils.todayISO();
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  /**
   * "Hoje" para filtros financeiros.
   * Turno noturno: se o caixa foi aberto ontem e ainda está aberto,
   * "hoje" é a data de abertura — vendas da madrugada ficam no dia certo.
   * @returns {string} YYYY-MM-DD
   */
  function _hoje() {
    const ultimoCaixa = Store.Selectors.getUltimoCaixa();
    if (ultimoCaixa?.tipo === 'ABERTURA' && ultimoCaixa.data) {
      // Suporte legado: caixa aberto pode ter data DD/MM/YYYY ou YYYY-MM-DD
      const raw = ultimoCaixa.data;
      if (raw.includes('/')) {
        const [d, m, y] = raw.split('/');
        if (y) return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
      }
      // Já é ISO
      if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
    }
    return Utils.todayISO();
  }

  /** Início da semana (segunda-feira, padrão BR/EU). @returns {string} YYYY-MM-DD */
  function _semanaInicio() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    const dia  = d.getDay();                    // 0=Dom … 6=Sáb
    d.setDate(d.getDate() - (dia === 0 ? 6 : dia - 1));
    return _localISO(d);
  }

  /** Início do mês atual. @returns {string} YYYY-MM-DD */
  function _mesInicio() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  }

  /** Início do ano atual. @returns {string} YYYY-MM-DD */
  function _anoInicio() { return `${new Date().getFullYear()}-01-01`; }

  /**
   * Extrai a data de uma venda como YYYY-MM-DD para comparações ISO.
   * Backward-compat: suporta registros antigos com dataCurta em DD/MM/YYYY.
   * @param {object} v
   * @returns {string} YYYY-MM-DD
   */
  function _dataVenda(v) {
    const raw = v.dataCurta || (v.data || '').slice(0, 10) || '';

    // Novo formato ISO (YYYY-MM-DD) — maioria dos registros v6+
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);

    // Legado: DD/MM/YYYY — registros anteriores ao v6
    if (raw.includes('/')) {
      const [d, m, y] = raw.split('/');
      return y ? `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}` : '';
    }

    return raw.slice(0, 10);
  }

  function filtrarPorPeriodo(periodo) {
    const todas = Store.Selectors.getVendas();
    if (periodo === 'geral') return [...todas];
    const inicio = { hoje: _hoje(), semana: _semanaInicio(), mes: _mesInicio(), ano: _anoInicio() }[periodo];
    return todas.filter(v => _dataVenda(v) >= inicio);
  }

  function agregarSubPeriodo(periodo, vendas) {
    const grupos = {};
    const MESES  = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
    const DIAS   = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];

    vendas.forEach(v => {
      const data = _dataVenda(v);
      let chave;
      if (periodo === 'hoje') {
        chave = `${(v.hora || '00:00').slice(0,2)}:00`;
      } else if (periodo === 'semana') {
        const d = new Date(data + 'T00:00:00');
        chave = `${DIAS[d.getDay()]} ${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}`;
      } else if (periodo === 'mes') {
        chave = data.slice(8,10) ? `Dia ${data.slice(8,10)}` : 'Dia --';
      } else {
        const m = parseInt(data.slice(5,7), 10) - 1;
        chave = isNaN(m) ? '—' : `${MESES[m]} ${data.slice(0,4)}`;
      }
      if (!grupos[chave]) grupos[chave] = { label: chave, vendas: 0, bruto: 0, lucro: 0 };
      grupos[chave].vendas++;
      grupos[chave].bruto += v.total || 0;
      grupos[chave].lucro += v.lucro || 0;
    });

    // FIX: ordenar cronologicamente, não lexicograficamente.
    // 'hoje'  → "HH:00"        → string de 5 chars, localeCompare é correto aqui.
    // 'semana'→ "Seg 03/03"    → usar data embutida no label (DD/MM).
    // 'mes'   → "Dia 07"       → extrair número do dia.
    // 'ano','geral' → "Jan 2026" → converter mês abreviado + ano para índice.
    const MESES_ABR = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
    return Object.values(grupos).sort((a, b) => {
      if (periodo === 'hoje') {
        return a.label.localeCompare(b.label); // "08:00" < "22:00" → correto
      }
      if (periodo === 'semana') {
        // label: "Seg 03/03" — extrai DD/MM e converte para timestamp comparável
        const parteA = a.label.split(' ')[1] || ''; // "03/03"
        const parteB = b.label.split(' ')[1] || '';
        const [dA, mA] = parteA.split('/').map(Number);
        const [dB, mB] = parteB.split('/').map(Number);
        const tsA = mA * 100 + dA; // ex: 303
        const tsB = mB * 100 + dB;
        return tsA - tsB;
      }
      if (periodo === 'mes') {
        // label: "Dia 07" → extrai o número
        return parseInt(a.label.split(' ')[1] || '0') - parseInt(b.label.split(' ')[1] || '0');
      }
      // periodo === 'ano' | 'geral' → label: "Jan 2026"
      const [maA, yaA] = a.label.split(' ');
      const [maB, yaB] = b.label.split(' ');
      const yearDiff = parseInt(yaA || '0') - parseInt(yaB || '0');
      if (yearDiff !== 0) return yearDiff;
      return MESES_ABR.indexOf(maA) - MESES_ABR.indexOf(maB);
    });
  }

  function calcularKPIsGlobais() {
    const todas = Store.Selectors.getVendas();
    const inv   = Store.Selectors.getInvestimento();
    // FIX: usar v.total (já com desconto aplicado) e v.lucro (já com desconto) — ambos gravados corretamente no checkout
    const bruto = todas.reduce((a, v) => a + (v.total || 0), 0);
    const lucro = todas.reduce((a, v) => {
      const l = v.lucro || 0;
      // Sanidade: lucro não pode exceder receita da venda
      return a + Math.min(l, v.total || 0);
    }, 0);
    return {
      bruto, lucro, inv,
      roi:               inv > 0 ? (lucro / inv) * 100 : null,
      breakEvenAtingido: inv > 0 && lucro >= inv,
      breakEvenRestante: Math.max(0, inv - lucro),
    };
  }

  function calcularKPIsPeriodo(vendas) {
    const bruto    = vendas.reduce((a, v) => a + (v.total || 0), 0);
    // FIX: lucro limitado ao total da venda (sanidade)
    const lucro    = vendas.reduce((a, v) => a + Math.min(v.lucro || 0, v.total || 0), 0);
    const qtd      = vendas.length;
    const delivery = vendas.filter(v => v.origem === 'DELIVERY').reduce((a, v) => a + (v.total || 0), 0);
    const comanda  = vendas.filter(v => v.origem === 'COMANDA').reduce((a, v)  => a + (v.total || 0), 0);
    return {
      bruto, lucro, qtd,
      ticket:       qtd > 0 ? bruto / qtd : 0,
      margem:       bruto > 0 ? Math.min(100, (lucro / bruto) * 100) : 0,
      delivery,     deliveryPerc: bruto > 0 ? (delivery / bruto) * 100 : 0,
      comanda,      comandaPerc:  bruto > 0 ? (comanda  / bruto) * 100 : 0,
    };
  }

  /**
   * Converte data ISO (YYYY-MM-DD) para exibição DD/MM/AAAA.
   * Centralizado aqui — substituiu várias funções espalhadas.
   * @param {string} iso YYYY-MM-DD
   * @returns {string} DD/MM/AAAA
   */
  function _isoToDisplay(iso) {
    if (!iso || !iso.includes('-')) return iso;
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y}`;
  }

  function labelPeriodo(periodo) {
    const hoje       = new Date();
    const MESES_FULL = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
                        'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

    if (periodo === 'hoje') {
      // Turno noturno: usa data de abertura do caixa se diferente de hoje
      const hojeISO = _hoje();
      const isTurno = hojeISO !== Utils.todayISO();
      return `${isTurno ? 'Turno' : 'Hoje'} · ${_isoToDisplay(hojeISO)}`;
    }
    if (periodo === 'semana') {
      return `Semana · ${_isoToDisplay(_semanaInicio())} – ${_isoToDisplay(Utils.todayISO())}`;
    }
    if (periodo === 'mes')  return `Mês · ${MESES_FULL[hoje.getMonth()]} ${hoje.getFullYear()}`;
    if (periodo === 'ano')  return `Ano · ${hoje.getFullYear()}`;
    return 'Geral · Histórico completo';
  }

  function labelSubPeriodo(periodo) {
    return { hoje:'Por hora', semana:'Por dia', mes:'Por dia', ano:'Por mês', geral:'Por mês' }[periodo] || '';
  }

  return Object.freeze({ filtrarPorPeriodo, agregarSubPeriodo, calcularKPIsGlobais, calcularKPIsPeriodo, labelPeriodo, labelSubPeriodo });
})();


/* ═══════════════════════════════════════════════════════════════════
   FINANCE EXPORT — Exportação detalhada por período
═══════════════════════════════════════════════════════════════════ */
const FinanceExport = (() => {
  const _f = s => `"${String(s ?? '').replace(/"/g, '""')}"`;

  function exportarTXT(periodo) {
    const vendas = FinanceCalc.filtrarPorPeriodo(periodo);
    if (!vendas.length) { UIService.showToast('Aviso', 'Sem vendas no período', 'warning'); return; }

    const kpis  = FinanceCalc.calcularKPIsPeriodo(vendas);
    const subs  = FinanceCalc.agregarSubPeriodo(periodo, vendas);
    const label = FinanceCalc.labelPeriodo(periodo);
    const SEP   = '═'.repeat(50);
    const sep   = '─'.repeat(50);

    let txt = `${SEP}\n  RELATÓRIO CH GELADAS\n  Período: ${label}\n  Gerado:  ${Utils.timestamp()}\n${SEP}\n\n`;

    txt += `SUMÁRIO\n${sep}\n`;
    txt += `Faturamento:   ${Utils.formatCurrency(kpis.bruto)}\n`;
    txt += `Lucro líquido: ${Utils.formatCurrency(kpis.lucro)}\n`;
    txt += `Margem:        ${kpis.margem.toFixed(1)}%\n`;
    txt += `Nº de vendas:  ${kpis.qtd}\n`;
    txt += `Ticket médio:  ${Utils.formatCurrency(kpis.ticket)}\n`;
    if (kpis.delivery > 0) txt += `Delivery:      ${Utils.formatCurrency(kpis.delivery)} (${kpis.deliveryPerc.toFixed(1)}%)\n`;
    if (kpis.comanda  > 0) txt += `Comanda:       ${Utils.formatCurrency(kpis.comanda)} (${kpis.comandaPerc.toFixed(1)}%)\n`;
    txt += `\n`;

    txt += `${FinanceCalc.labelSubPeriodo(periodo).toUpperCase()}\n${sep}\n`;
    subs.forEach(s => {
      const bar  = '█'.repeat(Math.round((s.bruto / (kpis.bruto || 1)) * 20));
      txt += `${String(s.label).padEnd(18)} ${bar.padEnd(20)} ${Utils.formatCurrency(s.bruto).padStart(12)}\n`;
      txt += `${' '.repeat(18)} ${s.vendas} venda(s)  lucro: ${Utils.formatCurrency(s.lucro)}\n`;
    });
    txt += `\n`;

    txt += `VENDAS INDIVIDUAIS (${vendas.length})\n${sep}\n`;
    [...vendas].reverse().forEach(v => {
      txt += `\n#${String(v.id).slice(-8)}  ${v.data}  ${v.hora || ''}  [${v.origem || 'PDV'}]\n`;
      (v.itens || []).forEach(i => {
        txt += `  · ${String(i.nome || '').padEnd(24)} ${i.label}  ${Utils.formatCurrency(i.preco)}\n`;
      });
      txt += `  ${sep.slice(0,40)}\n`;
      txt += `  TOTAL: ${Utils.formatCurrency(v.total).padStart(12)}   LUCRO: ${Utils.formatCurrency(v.lucro || 0)}\n`;
    });

    Utils.downloadBlob(txt, 'text/plain;charset=utf-8;', `CH_Geladas_${periodo.toUpperCase()}_${new Date().toISOString().slice(0,10)}.txt`);
    UIService.showToast('Relatório exportado', `${vendas.length} vendas exportadas`);
  }

  function exportarCSV(periodo) {
    const vendas = FinanceCalc.filtrarPorPeriodo(periodo);
    if (!vendas.length) { UIService.showToast('Aviso', 'Sem vendas no período', 'warning'); return; }

    const linhas = [['ID','Data','Hora','Total','Lucro','Margem%','Origem','Forma Pgto','Itens','Detalhes'].join(',')];
    [...vendas].reverse().forEach(v => {
      const mg  = (v.total || 0) > 0 ? (((v.lucro || 0) / v.total) * 100).toFixed(1) : '0';
      const det = (v.itens || []).map(i => `${i.nome}(${i.label}:${Utils.formatCurrency(i.preco)})`).join('; ');
      linhas.push([
        _f(String(v.id).slice(-8)), _f(v.data), _f(v.hora || ''),
        (v.total || 0).toFixed(2), (v.lucro || 0).toFixed(2), mg,
        _f(v.origem || 'PDV'), _f(v.formaPgto || '—'),
        (v.itens || []).length, _f(det),
      ].join(','));
    });

    Utils.downloadBlob('\uFEFF' + linhas.join('\r\n'), 'text/csv;charset=utf-8;', `CH_Geladas_${periodo.toUpperCase()}_${new Date().toISOString().slice(0,10)}.csv`);
    UIService.showToast('CSV exportado', `${vendas.length} vendas`);
  }

  return Object.freeze({ exportarTXT, exportarCSV });
})();


/* ═══════════════════════════════════════════════════════════════════
   FINANCE SERVICE — CRUD e investimento
═══════════════════════════════════════════════════════════════════ */
const FinanceService = (() => {

  function getVendaById(id) {
    return Store.Selectors.getVendas().find(v => String(v.id) === String(id)) || null;
  }

  function editarVenda(id) {
    const v = getVendaById(id);
    if (!v) return;
    ['evId','evData','evTotal','evLucro'].forEach((elId, i) => {
      const el = Utils.el(elId); if (el) el.value = [v.id, v.data, v.total, v.lucro][i] ?? '';
    });
    UIService.openModal('modalEditVenda');
  }

  function salvarEdicaoVenda() {
    const id     = String(Utils.el('evId')?.value || '');
    const vendas = Store.Selectors.getVendas();
    const idx    = vendas.findIndex(v => String(v.id) === id);
    if (idx === -1) return;
    const novaData  = Utils.el('evData')?.value  || vendas[idx].data;
    const novoTotal = parseFloat(Utils.el('evTotal')?.value) || 0;
    const novoLucro = parseFloat(Utils.el('evLucro')?.value) || 0;
    if (!novaData) { UIService.showToast('Erro', 'Data inválida', 'error'); return; }

    // BUG-01 FIX: derivar dataCurta (YYYY-MM-DD) a partir do campo data editado.
    // Sem isso, filtros de período (hoje/semana/mês) continuavam usando a dataCurta
    // original e ignoravam a data corrigida pelo admin.
    // novaData vem de Utils.timestamp() → formato "DD/MM/AAAA, HH:MM:SS"
    const _mData = String(novaData).match(/(\d{2})\/(\d{2})\/(\d{4})/);
    const novaDataCurta = _mData
      ? `${_mData[3]}-${_mData[2].padStart(2, '0')}-${_mData[1].padStart(2, '0')}`
      : (vendas[idx].dataCurta || Utils.todayISO());

    Store.mutate(state => {
      const i = state.vendas.findIndex(v => String(v.id) === id);
      if (i !== -1) state.vendas[i] = { ...state.vendas[i], data: novaData, dataCurta: novaDataCurta, total: novoTotal, lucro: novoLucro };
    }, true);
    SyncService.persist();
    UIService.closeModal('modalEditVenda');
    UIService.showToast('Venda atualizada');
    EventBus.emit('finance:venda-updated');
  }

  async function excluirVenda(id) {
    try {
      const v = getVendaById(id);
      if (!v) return;
      const modal = Utils.el('modalConfirmExcluirVenda');
      if (!modal) {
        // Fallback Dialog estilizado (sem modal HTML no DOM)
        const ok = await Dialog.danger({
          title:        'Excluir Venda',
          message:      `Venda #${String(v.id).slice(-6)} · ${Utils.formatCurrency(v.total)}`,
          icon:         'fa-receipt',
          confirmLabel: 'Excluir',
        });
        if (!ok) return;
        const devolver = await Dialog.confirm({
          title:        'Devolver Estoque?',
          message:      'Deseja retornar os itens desta venda ao estoque?',
          icon:         'fa-undo',
          confirmLabel: 'Sim, Devolver',
          cancelLabel:  'Não Devolver',
        });
        _executar(id, devolver);
        return;
      }
      const infoEl = Utils.el('confirmExcluirVendaInfo');
      if (infoEl) infoEl.textContent = `Venda #${String(v.id).slice(-6)} · ${Utils.formatCurrency(v.total)} · ${v.data}`;
      modal.dataset.pendingId = String(id);
      UIService.openModal('modalConfirmExcluirVenda');
  
    } catch (err) { console.error('[excluirVenda]', err); }
  }

  function confirmarExclusaoVenda(devolver) {
    const modal = Utils.el('modalConfirmExcluirVenda');
    const id    = modal?.dataset.pendingId;
    UIService.closeModal('modalConfirmExcluirVenda');
    if (id) _executar(id, devolver);
  }

  function _executar(id, devolver) {
    const v = getVendaById(id);
    if (!v) return;
    if (devolver) {
      Store.mutate(state => {
        (v.itens || []).forEach(it => {
          const p = state.estoque.find(e => String(e.id) === String(it.prodId));
          if (p) p.qtdUn += (it.desconto || it.qtd || 1);
        });
      }, true);
    }
    Store.mutate(state => {
      const i = state.vendas.findIndex(x => String(x.id) === String(id));
      if (i !== -1) state.vendas.splice(i, 1);
    }, true);
    SyncService.persist();
    UIService.showToast('Venda excluída', '', 'warning');
    EventBus.emit('finance:venda-deleted', v); // FIX: passa objeto da venda para NotifService registrar auditoria e Telegram
  }

  function salvarInvestimento() {
    const val = parseFloat(Utils.el('invInput')?.value || '0') || 0;
    Store.mutate(state => { state.investimento = val; }, true);
    SyncService.persist();
    UIService.showToast('Investimento salvo');
    EventBus.emit('finance:investimento-updated', val);
  }

  function filtrarVendas(q) {
    const todas = Store.Selectors.getVendas();
    if (!q) return [...todas];
    const ql = q.toLowerCase();
    return todas.filter(v =>
      (v.data      || '').toLowerCase().includes(ql) ||
      (v.dataCurta || '').toLowerCase().includes(ql) ||
      (v.origem    || '').toLowerCase().includes(ql) ||
      (v.formaPgto || '').toLowerCase().includes(ql) ||
      (v.itens || []).some(i => (i.nome || '').toLowerCase().includes(ql))
    );
  }

  function exportarRelatorioTXT() { FinanceExport.exportarTXT('geral'); }
  function exportarRelatorioCSV() { FinanceExport.exportarCSV('geral'); }

  return Object.freeze({
    getVendaById, editarVenda, salvarEdicaoVenda,
    excluirVenda, confirmarExclusaoVenda,
    salvarInvestimento, filtrarVendas,
    exportarRelatorioTXT, exportarRelatorioCSV,
  });
})();


/* ═══════════════════════════════════════════════════════════════════
   FINANCE RENDERER — Renderização e tempo real
═══════════════════════════════════════════════════════════════════ */
const FinanceRenderer = (() => {
  let _periodo = 'hoje';
  let _rtTimer = null;

  function renderFinanceiro() {
    _kpisGlobais();
    _periodo_atual();
    _vendaLogs();
    _renderFormasPgto();
    _renderRuptura();
    _renderPorHora();
    _startRT();
  }

  function setPeriodo(p) {
    _periodo = p;
    window._finPeriodo = p;
    ['hoje','semana','mes','ano','geral'].forEach(id => {
      const el = Utils.el(`finTab-${id}`);
      if (el) el.className = p === id ? 'fin-tab active' : 'fin-tab';
    });
    _periodo_atual();
    _vendaLogs();
    _renderFormasPgto();
    _renderPorHora();
  }

  /* ── KPIs globais ────────────────────────────────────────── */
  function _kpisGlobais() {
    const g = FinanceCalc.calcularKPIsGlobais();
    _set('dashLucro', Utils.formatCurrency(g.lucro));
    _set('dashBruto', Utils.formatCurrency(g.bruto));
    _set('dashROI',   g.roi !== null ? `${g.roi.toFixed(1)}%` : '—');

    const beEl = Utils.el('breakEven');
    if (beEl) {
      if (!g.inv) {
        beEl.textContent = 'Defina o investimento acima';
        beEl.className   = 'text-[8px] text-slate-600 font-bold mt-1';
      } else if (g.breakEvenAtingido) {
        beEl.textContent = '✅ Break-Even atingido!';
        beEl.className   = 'text-[8px] text-emerald-400 font-bold mt-1';
      } else {
        beEl.textContent = `Falta ${Utils.formatCurrency(g.breakEvenRestante)} para break-even`;
        beEl.className   = 'text-[8px] text-amber-400 font-bold mt-1';
      }
    }
    const invEl = Utils.el('invInput');
    if (invEl && !invEl.matches(':focus')) invEl.value = g.inv ?? ''; // FIX 3: || ocultava o valor 0
  }

  /* ── KPIs do período + sub-períodos ──────────────────────── */
  function _periodo_atual() {
    const vendas = FinanceCalc.filtrarPorPeriodo(_periodo);
    const kpis   = FinanceCalc.calcularKPIsPeriodo(vendas);

    _set('finPeriodoLabel',  FinanceCalc.labelPeriodo(_periodo));
    _set('finAtualizadoEm', `Atualizado ${Utils.now()}`);
    _set('finBruto',        Utils.formatCurrency(kpis.bruto));
    _set('finLucro',        Utils.formatCurrency(kpis.lucro));
    _set('finMargem',       `${kpis.margem.toFixed(1)}% margem`);
    _set('finQtd',          kpis.qtd);
    _set('finTicket',       `${Utils.formatCurrency(kpis.ticket)} ticket`);
    _set('finDelivery',     Utils.formatCurrency(kpis.delivery));
    _set('finDeliveryPerc', `${kpis.deliveryPerc.toFixed(1)}% do total`);
    _set('finComanda',      Utils.formatCurrency(kpis.comanda));
    _set('finComandaPerc',  `${kpis.comandaPerc.toFixed(1)}% do total`);

    _renderSubs(vendas, kpis);
    _renderTopProdutos(vendas);
  }

  /* ══════════════════════════════════════════════════════════════
     SVG AREA CHART — Substitui as barras CSS por chart de verdade
  ══════════════════════════════════════════════════════════════ */

  /**
   * Renderiza um area chart SVG responsivo com linha de lucro sobreposta.
   * Sem dependências externas — SVG puro gerado por JS.
   *
   * @param {Array<{label,bruto,lucro,vendas}>} subs - dados agregados por sub-período
   * @param {HTMLElement} container
   */
  function _renderSvgChart(subs, container) {
    const W = 340, H = 130, PAD = { top: 12, right: 8, bottom: 28, left: 8 };
    const iW = W - PAD.left - PAD.right;
    const iH = H - PAD.top  - PAD.bottom;
    const n  = subs.length;
    if (n === 0) return;

    const maxB = Math.max(...subs.map(s => s.bruto), 1);
    const maxL = Math.max(...subs.map(s => s.lucro),  1);

    // Escala: x por index, y normalizado para cada série
    const xOf  = i  => PAD.left + (n === 1 ? iW / 2 : (i / (n - 1)) * iW);
    const yOfB = v  => PAD.top  + iH - (v / maxB) * iH;
    const yOfL = v  => PAD.top  + iH - (v / maxB) * iH; // mesma escala para comparar

    // ── Polígono de área (faturamento) ──────────────────────────
    const pts   = subs.map((s, i) => `${xOf(i).toFixed(1)},${yOfB(s.bruto).toFixed(1)}`);
    const areaD = [
      `M ${xOf(0).toFixed(1)},${(PAD.top + iH).toFixed(1)}`,
      ...subs.map((s, i) => `L ${xOf(i).toFixed(1)},${yOfB(s.bruto).toFixed(1)}`),
      `L ${xOf(n - 1).toFixed(1)},${(PAD.top + iH).toFixed(1)}`,
      'Z'
    ].join(' ');

    // ── Linha de lucro ──────────────────────────────────────────
    const lineD = subs.map((s, i) =>
      `${i === 0 ? 'M' : 'L'} ${xOf(i).toFixed(1)},${yOfL(s.lucro).toFixed(1)}`
    ).join(' ');

    // ── Labels do eixo X (mostra no máximo 5 para não sobrepor) ─
    const step    = Math.ceil(n / 5);
    const xlabels = subs
      .map((s, i) => ({ i, label: s.label }))
      .filter((_, i) => i % step === 0 || i === n - 1)
      .map(({ i, label }) => {
        const lbl = String(label).split(' ').slice(-1)[0]; // pega só a parte curta
        return `<text x="${xOf(i).toFixed(1)}" y="${H - 4}"
          text-anchor="${i === 0 ? 'start' : i === n-1 ? 'end' : 'middle'}"
          font-size="7" fill="#475569" font-family="Plus Jakarta Sans,sans-serif"
          font-weight="800">${_esc(lbl)}</text>`;
      }).join('');

    // ── Pontos interativos (tooltip no hover) ───────────────────
    const dots = subs.map((s, i) => {
      const cx   = xOf(i).toFixed(1);
      const cy   = yOfB(s.bruto).toFixed(1);
      const mg   = s.bruto > 0 ? ((s.lucro / s.bruto) * 100).toFixed(0) : '0';
      const tip  = `${s.label} | ${Utils.formatCurrency(s.bruto)} | ${mg}% mg`;
      return `<circle cx="${cx}" cy="${cy}" r="3.5" fill="#3b82f6"
        stroke="#0d1117" stroke-width="1.5" opacity="0.9">
        <title>${_esc(tip)}</title>
      </circle>`;
    }).join('');

    const svg = `
      <svg viewBox="0 0 ${W} ${H}" width="100%" style="overflow:visible;display:block">
        <defs>
          <linearGradient id="gBruto" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stop-color="#3b82f6" stop-opacity=".35"/>
            <stop offset="100%" stop-color="#3b82f6" stop-opacity=".02"/>
          </linearGradient>
        </defs>

        <!-- Grade horizontal sutil -->
        ${[0.25, 0.5, 0.75].map(t => {
          const y = (PAD.top + iH - t * iH).toFixed(1);
          return `<line x1="${PAD.left}" y1="${y}" x2="${W - PAD.right}" y2="${y}"
            stroke="rgba(255,255,255,.04)" stroke-width="1"/>`;
        }).join('')}

        <!-- Área faturamento -->
        <path d="${areaD}" fill="url(#gBruto)"/>

        <!-- Linha faturamento -->
        <polyline points="${pts.join(' ')}"
          fill="none" stroke="#3b82f6" stroke-width="2"
          stroke-linecap="round" stroke-linejoin="round"/>

        <!-- Linha lucro (verde) -->
        <path d="${lineD}"
          fill="none" stroke="#10b981" stroke-width="1.5"
          stroke-linecap="round" stroke-linejoin="round"
          stroke-dasharray="4 2" opacity=".8"/>

        <!-- Labels X -->
        ${xlabels}

        <!-- Pontos interativos -->
        ${dots}
      </svg>`;

    container.innerHTML = svg;
  }

  /* ── Sub-períodos: chart SVG + tabela de detalhe ────────────── */
  function _renderSubs(vendas, kpis) {
    const subs  = FinanceCalc.agregarSubPeriodo(_periodo, vendas);
    const cont  = Utils.el('finSubLista');
    _set('finSubLabel', FinanceCalc.labelSubPeriodo(_periodo));
    _set('finSubTotal', `${subs.length} período(s)`);

    // ── Chart SVG ──────────────────────────────────────────────
    const chartCont = Utils.el('finChartArea');
    if (chartCont) {
      if (!subs.length) {
        chartCont.innerHTML = `<div class="flex flex-col items-center justify-center py-8 opacity-20">
          <i class="fas fa-chart-area text-3xl mb-2"></i>
          <p class="text-[9px] font-black uppercase">Sem dados</p></div>`;
      } else {
        _renderSvgChart(subs, chartCont);
      }
    }

    // ── Legenda do chart ────────────────────────────────────────
    const legendCont = Utils.el('finChartLegend');
    if (legendCont) {
      legendCont.innerHTML = `
        <span class="flex items-center gap-1 text-[8px] font-black text-blue-400">
          <span class="inline-block w-3 h-0.5 bg-blue-400 rounded"></span>Faturamento
        </span>
        <span class="flex items-center gap-1 text-[8px] font-black text-emerald-400">
          <span class="inline-block w-3 h-0.5 bg-emerald-400 rounded opacity-80" style="background:repeating-linear-gradient(90deg,#10b981 0,#10b981 4px,transparent 4px,transparent 6px)"></span>Lucro
        </span>`;
    }

    if (!cont) return;

    // ── Top 5 períodos (tabela) ─────────────────────────────────
    if (!subs.length) {
      cont.innerHTML = `<div class="text-center py-10 text-slate-700 text-[10px] font-bold uppercase">
        <i class="fas fa-chart-bar text-3xl block mb-2 opacity-20"></i>Sem dados no período</div>`;
      return;
    }

    const maxB = Math.max(...subs.map(s => s.bruto), 1);
    const frag = document.createDocumentFragment();
    subs.forEach((s, idx) => {
      const pct = ((s.bruto / maxB) * 100).toFixed(1);
      const mg  = s.bruto > 0 ? ((s.lucro / s.bruto) * 100).toFixed(0) : '0';
      const div = document.createElement('div');
      div.innerHTML = `
        <div class="flex items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-slate-900/50 transition-all">
          <span class="text-[8px] font-black text-slate-600 w-4 text-right flex-shrink-0">${idx + 1}</span>
          <span class="text-[9px] font-black text-slate-400 w-[60px] flex-shrink-0 truncate">${s.label}</span>
          <div class="flex-1 h-4 bg-slate-900 rounded overflow-hidden">
            <div class="h-full rounded transition-all duration-700"
              style="width:${pct}%;background:linear-gradient(90deg,#1d4ed8,#3b82f6)"></div>
          </div>
          <div class="text-right flex-shrink-0 min-w-[90px]">
            <p class="text-[9px] font-black text-white">${Utils.formatCurrency(s.bruto)}</p>
            <p class="text-[7px] text-slate-600 font-bold">${s.vendas}v · <span class="text-emerald-500">${mg}%</span></p>
          </div>
        </div>`;
      frag.appendChild(div.firstElementChild);
    });
    cont.innerHTML = '';
    cont.appendChild(frag);
  }

  /* ── Top Produtos — ranking por receita no período ───────────── */
  function _renderTopProdutos(vendas) {
    const cont = Utils.el('finTopProdutos');
    if (!cont) return;

    // Agrega por nome de produto
    const mapa = {};
    vendas.forEach(v => {
      (v.itens || []).forEach(it => {
        const nome = it.nome || 'Desconhecido';
        if (!mapa[nome]) mapa[nome] = { nome, qtd: 0, bruto: 0, lucro: 0 };
        const qt = it.desconto || it.qtd || 1;
        mapa[nome].qtd   += qt;
        mapa[nome].bruto += it.preco || 0;
        mapa[nome].lucro += (it.preco - (it.custo || 0)) || 0;
      });
    });

    const top = Object.values(mapa)
      .sort((a, b) => b.bruto - a.bruto)
      .slice(0, 5);

    if (!top.length) {
      cont.innerHTML = `<p class="text-center text-slate-700 text-[9px] font-black uppercase py-6">Sem dados</p>`;
      return;
    }

    const maxB  = Math.max(...top.map(p => p.bruto), 1);
    const MEDAL = ['🥇','🥈','🥉','4º','5º'];

    const frag = document.createDocumentFragment();
    top.forEach((p, i) => {
      const pct = ((p.bruto / maxB) * 100).toFixed(1);
      const mg  = p.bruto > 0 ? ((p.lucro / p.bruto) * 100).toFixed(0) : '0';
      const div = document.createElement('div');
      div.innerHTML = `
        <div class="flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-slate-900/50 transition-all">
          <span class="text-sm w-6 flex-shrink-0 text-center">${MEDAL[i]}</span>
          <div class="flex-1 min-w-0">
            <p class="text-[9px] font-black text-slate-200 truncate">${_esc(p.nome)}</p>
            <div class="h-1.5 bg-slate-900 rounded-full mt-1 overflow-hidden">
              <div class="h-full rounded-full transition-all duration-700"
                style="width:${pct}%;background:linear-gradient(90deg,#7c3aed,#a78bfa)"></div>
            </div>
          </div>
          <div class="text-right flex-shrink-0">
            <p class="text-[9px] font-black text-white">${Utils.formatCurrency(p.bruto)}</p>
            <p class="text-[7px] text-slate-600 font-bold">${p.qtd} un · <span class="text-emerald-500">${mg}%</span></p>
          </div>
        </div>`;
      frag.appendChild(div.firstElementChild);
    });
    cont.innerHTML = '';
    cont.appendChild(frag);
  }

  /* ── Lista de vendas individuais ─────────────────────────── */
  function _vendaLogs() {
    const q      = (Utils.el('filtroData')?.value || '').toLowerCase().trim();
    const base   = FinanceCalc.filtrarPorPeriodo(_periodo);
    const vendas = q
      ? base.filter(v =>
          (v.data      || '').toLowerCase().includes(q) ||
          (v.origem    || '').toLowerCase().includes(q) ||
          (v.formaPgto || '').toLowerCase().includes(q) ||
          (v.itens || []).some(i => (i.nome || '').toLowerCase().includes(q))
        )
      : base;

    _set('totalVendas', `${vendas.length} reg`);
    const logs = Utils.el('vendaLogs');
    if (!logs) return;

    if (!vendas.length) {
      logs.innerHTML = `<div class="text-center py-10 text-slate-700 text-[10px] font-bold uppercase">
        <i class="fas fa-receipt text-2xl block mb-2 opacity-20"></i>
        Sem vendas${q ? ' para este filtro' : ' neste período'}</div>`;
      return;
    }

    const frag = document.createDocumentFragment();
    vendas.forEach(v => {
      const div = document.createElement('div');
      div.innerHTML = _rowVenda(v);
      frag.appendChild(div.firstElementChild);
    });
    logs.innerHTML = '';
    logs.appendChild(frag);
  }

  function _rowVenda(v) {
    const isDlv = v.origem === 'DELIVERY';
    const isCmd = v.origem === 'COMANDA';
    const bdr   = isDlv ? 'border-l-2 border-l-purple-500/50' : isCmd ? 'border-l-2 border-l-amber-500/50' : '';
    const itens = (v.itens || []).map(i =>
      `<span class="text-[8px] text-slate-600 font-bold">${_esc(i.nome || '')}</span>`
    ).join('<span class="text-slate-800 mx-0.5">·</span>');

    // Desconto badge
    const descBadge = (v.desconto || 0) > 0
      ? `<span class="text-[7px] font-bold text-amber-400">-${Utils.formatCurrency(v.desconto)}</span>`
      : '';

    // Pagamentos múltiplos
    const pgtoStr = (v.pagamentos && v.pagamentos.length > 1)
      ? v.pagamentos.map(p => `${p.forma}: ${Utils.formatCurrency(p.valor)}`).join(' + ')
      : (v.formaPgto || '');

    return `
      <article class="p-3 rounded-xl border border-white/5 hover:bg-slate-900/60 transition-all ${bdr}">
        <div class="flex justify-between items-start gap-2">
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-1.5 flex-wrap mb-1">
              <span class="text-sm font-black text-white">${Utils.formatCurrency(v.total)}</span>
              ${(v.lucro || 0) > 0 ? `<span class="text-[8px] text-emerald-400 font-bold">+${Utils.formatCurrency(v.lucro)}</span>` : ''}
              ${descBadge}
              <span class="badge b-blue text-[7px]">${(v.itens || []).length} it.</span>
              ${isDlv ? `<span class="badge b-purple text-[7px]">🏍️ Delivery</span>` : ''}
              ${isCmd ? `<span class="badge b-amber  text-[7px]">📋 Comanda${v.nomeComanda ? ': ' + _esc(v.nomeComanda) : ''}</span>` : ''}
              ${pgtoStr ? `<span class="text-[7px] font-bold text-slate-500">${_esc(pgtoStr)}</span>` : ''}
            </div>
            <div class="flex gap-1 flex-wrap">${itens}</div>
            <p class="text-[8px] text-slate-600 font-bold mt-1">${_esc(v.data || '')}${v.hora ? ' · ' + _esc(v.hora) : ''}</p>
          </div>
          <div class="flex gap-1 flex-shrink-0">
            <button onclick="editarVenda('${v.id}')"
              class="w-7 h-7 rounded-lg bg-blue-500/10 text-blue-400 hover:bg-blue-500 hover:text-white flex items-center justify-center transition-all">
              <i class="fas fa-edit text-[9px]"></i>
            </button>
            <button onclick="excluirVenda('${v.id}')"
              class="w-7 h-7 rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500 hover:text-white flex items-center justify-center transition-all">
              <i class="fas fa-trash text-[9px]"></i>
            </button>
          </div>
        </div>
      </article>`;
  }

  /* ── Formas de pagamento breakdown ──────────────────────── */
  function _renderFormasPgto() {
    const cont = Utils.el('finFormasPgto');
    if (!cont) return;
    const vendas = FinanceCalc.filtrarPorPeriodo(_periodo);
    const mapa = {};
    vendas.forEach(v => {
      const pgtos = (v.pagamentos && v.pagamentos.length > 0)
        ? v.pagamentos
        : [{ forma: v.formaPgto || 'Não informado', valor: v.total || 0 }];
      pgtos.forEach(p => {
        const k = (p.forma || 'Outro').split('(')[0].trim();
        mapa[k] = (mapa[k] || 0) + (p.valor || 0);
      });
    });
    const total = Object.values(mapa).reduce((a, v) => a + v, 0) || 1;
    const items = Object.entries(mapa).sort(([,a],[,b]) => b - a);
    if (!items.length) { cont.innerHTML = '<p class="text-[9px] text-slate-700 font-bold">Sem dados</p>'; return; }
    const ICONES = { 'Dinheiro':'fa-money-bill-wave text-emerald-400','PIX':'fa-qrcode text-blue-400','Pix':'fa-qrcode text-blue-400','Débito':'fa-credit-card text-purple-400','Crédito':'fa-credit-card text-amber-400','Fiado':'fa-handshake text-red-400' };
    cont.innerHTML = items.map(([forma, val]) => {
      const pct  = ((val / total) * 100).toFixed(0);
      const icon = ICONES[forma] || 'fa-circle text-slate-400';
      return `
        <div class="flex items-center gap-2">
          <i class="fas ${icon} text-[9px] w-4 flex-shrink-0"></i>
          <div class="flex-1">
            <div class="flex items-center justify-between mb-0.5">
              <span class="text-[8px] font-black text-slate-300">${_esc(forma)}</span>
              <span class="text-[8px] font-black text-white">${Utils.formatCurrency(val)}</span>
            </div>
            <div class="h-1 bg-slate-800 rounded-full overflow-hidden">
              <div class="h-full rounded-full bg-blue-500" style="width:${pct}%"></div>
            </div>
          </div>
          <span class="text-[7px] text-slate-600 font-bold w-7 text-right">${pct}%</span>
        </div>`;
    }).join('');
  }

  /* ── Ruptura de estoque ──────────────────────────────────── */
  function _renderRuptura() {
    const cont = Utils.el('finRuptura');
    if (!cont) return;
    const thresh  = Store.Selectors.getConfig()?.alertaStock ?? 3;
    const esgot   = Store.Selectors.getOutOfStockItems();
    const baixo   = Store.Selectors.getLowStockItems();
    if (!esgot.length && !baixo.length) {
      cont.innerHTML = '<p class="text-[9px] text-emerald-400 font-bold">✅ Estoque OK</p>';
      return;
    }
    const rows = [
      ...esgot.map(p => `<div class="flex items-center justify-between"><span class="text-[9px] text-red-400 font-bold truncate flex-1">${_esc(p.nome)}</span><span class="badge b-red text-[7px] ml-1">Esgotado</span></div>`),
      ...baixo.map(p  => `<div class="flex items-center justify-between"><span class="text-[9px] text-amber-400 font-bold truncate flex-1">${_esc(p.nome)}</span><span class="text-[8px] text-amber-400 font-black ml-1">${p.qtdUn} un</span></div>`),
    ];
    cont.innerHTML = rows.join('');
  }

  /* ── Vendas por hora (só período "hoje") ─────────────────── */
  function _renderPorHora() {
    const wrap = Utils.el('finPorHoraWrap');
    const cont = Utils.el('finPorHora');
    if (!wrap || !cont) return;

    if (_periodo !== 'hoje') { wrap.classList.add('hidden'); return; }
    wrap.classList.remove('hidden');

    const vendas = FinanceCalc.filtrarPorPeriodo('hoje');
    const horas  = {};
    vendas.forEach(v => {
      const h = (v.hora || '00:00').slice(0, 2);
      if (!horas[h]) horas[h] = { qtd: 0, total: 0 };
      horas[h].qtd++;
      horas[h].total += (v.total || 0);
    });

    const items  = Object.entries(horas).sort(([a], [b]) => a.localeCompare(b));
    if (!items.length) { cont.innerHTML = '<p class="text-[9px] text-slate-700 font-bold">Sem vendas hoje ainda</p>'; return; }

    const maxQtd = Math.max(...items.map(([, v]) => v.qtd), 1);
    cont.innerHTML = items.map(([h, v]) => {
      const pct = ((v.qtd / maxQtd) * 100).toFixed(0);
      return `
        <div class="flex items-center gap-2">
          <span class="text-[8px] font-black text-slate-500 w-10 flex-shrink-0">${h}h</span>
          <div class="flex-1 h-4 bg-slate-800 rounded overflow-hidden">
            <div class="h-full bg-gradient-to-r from-cyan-700 to-cyan-500 rounded transition-all" style="width:${pct}%"></div>
          </div>
          <span class="text-[8px] font-black text-white w-6 text-right flex-shrink-0">${v.qtd}</span>
          <span class="text-[8px] font-bold text-slate-500 w-16 text-right flex-shrink-0">${Utils.formatCurrency(v.total)}</span>
        </div>`;
    }).join('');
  }

  /* ── Tempo real (30s) ────────────────────────────────────── */
  function _startRT() {
    if (_rtTimer) return;
    _rtTimer = setInterval(() => {
      if (!Utils.el('tab-financeiro')?.classList.contains('active')) return;
      _kpisGlobais();
      _periodo_atual();
      _renderFormasPgto();
      _renderRuptura();
      _renderPorHora();
      _set('finAtualizadoEm', `Atualizado ${Utils.now()}`);
    }, 30_000);
  }

  /* ── Helpers ─────────────────────────────────────────────── */
  function _set(id, v) { const el = Utils.el(id); if (el) el.textContent = String(v ?? ''); }
  function _esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  return Object.freeze({ renderFinanceiro, setPeriodo });
})();


/* ═══════════════════════════════════════════════════════════════════
   CAIXA TURNO SERVICE — Abertura, sangria, fechamento com diferença
═══════════════════════════════════════════════════════════════════ */
const CaixaTurnoService = (() => {

  function _getTurnos() {
    const s = Store.getState();
    if (!s.caixaTurnos) { Store.mutate(st => { st.caixaTurnos = []; }, true); }
    return Store.getState().caixaTurnos || [];
  }

  function turnoAtivo() {
    return _getTurnos().find(t => t.status === 'ABERTO') || null;
  }

  async function abrirCaixa() {
    if (turnoAtivo()) { UIService.showToast('Atenção', 'Caixa já está aberto', 'warning'); return; }
    const str = await Dialog.prompt({
      title: 'Abrir Caixa', message: 'Valor inicial (troco em caixa):',
      placeholder: '0.00', defaultValue: '0.00', confirmLabel: 'Abrir Caixa',
      icon: 'fa-cash-register', iconBg: 'bg-emerald-500/15', iconColor: 'text-emerald-400',
    });
    if (str === null) return;
    const valorAbertura = parseFloat(String(str).replace(',', '.')) || 0;
    const turno = {
      id:           Utils.generateId(),
      status:       'ABERTO',
      operador:     AuthService.getRole(),
      tsAbertura:   Date.now(),
      dataAbertura: Utils.todayISO(),
      horaAbertura: Utils.now(),
      valorAbertura,
      sangrias:     [],
      totalSangrias: 0,
    };
    Store.mutate(state => {
      if (!state.caixaTurnos) state.caixaTurnos = [];
      state.caixaTurnos.unshift(turno);
      if (state.caixaTurnos.length > 200) state.caixaTurnos.splice(200);
      // Compatibilidade: mantém registro legado
      state.caixa.unshift({ id: Utils.generateId(), tipo: 'ABERTURA', valor: valorAbertura, data: Utils.todayISO(), hora: Utils.now() });
      if (state.caixa.length > CONSTANTS.MAX_CAIXA) state.caixa.splice(CONSTANTS.MAX_CAIXA);
    }, true);
    SyncService.persistNow();
    UIService.showToast('Caixa Aberto', `Troco inicial: ${Utils.formatCurrency(valorAbertura)}`);
    EventBus.emit('caixa:aberto', valorAbertura);
    if (FinanceRenderer && typeof FinanceRenderer.renderFinanceiro === 'function') FinanceRenderer.renderFinanceiro();
  }

  async function registrarSangria() {
    const t = turnoAtivo();
    if (!t) { UIService.showToast('Atenção', 'Nenhum caixa aberto', 'warning'); return; }
    const str = await Dialog.prompt({
      title: 'Registrar Sangria', message: 'Valor retirado do caixa:',
      placeholder: '0.00', confirmLabel: 'Registrar',
      icon: 'fa-money-bill-wave', iconBg: 'bg-amber-500/15', iconColor: 'text-amber-400',
    });
    if (!str) return;
    const valor = parseFloat(String(str).replace(',', '.')) || 0;
    if (valor <= 0) return;
    const motivo = await Dialog.prompt({
      title: 'Motivo da sangria', message: 'Descreva o motivo (opcional):',
      placeholder: 'Ex: Retirada para banco', confirmLabel: 'Salvar',
      icon: 'fa-file-alt', iconBg: 'bg-slate-800', iconColor: 'text-slate-400',
    }) || '';
    Store.mutate(state => {
      const idx = state.caixaTurnos?.findIndex(x => x.id === t.id);
      if (idx !== undefined && idx !== -1) {
        const sangria = { id: Utils.generateId(), valor, motivo, hora: Utils.now(), ts: Date.now() };
        state.caixaTurnos[idx].sangrias.push(sangria);
        state.caixaTurnos[idx].totalSangrias = (state.caixaTurnos[idx].totalSangrias || 0) + valor;
      }
    }, true);
    SyncService.persist();
    UIService.showToast('Sangria registrada', Utils.formatCurrency(valor), 'warning');
    if (FinanceRenderer && typeof FinanceRenderer.renderFinanceiro === 'function') FinanceRenderer.renderFinanceiro();
  }

  async function fecharCaixa() {
    const t = turnoAtivo();
    if (!t) { UIService.showToast('Atenção', 'Nenhum caixa aberto', 'warning'); return; }

    // Calcula totais do turno
    const isoAbertura = t.dataAbertura || Utils.todayISO();
    const vendasTurno = Store.Selectors.getVendas().filter(v => {
      const dc = v.dataCurta || '';
      return dc === isoAbertura && (v.ts || 0) >= (t.tsAbertura || 0);
    });
    const totalVendas   = vendasTurno.reduce((s, v) => s + (v.total || 0), 0);
    const totalSangrias = t.totalSangrias || 0;

    // Dinheiro esperado: troco inicial + dinheiro das vendas - sangrias
    const mapaFormas = {};
    vendasTurno.forEach(v => {
      const pgtos = (v.pagamentos && v.pagamentos.length > 0) ? v.pagamentos : [{ forma: v.formaPgto || 'Outro', valor: v.total || 0 }];
      pgtos.forEach(p => {
        const k = (p.forma || 'Outro').split('(')[0].trim().toLowerCase();
        mapaFormas[k] = (mapaFormas[k] || 0) + (p.valor || 0);
      });
    });
    const totalDinheiro = (mapaFormas['dinheiro'] || 0) + (mapaFormas['espécie'] || 0) + (mapaFormas['especie'] || 0);
    const esperadoCaixa = t.valorAbertura + totalDinheiro - totalSangrias;

    const resumo = `Vendas: ${Utils.formatCurrency(totalVendas)} | Dinheiro esperado: ${Utils.formatCurrency(esperadoCaixa)}`;
    const str = await Dialog.prompt({
      title: 'Fechar Caixa', message: `${resumo}\n\nValor contado no caixa:`,
      placeholder: esperadoCaixa.toFixed(2), defaultValue: esperadoCaixa.toFixed(2),
      confirmLabel: 'Fechar Caixa',
      icon: 'fa-cash-register', iconBg: 'bg-red-500/15', iconColor: 'text-red-400',
    });
    if (str === null) return;

    const valorContado = parseFloat(String(str).replace(',', '.')) || 0;
    const diferenca    = valorContado - esperadoCaixa;

    Store.mutate(state => {
      const idx = state.caixaTurnos?.findIndex(x => x.id === t.id);
      if (idx !== undefined && idx !== -1) {
        Object.assign(state.caixaTurnos[idx], {
          status:        'FECHADO',
          tsFechamento:  Date.now(),
          horaFechamento: Utils.now(),
          totalVendas,
          valorEsperado: esperadoCaixa,
          valorContado,
          diferenca,
          qtdVendas:     vendasTurno.length,
        });
      }
      state.caixa.unshift({ id: Utils.generateId(), tipo: 'FECHAMENTO', valor: valorContado, data: Utils.todayISO(), hora: Utils.now() });
      if (state.caixa.length > CONSTANTS.MAX_CAIXA) state.caixa.splice(CONSTANTS.MAX_CAIXA);
    }, true);
    SyncService.persistNow();

    const diffMsg = Math.abs(diferenca) < 0.01 ? '✅ Caixa fechado sem diferença' : `${diferenca >= 0 ? '📈' : '📉'} Diferença: ${Utils.formatCurrency(diferenca)}`;
    UIService.showToast('Caixa Fechado', diffMsg, Math.abs(diferenca) > 1 ? 'warning' : 'success');
    EventBus.emit('caixa:fechado', valorContado);
    if (FinanceRenderer && typeof FinanceRenderer.renderFinanceiro === 'function') FinanceRenderer.renderFinanceiro();
  }

  function renderTurnoAtual() {
    const cont = Utils.el('caixaTurnoWrap');
    if (!cont) return;
    const t = turnoAtivo();
    const turnos = _getTurnos().slice(0, 10);

    let html = '';
    if (t) {
      const duracaoMin = Math.floor((Date.now() - (t.tsAbertura || Date.now())) / 60_000);
      const duracaoStr = duracaoMin < 60 ? `${duracaoMin}min` : `${Math.floor(duracaoMin/60)}h${duracaoMin%60}min`;
      html += `
        <div class="rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-4 mb-3">
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-2">
              <span class="w-2 h-2 bg-emerald-400 rounded-full animate-pulse"></span>
              <span class="text-[10px] font-black text-emerald-400 uppercase">Caixa Aberto</span>
            </div>
            <span class="text-[9px] text-slate-500 font-bold">${t.horaAbertura} · ${duracaoStr}</span>
          </div>
          <div class="grid grid-cols-3 gap-2 mb-3">
            <div class="bg-slate-900/60 rounded-xl p-2.5 text-center">
              <p class="text-[8px] text-slate-500 uppercase font-black mb-0.5">Troco Inicial</p>
              <p class="text-[11px] font-black text-white">${Utils.formatCurrency(t.valorAbertura || 0)}</p>
            </div>
            <div class="bg-slate-900/60 rounded-xl p-2.5 text-center">
              <p class="text-[8px] text-slate-500 uppercase font-black mb-0.5">Sangrias</p>
              <p class="text-[11px] font-black text-amber-400">${Utils.formatCurrency(t.totalSangrias || 0)}</p>
            </div>
            <div class="bg-slate-900/60 rounded-xl p-2.5 text-center">
              <p class="text-[8px] text-slate-500 uppercase font-black mb-0.5">Sangrias (qtd)</p>
              <p class="text-[11px] font-black text-slate-300">${(t.sangrias || []).length}</p>
            </div>
          </div>
          <div class="flex gap-2">
            <button onclick="caixaSangria()" class="flex-1 py-2.5 rounded-xl bg-amber-600/20 text-amber-300 border border-amber-500/30 font-black text-[9px] uppercase hover:bg-amber-600/30 transition-all">
              <i class="fas fa-money-bill-wave mr-1"></i>Sangria
            </button>
            <button onclick="caixaFechar()" class="flex-1 py-2.5 rounded-xl bg-red-600/20 text-red-300 border border-red-500/30 font-black text-[9px] uppercase hover:bg-red-600/30 transition-all">
              <i class="fas fa-lock mr-1"></i>Fechar Caixa
            </button>
          </div>
        </div>`;
    } else {
      html += `
        <div class="rounded-2xl border border-white/8 bg-slate-900/40 p-4 mb-3 text-center">
          <i class="fas fa-cash-register text-2xl text-slate-600 mb-2 block"></i>
          <p class="text-[10px] font-black text-slate-500 uppercase mb-3">Caixa Fechado</p>
          <button onclick="caixaAbrir()" class="w-full py-2.5 rounded-xl bg-emerald-600/20 text-emerald-300 border border-emerald-500/30 font-black text-[10px] uppercase hover:bg-emerald-600/30 transition-all">
            <i class="fas fa-lock-open mr-1"></i>Abrir Caixa
          </button>
        </div>`;
    }

    // Histórico de turnos
    if (turnos.length > 0) {
      html += `<p class="text-[8px] uppercase tracking-widest font-black text-slate-600 mb-2">Últimos turnos</p>`;
      html += turnos.map(tr => {
        const aberto  = tr.status === 'ABERTO';
        const diff    = tr.diferenca || 0;
        const diffStr = aberto ? '' : (Math.abs(diff) < 0.01 ? '✅' : (diff >= 0 ? `+${Utils.formatCurrency(diff)}` : Utils.formatCurrency(diff)));
        return `
          <div class="flex items-center justify-between px-3 py-2 rounded-xl border border-white/5 bg-slate-900/30 mb-1">
            <div>
              <p class="text-[10px] font-black text-slate-300">${tr.dataAbertura} · ${tr.horaAbertura}</p>
              <p class="text-[8px] text-slate-600 font-bold">${aberto ? '🟢 Aberto' : '🔴 Fechado'} · ${tr.qtdVendas || 0} vendas · ${Utils.formatCurrency(tr.totalVendas || 0)}</p>
            </div>
            ${!aberto ? `<span class="text-[9px] font-black ${Math.abs(diff) < 0.01 ? 'text-emerald-400' : diff > 0 ? 'text-blue-400' : 'text-red-400'}">${diffStr}</span>` : ''}
          </div>`;
      }).join('');
    }

    cont.innerHTML = html;
  }

  EventBus.on('caixa:aberto',  () => renderTurnoAtual());
  EventBus.on('caixa:fechado', () => renderTurnoAtual());
  EventBus.on('sync:remote-applied', () => {
    if (Utils.el('tab-financeiro')?.classList.contains('active')) renderTurnoAtual();
  });

  return Object.freeze({ turnoAtivo, abrirCaixa, registrarSangria, fecharCaixa, renderTurnoAtual });
})();


/* ═══════════════════════════════════════════════════════════════════
   EVENT LISTENERS
═══════════════════════════════════════════════════════════════════ */

/**
 * Atualiza apenas os KPIs globais do topo (dashLucro, dashBruto, dashROI).
 * Chamado quando a aba financeiro está inativa — evita re-render completo
 * mas mantém os números sempre frescos para quando o usuário abrir a aba.
 */
function _updateGlobalKPIsFast() {
  try {
    const g  = FinanceCalc.calcularKPIsGlobais();
    const _s = (id, v) => { const el = Utils.el(id); if (el) el.textContent = String(v ?? ''); };
    _s('dashLucro', Utils.formatCurrency(g.lucro));
    _s('dashBruto', Utils.formatCurrency(g.bruto));
    _s('dashROI',   g.roi !== null ? `${g.roi.toFixed(1)}%` : '—');
  } catch (_) { /* silencioso — aba pode ainda não estar no DOM */ }
}

function _isFinanceiroAtivo() {
  return !!Utils.el('tab-financeiro')?.classList.contains('active');
}

// Venda concluída (PDV, Comanda ou Delivery) → render completo se aba ativa,
// senão só KPIs do topo para economizar ciclos.
EventBus.on('cart:checkout', () => {
  _isFinanceiroAtivo() ? FinanceRenderer.renderFinanceiro() : _updateGlobalKPIsFast();
});

// FIX: Delivery registra venda ao chegar em ENTREGUE — financeiro precisa ouvir este evento
EventBus.on('delivery:status-changed', pedido => {
  if (pedido?.status === 'ENTREGUE') {
    _isFinanceiroAtivo() ? FinanceRenderer.renderFinanceiro() : _updateGlobalKPIsFast();
  }
});

// Sync remoto: outro dispositivo gravou → mesma lógica
EventBus.on('sync:remote-applied', () => {
  _isFinanceiroAtivo() ? FinanceRenderer.renderFinanceiro() : _updateGlobalKPIsFast();
});

// Edição/exclusão de venda e atualização de investimento → só renderiza se ativo
['finance:venda-updated', 'finance:venda-deleted', 'finance:investimento-updated'].forEach(ev => {
  EventBus.on(ev, () => { if (_isFinanceiroAtivo()) FinanceRenderer.renderFinanceiro(); });
});


/* ═══════════════════════════════════════════════════════════════════
   WINDOW BRIDGES
═══════════════════════════════════════════════════════════════════ */
function renderFinanceiro()        { FinanceRenderer.renderFinanceiro(); }
function updateInv()               { FinanceService.salvarInvestimento(); }
function editarVenda(id)           { FinanceService.editarVenda(id); }
function salvarEdicaoVenda()       { FinanceService.salvarEdicaoVenda(); }
function excluirVenda(id)          { FinanceService.excluirVenda(id); }
function confirmarExclusaoVenda(d) { FinanceService.confirmarExclusaoVenda(d); }
function finSetPeriodo(p)          { FinanceRenderer.setPeriodo(p); }
function finExportar()             { FinanceExport.exportarTXT(window._finPeriodo || 'hoje'); }
function finExportarCsv()          { FinanceExport.exportarCSV(window._finPeriodo || 'hoje'); }
function exportarRelatorio()       { FinanceExport.exportarTXT('geral'); }
function exportarRelatorioCsv()    { FinanceExport.exportarCSV('geral'); }

/** Exporta fechamento de caixa do dia como TXT estruturado */
function finExportarFechamentoCaixa() {
  const hoje = Utils.todayISO();
  const dispHoje = Utils.today();
  const cfg = Store.Selectors.getConfig();
  const nomeLoja = cfg.nome || 'PDV App';

  function _dataVenda(v) {
    const raw = v.dataCurta || (v.data || '').slice(0, 10) || '';
    if (raw.includes('-')) return raw.slice(0, 10);
    const [d, m, y] = raw.split('/');
    return y ? `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}` : raw;
  }

  const vendasHoje = Store.Selectors.getVendas().filter(v => _dataVenda(v) === hoje);
  if (!vendasHoje.length) { UIService.showToast('Aviso', 'Sem vendas hoje', 'warning'); return; }

  const fmt  = v => Utils.formatCurrency(v);
  const SEP  = '═'.repeat(48);
  const sep  = '─'.repeat(48);

  // Totais por forma
  const formaMap = {};
  vendasHoje.forEach(v => {
    const pgtos = (v.pagamentos && v.pagamentos.length > 0)
      ? v.pagamentos
      : [{ forma: v.formaPgto || 'Não informado', valor: v.total || 0 }];
    pgtos.forEach(p => {
      const k = (p.forma || 'Outro').split('(')[0].trim();
      formaMap[k] = (formaMap[k] || 0) + (p.valor || 0);
    });
  });

  const totalBruto  = vendasHoje.reduce((a, v) => a + (v.total || 0), 0);
  const totalLucro  = vendasHoje.reduce((a, v) => a + (v.lucro || 0), 0);
  const totalDesc   = vendasHoje.reduce((a, v) => a + (v.desconto || 0), 0);
  const qtdVendas   = vendasHoje.length;
  const ticket      = qtdVendas > 0 ? totalBruto / qtdVendas : 0;

  const caixaLogs   = Store.Selectors.getCaixa() || [];
  const abertura    = caixaLogs.find(c => c.tipo === 'ABERTURA');
  const trocoInicial = abertura ? parseFloat(abertura.valor) || 0 : 0;
  const fechamento  = caixaLogs.find(c => c.tipo === 'FECHAMENTO');
  const apurado     = fechamento ? parseFloat(fechamento.valor) || 0 : 0;

  const DINHEIRO    = ['dinheiro','espécie','especie','cash'];
  const totalDin    = Object.entries(formaMap).filter(([k]) => DINHEIRO.includes(k.toLowerCase())).reduce((a,[,v]) => a + v, 0);
  const esperado    = trocoInicial + totalDin;
  const diff        = apurado - esperado;

  // Sangrias do dia
  const sangrias = (Store.getState().movimentacoes || [])
    .filter(m => m.tipo === 'saida' && m.categoria === 'sangria' && (m.dataCurta === hoje || (m.data || '').slice(0,10) === hoje))
    .reduce((a, m) => a + (m.valor || 0), 0);

  // Top produtos
  const prodMap = {};
  vendasHoje.forEach(v => (v.itens || []).forEach(i => {
    if (!prodMap[i.nome]) prodMap[i.nome] = { qtd: 0, total: 0 };
    prodMap[i.nome].qtd += (i.desconto || 1);
    prodMap[i.nome].total += (i.preco || 0);
  }));
  const topProds = Object.entries(prodMap).sort(([,a],[,b]) => b.total - a.total).slice(0, 8);

  let txt = `${SEP}\n`;
  txt += `  FECHAMENTO DE CAIXA — ${nomeLoja}\n`;
  txt += `  Data: ${dispHoje}   Gerado: ${Utils.now()}\n`;
  txt += `${SEP}\n\n`;

  txt += `RESUMO FINANCEIRO\n${sep}\n`;
  txt += `Faturamento bruto:   ${fmt(totalBruto)}\n`;
  txt += `Lucro líquido:       ${fmt(totalLucro)}  (${totalBruto > 0 ? ((totalLucro/totalBruto)*100).toFixed(1) : 0}%)\n`;
  if (totalDesc > 0) txt += `Total descontos:     ${fmt(totalDesc)}\n`;
  txt += `Nº de vendas:        ${qtdVendas}\n`;
  txt += `Ticket médio:        ${fmt(ticket)}\n\n`;

  txt += `CAIXA\n${sep}\n`;
  txt += `Troco inicial:       ${fmt(trocoInicial)}\n`;
  if (sangrias > 0) txt += `Sangrias:            -${fmt(sangrias)}\n`;
  txt += `Esperado (dinheiro): ${fmt(esperado - sangrias)}\n`;
  if (apurado > 0) {
    txt += `Apurado:             ${fmt(apurado)}\n`;
    txt += `Diferença:           ${diff >= 0 ? '+' : ''}${fmt(diff)}${Math.abs(diff) > 1 ? ' ⚠️' : ' ✅'}\n`;
  }
  txt += `\n`;

  txt += `FORMAS DE PAGAMENTO\n${sep}\n`;
  Object.entries(formaMap).sort(([,a],[,b]) => b - a).forEach(([forma, val]) => {
    txt += `${String(forma).padEnd(22)} ${fmt(val)}\n`;
  });
  txt += `\n`;

  if (topProds.length) {
    txt += `TOP PRODUTOS\n${sep}\n`;
    topProds.forEach(([nome, d]) => {
      txt += `${String(nome).padEnd(26)} ${String(d.qtd).padStart(4)} un   ${fmt(d.total)}\n`;
    });
    txt += `\n`;
  }

  txt += `ORIGENS\n${sep}\n`;
  txt += `PDV: ${vendasHoje.filter(v=>v.origem==='PDV').length}   Comanda: ${vendasHoje.filter(v=>v.origem==='COMANDA').length}   Delivery: ${vendasHoje.filter(v=>v.origem==='DELIVERY').length}\n\n`;

  txt += `${SEP}\n  Gerado em ${Utils.timestamp()}\n${SEP}\n`;

  Utils.downloadBlob(txt, 'text/plain;charset=utf-8;', `Fechamento_Caixa_${hoje}.txt`);
  UIService.showToast('Fechamento', 'TXT baixado com sucesso');
}

/** Romaneio de delivery — lista de pedidos ativos para entrega */
function exportarRomaneioDelivery() {
  const pedidos = Store.Selectors.getPedidos().filter(p => p.status !== 'CANCELADO' && p.status !== 'ENTREGUE');
  if (!pedidos.length) { UIService.showToast('Aviso', 'Sem pedidos ativos para romaneio', 'warning'); return; }

  const cfg      = Store.Selectors.getConfig();
  const nomeLoja = cfg.nome || 'PDV App';
  const hoje     = Utils.today();
  const SEP      = '═'.repeat(46);
  const sep      = '─'.repeat(46);
  const fmt      = v => Utils.formatCurrency(v);

  let txt = `${SEP}\n  ROMANEIO DE DELIVERY — ${nomeLoja}\n  Data: ${hoje}   Gerado: ${Utils.now()}\n${SEP}\n\n`;

  let totalGeral = 0;
  pedidos.forEach((p, i) => {
    const status  = p.status || 'NOVO';
    const cliente = p.clienteNome || p.cliente || '—';
    const end     = p.endereco || '—';
    const entrega = p.entregadorNome || p.entregador || '—';
    const total   = p.total || p.valorTotal || 0;
    totalGeral   += total;

    txt += `[${i+1}] ${cliente}\n`;
    txt += `    Endereço:   ${end}\n`;
    txt += `    Entregador: ${entrega}\n`;
    txt += `    Status:     ${status}\n`;
    txt += `    Total:      ${fmt(total)}\n`;
    if ((p.itens || p.produtos || []).length) {
      const itens = p.itens || p.produtos || [];
      itens.forEach(it => {
        const nome = it.nome || it.produto || '—';
        const qtd  = it.qtd || it.quantidade || 1;
        txt += `      · ${qtd}x ${nome}\n`;
      });
    }
    txt += `${sep}\n`;
  });

  txt += `\nTOTAL GERAL: ${fmt(totalGeral)}\n`;
  txt += `Pedidos: ${pedidos.length}\n\n`;
  txt += `Gerado em ${Utils.timestamp()}\n`;

  Utils.downloadBlob(txt, 'text/plain;charset=utf-8;', `Romaneio_${Utils.todayISO()}.txt`);
  UIService.showToast('Romaneio', `${pedidos.length} pedidos exportados`);
}

/* ── CaixaTurnoService bridges ─────────────────────────────────── */
function caixaAbrir()    { CaixaTurnoService.abrirCaixa(); }
function caixaFechar()   { CaixaTurnoService.fecharCaixa(); }
function caixaSangria()  { CaixaTurnoService.registrarSangria(); }
function renderCaixaTurno() { CaixaTurnoService.renderTurnoAtual(); }
