#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
#  deploy.sh — Deploy completo do CH Geladas PDV para Firebase Hosting
#  Uso: bash deploy.sh
# ═══════════════════════════════════════════════════════════════════
set -e

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   CH GELADAS PDV — DEPLOY PARA FIREBASE  ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ── 1. Verificar dependências ─────────────────────────────────────
echo "▶ Verificando dependências..."

if ! command -v node &> /dev/null; then
  echo "❌ Node.js não encontrado. Instale em https://nodejs.org"
  exit 1
fi

if ! command -v firebase &> /dev/null; then
  echo "📦 Instalando Firebase CLI..."
  npm install -g firebase-tools
fi

echo "✅ Node $(node -v) | Firebase CLI $(firebase --version)"

# ── 2. Instalar dependências do projeto ───────────────────────────
echo ""
echo "▶ Instalando dependências..."
npm install

# ── 3. Gerar ícones PWA ───────────────────────────────────────────
echo ""
echo "▶ Gerando ícones PWA..."
node generate-icons.js

# ── 4. Build CSS (Tailwind purge) ─────────────────────────────────
echo ""
echo "▶ Compilando CSS otimizado..."
npm run build:css

# Substitui CDN do Tailwind pelo CSS local no index.html de produção
# (cria uma cópia — não altera o original de desenvolvimento)
echo ""
echo "▶ Preparando index.html para produção..."
cp index.html index.html.dev.bak
sed -i 's|<script src="https://cdn.tailwindcss.com"></script>|<link rel="stylesheet" href="/dist/app.css">|g' index.html
echo "✅ CSS otimizado injetado (backup salvo em index.html.dev.bak)"

# ── 5.5 Gerar CACHE_VERSION automático ───────────────────────────
# Hash SHA-256 do conteúdo dos arquivos do App Shell.
# O cache do SW só invalida quando um arquivo realmente muda —
# sem necessidade de bumpar a versão manualmente a cada deploy.
echo ""
echo "▶ Gerando CACHE_VERSION automático..."

# Arquivos que compõem o App Shell (mesma lista do sw.js)
SHELL_FILES="index.html app-core.js app-dialogs.js app-financeiro.js \
             app-delivery.js app-ponto.js app-comanda.js app-ia.js \
             app-notif.js firebase.js sync.js manifest.json sw.js"

# Concatena o conteúdo de todos e tira o SHA-256; pega os primeiros 8 chars
CONTENT_HASH=$(cat $SHELL_FILES 2>/dev/null | sha256sum | cut -c1-8)
BUILD_DATE=$(date +%Y%m%d)
CACHE_VERSION="ch-geladas-${BUILD_DATE}-${CONTENT_HASH}"

# Injeta no sw.js (substitui o placeholder)
sed -i "s|__CACHE_VERSION__|${CACHE_VERSION}|g" sw.js

echo "✅ CACHE_VERSION = ${CACHE_VERSION}"

# ── 5. Login Firebase (se necessário) ─────────────────────────────
echo ""
echo "▶ Verificando autenticação Firebase..."
if ! firebase projects:list &> /dev/null; then
  echo "🔐 Fazendo login no Firebase..."
  firebase login
fi

# ── 6. Deploy ─────────────────────────────────────────────────────
echo ""
echo "▶ Fazendo deploy para Firebase Hosting..."
firebase deploy --only hosting

# ── 7. Restaura arquivos de desenvolvimento ───────────────────────
cp index.html.dev.bak index.html
rm index.html.dev.bak
echo "✅ index.html de desenvolvimento restaurado"

# Restaura o placeholder do CACHE_VERSION no sw.js
sed -i "s|${CACHE_VERSION}|__CACHE_VERSION__|g" sw.js
echo "✅ sw.js restaurado (placeholder __CACHE_VERSION__ de volta)"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   ✅ DEPLOY CONCLUÍDO COM SUCESSO!        ║"
echo "║                                          ║"
echo "║   https://ch-geladas.web.app             ║"
echo "║   https://ch-geladas.firebaseapp.com     ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "📱 Para instalar no celular:"
echo "   Android: Chrome → menu (⋮) → 'Adicionar à tela inicial'"
echo "   iPhone:  Safari → Compartilhar (□↑) → 'Adicionar à tela de início'"
echo ""
