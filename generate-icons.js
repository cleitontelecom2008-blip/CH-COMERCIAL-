#!/usr/bin/env node
/**
 * generate-icons.js — Gera todos os ícones PWA necessários
 *
 * Uso:
 *   node generate-icons.js
 *
 * Dependência (instale uma vez):
 *   npm install sharp
 *
 * Coloque um arquivo "icon-source.png" (1024×1024, fundo escuro #060810, emoji 🍺 centralizado)
 * na pasta raiz e rode este script. Ele gera automaticamente todos os tamanhos no /icons/
 */

const fs   = require('fs');
const path = require('path');

async function main() {
  let sharp;
  try { sharp = require('sharp'); }
  catch {
    console.error('❌ sharp não instalado. Execute: npm install sharp');
    process.exit(1);
  }

  const SIZES = [72, 96, 128, 144, 152, 192, 384, 512];
  const SRC   = path.join(__dirname, 'icon-source.png');
  const OUT   = path.join(__dirname, 'icons');

  if (!fs.existsSync(SRC)) {
    // Gera um ícone placeholder SVG → PNG se não houver fonte
    console.warn('⚠️  icon-source.png não encontrado — gerando placeholder');

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
      <rect width="1024" height="1024" fill="#060810" rx="200"/>
      <text x="512" y="680" font-size="600" text-anchor="middle" dominant-baseline="middle">🍺</text>
    </svg>`;

    fs.mkdirSync(OUT, { recursive: true });
    for (const size of SIZES) {
      await sharp(Buffer.from(svg))
        .resize(size, size)
        .png()
        .toFile(path.join(OUT, `icon-${size}.png`));
      console.info(`✅ icon-${size}.png`);
    }
  } else {
    fs.mkdirSync(OUT, { recursive: true });
    for (const size of SIZES) {
      await sharp(SRC).resize(size, size).png().toFile(path.join(OUT, `icon-${size}.png`));
      console.info(`✅ icon-${size}.png`);
    }
  }

  console.info('\n🎉 Ícones gerados em /icons/ — pronto para PWA!');
}

main().catch(console.error);
