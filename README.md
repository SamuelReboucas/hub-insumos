# 📦 Hub de Gestão de Insumos e Equipamentos

Ferramenta interna para gestão de estoque de insumos de embalagem (caixas, fita gomada, preenchimento) em operação multi-marca e multi-canal (B2C, B2B, Marketplace), com forecast dinâmico de consumo e alertas automáticos de reposição.

## 🎯 Contexto do problema

Nasceu de uma crise operacional real: rupturas de insumos críticos travando o packing de pedidos, sem visibilidade centralizada de estoque entre marcas e centros de distribuição. Antes deste projeto, o controle era manual e fragmentado por planilhas isoladas por marca.

## 🎯 O que o sistema resolve

- **Estoque mínimo dinâmico** por insumo, calculado a partir de consumo médio × lead time (com lead times diferentes por insumo — ex: fita gomada 16 dias, caixas 7-12 dias)
- **Forecast de consumo** baseado em mix de produtos e fatores de consumo por marca/canal
- **Classificação de insumos por criticidade**:
  - **Críticos** (ex: caixas) — alta criticidade, maior lead time, exigem planejamento antecipado
  - **Compartilháveis/flexíveis** (ex: fita gomada, preenchimento) — podem ser redistribuídos entre marcas antes de gerar nova compra
- **Necessidade de compra** calculada automaticamente por marca/CD/canal
- **Alertas automáticos** (e-mail via Resend + Google Chat) quando: estoque cruza o ponto crítico, ou uma marca não reporta seu preenchimento semanal
- **Regras de faturamento** configuráveis por marca+CD (rateio de CNPJ emissor)

## 🏗️ Arquitetura

- **`src/index.ts`** — API completa em Cloudflare Workers (Hono), com banco SQLite embutido (`env.DB`)
- **`public/index.html`** — front-end single-page com abas de Snapshot, Parâmetros (mix/fatores de consumo), Forecast, Alertas e Faturamento

## 🔌 Integrações

- Ingestão de dados via formulário (Google Forms → planilha → CSV consumido pelo Worker)
- Notificação de criticidade e ausência de preenchimento semanal via **Google Chat Webhook**
- Alertas por e-mail via **Resend API**
- Endpoints de webhook para automação externa (`/api/webhook/submit`, `/api/webhook/check-week`), autenticados por `x-webhook-secret`

## 🚀 Stack

`TypeScript` · `Hono` · `Cloudflare Workers` · `SQLite (D1)` · `Resend API` · `Google Chat API` · `Google Sheets/Forms`

## 📌 Nota

Código extraído de um sistema em produção. IDs de planilhas, webhooks e demais credenciais foram removidos/substituídos por placeholders (`SEU_..._AQUI`) — configure suas próprias variáveis de ambiente (`RESEND_API_KEY`, `GOOGLE_CHAT_WEBHOOK`, `WEBHOOK_SECRET`, `ALERT_EMAIL`, `FROM_EMAIL`) antes de rodar.
