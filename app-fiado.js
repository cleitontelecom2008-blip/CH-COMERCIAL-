/**
 * @fileoverview CH Geladas PDV — Fiado Module v1.0.0
 *
 * Sistema completo de vendas a prazo:
 *  - FiadoService    → CRUD de clientes, lançamento e baixa
 *  - FiadoRenderer   → Renderização de listas e modais
 */
'use strict';

/* ═══════════════════════════════════════════════════════════════════
   FIADO SERVICE
═══════════════════════════════════════════════════════════════════ */
const FiadoService = (() => {

  const getClientes     = () => Store.Selectors.getFiadoClientes();
  const getClienteById  = id => Store.Selectors.getFiadoClienteById(id);

  /* ── CRUD ─────────────────────────────────────────────────── */
  function salvarCliente(dados) {
    const { id, nome, limite, telefone } = dados;
    const nomeTrim = (nome || '').trim();
    if (!nomeTrim) { UIService.showToast('Erro', 'Nome é obrigatório', 'error'); return false; }
    const limiteVal = parseFloat(String(limite).replace(',', '.')) || 0;

    if (id) {
      Store.mutate(state => {
        const idx = state.fiado.clientes.findIndex(c => String(c.id) === String(id));
        if (idx !== -1) state.fiado.clientes[idx] = {
          ...state.fiado.clientes[idx],
          nome: nomeTrim, limite: limiteVal,
          telefone: (telefone || '').trim(),
        };
      }, true);
      UIService.showToast('Fiado', `${nomeTrim} atualizado`);
    } else {
      // Evita duplicata por nome
      const existe = getClientes().some(c => c.nome.toLowerCase() === nomeTrim.toLowerCase());
      if (existe) { UIService.showToast('Duplicata', `${nomeTrim} já cadastrado`, 'warning'); return false; }
      Store.mutate(state => {
        state.fiado.clientes.push({
          id:        Utils.generateId(),
          nome:      nomeTrim,
          limite:    limiteVal,
          saldo:     0,
          telefone:  (telefone || '').trim(),
          historico: [],
          criadoEm:  Utils.timestamp(),
        });
      }, true);
      UIService.showToast('Fiado', `${nomeTrim} cadastrado`);
    }
    SyncService.persist();
    return true;
  }

  async function removerCliente(id) {
    try {
      const c = getClienteById(id);
      if (!c) return;
      if ((c.saldo || 0) > 0.009) {
        UIService.showToast('Atenção', `${c.nome} tem R$ ${(c.saldo || 0).toFixed(2)} em aberto`, 'warning');
        return;
      }
      const ok = await Dialog.danger({
        title:        `Remover "${c.nome}"?`,
        message:      'Cliente e histórico serão excluídos.',
        icon:         'fa-user-times',
        confirmLabel: 'Remover',
      });
      if (!ok) return;
      Store.mutate(state => {
        const idx = state.fiado.clientes.findIndex(x => String(x.id) === String(id));
        if (idx !== -1) state.fiado.clientes.splice(idx, 1);
      }, true);
      SyncService.persist();
      UIService.showToast('Fiado', 'Cliente removido', 'warning');
      FiadoRenderer.render();
    } catch (err) { console.error('[FiadoService.removerCliente]', err); }
  }

  /* ── Lançamento de dívida ─────────────────────────────────── */
  function registrarVendaFiado(clienteId, valor, descricao = '') {
    const c = getClienteById(clienteId);
    if (!c) return false;

    // Bloqueio manual
    if (c.bloqueado) {
      UIService.showToast('Cliente Bloqueado', `${c.nome} está bloqueado para fiado`, 'error');
      return false;
    }

    const novoSaldo = (c.saldo || 0) + valor;
    if (c.limite > 0 && novoSaldo > c.limite + 0.009) {
      UIService.showToast('Limite Excedido',
        `Limite: ${Utils.formatCurrency(c.limite)} | Atual: ${Utils.formatCurrency(c.saldo || 0)}`, 'error');
      return false;
    }
    Store.mutate(state => {
      const idx = state.fiado.clientes.findIndex(x => String(x.id) === String(clienteId));
      if (idx !== -1) {
        const cli = state.fiado.clientes[idx];
        cli.saldo = (cli.saldo || 0) + valor;
        if (!Array.isArray(cli.historico)) cli.historico = [];
        cli.historico.unshift({
          id:        Utils.generateId(),
          tipo:      'DEBITO',
          valor,
          saldo:     cli.saldo,
          descricao: descricao || 'Venda fiado',
          data:      Utils.timestamp(),
          dataCurta: Utils.todayISO(),
        });
        if (cli.historico.length > 300) cli.historico.splice(300);

        // Bloqueio automático ao atingir 100% do limite
        if (cli.limite > 0 && cli.saldo >= cli.limite - 0.009) {
          cli.bloqueado = true;
          UIService.showToast('Limite atingido', `${cli.nome} bloqueado automaticamente`, 'warning');
        }
        // Alerta ao atingir 80% do limite
        else if (cli.limite > 0 && cli.saldo >= cli.limite * 0.8) {
          const pct = Math.round((cli.saldo / cli.limite) * 100);
          UIService.showToast('Alerta Fiado', `${cli.nome}: ${pct}% do limite usado`, 'warning');
          EventBus.emit('notif:fiado-alerta', { cliente: cli, pct });
        }
      }
    }, true);
    SyncService.persistNow();
    return true;
  }

  /* ── Baixa parcial ou total ───────────────────────────────── */
  function registrarPagamento(clienteId, valor, formaPgto = '') {
    const c = getClienteById(clienteId);
    if (!c) return false;
    const saldo = c.saldo || 0;
    if (saldo <= 0.009) { UIService.showToast('Atenção', 'Saldo já está zerado', 'warning'); return false; }
    const pagamento = Math.min(valor, saldo);

    Store.mutate(state => {
      const idx = state.fiado.clientes.findIndex(x => String(x.id) === String(clienteId));
      if (idx !== -1) {
        const cli = state.fiado.clientes[idx];
        cli.saldo = Math.max(0, (cli.saldo || 0) - pagamento);
        if (!Array.isArray(cli.historico)) cli.historico = [];
        cli.historico.unshift({
          id:        Utils.generateId(),
          tipo:      'CREDITO',
          valor:     pagamento,
          saldo:     cli.saldo,
          descricao: `Pagamento${formaPgto ? ' (' + formaPgto + ')' : ''}`,
          data:      Utils.timestamp(),
          dataCurta: Utils.todayISO(),
        });
        if (cli.historico.length > 300) cli.historico.splice(300);
        // Desbloqueio automático ao pagar e ficar abaixo do limite
        if (cli.bloqueado && (cli.limite <= 0 || cli.saldo < cli.limite - 0.009)) {
          cli.bloqueado = false;
        }
      }
    }, true);
    SyncService.persist();
    UIService.showToast('Fiado', `${Utils.formatCurrency(pagamento)} recebido de ${c.nome}`);
    return true;
  }

  /* ── KPIs ─────────────────────────────────────────────────── */
  function calcularTotais() {
    const clientes = getClientes();
    return {
      totalEmAberto:         clientes.reduce((a, c) => a + (c.saldo || 0), 0),
      clientesDevendo:       clientes.filter(c => (c.saldo || 0) > 0.009).length,
      clientesLimiteExcedido: clientes.filter(c => c.limite > 0 && (c.saldo || 0) >= c.limite).length,
      total:                 clientes.length,
    };
  }

  /* ── Fluxo de seleção de cliente ao finalizar com fiado ───── */
  async function abrirSelecaoCliente(valorVenda) {
    const clientes = getClientes();
    if (!clientes.length) {
      const novoNome = await Dialog.prompt({
        title:        'Nenhum cliente cadastrado',
        message:      'Informe o nome para criar o primeiro cliente:',
        placeholder:  'Nome do cliente',
        confirmLabel: 'Criar e Vender',
        icon:         'fa-user-plus',
        iconBg:       'bg-red-500/15',
        iconColor:    'text-red-400',
      });
      if (!novoNome) { _reativarBotoesFinalizar(); return; }
      if (!salvarCliente({ nome: novoNome, limite: 0 })) { _reativarBotoesFinalizar(); return; }
      const novo = getClientes().find(c => c.nome === novoNome.trim());
      if (novo) _processarVendaFiado(novo.id, valorVenda);
      return;
    }
    _renderModalSelecao(clientes, valorVenda);
  }

  function _reativarBotoesFinalizar() {
    const b = Utils.el('btnFinalizar'), m = Utils.el('btnFinalizarMob');
    if (b) b.disabled = false;
    if (m) m.disabled = false;
  }

  function _renderModalSelecao(clientes, valorVenda) {
    let modal = Utils.el('modalFiadoSelecao');
    if (!modal) {
      modal = document.createElement('div');
      modal.id        = 'modalFiadoSelecao';
      modal.className = 'modal';
      document.body.appendChild(modal);
    }

    const listHtml = clientes.map(c => {
      const saldo = c.saldo || 0;
      const lim   = c.limite || 0;
      const blq   = lim > 0 && (saldo + valorVenda) > lim + 0.009;
      return `
        <button onclick="FiadoService._selecionarCliente('${c.id}',${valorVenda})"
          ${blq ? 'disabled' : ''}
          class="w-full flex items-center justify-between px-4 py-3 rounded-xl border transition-all text-left
            ${blq ? 'border-red-500/20 bg-red-500/5 opacity-50 cursor-not-allowed'
                  : 'border-white/8 bg-slate-900/60 hover:bg-blue-600/10 hover:border-blue-500/30'}">
          <div>
            <p class="text-[11px] font-black text-slate-200">${_esc(c.nome)}</p>
            <p class="text-[9px] text-slate-500 font-bold">${lim > 0 ? 'Limite: ' + Utils.formatCurrency(lim) : 'Sem limite'}</p>
          </div>
          <div class="text-right">
            <p class="text-[10px] font-black ${saldo > 0.009 ? 'text-red-400' : 'text-emerald-400'}">${saldo > 0.009 ? Utils.formatCurrency(saldo) : 'Zerado'}</p>
            ${blq ? '<p class="text-[8px] text-red-400 font-bold">Limite excedido</p>' : ''}
          </div>
        </button>`;
    }).join('');

    modal.innerHTML = `
      <div class="modal-box max-w-sm p-0 overflow-hidden">
        <div class="p-5 border-b border-white/5 flex items-center justify-between">
          <h3 class="text-sm font-black text-red-400 flex items-center gap-2">
            <i class="fas fa-handshake"></i> Venda Fiado
          </h3>
          <button onclick="FiadoService.cancelarSelecao()" class="w-8 h-8 rounded-lg bg-slate-800 text-slate-400 hover:text-white flex items-center justify-center">
            <i class="fas fa-times text-xs"></i>
          </button>
        </div>
        <div class="p-5">
          <div class="bg-red-500/10 border border-red-500/20 rounded-xl p-3 mb-4 text-center">
            <p class="text-[9px] text-red-300 font-bold uppercase">Valor a anotar</p>
            <p class="text-2xl font-black text-white">${Utils.formatCurrency(valorVenda)}</p>
          </div>
          <p class="text-[9px] font-black uppercase text-slate-500 mb-3">Selecionar cliente</p>
          <div class="space-y-2 max-h-56 overflow-y-auto scroll">${listHtml}</div>
          <button onclick="FiadoService._novoClienteRapido(${valorVenda})"
            class="w-full mt-3 py-2.5 rounded-xl bg-blue-600/20 text-blue-300 border border-blue-500/30 font-black text-[10px] uppercase hover:bg-blue-600/40 transition-all">
            <i class="fas fa-user-plus mr-1"></i>Novo Cliente
          </button>
          <button onclick="FiadoService.cancelarSelecao()"
            class="w-full mt-2 py-2.5 rounded-xl bg-slate-800 text-slate-400 font-black text-[10px] uppercase">
            Cancelar
          </button>
        </div>
      </div>`;
    UIService.openModal('modalFiadoSelecao');
  }

  function _selecionarCliente(clienteId, valorVenda) {
    UIService.closeModal('modalFiadoSelecao');
    _processarVendaFiado(clienteId, valorVenda);
  }

  async function _novoClienteRapido(valorVenda) {
    const nome = await Dialog.prompt({
      title: 'Novo Cliente', message: 'Nome:', placeholder: 'Ex: João Silva',
      confirmLabel: 'Criar', icon: 'fa-user-plus', iconBg: 'bg-blue-500/15', iconColor: 'text-blue-400',
    });
    if (!nome) return;
    if (!salvarCliente({ nome, limite: 0 })) return;
    UIService.closeModal('modalFiadoSelecao');
    const novo = getClientes().find(c => c.nome === nome.trim());
    if (novo) _processarVendaFiado(novo.id, valorVenda);
  }

  function cancelarSelecao() {
    UIService.closeModal('modalFiadoSelecao');
    _reativarBotoesFinalizar();
  }

  function _processarVendaFiado(clienteId, valorVenda) {
    const c = getClienteById(clienteId);
    if (!c) return;
    const novoSaldo = (c.saldo || 0) + valorVenda;
    if (c.limite > 0 && novoSaldo > c.limite + 0.009) {
      UIService.showToast('Limite Excedido', `${c.nome}: limite ${Utils.formatCurrency(c.limite)}`, 'error');
      _reativarBotoesFinalizar();
      return;
    }
    CartService.setFormaPgto(`Fiado (${c.nome})`);
    const venda = CartService.checkout();
    if (!venda) return;
    registrarVendaFiado(clienteId, valorVenda, `Venda #${String(venda.id).slice(-6)}`);
    UIService.showToast('Fiado', `${Utils.formatCurrency(valorVenda)} anotado · ${c.nome}`, 'warning');
    UIService.openModal('modalVenda');
    if (Utils.el('tab-fiado')?.classList.contains('active')) FiadoRenderer.render();
  }

  function _esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function toggleBloqueio(clienteId) {
    const c = getClienteById(clienteId);
    if (!c) return;
    Store.mutate(state => {
      const idx = state.fiado.clientes.findIndex(x => String(x.id) === String(clienteId));
      if (idx !== -1) state.fiado.clientes[idx].bloqueado = !state.fiado.clientes[idx].bloqueado;
    }, true);
    SyncService.persist();
    const atualizado = getClienteById(clienteId);
    UIService.showToast('Fiado', `${atualizado.nome} ${atualizado.bloqueado ? 'bloqueado' : 'desbloqueado'}`, atualizado.bloqueado ? 'error' : 'success');
    FiadoRenderer.render();
  }

  return Object.freeze({
    getClientes, getClienteById,
    salvarCliente, removerCliente,
    registrarVendaFiado, registrarPagamento, calcularTotais,
    abrirSelecaoCliente, cancelarSelecao,
    _selecionarCliente, _novoClienteRapido, toggleBloqueio,
  });
})();


/* ═══════════════════════════════════════════════════════════════════
   FIADO RENDERER
═══════════════════════════════════════════════════════════════════ */
const FiadoRenderer = (() => {
  let _filtro        = '';
  let _editandoId    = null;
  let _pgtoClienteId = null;

  /* ── Renderização principal ──────────────────────────────── */
  function render() {
    _kpis();
    _lista();
  }

  function _kpis() {
    const t  = FiadoService.calcularTotais();
    const _s = (id, v) => { const el = Utils.el(id); if (el) el.textContent = String(v ?? ''); };
    _s('fiadoKpiTotal',   Utils.formatCurrency(t.totalEmAberto));
    _s('fiadoKpiDevendo', t.clientesDevendo);
    _s('fiadoKpiLimite',  t.clientesLimiteExcedido);
    _s('fiadoKpiClients', t.total);
  }

  function _lista() {
    const cont = Utils.el('fiadoLista');
    if (!cont) return;
    let clientes = FiadoService.getClientes();
    if (_filtro) {
      const fl = _filtro.toLowerCase();
      clientes = clientes.filter(c => c.nome.toLowerCase().includes(fl));
    }
    // Ordena: devendo primeiro (maior saldo), depois zerado
    clientes.sort((a, b) => (b.saldo || 0) - (a.saldo || 0));

    if (!clientes.length) {
      cont.innerHTML = `
        <div class="flex flex-col items-center justify-center py-20 opacity-20">
          <i class="fas fa-handshake text-5xl mb-4 text-slate-600"></i>
          <p class="text-[10px] font-black uppercase tracking-widest text-slate-600">
            ${_filtro ? 'Nenhum cliente encontrado' : 'Nenhum cliente cadastrado ainda'}</p>
        </div>`;
      return;
    }

    const frag = document.createDocumentFragment();
    clientes.forEach(c => {
      const saldo   = c.saldo || 0;
      const limite  = c.limite || 0;
      const pct     = limite > 0 ? Math.min(100, (saldo / limite) * 100) : 0;
      const excedeu = limite > 0 && saldo >= limite;
      const devendo = saldo > 0.009;
      const barCls  = excedeu ? 'bg-red-500' : pct > 70 ? 'bg-amber-500' : 'bg-emerald-500';
      const bloqueado = !!c.bloqueado;

      const div = document.createElement('div');
      div.innerHTML = `
        <div class="glass rounded-2xl p-4 border ${excedeu ? 'border-red-500/30' : devendo ? 'border-amber-500/20' : 'border-white/5'}">
          <div class="flex items-start justify-between gap-2 mb-3">
            <div class="flex items-center gap-2.5 min-w-0">
              <div class="w-9 h-9 rounded-xl ${devendo ? 'bg-red-500/15' : 'bg-slate-800'} flex items-center justify-center flex-shrink-0">
                <i class="fas fa-user text-[11px] ${devendo ? 'text-red-400' : 'text-slate-500'}"></i>
              </div>
              <div class="min-w-0">
                <p class="text-[11px] font-black text-white truncate">${_esc(c.nome)}</p>
                <p class="text-[9px] font-bold text-slate-500">${limite > 0 ? 'Limite: ' + Utils.formatCurrency(limite) : 'Sem limite'}</p>
              </div>
            </div>
            <div class="text-right flex-shrink-0">
              <p class="text-sm font-black ${devendo ? 'text-red-400' : 'text-emerald-400'}">${Utils.formatCurrency(saldo)}</p>
              <p class="text-[8px] font-bold ${devendo ? 'text-red-500/60' : 'text-slate-600'} uppercase">${devendo ? 'em aberto' : 'zerado'}</p>
            </div>
          </div>
          ${limite > 0 ? `
          <div class="mb-3">
            <div class="h-1.5 bg-slate-800 rounded-full overflow-hidden">
              <div class="h-full ${barCls} rounded-full transition-all" style="width:${pct.toFixed(1)}%"></div>
            </div>
            <p class="text-[8px] text-slate-600 font-bold mt-1">${pct.toFixed(0)}% do limite${excedeu ? ' — EXCEDIDO' : ''}</p>
          </div>` : ''}
          <div class="flex gap-2">
            ${devendo ? `<button onclick="fiadoAbrirPagamento('${c.id}')"
              class="flex-1 py-2 rounded-xl bg-emerald-600/20 text-emerald-300 border border-emerald-500/30 font-black text-[9px] uppercase hover:bg-emerald-600/40 transition-all active:scale-95">
              <i class="fas fa-money-bill-wave mr-1"></i>Receber</button>` : ''}
            <button onclick="fiadoHistorico('${c.id}')"
              class="flex-1 py-2 rounded-xl bg-blue-600/20 text-blue-300 border border-blue-500/30 font-black text-[9px] uppercase hover:bg-blue-600/40 transition-all active:scale-95">
              <i class="fas fa-history mr-1"></i>Histórico</button>
            <button onclick="fiadoEditarCliente('${c.id}')"
              class="w-8 h-8 rounded-xl bg-slate-800 text-slate-400 hover:text-white flex items-center justify-center transition-all flex-shrink-0">
              <i class="fas fa-edit text-[9px]"></i></button>
            <button onclick="fiadoRemoverCliente('${c.id}')"
              class="w-8 h-8 rounded-xl bg-red-500/10 text-red-400 hover:bg-red-500/25 flex items-center justify-center transition-all flex-shrink-0">
              <i class="fas fa-trash text-[9px]"></i></button>
          </div>
        </div>`;
      frag.appendChild(div.firstElementChild);
    });
    cont.innerHTML = '';
    cont.appendChild(frag);
  }

  /* ── Formulário de cliente ───────────────────────────────── */
  function abrirForm(id = null) {
    _editandoId = id;
    const c = id ? FiadoService.getClienteById(id) : null;
    const _set = (elId, val) => { const el = Utils.el(elId); if (el) el.value = val ?? ''; };
    _set('fiadoFNome',     c?.nome || '');
    _set('fiadoFLimite',   c?.limite > 0 ? c.limite : '');
    _set('fiadoFTel',      c?.telefone || '');
    const tEl = Utils.el('fiadoFormTitulo');
    if (tEl) tEl.textContent = id ? 'Editar Cliente' : 'Novo Cliente';
    UIService.openModal('modalFiadoCliente');
    setTimeout(() => Utils.el('fiadoFNome')?.focus(), 220);
  }

  function salvarForm() {
    const nome    = Utils.el('fiadoFNome')?.value.trim();
    const limite  = Utils.el('fiadoFLimite')?.value;
    const telefone = Utils.el('fiadoFTel')?.value;
    const ok = FiadoService.salvarCliente({ id: _editandoId, nome, limite, telefone });
    if (!ok) return;
    UIService.closeModal('modalFiadoCliente');
    render();
  }

  /* ── Recebimento ─────────────────────────────────────────── */
  function abrirPagamento(clienteId) {
    const c = FiadoService.getClienteById(clienteId);
    if (!c) return;
    _pgtoClienteId = clienteId;
    const _s = (id, v) => { const el = Utils.el(id); if (el) el.textContent = String(v ?? ''); };
    _s('fiadoPgtoNome', c.nome);
    _s('fiadoPgtoSaldo', `Saldo em aberto: ${Utils.formatCurrency(c.saldo || 0)}`);
    const val = Utils.el('fiadoPgtoValor');
    if (val) val.value = '';
    const formaEl = Utils.el('fiadoPgtoForma');
    if (formaEl) formaEl.value = 'Dinheiro';
    UIService.openModal('modalFiadoPagamento');
    setTimeout(() => Utils.el('fiadoPgtoValor')?.focus(), 220);
  }

  function confirmarPagamento() {
    const val = parseFloat(Utils.el('fiadoPgtoValor')?.value?.replace(',', '.')) || 0;
    if (val <= 0) { UIService.showToast('Atenção', 'Informe o valor recebido', 'warning'); return; }
    const forma = Utils.el('fiadoPgtoForma')?.value || 'Dinheiro';
    const ok = FiadoService.registrarPagamento(_pgtoClienteId, val, forma);
    if (!ok) return;
    UIService.closeModal('modalFiadoPagamento');
    render();
  }

  /* ── Histórico por cliente ───────────────────────────────── */
  function verHistorico(clienteId) {
    const c = FiadoService.getClienteById(clienteId);
    if (!c) return;
    const hist  = (c.historico || []).slice(0, 60);
    const modal = Utils.el('modalFiadoHistorico');
    if (!modal) return;
    const tEl = Utils.el('fiadoHistTitulo');
    const lEl = Utils.el('fiadoHistLista');
    if (tEl) tEl.textContent = `Histórico — ${c.nome}`;
    if (lEl) {
      if (!hist.length) {
        lEl.innerHTML = '<p class="text-center text-slate-600 text-[10px] font-bold py-8">Sem histórico</p>';
      } else {
        lEl.innerHTML = hist.map(h => `
          <div class="flex items-center justify-between px-3 py-2.5 rounded-xl ${h.tipo === 'CREDITO'
            ? 'bg-emerald-500/5 border border-emerald-500/15'
            : 'bg-red-500/5 border border-red-500/10'}">
            <div>
              <p class="text-[10px] font-black ${h.tipo === 'CREDITO' ? 'text-emerald-400' : 'text-red-400'}">
                ${h.tipo === 'CREDITO' ? '⬆ ' + _esc(h.descricao) : '⬇ ' + _esc(h.descricao || 'Venda')}</p>
              <p class="text-[8px] text-slate-600 font-bold">${h.data || ''}</p>
            </div>
            <div class="text-right">
              <p class="text-[11px] font-black ${h.tipo === 'CREDITO' ? 'text-emerald-400' : 'text-red-400'}">
                ${h.tipo === 'CREDITO' ? '-' : '+'}${Utils.formatCurrency(h.valor)}</p>
              <p class="text-[8px] text-slate-600">Saldo: ${Utils.formatCurrency(h.saldo || 0)}</p>
            </div>
          </div>`).join('');
      }
    }
    UIService.openModal('modalFiadoHistorico');
  }

  function setFiltro(q) { _filtro = q; _lista(); }

  function _esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  return Object.freeze({ render, abrirForm, salvarForm, abrirPagamento, confirmarPagamento, verHistorico, setFiltro });
})();


/* ═══════════════════════════════════════════════════════════════════
   EVENT LISTENERS
═══════════════════════════════════════════════════════════════════ */
EventBus.on('sync:remote-applied', () => {
  if (Utils.el('tab-fiado')?.classList.contains('active')) FiadoRenderer.render();
});

/* ═══════════════════════════════════════════════════════════════════
   WINDOW BRIDGES
═══════════════════════════════════════════════════════════════════ */
function renderFiado()               { FiadoRenderer.render(); }
function fiadoAbrirForm(id)          { FiadoRenderer.abrirForm(id ?? null); }
function fiadoEditarCliente(id)      { FiadoRenderer.abrirForm(id); }
function fiadoSalvarCliente()        { FiadoRenderer.salvarForm(); }
async function fiadoRemoverCliente(id) {
  await FiadoService.removerCliente(id);
  FiadoRenderer.render();
}
function fiadoAbrirPagamento(id)     { FiadoRenderer.abrirPagamento(id); }
function fiadoConfirmarPagamento()   { FiadoRenderer.confirmarPagamento(); }
function fiadoHistorico(id)          { FiadoRenderer.verHistorico(id); }
function fiadoFiltrar(q)             { FiadoRenderer.setFiltro(q); }
