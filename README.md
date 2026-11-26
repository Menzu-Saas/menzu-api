# Menzu · API

Rotas `/api/*`, fila de pedidos e verificação automática de pagamentos, publicadas no **Render**.
As páginas e o painel ficam no repositório [`menzu-front`](https://github.com/Menzu-Saas/menzu-front), publicado na Vercel.

| Rota | Uso |
| --- | --- |
| `GET /api/health` | saúde do serviço; `ordering` diz se a fila aceita pedidos |
| `POST /api/orders` · `GET /api/orders/status` · `/api/orders/quote` | pedidos do cardápio |
| `/api/webhooks/asaas` | avisos de pagamento da Asaas |
| `/api/internal/*` | fila e verificação de pagamentos, protegidas por segredo |

## Publicar no Render

Crie um Blueprint apontando para este repositório (branch `main`, arquivo `render.yaml`) e preencha no painel as
variáveis marcadas como segredo. `NEXT_PUBLIC_APP_URL` é o endereço do front.

O plano gratuito serve só para testes: o serviço suspende sem acesso e a fila é apagada a cada
reinício. Para pedidos reais use um plano com disco persistente.

## Rodar no computador

```
npm ci
npm run dev      # API em http://localhost:3004
npm run queue    # fila, em outro terminal
```

O banco (Supabase) está em `supabase/migrations`.

## Código compartilhado

Parte de `src/lib` e `src/server` existe aqui e no [`menzu-front`](https://github.com/Menzu-Saas/menzu-front)
(login, Supabase, pagamentos, regras de pedido). Ao alterar um desses arquivos, leve a mesma mudança
para o outro repositório.

Este repositório é público. Nunca versione chaves, senhas ou dados de clientes.
