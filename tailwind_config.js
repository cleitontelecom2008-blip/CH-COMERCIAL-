/** @type {import('tailwindcss').Config} */
module.exports = {
  // Escaneia TODOS os arquivos que usam classes Tailwind
  content: [
    './index.html',
    './app-*.js',
    './sw.js',
  ],

  theme: {
    extend: {
      fontFamily: {
        sans: ['Plus Jakarta Sans', 'sans-serif'],
      },
      colors: {
        // Design tokens do sistema
        'ch-bg':      '#060810',
        'ch-surface': '#0d1117',
        'ch-card':    '#111827',
      },
      borderRadius: {
        '2xl': '1rem',
        '3xl': '1.5rem',
        '4xl': '2rem',
      },
    },
  },

  plugins: [],

  // Safelist: classes geradas dinamicamente via JS (não detectadas pelo scanner)
  safelist: [
    // Cores de status delivery
    'ds-novo', 'ds-preparando', 'ds-caminho', 'ds-entregue', 'ds-cancelado',
    // Badges
    'b-blue', 'b-amber', 'b-purple', 'b-green', 'b-red',
    // Classes adicionadas dinamicamente
    { pattern: /^(text|bg|border)-(slate|blue|emerald|amber|red|purple)-(300|400|500|600|700|800|900)(\/\d+)?$/ },
    { pattern: /^(opacity|scale)-\d+$/ },
    // Animações
    'flash-blue', 'flash-amber', 'animate-pulse', 'animate-spin',
    // Tabs/panes
    'tab-pane', 'active',
    // Utilitários usados via JS
    'hidden', 'flex', 'block', 'grid',
  ],
};
