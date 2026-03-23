/**
 * @fileoverview CH Geladas PDV — Ponto, Caixa, Inventário e Dados Module
 * @version 5.0.0-enterprise
 *
 * Módulos:
 *  - PontoService       → Registro de ponto de colaboradores
 *  - CaixaService       → Abertura e fechamento de caixa
 *  - InventoryRenderer  → Renderização do inventário e caixa
 *  - PontoRenderer      → Renderização do módulo de ponto
 *  - DataService        → Backup, importação e reset
 *  - EstoqueService     → Gerência de produtos no estoque
 *  - EstoqueRenderer    → Renderização do catálogo de estoque (admin)
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════════
   PONTO SERVICE — Registro de entrada/saída
═══════════════════════════════════════════════════════════════════ */
const PontoService = (() => {
  const TIPOS = Object.freeze({ ENTRADA: 'ENTRADA', SAIDA: 'SAÍDA' });

  /**
   * Registra ponto de entrada ou saída
   * @param {'ENTRADA'|'SAÍDA'} tipo
   */
  function registrar(tipo) {
    const nome = Utils.el('pontNomeLive')?.value.trim() || '';
    if (!Validators.isNonEmptyString(nome)) {
      UIService.showToast('Erro', 'Insira o nome do colaborador', 'error');
      return;
    }
    Store.mutate(state => {
      state.ponto.unshift({
        id:        Utils.generateId(),
        nome,
        tipo,
        data:      Utils.timestamp(),
        dataCurta: Utils.todayISO(),
      });
    }, true);
    SyncService.persist();
    UIService.showToast('Ponto', `${nome} → ${tipo}`);
    EventBus.emit('ponto:registered', { nome, tipo });
  }

  /**
   * Abre modal de edição de um registro
   * @param {number|string} id
   */
  function abrirEditar(id) {
    const reg = Store.getState().ponto.find(p => String(p.id) === String(id));
    if (!reg) return;
    const set = (elId, val) => { const el = Utils.el(elId); if (el) el.value = val ?? ''; };
    set('pontIdx',  reg.id);
    set('pontNome', reg.nome);
    set('pontData', reg.data);
    _setPontoTipoBtn(reg.tipo);
    UIService.openModal('modalEditPonto');
  }

  /**
   * Salva edição de registro de ponto
   */
  function salvarEdicao() {
    const id   = String(Utils.el('pontIdx')?.value || '');
    const nome = Utils.el('pontNome')?.value.trim() || '';
    const tipo = Utils.el('pontTipo')?.value || '';
    const data = Utils.el('pontData')?.value.trim() || '';

    if (!Validators.isNonEmptyString(nome)) {
      UIService.showToast('Erro', 'Nome é obrigatório', 'error');
      return;
    }

    let found = false;
    Store.mutate(state => {
      const idx = state.ponto.findIndex(p => String(p.id) === id);
      if (idx !== -1) {
        state.ponto[idx] = { ...state.ponto[idx], nome, tipo, data };
        found = true;
      }
    }, true);
    if (!found) return;
    SyncService.persist();
    UIService.closeModal('modalEditPonto');
    UIService.showToast('Ponto', 'Registo atualizado');
    EventBus.emit('ponto:updated');
  }

  /**
   * Remove registro de ponto
   * @param {number|string} id
   */
  async function apagar(id) {
    try {
      const reg = Store.getState().ponto.find(p => String(p.id) === String(id));
      if (!reg) return;
      const ok = await Dialog.danger({
      title:        `Apagar registo de ${reg.nome}?`,
      message:      'Esta ação não pode ser desfeita.',
      icon:         'fa-trash',
      confirmLabel: 'Apagar',
    });
    if (!ok) return;
    Store.mutate(state => {
      const idx = state.ponto.findIndex(p => String(p.id) === String(id));
      if (idx !== -1) state.ponto.splice(idx, 1);
    }, true);
      SyncService.persist();
      UIService.showToast('Ponto', 'Registo apagado', 'warning');
      EventBus.emit('ponto:deleted');
    } catch (err) { console.error('[ponto.apagar]', err); }
  }

  /**
   * Limpa todos os registros (apenas admin)
   */
  async function limparTodos() {
    try {
      if (!AuthService.isAdmin()) return;
      const ok = await Dialog.danger({
        title:        'Apagar todos os registos?',
        message:      'Esta ação irá remover TODOS os registos de ponto e não pode ser desfeita.',
        icon:         'fa-exclamation-triangle',
        confirmLabel: 'Apagar Tudo',
      });
      if (!ok) return;
      Store.mutate(state => { state.ponto.splice(0); }, true);
      SyncService.persist();
      UIService.showToast('Ponto', 'Todos os registos apagados', 'warning');
      EventBus.emit('ponto:cleared');
    } catch (err) { console.error('[ponto.limparTodos]', err); }
  }

  /**
   * Atualiza botões visuais de tipo no modal de edição
   * @param {'ENTRADA'|'SAÍDA'} tipo
   */
  function _setPontoTipoBtn(tipo) {
    const tipoEl = Utils.el('pontTipo');
    if (tipoEl) tipoEl.value = tipo;

    const btnE = Utils.el('pontBtnE');
    const btnS = Utils.el('pontBtnS');

    const activeE = tipo === TIPOS.ENTRADA;
    if (btnE) btnE.className = `py-3 rounded-xl font-black uppercase text-xs border transition-all ${activeE ? 'bg-emerald-600/30 text-emerald-300 border-emerald-500/50' : 'bg-slate-800 text-slate-500 border-white/5'}`;
    if (btnS) btnS.className = `py-3 rounded-xl font-black uppercase text-xs border transition-all ${!activeE ? 'bg-red-600/30 text-red-300 border-red-500/50' : 'bg-slate-800 text-slate-500 border-white/5'}`;
  }

  /**
   * Gera relatório mensal de ponto por colaborador
   * @param {number} ano
   * @param {number} mes — 1-12
   * @returns {Array<{nome, diasTrabalhados, horasTrabalhadas, registros}>}
   */
  function relatorioMensal(ano, mes) {
    const todos = Store.getState().ponto || [];
    // Filtra registros do mês
    const mesISO = `${ano}-${String(mes).padStart(2, '0')}`;
    const doMes  = todos.filter(p => (p.dataCurta || '').startsWith(mesISO));

    // Agrupa por nome
    const porNome = {};
    doMes.forEach(p => {
      const n = p.nome || 'Desconhecido';
      if (!porNome[n]) porNome[n] = { nome: n, registros: [] };
      porNome[n].registros.push(p);
    });

    return Object.values(porNome).map(col => {
      // Emparelha ENTRADA + SAÍDA por dia
      const porDia = {};
      col.registros.forEach(r => {
        const d = r.dataCurta || '';
        if (!porDia[d]) porDia[d] = [];
        porDia[d].push(r);
      });

      let horasTotal = 0;
      let diasComEntrada = 0;

      Object.values(porDia).forEach(regs => {
        const entradas = regs.filter(r => r.tipo === 'ENTRADA').sort((a, b) => a.ts - b.ts);
        const saidas   = regs.filter(r => r.tipo === 'SAÍDA' || r.tipo === 'SAIDA').sort((a, b) => a.ts - b.ts);
        if (entradas.length > 0) diasComEntrada++;
        const pares = Math.min(entradas.length, saidas.length);
        for (let i = 0; i < pares; i++) {
          const tsE = entradas[i].ts || new Date(entradas[i].data).getTime();
          const tsS = saidas[i].ts   || new Date(saidas[i].data).getTime();
          if (tsS > tsE) horasTotal += (tsS - tsE) / 3_600_000;
        }
      });

      return {
        nome:             col.nome,
        diasTrabalhados:  diasComEntrada,
        horasTrabalhadas: +horasTotal.toFixed(2),
        registros:        col.registros.length,
      };
    }).sort((a, b) => b.diasTrabalhados - a.diasTrabalhados);
  }

  /**
   * Exibe modal com relatório mensal
   */
  async function exibirRelatorioMensal() {
    const agora = new Date();
    const ano   = agora.getFullYear();
    const mes   = agora.getMonth() + 1;
    const MESES = ['','Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
    const dados = relatorioMensal(ano, mes);

    if (!dados.length) {
      UIService.showToast('Ponto', 'Sem registros este mês', 'warning');
      return;
    }

    const linhas = dados.map(c => `
      <tr class="border-b border-white/5">
        <td class="py-2 pr-3 text-[10px] font-black text-slate-200">${c.nome}</td>
        <td class="py-2 pr-3 text-[10px] font-bold text-slate-300 text-center">${c.diasTrabalhados}</td>
        <td class="py-2 pr-3 text-[10px] font-bold text-blue-400 text-center">${c.horasTrabalhadas.toFixed(1)}h</td>
        <td class="py-2 text-[10px] font-bold text-slate-500 text-center">${c.registros}</td>
      </tr>`).join('');

    const html = `
      <div style="max-width:360px;background:rgba(13,17,23,0.98);border:1px solid rgba(255,255,255,0.09);border-radius:1.5rem;padding:1.5rem;">
        <h3 style="font-size:14px;font-weight:900;color:#fff;margin-bottom:4px;">📋 Relatório — ${MESES[mes]} ${ano}</h3>
        <p style="font-size:10px;color:#64748b;margin-bottom:16px;">${dados.length} colaborador(es)</p>
        <table style="width:100%;border-collapse:collapse;">
          <thead><tr style="border-bottom:1px solid rgba(255,255,255,0.1);">
            <th style="font-size:8px;color:#475569;text-align:left;padding-bottom:6px;text-transform:uppercase;">Nome</th>
            <th style="font-size:8px;color:#475569;text-align:center;padding-bottom:6px;text-transform:uppercase;">Dias</th>
            <th style="font-size:8px;color:#475569;text-align:center;padding-bottom:6px;text-transform:uppercase;">Horas</th>
            <th style="font-size:8px;color:#475569;text-align:center;padding-bottom:6px;text-transform:uppercase;">Registros</th>
          </tr></thead>
          <tbody class="ponto-relatorio-body">${linhas}</tbody>
        </table>
        <button onclick="document.getElementById('modalRelatorioMensal').classList.remove('open')"
          style="width:100%;margin-top:16px;padding:10px;border-radius:12px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);color:#94a3b8;font-size:10px;font-weight:800;text-transform:uppercase;cursor:pointer;">
          Fechar
        </button>
      </div>`;

    let modal = Utils.el('modalRelatorioMensal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id        = 'modalRelatorioMensal';
      modal.className = 'modal';
      modal.style.cssText = 'z-index:200;';
      modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('open'); });
      document.body.appendChild(modal);
    }
    modal.innerHTML = html;
    modal.classList.add('open');
  }

  return Object.freeze({ TIPOS, registrar, abrirEditar, salvarEdicao, apagar, limparTodos, _setPontoTipoBtn, relatorioMensal, exibirRelatorioMensal });
})();

/* ═══════════════════════════════════════════════════════════════════
   CAIXA SERVICE — Abertura e fechamento
═══════════════════════════════════════════════════════════════════ */
const CaixaService = (() => {
  /**
   * Abre modal de abertura de caixa
   */
  function abrirModalAbertura() {
    // Guard: impede dupla abertura
    if (Store.Selectors.isCaixaOpen()) {
      UIService.showToast('Atenção', 'Caixa já está aberto', 'warning');
      return;
    }
    const input = Utils.el('valorInicialCaixa');
    if (input) input.value = '';
    UIService.openModal('modalAbrirCaixa');
    setTimeout(() => input?.focus(), 220);
  }

  /**
   * Confirma abertura de caixa
   */
  function confirmarAbertura() {
    // Guard duplo (caso modal tenha ficado aberto)
    if (Store.Selectors.isCaixaOpen()) {
      UIService.closeModal('modalAbrirCaixa');
      UIService.showToast('Atenção', 'Caixa já está aberto', 'warning');
      return;
    }
    const raw = Utils.el('valorInicialCaixa')?.value || '0';
    const val = parseFloat(raw.replace(',', '.')) || 0;
    if (val < 0) { UIService.showToast('Erro', 'Valor não pode ser negativo', 'error'); return; }

    _registrarMovimento('ABERTURA', val, 'Abertura de caixa');
    UIService.closeModal('modalAbrirCaixa');
    UIService.showToast('Caixa Aberto', `Troco inicial: ${Utils.formatCurrency(val)}`);
    EventBus.emit('caixa:aberto', val);
  }

  /**
   * Abre modal de fechamento de caixa
   */
  function abrirModalFechamento() {
    if (!Store.Selectors.isCaixaOpen()) {
      UIService.showToast('Atenção', 'Caixa já está fechado', 'warning');
      return;
    }
    const input = Utils.el('valorFinalCaixa');
    if (input) input.value = '';

    // Oculta diferença até o usuário digitar
    const difEl = Utils.el('fcDiferenca');
    if (difEl) difEl.classList.add('hidden');

    _preencherResumoDia();
    UIService.openModal('modalFecharCaixa');
    setTimeout(() => input?.focus(), 220);

    // Calcula diferença em tempo real conforme o usuário digita
    if (input) {
      input.oninput = () => _atualizarDiferenca();
    }
  }

  /**
   * Calcula e preenche o resumo do dia no modal de fechamento.
   * Considera todas as vendas do dia (PDV + Comanda + Delivery).
   */
  function _preencherResumoDia() {
    const fmt = v => Utils.formatCurrency(v);
    const _s  = (id, val) => { const el = Utils.el(id); if (el) el.textContent = val; };

    const ultimoEvento = Store.Selectors.getCaixa();
    let trocoInicial = 0;
    const ultimaAbertura = (ultimoEvento || []).find(c => c.tipo === 'ABERTURA');
    if (ultimaAbertura) trocoInicial = parseFloat(ultimaAbertura.valor) || 0;

    const hoje = (() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    })();

    function _dataVenda(v) {
      const raw = v.dataCurta || (v.data || '').slice(0, 10) || '';
      if (raw.includes('/')) {
        const [d, m, y] = raw.split('/');
        return y ? `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}` : raw;
      }
      return raw.slice(0, 10);
    }

    const vendasHoje = Store.Selectors.getVendas().filter(v => _dataVenda(v) === hoje);

    const FORMAS_DINHEIRO = ['dinheiro', 'espécie', 'especie', 'cash'];
    const FORMAS_PIX      = ['pix'];
    const FORMAS_CARTAO   = ['cartão', 'cartao', 'débito', 'debito', 'crédito', 'credito'];
    const FORMAS_FIADO    = ['fiado'];

    // Função para checar forma (suporta multi-pgto e forma única)
    const formaMatch = (venda, lista) => {
      const pgtos = venda.pagamentos && venda.pagamentos.length > 0
        ? venda.pagamentos
        : [{ forma: venda.formaPgto || '', valor: venda.total || 0 }];
      return pgtos.reduce((acc, p) => {
        const fl = (p.forma || '').toLowerCase();
        return acc + (lista.some(f => fl.includes(f)) ? (p.valor || 0) : 0);
      }, 0);
    };

    const vendasDinheiro = vendasHoje.reduce((a, v) => a + formaMatch(v, FORMAS_DINHEIRO), 0);
    const vendasPix      = vendasHoje.reduce((a, v) => a + formaMatch(v, FORMAS_PIX), 0);
    const vendasCartao   = vendasHoje.reduce((a, v) => a + formaMatch(v, FORMAS_CARTAO), 0);
    const vendasFiado    = vendasHoje.reduce((a, v) => a + formaMatch(v, FORMAS_FIADO), 0);
    const totalVendido   = vendasHoje.reduce((a, v) => a + (v.total || 0), 0);

    // Sangrias do fluxo de caixa registradas hoje
    const sangrias = (Store.getState().movimentacoes || []).filter(m =>
      m.tipo === 'saida' && m.categoria === 'sangria' &&
      (m.dataCurta === hoje || (m.data || '').slice(0, 10) === hoje)
    ).reduce((a, m) => a + (m.valor || 0), 0);

    const esperado = trocoInicial + vendasDinheiro - sangrias;

    const qtdPdv      = vendasHoje.filter(v => v.origem === 'PDV').length;
    const qtdComanda  = vendasHoje.filter(v => v.origem === 'COMANDA').length;
    const qtdDelivery = vendasHoje.filter(v => v.origem === 'DELIVERY').length;

    _s('fcTrocoInicial',   fmt(trocoInicial));
    _s('fcVendasDinheiro', fmt(vendasDinheiro));
    _s('fcVendasPix',      fmt(vendasPix));
    _s('fcVendasCartao',   fmt(vendasCartao));
    _s('fcVendasFiado',    fmt(vendasFiado));
    _s('fcSangrias',       fmt(sangrias));
    _s('fcTotalVendido',   fmt(totalVendido));
    _s('fcEsperado',       fmt(esperado));
    _s('fcQtdVendas',      `${qtdPdv} PDV · ${qtdComanda} comanda(s) · ${qtdDelivery} delivery`);

    const modalEl = Utils.el('modalFecharCaixa');
    if (modalEl) {
      modalEl.dataset.esperado    = esperado.toFixed(2);
      modalEl.dataset.dinheiro    = vendasDinheiro.toFixed(2);
      modalEl.dataset.pix         = vendasPix.toFixed(2);
      modalEl.dataset.cartao      = vendasCartao.toFixed(2);
      modalEl.dataset.fiado       = vendasFiado.toFixed(2);
      modalEl.dataset.sangrias    = sangrias.toFixed(2);
      modalEl.dataset.totalVendido = totalVendido.toFixed(2);
      modalEl.dataset.trocoInicial = trocoInicial.toFixed(2);
    }
  }

  /**
   * Atualiza indicador de diferença (sobra/falta) em tempo real.
   */
  function _atualizarDiferenca() {
    const input    = Utils.el('valorFinalCaixa');
    const difEl    = Utils.el('fcDiferenca');
    const modalEl  = Utils.el('modalFecharCaixa');
    if (!input || !difEl || !modalEl) return;

    const apurado   = parseFloat(input.value) || 0;
    const sangriaV  = parseFloat(Utils.el('fcSangriaValor')?.value || '0') || 0;
    // Recalcula esperado descontando sangria digitada agora
    const esperadoBase = parseFloat(modalEl.dataset.esperado) || 0;
    const esperado  = esperadoBase - sangriaV;
    const diff      = apurado - esperado;

    if (input.value === '' && sangriaV === 0) { difEl.classList.add('hidden'); return; }

    difEl.classList.remove('hidden');
    const fmt = v => Utils.formatCurrency(Math.abs(v));

    if (Math.abs(diff) < 0.01) {
      difEl.textContent = '✅ Caixa fechando no valor exato';
      difEl.className   = 'text-[9px] font-black text-center mt-2 text-emerald-400';
    } else if (diff > 0) {
      difEl.textContent = `⬆ Sobra ${fmt(diff)} em relação ao esperado`;
      difEl.className   = 'text-[9px] font-black text-center mt-2 text-amber-400';
    } else {
      difEl.textContent = `⬇ Falta ${fmt(diff)} em relação ao esperado`;
      difEl.className   = 'text-[9px] font-black text-center mt-2 text-red-400';
    }
  }

  /**
   * Confirma fechamento de caixa e envia relatório completo do dia
   */
  function confirmarFechamento() {
    const raw = Utils.el('valorFinalCaixa')?.value || '0';
    const val = parseFloat(raw.replace(',', '.')) || 0;
    if (val < 0) { UIService.showToast('Erro', 'Valor não pode ser negativo', 'error'); return; }

    // Registra sangria se informada
    const sangriaVal    = parseFloat(Utils.el('fcSangriaValor')?.value || '0') || 0;
    const sangriaMotivo = (Utils.el('fcSangriaMotivo')?.value || '').trim();
    if (sangriaVal > 0) {
      Store.mutate(state => {
        if (!Array.isArray(state.movimentacoes)) state.movimentacoes = [];
        state.movimentacoes.unshift({
          id:        Utils.generateId(),
          tipo:      'saida',
          categoria: 'sangria',
          valor:     sangriaVal,
          descricao: sangriaMotivo || 'Sangria no fechamento de caixa',
          data:      Utils.timestamp(),
          dataCurta: Utils.todayISO(),
        });
      }, true);
    }

    _registrarMovimento('FECHAMENTO', val, 'Fechamento de caixa');
    UIService.closeModal('modalFecharCaixa');
    UIService.showToast('Caixa Fechado', `Valor apurado: ${Utils.formatCurrency(val)}`, 'warning');
    EventBus.emit('caixa:fechado', val);

    setTimeout(() => _enviarRelatorioDia(val), 600);
  }

  /**
   * Gera o relatório completo do dia e envia via Telegram + WhatsApp.
   * Também oferece download TXT.
   * @param {number} valorApurado
   */
  function _enviarRelatorioDia(valorApurado) {
    const hoje = (() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    })();

    function _dataVenda(v) {
      const raw = v.dataCurta || (v.data || '').slice(0, 10) || '';
      if (raw.includes('-')) return raw.slice(0, 10);
      const [d, m, y] = raw.split('/');
      return y ? `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}` : raw;
    }

    const vendasHoje = Store.Selectors.getVendas().filter(v => _dataVenda(v) === hoje);
    const cfg        = Store.Selectors.getConfig();
    const nomeLoja   = cfg.nome || 'PDV App';

    const totalBruto   = vendasHoje.reduce((a, v) => a + (v.total  || 0), 0);
    const totalLucro   = vendasHoje.reduce((a, v) => a + (v.lucro  || 0), 0);
    const totalDesc    = vendasHoje.reduce((a, v) => a + (v.desconto || 0), 0);
    const qtdVendas    = vendasHoje.length;
    const ticket       = qtdVendas > 0 ? totalBruto / qtdVendas : 0;

    // Abertura de caixa
    const caixaLogs  = Store.Selectors.getCaixa() || [];
    const abertura   = caixaLogs.find(c => c.tipo === 'ABERTURA');
    const trocoInicial = abertura ? parseFloat(abertura.valor) || 0 : 0;

    // Formas de pagamento
    const formasTotais = {};
    vendasHoje.forEach(v => {
      if (v.pagamentos && v.pagamentos.length > 0) {
        v.pagamentos.forEach(p => {
          formasTotais[p.forma] = (formasTotais[p.forma] || 0) + p.valor;
        });
      } else {
        const forma = v.formaPgto || 'Não informado';
        formasTotais[forma] = (formasTotais[forma] || 0) + (v.total || 0);
      }
    });

    // Top produtos
    const prodMap = {};
    vendasHoje.forEach(v => {
      (v.itens || []).forEach(i => {
        if (!prodMap[i.nome]) prodMap[i.nome] = { qtd: 0, total: 0 };
        prodMap[i.nome].qtd   += (i.desconto || 1);
        prodMap[i.nome].total += (i.preco || 0);
      });
    });
    const topProds = Object.entries(prodMap)
      .sort(([,a],[,b]) => b.total - a.total)
      .slice(0, 5);

    // Origens
    const qtdPdv      = vendasHoje.filter(v => v.origem === 'PDV').length;
    const qtdComanda  = vendasHoje.filter(v => v.origem === 'COMANDA').length;
    const qtdDelivery = vendasHoje.filter(v => v.origem === 'DELIVERY').length;

    const SEP  = '═'.repeat(40);
    const sep  = '─'.repeat(40);
    const fmt  = v => Utils.formatCurrency(v);
    const data = hoje.split('-').reverse().join('/');

    let txt = `${SEP}\n`;
    txt += `  RELATÓRIO DIÁRIO — ${nomeLoja}\n`;
    txt += `  Data: ${data}   Fechamento: ${Utils.now()}\n`;
    txt += `${SEP}\n\n`;

    txt += `RESUMO DO DIA\n${sep}\n`;
    txt += `Faturamento bruto:   ${fmt(totalBruto)}\n`;
    txt += `Lucro líquido:       ${fmt(totalLucro)}\n`;
    txt += `Margem:              ${totalBruto > 0 ? ((totalLucro/totalBruto)*100).toFixed(1) : 0}%\n`;
    txt += `Total de descontos:  ${fmt(totalDesc)}\n`;
    txt += `Nº de vendas:        ${qtdVendas}\n`;
    txt += `Ticket médio:        ${fmt(ticket)}\n`;
    txt += `\n`;

    txt += `CAIXA\n${sep}\n`;
    txt += `Troco inicial:       ${fmt(trocoInicial)}\n`;
    txt += `Valor apurado:       ${fmt(valorApurado)}\n`;
    const FORMAS_DIN = ['dinheiro','espécie','especie','cash'];
    const totalDin = Object.entries(formasTotais)
      .filter(([k]) => FORMAS_DIN.includes(k.toLowerCase()))
      .reduce((a,[,v]) => a + v, 0);
    txt += `Esperado em caixa:   ${fmt(trocoInicial + totalDin)}\n`;
    const diff = valorApurado - (trocoInicial + totalDin);
    txt += `Diferença:           ${diff >= 0 ? '+' : ''}${fmt(diff)}\n`;
    txt += `\n`;

    txt += `ORIGENS\n${sep}\n`;
    txt += `PDV: ${qtdPdv}  ·  Comanda: ${qtdComanda}  ·  Delivery: ${qtdDelivery}\n\n`;

    txt += `FORMAS DE PAGAMENTO\n${sep}\n`;
    Object.entries(formasTotais).forEach(([forma, val]) => {
      txt += `${String(forma).padEnd(20)} ${fmt(val)}\n`;
    });
    txt += `\n`;

    if (topProds.length > 0) {
      txt += `TOP PRODUTOS\n${sep}\n`;
      topProds.forEach(([nome, d]) => {
        txt += `${String(nome).padEnd(24)} ${String(d.qtd).padStart(4)} un  ${fmt(d.total)}\n`;
      });
      txt += `\n`;
    }

    txt += `VENDAS INDIVIDUAIS (${qtdVendas})\n${sep}\n`;
    [...vendasHoje].reverse().forEach(v => {
      txt += `\n#${String(v.id).slice(-6)}  ${v.data}  ${v.hora || ''}  [${v.origem || 'PDV'}]\n`;
      (v.itens || []).forEach(i => {
        txt += `  · ${String(i.nome || '').padEnd(22)} ${fmt(i.preco)}\n`;
      });
      if ((v.desconto || 0) > 0) txt += `  Desconto: -${fmt(v.desconto)}\n`;
      txt += `  TOTAL: ${fmt(v.total)}   Pgto: ${v.formaPgto || '—'}\n`;
    });

    txt += `\n${SEP}\n`;
    txt += `  Gerado em ${Utils.timestamp()}\n`;
    txt += `${SEP}\n`;

    // Oferece download TXT
    Utils.downloadBlob(txt, 'text/plain;charset=utf-8;', `Relatorio_${hoje}.txt`);
    UIService.showToast('📋 Relatório do Dia', 'Baixando relatório completo...', 'success');

    // Envia via Telegram se configurado
    const tg = cfg.telegram;
    if (tg?.token && tg?.chatId) {
      const msgTg = `📊 *FECHAMENTO DE CAIXA — ${nomeLoja}*\n📅 ${data}\n\n` +
        `💰 Faturamento: *${fmt(totalBruto)}*\n` +
        `📈 Lucro: *${fmt(totalLucro)}* (${totalBruto > 0 ? ((totalLucro/totalBruto)*100).toFixed(1) : 0}%)\n` +
        `🧾 Vendas: *${qtdVendas}* | Ticket: ${fmt(ticket)}\n` +
        (totalDesc > 0 ? `🏷️ Descontos: -${fmt(totalDesc)}\n` : '') +
        `🏦 Caixa apurado: *${fmt(valorApurado)}*\n\n` +
        `PDV: ${qtdPdv} | Comanda: ${qtdComanda} | Delivery: ${qtdDelivery}\n\n` +
        Object.entries(formasTotais).map(([f,v]) => `${f}: ${fmt(v)}`).join('\n');

      fetch(`https://api.telegram.org/bot${tg.token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: tg.chatId, text: msgTg, parse_mode: 'Markdown' }),
      }).catch(e => console.warn('[CaixaService] Telegram report failed:', e));
    }

    // Envia via WhatsApp (admin) se configurado
    if (cfg.whatsapp) {
      const msgWa = `*📊 FECHAMENTO — ${nomeLoja}*\n📅 ${data}\n` +
        `${'—'.repeat(28)}\n` +
        `💰 Faturamento: *${fmt(totalBruto)}*\n` +
        `📈 Lucro: *${fmt(totalLucro)}*\n` +
        `🧾 Vendas: ${qtdVendas} | Ticket: ${fmt(ticket)}\n` +
        (totalDesc > 0 ? `🏷️ Descontos: -${fmt(totalDesc)}\n` : '') +
        `🏦 Caixa: *${fmt(valorApurado)}*\n` +
        `${'—'.repeat(28)}\n` +
        Object.entries(formasTotais).map(([f,v]) => `${f}: ${fmt(v)}`).join('\n');
      Utils.openWhatsApp(cfg.whatsapp, msgWa);
    }
  }

  /**
   * Registra evento de caixa e persiste
   * @param {'ABERTURA'|'FECHAMENTO'} tipo
   * @param {number} valor
   * @param {string} descricao
   */
  function _registrarMovimento(tipo, valor, descricao) {
    Store.mutate(state => {
      if (!Array.isArray(state.caixa)) state.caixa = [];
      state.caixa.unshift({
        id:        Utils.generateId(),
        tipo,
        valor,
        descricao,
        data:      Utils.today(),
        hora:      Utils.now(),
        timestamp: Date.now(),
      });
    }, true);
    SyncService.persist();
  }

  return Object.freeze({ abrirModalAbertura, confirmarAbertura, abrirModalFechamento, confirmarFechamento });
})();

/* ═══════════════════════════════════════════════════════════════════
   PONTO RENDERER — Renderização do módulo de ponto
═══════════════════════════════════════════════════════════════════ */
const PontoRenderer = (() => {
  function renderPonto() {
    _renderStatusCaixa();
    _renderPontoLogs();
    _renderPontoResumo();
  }

  /* ── Status do caixa ─────────────────────────────────────── */
  function _renderStatusCaixa() {
    const statusEl = Utils.el('caixaStatus');
    if (!statusEl) return;

    const ultimo = Store.Selectors.getUltimoCaixa();
    if (!ultimo) {
      statusEl.className = 'mb-4 p-4 rounded-xl border text-center border-slate-700 bg-slate-900/30';
      statusEl.innerHTML = '<p class="text-xs font-black uppercase text-slate-500"><i class="fas fa-question-circle mr-2" aria-hidden="true"></i>Sem registo de caixa</p>';
      statusEl.setAttribute('aria-label', 'Sem registo de caixa');
      return;
    }

    const isAberto = ultimo.tipo === 'ABERTURA';
    const cor      = isAberto ? 'emerald' : 'red';
    const icon     = isAberto ? 'fa-cash-register' : 'fa-lock';
    const label    = isAberto ? 'Caixa Aberto' : 'Caixa Fechado';
    const detalhe  = ultimo.valor != null
      ? ` · ${isAberto ? 'Troco' : 'Apurado'}: ${Utils.formatCurrency(parseFloat(ultimo.valor))}`
      : '';

    statusEl.className = `mb-4 p-4 rounded-xl border text-center border-${cor}-500/30 bg-${cor}-500/10`;
    statusEl.innerHTML = `<p class="text-xs font-black uppercase text-${cor}-400"><i class="fas ${icon} mr-2" aria-hidden="true"></i>${label} · ${ultimo.hora}${detalhe}</p>`;
    statusEl.setAttribute('aria-label', `${label}${detalhe}`);

    // Atualiza estado visual dos botões Abrir/Fechar
    const btnAbrir  = Utils.el('btnAbrirCaixa');
    const btnFechar = Utils.el('btnFecharCaixa');
    if (btnAbrir) {
      btnAbrir.disabled = isAberto;
      btnAbrir.className = isAberto
        ? 'py-4 rounded-xl bg-slate-800 text-slate-600 border border-slate-700 font-black text-xs uppercase cursor-not-allowed'
        : 'py-4 rounded-xl bg-emerald-600/20 text-emerald-300 border border-emerald-500/30 font-black text-xs uppercase hover:bg-emerald-600/30 transition-all';
    }
    if (btnFechar) {
      btnFechar.disabled = !isAberto;
      btnFechar.className = !isAberto
        ? 'py-4 rounded-xl bg-slate-800 text-slate-600 border border-slate-700 font-black text-xs uppercase cursor-not-allowed'
        : 'py-4 rounded-xl bg-red-600/20 text-red-300 border border-red-500/30 font-black text-xs uppercase hover:bg-red-600/30 transition-all';
    }
  }

  /* ── Logs de ponto ───────────────────────────────────────── */
  function _renderPontoLogs() {
    const cont = Utils.el('pontoLogs');
    if (!cont) return;

    const filtro  = (Utils.el('filtroPonto')?.value || '').toLowerCase();
    const pontos  = Store.getState().ponto || [];
    const filtrados = filtro
      ? pontos.filter(p => p.nome.toLowerCase().includes(filtro))
      : pontos;

    if (filtrados.length === 0) {
      cont.innerHTML = `
        <div class="text-center py-8 text-slate-700 text-[10px] font-bold uppercase" role="status">
          <i class="fas fa-clock text-2xl block mb-2" aria-hidden="true"></i>
          Sem registos${filtro ? ' para este filtro' : ''}
        </div>`;
      return;
    }

    const frag = document.createDocumentFragment();
    filtrados.forEach(p => {
      const isEntrada = p.tipo === 'ENTRADA';
      const div = document.createElement('div');
      div.innerHTML = `
        <div class="flex items-center justify-between bg-slate-900/50 p-4 rounded-2xl border border-white/5 hover:bg-slate-900 transition-all" role="row">
          <div class="flex items-center gap-3">
            <div class="w-8 h-8 rounded-xl flex items-center justify-center ${isEntrada ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'}" aria-hidden="true">
              <i class="fas ${isEntrada ? 'fa-sign-in-alt' : 'fa-sign-out-alt'} text-xs"></i>
            </div>
            <div>
              <span class="block text-[11px] font-black text-slate-200">${RenderService._escapeHtml(p.nome)}</span>
              <span class="text-[9px] text-slate-500">${p.data}</span>
            </div>
          </div>
          <div class="flex items-center gap-2">
            <span class="badge ${isEntrada ? 'b-green' : 'b-red'}" role="status">${p.tipo}</span>
            ${AuthService.isAdmin() ? `
              <button onclick="abrirEditarPonto('${p.id}')" class="w-7 h-7 rounded-lg bg-blue-500/10 text-blue-400 hover:bg-blue-500 hover:text-white flex items-center justify-center transition-all" aria-label="Editar registo de ${RenderService._escapeHtml(p.nome)}"><i class="fas fa-edit text-[9px]" aria-hidden="true"></i></button>
              <button onclick="apagarPonto('${p.id}')" class="w-7 h-7 rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500 hover:text-white flex items-center justify-center transition-all" aria-label="Apagar registo de ${RenderService._escapeHtml(p.nome)}"><i class="fas fa-trash text-[9px]" aria-hidden="true"></i></button>` : ''}
          </div>
        </div>`;
      frag.appendChild(div.firstElementChild);
    });
    cont.innerHTML = '';
    cont.appendChild(frag);
  }

  /* ── Resumo por colaborador ──────────────────────────────── */
  function _renderPontoResumo() {
    const resumoEl = Utils.el('pontoResumo');
    if (!resumoEl) return;

    const pontos = Store.getState().ponto || [];
    /** @type {Object.<string, {e: number, s: number}>} */
    const map = {};
    pontos.forEach(p => {
      if (!map[p.nome]) map[p.nome] = { e: 0, s: 0 };
      if (p.tipo === 'ENTRADA') map[p.nome].e++;
      else map[p.nome].s++;
    });

    const nomes = Object.keys(map);
    if (nomes.length === 0) {
      resumoEl.innerHTML = '<p class="col-span-2 text-[9px] text-slate-600 text-center font-bold uppercase py-2">Sem registos ainda</p>';
      return;
    }

    resumoEl.innerHTML = nomes.map(n => `
      <div class="bg-black/20 p-4 rounded-xl border border-white/5">
        <p class="text-[10px] font-black text-slate-300 mb-2 truncate">${RenderService._escapeHtml(n)}</p>
        <div class="flex gap-2">
          <span class="badge b-green"><i class="fas fa-sign-in-alt mr-1" aria-hidden="true"></i>${map[n].e}</span>
          <span class="badge b-red"><i class="fas fa-sign-out-alt mr-1" aria-hidden="true"></i>${map[n].s}</span>
        </div>
      </div>`).join('');
  }

  return Object.freeze({ renderPonto });
})();

/* ═══════════════════════════════════════════════════════════════════
   INVENTORY RENDERER — Inventário e logs de caixa
═══════════════════════════════════════════════════════════════════ */
const InventoryRenderer = (() => {
  const TYPE_CONFIG = Object.freeze({
    DEVOLUCAO: { cls: 'bg-amber-500/10 text-amber-400',  icon: 'fa-undo',       border: 'border-l-amber-500/40' },
    DELIVERY:  { cls: 'bg-purple-500/10 text-purple-400', icon: 'fa-motorcycle', border: 'border-l-purple-500/40' },
    VENDA:     { cls: 'bg-blue-500/10 text-blue-400',     icon: 'fa-box',        border: 'border-l-blue-500/40' },
  });

  function renderInventario() {
    _renderInventarioLogs();
    _renderCaixaLogs();
  }

  function _renderInventarioLogs() {
    const cont = Utils.el('invLogs');
    if (!cont) return;

    const filtroData = Utils.el('filtroInvData')?.value || '';
    const todos      = Store.Selectors.getInventario() || [];
    const filtrados  = filtroData
      ? todos.filter(r => {
          const raw = r.data || '';
          // FIX: suportar tanto YYYY-MM-DD (novo) quanto DD/MM/YYYY (legado)
          if (raw.includes('-')) return raw.slice(0, 10) === filtroData;
          const [d, m, y] = raw.split('/');
          return y ? `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}` === filtroData : false;
        })
      : todos;

    if (filtrados.length === 0) {
      cont.innerHTML = `
        <div class="text-center py-10 text-slate-700 text-[10px] font-bold uppercase" role="status">
          <i class="fas fa-clipboard text-2xl block mb-3" aria-hidden="true"></i>
          Sem registos${filtroData ? ' para esta data' : ''}
        </div>`;
      return;
    }

    const frag = document.createDocumentFragment();
    filtrados.forEach(r => {
      const config = TYPE_CONFIG[r.tipo] || TYPE_CONFIG.VENDA;
      const div    = document.createElement('div');
      div.innerHTML = `
        <article
          class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-900/50 p-4 rounded-2xl border border-white/5 hover:bg-slate-900 transition-all ${r.tipo !== 'VENDA' ? `border-l-2 ${config.border}` : ''}"
          role="row">
          <div class="flex items-center gap-3 min-w-0">
            <div class="w-10 h-10 rounded-xl flex-shrink-0 flex items-center justify-center ${config.cls}" aria-hidden="true">
              <i class="fas ${config.icon} text-sm"></i>
            </div>
            <div class="min-w-0">
              <p class="text-[11px] font-black text-slate-200 truncate">${RenderService._escapeHtml(r.produto)}</p>
              <p class="text-[9px] text-slate-500 font-bold">
                ${RenderService._escapeHtml(r.label)}
                ${r.preco > 0 ? `· ${Utils.formatCurrency(r.preco)}` : ''}
              </p>
            </div>
          </div>
          <div class="flex items-center gap-4 flex-shrink-0" role="group" aria-label="Movimentação de estoque">
            <div class="text-center">
              <p class="text-[7px] text-slate-600 uppercase font-bold mb-0.5">Antes</p>
              <p class="text-sm font-black text-amber-400" aria-label="Antes: ${r.qtdAntes}">${r.qtdAntes}</p>
            </div>
            <div class="w-5 text-center text-slate-600" aria-hidden="true">→</div>
            <div class="text-center">
              <p class="text-[7px] text-slate-600 uppercase font-bold mb-0.5">Depois</p>
              <p class="text-sm font-black ${r.qtdDepois <= 0 ? 'text-red-400' : r.qtdDepois <= CONSTANTS.LOW_STOCK_THRESHOLD ? 'text-amber-400' : 'text-emerald-400'}" aria-label="Depois: ${r.qtdDepois}">${r.qtdDepois}</p>
            </div>
            <div class="text-right">
              <p class="text-[9px] font-black text-slate-300">${r.data}</p>
              <p class="text-[8px] text-slate-600 font-bold">${r.hora}</p>
            </div>
          </div>
        </article>`;
      frag.appendChild(div.firstElementChild);
    });
    cont.innerHTML = '';
    cont.appendChild(frag);
  }

  function _renderCaixaLogs() {
    const cont = Utils.el('caixaLogs');
    if (!cont) return;

    const logs = Store.Selectors.getCaixa() || [];
    if (logs.length === 0) {
      cont.innerHTML = '<div class="text-center py-6 text-slate-700 text-[10px] font-bold uppercase" role="status">Sem registos de caixa</div>';
      return;
    }

    cont.innerHTML = logs.map(c => {
      const isAbertura = c.tipo === 'ABERTURA';
      const cor  = isAbertura ? 'emerald' : 'red';
      const icon = isAbertura ? 'fa-cash-register' : 'fa-lock';
      const info = c.valor != null
        ? `${isAbertura ? 'Troco inicial' : 'Valor apurado'}: ${Utils.formatCurrency(parseFloat(c.valor))}`
        : (c.responsavel || c.descricao || '—');

      return `
        <div class="flex items-center justify-between bg-slate-900/50 p-4 rounded-xl border border-white/5" role="row">
          <div class="flex items-center gap-3">
            <div class="w-8 h-8 rounded-xl flex items-center justify-center bg-${cor}-500/15 text-${cor}-400" aria-hidden="true">
              <i class="fas ${icon} text-xs"></i>
            </div>
            <div>
              <p class="text-[10px] font-black text-slate-200">${c.tipo} DE CAIXA</p>
              <p class="text-[9px] text-slate-500 font-bold">${info}</p>
            </div>
          </div>
          <div class="text-right">
            <p class="text-[9px] font-black text-slate-300">${c.data}</p>
            <p class="text-[8px] text-slate-600 font-bold">${c.hora}</p>
          </div>
        </div>`;
    }).join('');
  }

  return Object.freeze({ renderInventario });
})();

/* ═══════════════════════════════════════════════════════════════════
   DATA SERVICE — Backup, Importação e Reset
═══════════════════════════════════════════════════════════════════ */
const DataService = (() => {
  /**
   * Atualiza painel de dados
   */
  function renderDados() {
    const set = (id, v) => { const el = Utils.el(id); if (el) el.textContent = v; };
    set('statProd', Store.Selectors.getEstoque().length);
    set('statVend', Store.Selectors.getVendas().length);
    set('statPont', Store.getState().ponto?.length || 0);
    set('statInv',  Store.Selectors.getInventario().length);
    set('statDlv',  Store.Selectors.getPedidos().length);
    _renderRestorePoints();
  }

  /**
   * Exporta backup completo como JSON
   */
  function exportarBackup() {
    const state   = Store.getState();
    const version = '9.0.0';
    const ts      = new Date().toISOString();
    const payload = {
      _backupVersion: version,
      _exportedAt:    ts,
      _exportedBy:    AuthService.getRole() || 'admin',
      _checksum:      state.estoque?.length + '.' + (state.vendas?.length || 0),
      data:           state,
    };

    // Salva ponto de restauração local (máx 10)
    Store.mutate(s => {
      if (!Array.isArray(s.backupHistory)) s.backupHistory = [];
      s.backupHistory.unshift({
        id:         Utils.generateId(),
        version,
        timestamp:  ts,
        label:      `Backup manual — ${Utils.timestamp()}`,
        produtos:   state.estoque?.length || 0,
        vendas:     state.vendas?.length  || 0,
        snapshot:   JSON.stringify(payload).slice(0, 50_000), // ~50KB snapshot parcial
      });
    }, true);

    Utils.downloadBlob(
      JSON.stringify(payload, null, 2),
      'application/json',
      `CH_Geladas_BKP_v${version}_${ts.slice(0,10)}.json`
    );
    const lastEl = Utils.el('lastBackup');
    if (lastEl) lastEl.textContent = `Último: ${Utils.timestamp()}`;
    UIService.showToast('Backup', `v${version} exportado com sucesso`);
    SyncService.persist();
    _renderRestorePoints();
  }

  function _renderRestorePoints() {
    const cont = Utils.el('restorePointsList');
    if (!cont) return;
    const history = Store.getState().backupHistory || [];
    if (!history.length) {
      cont.innerHTML = '<p class="text-[9px] text-slate-600 text-center py-4 font-bold">Nenhum ponto salvo</p>';
      return;
    }
    cont.innerHTML = history.map((h, i) => `
      <div class="flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl border border-white/5 bg-slate-900/40">
        <div class="flex-1 min-w-0">
          <p class="text-[9px] font-black text-slate-200 truncate">${h.label || 'Backup'}</p>
          <p class="text-[8px] text-slate-600 font-bold">${h.produtos || 0} prod · ${h.vendas || 0} vendas</p>
        </div>
        <div class="flex gap-1 flex-shrink-0">
          ${h.snapshot ? `<button onclick="restoreFromPoint(${i})" class="px-2 py-1 rounded-lg bg-amber-500/10 text-amber-400 hover:bg-amber-500/25 text-[8px] font-black transition-all">Restaurar</button>` : ''}
          <button onclick="deleteRestorePoint(${i})" class="w-6 h-6 rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/25 flex items-center justify-center transition-all"><i class="fas fa-times text-[8px]"></i></button>
        </div>
      </div>`).join('');
  }

  function importarDados(input) {
    const file = input.files?.[0];
    if (!file) return;

    // Valida extensão e tamanho
    if (!file.name.endsWith('.json')) {
      UIService.showToast('Erro', 'Selecione um arquivo .json', 'error');
      input.value = '';
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      UIService.showToast('Erro', 'Arquivo muito grande (máx 50MB)', 'error');
      input.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = async e => {
      try {
        const parsed = Utils.safeJsonParse(e.target.result, null);
        if (!parsed) throw new Error('JSON inválido');

        const data = parsed.data ?? parsed;

        // Validação estrutural
        if (!Array.isArray(data.estoque)) {
          UIService.showToast('Erro', 'Arquivo inválido — campo estoque ausente', 'error');
          return;
        }
        if (typeof data.vendas !== 'undefined' && !Array.isArray(data.vendas)) {
          UIService.showToast('Erro', 'Arquivo corrompido — campo vendas inválido', 'error');
          return;
        }

        // Checksum simples
        const expectedCheck = parsed._checksum;
        if (expectedCheck) {
          const actualCheck = data.estoque.length + '.' + (data.vendas?.length || 0);
          if (expectedCheck !== actualCheck) {
            UIService.showToast('Atenção', `Checksum divergente (${actualCheck} ≠ ${expectedCheck}) — pode estar incompleto`, 'warning');
          }
        }

        const infoStr = `Versão: ${parsed._backupVersion || 'legado'}\nProdutos: ${data.estoque.length}\nVendas: ${(data.vendas || []).length}\nData: ${parsed._exportedAt ? new Date(parsed._exportedAt).toLocaleString('pt-BR') : '—'}`;

        const ok = await Dialog.danger({
          title:        'Restaurar Backup?',
          message:      infoStr + '\n\nIrá SUBSTITUIR todos os dados atuais.',
          icon:         'fa-file-import',
          confirmLabel: 'Restaurar',
        });
        if (!ok) { input.value = ''; return; }

        Store.setState(data);
        SyncService.persistNow();
        UIService.showToast('Sucesso', 'Dados restaurados!');
        setTimeout(() => location.reload(), 1_500);
      } catch (err) {
        console.error('[DataService] Import failed:', err);
        UIService.showToast('Erro', 'Falha ao ler arquivo: ' + (err.message || '?'), 'error');
      } finally {
        input.value = '';
      }
    };
    reader.readAsText(file);
  }

  return Object.freeze({ renderDados, exportarBackup, importarDados, resetSistema, _renderRestorePoints });
  async function resetSistema() {
    try {
      if (!AuthService.isAdmin()) {
        UIService.showToast('Negado', 'Apenas administradores podem resetar o sistema', 'error');
        return;
      }
      const ok = await Dialog.promptDanger({
        title:        '⚠️ Reset Completo do Sistema',
        message:      'Esta ação irá apagar TODOS os dados (estoque, vendas, caixa, ponto, delivery). IMPOSSÍVEL desfazer.',
        keyword:      'DELETAR',
        confirmLabel: 'Confirmar Reset',
      });
      if (!ok) {
        UIService.showToast('Cancelado', 'Reset abortado', 'warning');
        return;
      }
      Store.resetState();
      SyncService.persist();
      UIService.showToast('Reset', 'Todos os dados foram apagados', 'error');
      setTimeout(() => location.reload(), 1_500);
    } catch (err) {
      console.error('[DataService.resetSistema]', err);
      UIService.showToast('Erro', 'Falha ao resetar. Tente novamente.', 'error');
    }
  }

  return Object.freeze({ renderDados, exportarBackup, importarDados, resetSistema });
})();

/* ═══════════════════════════════════════════════════════════════════
   ESTOQUE SERVICE — CRUD de produtos (painel admin)
═══════════════════════════════════════════════════════════════════ */
const EstoqueService = (() => {
  // Estado do formulário de produto (novo ou edição)
  let _editingId = null;
  let _tempPacks = []; // packs em edição no formulário principal
  let _epPacks   = []; // packs no modal de edição rápida

  /* ── Getters ─────────────────────────────────────────────── */
  const getTempPacks = () => [..._tempPacks];
  const getEpPacks   = () => [..._epPacks];
  const isEditing    = () => _editingId !== null;

  /* ── Form Principal ──────────────────────────────────────── */
  function resetForm() {
    _editingId = null;
    _tempPacks = [];
    ['pNome', 'pCusto', 'pQtd', 'pPreco', 'editId'].forEach(id => {
      const el = Utils.el(id); if (el) el.value = '';
    });
    // Reset e popular select de categorias
    const pCat = Utils.el('pCategoria');
    if (pCat) {
      const cats = Store.Selectors.getConfig()?.categorias || [];
      pCat.innerHTML = '<option value="">— Sem categoria —</option>' +
        cats.map(c => `<option value="${c}">${c}</option>`).join('');
    }
    const formTitle = Utils.el('formTitle');
    if (formTitle) formTitle.textContent = 'Novo Produto';
    const btnSalvar = Utils.el('btnSalvar');
    if (btnSalvar) btnSalvar.textContent = 'Registar Produto';
    const btnCancelar = Utils.el('btnCancelar');
    if (btnCancelar) btnCancelar.classList.add('hidden');
    renderPackList('tPackList', _tempPacks);
  }

  function adicionarPack() {
    const un    = parseInt(Utils.el('tPackUn')?.value)   || 0;
    const preco = parseFloat(Utils.el('tPackPr')?.value) || 0;
    if (!un || !preco) { UIService.showToast('Pack', 'Preencha un. e preço', 'error'); return; }
    _tempPacks.push({ un, preco });
    const pUn = Utils.el('tPackUn'); if (pUn) pUn.value = '';
    const pP  = Utils.el('tPackPr'); if (pP) pP.value = '';
    renderPackList('tPackList', _tempPacks);
  }

  function removerTempPack(i) {
    _tempPacks.splice(i, 1);
    renderPackList('tPackList', _tempPacks);
  }

  function salvarProduto() {
    const nome      = Utils.el('pNome')?.value.trim()    || '';
    const preco     = parseFloat(Utils.el('pPreco')?.value) || 0;
    const custo     = parseFloat(Utils.el('pCusto')?.value) || 0;
    const qtd       = parseInt(Utils.el('pQtd')?.value)     || 0;
    const categoria = Utils.el('pCategoria')?.value || '';

    const validation = Validators.validateProduct({ nome, precoUn: preco, custoUn: custo, qtdUn: qtd });
    if (!validation.valid) { UIService.showToast('Erro', validation.errors[0], 'error'); return; }

    if (_editingId !== null) {
      const prodAntes = Store.Selectors.getProdutoById(_editingId);
      const qtdAntes  = prodAntes?.qtdUn ?? 0;
      Store.mutate(state => {
        const idx = state.estoque.findIndex(p => String(p.id) === String(_editingId));
        if (idx !== -1)
          state.estoque[idx] = { ...state.estoque[idx], nome, precoUn: preco, custoUn: custo, qtdUn: qtd, categoria, packs: [..._tempPacks] };
      }, true);
      // Auditoria de estoque quando quantidade mudou
      if (qtdAntes !== qtd) {
        _registrarAuditEstoque({
          prodId: _editingId, produto: nome,
          qtdAntes, qtdDepois: qtd,
          motivo: 'Edição de produto (formulário)',
          responsavel: 'Admin',
          tipo: 'AJUSTE',
        });
      }
      UIService.showToast('Estoque', `${nome} atualizado`);
    } else {
      const novoId = Utils.generateId();
      Store.mutate(state => {
        state.estoque.push({ id: novoId, nome, precoUn: preco, custoUn: custo, qtdUn: qtd, categoria, packs: [..._tempPacks] });
      }, true);
      _registrarAuditEstoque({
        prodId: novoId, produto: nome,
        qtdAntes: 0, qtdDepois: qtd,
        motivo: 'Cadastro inicial',
        responsavel: 'Admin',
        tipo: 'ENTRADA',
      });
      UIService.showToast('Estoque', `${nome} adicionado`);
    }

    SyncService.persist();
    resetForm();
    EventBus.emit('estoque:updated');
  }

  function editarProduto(prodId) {
    const prod = Store.Selectors.getProdutoById(prodId);
    if (!prod) return;
    _editingId = prod.id;
    _tempPacks = [...(prod.packs || [])];

    const set = (id, val) => { const el = Utils.el(id); if (el) el.value = val ?? ''; };
    set('editId',  prod.id);
    set('pNome',   prod.nome);
    set('pPreco',  prod.precoUn);
    set('pCusto',  prod.custoUn);
    set('pQtd',    prod.qtdUn);

    // Popular e definir categoria
    const pCat = Utils.el('pCategoria');
    if (pCat) {
      const cats = Store.Selectors.getConfig()?.categorias || [];
      pCat.innerHTML = '<option value="">— Sem categoria —</option>' +
        cats.map(c => `<option value="${c}"${c === (prod.categoria || '') ? ' selected' : ''}>${c}</option>`).join('');
    }

    const formTitle = Utils.el('formTitle');
    if (formTitle) formTitle.textContent = 'Editar Produto';
    const btnSalvar = Utils.el('btnSalvar');
    if (btnSalvar) btnSalvar.textContent = 'Salvar Alterações';
    const btnCancelar = Utils.el('btnCancelar');
    if (btnCancelar) btnCancelar.classList.remove('hidden');
    renderPackList('tPackList', _tempPacks);

    Utils.el('formTitle')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function removerProduto(prodId) {
    try {
      const prod = Store.Selectors.getProdutoById(prodId);
      if (!prod) return;
      const ok = await Dialog.danger({
        title:        `Remover "${prod.nome}"?`,
        message:      'O produto será excluído do estoque. Esta ação não pode ser desfeita.',
        icon:         'fa-box-open',
        confirmLabel: 'Remover',
      });
      if (!ok) return;
      const qtdSnap = prod.qtdUn;
      Store.mutate(state => {
        const idx = state.estoque.findIndex(p => String(p.id) === String(prodId));
        if (idx !== -1) state.estoque.splice(idx, 1);
      }, true);
      _registrarAuditEstoque({
        prodId, produto: prod.nome,
        qtdAntes: qtdSnap, qtdDepois: 0,
        motivo: 'Produto removido do estoque',
        tipo:   'REMOCAO',
      });
      SyncService.persist();
      UIService.showToast('Produto removido', '', 'warning');
      EventBus.emit('estoque:updated');
    } catch (err) { console.error('[estoque.removerProduto]', err); }
  }

  /* ── Edição Rápida (modal) ───────────────────────────────── */
  function abrirEdicaoRapida(prodId) {
    const prod = Store.Selectors.getProdutoById(prodId);
    if (!prod) return;
    _epPacks = [...(prod.packs || [])];

    const set = (id, val) => { const el = Utils.el(id); if (el) el.value = val ?? ''; };
    set('epId',    prod.id);
    set('epNome',  prod.nome);
    set('epPreco', prod.precoUn);
    set('epCusto', prod.custoUn);
    set('epQtd',   prod.qtdUn);
    renderPackList('epPackList', _epPacks);

    // Preencher select de categorias
    const sel  = Utils.el('epCategoria');
    if (sel) {
      const cats = Store.Selectors.getConfig()?.categorias || [];
      sel.innerHTML = '<option value="">— Sem categoria —</option>' +
        cats.map(c => `<option value="${c}"${c === (prod.categoria || '') ? ' selected' : ''}>${c}</option>`).join('');
    }

    UIService.openModal('modalEditProd');
  }

  function epAdicionarPack() {
    const un    = parseInt(Utils.el('epPackUn')?.value)    || 0;
    const preco = parseFloat(Utils.el('epPackPr')?.value) || 0;
    if (!un || !preco) { UIService.showToast('Pack', 'Preencha un. e preço', 'error'); return; }
    _epPacks.push({ un, preco });
    const pUn = Utils.el('epPackUn'); if (pUn) pUn.value = '';
    const pP  = Utils.el('epPackPr'); if (pP) pP.value = '';
    renderPackList('epPackList', _epPacks);
  }

  function epRemoverPack(i) {
    _epPacks.splice(i, 1);
    renderPackList('epPackList', _epPacks);
  }

  function salvarEdicaoRapida() {
    const id       = String(Utils.el('epId')?.value || '');
    const nome     = Utils.el('epNome')?.value.trim() || '';
    const preco    = parseFloat(Utils.el('epPreco')?.value) || 0;
    const custo    = parseFloat(Utils.el('epCusto')?.value) || 0;
    const qtd      = parseInt(Utils.el('epQtd')?.value)     || 0;
    const categoria = Utils.el('epCategoria')?.value || '';

    const validation = Validators.validateProduct({ nome, precoUn: preco, custoUn: custo, qtdUn: qtd });
    if (!validation.valid) { UIService.showToast('Erro', validation.errors[0], 'error'); return; }

    const prodAntes = Store.Selectors.getProdutoById(id);
    const qtdAntes  = prodAntes?.qtdUn ?? 0;

    Store.mutate(state => {
      const idx = state.estoque.findIndex(p => String(p.id) === id);
      if (idx !== -1)
        state.estoque[idx] = { ...state.estoque[idx], nome, precoUn: preco, custoUn: custo, qtdUn: qtd, categoria, packs: [..._epPacks] };
    }, true);

    if (qtdAntes !== qtd) {
      const motivo = Utils.el('epMotivo')?.value.trim() || '';
      if (!motivo) {
        UIService.showToast('Auditoria', 'Informe o motivo do ajuste de estoque', 'warning');
        setTimeout(() => Utils.el('epMotivo')?.focus(), 100);
        return; // bloqueia o save sem motivo
      }
      _registrarAuditEstoque({
        prodId: id, produto: nome,
        qtdAntes, qtdDepois: qtd,
        motivo,
        responsavel: 'Admin',
        tipo: qtd > qtdAntes ? 'ENTRADA' : 'SAIDA',
      });
    }

    SyncService.persist();
    UIService.closeModal('modalEditProd');
    UIService.showToast('Produto', `${nome} atualizado`);
    EventBus.emit('estoque:updated');
  }

  /* ── Renderização de packs ───────────────────────────────── */
  function renderPackList(containerId, packs) {
    const cont = Utils.el(containerId);
    if (!cont) return;
    if (!packs.length) {
      cont.innerHTML = '<p class="text-[9px] text-slate-600 text-center py-2 font-bold">Sem packs</p>';
      return;
    }
    const isEp  = containerId === 'epPackList';
    const remFn = isEp ? 'epRemoverPack' : 'removerTempPack';
    cont.innerHTML = packs.map((pk, i) => `
      <div class="flex items-center justify-between bg-slate-900/50 px-3 py-2 rounded-xl border border-white/5">
        <span class="text-[10px] font-black text-slate-300">Pack ${pk.un} un · ${Utils.formatCurrency(pk.preco)}</span>
        <button onclick="${remFn}(${i})" class="text-red-400 hover:text-red-300 text-[10px]" aria-label="Remover pack ${pk.un} unidades"><i class="fas fa-times" aria-hidden="true"></i></button>
      </div>`).join('');
  }

  /* ── Estoque Renderer ────────────────────────────────────── */
  function renderEstoque() {
    const cont = Utils.el('gridEstoque');
    if (!cont) return;

    const busca   = (Utils.el('buscaEstoque')?.value || '').toLowerCase();
    const estoque = Store.Selectors.getEstoque();
    const filtrado = busca ? estoque.filter(p => p.nome.toLowerCase().includes(busca)) : estoque;

    if (filtrado.length === 0) {
      cont.innerHTML = `
        <div class="col-span-full text-center py-12 text-slate-700 text-[10px] font-bold uppercase" role="status">
          <i class="fas fa-box-open text-3xl block mb-3" aria-hidden="true"></i>
          ${busca ? 'Nenhum produto encontrado' : 'Nenhum produto cadastrado'}
        </div>`;
      return;
    }

    const frag = document.createDocumentFragment();
    filtrado.forEach(p => {
      const thresh     = Store.Selectors.getConfig()?.alertaStock ?? CONSTANTS.LOW_STOCK_THRESHOLD;
      const esgotado   = p.qtdUn <= 0;
      const baixo      = !esgotado && p.qtdUn <= thresh;
      const stockCls   = esgotado ? 'text-red-400' : baixo ? 'text-amber-400' : 'text-emerald-400';
      const margem     = p.precoUn > 0 ? ((1 - p.custoUn / p.precoUn) * 100).toFixed(0) : 0;

      const div = document.createElement('div');
      div.innerHTML = `
        <article class="glass-card rounded-2xl p-4 ${esgotado ? 'opacity-60' : ''}" aria-label="${RenderService._escapeHtml(p.nome)}">
          <div class="flex justify-between items-start mb-3">
            <div class="min-w-0 flex-1">
              <h3 class="text-[11px] font-black text-slate-200 truncate">${RenderService._escapeHtml(p.nome)}</h3>
              ${p.categoria ? `<span class="inline-block text-[7px] font-black uppercase tracking-wide bg-blue-500/10 text-blue-400 border border-blue-500/20 px-2 py-0.5 rounded-full mb-0.5">${RenderService._escapeHtml(p.categoria)}</span>` : ''}
              <p class="text-sm font-black text-white mt-0.5">${Utils.formatCurrency(p.precoUn)}</p>
              <p class="text-[8px] font-bold ${stockCls} mt-0.5">${esgotado ? 'Esgotado' : baixo ? `⚠ ${p.qtdUn} restante(s)` : `${p.qtdUn} em estoque`}</p>
            </div>
            <div class="text-right flex-shrink-0 ml-3">
              <span class="badge b-green text-[7px]">Margem ${margem}%</span>
              <p class="text-[7px] text-slate-600 font-bold mt-1">Custo: ${Utils.formatCurrency(p.custoUn)}</p>
            </div>
          </div>
          ${(p.packs || []).length > 0 ? `
            <div class="flex gap-1 flex-wrap mb-3">
              ${p.packs.map(pk => `<span class="badge b-amber text-[7px]">Pack ${pk.un}: ${Utils.formatCurrency(pk.preco)}</span>`).join('')}
            </div>` : ''}
          <div class="flex gap-2" role="group" aria-label="Ações de ${RenderService._escapeHtml(p.nome)}">
            <button onclick="editarProduto('${p.id}')" class="flex-1 py-2 rounded-lg bg-blue-500/10 text-blue-400 hover:bg-blue-500 hover:text-white text-[8px] font-black uppercase transition-all" aria-label="Editar ${RenderService._escapeHtml(p.nome)}">Editar</button>
            <button onclick="abrirEdicaoRapida('${p.id}')" class="py-2 px-3 rounded-lg bg-amber-500/10 text-amber-400 hover:bg-amber-500 hover:text-white text-[8px] font-black uppercase transition-all" aria-label="Edição rápida de ${RenderService._escapeHtml(p.nome)}"><i class="fas fa-bolt" aria-hidden="true"></i></button>
            <button onclick="removerProduto('${p.id}')" class="py-2 px-3 rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500 hover:text-white text-[8px] font-black uppercase transition-all" aria-label="Remover ${RenderService._escapeHtml(p.nome)}"><i class="fas fa-trash" aria-hidden="true"></i></button>
          </div>
        </article>`;
      frag.appendChild(div.firstElementChild);
    });
    cont.innerHTML = '';
    cont.appendChild(frag);
  }

  return Object.freeze({
    getTempPacks, getEpPacks, isEditing,
    resetForm, adicionarPack, removerTempPack, salvarProduto,
    editarProduto, removerProduto,
    abrirEdicaoRapida, epAdicionarPack, epRemoverPack, salvarEdicaoRapida,
    renderPackList, renderEstoque,
  });
})();

/* ═══════════════════════════════════════════════════════════════════
   REGISTRA LISTENERS
═══════════════════════════════════════════════════════════════════ */
EventBus.on('ponto:registered', () => PontoRenderer.renderPonto());
EventBus.on('ponto:updated',    () => PontoRenderer.renderPonto());
EventBus.on('ponto:deleted',    () => PontoRenderer.renderPonto());
EventBus.on('ponto:cleared',    () => PontoRenderer.renderPonto());
EventBus.on('caixa:aberto',     () => PontoRenderer.renderPonto());
EventBus.on('caixa:fechado',    () => PontoRenderer.renderPonto());
EventBus.on('estoque:updated',  () => {
  EstoqueService.renderEstoque();
  RenderService.renderCatalogo();
  RenderService.updateStats();
});

// Sync remoto (outro dispositivo gravou) — re-renderiza módulos que não têm
// listener próprio para sync:remote-applied: Ponto, Caixa, Estoque, Inventário.
// Cada render só executa se a aba correspondente estiver ativa, evitando trabalho
// desnecessário enquanto o usuário está em outra seção.
EventBus.on('sync:remote-applied', () => {
  const _ativo = id => !!Utils.el(`tab-${id}`)?.classList.contains('active');

  if (_ativo('ponto'))     PontoRenderer.renderPonto();
  if (_ativo('estoque'))   EstoqueService.renderEstoque();
  if (_ativo('inventario')) InventoryRenderer.renderInventario();
  if (_ativo('dados'))     DataService.renderDados();
});

/* ═══════════════════════════════════════════════════════════════════
   WINDOW BRIDGES — Compatibilidade com HTML inline
═══════════════════════════════════════════════════════════════════ */

// ── Ponto
function registarPonto(tipo)     { PontoService.registrar(tipo); }
function abrirEditarPonto(id)    { PontoService.abrirEditar(id); }
function setPontoTipo(tipo)      { PontoService._setPontoTipoBtn(tipo); }
function salvarEdicaoPonto()     { PontoService.salvarEdicao(); }
function apagarPonto(id)         { PontoService.apagar(id); }
function limparPonto()           { PontoService.limparTodos(); }
function renderPonto()           { PontoRenderer.renderPonto(); }

// ── Caixa
function abrirCaixa()            { CaixaService.abrirModalAbertura(); }
function fecharModalCaixa()      { UIService.closeModal('modalAbrirCaixa'); }
function confirmarAberturaCaixa(){ CaixaService.confirmarAbertura(); }
function fecharCaixa()           { CaixaService.abrirModalFechamento(); }
function fecharModalFechamento() { UIService.closeModal('modalFecharCaixa'); }
function confirmarFechamentoCaixa() { CaixaService.confirmarFechamento(); }

// ── Inventário
function renderInventario()      { InventoryRenderer.renderInventario(); }

// ── Dados
function renderDados()           { DataService.renderDados(); }
function exportarBackup()        { DataService.exportarBackup(); }
function importarDados(input)    { DataService.importarDados(input); }
function resetSistema()          { DataService.resetSistema(); }

async function restoreFromPoint(idx) {
  try {
    const history = Store.getState().backupHistory || [];
    const point   = history[idx];
    if (!point?.snapshot) return;
    const parsed = Utils.safeJsonParse(point.snapshot, null);
    if (!parsed) { UIService.showToast('Erro', 'Ponto de restauração inválido', 'error'); return; }
    const data = parsed.data ?? parsed;
    if (!Array.isArray(data.estoque)) { UIService.showToast('Erro', 'Snapshot incompleto', 'error'); return; }
    const ok = await Dialog.danger({
      title:        'Restaurar este ponto?',
      message:      `${point.label}\n${point.produtos} produtos · ${point.vendas} vendas\nSubstitui dados atuais.`,
      icon:         'fa-history',
      confirmLabel: 'Restaurar',
    });
    if (!ok) return;
    Store.setState(data);
    SyncService.persistNow();
    UIService.showToast('Restaurado', point.label, 'success');
    setTimeout(() => location.reload(), 1_500);
  } catch (err) { UIService.showToast('Erro', err.message || 'Falha', 'error'); }
}

async function deleteRestorePoint(idx) {
  Store.mutate(s => { s.backupHistory?.splice(idx, 1); }, true);
  SyncService.persist();
  DataService._renderRestorePoints();
}

// ── Estoque
function renderEstoque()         { EstoqueService.renderEstoque(); }
function resetFormEstoque()      { EstoqueService.resetForm(); }
function addPackForm()           { EstoqueService.adicionarPack(); }
function adicionarPack()         { EstoqueService.adicionarPack(); }
function removerTempPack(i)      { EstoqueService.removerTempPack(i); }
function salvarProduto()         { EstoqueService.salvarProduto(); }
function editarProduto(id)       { EstoqueService.editarProduto(id); }
function removerProduto(id)      { EstoqueService.removerProduto(id); }
function abrirEdicaoRapida(id)   { EstoqueService.abrirEdicaoRapida(id); }
function epAdicionarPack()       { EstoqueService.epAdicionarPack(); }
function addPackModal()          { EstoqueService.epAdicionarPack(); }
function epRemoverPack(i)        { EstoqueService.epRemoverPack(i); }
function salvarEdicaoRapida()    { EstoqueService.salvarEdicaoRapida(); }
function salvarProdModal()       { EstoqueService.salvarEdicaoRapida(); }

function ajusteStock(delta) {
  const el = Utils.el('epQtd');
  if (!el) return;
  const atual = parseInt(el.value) || 0;
  el.value = Math.max(0, atual + delta);
  // Quando a qtd muda via botão +/-, exibe campo de motivo
  const wrap = Utils.el('epMotivoWrap');
  if (wrap) wrap.classList.remove('hidden');
}

function entradaRapida() {
  const qtdEl     = Utils.el('epEntrada');
  const estoqueEl = Utils.el('epQtd');
  if (!qtdEl || !estoqueEl) return;
  const entrada = parseInt(qtdEl.value) || 0;
  if (entrada <= 0) { UIService.showToast('Atenção', 'Informe uma quantidade válida', 'warning'); return; }
  estoqueEl.value = (parseInt(estoqueEl.value) || 0) + entrada;
  qtdEl.value = '';
  UIService.showToast('Estoque', `+${entrada} unidades adicionadas`);
  const wrap = Utils.el('epMotivoWrap');
  if (wrap) wrap.classList.remove('hidden');
}

// ── Auditoria de Estoque
function _registrarAuditEstoque({ prodId, produto, qtdAntes, qtdDepois, motivo, responsavel, tipo }) {
  const role = AuthService.getRole();
  const resp = responsavel || (role === 'admin' ? 'Admin' : role === 'pdv' ? 'Colaborador' : 'Sistema');
  Store.mutate(state => {
    if (!Array.isArray(state.auditEstoque)) state.auditEstoque = [];
    state.auditEstoque.unshift({
      id:         Utils.generateId(),
      prodId:     String(prodId),
      produto:    String(produto),
      qtdAntes,
      qtdDepois,
      delta:      qtdDepois - qtdAntes,
      motivo:     motivo || '—',
      responsavel: resp,
      tipo:       tipo || 'AJUSTE',
      data:       Utils.todayISO(),
      hora:       Utils.now(),
      timestamp:  Date.now(),
    });
  }, true);
}

function renderAuditEstoque() {
  const cont = Utils.el('auditEstoqueLista');
  if (!cont) return;
  const filtroProd = (Utils.el('auditEstoqueFiltro')?.value || '').toLowerCase();
  let logs = Store.Selectors.getAuditEstoque();
  if (filtroProd) logs = logs.filter(l =>
    (l.produto || '').toLowerCase().includes(filtroProd) ||
    (l.motivo  || '').toLowerCase().includes(filtroProd)
  );
  if (!logs.length) {
    cont.innerHTML = '<p class="text-center text-slate-600 text-[9px] font-black uppercase py-8">Nenhum registro ainda</p>';
    return;
  }
  const frag = document.createDocumentFragment();
  logs.slice(0, 120).forEach(l => {
    const isEntrada = l.delta > 0;
    const div = document.createElement('div');
    div.innerHTML = `
      <div class="flex items-start gap-3 px-3 py-2.5 rounded-xl border ${isEntrada ? 'border-emerald-500/15 bg-emerald-500/5' : 'border-red-500/15 bg-red-500/5'}">
        <div class="w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5 ${isEntrada ? 'bg-emerald-500/20' : 'bg-red-500/20'}">
          <i class="fas ${isEntrada ? 'fa-arrow-up text-emerald-400' : 'fa-arrow-down text-red-400'} text-[9px]"></i>
        </div>
        <div class="flex-1 min-w-0">
          <p class="text-[10px] font-black text-slate-200 truncate">${l.produto || '—'}</p>
          <p class="text-[8px] text-slate-500 font-bold truncate">${l.motivo || '—'}</p>
          <p class="text-[8px] text-slate-600 font-bold">${l.data || ''} ${l.hora || ''} · ${l.responsavel || ''}</p>
        </div>
        <div class="text-right flex-shrink-0">
          <p class="text-[11px] font-black ${isEntrada ? 'text-emerald-400' : 'text-red-400'}">${isEntrada ? '+' : ''}${l.delta} un</p>
          <p class="text-[8px] text-slate-600">${l.qtdAntes} → ${l.qtdDepois}</p>
        </div>
      </div>`;
    frag.appendChild(div.firstElementChild);
  });
  cont.innerHTML = '';
  cont.appendChild(frag);
}

function pontoRelatorioMensal() { PontoService.exibirRelatorioMensal(); }
