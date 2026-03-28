/**
 * @fileoverview CH Geladas PDV — Delivery Module
 * @version 5.0.0-enterprise
 *
 * Módulos:
 *  - DeliveryConstants  → Enums e constantes de domínio
 *  - DeliveryValidators → Validações específicas de delivery
 *  - DeliveryService    → Lógica de negócio: pedidos, zonas, entregadores
 *  - DeliveryRenderer   → Renderização pura e sem efeitos colaterais
 *  - PublicOrderService → Fluxo de pedido público (cardápio online)
 *  - ManualOrderService → Fluxo de pedido manual pelo operador
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════════
   DELIVERY CONSTANTS
═══════════════════════════════════════════════════════════════════ */
const DeliveryConstants = Object.freeze({
  STATUS: Object.freeze({
    NOVO:       'NOVO',
    PREPARANDO: 'PREPARANDO',
    A_CAMINHO:  'A_CAMINHO',
    ENTREGUE:   'ENTREGUE',
    CANCELADO:  'CANCELADO',
  }),

  STATUS_LABEL: Object.freeze({
    NOVO:       'Novo',
    PREPARANDO: 'Preparando',
    A_CAMINHO:  'A Caminho',
    ENTREGUE:   'Entregue',
    CANCELADO:  'Cancelado',
  }),

  STATUS_CSS: Object.freeze({
    NOVO:       'ds-novo',
    PREPARANDO: 'ds-preparando',
    A_CAMINHO:  'ds-caminho',
    ENTREGUE:   'ds-entregue',
    CANCELADO:  'ds-cancelado',
  }),

  PROX_STATUS: Object.freeze({
    NOVO:       'PREPARANDO',
    PREPARANDO: 'A_CAMINHO',
    A_CAMINHO:  'ENTREGUE',
  }),

  PROX_LABEL: Object.freeze({
    NOVO:       'Iniciar Preparo',
    PREPARANDO: 'Saiu para Entrega',
    A_CAMINHO:  'Marcar Entregue',
  }),

  PROX_COLOR: Object.freeze({
    NOVO:       'bg-amber-600 hover:bg-amber-500',
    PREPARANDO: 'bg-purple-600 hover:bg-purple-500',
    A_CAMINHO:  'bg-emerald-600 hover:bg-emerald-500',
  }),

  WPP_STATUS_MSG: Object.freeze({
    NOVO:       '✅ Pedido recebido! Estamos preparando em breve.',
    PREPARANDO: '🍺 Seu pedido está sendo preparado agora!',
    A_CAMINHO:  '🏍️ Seu pedido saiu para entrega! Aguarde...',
    ENTREGUE:   '✅ Pedido entregue! Obrigado pela preferência 🙏',
    CANCELADO:  '❌ Seu pedido foi cancelado. Entre em contato para mais informações.',
  }),

  FILTROS: Object.freeze(['TODOS', 'NOVO', 'PREPARANDO', 'A_CAMINHO', 'ENTREGUE', 'CANCELADO']),
});

/* ═══════════════════════════════════════════════════════════════════
   DELIVERY VALIDATORS
═══════════════════════════════════════════════════════════════════ */
const DeliveryValidators = Object.freeze({
  /**
   * Valida dados de um pedido manual
   * @param {object} dados
   * @returns {{ valid: boolean, errors: string[] }}
   */
  validatePedido(dados) {
    const errors = [];
    if (!Validators.isNonEmptyString(dados.clienteNome)) errors.push('Nome do cliente é obrigatório');
    if (!Validators.isNonEmptyString(dados.clienteTel))  errors.push('Telefone é obrigatório');
    if (!Validators.isNonEmptyString(dados.endereco))    errors.push('Endereço é obrigatório');
    if (!Validators.isNonEmptyArray(dados.itens))        errors.push('Adicione pelo menos 1 produto');
    return { valid: errors.length === 0, errors };
  },

  /**
   * Valida zona de entrega
   * @param {{ nome: string, taxa: number }} zona
   * @returns {{ valid: boolean, errors: string[] }}
   */
  validateZona(zona) {
    const errors = [];
    if (!Validators.isNonEmptyString(zona.nome)) errors.push('Nome da zona é obrigatório');
    if (!Validators.isPositiveNumber(zona.taxa)) errors.push('Taxa inválida');
    return { valid: errors.length === 0, errors };
  },

  /**
   * Valida entregador
   * @param {{ nome: string }} entregador
   * @returns {{ valid: boolean, errors: string[] }}
   */
  validateEntregador(entregador) {
    const errors = [];
    if (!Validators.isNonEmptyString(entregador.nome)) errors.push('Nome do entregador é obrigatório');
    return { valid: errors.length === 0, errors };
  },
});

/* ═══════════════════════════════════════════════════════════════════
   DELIVERY SERVICE — Lógica de negócio
═══════════════════════════════════════════════════════════════════ */
const DeliveryService = (() => {
  /** Filtro ativo na lista de pedidos */
  let _filtroAtivo = 'TODOS';

  /* ── Getters ─────────────────────────────────────────────── */
  const getFiltro         = () => _filtroAtivo;
  const setFiltro         = f => { _filtroAtivo = f; EventBus.emit('delivery:filtro-changed', f); };

  /* ── Sequencial de pedido ────────────────────────────────── */
  function _proximoNumPedido() {
    const pedidos = Store.Selectors.getPedidos();
    return pedidos.length > 0
      ? Math.max(...pedidos.map(p => p.num || 0)) + 1
      : 1001;
  }

  /* ── Avança status ───────────────────────────────────────── */
  /**
   * @param {string|number} pedId
   */
  function avancarStatus(pedId) {
    const pedido = Store.Selectors.getPedidoById(pedId);
    if (!pedido) return;
    const prox = DeliveryConstants.PROX_STATUS[pedido.status];
    if (!prox) return;

    Store.mutate(state => {
      const p = state.delivery.pedidos.find(x => String(x.id) === String(pedId));
      if (!p) return;
      p.status = prox;
      if (prox === DeliveryConstants.STATUS.ENTREGUE) {
        p.dataEntrega = Utils.timestamp();

        // ── FIX: venda só é registrada no financeiro quando ADM aprova (ENTREGUE) ──
        const today   = Utils.todayISO();
        const nowStr  = Utils.now();
        const itens   = pedido.itens || [];
        const sub     = pedido.subtotal || 0;
        const taxa    = pedido.taxaEntrega || 0;
        const totalCusto = itens.reduce((a, b) => {
          const pr = state.estoque.find(e => String(e.id) === String(b.prodId));
          return a + (pr ? pr.custoUn * b.qtd : 0);
        }, 0);
        state.vendas.unshift({
          id:          Utils.generateId(),
          total:       sub + taxa,
          lucro:       (sub + taxa) - totalCusto,
          data:        Utils.timestamp(),
          dataCurta:   today,
          hora:        nowStr,
          itens:       itens.map(i => ({ ...i, label: 'DELIVERY' })),
          origem:      'DELIVERY',
          pedidoNum:   pedido.num,
        });
      }
    }, true);

    SyncService.persist();
    UIService.showToast('Delivery', `Pedido #${pedido.num} → ${DeliveryConstants.STATUS_LABEL[prox]}`);
    UIService.closeModal('modalPedido');
    EventBus.emit('delivery:status-changed', Store.Selectors.getPedidoById(pedId));

    // Notifica o financeiro apenas quando a venda foi de facto registada
    if (prox === DeliveryConstants.STATUS.ENTREGUE) {
      EventBus.emit('cart:checkout', Store.Selectors.getPedidoById(pedId));
    }
  }

  /* ── Atribui entregador ──────────────────────────────────── */
  /**
   * @param {string|number} pedId
   * @param {string} entId
   */
  function atribuirEntregador(pedId, entId) {
    const pedido = Store.Selectors.getPedidoById(pedId);
    if (!pedido) return;
    Store.mutate(state => {
      const p = state.delivery.pedidos.find(x => String(x.id) === String(pedId));
      if (p) p.entregadorId = entId || null;
    }, true);
    SyncService.persist();
    UIService.showToast('Delivery', 'Entregador atribuído');
    UIService.closeModal('modalPedido');
    EventBus.emit('delivery:entregador-atribuido', Store.Selectors.getPedidoById(pedId));
  }

  /* ── Cancela pedido ──────────────────────────────────────── */
  /**
   * @param {string|number} pedId
   */
  async function cancelarPedido(pedId) {
    try {
      const pedido = Store.Selectors.getPedidoById(pedId);
      if (!pedido) return;

      const ok = await Dialog.danger({
        title:        `Cancelar Pedido #${pedido.num}?`,
        message:      'O estoque será devolvido automaticamente.',
        icon:         'fa-ban',
        confirmLabel: 'Cancelar Pedido',
      });
      if (!ok) return;

      // Devolve estoque apenas se ainda não entregue
      if (pedido.status !== DeliveryConstants.STATUS.ENTREGUE) {
        const today  = Utils.todayISO();
        const nowStr = Utils.now();

        Store.mutate(state => {
          (pedido.itens || []).forEach(item => {
            const prod = state.estoque.find(p => String(p.id) === String(item.prodId));
            if (!prod) return;
            const qtdAntes = prod.qtdUn;
            prod.qtdUn += (item.qtd || 1);
            state.inventario.unshift({
              id:           Utils.generateId(),
              vendaId:      pedido.id,
              produto:      item.nome,
              label:        `DEVOLUÇÃO DELIVERY #${pedido.num}`,
              preco:        0,
              qtdMovimento: item.qtd || 1,
              qtdAntes,
              qtdDepois:    prod.qtdUn,
              data:         today,
              hora:         nowStr,
              tipo:         'DEVOLUCAO',
            });
          });
        }, true); // fim Store.mutate
      }

      Store.mutate(state => {
        const p = state.delivery.pedidos.find(x => String(x.id) === String(pedId));
        if (p) {
          p.status           = DeliveryConstants.STATUS.CANCELADO;
          p.dataCancelamento = Utils.timestamp();
        }
      }, true);

      SyncService.persist();
      UIService.showToast('Delivery', `Pedido #${pedido.num} cancelado — estoque devolvido`, 'warning');
      UIService.closeModal('modalPedido');
      EventBus.emit('delivery:cancelado', Store.Selectors.getPedidoById(pedId));
  
    } catch (err) { console.error('[cancelarPedido]', err); }
  }

  async function excluirPedido(pedId) {
    try {
      const pedido = Store.Selectors.getPedidoById(pedId);
      if (!pedido) return;

      const ok = await Dialog.danger({
        title:        `Excluir Pedido #${pedido.num}?`,
        message:      'Esta ação não pode ser desfeita. O estoque será devolvido se aplicável.',
        icon:         'fa-trash',
        confirmLabel: 'Excluir Pedido',
      });
      if (!ok) return;

      const statusesQueDevolvem = [DeliveryConstants.STATUS.NOVO, DeliveryConstants.STATUS.PREPARANDO, DeliveryConstants.STATUS.A_CAMINHO];
      Store.mutate(state => {
        if (statusesQueDevolvem.includes(pedido.status)) {
          const today  = Utils.todayISO();
          const nowStr = Utils.now();
          (pedido.itens || []).forEach(item => {
            const prod = state.estoque.find(p => String(p.id) === String(item.prodId));
            if (!prod) return;
            const qtdAntes = prod.qtdUn;
            prod.qtdUn += (item.qtd || 1);
            state.inventario.unshift({
              id:           Utils.generateId(),
              vendaId:      pedido.id,
              produto:      item.nome,
              label:        `DEVOLUÇÃO EXCLUÍDO #${pedido.num}`,
              preco:        0,
              qtdMovimento: item.qtd || 1,
              qtdAntes,
              qtdDepois:    prod.qtdUn,
              data:         today,
              hora:         nowStr,
              tipo:         'DEVOLUCAO',
            });
          });
        }

        // Remove venda correspondente do financeiro (só existe se já foi ENTREGUE)
        const vidx = state.vendas.findIndex(v => v.pedidoNum === pedido.num && v.origem === 'DELIVERY');
        if (vidx !== -1) state.vendas.splice(vidx, 1);

        // Remove pedido
        const idx = state.delivery.pedidos.findIndex(p => String(p.id) === String(pedId));
        if (idx !== -1) state.delivery.pedidos.splice(idx, 1);
      }, true);

      SyncService.persist();
      UIService.showToast('Delivery', `Pedido #${pedido.num} excluído — estoque devolvido`, 'error');
      UIService.closeModal('modalPedido');
      DeliveryRenderer.renderDelivery();
  
    } catch (err) { console.error('[excluirPedido]', err); }
  }

  /* ── WhatsApp ────────────────────────────────────────────── */
  /**
   * Envia status atual do pedido via WhatsApp para o cliente
   * @param {string|number} pedId
   */
  function enviarStatusWpp(pedId) {
    const pedido = Store.Selectors.getPedidoById(pedId);
    if (!pedido) return;
    const tel = Utils.formatPhone(pedido.clienteTel);
    if (!tel) return UIService.showToast('Atenção', 'Pedido sem telefone registado', 'warning');

    const entregador  = pedido.entregadorId ? Store.Selectors.getEntregadorById(pedido.entregadorId) : null;
    const statusMsg   = DeliveryConstants.WPP_STATUS_MSG[pedido.status] || pedido.status;
    const entInfo     = (pedido.status === DeliveryConstants.STATUS.A_CAMINHO && entregador)
      ? `\nEntregador: ${entregador.nome}${entregador.tel ? ' · ' + entregador.tel : ''}`
      : '';

    const linhasItens = (pedido.itens || [])
      .map(i => `• ${i.qtd || 1}x ${i.nome}: ${Utils.formatCurrency(i.preco * (i.qtd || 1))}`)
      .join('\n');

    const msg =
      `*CH GELADAS | PEDIDO #${pedido.num}*\n` +
      `${statusMsg}${entInfo}\n\n` +
      `📋 *Itens:*\n${linhasItens}\n\n` +
      `💰 Subtotal: ${Utils.formatCurrency(pedido.subtotal || 0)}\n` +
      `🛵 Taxa entrega: ${Utils.formatCurrency(pedido.taxaEntrega || 0)}\n` +
      `✅ *Total: ${Utils.formatCurrency(pedido.total || 0)}*\n\n` +
      `📍 ${pedido.endereco || '—'}` +
      (pedido.obs ? `\n📝 Obs: ${pedido.obs}` : '');

    Utils.openWhatsApp(tel, msg);
  }

  /**
   * Notifica a loja via WhatsApp ao receber novo pedido
   * @param {object} pedido
   * @param {Array} itens
   * @param {object|null} zona
   */
  function notificarLojaWpp(pedido, itens, zona) {
    const lojaWpp = Utils.formatPhone(Store.Selectors.getConfig()?.whatsapp);
    if (!lojaWpp) return;

    const linhasItens = itens
      .map(i => `• ${i.qtd}x ${i.nome}: ${Utils.formatCurrency(i.preco * i.qtd)}`)
      .join('\n');

    const msg =
      `🛎️ *NOVO PEDIDO #${pedido.num}*\n` +
      `👤 ${pedido.clienteNome}\n` +
      `📞 ${pedido.clienteTel || '—'}\n` +
      `📍 ${pedido.endereco}${zona ? ` (${zona.nome})` : ''}\n` +
      (pedido.obs ? `📝 ${pedido.obs}\n` : '') +
      `\n📋 *Itens:*\n${linhasItens}\n\n` +
      `💰 Subtotal: ${Utils.formatCurrency(pedido.subtotal || 0)}\n` +
      `🛵 Taxa: ${Utils.formatCurrency(pedido.taxaEntrega || 0)}\n` +
      `✅ *Total: ${Utils.formatCurrency(pedido.total)}*\n` +
      `🕐 ${pedido.hora} · ${pedido.origem === 'PUBLICO' ? 'Online' : 'Manual'}`;

    Utils.openWhatsApp(lojaWpp, msg);
  }

  /* ── Zonas ───────────────────────────────────────────────── */
  function adicionarZona(nome, taxa) {
    const validation = DeliveryValidators.validateZona({ nome, taxa });
    if (!validation.valid) {
      UIService.showToast('Erro', validation.errors[0], 'error');
      return false;
    }
    Store.mutate(state => {
      state.delivery.zonas.push({ id: Utils.generateId(), nome: nome.trim(), taxa });
    }, true);
    SyncService.persist();
    EventBus.emit('delivery:zona-added');
    return true;
  }

  function removerZona(zonaId) {
    Store.mutate(state => {
      const idx = state.delivery.zonas.findIndex(z => String(z.id) === String(zonaId));
      if (idx !== -1) state.delivery.zonas.splice(idx, 1);
    }, true);
    SyncService.persist();
    EventBus.emit('delivery:zona-removed');
  }

  /* ── Entregadores ────────────────────────────────────────── */
  function adicionarEntregador(nome, tel) {
    const validation = DeliveryValidators.validateEntregador({ nome });
    if (!validation.valid) {
      UIService.showToast('Erro', validation.errors[0], 'error');
      return false;
    }
    Store.mutate(state => {
      state.delivery.entregadores.push({
        id:               Utils.generateId(),
        nome:             nome.trim(),
        tel:              tel?.trim() || '',
        ativo:            true,
        pedidosEntregues: 0,
        criadoEm:         Utils.timestamp(),
      });
    }, true);
    SyncService.persist();
    EventBus.emit('delivery:entregador-added');
    return true;
  }

  function removerEntregador(entId) {
    Store.mutate(state => {
      const idx = state.delivery.entregadores.findIndex(e => String(e.id) === String(entId));
      if (idx !== -1) state.delivery.entregadores.splice(idx, 1);
    }, true);
    SyncService.persist();
    EventBus.emit('delivery:entregador-removed');
  }

  function toggleEntregador(entId) {
    Store.mutate(state => {
      const ent = state.delivery.entregadores.find(e => String(e.id) === String(entId));
      if (ent) ent.ativo = !ent.ativo;
    }, true);
    SyncService.persist();
    EventBus.emit('delivery:entregador-toggled', Store.Selectors.getEntregadorById(entId));
  }

  /* ── Link público ────────────────────────────────────────── */
  function copiarLinkPublico() {
    const url = `${window.location.href.split('#')[0]}#pedido`;
    navigator.clipboard.writeText(url)
      .then(() => UIService.showToast('Link copiado!', 'Compartilhe com os clientes'))
      .catch(() => UIService.showToast('Link', url));
  }

  /**
   * Cria pedido (manual ou público) e debita estoque.
   * A venda NÃO é registrada no financeiro aqui — isso acontece apenas
   * quando o ADM avança o status para ENTREGUE (avancarStatus).
   * @param {object} pedidoData
   * @param {'MANUAL'|'PUBLICO'} origem
   * @returns {object} pedido criado
   */
  function _criarPedido(pedidoData, origem) {
    const now    = new Date();
    const today  = Utils.todayISO();
    const nowStr = Utils.now();
    const pedId  = Utils.generateId();
    const numPed = _proximoNumPedido();
    const { itens, zona } = pedidoData;
    const taxa    = zona?.taxa ?? 0;
    const sub     = itens.reduce((a, b) => a + b.preco * b.qtd, 0);

    // Valida disponibilidade em estoque
    for (const item of itens) {
      const prod = Store.Selectors.getProdutoById(item.prodId);
      if (!prod || prod.qtdUn < item.qtd) {
        UIService.showToast('Atenção', `Produto indisponível: ${item.nome}`, 'error');
        return null;
      }
    }

    // Debita estoque e registra no inventário via Store.mutate()
    Store.mutate(state => {
      itens.forEach(item => {
        const prod = state.estoque.find(p => String(p.id) === String(item.prodId));
        if (!prod) return;
        const qtdAntes = prod.qtdUn;
        prod.qtdUn -= item.qtd;
        state.inventario.unshift({
          id:           Utils.generateId(),
          vendaId:      pedId,
          produto:      prod.nome,
          label:        `DELIVERY ${origem === 'PUBLICO' ? 'ONLINE' : ''} #${numPed}`.trim(),
          preco:        item.preco * item.qtd,
          qtdMovimento: item.qtd,
          qtdAntes,
          qtdDepois:    prod.qtdUn,
          data:         today,
          hora:         nowStr,
          tipo:         'DELIVERY',
        });
      });
    }, true);

    const pedido = {
      id:            pedId,
      num:           numPed,
      clienteNome:   pedidoData.clienteNome,
      clienteTel:    pedidoData.clienteTel,
      endereco:      pedidoData.endereco,
      zona:          zona?.nome ?? '',
      taxaEntrega:   taxa,
      itens,
      subtotal:      sub,
      total:         sub + taxa,
      status:        DeliveryConstants.STATUS.NOVO,
      entregadorId:  pedidoData.entregadorId ?? null,
      obs:           pedidoData.obs ?? '',
      origem,
      data:          today,
      hora:          nowStr,
      tsCriado:      Date.now(),          // para cronômetro de atraso
      tempoEstimado: pedidoData.tempoEstimado || 40, // minutos estimados
    };

    // Adiciona apenas o pedido — venda será registrada ao confirmar ENTREGUE
    Store.mutate(state => {
      state.delivery.pedidos.unshift(pedido);
    }, true);

    SyncService.persistNow();
    notificarLojaWpp(pedido, itens, zona);
    EventBus.emit('delivery:pedido-criado', pedido);
    return pedido;
  }

  /**
   * Cria pedido (manual ou público) e debita estoque.
   * Método público — use este em vez de _criarPedido().
   * @param {object} pedidoData
   * @param {'MANUAL'|'PUBLICO'} origem
   * @returns {object|null} pedido criado ou null em caso de erro
   */
  function criarPedido(pedidoData, origem) {
    return _criarPedido(pedidoData, origem);
  }

  return Object.freeze({
    getFiltro, setFiltro,
    avancarStatus, atribuirEntregador, cancelarPedido, excluirPedido, enviarStatusWpp,
    adicionarZona, removerZona,
    adicionarEntregador, removerEntregador, toggleEntregador,
    copiarLinkPublico, notificarLojaWpp,
    criarPedido,
  });
})();

/* ═══════════════════════════════════════════════════════════════════
   DELIVERY RENDERER — Renderização pura
═══════════════════════════════════════════════════════════════════ */
const DeliveryRenderer = (() => {
  /* ── Lista de pedidos ─────────────────────────────────────── */
  function renderDelivery() {
    _renderKPIs();
    _renderPedidoLista();
    renderZonaLista();
    renderEntLista();
  }

  function _renderKPIs() {
    const pedidos = Store.Selectors.getPedidos();
    const hoje    = Utils.todayISO();
    _setText('dlvNovos', pedidos.filter(p => p.status === 'NOVO').length);
    _setText('dlvPrep',  pedidos.filter(p => p.status === 'PREPARANDO').length);
    _setText('dlvRoad',  pedidos.filter(p => p.status === 'A_CAMINHO').length);
    _setText('dlvDone',  pedidos.filter(p => p.status === 'ENTREGUE' && p.data === hoje).length);
  }

  function _renderPedidoLista() {
    const cont    = Utils.el('dlvLista');
    if (!cont) return;
    const filtro  = DeliveryService.getFiltro();
    const pedidos = Store.Selectors.getPedidos();

    let lista;
    if (filtro === 'TODOS') {
      lista = [...pedidos];
    } else {
      lista = pedidos.filter(p => p.status === filtro);
    }

    if (lista.length === 0) {
      cont.innerHTML = `
        <div class="text-center py-12 text-slate-700 text-[10px] font-bold uppercase" role="status">
          <i class="fas fa-motorcycle text-3xl block mb-3" aria-hidden="true"></i>
          Nenhum pedido${filtro !== 'TODOS' ? ' com este status' : ''}
        </div>`;
      return;
    }

    const frag = document.createDocumentFragment();

    if (filtro === 'TODOS') {
      const ativos     = lista.filter(p => p.status !== 'CANCELADO');
      const cancelados = lista.filter(p => p.status === 'CANCELADO');

      ativos.forEach(p => {
        const div = document.createElement('div');
        div.innerHTML = _buildPedidoCard(p);
        frag.appendChild(div.firstElementChild);
      });

      if (cancelados.length > 0) {
        const sep = document.createElement('div');
        sep.innerHTML = `<div class="flex items-center gap-3 my-3">
          <div class="flex-1 h-px bg-slate-800"></div>
          <span class="text-[8px] font-black uppercase text-slate-600 tracking-widest">${cancelados.length} cancelado(s)</span>
          <div class="flex-1 h-px bg-slate-800"></div>
        </div>`;
        frag.appendChild(sep.firstElementChild);

        cancelados.forEach(p => {
          const div = document.createElement('div');
          div.innerHTML = _buildPedidoCard(p);
          frag.appendChild(div.firstElementChild);
        });
      }
    } else {
      lista.forEach(p => {
        const div = document.createElement('div');
        div.innerHTML = _buildPedidoCard(p);
        frag.appendChild(div.firstElementChild);
      });
    }

    cont.innerHTML = '';
    cont.appendChild(frag);
  }

  /**
   * @param {object} p — pedido
   * @returns {string}
   */
  function _buildPedidoCard(p) {
    const ent     = p.entregadorId ? Store.Selectors.getEntregadorById(p.entregadorId) : null;
    const cls     = DeliveryConstants.STATUS_CSS[p.status]   || 'ds-novo';
    const lbl     = DeliveryConstants.STATUS_LABEL[p.status] || p.status;
    const tel     = Utils.formatPhone(p.clienteTel);
    const isOnline = p.origem === 'PUBLICO';

    return `
      <article class="glass-card rounded-2xl p-4 hover:border-white/15 transition-all" aria-label="Pedido #${p.num}">
        <div class="flex justify-between items-start mb-3">
          <div>
            <div class="flex items-center gap-2 mb-1" role="group" aria-label="Status do pedido">
              <span class="text-[9px] font-black text-slate-500">#${p.num}</span>
              <span class="badge ${cls} text-[8px]" role="status">${lbl}</span>
              <span class="badge ${isOnline ? 'b-purple' : 'b-amber'} text-[8px]">
                ${isOnline ? 'Online' : 'Manual'}
              </span>
            </div>
            <p class="text-sm font-black text-slate-200">${_esc(p.clienteNome)}</p>
            <p class="text-[9px] text-slate-500 font-bold">
              <i class="fas fa-map-marker-alt mr-1" aria-hidden="true"></i>${_esc(p.endereco || '—')}
            </p>
          </div>
          <div class="text-right flex-shrink-0 ml-3">
            <p class="text-lg font-black text-white">${Utils.formatCurrency(p.total || 0)}</p>
            <p class="text-[8px] text-slate-600">${p.hora || ''}</p>
          </div>
        </div>
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-1.5 flex-wrap">
            ${ent
              ? `<span class="badge b-purple text-[8px]"><i class="fas fa-motorcycle mr-1" aria-hidden="true"></i>${_esc(ent.nome)}</span>`
              : '<span class="text-[8px] text-slate-600 font-bold">Sem entregador</span>'}
            ${p.zona ? `<span class="badge b-blue text-[8px]">${_esc(p.zona)}</span>` : ''}
          </div>
          <div class="flex gap-1.5" role="group" aria-label="Ações do pedido">
            <button
              onclick="abrirDetalhePedido('${p.id}')"
              class="w-7 h-7 rounded-lg bg-blue-500/10 text-blue-400 hover:bg-blue-500 hover:text-white flex items-center justify-center transition-all"
              aria-label="Ver detalhes do pedido #${p.num}">
              <i class="fas fa-eye text-[9px]" aria-hidden="true"></i>
            </button>
            ${tel ? `
              <a href="https://wa.me/55${tel}" target="_blank" rel="noopener noreferrer"
                 class="w-7 h-7 rounded-lg bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500 hover:text-white flex items-center justify-center transition-all"
                 aria-label="WhatsApp do cliente ${_esc(p.clienteNome)}">
                <i class="fab fa-whatsapp text-[10px]" aria-hidden="true"></i>
              </a>` : ''}
            ${p.endereco ? `
              <a href="https://www.google.com/maps/search/${encodeURIComponent(p.endereco)}" target="_blank" rel="noopener noreferrer"
                 class="w-7 h-7 rounded-lg bg-slate-800 text-slate-400 hover:text-white flex items-center justify-center transition-all"
                 aria-label="Ver no mapa: ${_esc(p.endereco)}">
                <i class="fas fa-map text-[9px]" aria-hidden="true"></i>
              </a>` : ''}
            <button
              onclick="excluirPedido('${p.id}')"
              class="w-7 h-7 rounded-lg bg-red-500/10 text-red-500 hover:bg-red-500 hover:text-white flex items-center justify-center transition-all"
              aria-label="Excluir pedido #${p.num}">
              <i class="fas fa-trash text-[9px]" aria-hidden="true"></i>
            </button>
          </div>
        </div>
      </article>`;
  }

  /* ── Detalhe do pedido ───────────────────────────────────── */
  /**
   * @param {string|number} id
   */
  function abrirDetalhePedido(id) {
    const pedido = Store.Selectors.getPedidoById(id);
    if (!pedido) return;

    const ent     = pedido.entregadorId ? Store.Selectors.getEntregadorById(pedido.entregadorId) : null;
    const tel     = Utils.formatPhone(pedido.clienteTel);
    const statusCls = DeliveryConstants.STATUS_CSS[pedido.status] || '';
    const statusLbl = DeliveryConstants.STATUS_LABEL[pedido.status] || pedido.status;

    // Cronômetro de atraso
    const ativo    = !['ENTREGUE','CANCELADO'].includes(pedido.status);
    const minsDecorridos = pedido.tsCriado ? Math.floor((Date.now() - pedido.tsCriado) / 60000) : 0;
    const minsEstimados  = pedido.tempoEstimado || 40;
    const atrasado       = ativo && minsDecorridos > minsEstimados;
    const tempoBadge = ativo
      ? `<span class="badge ${atrasado ? 'b-red' : minsDecorridos > minsEstimados * 0.8 ? 'b-amber' : 'b-blue'} text-[8px]">
           <i class="fas fa-clock mr-1"></i>${minsDecorridos}min${atrasado ? ' ⚠️ ATRASADO' : ' / ' + minsEstimados + 'min est.'}
         </span>`
      : '';

    _setText('mpDetailTitle', `Pedido #${pedido.num}`);

    Utils.el('mpDetailBody').innerHTML = `
      <div class="flex items-center gap-2 mb-3 flex-wrap">
        <span class="badge ${statusCls}" role="status">${statusLbl}</span>
        <span class="badge ${pedido.origem === 'PUBLICO' ? 'b-purple' : 'b-amber'}">
          ${pedido.origem === 'PUBLICO' ? 'Online' : 'Manual'}
        </span>
        ${tempoBadge}
      </div>
      <dl class="space-y-1.5 text-[10px]">
        <div class="flex gap-1"><dt class="text-slate-500 font-bold">Cliente:</dt><dd class="font-black text-slate-200">${_esc(pedido.clienteNome)}</dd></div>
        <div class="flex items-center gap-2">
          <dt class="text-slate-500 font-bold">Tel:</dt>
          <dd class="font-bold text-slate-300">${_esc(pedido.clienteTel || '—')}</dd>
          ${tel ? `<a href="https://wa.me/55${tel}" target="_blank" rel="noopener noreferrer" class="text-emerald-400 hover:text-emerald-300" aria-label="WhatsApp"><i class="fab fa-whatsapp" aria-hidden="true"></i></a>` : ''}
        </div>
        <div class="flex items-center gap-1">
          <dt class="text-slate-500 font-bold">Endereço:</dt>
          <dd class="font-bold text-slate-300">${_esc(pedido.endereco || '—')}</dd>
          ${pedido.endereco ? `<a href="https://www.google.com/maps/search/${encodeURIComponent(pedido.endereco)}" target="_blank" rel="noopener noreferrer" class="text-blue-400 hover:text-blue-300 ml-1" aria-label="Ver no mapa"><i class="fas fa-map-marker-alt text-[9px]" aria-hidden="true"></i></a>` : ''}
        </div>
        <div class="flex gap-1"><dt class="text-slate-500 font-bold">Zona:</dt><dd class="font-bold text-slate-300">${_esc(pedido.zona || '—')}</dd></div>
        <div class="flex gap-1"><dt class="text-slate-500 font-bold">Entregador:</dt><dd class="font-bold text-slate-300">${ent ? _esc(ent.nome) : 'Não atribuído'}</dd></div>
        ${pedido.obs ? `<div class="flex gap-1"><dt class="text-slate-500 font-bold">Obs:</dt><dd class="font-bold text-amber-400">${_esc(pedido.obs)}</dd></div>` : ''}
      </dl>

      <div class="border-t border-white/5 pt-3 mt-3 space-y-1" role="list" aria-label="Itens do pedido">
        ${(pedido.itens || []).map(it => `
          <div class="flex justify-between text-[10px]" role="listitem">
            <span class="text-slate-300 font-bold">${it.qtd || 1}x ${_esc(it.nome)} <span class="text-slate-600">(${it.label})</span></span>
            <span class="font-black text-white">${Utils.formatCurrency(it.preco * (it.qtd || 1))}</span>
          </div>`).join('')}
        <div class="border-t border-white/5 pt-2 mt-2 space-y-1">
          <div class="flex justify-between text-[9px] font-bold">
            <span class="text-slate-500">Subtotal</span>
            <span>${Utils.formatCurrency(pedido.subtotal || 0)}</span>
          </div>
          <div class="flex justify-between text-[9px] font-bold">
            <span class="text-slate-500">Taxa entrega</span>
            <span class="text-blue-400">${Utils.formatCurrency(pedido.taxaEntrega || 0)}</span>
          </div>
          <div class="flex justify-between font-black">
            <span class="text-[10px] text-slate-400">TOTAL</span>
            <span class="text-white">${Utils.formatCurrency(pedido.total || 0)}</span>
          </div>
        </div>
      </div>

      <div class="mt-4">
        <label class="label" for="detEnt">Atribuir Entregador</label>
        <div class="flex gap-2">
          <select id="detEnt" class="inp flex-1" aria-label="Selecionar entregador">
            <option value="">Nenhum</option>
            ${Store.Selectors.getEntregadores()
              .filter(e => e.ativo)
              .map(e => `<option value="${e.id}" ${String(e.id) === String(pedido.entregadorId) ? 'selected' : ''}>${_esc(e.nome)}</option>`)
              .join('')}
          </select>
          <button
            onclick="atribuirEntregador('${pedido.id}')"
            class="bg-blue-600 px-4 rounded-xl font-black text-xs text-white transition-all hover:bg-blue-500"
            aria-label="Confirmar entregador">
            OK
          </button>
        </div>
      </div>`;

    // Ações
    let bts = '';
    const prox      = DeliveryConstants.PROX_STATUS[pedido.status];
    const proxLabel = DeliveryConstants.PROX_LABEL[pedido.status];
    const proxColor = DeliveryConstants.PROX_COLOR[pedido.status];

    if (prox) {
      bts += `<button onclick="avancarStatus('${pedido.id}')" class="w-full ${proxColor} text-white py-3 rounded-xl font-black uppercase text-xs transition-all">${proxLabel}</button>`;
    }
    if (tel) {
      bts += `<button onclick="enviarStatusWpp('${pedido.id}')" class="w-full bg-[#25D366] hover:bg-[#20bd5a] text-white py-3 rounded-xl font-black uppercase text-xs flex items-center justify-center gap-2 transition-all"><i class="fab fa-whatsapp" aria-hidden="true"></i>Enviar Status WhatsApp</button>`;
    }
    if (pedido.status !== DeliveryConstants.STATUS.CANCELADO && pedido.status !== DeliveryConstants.STATUS.ENTREGUE) {
      bts += `<button onclick="cancelarPedido('${pedido.id}')" class="w-full bg-red-500/10 text-red-400 border border-red-500/20 py-3 rounded-xl font-black uppercase text-xs transition-all hover:bg-red-500 hover:text-white">Cancelar Pedido</button>`;
    }
    bts += `<button onclick="excluirPedido('${pedido.id}')" class="w-full bg-slate-800/50 text-slate-500 border border-slate-700/50 py-3 rounded-xl font-black uppercase text-xs transition-all hover:bg-red-900/30 hover:text-red-400 hover:border-red-500/30 flex items-center justify-center gap-2"><i class="fas fa-trash text-[10px]"></i>Excluir Pedido</button>`;
    Utils.el('mpDetailActions').innerHTML = bts;
    UIService.openModal('modalPedido');
  }

  /* ── Zonas e Entregadores ────────────────────────────────── */
  function renderZonaLista() {
    const cont = Utils.el('zonaLista');
    if (!cont) return;
    const zonas = Store.Selectors.getZonas();
    cont.innerHTML = zonas.length === 0
      ? '<p class="text-[9px] text-slate-600 font-bold uppercase text-center py-3" role="status">Nenhuma zona cadastrada</p>'
      : zonas.map(z => `
          <div class="flex items-center justify-between bg-slate-900/50 px-4 py-3 rounded-xl border border-white/5">
            <div>
              <p class="text-[10px] font-black text-slate-300">${_esc(z.nome)}</p>
              <p class="text-[8px] text-emerald-400 font-black">${Utils.formatCurrency(z.taxa)}</p>
            </div>
            <button
              onclick="removerZona('${z.id}')"
              class="w-7 h-7 rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500 hover:text-white flex items-center justify-center transition-all"
              aria-label="Remover zona ${_esc(z.nome)}">
              <i class="fas fa-times text-[9px]" aria-hidden="true"></i>
            </button>
          </div>`).join('');
  }

  function renderEntLista() {
    const cont = Utils.el('entLista');
    if (!cont) return;
    const entregadores = Store.Selectors.getEntregadores();
    cont.innerHTML = entregadores.length === 0
      ? '<p class="text-[9px] text-slate-600 font-bold uppercase text-center py-3" role="status">Nenhum entregador cadastrado</p>'
      : entregadores.map(e => {
          const entTel = Utils.formatPhone(e.tel);
          return `
            <div class="flex items-center justify-between bg-slate-900/50 px-4 py-3 rounded-xl border border-white/5">
              <div>
                <p class="text-[10px] font-black ${e.ativo ? 'text-slate-300' : 'text-slate-600 line-through'}">${_esc(e.nome)}</p>
                <p class="text-[8px] text-slate-500 font-bold">${_esc(e.tel || '—')}</p>
              </div>
              <div class="flex gap-1.5" role="group" aria-label="Ações entregador ${_esc(e.nome)}">
                <button
                  onclick="toggleEntregador('${e.id}')"
                  class="w-7 h-7 rounded-lg ${e.ativo ? 'bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500' : 'bg-slate-800 text-slate-600 hover:bg-emerald-500/20 hover:text-emerald-400'} flex items-center justify-center transition-all"
                  aria-label="${e.ativo ? 'Desativar' : 'Ativar'} entregador ${_esc(e.nome)}"
                  aria-pressed="${e.ativo}">
                  <i class="fas fa-${e.ativo ? 'check' : 'ban'} text-[9px]" aria-hidden="true"></i>
                </button>
                ${entTel ? `
                  <a href="https://wa.me/55${entTel}" target="_blank" rel="noopener noreferrer"
                     class="w-7 h-7 rounded-lg bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500 hover:text-white flex items-center justify-center transition-all"
                     aria-label="WhatsApp do entregador ${_esc(e.nome)}">
                    <i class="fab fa-whatsapp text-[9px]" aria-hidden="true"></i>
                  </a>` : ''}
                <button
                  onclick="removerEntregador('${e.id}')"
                  class="w-7 h-7 rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500 hover:text-white flex items-center justify-center transition-all"
                  aria-label="Remover entregador ${_esc(e.nome)}">
                  <i class="fas fa-times text-[9px]" aria-hidden="true"></i>
                </button>
              </div>
            </div>`;
        }).join('');
  }

  /* ── Selects auxiliares ─────────────────────────────────── */
  function populateMpZonas() {
    const sel = Utils.el('mpZona');
    if (!sel) return;
    sel.innerHTML = '<option value="">Selecione...</option>' +
      Store.Selectors.getZonas()
        .map(z => `<option value="${z.id}">${_esc(z.nome)} — ${Utils.formatCurrency(z.taxa)}</option>`)
        .join('');
  }

  function populateMpEntregadores() {
    ['mpEntregador', 'detEnt'].forEach(selId => {
      const sel = Utils.el(selId);
      if (!sel) return;
      sel.innerHTML = '<option value="">Atribuir depois...</option>' +
        Store.Selectors.getEntregadores()
          .filter(e => e.ativo)
          .map(e => `<option value="${e.id}">${_esc(e.nome)}</option>`)
          .join('');
    });
  }

  function populatePubZonas() {
    const sel = Utils.el('pubZona');
    if (!sel) return;
    sel.innerHTML = '<option value="">Selecione o bairro...</option>' +
      Store.Selectors.getZonas()
        .map(z => `<option value="${z.id}">${_esc(z.nome)} — ${Utils.formatCurrency(z.taxa)}</option>`)
        .join('');
  }

  /* ── Auxiliares ─────────────────────────────────────────── */
  function _setText(id, txt) { const el = Utils.el(id); if (el) el.textContent = txt; }
  function _esc(s) { return RenderService._escapeHtml(s); }

  return Object.freeze({
    renderDelivery, renderZonaLista, renderEntLista,
    abrirDetalhePedido,
    populateMpZonas, populateMpEntregadores, populatePubZonas,
  });
})();

/* ═══════════════════════════════════════════════════════════════════
   MANUAL ORDER SERVICE — Pedido manual pelo operador
═══════════════════════════════════════════════════════════════════ */
const ManualOrderService = (() => {
  /** @type {Object.<string, number>} prodId → quantidade */
  let _qtds = {};

  function reset() {
    _qtds = {};
    ['mpNome', 'mpTel', 'mpEndereco', 'mpObs'].forEach(id => {
      const el = Utils.el(id);
      if (el) el.value = '';
    });
    const zona = Utils.el('mpZona');
    if (zona) zona.value = '';
    Utils.el('mpTaxaBox')?.classList.add('hidden');
  }

  /** Renderiza catálogo dentro do modal de novo pedido */
  function populateMpProdutos() {
    const cont = Utils.el('mpProdutos');
    if (!cont) return;
    const produtos = Store.Selectors.getEstoque();

    if (produtos.length === 0) {
      cont.innerHTML = '<p class="text-[9px] text-slate-600 text-center py-4 font-bold uppercase">Nenhum produto cadastrado</p>';
      return;
    }

    const frag = document.createDocumentFragment();
    produtos.forEach(p => {
      const qtd      = _qtds[p.id] || 0;
      const esgotado = p.qtdUn <= 0;
      const div = document.createElement('div');
      div.innerHTML = `
        <div class="flex items-center justify-between bg-slate-900/50 px-3 py-2 rounded-xl border border-white/5 ${esgotado ? 'opacity-40' : ''}">
          <div class="flex-1 min-w-0">
            <p class="text-[10px] font-black text-slate-300 truncate">${RenderService._escapeHtml(p.nome)}</p>
            <div class="flex gap-2">
              <p class="text-[8px] text-slate-500 font-bold">${Utils.formatCurrency(p.precoUn)}</p>
              <span class="text-[8px] font-black ${esgotado ? 'text-red-400' : p.qtdUn <= CONSTANTS.LOW_STOCK_THRESHOLD ? 'text-amber-400' : 'text-emerald-400'}">
                ${esgotado ? 'Esgotado' : `${p.qtdUn} em estoque`}
              </span>
            </div>
          </div>
          <div class="flex items-center gap-2 flex-shrink-0 ml-2" role="group" aria-label="Quantidade de ${RenderService._escapeHtml(p.nome)}">
            <button onclick="mpAjQ('${p.id}',-1)" class="qty-btn qty-m" ${esgotado ? 'disabled' : ''} aria-label="Diminuir">−</button>
            <span id="mpq-${p.id}" class="text-[10px] font-black text-white w-6 text-center" aria-live="polite">${qtd}</span>
            <button onclick="mpAjQ('${p.id}',1,${p.qtdUn})" class="qty-btn qty-p" ${esgotado ? 'disabled' : ''} aria-label="Aumentar">+</button>
          </div>
        </div>`;
      frag.appendChild(div.firstElementChild);
    });
    cont.innerHTML = '';
    cont.appendChild(frag);
    _calcTotal();
  }

  function mpAjQ(prodId, delta, maxQtd = Infinity) {
    if (!_qtds[prodId]) _qtds[prodId] = 0;
    _qtds[prodId] = Math.max(0, Math.min(maxQtd, _qtds[prodId] + delta));
    if (delta > 0 && _qtds[prodId] === maxQtd) {
      UIService.showToast('Limite', `Máximo disponível: ${maxQtd}`, 'warning');
    }
    const el = Utils.el(`mpq-${prodId}`);
    if (el) el.textContent = _qtds[prodId];
    _calcTotal();
  }

  function _calcTotal() {
    const zonaId = Utils.el('mpZona')?.value || '';
    const zona   = zonaId ? Store.Selectors.getZonaById(zonaId) : null;
    const taxa   = zona?.taxa ?? 0;

    let sub = 0;
    Object.entries(_qtds).forEach(([prodId, qtd]) => {
      if (!qtd) return;
      const prod = Store.Selectors.getProdutoById(prodId);
      if (prod) sub += prod.precoUn * qtd;
    });

    const setText = (id, v) => { const el = Utils.el(id); if (el) el.textContent = v; };
    setText('mpSubtotal', Utils.formatCurrency(sub));
    setText('mpTaxaRes',  Utils.formatCurrency(taxa));
    setText('mpTotal',    Utils.formatCurrency(sub + taxa));
  }

  function onZonaChange() {
    const zonaId = Utils.el('mpZona')?.value || '';
    const zona   = zonaId ? Store.Selectors.getZonaById(zonaId) : null;
    const box    = Utils.el('mpTaxaBox');
    const val    = Utils.el('mpTaxaRes');
    const valBox = Utils.el('mpTaxaVal');
    if (zona) {
      box?.classList.remove('hidden');
      if (val)    val.textContent    = Utils.formatCurrency(zona.taxa);
      if (valBox) valBox.textContent = Utils.formatCurrency(zona.taxa);
    } else {
      box?.classList.add('hidden');
      if (val)    val.textContent    = Utils.formatCurrency(0);
      if (valBox) valBox.textContent = Utils.formatCurrency(0);
    }
    _calcTotal();
  }

  function salvarPedidoManual() {
    const nome  = Utils.el('mpNome')?.value.trim() || '';
    const tel   = Utils.el('mpTel')?.value.trim()  || '';
    const end   = Utils.el('mpEndereco')?.value.trim() || '';
    const obs   = Utils.el('mpObs')?.value.trim() || '';
    const zonaId = Utils.el('mpZona')?.value || '';
    const entId  = Utils.el('mpEntregador')?.value || null;
    const zona   = zonaId ? Store.Selectors.getZonaById(zonaId) : null;

    const itens = Object.entries(_qtds)
      .filter(([, qtd]) => qtd > 0)
      .map(([prodId, qtd]) => {
        const prod = Store.Selectors.getProdutoById(prodId);
        return prod ? { prodId, nome: prod.nome, label: 'UNID', preco: prod.precoUn, qtd } : null;
      })
      .filter(Boolean);

    const validation = DeliveryValidators.validatePedido({ clienteNome: nome, clienteTel: tel, endereco: end, itens });
    if (!validation.valid) {
      UIService.showToast('Atenção', validation.errors[0], 'error');
      return;
    }

    const pedido = DeliveryService.criarPedido({ clienteNome: nome, clienteTel: tel, endereco: end, obs, zona, entregadorId: entId, itens }, 'MANUAL');
    if (!pedido) return;

    reset();
    UIService.closeModal('modalNovoPedido');
    UIService.showToast('Delivery', `Pedido #${pedido.num} criado`);
    DeliveryRenderer.renderDelivery();
  }

  return Object.freeze({ reset, populateMpProdutos, mpAjQ, onZonaChange, salvarPedidoManual, _calcTotal });
})();

/* ═══════════════════════════════════════════════════════════════════
   PUBLIC ORDER SERVICE — Cardápio público online
═══════════════════════════════════════════════════════════════════ */
const PublicOrderService = (() => {
  /** @type {Object.<string, { qtd: number, preco: number, nome: string, label: string }>} */
  let _carrinho = {};

  // Rate limiting: máx 3 pedidos por IP/sessão por hora
  const _RATE_LIMIT = 3;
  const _RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hora
  const _STORAGE_KEY = 'ch_pub_rl';

  function _checkRateLimit() {
    try {
      const raw  = sessionStorage.getItem(_STORAGE_KEY);
      const data = raw ? JSON.parse(raw) : { count: 0, since: Date.now() };
      const now  = Date.now();
      // Reset janela se já passou 1 hora
      if (now - data.since > _RATE_WINDOW_MS) {
        data.count = 0;
        data.since = now;
      }
      if (data.count >= _RATE_LIMIT) {
        const minRestante = Math.ceil((_RATE_WINDOW_MS - (now - data.since)) / 60000);
        UIService.showToast('Limite atingido', `Aguarde ${minRestante} min para novo pedido`, 'error');
        return false;
      }
      data.count++;
      sessionStorage.setItem(_STORAGE_KEY, JSON.stringify(data));
      return true;
    } catch { return true; } // se sessionStorage falhar, não bloqueia
  }

  function iniciarPublicOrder() {
    Utils.el('public-order')?.classList.add('show');
    const lock = Utils.el('lock');
    if (lock) lock.style.display = 'none';
    DeliveryRenderer.populatePubZonas();
    renderPubCatalog();

    // Avisa o utilizador se tentar sair com itens no carrinho
    window.addEventListener('beforeunload', _beforeUnloadGuard);
  }

  function _beforeUnloadGuard(e) {
    const count = Object.values(_carrinho).reduce((a, v) => a + v.qtd, 0);
    if (count > 0) {
      e.preventDefault();
      e.returnValue = ''; // necessário para Chrome mostrar o diálogo nativo
    }
  }

  function novoPublicOrder() {
    _carrinho = {};
    const successEl = Utils.el('public-success');
    if (successEl) successEl.style.display = 'none';
    Utils.el('public-order')?.classList.add('show');
    ['pubNome', 'pubTel', 'pubEndereco', 'pubObs'].forEach(id => {
      const el = Utils.el(id); if (el) el.value = '';
    });
    const zona = Utils.el('pubZona'); if (zona) zona.value = '';
    Utils.el('pubTaxaBox')?.classList.add('hidden');
    renderPubCatalog();
    _atualizarResumo();
  }

  function renderPubCatalog() {
    const cont = Utils.el('pubCatalog');
    if (!cont) return;
    const q     = (Utils.el('pubSearch')?.value || '').toLowerCase();
    const prods = Store.Selectors.getEstoque().filter(p => p.qtdUn > 0 && p.nome.toLowerCase().includes(q));

    if (prods.length === 0) {
      cont.innerHTML = '<p class="text-center text-slate-700 text-[10px] font-bold uppercase py-6" role="status">Nenhum produto disponível</p>';
      return;
    }

    const frag = document.createDocumentFragment();
    prods.forEach(p => {
      const qtd      = _carrinho[p.id]?.qtd || 0;
      const esgotado = p.qtdUn <= 0;
      const stockCls = p.qtdUn <= CONSTANTS.LOW_STOCK_THRESHOLD && p.qtdUn > 0
        ? 'text-amber-400'
        : esgotado ? 'text-red-400' : 'text-slate-600';

      const div = document.createElement('div');
      div.innerHTML = `
        <div id="pubprod-${p.id}" class="pub-prod ${qtd > 0 ? 'selected' : ''} ${esgotado ? 'opacity-40' : ''}"
             role="listitem" aria-label="${RenderService._escapeHtml(p.nome)}">
          <div class="flex items-center justify-between">
            <div class="flex-1 min-w-0">
              <p class="text-[11px] font-black text-slate-200 truncate">${RenderService._escapeHtml(p.nome)}</p>
              <div class="flex items-center gap-2 mt-0.5">
                <p class="text-[10px] font-black text-blue-400">${Utils.formatCurrency(p.precoUn)}</p>
                <span class="text-[8px] font-bold ${stockCls}">
                  ${esgotado ? '· Esgotado' : `· ${p.qtdUn} disp.`}
                </span>
              </div>
            </div>
            <div class="flex items-center gap-2 flex-shrink-0 ml-3" role="group" aria-label="Quantidade">
              <button onclick="pubAjQ('${p.id}',-1,${p.precoUn},'${p.nome.replace(/'/g, "&#39;")}')"
                      class="qty-btn qty-m" ${esgotado ? 'disabled' : ''} aria-label="Diminuir ${RenderService._escapeHtml(p.nome)}">−</button>
              <span id="pubqtd-${p.id}" class="text-sm font-black text-white w-5 text-center" aria-live="polite">${qtd}</span>
              <button onclick="pubAjQ('${p.id}',1,${p.precoUn},'${p.nome.replace(/'/g, "&#39;")}')"
                      class="qty-btn qty-p" ${esgotado ? 'disabled' : ''} aria-label="Aumentar ${RenderService._escapeHtml(p.nome)}">+</button>
            </div>
          </div>
        </div>`;
      frag.appendChild(div.firstElementChild);
    });
    cont.innerHTML = '';
    cont.appendChild(frag);
  }

  function pubAjQ(prodId, delta, preco, nome) {
    const prod   = Store.Selectors.getProdutoById(prodId);
    const maxQtd = prod?.qtdUn ?? 0;

    if (!_carrinho[prodId]) _carrinho[prodId] = { qtd: 0, preco, nome, label: 'UNID' };
    const novaQtd = Math.max(0, Math.min(maxQtd, _carrinho[prodId].qtd + delta));

    if (delta > 0 && novaQtd === _carrinho[prodId].qtd && novaQtd === maxQtd) {
      UIService.showToast('Limite', `Quantidade máxima disponível: ${maxQtd}`, 'warning');
      return;
    }

    _carrinho[prodId].qtd = novaQtd;
    if (novaQtd === 0) delete _carrinho[prodId];

    const qtdEl = Utils.el(`pubqtd-${prodId}`);
    if (qtdEl) qtdEl.textContent = _carrinho[prodId]?.qtd || 0;

    const card = Utils.el(`pubprod-${prodId}`);
    if (card) card.classList.toggle('selected', (_carrinho[prodId]?.qtd || 0) > 0);

    _atualizarResumo();
  }

  function pubSelecionarZona() {
    const zonaId = Utils.el('pubZona')?.value || '';
    const zona   = zonaId ? Store.Selectors.getZonaById(zonaId) : null;
    const box    = Utils.el('pubTaxaBox');
    const val    = Utils.el('pubTaxaVal');
    if (zona) {
      box?.classList.remove('hidden');
      if (val) val.textContent = Utils.formatCurrency(zona.taxa);
    } else {
      box?.classList.add('hidden');
      if (val) val.textContent = Utils.formatCurrency(0);
    }
    _atualizarResumo();
  }

  function _atualizarResumo() {
    const itens  = Object.entries(_carrinho);
    const sub    = itens.reduce((a, [, v]) => a + v.preco * v.qtd, 0);
    const zonaId = Utils.el('pubZona')?.value || '';
    const zona   = zonaId ? Store.Selectors.getZonaById(zonaId) : null;
    const taxa   = zona?.taxa ?? 0;
    const count  = itens.reduce((a, [, v]) => a + v.qtd, 0);

    const totalEl   = Utils.el('pubTotal');
    const countEl   = Utils.el('pubCount');
    const resumoEl  = Utils.el('pubResumo');
    if (totalEl)  totalEl.textContent  = Utils.formatCurrency(sub + taxa);
    if (countEl)  countEl.textContent  = count;
    if (resumoEl) resumoEl.classList.toggle('hidden', count === 0);
  }

  function confirmarPedidoPublico() {
    if (!_checkRateLimit()) return;
    const nome  = Utils.el('pubNome')?.value.trim()     || '';
    const tel   = Utils.el('pubTel')?.value.trim()      || '';
    const end   = Utils.el('pubEndereco')?.value.trim() || '';
    const obs   = Utils.el('pubObs')?.value.trim()      || '';
    const zonaId = Utils.el('pubZona')?.value || '';
    const zona  = zonaId ? Store.Selectors.getZonaById(zonaId) : null;

    const itens = Object.entries(_carrinho).map(([prodId, v]) => ({
      prodId, nome: v.nome, label: v.label, preco: v.preco, qtd: v.qtd,
    }));

    const validation = DeliveryValidators.validatePedido({ clienteNome: nome, clienteTel: tel, endereco: end, itens });
    if (!validation.valid) {
      UIService.showToast('Atenção', validation.errors[0], 'error');
      return;
    }

    const pedido = DeliveryService.criarPedido({ clienteNome: nome, clienteTel: tel, endereco: end, obs, zona, itens }, 'PUBLICO');
    if (!pedido) return;

    Utils.el('pubNumPedido').textContent = `Pedido #${pedido.num}`;
    window.removeEventListener('beforeunload', _beforeUnloadGuard);
    Utils.el('public-order')?.classList.remove('show');
    const success = Utils.el('public-success');
    if (success) {
      success.style.cssText = 'display:flex;position:fixed;inset:0;z-index:9995;background:var(--bg);align-items:center;justify-content:center;';
    }
    _carrinho = {};
  }

  return Object.freeze({
    iniciarPublicOrder, novoPublicOrder, renderPubCatalog,
    pubAjQ, pubSelecionarZona, confirmarPedidoPublico,
  });
})();

/* ═══════════════════════════════════════════════════════════════════
   REGISTRA LISTENERS DE EVENTOS
═══════════════════════════════════════════════════════════════════ */
EventBus.on('delivery:status-changed',      () => DeliveryRenderer.renderDelivery());
EventBus.on('delivery:cancelado',           () => DeliveryRenderer.renderDelivery());
EventBus.on('delivery:entregador-atribuido',() => DeliveryRenderer.renderDelivery());
EventBus.on('delivery:pedido-criado',       () => DeliveryRenderer.renderDelivery());
// FIX: filtro-changed → re-renderiza lista de pedidos quando filtro muda programaticamente
EventBus.on('delivery:filtro-changed',      () => DeliveryRenderer.renderDelivery());
EventBus.on('delivery:zona-added',          () => { DeliveryRenderer.renderZonaLista(); DeliveryRenderer.populateMpZonas(); DeliveryRenderer.populatePubZonas(); });
EventBus.on('delivery:zona-removed',        () => { DeliveryRenderer.renderZonaLista(); DeliveryRenderer.populateMpZonas(); DeliveryRenderer.populatePubZonas(); });
EventBus.on('delivery:entregador-added',    () => { DeliveryRenderer.renderEntLista();  DeliveryRenderer.populateMpEntregadores(); });
EventBus.on('delivery:entregador-removed',  () => { DeliveryRenderer.renderEntLista();  DeliveryRenderer.populateMpEntregadores(); });
EventBus.on('delivery:entregador-toggled',  () => { DeliveryRenderer.renderEntLista();  DeliveryRenderer.populateMpEntregadores(); });

// Sync remoto (outro dispositivo gravou) — re-renderiza Delivery se a aba
// estiver ativa. Sem este listener, mudanças de status de pedidos feitas em
// outro device só apareciam após F5.
EventBus.on('sync:remote-applied', () => {
  if (Utils.el('tab-delivery')?.classList.contains('active')) {
    DeliveryRenderer.renderDelivery();
  }
});

/* ═══════════════════════════════════════════════════════════════════
   WINDOW BRIDGES — Compatibilidade com HTML inline
═══════════════════════════════════════════════════════════════════ */

// ── Filtro
function filtrarDelivery(f) {
  DeliveryService.setFiltro(f);
  ['TODOS','NOVO','PREPARANDO','A_CAMINHO','ENTREGUE','CANCELADO'].forEach(status => {
    const btn = Utils.el(`df-${status}`);
    if (!btn) return;
    btn.style.outline = status === f ? '2px solid currentColor' : 'none';
    btn.style.opacity = status === f ? '1' : '0.55';
  });
  DeliveryRenderer.renderDelivery();
}

// ── Lista / Render
function renderDelivery()          { DeliveryRenderer.renderDelivery(); }
function renderZonaLista()         { DeliveryRenderer.renderZonaLista(); }
function renderEntLista()          { DeliveryRenderer.renderEntLista(); }
function populateMpZonas()         { DeliveryRenderer.populateMpZonas(); }
function populateMpEntregadores()  { DeliveryRenderer.populateMpEntregadores(); }
function populateMpProdutos()      { ManualOrderService.populateMpProdutos(); }

// ── Pedido manual
function mpAjQ(prodId, delta, max)  { ManualOrderService.mpAjQ(prodId, delta, max); }
function mpZonaChange()             { ManualOrderService.onZonaChange(); }
function mpSelecionarZona()         { ManualOrderService.onZonaChange(); }
function salvarPedidoManual()       { ManualOrderService.salvarPedidoManual(); }
function mpCalcTotal()              { ManualOrderService._calcTotal(); }

// ── Detalhe e ações
function abrirDetalhePedido(id)    { DeliveryRenderer.abrirDetalhePedido(id); }
function avancarStatus(id)         { DeliveryService.avancarStatus(id); }
function atribuirEntregador(id)    {
  const entId = Utils.el('detEnt')?.value || null;
  DeliveryService.atribuirEntregador(id, entId);
  DeliveryRenderer.renderDelivery();
}
function cancelarPedido(id)        { DeliveryService.cancelarPedido(id); }
function excluirPedido(id)         { DeliveryService.excluirPedido(id); }
function enviarStatusWpp(id)       { DeliveryService.enviarStatusWpp(id); }

// ── Zonas
function adicionarZona() {
  const nome = Utils.el('zonanome')?.value.trim() || '';
  const taxa = parseFloat(Utils.el('zonatax')?.value || '0') || 0;
  if (DeliveryService.adicionarZona(nome, taxa)) {
    const n = Utils.el('zonanome'); if (n) n.value = '';
    const t = Utils.el('zonatax');  if (t) t.value = '';
  }
}
function removerZona(id) { DeliveryService.removerZona(id); }

// ── Entregadores
function adicionarEntregador() {
  const nome = Utils.el('entNome')?.value.trim() || '';
  const tel  = Utils.el('entTel')?.value.trim()  || '';
  if (DeliveryService.adicionarEntregador(nome, tel)) {
    const n = Utils.el('entNome'); if (n) n.value = '';
    const t = Utils.el('entTel');  if (t) t.value = '';
  }
}
function removerEntregador(id)  { DeliveryService.removerEntregador(id); }
function toggleEntregador(id)   { DeliveryService.toggleEntregador(id); }

// ── Link público
function copiarLinkPublico()   { DeliveryService.copiarLinkPublico(); }

// ── Cardápio público
function iniciarPublicOrder()  { PublicOrderService.iniciarPublicOrder(); }
function novoPublicOrder()     { PublicOrderService.novoPublicOrder(); }
function renderPubCatalog()    { PublicOrderService.renderPubCatalog(); }
function pubAjQ(id, d, p, n)  { PublicOrderService.pubAjQ(id, d, p, n); }
function pubSelecionarZona()   { PublicOrderService.pubSelecionarZona(); }
function confirmarPedidoPublico() { PublicOrderService.confirmarPedidoPublico(); }

/* ── Monitor de atraso: verifica pedidos atrasados a cada 2min ── */
setInterval(() => {
  if (!Utils.el('tab-delivery')?.classList.contains('active')) return;
  const pedidos = Store.Selectors.getPedidos();
  const atrasados = pedidos.filter(p => {
    if (['ENTREGUE','CANCELADO'].includes(p.status)) return false;
    if (!p.tsCriado) return false;
    const mins = Math.floor((Date.now() - p.tsCriado) / 60000);
    return mins > (p.tempoEstimado || 40);
  });
  if (atrasados.length > 0) {
    EventBus.emit('notif:alerta-delivery', { qtd: atrasados.length, pedidos: atrasados });
  }
  DeliveryRenderer.renderDelivery();
}, 120_000);
