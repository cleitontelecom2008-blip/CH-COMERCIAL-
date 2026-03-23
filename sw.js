// CH Geladas PDV — Service Worker
// BUMP esta versão a cada deploy para forçar atualização do cache nos clientes
const CACHE_NAME = 'pdv-app-v4'; // nome genérico — isolamento real é feito pelo domínio

const ASSETS_TO_CACHE = [
  '/Ch-comercial/',
  '/Ch-comercial/index.html',
  '/Ch-comercial/manifest.json',
  // Módulos JS — obrigatórios para funcionamento offline
  '/Ch-comercial/app-dialogs.js',
  '/Ch-comercial/app-core.js',
  '/Ch-comercial/app-financeiro.js',
  '/Ch-comercial/app-ia.js',
  '/Ch-comercial/app-delivery.js',
  '/Ch-comercial/app-ponto.js',
  '/Ch-comercial/app-comanda.js',
  '/Ch-comercial/app-notif.js',
  '/Ch-comercial/app-fiado.js',   // FIX-04: estava ausente — fiado não funcionava offline
  '/Ch-comercial/firebase.js',
  '/Ch-comercial/sync.js',
  // Ícones PWA
  '/Ch-comercial/icon-72.png',
  '/Ch-comercial/icon-96.png',
  '/Ch-comercial/icon-128.png',
  '/Ch-comercial/icon-144.png',
  '/Ch-comercial/icon-152.png',
  '/Ch-comercial/icon-192.png',
  '/Ch-comercial/icon-384.png',
  '/Ch-comercial/icon-512.png'
];

// Instalação: pré-cacheia os assets essenciais
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

// Ativação: remove caches antigos
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// Fetch: serve do cache, com fallback para rede (cache-first)
self.addEventListener('fetch', (event) => {
  // Ignora requisições não-GET e externas (Firebase, Telegram, etc.)
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        // Cacheia apenas respostas válidas do próprio domínio
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
