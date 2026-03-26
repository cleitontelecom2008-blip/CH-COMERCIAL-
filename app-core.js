/**
 * @fileoverview CH Geladas PDV — Core Module
 * @version 5.0.0-enterprise
 *
 * Arquitetura:
 *  - Store          → State management reativo (padrão Redux-like)
 *  - AuthService    → Autenticação com SHA-256 hash
 *  - CartService    → Carrinho de compras
 *  - UIService      → Toast, Modals, Clock, Alerts
 *  - SyncService    → localStorage + Firestore bridge
 *  - RenderService  → Renderização do catálogo PDV
 *  - Validators     → Validações puras e reutilizáveis
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════════
   CONSTANTS
═══════════════════════════════════════════════════════════════════ */

/** Lê LOJA_CONFIG antes do resto do app (chaves isoladas por projeto) */
function _lojaConfigEarly() {
  try { return JSON.parse(localStorage.getItem('LOJA_CONFIG') || '{}'); }
  catch (e) { return {}; }
}
const _lojaEarly = _lojaConfigEarly();

function _deriveStorageKey(suffix, fallback) {
  const pid = _lojaEarly.firebase?.projectId;
  if (pid && pid !== 'ch-geladas') {
    const slug = pid.toUpperCase().replace(/-/g, '_').replace(/[^A-Z0-9_]/g, '');
    return `PDV_${suffix}_${slug}`;
  }
  return fallback;
}

const CONSTANTS = Object.freeze({
  STORAGE_KEY: _deriveStorageKey('DB', 'CH_GELADAS_DB_ENTERPRISE'),
  SYNC_LOCK_DURATION_MS: 5_000,  // reduzido de 15s→5s: protege saves locais sem bloquear sync simultâneo
  TOAST_DURATION_MS: 2_800,
  SYNC_FALLBACK_MS: 5_000,
  CART_ANIMATION_MS: 400,
  DEBOUNCE_SAVE_MS: 300,
  LOCALE: 'pt-BR',
  CURRENCY: { minimumFractionDigits: 2, maximumFractionDigits: 2 },
  PIN_HASH: Object.freeze({
    ADMIN: '7a3e6b16cb75f48fb897eff3ae732f3154f6d203b53f33660f01b4c3b6bc2df9', // 001
    PDV:   'a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3'  // 123
  }),
  LOW_STOCK_THRESHOLD: 3,
  // FIFO — limites para evitar estouro do localStorage em uso prolongado
  MAX_VENDAS:           5_000,
  MAX_INVENTARIO:       2_000,
  MAX_PONTO:            1_000,
  MAX_AUDIT_ESTOQUE:    3_000,
  MAX_MOVIMENTACOES:    1_000,
  MAX_AUDIT_LOG:        2_000,   // FIX-01: auditLog crescia sem limite → crash localStorage
  MAX_DELIVERY_PEDIDOS: 2_000,   // FIX-02: pedidos finalizados acumulavam indefinidamente
  MAX_CAIXA:              500,   // FIX-03: registros de abertura/fechamento sem teto
});

/* ═══════════════════════════════════════════════════════════════════
   VALIDATORS — Funções puras, sem efeitos colaterais
═══════════════════════════════════════════════════════════════════ */
const Validators = Object.freeze({
  /** @param {string} v @returns {boolean} */
  isNonEmptyString: v => typeof v === 'string' && v.trim().length > 0,

  /** @param {number} v @returns {boolean} */
  isPositiveNumber: v => typeof v === 'number' && Number.isFinite(v) && v >= 0,

  /** @param {any} v @returns {boolean} */
  isNonEmptyArray: v => Array.isArray(v) && v.length > 0,

  /** @param {string} tel @returns {boolean} */
  isPhoneNumber: tel => /^\+?[\d\s\-().]{7,20}$/.test(String(tel).trim()),

  /** @param {number} price @returns {boolean} */
  isValidPrice: price => typeof price === 'number' && Number.isFinite(price) && price >= 0,

  /** @param {object} product @returns {{valid:boolean, errors:string[]}} */
  validateProduct(product) {
    const errors = [];
    if (!this.isNonEmptyString(product?.nome)) errors.push('Nome é obrigatório');
    if (!this.isValidPrice(product?.precoUn))  errors.push('Preço unitário inválido');
    if (!this.isValidPrice(product?.custoUn))  errors.push('Custo unitário inválido');
    if (!this.isPositiveNumber(product?.qtdUn))errors.push('Quantidade inválida');
    return { valid: errors.length === 0, errors };
  },
});

/* ═══════════════════════════════════════════════════════════════════
   UTILITIES — Helpers puros
═══════════════════════════════════════════════════════════════════ */
const Utils = Object.freeze({
  /**
   * Gera ID único globalmente (UUID v4 via Web Crypto API).
   * Colisão-free, seguro para multi-device e multi-tab.
   * Compatível com todos os browsers modernos (mesmo Firefox/Safari offline).
   * Retorna string — todos os comparadores do app já usam String() casting.
   * @returns {string} ex: "550e8400-e29b-41d4-a716-446655440000"
   */
  generateId: () => crypto.randomUUID(),

  /**
   * Formata valor como moeda BRL
   * @param {number} v
   * @returns {string}
   */
  formatCurrency: v =>
    `R$ ${Number(v || 0).toLocaleString(CONSTANTS.LOCALE, CONSTANTS.CURRENCY)}`,

  /**
   * Formata número de telefone para wa.me (somente dígitos, sem zero inicial)
   * @param {string|null|undefined} tel
   * @returns {string}
   */
  formatPhone(tel) {
    if (!tel) return '';
    const digits = String(tel).replace(/\D/g, '');
    return digits.startsWith('0') ? digits.slice(1) : digits;
  },

  /**
   * Debounce: adia execução da função até silêncio de `ms`
   * @param {Function} fn
   * @param {number} ms
   * @returns {Function}
   */
  debounce(fn, ms) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  },

  /**
   * Safe JSON parse com fallback
   * @param {string} str
   * @param {any} fallback
   * @returns {any}
   */
  safeJsonParse(str, fallback = null) {
    try { return JSON.parse(str); }
    catch { return fallback; }
  },

  /**
   * Abre link WhatsApp sem ser bloqueado pelo browser
   * @param {string} tel
   * @param {string} msg
   */
  openWhatsApp(tel, msg) {
    const num = this.formatPhone(tel);
    if (!num) return;
    const a = document.createElement('a');
    a.href = `https://wa.me/55${num}?text=${encodeURIComponent(msg)}`;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  },

  /**
   * Download de blob como arquivo
   * @param {string|object} content
   * @param {string} mime
   * @param {string} filename
   */
  downloadBlob(content, mime, filename) {
    const blob = new Blob([content], { type: mime });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  /**
   * Obtém elemento do DOM de forma segura
   * @param {string} id
   * @returns {HTMLElement|null}
   */
  el: id => document.getElementById(id),

  /**
   * Data local atual em formato exibição: DD/MM/AAAA (pt-BR)
   * Usado para display ao usuário e comparações de dataCurta legada.
   */
  today: () => new Date().toLocaleDateString(CONSTANTS.LOCALE),

  /**
   * Data local atual em formato ISO: YYYY-MM-DD
   * Padrão global de armazenamento — evita ambiguidade e conversões.
   * Todas as novas gravações de dataCurta usam este formato.
   */
  todayISO: (() => {
    const pad = n => String(n).padStart(2, '0');
    return () => {
      const d = new Date();
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    };
  })(),

  /** Hora atual em locale string (HH:MM:SS) */
  now: () => new Date().toLocaleTimeString(CONSTANTS.LOCALE),

  /** Timestamp completo para logs e auditoria */
  timestamp: () => new Date().toLocaleString(CONSTANTS.LOCALE),
});

/* ═══════════════════════════════════════════════════════════════════
   CRYPTO — SHA-256 via Web Crypto API
═══════════════════════════════════════════════════════════════════ */
const CryptoService = (() => {
  /**
   * Gera hash SHA-256 de uma string
   * @param {string} str
   * @returns {Promise<string>}
   */
  async function sha256(str) {
    const buffer = new TextEncoder().encode(str);
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * Valida PIN comparando hash
   * @param {string} pin
   * @returns {Promise<'admin'|'pdv'|null>}
   */
  async function validatePin(pin) {
    const hash = await sha256(pin);
    // PINs personalizados (config) têm prioridade
    const cfg = (typeof Store !== 'undefined') ? Store.Selectors.getConfig() : {};
    if (cfg.pinHashAdmin && hash === cfg.pinHashAdmin) return 'admin';
    if (cfg.pinHashPdv   && hash === cfg.pinHashPdv)   return 'pdv';
    // Fallback para constantes padrão
    if (hash === CONSTANTS.PIN_HASH.ADMIN) return 'admin';
    if (hash === CONSTANTS.PIN_HASH.PDV)   return 'pdv';
    return null;
  }

  return Object.freeze({ sha256, validatePin });
})();

/* ═══════════════════════════════════════════════════════════════════
   EVENT BUS — Comunicação desacoplada entre módulos
═══════════════════════════════════════════════════════════════════ */
const EventBus = (() => {
  /** @type {Map<string, Set<Function>>} */
  const _listeners = new Map();

  /**
   * Registra listener para um evento
   * @param {string} event
   * @param {Function} handler
   * @returns {Function} unsubscribe
   */
  function on(event, handler) {
    if (!_listeners.has(event)) _listeners.set(event, new Set());
    _listeners.get(event).add(handler);
    return () => _listeners.get(event)?.delete(handler);
  }

  /**
   * Emite um evento com dados opcionais
   * @param {string} event
   * @param {any} [data]
   */
  function emit(event, data) {
    _listeners.get(event)?.forEach(fn => {
      try { fn(data); }
      catch (err) { console.error(`[EventBus] Handler error for "${event}":`, err); }
    });
  }

  /**
   * Remove todos os listeners de um evento
   * @param {string} event
   */
  function off(event) { _listeners.delete(event); }

  return Object.freeze({ on, emit, off });
})();

/* ═══════════════════════════════════════════════════════════════════
   STORE — Single Source of Truth (padrão Redux-like)
═══════════════════════════════════════════════════════════════════ */
const Store = (() => {
  /** @type {import('./types').AppState} */
  const _defaultState = () => ({
    estoque:    [],
    vendas:     [],
    ponto:      [],
    inventario: [],
    caixa:      [],
    comandas:   [],
    movimentacoes: [],   // entradas e saídas manuais
    auditLog:   [],      // log imutável de auditoria (append-only)
    auditEstoque: [],    // log detalhado de ajustes manuais de estoque
    fiado:      { clientes: [] },  // sistema de vendas a prazo
    backupHistory: [],   // pontos de restauração automáticos
    investimento: 0,
    config:     { whatsapp: '' },
    delivery:   {
      pedidos:      [],
      clientes:     [],
      entregadores: [],
      zonas:        [],
    },
  });

  let _state = _defaultState();
  let _version = 0;

  /**
   * Retorna referência ao estado atual.
   * ATENÇÃO: não mutar diretamente — use Store.mutate() para mutations controladas.
   * @returns {object}
   */
  function getState() { return _state; }

  /**
   * Executa uma mutação controlada no estado.
   * Garante que _ensureDefaults() é chamado, _version incrementa e o evento state:changed dispara.
   * Use este método em vez de Store.getState().campo = valor.
   * @param {function(object): void} fn — função que recebe o estado mutável
   * @param {boolean} [silent=false]
   */
  function mutate(fn, silent = false) {
    if (typeof fn !== 'function') return;
    const prev = _state;
    try { fn(_state); } catch (err) { console.error('[Store.mutate] Erro na mutação:', err); return; }
    _ensureDefaults();
    _version++;
    if (!silent) EventBus.emit('state:changed', { prev, next: _state, version: _version });
  }

  /**
   * Atualiza estado de forma controlada e emite evento 'state:changed'
   * @param {Partial<object>} patch
   * @param {boolean} [silent=false] — se true, não emite evento
   */
  function setState(patch, silent = false) {
    const prev = _state;
    _state = _mergeDeep(_state, patch);
    _ensureDefaults();
    _version++;
    if (!silent) EventBus.emit('state:changed', { prev, next: _state, version: _version });
  }

  /**
   * Reseta estado para o padrão inicial
   */
  function resetState() {
    _state = _defaultState();
    _version = 0;
    EventBus.emit('state:reset');
  }

  /**
   * Garante que arrays e sub-objetos obrigatórios existem
   * @private
   */
  function _ensureDefaults() {
    const d = _state;
    if (!d.config)              d.config = { whatsapp: '' };
    if (!d.config.nome)         d.config.nome = '';
    if (typeof d.config.alertaStock !== 'number') d.config.alertaStock = CONSTANTS.LOW_STOCK_THRESHOLD;
    if (!d.config.telegram)     d.config.telegram = { token: '', chatId: '' };
    if (!Array.isArray(d.config.categorias)) d.config.categorias = [];
    if (d.config.pinHashAdmin === undefined) d.config.pinHashAdmin = '';
    if (d.config.pinHashPdv   === undefined) d.config.pinHashPdv   = '';
    if (d.config.anthropicApiKey === undefined) d.config.anthropicApiKey = '';
    if (d.config.sessionTimeoutMinutes === undefined) d.config.sessionTimeoutMinutes = 30;
    if (!Array.isArray(d.estoque))    d.estoque    = [];
    if (!Array.isArray(d.vendas))     d.vendas     = [];
    if (!Array.isArray(d.ponto))      d.ponto      = [];
    if (!Array.isArray(d.inventario)) d.inventario = [];
    if (!Array.isArray(d.auditLog))       d.auditLog       = [];
    if (!Array.isArray(d.movimentacoes)) d.movimentacoes = [];
    if (!Array.isArray(d.auditEstoque)) d.auditEstoque = [];
    if (d.auditEstoque.length > CONSTANTS.MAX_AUDIT_ESTOQUE) d.auditEstoque.splice(CONSTANTS.MAX_AUDIT_ESTOQUE);
    if (d.movimentacoes.length > CONSTANTS.MAX_MOVIMENTACOES) d.movimentacoes.splice(CONSTANTS.MAX_MOVIMENTACOES);
    if (!d.fiado)                         d.fiado = { clientes: [] };
    if (!Array.isArray(d.fiado.clientes)) d.fiado.clientes = [];
    if (!Array.isArray(d.backupHistory))  d.backupHistory = [];
    if (d.backupHistory.length > 10)      d.backupHistory.splice(10); // máx 10 pontos
    if (!Array.isArray(d.caixa))      d.caixa      = [];
    if (!Array.isArray(d.comandas))   d.comandas   = [];
    if (typeof d.investimento !== 'number') d.investimento = 0;

    // FIFO — remove registros mais antigos para não estourar localStorage
    if (d.vendas.length     > CONSTANTS.MAX_VENDAS)     d.vendas.splice(CONSTANTS.MAX_VENDAS);
    if (d.inventario.length > CONSTANTS.MAX_INVENTARIO) d.inventario.splice(CONSTANTS.MAX_INVENTARIO);
    if (d.ponto.length      > CONSTANTS.MAX_PONTO)      d.ponto.splice(CONSTANTS.MAX_PONTO);
    // FIX-01: auditLog append-only crescia sem limite — mantém os 2000 mais recentes
    if (d.auditLog.length   > CONSTANTS.MAX_AUDIT_LOG)  d.auditLog.splice(CONSTANTS.MAX_AUDIT_LOG);
    // FIX-03: registros de abertura/fechamento de caixa sem teto
    if (Array.isArray(d.caixa) && d.caixa.length > CONSTANTS.MAX_CAIXA) d.caixa.splice(CONSTANTS.MAX_CAIXA);
    if (!d.delivery) d.delivery = { pedidos: [], clientes: [], entregadores: [], zonas: [] };
    const dlv = d.delivery;
    if (!Array.isArray(dlv.pedidos))      dlv.pedidos      = [];
    if (!Array.isArray(dlv.clientes))     dlv.clientes     = [];
    if (!Array.isArray(dlv.entregadores)) dlv.entregadores = [];
    if (!Array.isArray(dlv.zonas))        dlv.zonas        = [];
    // FIX-02: FIFO para pedidos — preserva ativos, trunca apenas os finalizados mais antigos
    if (dlv.pedidos.length > CONSTANTS.MAX_DELIVERY_PEDIDOS) {
      const ativos     = dlv.pedidos.filter(p => p.status !== 'ENTREGUE' && p.status !== 'CANCELADO');
      const finalizados = dlv.pedidos.filter(p => p.status === 'ENTREGUE' || p.status === 'CANCELADO');
      const limite     = Math.max(0, CONSTANTS.MAX_DELIVERY_PEDIDOS - ativos.length);
      dlv.pedidos = [...ativos, ...finalizados.slice(0, limite)];
    }
  }

  /**
   * Deep merge de objetos (não sobrescreve arrays, apenas objetos simples)
   * @private
   */
  function _mergeDeep(target, source) {
    if (source === null || typeof source !== 'object') return source;
    const output = { ...target };
    for (const key of Object.keys(source)) {
      if (
        source[key] !== null &&
        typeof source[key] === 'object' &&
        !Array.isArray(source[key]) &&
        typeof target[key] === 'object' &&
        !Array.isArray(target[key])
      ) {
        output[key] = _mergeDeep(target[key] || {}, source[key]);
      } else {
        output[key] = source[key];
      }
    }
    return output;
  }

  /** Selectors — acesso tipado e seguro ao estado */
  const Selectors = Object.freeze({
    getMovimentacoes:  () => _state.movimentacoes,
    getAuditEstoque:   () => _state.auditEstoque,
    getFiado:          () => _state.fiado,
    getFiadoClientes:  () => _state.fiado?.clientes || [],
    getFiadoClienteById: id => (_state.fiado?.clientes || []).find(c => String(c.id) === String(id)) || null,
    getEstoque:        () => _state.estoque,
    getVendas:         () => _state.vendas,
    getPonto:          () => _state.ponto,
    getInventario:     () => _state.inventario,
    getCaixa:          () => _state.caixa,
    getConfig:         () => _state.config,
    getDelivery:       () => _state.delivery,
    getPedidos:        () => _state.delivery.pedidos,
    getZonas:          () => _state.delivery.zonas,
    getEntregadores:   () => _state.delivery.entregadores,
    getInvestimento:   () => _state.investimento,
    getUltimoCaixa:    () => (_state.caixa || [])[0] || null,
    getProdutoById:    id => _state.estoque.find(p => String(p.id) === String(id)) || null,
    getPedidoById:     id => _state.delivery.pedidos.find(p => String(p.id) === String(id)) || null,
    getEntregadorById: id => _state.delivery.entregadores.find(e => String(e.id) === String(id)) || null,
    getZonaById:       id => _state.delivery.zonas.find(z => String(z.id) === String(id)) || null,
    getLowStockItems:  () => {
      const thresh = _state.config?.alertaStock ?? CONSTANTS.LOW_STOCK_THRESHOLD;
      return _state.estoque.filter(p => p.qtdUn > 0 && p.qtdUn <= thresh);
    },
    getOutOfStockItems:() => _state.estoque.filter(p => p.qtdUn <= 0),
    isCaixaOpen:       () => (_state.caixa || [])[0]?.tipo === 'ABERTURA',
    vendasHoje: () => {
      // dataCurta é YYYY-MM-DD (v6+). Backward-compat: aceita DD/MM/YYYY legado.
      const isoHoje  = Utils.todayISO(); // "2026-03-04"
      const dispHoje = Utils.today();    // "04/03/2026" — compatível com registros antigos
      return _state.vendas.filter(v => {
        const dc = v.dataCurta || '';
        if (dc) return dc === isoHoje || dc === dispHoje || dc.startsWith(dispHoje);
        return (v.data || '').startsWith(dispHoje);
      });
    },
    pedidosAtivosHoje: () => {
      const isoHoje  = Utils.todayISO();
      const dispHoje = Utils.today();
      return _state.delivery.pedidos.filter(p =>
        (p.dataCurta === isoHoje || p.data === dispHoje) &&
        p.status !== 'CANCELADO'
      );
    },
  });

  return Object.freeze({ getState, setState, resetState, mutate, Selectors });
})();

/* ═══════════════════════════════════════════════════════════════════
   SYNC SERVICE — localStorage + Firestore bridge
═══════════════════════════════════════════════════════════════════ */
const SyncService = (() => {
  let _syncLockTimer = null;
  let _isSyncLocked  = false;

  /** Bloqueia sync externo por SYNC_LOCK_DURATION_MS após save local */
  function _acquireSyncLock() {
    _isSyncLocked = true;
    clearTimeout(_syncLockTimer);
    _syncLockTimer = setTimeout(() => {
      _isSyncLocked = false;
      EventBus.emit('sync:unlocked');
    }, CONSTANTS.SYNC_LOCK_DURATION_MS);
  }

  /**
   * Persiste estado no localStorage e dispara backup no Firestore
   * Debounced para evitar escritas excessivas em série
   */
  const persist = Utils.debounce(() => {
    try {
      _acquireSyncLock();
      // Injeta timestamp de modificação para resolução de conflitos no sync remoto
      const stateWithTs = { ...Store.getState(), _updatedAt: Date.now() };
      localStorage.setItem(CONSTANTS.STORAGE_KEY, JSON.stringify(stateWithTs));
      EventBus.emit('sync:saved');

      // Bridge para sync.js (Firestore)
      if (typeof window.CH_BACKUP === 'function') window.CH_BACKUP();

      // Feedback visual de sincronização
      const dot = Utils.el('syncDot');
      if (dot) {
        dot.style.display  = 'block';
        dot.style.background = '#f59e0b';
        setTimeout(() => { dot.style.background = '#10b981'; }, 3_500);
      }
    } catch (err) {
      console.error('[SyncService] Persist failed:', err);
      EventBus.emit('sync:error', err);
    }
  }, CONSTANTS.DEBOUNCE_SAVE_MS);

  /**
   * FIX: persistNow — escrita IMEDIATA no localStorage sem debounce.
   * Usar em operações críticas (checkout, finalizar comanda/delivery) onde
   * um F5 ou fechamento de aba nos próximos 300ms não pode perder a venda.
   * O backup no Firestore ainda usa debounce (CH_BACKUP) para não sobrecarregar.
   */
  function persistNow() {
    try {
      _acquireSyncLock();
      const stateWithTs = { ...Store.getState(), _updatedAt: Date.now() };
      localStorage.setItem(CONSTANTS.STORAGE_KEY, JSON.stringify(stateWithTs));
      EventBus.emit('sync:saved');
      if (typeof window.CH_BACKUP === 'function') window.CH_BACKUP();
      const dot = Utils.el('syncDot');
      if (dot) {
        dot.style.display    = 'block';
        dot.style.background = '#f59e0b';
        setTimeout(() => { dot.style.background = '#10b981'; }, 3_500);
      }
    } catch (err) {
      console.error('[SyncService] PersistNow failed:', err);
      EventBus.emit('sync:error', err);
    }
  }

  /**
   * Carrega estado do localStorage
   * @returns {object|null}
   */
  function load() {
    const raw = localStorage.getItem(CONSTANTS.STORAGE_KEY);
    if (!raw) return null;
    return Utils.safeJsonParse(raw, null);
  }

  /**
   * Aplica dados remotos (Firestore) sem sobrescrever saves locais
   * Chamado por window.CH_SAFE_SYNC do sync.js
   * @param {object} remoteData
   */
  function applyRemoteSync(remoteData) {
    if (_isSyncLocked) {
      console.info('[SyncService] Sync bloqueado — save local em progresso');
      return;
    }
    if (!remoteData || typeof remoteData !== 'object') return;

    // BUG FIX: comparar _updatedAt contra o estado EM MEMÓRIA, não contra o localStorage.
    // Antes, sync.js/_applyRemoteSnapshot gravava o dado remoto no localStorage ANTES de chamar
    // esta função. Resultado: localTs === remoteTs → condição (remoteTs <= localTs) sempre
    // verdadeira → função retornava sem nunca atualizar o Store ou emitir sync:remote-applied.
    // O sync em tempo real estava completamente inativo.
    try {
      const localTs  = Store.getState()?._updatedAt ?? 0;
      const remoteTs = remoteData._updatedAt ?? 0;
      if (remoteTs <= localTs) {
        console.info(`[SyncService] Remote (${new Date(remoteTs).toLocaleTimeString()}) ≤ memória (${new Date(localTs).toLocaleTimeString()}) — ignorado`);
        return;
      }
    } catch { /* se falhar, permite aplicar */ }

    try {
      Store.setState(remoteData, true);
      const stateWithTs = { ...Store.getState(), _updatedAt: remoteData._updatedAt ?? Date.now() };
      localStorage.setItem(CONSTANTS.STORAGE_KEY, JSON.stringify(stateWithTs));
      EventBus.emit('sync:remote-applied', remoteData);
    } catch (err) {
      console.error('[SyncService] applyRemoteSync failed:', err);
    }
  }

  return Object.freeze({ persist, persistNow, load, applyRemoteSync, get _isSyncLocked() { return _isSyncLocked; } });
})();

/* ═══════════════════════════════════════════════════════════════════
   AUTH SERVICE — Autenticação com PIN + SHA-256
═══════════════════════════════════════════════════════════════════ */
const AuthService = (() => {
  /** @type {'admin'|'pdv'|null} */
  let _role = null;
  let _loginAttempts = 0;
  const MAX_ATTEMPTS = 5;

  /** @returns {'admin'|'pdv'|null} */
  const getRole  = () => _role;
  const isAdmin  = () => _role === 'admin';
  const isLogged = () => _role !== null;

  /**
   * Realiza login assíncrono com validação de PIN via SHA-256
   * @param {string} pin
   * @returns {Promise<boolean>}
   */
  async function login(pin) {
    if (_loginAttempts >= MAX_ATTEMPTS) {
      UIService.showToast('Bloqueado', 'Muitas tentativas. Recarregue a página.', 'error');
      return false;
    }

    const role = await CryptoService.validatePin(String(pin).trim());

    if (!role) {
      _loginAttempts++;
      const remaining = MAX_ATTEMPTS - _loginAttempts;
      UIService.showToast('PIN Inválido', remaining > 0 ? `${remaining} tentativa(s) restante(s)` : 'Conta bloqueada', 'error');
      const pinEl = Utils.el('pinInput');
      if (pinEl) pinEl.value = '';
      return false;
    }

    _loginAttempts = 0;
    _role = role;
    _applyRoleToUI(role);
    EventBus.emit('auth:login', { role });
    return true;
  }

  function logout() {
    _role = null;
    EventBus.emit('auth:logout');
  }

  /** Aplica permissões visuais baseadas no role */
  function _applyRoleToUI(role) {
    const isAdm = role === 'admin';

    document.body.classList.toggle('is-admin', isAdm);
    document.body.classList.toggle('is-pdv',   !isAdm);

    const roleTitle = Utils.el('roleTitle');
    const roleTag   = Utils.el('roleTag');
    if (roleTitle) roleTitle.textContent = isAdm ? 'Administrador' : 'Colaborador';
    if (roleTag) {
      roleTag.textContent = isAdm ? 'ADM' : 'PDV';
      roleTag.className   = `badge ${isAdm ? 'b-blue' : 'b-purple'}`;
      roleTag.classList.remove('hidden');
    }
  }

  return Object.freeze({ login, logout, getRole, isAdmin, isLogged });
})();

/* ═══════════════════════════════════════════════════════════════════
   UI SERVICE — Toast, Modais, Clock, Alertas
═══════════════════════════════════════════════════════════════════ */
const UIService = (() => {
  let _toastTimer  = null;
  let _clockTimer  = null;

  /* ── Toast ─────────────────────────────────────────────── */
  /**
   * Exibe notificação toast
   * @param {string} title
   * @param {string} [subtitle='']
   * @param {'success'|'warning'|'error'} [type='success']
   */
  function showToast(title, subtitle = '', type = 'success') {
    const toast = Utils.el('toast');
    if (!toast) return;

    const config = {
      success: { cls: 'bg-blue-500/20 text-blue-400',  icon: 'check' },
      warning: { cls: 'bg-amber-500/20 text-amber-400', icon: 'exclamation' },
      error:   { cls: 'bg-red-500/20 text-red-400',     icon: 'times' },
    };

    const { cls, icon } = config[type] || config.success;
    const iconEl = Utils.el('toastIcon');
    const msgEl  = Utils.el('toastMsg');
    const subEl  = Utils.el('toastSub');

    if (iconEl) { iconEl.className = `w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${cls}`; iconEl.innerHTML = `<i class="fas fa-${icon} text-[10px]"></i>`; }
    if (msgEl) msgEl.textContent = title;
    if (subEl) subEl.textContent = subtitle;

    toast.classList.add('show');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => toast.classList.remove('show'), CONSTANTS.TOAST_DURATION_MS);
  }

  /* ── Modais ─────────────────────────────────────────────── */
  /** @param {string} id */
  function openModal(id) {
    const modal = Utils.el(id);
    if (!modal) return;
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    // Trap focus inside modal
    const first = modal.querySelector('button, input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (first) setTimeout(() => first.focus(), 50);
  }

  /** @param {string} id */
  function closeModal(id) {
    const modal = Utils.el(id);
    if (!modal) return;
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
  }

  /** Fecha modais ao clicar no backdrop */
  function _initModalBackdropClose() {
    document.querySelectorAll('.modal').forEach(modal => {
      modal.addEventListener('click', e => {
        if (e.target === modal) closeModal(modal.id);
      });
    });
    // ESC fecha o modal aberto mais recente
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        const open = document.querySelector('.modal.open');
        if (open) closeModal(open.id);
      }
    });
  }

  /* ── Relógio ────────────────────────────────────────────── */
  function startClock() {
    const el = Utils.el('clock');
    if (!el) return;
    clearInterval(_clockTimer);
    const tick = () => { el.textContent = Utils.now(); };
    tick();
    _clockTimer = setInterval(tick, 1_000);
  }

  /* ── Alertas de Estoque ──────────────────────────────────── */
  function refreshAlerts() {
    if (!AuthService.isAdmin()) return;
    const lowCount = Store.Selectors.getLowStockItems().length;
    const btn      = Utils.el('alertaBtn');
    const count    = Utils.el('alertaCount');
    if (!btn) return;
    if (lowCount > 0) {
      if (count) count.textContent = lowCount;
      btn.style.display = 'flex';
      btn.setAttribute('aria-label', `${lowCount} produto(s) com estoque baixo`);
    } else {
      btn.style.display = 'none';
    }
  }

  /* ── Tela de Bloqueio ─────────────────────────────────────── */
  function showLock() {
    const lock = Utils.el('lock');
    if (lock) lock.style.display = 'flex';
    const app = Utils.el('app');
    if (app)  app.style.display  = 'none';

    const pin = Utils.el('pinInput');
    if (pin) {
      pin.maxLength = 6;

      // Tenta focar — só funciona se houver gesto do utilizador
      setTimeout(() => {
        pin.focus();
        // Após o attempt de focus, verifica se o teclado realmente abriu
        setTimeout(() => {
          if (document.activeElement !== pin) {
            _showTapToTypeBtn(pin);
          }
        }, 150);
      }, 300);

      // Clique em qualquer ponto do lock também tenta abrir o teclado
      const lockEl = Utils.el('lock');
      if (lockEl && !lockEl._tapBound) {
        lockEl._tapBound = true;
        lockEl.addEventListener('click', () => {
          Utils.el('pinInput')?.focus();
          _removeTapToTypeBtn();
        });
      }

      if (!pin._enterBound) {
        pin._enterBound = true;
        pin.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
      }
    }
  }

  /* Botão flutuante "Toque para digitar" — aparece quando o foco
     é bloqueado pelo browser (PWA offline sem gesto do utilizador) */
  function _showTapToTypeBtn(pin) {
    if (document.getElementById('_tapToTypeBtn')) return; // já existe
    const btn = document.createElement('button');
    btn.id = '_tapToTypeBtn';
    btn.textContent = '⌨️ Toque para digitar';
    btn.style.cssText = [
      'position:fixed',
      'bottom:40px',
      'left:50%',
      'transform:translateX(-50%)',
      'padding:14px 28px',
      'font-size:16px',
      'font-family:inherit',
      'background:#1a73e8',
      'color:#fff',
      'border:none',
      'border-radius:24px',
      'box-shadow:0 4px 16px rgba(0,0,0,0.35)',
      'z-index:99999',
      'cursor:pointer',
      'white-space:nowrap',
    ].join(';');
    // Este clique É um gesto humano real → o browser permite o focus + teclado
    btn.addEventListener('click', () => {
      (pin || Utils.el('pinInput'))?.focus();
      btn.remove();
    });
    document.body.appendChild(btn);
  }

  function _removeTapToTypeBtn() {
    document.getElementById('_tapToTypeBtn')?.remove();
  }

  function showApp() {
    const lock = Utils.el('lock');
    if (lock) lock.style.display  = 'none';
    const app = Utils.el('app');
    if (app)  app.style.display   = 'flex';
    const dot = Utils.el('syncDot');
    if (dot)  dot.style.display   = 'block';
  }

  /* ── Loader ───────────────────────────────────────────────── */
  function hideLoader() {
    const loader = Utils.el('app-loader');
    if (!loader) return;
    loader.classList.add('hide');
    setTimeout(() => { loader.style.display = 'none'; }, 400);
  }

  return Object.freeze({
    showToast, openModal, closeModal, startClock,
    refreshAlerts, showLock, showApp, hideLoader,
    _initModalBackdropClose,
  });
})();

/* ═══════════════════════════════════════════════════════════════════
   CART SERVICE — Carrinho de compras
═══════════════════════════════════════════════════════════════════ */
/**
 * Verifica se PDV pode registar vendas (ponto + caixa).
 * @returns {string|null} mensagem de bloqueio ou null se liberado
 */
function _getPdvBloqueio() {
  // ADM tem acesso total — sem restrição de ponto/caixa
  if (AuthService.isAdmin()) return null;

  // dataCurta é ISO (v6+); Utils.today() como fallback para registros legados
  const isoHoje  = Utils.todayISO();
  const dispHoje = Utils.today();
  const pontoHoje = Store.getState().ponto?.some(
    p => (p.dataCurta === isoHoje || p.dataCurta === dispHoje || p.data?.startsWith(dispHoje)) &&
         p.tipo === 'ENTRADA'
  );
  const caixaAberto = Store.Selectors.isCaixaOpen();

  if (!pontoHoje && !caixaAberto) return 'Registe o ponto e abra o caixa';
  if (!pontoHoje)                 return 'Registe a entrada do ponto primeiro';
  if (!caixaAberto)               return 'Abra o caixa antes de vender';
  return null;
}

const CartService = (() => {
  /** @type {Array<CartItem>} */
  let _items = [];
  let _formaPgto  = '';
  /** Desconto global em R$ aplicado ao total */
  let _desconto   = 0;
  /** Pagamentos múltiplos: [{forma, valor}] */
  let _pagamentos = [];
  /** Proteção contra checkout duplo */
  let _checkoutLock = false;
  /** Debounce por produto: evita duplo-toque acidental (<400ms) */
  const _lastAddTs = new Map();

  /* ── Getters ─────────────────────────────────────────────── */
  const getItems     = () => [..._items];
  const getSubtotal  = () => _items.reduce((acc, i) => acc + i.preco, 0);
  const getDesconto  = () => _desconto;
  const getTotal     = () => Math.max(0, getSubtotal() - _desconto);
  const getLucro     = () => Math.max(0, _items.reduce((acc, i) => acc + (i.preco - (i.custo || 0)), 0) - _desconto);
  const getCount     = () => _items.length;
  const isEmpty      = () => _items.length === 0;
  const getFormaPgto = () => _formaPgto;
  const getPagamentos = () => [..._pagamentos];

  /**
   * Define desconto em R$ sobre o total.
   * @param {number} valor — valor em R$ (0 = sem desconto)
   */
  function setDesconto(valor) {
    _desconto = Math.max(0, Number(valor) || 0);
    EventBus.emit('cart:desconto-set', _desconto);
  }

  /**
   * Adiciona uma forma de pagamento parcial.
   * @param {string} forma
   * @param {number} valor
   */
  function addPagamento(forma, valor) {
    if (!forma || valor <= 0) return;
    _pagamentos.push({ forma: String(forma), valor: Number(valor) });
    EventBus.emit('cart:pgto-added', _pagamentos);
  }

  /** Remove todos os pagamentos parciais */
  function clearPagamentos() {
    _pagamentos = [];
    _formaPgto  = '';
    EventBus.emit('cart:pgto-cleared');
  }

  /** Soma dos valores já alocados nos pagamentos */
  const getTotalPagamentos = () => _pagamentos.reduce((a, p) => a + p.valor, 0);

  /* ── Mutações ────────────────────────────────────────────── */
  /**
   * Adiciona item ao carrinho, verificando estoque
   * @param {string} prodId
   * @param {number} packIdx — 0 = unidade, 1+ = pack
   * @param {HTMLElement|null} btnEl — botão que gerou a ação (para animação)
   */
  function addItem(prodId, packIdx, btnEl = null) {
    // Debounce: bloqueia duplo-toque no mesmo produto (<400ms)
    const tsKey = `${prodId}:${packIdx}`;
    const now   = Date.now();
    if (now - (_lastAddTs.get(tsKey) || 0) < 400) return;
    _lastAddTs.set(tsKey, now);

    const product = Store.Selectors.getProdutoById(prodId);
    if (!product) return;

    // Guard: ponto + caixa obrigatórios
    const bloqueio = _getPdvBloqueio();
    if (bloqueio) {
      UIService.showToast('Acesso Bloqueado', bloqueio, 'error');
      TabManager.switchTab('ponto');
      return;
    }

    /** @type {CartItem} */
    let item;

    if (packIdx === 0) {
      if (product.qtdUn < 1) return UIService.showToast('Sem Estoque', product.nome, 'error');
      item = {
        prodId: product.id,
        nome:    product.nome,
        label:   'UNID',
        preco:   product.precoUn,
        custo:   product.custoUn,
        desconto: 1,
      };
    } else {
      const pack = product.packs?.[packIdx - 1];
      if (!pack) return;
      if (product.qtdUn < pack.un) return UIService.showToast('Estoque Insuficiente', 'Pack cancelado', 'error');
      item = {
        prodId:  product.id,
        nome:    product.nome,
        label:   `PACK ${pack.un}`,
        preco:   pack.preco,
        custo:   product.custoUn * pack.un,
        desconto: pack.un,
      };
    }

    _items.push(item);
    EventBus.emit('cart:item-added', item);

    // Animação no botão
    if (btnEl) {
      const cls = packIdx === 0 ? 'flash-blue' : 'flash-amber';
      btnEl.classList.remove(cls);
      void btnEl.offsetWidth; // reflow
      btnEl.classList.add(cls);
      setTimeout(() => btnEl.classList.remove(cls), CONSTANTS.CART_ANIMATION_MS);
    }
  }

  /**
   * Remove item pelo índice
   * @param {number} index
   */
  function removeItem(index) {
    if (index < 0 || index >= _items.length) return;
    const removed = _items.splice(index, 1)[0];
    EventBus.emit('cart:item-removed', removed);
  }

  /** Limpa todos os itens, desconto e pagamentos */
  function clear() {
    _items      = [];
    _desconto   = 0;
    _pagamentos = [];
    _formaPgto  = '';
    EventBus.emit('cart:cleared');
  }

  /**
   * Define a forma de pagamento (modo simples — mantido por compatibilidade)
   * @param {string} forma
   */
  function setFormaPgto(forma) {
    _formaPgto = forma;
    // Modo simples: substitui pagamentos múltiplos
    _pagamentos = [{ forma, valor: getTotal() }];
    EventBus.emit('cart:pgto-set', forma);
  }

  /* ── Checkout ────────────────────────────────────────────── */
  /**
   * Finaliza venda: debita estoque, registra venda e inventário
   * @returns {object|null} venda registrada ou null em caso de erro
   */
  function checkout() {
    if (isEmpty() || _checkoutLock) return null;
    _checkoutLock = true;

    const now    = new Date();
    const today  = Utils.todayISO();
    const nowStr = Utils.now();
    const ts     = Utils.timestamp();

    const vendaId = Utils.generateId();

    // Debita estoque e registra no inventário via Store.mutate()
    Store.mutate(state => {
      _items.forEach(item => {
        const product = state.estoque.find(p => String(p.id) === String(item.prodId));
        if (!product) return;
        const qtdAntes = product.qtdUn;
        state.inventario.unshift({
          id: Utils.generateId(),
          vendaId,
          produto:       product.nome,
          label:         item.label,
          preco:         item.preco,
          qtdMovimento:  item.desconto,
          qtdAntes,
          qtdDepois:     qtdAntes - item.desconto,
          data:          today,
          hora:          nowStr,
          tipo:          'VENDA',
        });
        product.qtdUn -= item.desconto;
      });
    }, true); // silent=true pois persist() já dispara seu próprio evento

    const venda = {
      id:          vendaId,
      total:       getTotal(),
      subtotal:    getSubtotal(),
      desconto:    _desconto,
      lucro:       getLucro(),
      data:        ts,
      dataCurta:   today,
      hora:        nowStr,
      itens:       [..._items],
      formaPgto:   _pagamentos.length > 1
                     ? _pagamentos.map(p => `${p.forma}(${Utils.formatCurrency(p.valor)})`).join(' + ')
                     : (_formaPgto || (_pagamentos[0]?.forma ?? '')),
      pagamentos:  [..._pagamentos],
      origem:      'PDV',
    };

    Store.mutate(state => { state.vendas.unshift(venda); }, true);
    // FIX: persistNow (sem debounce) garante que a venda está no localStorage
    // imediatamente — evita perda se o utilizador der F5 nos próximos 300ms.
    SyncService.persistNow();

    const vendaSnapshot = { ...venda };
    clear();
    EventBus.emit('cart:checkout', vendaSnapshot);
    setTimeout(() => { _checkoutLock = false; }, 1_500);
    return vendaSnapshot;
  }

  return Object.freeze({
    getItems, getSubtotal, getTotal, getDesconto, getLucro,
    getCount, isEmpty, getFormaPgto, getPagamentos, getTotalPagamentos,
    addItem, removeItem, clear, setFormaPgto,
    setDesconto, addPagamento, clearPagamentos, checkout,
  });
})();

/* ═══════════════════════════════════════════════════════════════════
   RENDER SERVICE — Catálogo PDV e Carrinho
═══════════════════════════════════════════════════════════════════ */
const RenderService = (() => {
  /* ── PDV Stats ────────────────────────────────────────────── */
  function updateStats() {
    const estoque  = Store.Selectors.getEstoque();
    const statsEl  = Utils.el('pdvStats');
    if (!statsEl) return;

    if (estoque.length > 0) {
      statsEl.classList.remove('hidden');
      _setText('pdvTotal', estoque.length);
      _setText('pdvLow',   Store.Selectors.getLowStockItems().length);
      _setText('pdvOut',   Store.Selectors.getOutOfStockItems().length);
    } else {
      statsEl.classList.add('hidden');
    }
    UIService.refreshAlerts();
  }

  /* ── Catálogo ─────────────────────────────────────────────── */
  /* ── Filtro por categoria ─────────────────────────────────── */
  let _activeCat  = null;
  let _activeMode = 'todos';

  function setCatFilter(cat) {
    _activeCat = (_activeCat === cat) ? null : cat;
    renderCatFilter();
    renderCatalogo();
  }

  function setCatalogMode(mode) {
    _activeMode = (_activeMode === mode) ? 'todos' : mode;
    renderCatFilter();
    renderCatalogo();
  }

  function renderCatFilter() {
    const row  = Utils.el('catFilterRow');
    if (!row) return;
    const cats = Store.Selectors.getConfig()?.categorias || [];
    row.classList.remove('hidden');

    const modePill = (label, mode, icon) => {
      const a = _activeMode === mode;
      return '<button onclick="setCatalogMode(\'' + mode + '\')" class="flex-shrink-0 px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-wide transition-all border flex items-center gap-1 ' +
        (a ? 'bg-blue-600 text-white border-blue-500' : 'bg-slate-900 text-slate-400 border-white/10 hover:border-blue-500/40') +
        '"><i class=\"fas ' + icon + ' text-[8px]\"></i>' + label + '</button>';
    };
    const catPill = (label, val) => {
      const a = _activeCat === val;
      const onclick = val === null ? 'setCatFilter(null)' : "setCatFilter('" + val.replace(/'/g, "\\'") + "')";
      return '<button onclick="' + onclick + '" class="flex-shrink-0 px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-wide transition-all border ' +
        (a ? 'bg-violet-600 text-white border-violet-500' : 'bg-slate-900 text-slate-400 border-white/10 hover:border-violet-500/40') +
        '">' + label + '</button>';
    };

    const modes = modePill('Disponíveis', 'disponiveis', 'fa-check-circle') +
                  modePill('Mais Vendidos', 'topsellers', 'fa-fire');
    const catPills = cats.length > 0
      ? '<span class="w-px h-4 bg-white/10 self-center flex-shrink-0"></span>' +
        catPill('Todos', null) + cats.map(c => catPill(c, c)).join('')
      : '';
    row.innerHTML = modes + catPills;
  }

  function renderCatalogo() {
    const cont = Utils.el('catalogo');
    if (!cont) return;

    // Verifica bloqueio ponto + caixa
    const bloqueio   = _getPdvBloqueio();
    const warning    = Utils.el('pdvWarning');
    const warningMsg = Utils.el('pdvWarningMsg');
    if (warning) {
      if (bloqueio) {
        warning.classList.remove('hidden');
        if (warningMsg) warningMsg.textContent = bloqueio;
      } else {
        warning.classList.add('hidden');
      }
    }

    const busca   = (Utils.el('searchProd')?.value || '').toLowerCase();
    let estoque = Store.Selectors.getEstoque();

    // Modo: mais vendidos — ordena por quantidade vendida
    if (_activeMode === 'topsellers') {
      const mapa = {};
      Store.Selectors.getVendas().forEach(v => {
        (v.itens || []).forEach(it => {
          const k = String(it.prodId || '');
          mapa[k] = (mapa[k] || 0) + (it.desconto || 1);
        });
      });
      estoque = [...estoque].sort((a, b) => (mapa[String(b.id)] || 0) - (mapa[String(a.id)] || 0));
    }

    const filtered = estoque.filter(p => {
      const buscaOk = !busca || p.nome.toLowerCase().includes(busca);
      const catOk   = !_activeCat || (p.categoria || '') === _activeCat;
      const modeOk  = _activeMode !== 'disponiveis' || p.qtdUn > 0;
      return buscaOk && catOk && modeOk;
    });

    if (filtered.length === 0) {
      cont.innerHTML = `
        <div class="col-span-full flex flex-col items-center justify-center py-20 opacity-20">
          <i class="fas fa-beer text-5xl mb-4 text-slate-600"></i>
          <p class="text-[10px] font-black uppercase tracking-widest text-slate-600">
            ${busca || _activeCat ? 'Nenhum produto encontrado' : 'Catálogo vazio'}
          </p>
        </div>`;
      return;
    }

    const frag = document.createDocumentFragment();
    filtered.forEach(prod => {
      const div = document.createElement('div');
      div.innerHTML = _buildProdCard(prod, !!bloqueio);
      frag.appendChild(div.firstElementChild);
    });
    cont.innerHTML = '';
    cont.appendChild(frag);
    updateStats();
  }

  /**
   * Constrói HTML do card de produto (sem innerHTML concatenado em loop)
   * @param {object} p — produto
   * @returns {string}
   */
  function _buildProdCard(p, bloqueado = false) {
    const esgotado   = p.qtdUn <= 0;
    const _thresh    = Store.Selectors.getConfig()?.alertaStock ?? CONSTANTS.LOW_STOCK_THRESHOLD;
    const baixoStock = !esgotado && p.qtdUn <= _thresh;
    const stockCls   = esgotado   ? 'text-red-400'
                     : baixoStock ? 'text-amber-400'
                     :              'text-emerald-400';
    const stockLabel = esgotado   ? 'Esgotado'
                     : baixoStock ? `⚠ ${p.qtdUn}`
                     :              `${p.qtdUn} und`;
    const margem = p.custoUn > 0
      ? `<span class="badge b-green text-[7px]">${((1 - p.custoUn / p.precoUn) * 100).toFixed(0)}%</span>` : '';
    const catBadge = p.categoria
      ? `<span class="inline-block px-1.5 py-0.5 rounded-full bg-violet-500/15 text-violet-400 text-[6px] font-black uppercase tracking-wide leading-none">${_escapeHtml(p.categoria)}</span>`
      : '';

    // Packs: só o primeiro pack em mobile (para não encher demais)
    const packsHtml = (p.packs || []).slice(0, 2).map((pk, i) => {
      const desc = ((1 - pk.preco / (p.precoUn * pk.un)) * 100).toFixed(0);
      return `<button class="btn-pk" onclick="addCart('${p.id}', ${i + 1}, this)"
          ${esgotado || p.qtdUn < pk.un || bloqueado ? 'disabled' : ''}>
        <div class="text-[8px] font-black text-amber-400 uppercase leading-none">Pack ${pk.un}</div>
        <div class="text-[10px] font-black text-white leading-tight">R$ ${pk.preco.toFixed(2)}</div>
        ${Number(desc) > 0 ? `<div class="text-[7px] text-amber-300/60">-${desc}%</div>` : ''}
      </button>`;
    }).join('');

    return `
      <article class="prod-card p-3 flex flex-col gap-2 ${esgotado ? 'esgotado' : ''}" data-prod-id="${p.id}">
        <!-- header: nome + margem -->
        <div class="flex items-start justify-between gap-1 min-w-0">
          <div class="min-w-0 flex-1">
            <h3 class="text-[10px] font-black text-slate-200 leading-tight" style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${_escapeHtml(p.nome)}</h3>
            ${catBadge}
          </div>
          ${margem}
        </div>
        <!-- preço + stock -->
        <div>
          <p class="text-base font-black text-white leading-none">R$ ${p.precoUn.toFixed(2)}</p>
          <p class="text-[8px] font-bold ${stockCls} mt-0.5">${stockLabel}</p>
        </div>
        <!-- botões -->
        <div class="flex gap-1.5 mt-auto">
          <button class="btn-un flex-1" onclick="addCart('${p.id}', 0, this)"
              ${esgotado || bloqueado ? 'disabled' : ''}>
            <div class="text-[8px] font-black text-blue-400 uppercase leading-none">Unid</div>
            <div class="text-[10px] font-black text-white leading-tight">R$ ${p.precoUn.toFixed(2)}</div>
          </button>
          ${packsHtml}
        </div>
      </article>`;
  }

  /* ── Carrinho ─────────────────────────────────────────────── */
  function renderCarrinho() {
    const items = CartService.getItems();
    const total = CartService.getTotal();
    const count = CartService.getCount();
    const fmtTotal = Utils.formatCurrency(total);

    const emptyHtml = `<div class="flex flex-col items-center justify-center h-full text-center py-10 opacity-20">
      <i class="fas fa-shopping-cart text-4xl mb-3 text-slate-500"></i>
      <p class="text-[10px] text-slate-500 font-black uppercase tracking-wider">Carrinho vazio</p>
    </div>`;

    function fillContainer(cont, btnLimparId) {
      if (!cont) return;
      if (items.length === 0) {
        cont.innerHTML = emptyHtml;
        Utils.el(btnLimparId)?.classList.add('hidden');
      } else {
        const frag = document.createDocumentFragment();
        items.forEach((item, i) => {
          const div = document.createElement('div');
          div.innerHTML = _buildCartItem(item, i);
          frag.appendChild(div.firstElementChild);
        });
        cont.innerHTML = '';
        cont.appendChild(frag);
        Utils.el(btnLimparId)?.classList.remove('hidden');
      }
    }

    // Desktop sidebar
    fillContainer(Utils.el('carrinhoLista'), 'btnLimpar');
    _setText('cartTotal', fmtTotal);
    if (CartService.getDesconto() > 0) {
      _setText('cartSubtotalDesk', `Sub: ${Utils.formatCurrency(CartService.getSubtotal())}`);
    } else {
      _setText('cartSubtotalDesk', '');
    }
    _setText('cartSubtotal', '');
    _setText('cartDesconto', '');
    _setText('cartCount', count > 0 ? `${count} ${count === 1 ? 'item' : 'itens'}` : '');
    const badge = Utils.el('cartBadge');
    if (badge) { badge.textContent = count; badge.classList.toggle('hidden', count === 0); }

    // Quick-pay buttons
    const qp    = Utils.el('quickPayBtns');
    const qpMob = Utils.el('quickPayBtnsMob');
    if (qp)    qp.classList.toggle('hidden', count === 0);
    if (qpMob) qpMob.classList.toggle('hidden', count === 0);

    const btn = Utils.el('btnFinalizar');
    if (btn) {
      btn.disabled = count === 0;
      btn.className = count > 0
        ? 'w-full py-3 rounded-xl font-black uppercase text-[10px] tracking-widest transition-all bg-slate-700/60 text-slate-300 border border-white/8 hover:bg-slate-700'
        : 'w-full py-3 rounded-xl font-black uppercase text-[10px] tracking-widest transition-all bg-slate-800 text-slate-500 cursor-not-allowed';
    }

    // Mobile drawer
    fillContainer(Utils.el('carrinhoListaMob'), 'btnLimparMob');
    _setText('cartTotalMob', fmtTotal);
    _setText('cartCountMob', count > 0 ? `${count} ${count === 1 ? 'item' : 'itens'}` : '');
    const badgeMob = Utils.el('cartBadgeMob');
    if (badgeMob) { badgeMob.textContent = count; badgeMob.classList.toggle('hidden', count === 0); }
    const btnMob = Utils.el('btnFinalizarMob');
    if (btnMob) {
      btnMob.disabled = count === 0;
      btnMob.className = count > 0
        ? 'w-full py-3 rounded-xl font-black uppercase text-[10px] tracking-widest transition-all bg-slate-700/60 text-slate-300 border border-white/8'
        : 'w-full py-3 rounded-xl font-black uppercase text-[10px] tracking-widest transition-all bg-slate-800 text-slate-500 cursor-not-allowed';
    }

    // Float button
    const fl = Utils.el('float-cart');
    if (fl) {
      fl.classList.toggle('show', count > 0);
      if (count > 0) {
        _setText('floatCount', `${count} ${count === 1 ? 'item' : 'itens'}`);
        _setText('floatTotal', fmtTotal);
        _setText('floatBadge', count);
      }
    }
  }

  /**
   * @param {object} item
   * @param {number} index
   * @returns {string}
   */
  function _buildCartItem(item, index) {
    const isUnid = item.label === 'UNID';
    return `
      <div class="flex justify-between items-center bg-slate-950/60 px-4 py-3 rounded-xl border border-white/5 hover:border-white/10 transition-all"
           role="listitem">
        <div class="flex items-center gap-3 min-w-0">
          <div class="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 ${isUnid ? 'bg-blue-500/15' : 'bg-amber-500/15'}" aria-hidden="true">
            <i class="fas ${isUnid ? 'fa-cube text-blue-400' : 'fa-box text-amber-400'} text-[9px]"></i>
          </div>
          <div class="min-w-0">
            <p class="text-[10px] font-black text-slate-300 truncate">${_escapeHtml(item.nome)}</p>
            <p class="text-[9px] text-slate-600 font-bold">
              ${_escapeHtml(item.label)} ·
              <span class="text-blue-400 font-black">${Utils.formatCurrency(item.preco)}</span>
            </p>
          </div>
        </div>
        <button
          onclick="removerCart(${index})"
          class="w-6 h-6 rounded-lg bg-red-500/8 text-red-500/40 hover:bg-red-500/20 hover:text-red-400 flex items-center justify-center transition-all flex-shrink-0 ml-2"
          aria-label="Remover ${_escapeHtml(item.nome)} do carrinho">
          <i class="fas fa-times text-[9px]" aria-hidden="true"></i>
        </button>
      </div>`;
  }

  /* ── Auxiliares ──────────────────────────────────────────── */
  function _setText(id, text) {
    const el = Utils.el(id);
    if (el) el.textContent = text;
  }

  /** Previne XSS em interpolação de strings */
  function _escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* ── Modo Turbo — top-sellers + atalhos por categoria ────── */
  const _EMOJI_CAT = {
    'cerveja': '🍺', 'beer': '🍺', 'lata': '🍺', 'litrão': '🍶', 'litrao': '🍶',
    'whisky': '🥃', 'dose': '🥃', 'destilado': '🥃', 'vodka': '🥃', 'rum': '🥃',
    'refrigerante': '🥤', 'refri': '🥤', 'suco': '🥤', 'energético': '⚡',
    'água': '💧', 'agua': '💧', 'gelo': '🧊', 'copo': '🥂', 'vinho': '🍷',
  };

  const _CATEGORY_SHORTCUTS = [
    { label: 'Cerveja Lata', keys: ['cerveja lata', 'lata'], emoji: '🍺' },
    { label: 'Litrão',       keys: ['litrão', 'litrao', '1l', '1 l'], emoji: '🍶' },
    { label: 'Whisky',       keys: ['whisky', 'whiskey', 'dose'],      emoji: '🥃' },
    { label: 'Gelo',         keys: ['gelo'],                            emoji: '🧊' },
    { label: 'Refrigerante', keys: ['refrigerante', 'refri'],           emoji: '🥤' },
    { label: 'Água',         keys: ['água', 'agua'],                    emoji: '💧' },
  ];

  function _emojiFit(nome) {
    const n = (nome || '').toLowerCase();
    for (const [k, e] of Object.entries(_EMOJI_CAT)) {
      if (n.includes(k)) return e;
    }
    return '🍶';
  }

  function renderTurboMode() {
    const cont = Utils.el('turboGrid');
    if (!cont) return;

    const estoque = Store.Selectors.getEstoque();

    // Agrega quantidades por produto a partir do histórico de vendas
    const mapa = {};
    Store.Selectors.getVendas().forEach(v => {
      (v.itens || []).forEach(it => {
        const key = String(it.prodId || '');
        if (!key) return;
        if (!mapa[key]) mapa[key] = { prodId: key, nome: it.nome || '', qtd: 0 };
        mapa[key].qtd += (it.desconto || 1);
      });
    });

    const top = Object.values(mapa).sort((a, b) => b.qtd - a.qtd).slice(0, 8);

    // Atalhos de categoria fixos — encontra o primeiro produto que bate
    const shortcuts = _CATEGORY_SHORTCUTS.map(sc => {
      const prod = estoque.find(p => {
        const n = (p.nome || '').toLowerCase();
        return sc.keys.some(k => n.includes(k));
      });
      return prod ? { ...sc, prod } : null;
    }).filter(Boolean);

    if (!top.length && !shortcuts.length) {
      cont.innerHTML = `<p class="col-span-4 text-center text-slate-700 text-[9px] font-black uppercase py-3">Realize algumas vendas para popular</p>`;
      return;
    }

    const frag = document.createDocumentFragment();

    // Primeiro: atalhos de categoria
    shortcuts.forEach(sc => {
      const p = sc.prod;
      const esgotado = p.qtdUn <= 0;
      const div = document.createElement('div');
      div.innerHTML = `
        <button onclick="addCart('${p.id}', 0, this)" ${esgotado ? 'disabled' : ''}
          class="turbo-btn ${esgotado ? 'esgotado' : ''}" title="${_escapeHtml(p.nome)}">
          <span class="text-xl leading-none">${sc.emoji}</span>
          <p class="text-[7px] font-black text-amber-300 uppercase leading-none">${_escapeHtml(sc.label)}</p>
          <p class="text-[9px] font-black text-white">R$ ${p.precoUn.toFixed(2)}</p>
          <p class="text-[7px] text-slate-600 font-bold">${esgotado ? 'Esgotado' : p.qtdUn + ' un'}</p>
        </button>`;
      frag.appendChild(div.firstElementChild);
    });

    // Depois: top-sellers que não estão nos shortcuts
    const shortcutIds = new Set(shortcuts.map(s => String(s.prod.id)));
    top.filter(t => !shortcutIds.has(String(t.prodId))).slice(0, Math.max(0, 8 - shortcuts.length)).forEach(t => {
      const prod = Store.Selectors.getProdutoById(t.prodId);
      if (!prod) return;
      const esgotado = prod.qtdUn <= 0;
      const div = document.createElement('div');
      div.innerHTML = `
        <button onclick="addCart('${prod.id}', 0, this)" ${esgotado ? 'disabled' : ''}
          class="turbo-btn ${esgotado ? 'esgotado' : ''}">
          <span class="text-xl leading-none">${_emojiFit(prod.nome)}</span>
          <p class="text-[8px] font-black text-white leading-tight w-full"
            style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">
            ${_escapeHtml(prod.nome)}</p>
          <p class="text-[9px] font-black text-blue-400">R$ ${prod.precoUn.toFixed(2)}</p>
          <p class="text-[7px] text-slate-600 font-bold">${esgotado ? 'Esgotado' : prod.qtdUn + ' un'}</p>
        </button>`;
      frag.appendChild(div.firstElementChild);
    });

    cont.innerHTML = '';
    cont.appendChild(frag);
  }

  return Object.freeze({ renderCatalogo, renderCarrinho, updateStats, renderCatFilter, setCatFilter, setCatalogMode, renderTurboMode, _escapeHtml, get _activeCat() { return _activeCat; }, get _activeMode() { return _activeMode; } });
})();

/* ═══════════════════════════════════════════════════════════════════
   TAB MANAGER — Controle de abas com permissão
═══════════════════════════════════════════════════════════════════ */
const TabManager = (() => {
  /** Map de aba → função de render associada */
  const _renderMap = {
    vendas:     () => { RenderService.renderCatalogo(); },
    estoque:    () => { if (typeof renderEstoque    === 'function') renderEstoque();    },
    financeiro: () => { if (typeof renderFinanceiro === 'function') renderFinanceiro(); if (typeof CaixaTurnoService !== 'undefined') CaixaTurnoService.renderTurnoAtual(); },
    fluxo:      () => { if (typeof renderFluxo      === 'function') renderFluxo();      },
    ponto:      () => { if (typeof renderPonto      === 'function') renderPonto();      },
    dados:      () => { if (typeof renderDados      === 'function') renderDados();      },
    inventario: () => { if (typeof renderInventario === 'function') renderInventario(); },
    ia:         () => { if (typeof renderIA         === 'function') renderIA();         },
    comanda:    () => { if (typeof renderComandas   === 'function') renderComandas();   },
    fiado:      () => { if (typeof renderFiado      === 'function') renderFiado();      },
    delivery:   () => {
      if (typeof renderDelivery          === 'function') renderDelivery();
      if (typeof populateMpProdutos      === 'function') populateMpProdutos();
      if (typeof populateMpZonas         === 'function') populateMpZonas();
      if (typeof populateMpEntregadores  === 'function') populateMpEntregadores();
    },
  };

  /**
   * Troca de aba com verificação de permissão
   * @param {string} id
   */
  function switchTab(id) {
    const btn = document.querySelector(`[data-tab="${id}"]`);
    if (!btn) return;

    // Verifica permissão para aba restrita
    if (btn.classList.contains('adm') && !AuthService.isAdmin()) {
      UIService.showToast('Acesso Negado', 'Apenas Administradores', 'error');
      return;
    }

    // Verifica plano SaaS para abas bloqueadas por feature
    if (id === 'ia' && window.SaasPlans && !SaasPlans.check('ia')) {
      SaasPlans.showUpgradeModal('ia');
      return;
    }
    if (id === 'delivery' && window.SaasPlans && !SaasPlans.check('delivery')) {
      SaasPlans.showUpgradeModal('delivery');
      return;
    }

    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));

    const pane = Utils.el(`tab-${id}`);
    if (pane) {
      pane.classList.add('active');
      pane.setAttribute('aria-selected', 'true');
    }
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');

    if (id === 'estoque' && typeof resetFormEstoque === 'function') resetFormEstoque();
    _renderMap[id]?.();
    EventBus.emit('tab:switched', id);
  }

  return Object.freeze({ switchTab });
})();

/* ═══════════════════════════════════════════════════════════════════
   VENDA — Fluxo de pagamento e comprovante
═══════════════════════════════════════════════════════════════════ */
const VendaService = (() => {
  /** @type {object|null} */
  let _lastSale = null;

  /** @returns {object|null} */
  const getLastSale = () => _lastSale;

  /** Abre modal de seleção de pagamento */
  function abrirPagamento() {
    if (CartService.isEmpty()) return;

    // Guard: ponto + caixa obrigatórios
    const bloqueio = _getPdvBloqueio();
    if (bloqueio) {
      UIService.showToast('Acesso Bloqueado', bloqueio, 'error');
      TabManager.switchTab('ponto');
      return;
    }

    // Limpa pagamentos anteriores
    CartService.clearPagamentos();

    // BUG-02 FIX: zera desconto interno e o campo de input ao re-abrir o modal.
    // clearPagamentos() não toca em _desconto — sem este reset, um desconto
    // aplicado em uma abertura anterior fica ativo na próxima.
    CartService.setDesconto(0);
    const _descInp  = Utils.el('_pdvDescontoInput');
    const _descInfo = Utils.el('_pdvDescontoInfo');
    if (_descInp)  _descInp.value = '';
    if (_descInfo) _descInfo.classList.add('hidden');

    // BUG-03 FIX: oculta e limpa o painel de multi-pagamento ao re-abrir.
    // O wrap é injetado uma única vez — sem este reset, a lista de uma
    // divisão anterior continua visível na abertura seguinte.
    const _multiWrap = Utils.el('_pdvMultiPgtoWrap');
    const _pgtoLista = Utils.el('_pdvPgtosLista');
    const _pgtoRest  = Utils.el('_pdvPgtoRestante');
    if (_multiWrap) _multiWrap.classList.add('hidden');
    if (_pgtoLista) _pgtoLista.innerHTML = '';
    if (_pgtoRest)  _pgtoRest.textContent = 'Restante: —';

    const subtotalEl = Utils.el('vendaSubtotal');
    const resumoEl   = Utils.el('vendaResumo');
    const descontoEl = Utils.el('vendaDescontoWrap');

    if (subtotalEl) subtotalEl.textContent = `Subtotal: ${Utils.formatCurrency(CartService.getSubtotal())}`;
    if (resumoEl)   resumoEl.textContent   = `Total: ${Utils.formatCurrency(CartService.getTotal())}`;

    // Injeta painel de desconto se ainda não existe no modal
    const modal    = Utils.el('modalPagamento');
    // Operar dentro do .modal-box — os botões são filhos diretos dele, não do .modal
    const modalBox = modal?.querySelector('.modal-box') ?? modal;
    if (modalBox && !Utils.el('_pdvDescontoInput')) {
      const wrap = document.createElement('div');
      wrap.id        = '_pdvDescontoWrap';
      wrap.className = 'mt-3 mb-1';
      wrap.innerHTML = `
        <label class="block text-[9px] font-black uppercase text-slate-500 mb-1">Desconto (R$)</label>
        <div class="flex gap-2">
          <input id="_pdvDescontoInput" type="number" min="0" step="0.01" placeholder="0,00"
            class="flex-1 bg-slate-900 border border-white/10 rounded-xl px-3 py-2 text-sm text-white font-black focus:border-blue-500 outline-none"
            oninput="_pdvAplicarDesconto()"/>
          <button onclick="_pdvAplicarDesconto()"
            class="px-3 rounded-xl bg-amber-600/20 text-amber-300 border border-amber-500/30 text-[9px] font-black uppercase hover:bg-amber-600/30 transition-all">
            Aplicar
          </button>
        </div>
        <p id="_pdvDescontoInfo" class="text-[8px] text-amber-400 font-bold mt-1 hidden"></p>`;
      // Insere antes do grid de botões — filho direto do modal-box
      const grid = modalBox.querySelector('[class*="grid"]');
      modalBox.insertBefore(wrap, grid ?? null);
    }

    // Injeta seção de pagamento múltiplo
    if (modalBox && !Utils.el('_pdvMultiPgtoWrap')) {
      const mp = document.createElement('div');
      mp.id        = '_pdvMultiPgtoWrap';
      mp.className = 'mt-2 mb-2 hidden';
      mp.innerHTML = `
        <div class="border-t border-white/10 pt-3">
          <p class="text-[9px] font-black uppercase text-slate-400 mb-2">Divisão de Pagamento</p>
          <div id="_pdvPgtosLista" class="space-y-1 mb-2"></div>
          <p id="_pdvPgtoRestante" class="text-[9px] text-blue-300 font-bold mb-2">Restante: —</p>
        </div>`;
      modalBox.appendChild(mp);
    }

    UIService.openModal('modalPagamento');
  }

  /** Aplica desconto digitado no campo */
  function _aplicarDesconto() {
    const inp  = Utils.el('_pdvDescontoInput');
    const info = Utils.el('_pdvDescontoInfo');
    const resumoEl = Utils.el('vendaResumo');
    if (!inp) return;
    const val = parseFloat(inp.value) || 0;
    const max = CartService.getSubtotal();
    const descFinal = Math.min(val, max);
    CartService.setDesconto(descFinal);
    if (info) {
      if (descFinal > 0) {
        info.textContent = `Desconto: −${Utils.formatCurrency(descFinal)} · Novo total: ${Utils.formatCurrency(CartService.getTotal())}`;
        info.classList.remove('hidden');
      } else {
        info.classList.add('hidden');
      }
    }
    if (resumoEl) resumoEl.textContent = `Total: ${Utils.formatCurrency(CartService.getTotal())}`;
  }

  /**
   * Confirma forma de pagamento e finaliza venda
   * @param {string} forma
   */
  function confirmarPagamento(forma) {
    if (forma === 'Fiado') {
      UIService.closeModal('modalPagamento');
      const total = CartService.getTotal();
      if (typeof FiadoService !== 'undefined') {
        FiadoService.abrirSelecaoCliente(total);
      } else {
        // Fallback sem rastreio de cliente
        CartService.setFormaPgto('Fiado');
        finalizarVenda();
      }
      return;
    }
    CartService.setFormaPgto(forma);
    UIService.closeModal('modalPagamento');
    finalizarVenda();
  }

  /**
   * Adiciona pagamento parcial ao total (suporte a múltiplas formas)
   * FIX: substituído prompt() nativo (bloqueado no Android Chrome) por Dialog.prompt()
   * @param {string} forma
   */
  async function adicionarPagamentoParcial(forma) {
    const restante = CartService.getTotal() - CartService.getTotalPagamentos();
    if (restante <= 0.009) {
      UIService.showToast('Atenção', 'Total já foi coberto pelos pagamentos', 'warning');
      return;
    }

    // Ícone por forma de pagamento
    const icones = { Dinheiro: 'fa-money-bill-wave', PIX: 'fa-qrcode', Cartão: 'fa-credit-card', Crédito: 'fa-credit-card', Débito: 'fa-credit-card' };
    const icone  = icones[forma] || 'fa-hand-holding-usd';

    const str = await Dialog.prompt({
      title:        `Valor — ${forma}`,
      message:      `Restante a cobrir: ${Utils.formatCurrency(restante)}`,
      placeholder:  restante.toFixed(2),
      defaultValue: restante.toFixed(2),
      confirmLabel: 'Adicionar',
      icon:         icone,
      iconBg:       'bg-emerald-500/15',
      iconColor:    'text-emerald-400',
    });

    if (!str) return;
    const val = parseFloat(String(str).replace(',', '.')) || 0;
    if (val <= 0) return;

    CartService.addPagamento(forma, Math.min(val, restante));
    _renderMultiPgto();

    // Se todo o total foi coberto, finaliza automaticamente
    if (CartService.getTotalPagamentos() >= CartService.getTotal() - 0.009) {
      UIService.closeModal('modalPagamento');
      finalizarVenda();
    }
  }

  /** Atualiza lista de pagamentos parciais no modal */
  function _renderMultiPgto() {
    const lista  = Utils.el('_pdvPgtosLista');
    const restEl = Utils.el('_pdvPgtoRestante');
    const wrap   = Utils.el('_pdvMultiPgtoWrap');
    if (!lista) return;
    const pgtos = CartService.getPagamentos();
    if (pgtos.length === 0) {
      if (wrap) wrap.classList.add('hidden');
      return;
    }
    if (wrap) wrap.classList.remove('hidden');
    lista.innerHTML = pgtos.map((p, i) =>
      `<div class="flex justify-between text-[9px] font-bold text-slate-300 bg-slate-900/60 rounded-lg px-3 py-1.5">
        <span>${p.forma}</span>
        <span class="text-emerald-400">${Utils.formatCurrency(p.valor)}</span>
       </div>`
    ).join('');
    const restante = CartService.getTotal() - CartService.getTotalPagamentos();
    if (restEl) restEl.textContent = `Restante: ${Utils.formatCurrency(Math.max(0, restante))}`;
  }

  /** Executa checkout com guard duplo-clique */
  function finalizarVenda() {
    const btn    = Utils.el('btnFinalizar');
    const btnMob = Utils.el('btnFinalizarMob');
    if ((btn?.disabled && btnMob?.disabled) || CartService.isEmpty()) return;

    // Verifica limite de vendas do plano SaaS
    if (window.SaasPlans && !SaasPlans.checkVendaLimit()) return;

    if (btn)    btn.disabled    = true;
    if (btnMob) btnMob.disabled = true;

    try { Utils.el('audioVenda')?.play(); } catch (_) {}

    const venda = CartService.checkout();
    if (!venda) { if (btn) btn.disabled = false; return; }

    // Registra +1 venda no contador do plano
    if (window.SaasPlans) SaasPlans.incrementVenda();

    _lastSale = venda;
    _populateRecibo(venda);
    EventBus.emit('venda:concluida', venda);
    UIService.openModal('modalVenda');
  }

  /** Preenche o recibo visual no modal */
  function _populateRecibo(venda) {
    const cfg      = Store.Selectors.getConfig();
    const nomeLoja = cfg.nome || 'PDV App';
    const _s       = (id, v) => { const el = Utils.el(id); if (el) el.textContent = v ?? ''; };
    const _t       = v => Utils.formatCurrency(v);

    _s('recNomeLoja', nomeLoja);
    _s('recId',       `#${String(venda.id).slice(-6)}`);
    _s('recTotal',    _t(venda.total));
    _s('recDataHora', `${venda.data || ''}${venda.hora ? ' · ' + venda.hora : ''}`);

    // Itens
    const itensEl = Utils.el('recItens');
    if (itensEl) {
      itensEl.innerHTML = (venda.itens || []).map(i => `
        <div class="flex justify-between items-center">
          <div class="flex items-center gap-2 min-w-0">
            <span class="text-[8px] font-black text-slate-500 bg-slate-800 px-1.5 py-0.5 rounded flex-shrink-0">${i.label === 'UNID' ? '1x' : i.label}</span>
            <span class="text-[10px] font-bold text-slate-300 truncate">${i.nome || ''}</span>
          </div>
          <span class="text-[10px] font-black text-white flex-shrink-0 ml-2">${_t(i.preco)}</span>
        </div>`).join('');
    }

    // Desconto
    const hasDesc = (venda.desconto || 0) > 0;
    const descRow  = Utils.el('recDescontoRow');
    const descValRow = Utils.el('recDescontoValRow');
    if (descRow)    descRow.classList.toggle('hidden', !hasDesc);
    if (descValRow) descValRow.classList.toggle('hidden', !hasDesc);
    if (hasDesc) {
      _s('recSubtotal', _t(venda.subtotal || venda.total));
      _s('recDesconto', `-${_t(venda.desconto)}`);
    }

    // Pagamento
    const pgtoStr = (venda.pagamentos && venda.pagamentos.length > 1)
      ? venda.pagamentos.map(p => `${p.forma}: ${_t(p.valor)}`).join(' + ')
      : (venda.formaPgto || '');
    _s('recPgto', pgtoStr ? `💳 ${pgtoStr}` : '');
  }

  function fecharModalVenda() {
    UIService.closeModal('modalVenda');
    // FIX: re-habilitar ambos os botões (desktop + mobile)
    const btn    = Utils.el('btnFinalizar');
    const btnMob = Utils.el('btnFinalizarMob');
    if (btn)    btn.disabled    = false;
    if (btnMob) btnMob.disabled = false;
  }

  /** Gera e baixa comprovante TXT */
  function baixarComprovante() {
    if (!_lastSale) return;
    let txt = `CH GELADAS — CUPOM NÃO FISCAL\n`;
    txt    += `ID: ${_lastSale.id} | Data: ${_lastSale.data}\n`;
    txt    += `${'─'.repeat(36)}\n`;
    _lastSale.itens.forEach(i => {
      txt += `${i.label === 'UNID' ? '1x' : i.label} ${i.nome} ... ${Utils.formatCurrency(i.preco)}\n`;
    });
    txt += `${'─'.repeat(36)}\n`;
    if ((_lastSale.desconto || 0) > 0) {
      txt += `Subtotal: ${Utils.formatCurrency(_lastSale.subtotal || _lastSale.total)}\n`;
      txt += `Desconto: -${Utils.formatCurrency(_lastSale.desconto)}\n`;
    }
    if ((_lastSale.pagamentos || []).length > 1) {
      txt += `Pagamentos:\n`;
      _lastSale.pagamentos.forEach(p => { txt += `  · ${p.forma}: ${Utils.formatCurrency(p.valor)}\n`; });
    } else {
      txt += `Forma de Pgto: ${_lastSale.formaPgto || '—'}\n`;
    }
    txt += `TOTAL: ${Utils.formatCurrency(_lastSale.total)}\n`;
    Utils.downloadBlob(txt, 'text/plain', `Venda_${_lastSale.id}.txt`);
  }

  /** Envia comprovante via WhatsApp */
  function enviarWhatsapp() {
    if (!_lastSale) return;
    const config = Store.Selectors.getConfig();
    if (!config.whatsapp) { UIService.showToast('Configuração', 'Configure o WhatsApp nas configurações', 'error'); return; }
    let msg = `*CH GELADAS | COMPROVANTE*\n📅 ${_lastSale.data}\n${'—'.repeat(26)}\n`;
    _lastSale.itens.forEach(i => { msg += `${i.label === 'UNID' ? '1x' : i.label} ${i.nome} ... ${Utils.formatCurrency(i.preco)}\n`; });
    msg += `${'—'.repeat(26)}\n`;
    if ((_lastSale.desconto || 0) > 0) {
      msg += `Subtotal: ${Utils.formatCurrency(_lastSale.subtotal || _lastSale.total)}\n`;
      msg += `🏷️ Desconto: -${Utils.formatCurrency(_lastSale.desconto)}\n`;
    }
    if ((_lastSale.pagamentos || []).length > 1) {
      _lastSale.pagamentos.forEach(p => { msg += `💳 ${p.forma}: ${Utils.formatCurrency(p.valor)}\n`; });
    } else if (_lastSale.formaPgto) {
      msg += `Pagamento: ${_lastSale.formaPgto}\n`;
    }
    msg += `*TOTAL: ${Utils.formatCurrency(_lastSale.total)}*\nObrigado pela preferência! 🍺`;
    Utils.openWhatsApp(config.whatsapp, msg);
    fecharModalVenda();
  }

  return Object.freeze({
    abrirPagamento, confirmarPagamento, adicionarPagamentoParcial,
    _aplicarDesconto, _renderMultiPgto,
    finalizarVenda, fecharModalVenda, baixarComprovante, enviarWhatsapp, getLastSale,
  });
})();

/* ═══════════════════════════════════════════════════════════════════
   BACKUP MANAGER — Backups locais automáticos + restauração
═══════════════════════════════════════════════════════════════════ */
const BackupManager = (() => {
  const BACKUP_KEY    = _deriveStorageKey('BACKUPS', 'CH_GELADAS_BACKUPS');
  const MAX_BACKUPS   = 7;
  let   _scheduledTimer = null;

  function _getBackups()       { return Utils.safeJsonParse(localStorage.getItem(BACKUP_KEY), []); }
  function _saveBackups(arr)   { try { localStorage.setItem(BACKUP_KEY, JSON.stringify(arr)); } catch (_) {} }

  /** Cria um ponto de restauração */
  function criarBackup(motivo = 'manual') {
    const estado = Store.getState();
    const entry  = {
      id:        Utils.generateId(),
      ts:        new Date().toISOString(),
      data:      Utils.todayISO(),
      hora:      Utils.now(),
      motivo,
      dados:     JSON.stringify(estado),
      tamanho:   Math.round(JSON.stringify(estado).length / 1024),
    };
    const backups = [entry, ..._getBackups()].slice(0, MAX_BACKUPS);
    _saveBackups(backups);
    if (motivo !== 'automatico_diario') UIService.showToast('Backup criado', `${entry.tamanho}KB salvo`);
    return entry;
  }

  /** Lista backups sem os dados (leve) */
  function listarBackups() { return _getBackups().map(b => ({ ...b, dados: undefined })); }

  /** Restaura um backup pelo ID */
  function restaurarBackup(id) {
    const b = _getBackups().find(x => x.id === id);
    if (!b) return false;
    try {
      const parsed = Utils.safeJsonParse(b.dados, null);
      if (!parsed) return false;
      Store.setState({ ...parsed, _updatedAt: Date.now() }, false);
      SyncService.persistNow();
      UIService.showToast('Backup restaurado', b.data + ' ' + b.hora);
      return true;
    } catch (e) {
      UIService.showToast('Erro', 'Falha ao restaurar', 'error');
      return false;
    }
  }

  /** Download do estado atual como JSON */
  function downloadBackup() {
    const json = JSON.stringify(Store.getState(), null, 2);
    Utils.downloadBlob(json, 'application/json', `CH_Geladas_Backup_${Utils.todayISO()}.json`);
    UIService.showToast('Download', 'Backup baixado');
  }

  /** Agenda backup automático diário às 02:00 */
  function _agendarProximo() {
    const agora = new Date();
    const alvo  = new Date();
    alvo.setHours(2, 0, 0, 0);
    if (alvo <= agora) alvo.setDate(alvo.getDate() + 1);
    const delay = alvo.getTime() - agora.getTime();
    clearTimeout(_scheduledTimer);
    _scheduledTimer = setTimeout(() => { criarBackup('automatico_diario'); _agendarProximo(); }, delay);
  }

  function init() {
    _agendarProximo();
    // Backup catching-up: se passou das 2h e ainda não tem backup de hoje
    EventBus.on('auth:login', () => {
      const hoje = Utils.todayISO();
      const temHoje = _getBackups().some(b => b.ts.startsWith(hoje) && b.motivo === 'automatico_diario');
      if (!temHoje && new Date().getHours() >= 2) criarBackup('automatico_diario');
    });
  }

  return Object.freeze({ criarBackup, listarBackups, restaurarBackup, downloadBackup, init });
})();

/* ═══════════════════════════════════════════════════════════════════
   SESSION MANAGER — Timeout automático de sessão
═══════════════════════════════════════════════════════════════════ */
const SessionManager = (() => {
  const DEFAULT_TIMEOUT_MIN  = 30;
  const WARNING_BEFORE_MIN   = 5;
  let _timeoutTimer   = null;
  let _warningTimer   = null;
  let _warnShown      = false;

  function _getTimeoutMs() {
    const cfg = Store.Selectors.getConfig();
    return ((cfg.sessionTimeoutMinutes ?? DEFAULT_TIMEOUT_MIN) * 60_000);
  }

  /** Renova o timer de sessão (chamado em qualquer atividade) */
  function renovar() {
    if (!AuthService.isLogged()) return;
    _warnShown = false;
    _esconderAviso();
    clearTimeout(_timeoutTimer);
    clearTimeout(_warningTimer);

    const total   = _getTimeoutMs();
    const warnAt  = total - WARNING_BEFORE_MIN * 60_000;

    if (warnAt > 0) {
      _warningTimer = setTimeout(() => {
        if (!_warnShown) { _warnShown = true; _mostrarAviso(); }
      }, warnAt);
    }

    _timeoutTimer = setTimeout(() => {
      if (AuthService.isLogged()) {
        AuthService.logout();
        UIService.showToast('Sessão expirada', 'Entre novamente', 'warning');
        EventBus.emit('session:expired');
      }
    }, total);
  }

  function _mostrarAviso() {
    let el = Utils.el('sessionWarning');
    if (!el) {
      el = document.createElement('div');
      el.id = 'sessionWarning';
      el.style.cssText = 'position:fixed;top:env(safe-area-inset-top,0px);left:50%;transform:translateX(-50%);' +
        'background:#fef3c7;border:1px solid #f59e0b;color:#92400e;font-size:12px;padding:8px 16px;' +
        'border-radius:12px;z-index:9999;white-space:nowrap;font-weight:700;cursor:pointer;';
      el.innerHTML = '⚠️ Sessão expira em 5 min — <strong>Toque para continuar</strong>';
      el.addEventListener('click', () => { renovar(); UIService.showToast('Sessão renovada', ''); });
      document.body.appendChild(el);
    }
    el.style.display = 'block';
    EventBus.emit('session:timeout-warning', { minutosRestantes: WARNING_BEFORE_MIN });
  }

  function _esconderAviso() {
    const el = Utils.el('sessionWarning');
    if (el) el.style.display = 'none';
  }

  /** Inicia rastreamento de atividade do usuário */
  function init() {
    ['click','keydown','touchstart','mousemove','scroll'].forEach(ev => {
      document.addEventListener(ev, () => { if (AuthService.isLogged()) renovar(); }, { passive: true });
    });
    // Renova ao voltar à aba
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && AuthService.isLogged()) renovar();
    });
  }

  return Object.freeze({ renovar, init });
})();

/* ═══════════════════════════════════════════════════════════════════
   BOOTSTRAP — Inicialização da aplicação
═══════════════════════════════════════════════════════════════════ */
const Bootstrap = (() => {
  /**
   * Ponto de entrada. Chamado pelo sync.js após restaurar dados remotos.
   */
  function init() {
    UIService.hideLoader();

    // Aplica identidade visual da loja (tema, logo) o mais cedo possível
    _initLojaIdentidade();

    if (!AuthService.isLogged()) {
      UIService.showLock();
    }

    // Carrega estado do localStorage
    const savedData = SyncService.load();
    if (savedData) {
      Store.setState(savedData, true);
    }

    // Inicializa UI
    const invInput = Utils.el('invInput');
    if (invInput) invInput.value = Store.Selectors.getInvestimento() || 0;

    const zapNum = Utils.el('zapNum');
    if (zapNum) zapNum.value = Store.Selectors.getConfig().whatsapp || '';

    // Modo cardápio público (URL hash #pedido)
    if (window.location.hash === '#pedido') {
      UIService.hideLoader();
      if (typeof iniciarPublicOrder === 'function') iniciarPublicOrder();
    }
  }

  /**
   * Finaliza login e inicializa interface completa
   * @param {'admin'|'pdv'} role
   */
  function onLoginSuccess(role) {
    UIService.showApp();
    UIService.showToast('Sessão Iniciada', role === 'admin' ? 'Acesso Total' : 'Modo Colaborador');
    SessionManager.renovar(); // inicia timer de sessão

    // Avisa se admin está a usar o PIN padrão fraco
    if (role === 'admin') {
      setTimeout(() => {
        UIService.showToast('Segurança', 'PIN padrão detectado — considere alterar nas configurações', 'warning');
      }, 2500);
    }

    // Alerta de caixa fechado — obrigatório para PDV
    setTimeout(() => {
      if (!Store.Selectors.isCaixaOpen()) {
        const banner = Utils.el('caixaFechadoBanner');
        if (banner) {
          banner.classList.remove('hidden');
          banner.classList.add('flex');
        }
        if (role !== 'admin') {
          UIService.showToast('Atenção', 'Abra o caixa antes de vender', 'warning');
        }
      }
    }, 600);

    UIService.startClock();
    UIService.refreshAlerts();

    // NOTA: o estado já foi carregado em Bootstrap.init() antes do login.
    // Não recarregamos aqui para evitar sobrescrever um sync remoto que possa
    // ter ocorrido entre init() e o momento do login.

    // Aplica identidade visual (pode ter sido sobrescrita antes do login)
    _initLojaIdentidade();

    // Renderiza módulos iniciais
    const _nomeCfg = Store.Selectors.getConfig()?.nome;
    if (_nomeCfg) document.title = _nomeCfg;
    RenderService.renderCatFilter();
    RenderService.renderCatalogo();
    RenderService.renderTurboMode();
    RenderService.renderCarrinho();
    if (typeof renderEstoque    === 'function') renderEstoque();
    if (typeof renderPonto      === 'function') renderPonto();
    if (typeof renderFinanceiro === 'function') renderFinanceiro();
    if (typeof CaixaTurnoService !== 'undefined') CaixaTurnoService.renderTurnoAtual();
    if (typeof renderDelivery   === 'function') renderDelivery();
    if (typeof renderComandas   === 'function') renderComandas();
    if (typeof renderFluxo      === 'function') renderFluxo();
    if (typeof renderFiado      === 'function') renderFiado();
    if (typeof populateMpZonas       === 'function') populateMpZonas();
    if (typeof populateMpEntregadores === 'function') populateMpEntregadores();

    RenderService.updateStats();
  }

  /**
   * Registra listeners globais de eventos
   */
  function _registerEventListeners() {
    // Reativa renders quando o estado muda via sync remoto
    EventBus.on('sync:remote-applied', () => {
      RenderService.renderCatalogo();
      RenderService.updateStats();
      // Fluxo e IA não têm módulo próprio com listener — actualiza se ativo
      const _tab = id => !!Utils.el(`tab-${id}`)?.classList.contains('active');
      if (_tab('fluxo')  && typeof renderFluxo === 'function') renderFluxo();
      if (_tab('ia')     && typeof renderIA    === 'function') renderIA();
    });

    // FIX: auth:logout → trava a UI imediatamente (lock screen + limpa classes de role)
    EventBus.on('auth:logout', () => {
      document.body.classList.remove('is-admin', 'is-pdv');
      UIService.showLock();
    });

    // FIX: state:reset → re-renderiza catálogo e stats após reset total de dados
    EventBus.on('state:reset', () => {
      RenderService.renderCatalogo();
      RenderService.updateStats();
    });

    // FIX: sync:error → toast não intrusivo para notificar falha de backup
    EventBus.on('sync:error', (err) => {
      const msg = err?.message || 'Verifique a conexão';
      UIService.showToast('Sync falhou', msg, 'error');
    });

    // Atualiza aviso do PDV quando caixa ou ponto muda
    EventBus.on('caixa:aberto',     () => {
      RenderService.renderCatalogo();
      const banner = Utils.el('caixaFechadoBanner');
      if (banner) { banner.classList.add('hidden'); banner.classList.remove('flex'); }
    });
    EventBus.on('caixa:fechado',    () => RenderService.renderCatalogo());
    EventBus.on('ponto:registered', () => RenderService.renderCatalogo());

    // Renderiza carrinho sempre que muda
    EventBus.on('cart:item-added',   () => RenderService.renderCarrinho());
    EventBus.on('cart:item-removed', () => RenderService.renderCarrinho());
    EventBus.on('cart:cleared',      () => RenderService.renderCarrinho());
    EventBus.on('cart:checkout',     () => { RenderService.updateStats(); RenderService.renderTurboMode(); });

    // Float-cart bounce ao adicionar item
    EventBus.on('cart:item-added', () => {
      const fl = Utils.el('float-cart');
      if (fl) {
        fl.style.transform = 'scale(1.08)';
        setTimeout(() => { fl.style.transform = 'scale(1)'; }, 200);
      }
    });

    // Hash change para cardápio público
    window.addEventListener('hashchange', () => {
      if (window.location.hash === '#pedido') {
        if (Utils.el('app')?.style.display !== 'none') {
          if (typeof iniciarPublicOrder === 'function') iniciarPublicOrder();
        }
      }
    });

    // Modais: fecha no backdrop e ESC
    UIService._initModalBackdropClose();
  }

  function start() {
    _registerEventListeners();
    BackupManager.init();
    SessionManager.init();

    // Captura CH_INIT ANTES de definir o wrapper, para evitar referência circular.
    const _originalCHInit = window.CH_INIT;

    // Fallback de segurança: se sync.js não chamar CH_INIT em SYNC_FALLBACK_MS,
    // o app inicializa em modo offline para não travar o utilizador.
    let _initDispatched = false; // garante que Bootstrap.init() roda no máximo UMA VEZ

    window.CH_INIT = function () {
      if (_initDispatched) {
        console.warn('[Bootstrap] CH_INIT chamado mais de uma vez — ignorado');
        return;
      }
      _initDispatched = true;
      _originalCHInit?.();
    };

    setTimeout(() => {
      if (_initDispatched) return; // já inicializado pelo sync.js — não faz nada
      const loader = Utils.el('app-loader');
      const loaderAindaAtivo = loader && !loader.classList.contains('hide');
      if (loaderAindaAtivo) {
        console.warn('[Bootstrap] Fallback offline ativado — sync.js não chamou CH_INIT a tempo');
        Bootstrap.init(); // chama diretamente (não via window.CH_INIT para não marcar _initDispatched antes)
        _initDispatched = true;
      }
    }, CONSTANTS.SYNC_FALLBACK_MS);
  }

  return Object.freeze({ init, onLoginSuccess, start });
})();

/* ═══════════════════════════════════════════════════════════════════
   WINDOW BRIDGES — API pública para sync.js e HTML inline
═══════════════════════════════════════════════════════════════════ */

/** Chamado pelo sync.js após restaurar dados */
window.CH_INIT = Bootstrap.init;

/** Chamado pelo sync.js ao receber snapshot do Firestore */
window.CH_SAFE_SYNC = SyncService.applyRemoteSync;

/** Flag de lock de sync para sync.js */
Object.defineProperty(window, 'CH_SYNC_LOCK', {
  get: () => SyncService._isSyncLocked ?? false,
  configurable: true,
});

/* ── Funções globais mantidas para compatibilidade com HTML inline ── */

/** @deprecated Use TabManager.switchTab */
function switchTab(id)           { TabManager.switchTab(id); }

/** @deprecated Use UIService.openModal */
function openModal(id)           { UIService.openModal(id); }

/** @deprecated Use UIService.closeModal */
function closeModal(id)          { UIService.closeModal(id); }

/** @deprecated Use UIService.showToast */
function showToast(msg, sub, type) { UIService.showToast(msg, sub, type); }

/** @deprecated Use Utils.downloadBlob */
function dlBlob(c, m, f)        { Utils.downloadBlob(c, m, f); }

/** @deprecated Use RenderService.renderCatalogo */
function renderCatalogo()        { RenderService.renderCatalogo(); }

/** @deprecated Use RenderService.updateStats */
function updateStats()           { RenderService.updateStats(); }

/** Adiciona item ao carrinho — chamado por onclick nos cards */
function addCart(prodId, packIdx, btnEl) { CartService.addItem(prodId, packIdx, btnEl); }

function removerCart(i)          { CartService.removeItem(i); }

async function limparCarrinho() {
  try {
    if (CartService.isEmpty()) return;
    const count = CartService.getCount();
    const ok = await Dialog.confirm({
      title:        'Limpar carrinho',
      message:      `Remover ${count} ${count === 1 ? 'item' : 'itens'} do carrinho?`,
      icon:         'fa-trash',
      iconBg:       'bg-red-500/15',
      iconColor:    'text-red-400',
      confirmLabel: 'Limpar',
      confirmCls:   'bg-red-600 hover:bg-red-500 text-white',
      danger:       true,
    });
    if (!ok) return;
    CartService.clear();
    UIService.showToast('Carrinho', 'Limpo', 'warning');
  } catch (err) { console.error('[limparCarrinho]', err); }
}

function abrirDrawer() {
  const drawer = Utils.el('carrinhoDrawer');
  const bg     = Utils.el('drawerBg');
  const panel  = Utils.el('drawerPanel');
  if (!drawer) return;
  drawer.style.visibility    = 'visible';
  drawer.style.pointerEvents = 'auto';
  requestAnimationFrame(() => {
    if (bg)    bg.style.opacity        = '1';
    if (panel) panel.style.transform   = 'translateY(0)';
  });
}

function fecharDrawer() {
  const drawer = Utils.el('carrinhoDrawer');
  const bg     = Utils.el('drawerBg');
  const panel  = Utils.el('drawerPanel');
  if (!drawer) return;
  if (bg)    bg.style.opacity      = '0';
  if (panel) panel.style.transform = 'translateY(100%)';
  setTimeout(() => {
    drawer.style.visibility    = 'hidden';
    drawer.style.pointerEvents = 'none';
  }, 320);
}

function abrirPagamento()              { VendaService.abrirPagamento(); }
function confirmarPagamento(f)         { VendaService.confirmarPagamento(f); }
function adicionarPagamentoParcial(f)  { VendaService.adicionarPagamentoParcial(f); }
function _pdvAplicarDesconto()         { VendaService._aplicarDesconto(); }
function finalizarVenda()              { VendaService.finalizarVenda(); }
function fecharModalVenda()            { VendaService.fecharModalVenda(); }
function baixarTxt()                   { VendaService.baixarComprovante(); }
function enviarWhatsapp()              { VendaService.enviarWhatsapp(); }

/**
 * Pagamento rápido — finaliza venda em 1 toque sem abrir modal.
 * Usado pelos botões Dinheiro / Pix / Cartão no carrinho.
 * @param {'Dinheiro'|'Pix'|'Cartão'} forma
 */
function quickPay(forma) {
  if (CartService.isEmpty()) return;

  const bloqueio = _getPdvBloqueio();
  if (bloqueio) {
    UIService.showToast('Acesso Bloqueado', bloqueio, 'error');
    TabManager.switchTab('ponto');
    return;
  }

  CartService.setFormaPgto(forma);
  VendaService.finalizarVenda();
}

/** Copia recibo formatado para o clipboard */
async function copiarRecibo() {
  const v = VendaService.getLastSale();
  if (!v) return;
  const cfg      = Store.Selectors.getConfig();
  const nomeLoja = cfg.nome || 'PDV App';
  const fmt      = val => Utils.formatCurrency(val);
  const SEP      = '─'.repeat(28);

  let txt = `🧾 *${nomeLoja}*\n`;
  txt    += `📅 ${v.data || ''}${v.hora ? ' · ' + v.hora : ''}\n`;
  txt    += `${SEP}\n`;
  (v.itens || []).forEach(i => {
    const qt = i.label === 'UNID' ? '1x' : i.label;
    txt += `${qt} ${i.nome} · ${fmt(i.preco)}\n`;
  });
  txt += `${SEP}\n`;
  if ((v.desconto || 0) > 0) {
    txt += `Subtotal: ${fmt(v.subtotal || v.total)}\n`;
    txt += `🏷️ Desconto: -${fmt(v.desconto)}\n`;
  }
  if ((v.pagamentos || []).length > 1) {
    v.pagamentos.forEach(p => { txt += `💳 ${p.forma}: ${fmt(p.valor)}\n`; });
  } else if (v.formaPgto) {
    txt += `💳 ${v.formaPgto}\n`;
  }
  txt += `*TOTAL: ${fmt(v.total)}*\n`;
  txt += `${SEP}\n`;
  txt += `#${String(v.id).slice(-6)} · Obrigado! 🍺`;

  try {
    await navigator.clipboard.writeText(txt);
    UIService.showToast('Copiado!', 'Recibo copiado para o clipboard', 'success');
  } catch {
    // Fallback para devices sem clipboard API
    const ta = document.createElement('textarea');
    ta.value = txt;
    ta.style.position = 'fixed';
    ta.style.opacity  = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    UIService.showToast('Copiado!', 'Recibo copiado', 'success');
  }
}

function salvarZap() {
  const raw = Utils.el('zapNum')?.value || '';
  Store.mutate(state => { state.config.whatsapp = raw.replace(/\D/g, ''); }, true);
  SyncService.persist();
  UIService.closeModal('modalZap');
  UIService.showToast('WhatsApp', 'Número salvo');
}

/** Login assíncrono com PIN */
async function doLogin() {
  const pin = Utils.el('pinInput')?.value || '';
  const success = await AuthService.login(pin);
  if (success) Bootstrap.onLoginSuccess(AuthService.getRole());
}

/**
 * Auto-login chamado a cada keystroke.
 * Só dispara quando o comprimento do PIN é inequívoco:
 *  - 3 dígitos → pode ser admin (001) → só tenta se NENHUM PIN maior for possível.
 *    Para evitar consumir tentativas enquanto o PDV ainda digita, usamos um delay
 *    cancelável: se o utilizador continuar digitando, o auto-login é abortado.
 */
let _checkPinTimer = null;
function checkPin(val) {
  clearTimeout(_checkPinTimer);
  const len = String(val).trim().length;

  // PIN de 5 dígitos: tenta imediatamente (comprimento final do PIN PDV)
  if (len === 5 || len === 6) {
    doLogin();
    return;
  }

  // PIN de 3 dígitos: aguarda 600ms para ver se o utilizador continua a digitar.
  // Isso evita consumir tentativas de quem está a digitar o PIN de 5 dígitos.
  if (len === 3) {
    _checkPinTimer = setTimeout(() => {
      // Verifica novamente o comprimento actual (pode ter mudado)
      const currentLen = String(Utils.el('pinInput')?.value || '').trim().length;
      if (currentLen === 3) doLogin();
    }, 600);
  }
}




function verificarAlertas()      { UIService.refreshAlerts(); }

/** Salva estado — bridge para módulos externos */
function save() { SyncService.persist(); }

/** Referência legada ao db — somente leitura para prevenir sobrescrita do estado via console */
Object.defineProperty(window, 'db', {
  get: () => Store.getState(),
  // setter removido intencionalmente (LOW-07): expor setter permite que qualquer
  // script ou extensão do browser sobrescreva todo o estado com db = {}.
  // Use Store.setState() ou Store.mutate() nos módulos internos.
  configurable: true,
});

/** Referência legada a isAdmin */
Object.defineProperty(window, 'isAdmin', {
  get: () => AuthService.isAdmin(),
  configurable: true,
});

/** Referência legada a lastSale */
Object.defineProperty(window, 'lastSale', {
  get: () => VendaService.getLastSale(),
  configurable: true,
});

/* ── Bridge global setCatFilter e setCatalogMode ─────────────────── */
function setCatFilter(cat)       { RenderService.setCatFilter(cat); }
function setCatalogMode(mode)    { RenderService.setCatalogMode(mode); }

/* ── Configurações ──────────────────────────────────────────────── */

/** Abre o modal de configurações e preenche todos os campos */
function abrirConfig() {
  const cfg = Store.Selectors.getConfig();
  const el  = id => Utils.el(id);
  if (el('cfgNome'))           el('cfgNome').value           = cfg.nome || '';
  if (el('cfgAlerta'))         el('cfgAlerta').value         = cfg.alertaStock ?? 3;
  if (el('cfgTgToken'))        el('cfgTgToken').value        = cfg.telegram?.token  || '';
  if (el('cfgTgChatId'))       el('cfgTgChatId').value       = cfg.telegram?.chatId || '';
  if (el('cfgPinAdm'))         el('cfgPinAdm').value         = '';
  if (el('cfgPinColab'))       el('cfgPinColab').value       = '';
  if (el('cfgApiKey'))         el('cfgApiKey').value         = cfg.anthropicApiKey  || '';
  if (el('cfgWhatsappAdm'))    el('cfgWhatsappAdm').value    = cfg.whatsapp              || '';
  if (el('cfgWhatsappColab'))  el('cfgWhatsappColab').value  = cfg.whatsappColaborador   || '';
  if (el('cfgSessionTimeout')) el('cfgSessionTimeout').value = cfg.sessionTimeoutMinutes ?? 30;
  // Toggle som
  const somAtivo = cfg.somNotificacoes !== false;
  const btn = el('cfgSomBtn'); const dot = el('cfgSomDot');
  if (btn) btn.className = `relative w-11 h-6 rounded-full transition-all flex-shrink-0 ${somAtivo ? 'bg-blue-600' : 'bg-slate-700'}`;
  if (dot) dot.className = `absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${somAtivo ? 'translate-x-5' : 'translate-x-0.5'}`;
  if (el('cfgSecAdmTool')) el('cfgSecAdmTool').classList.toggle('hidden', !AuthService.isAdmin());
  _renderCfgCategorias();

  // ── Identidade Visual ──────────────────────────────────────
  const loja = _getLojaConfig();
  const corEl = el('cfgCorPrimaria');
  if (corEl) corEl.value = loja.corPrimaria || '#3b82f6';
  const logoPreview = el('cfgLogoPreview');
  if (logoPreview) {
    const nomeCfg = cfg.nome || loja.nome || 'CH';
    const corCfg  = loja.corPrimaria || '#3b82f6';
    const src     = loja.logoBase64 || _gerarAvatarSVG(nomeCfg, corCfg);
    logoPreview.innerHTML = `<img src="${src}" style="width:100%;height:100%;object-fit:contain;border-radius:10px;">`;
  }
  window._cfgLogoTemp = undefined;

  // ── Firebase + Export/Import (só ADM) ─────────────────────
  const isAdm = AuthService.isAdmin();
  const fbSec = el('cfgSecFirebase');
  if (fbSec) fbSec.classList.toggle('hidden', !isAdm);
  const expSec = el('cfgSecExportImport');
  if (expSec) expSec.classList.toggle('hidden', !isAdm);

  if (isAdm) {
    const ta = el('cfgFirebaseJson');
    if (ta) ta.value = loja.firebase ? JSON.stringify(loja.firebase, null, 2) : '';
    const colEl = el('cfgFirestoreCollection');
    if (colEl) { colEl.value = loja.firestoreCollection || 'ch_geladas'; delete colEl.dataset.userEdited; }
    const docEl = el('cfgFirestoreDocId');
    if (docEl) docEl.value = loja.firestoreDocId || 'sistema';
    const statusEl = el('cfgFirebaseJsonStatus');
    if (statusEl) statusEl.classList.add('hidden');
  }

  UIService.openModal('modalConfig');
}

/** Renderiza lista de categorias dentro do modal */
function _renderCfgCategorias() {
  const list = Utils.el('cfgCatList');
  if (!list) return;
  const cats = Store.Selectors.getConfig()?.categorias || [];
  if (cats.length === 0) {
    list.innerHTML = '<p class="text-[10px] text-slate-600 text-center py-3">Nenhuma categoria ainda.</p>';
    return;
  }
  list.innerHTML = cats.map((c, i) => `
    <div class="flex items-center justify-between bg-slate-800/60 border border-white/5 rounded-xl px-4 py-2.5">
      <span class="text-[11px] font-black text-slate-300 uppercase tracking-wide">${c}</span>
      <button onclick="removeCfgCategoria(${i})" class="text-red-400 hover:text-red-300 text-xs ml-3 transition-colors" aria-label="Remover ${c}"><i class="fas fa-trash"></i></button>
    </div>`).join('');
}

/** Adiciona nova categoria ao store (salva só ao guardar config) */
function addCfgCategoria() {
  const inp = Utils.el('cfgCatNova');
  const val = (inp?.value || '').trim();
  if (!val) return;
  const cfg  = Store.Selectors.getConfig();
  const cats = [...(cfg.categorias || [])];
  if (cats.map(c => c.toLowerCase()).includes(val.toLowerCase())) {
    UIService.showToast('Categoria duplicada', val, 'warning'); return;
  }
  cats.push(val);
  // FIX: mutate deve receber função, não objeto — objeto era ignorado silenciosamente
  Store.mutate(state => { state.config = { ...cfg, categorias: cats }; });
  if (inp) inp.value = '';
  _renderCfgCategorias();
}

/** Remove categoria por índice */
function removeCfgCategoria(idx) {
  const cfg  = Store.Selectors.getConfig();
  const cats = [...(cfg.categorias || [])];
  cats.splice(idx, 1);
  // FIX: mutate deve receber função, não objeto
  Store.mutate(state => { state.config = { ...cfg, categorias: cats }; });
  _renderCfgCategorias();
}

/** Guarda todas as configurações */
async function salvarConfig() {
  const cfg    = { ...Store.Selectors.getConfig() };
  const nome   = (Utils.el('cfgNome')?.value         || '').trim();
  const alerta = parseInt(Utils.el('cfgAlerta')?.value) || 3;
  const tgTok  = (Utils.el('cfgTgToken')?.value       || '').trim();
  const tgCid  = (Utils.el('cfgTgChatId')?.value      || '').trim();
  const pinA   = (Utils.el('cfgPinAdm')?.value         || '').trim();
  const pinC   = (Utils.el('cfgPinColab')?.value       || '').trim();
  const apiKey = (Utils.el('cfgApiKey')?.value         || '').trim();
  const zapAdm  = (Utils.el('cfgWhatsappAdm')?.value   || '').replace(/\D/g, '');
  const zapColab = (Utils.el('cfgWhatsappColab')?.value || '').replace(/\D/g, '');
  const sessionTimeout = parseInt(Utils.el('cfgSessionTimeout')?.value) || 30;
  // Som: lê do estado atual do botão (toggle não tem input)
  const somAtivo = Utils.el('cfgSomBtn')?.classList.contains('bg-blue-600') !== false;

  // Validação dos PINs
  if (pinA && pinA.length < 3) { UIService.showToast('PIN inválido', 'PIN Administrador precisa de mínimo 3 dígitos', 'error'); return; }
  if (pinC && pinC.length < 3) { UIService.showToast('PIN inválido', 'PIN Colaborador precisa de mínimo 3 dígitos', 'error'); return; }

  cfg.nome                   = nome;
  cfg.alertaStock            = alerta;
  cfg.telegram               = { token: tgTok, chatId: tgCid };
  cfg.sessionTimeoutMinutes  = Math.max(5, Math.min(480, sessionTimeout));
  cfg.somNotificacoes        = somAtivo;
  if (apiKey)  cfg.anthropicApiKey     = apiKey;
  if (zapAdm)  cfg.whatsapp            = zapAdm;
  if (zapColab) cfg.whatsappColaborador = zapColab;
  if (pinA) cfg.pinHashAdmin = await CryptoService.sha256(pinA);
  if (pinC) cfg.pinHashPdv   = await CryptoService.sha256(pinC);

  // FIX: mutate deve receber função, não objeto — objeto era ignorado silenciosamente
  Store.mutate(state => { state.config = { ...cfg }; });
  SyncService.persist();

  // ── Salvar identidade visual e Firebase em LOJA_CONFIG ────
  const loja = _getLojaConfig();
  loja.nome = nome;
  const corPrimaria = (Utils.el('cfgCorPrimaria')?.value || '').trim();
  if (corPrimaria) loja.corPrimaria = corPrimaria;

  // Logo (undefined = sem alteração, '' = remover, string = novo logo)
  if (window._cfgLogoTemp !== undefined) {
    loja.logoBase64 = window._cfgLogoTemp || null;
  }

  // Firebase (só ADM, só se preenchido)
  if (AuthService.isAdmin()) {
    const jsonStr = (Utils.el('cfgFirebaseJson')?.value || '').trim();
    if (jsonStr) {
      try {
        const fbCfg = JSON.parse(jsonStr);
        if (fbCfg.apiKey && fbCfg.projectId) {
          loja.firebase = fbCfg;
          loja.firestoreCollection = (Utils.el('cfgFirestoreCollection')?.value || '').trim() || 'ch_geladas';
          loja.firestoreDocId      = (Utils.el('cfgFirestoreDocId')?.value      || '').trim() || 'sistema';
        }
      } catch (e) { /* JSON inválido — utilizador não preencheu */ }
    } else if (jsonStr === '') {
      // Campo apagado → remover config personalizada
      delete loja.firebase;
      delete loja.firestoreCollection;
      delete loja.firestoreDocId;
    }
  }

  _saveLojaConfig(loja);

  // Aplica tema e logos imediatamente
  if (corPrimaria) aplicarTema(corPrimaria);
  _atualizarLogos(loja.logoBase64 || null, loja.nome, corPrimaria || '#3b82f6');

  if (nome) document.title = nome;
  RenderService.renderCatFilter();
  RenderService.renderCatalogo();
  UIService.refreshAlerts();
  UIService.closeModal('modalConfig');
  UIService.showToast('Configurações guardadas', nome || '✓', 'success');
}

/** Envia mensagem de teste ao bot Telegram */
async function testarTelegram() {
  const token  = (Utils.el('cfgTgToken')?.value  || '').trim();
  const chatId = (Utils.el('cfgTgChatId')?.value || '').trim();
  if (!token || !chatId) { UIService.showToast('Preencha Token e Chat ID', '', 'warning'); return; }
  try {
    const res  = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: `✅ ${Store.Selectors.getConfig()?.nome || 'PDV'} — notificações Telegram activas!` })
    });
    const data = await res.json();
    if (data.ok) UIService.showToast('Telegram OK!', 'Mensagem enviada com sucesso', 'success');
    else         UIService.showToast('Erro Telegram', data.description || 'Verifique token/chatId', 'error');
  } catch (e) {
    UIService.showToast('Erro de rede', e.message, 'error');
  }
}

/* ══════════════════════════════════════════════════════════════════
   LOJA CONFIG — Identidade Visual, Tema, Firebase, Export/Import
══════════════════════════════════════════════════════════════════ */

/** Lê a configuração da loja */
function _getLojaConfig() {
  try { return JSON.parse(localStorage.getItem('LOJA_CONFIG') || '{}'); }
  catch (e) { return {}; }
}

/** Persiste a configuração da loja */
function _saveLojaConfig(cfg) {
  localStorage.setItem('LOJA_CONFIG', JSON.stringify(cfg));
}

/** Gera SVG de avatar com iniciais da empresa */
function _gerarAvatarSVG(nome, cor) {
  const iniciais = (nome || 'CH')
    .split(/\s+/).filter(Boolean).slice(0, 2)
    .map(w => w[0].toUpperCase()).join('') || '?';
  const c = cor || '#3b82f6';
  const r = parseInt(c.slice(1,3), 16);
  const g = parseInt(c.slice(3,5), 16);
  const b = parseInt(c.slice(5,7), 16);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="22" fill="rgba(${r},${g},${b},0.15)"/>
    <rect width="100" height="100" rx="22" fill="none" stroke="rgba(${r},${g},${b},0.4)" stroke-width="2"/>
    <text x="50" y="50" text-anchor="middle" dominant-baseline="central"
      font-family="system-ui,sans-serif" font-weight="900"
      font-size="${iniciais.length > 1 ? 38 : 44}" fill="${c}">${iniciais}</text>
  </svg>`;
  return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
}

/** Aplica cor primária via CSS variables — afeta nav, botões, badges */
function aplicarTema(cor) {
  if (!cor || !/^#[0-9a-fA-F]{6}$/.test(cor)) return;
  const r = parseInt(cor.slice(1,3), 16);
  const g = parseInt(cor.slice(3,5), 16);
  const b = parseInt(cor.slice(5,7), 16);

  let style = document.getElementById('ch-tema-style');
  if (!style) {
    style = document.createElement('style');
    style.id = 'ch-tema-style';
    document.head.appendChild(style);
  }
  style.textContent = `
    :root { --ch-primary: ${cor}; --ch-primary-rgb: ${r},${g},${b}; }
    .nav-btn.active { color: ${cor} !important; border-bottom-color: ${cor} !important; background: rgba(${r},${g},${b},.06) !important; }
    .fin-tab.active { color: ${cor} !important; border-bottom-color: ${cor} !important; background: rgba(${r},${g},${b},.07) !important; }
    .label { color: ${cor} !important; }
    .bg-blue-600 { background-color: ${cor} !important; }
    .hover\\:bg-blue-500:hover { background-color: ${cor}dd !important; }
    .text-blue-400 { color: ${cor} !important; }
    .text-blue-300 { color: ${cor}bb !important; }
    .border-blue-500\\/20, .border-blue-500\\/30 { border-color: rgba(${r},${g},${b},.25) !important; }
    .bg-blue-500\\/10, .bg-blue-600\\/10 { background: rgba(${r},${g},${b},.10) !important; }
    .bg-blue-500\\/8, .bg-blue-600\\/8 { background: rgba(${r},${g},${b},.08) !important; }
    .badge.b-blue { background: rgba(${r},${g},${b},.18) !important; color: ${cor} !important; border-color: rgba(${r},${g},${b},.3) !important; }
    #syncDot { background: ${cor} !important; }
  `;
}

/** Atualiza todos os slots de logo no app */
function _atualizarLogos(logoSrc, nomeLoja, corPrimaria) {
  const src = logoSrc || _gerarAvatarSVG(nomeLoja, corPrimaria);
  ['chLogoHeader', 'chLogoLogin', 'chLogoLoading'].forEach(id => {
    const wrap = document.getElementById(id);
    if (!wrap) return;
    const img = wrap.querySelector('img');
    if (img) { img.src = src; img.alt = nomeLoja || 'Logo'; }
  });
}

/** Aplica identidade visual no arranque do app */
function _initLojaIdentidade() {
  const loja = _getLojaConfig();
  const nome = loja.nome || Store.Selectors.getConfig()?.nome || 'PDV App';
  if (loja.corPrimaria) aplicarTema(loja.corPrimaria);
  _atualizarLogos(loja.logoBase64 || null, nome, loja.corPrimaria || '#3b82f6');
  // Atualiza title e meta-title dinamicamente
  document.title = nome;
  const metaTitle = document.querySelector('meta[name="apple-mobile-web-app-title"]');
  if (metaTitle) metaTitle.setAttribute('content', nome);
}

/* ── Cfg: Logo ──────────────────────────────────────────────────── */
function cfgLogoUpload(input) {
  const file = input?.files?.[0];
  if (!file) return;
  if (file.size > 600 * 1024) {
    UIService.showToast('Imagem muito grande', 'Máximo 600 KB', 'error'); return;
  }
  const reader = new FileReader();
  reader.onload = e => {
    const src = e.target.result;
    const preview = Utils.el('cfgLogoPreview');
    if (preview) preview.innerHTML = `<img src="${src}" style="width:100%;height:100%;object-fit:contain;border-radius:10px;">`;
    window._cfgLogoTemp = src;
    UIService.showToast('Logo carregado', 'Clique em Guardar para confirmar', 'success');
  };
  reader.readAsDataURL(file);
}

function cfgLogoRemover() {
  window._cfgLogoTemp = '';
  const loja = _getLojaConfig();
  const nome = (Utils.el('cfgNome')?.value || loja.nome || 'CH').trim();
  const cor  = Utils.el('cfgCorPrimaria')?.value || loja.corPrimaria || '#3b82f6';
  const preview = Utils.el('cfgLogoPreview');
  if (preview) preview.innerHTML = `<img src="${_gerarAvatarSVG(nome, cor)}" style="width:100%;height:100%;object-fit:contain;">`;
}

/* ── Cfg: Tema / Cor ────────────────────────────────────────────── */
function cfgPreviewCor(cor) {
  if (!cor) return;
  aplicarTema(cor);
  // Actualiza avatar se não há logo personalizado
  const loja = _getLojaConfig();
  if (!loja.logoBase64 && !window._cfgLogoTemp) {
    const nome = (Utils.el('cfgNome')?.value || loja.nome || 'CH').trim();
    const preview = Utils.el('cfgLogoPreview');
    if (preview) preview.innerHTML = `<img src="${_gerarAvatarSVG(nome, cor)}" style="width:100%;height:100%;object-fit:contain;">`;
  }
}

function cfgSetCor(cor) {
  const inp = Utils.el('cfgCorPrimaria');
  if (inp) inp.value = cor;
  cfgPreviewCor(cor);
}

/* ── Cfg: Firebase ──────────────────────────────────────────────── */

/** Auto-sugere nome da coleção a partir do projectId */
function cfgFirebaseJsonChange() {
  const jsonStr = (Utils.el('cfgFirebaseJson')?.value || '').trim();
  const statusEl = Utils.el('cfgFirebaseJsonStatus');
  if (statusEl) statusEl.classList.add('hidden');
  try {
    const cfg = JSON.parse(jsonStr);
    if (cfg.projectId) {
      const colEl = Utils.el('cfgFirestoreCollection');
      if (colEl && !colEl.dataset.userEdited) {
        colEl.value = cfg.projectId.toLowerCase().replace(/-/g,'_').replace(/[^a-z0-9_]/g,'');
      }
    }
  } catch (e) { /* JSON ainda incompleto */ }
}

/** Testa credenciais Firebase via REST API sem reinicializar o SDK */
async function cfgTestarFirebase() {
  const jsonStr = (Utils.el('cfgFirebaseJson')?.value || '').trim();
  if (!jsonStr) { UIService.showToast('Cole o JSON Firebase', '', 'warning'); return; }

  let config;
  try { config = JSON.parse(jsonStr); }
  catch (e) { UIService.showToast('JSON inválido', e.message, 'error'); return; }

  if (!config.apiKey || !config.projectId) {
    UIService.showToast('Config incompleta', 'apiKey e projectId obrigatórios', 'error'); return;
  }

  const col      = (Utils.el('cfgFirestoreCollection')?.value || 'ch_geladas').trim();
  const docId    = (Utils.el('cfgFirestoreDocId')?.value      || 'sistema').trim();
  const statusEl = Utils.el('cfgFirebaseJsonStatus');

  UIService.showToast('Testando...', 'A verificar credenciais', 'info');
  if (statusEl) { statusEl.textContent = '⏳ A verificar...'; statusEl.className = 'text-[9px] mt-1 text-slate-400 font-bold'; statusEl.classList.remove('hidden'); }

  try {
    const url = `https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/(default)/documents/${col}/${docId}?key=${config.apiKey}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if ([200, 404].includes(res.status)) {
      UIService.showToast('✅ Firebase válido!', `Projeto: ${config.projectId}`, 'success');
      if (statusEl) { statusEl.textContent = `✅ Credenciais OK — projeto: ${config.projectId}`; statusEl.className = 'text-[9px] mt-1 text-emerald-400 font-bold'; }
    } else if (res.status === 403) {
      UIService.showToast('✅ Credenciais OK', 'Ajuste as regras do Firestore', 'success');
      if (statusEl) { statusEl.textContent = '✅ Credenciais válidas (403 — verifique regras Firestore)'; statusEl.className = 'text-[9px] mt-1 text-amber-400 font-bold'; }
    } else if (res.status === 400) {
      UIService.showToast('❌ API Key inválida', 'Verifique a apiKey', 'error');
      if (statusEl) { statusEl.textContent = '❌ API Key inválida ou projecto errado'; statusEl.className = 'text-[9px] mt-1 text-red-400 font-bold'; }
    } else {
      UIService.showToast('⚠️ Resposta inesperada', `HTTP ${res.status}`, 'warning');
      if (statusEl) { statusEl.textContent = `⚠️ HTTP ${res.status} — verifique configuração`; statusEl.className = 'text-[9px] mt-1 text-amber-400 font-bold'; }
    }
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'Timeout — servidor sem resposta' : e.message;
    UIService.showToast('❌ Erro de rede', msg, 'error');
    if (statusEl) { statusEl.textContent = `❌ ${msg}`; statusEl.className = 'text-[9px] mt-1 text-red-400 font-bold'; }
  }
}

/** Restaura Firebase padrão e recarrega */
async function cfgResetFirebase() {
  const ok = await Dialog.confirm(
    'Restaurar Firebase padrão?',
    'A configuração personalizada será removida e o app vai recarregar com o Firebase padrão (padrão).'
  );
  if (!ok) return;
  const loja = _getLojaConfig();
  delete loja.firebase;
  delete loja.firestoreCollection;
  delete loja.firestoreDocId;
  _saveLojaConfig(loja);
  UIService.showToast('Firebase restaurado', 'A recarregar...', 'success');
  setTimeout(() => location.reload(), 1400);
}

/* ── Cfg: Export / Import ───────────────────────────────────────── */
function cfgExportarConfig() {
  const loja = _getLojaConfig();
  const cfg  = Store.Selectors.getConfig();
  const exportData = {
    _versao: '1.0',
    _exportadoEm: new Date().toISOString(),
    loja,
    preferencias: {
      nome: cfg.nome,
      alertaStock: cfg.alertaStock,
      categorias: cfg.categorias,
      sessionTimeoutMinutes: cfg.sessionTimeoutMinutes,
      somNotificacoes: cfg.somNotificacoes,
    },
  };
  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  const nome = (loja.nome || cfg.nome || 'loja').replace(/\s+/g, '-').toLowerCase();
  a.href = url; a.download = `config-${nome}-${Date.now()}.json`; a.click();
  URL.revokeObjectURL(url);
  UIService.showToast('Config exportada!', 'Ficheiro JSON guardado', 'success');
}

function cfgImportarConfig(input) {
  const file = input?.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async e => {
    try {
      const data = JSON.parse(e.target.result);
      if (!data._versao || (!data.loja && !data.preferencias)) throw new Error('Formato de ficheiro inválido');
      const nomeLoja = data.loja?.nome || data.preferencias?.nome || '?';
      const ok = await Dialog.confirm(
        'Importar configuração?',
        `Vai substituir identidade visual, Firebase e preferências.\nLoja: ${nomeLoja}`
      );
      if (!ok) { input.value = ''; return; }
      if (data.loja) _saveLojaConfig(data.loja);
      if (data.preferencias) {
        const cfg = { ...Store.Selectors.getConfig(), ...data.preferencias };
        Store.mutate(state => { state.config = cfg; });
        SyncService.persist();
      }
      UIService.showToast('Config importada!', 'A recarregar...', 'success');
      setTimeout(() => location.reload(), 1400);
    } catch (e) {
      UIService.showToast('Erro ao importar', e.message, 'error');
    }
    input.value = '';
  };
  reader.readAsText(file);
}

/* ── Inicia a aplicação ─────────────────────────────────────────── */
function toggleTurbo() {
  const panel   = Utils.el('turboPanel');
  const chevron = Utils.el('turboChevron');
  if (!panel) return;
  const open = panel.classList.toggle('hidden') === false;
  if (chevron) chevron.style.transform = open ? 'rotate(180deg)' : '';
  if (open) RenderService.renderTurboMode();
}

Bootstrap.start();

/* ── BackupManager bridges ───────────────────────────────────────── */
function criarBackupManual()          { BackupManager.criarBackup("manual"); }
function downloadBackupJSON()         { BackupManager.downloadBackup(); }
function restaurarBackup(id)          { BackupManager.restaurarBackup(id); }
function listarBackups()              { return BackupManager.listarBackups(); }

/* ── Toggle de som nas configurações ──────────────────────────── */
function cfgToggleSom() {
  const btn = Utils.el('cfgSomBtn');
  const dot = Utils.el('cfgSomDot');
  if (!btn) return;
  const ativo = btn.classList.contains('bg-blue-600');
  btn.className = `relative w-11 h-6 rounded-full transition-all flex-shrink-0 ${!ativo ? 'bg-blue-600' : 'bg-slate-700'}`;
  if (dot) dot.className = `absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${!ativo ? 'translate-x-5' : 'translate-x-0.5'}`;
}
