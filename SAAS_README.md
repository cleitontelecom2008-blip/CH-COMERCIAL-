# PDV SaaS v6 — FASE 2: Estrutura de Empresas

## O que foi adicionado na FASE 2

| Arquivo | Descrição |
|---|---|
| `saas-users.js` | **NOVO** — Gestão de usuários/colaboradores por empresa |
| `saas-auth.js` | Atualizado: campo de convite no registro, auto-fill por URL |
| `firestore.rules` | Atualizado: coleção `convites` adicionada |
| `admin.html` | Atualizado: coluna "Usuários" na tabela de empresas |
| `index.html` | Atualizado: seção "Usuários" no modal de Configurações |

---

## Coleções Firestore

### `empresas/{empresaId}`
nome, plano, planoReal, planoExpira, status, criadoEm, dono, vendasMes, limites

### `usuarios/{uid}`
empresaId, nome, email, cargo (dono|gerente|colaborador), criadoEm, ultimoAcesso

### `saas_dados/{empresaId}`
data { ...PDV... }, updated, version, empresaId

### `convites/{code}` — NOVO
empresaId, nomeEmpresa, cargo, criadoPor, criadoEm, expiraEm (24h), usado, usadoPor, usadoEm

---

## Fluxo de Convites

### Dono gera convite:
Configurações → Usuários da Empresa → Gerar Convite
→ Código de 6 letras + link direto (?convite=XXXXXX)
→ Válido por 24h, expira automaticamente

### Colaborador aceita:
Via link: app abre na tela Cadastrar com código preenchido
Via código: campo "Código de convite" no formulário de Cadastrar
→ Validação em tempo real (verde = válido, vermelho = inválido)
→ Cria conta → entra na empresa como colaborador

---

## Cargos

Dono: gerar convites, remover usuarios, alterar cargos
Gerente: acesso ADM ao PDV
Colaborador: acesso basico ao PDV

---

## Limite de Usuarios por Plano

Free: 1 | Basic: 3 | Pro: 10

---

## Deploy das Regras

firebase deploy --only firestore:rules

