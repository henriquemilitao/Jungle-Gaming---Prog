# Distributed Wagering Processor

Serviço financeiro que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`)
vindas de provedores de jogos, por **HTTP** e por **AWS SQS**, mantendo saldo e ledger corretos
mesmo com mensagens duplicadas, fora de ordem, simultâneas e com processos morrendo no meio.

**Stack:** Bun 1.x · TypeScript estrito · NestJS · PostgreSQL 16 · MikroORM · AWS SQS (LocalStack) · Docker Compose

As decisões de arquitetura, os trade-offs e as limitações estão em [`ARCHITECTURE.md`](./ARCHITECTURE.md).

---

## Subindo o ambiente

Pré-requisitos: **Docker** (com Compose). Para rodar testes e scripts fora do container: **Bun 1.x**.

```bash
docker compose up -d --build
```

O compose sobe:

| Serviço | O que é | Porta |
|---|---|---|
| `postgres` | PostgreSQL 16 | 5432 |
| `localstack` | Emulador de SQS | 4566 |
| `setup` | Job único: aplica as migrations e cria as filas | — |
| `app-1`, `app-2`, `app-3` | **Três instâncias** da aplicação (API + consumidor SQS + workers) | 3001, 3002, 3003 |

```bash
curl localhost:3001/health/ready
# {"status":"ready","checks":{"postgres":"up","sqs":"up"}}
```

> **LocalStack:** desde 2026.03, as imagens mais novas do LocalStack exigem auth token. O compose fixa a tag
> community `4.12`. Se ela não estiver disponível, use o MiniStack (também aceito pelo desafio):
> `SQS_EMULATOR_IMAGE=ministackorg/ministack:latest docker compose up -d --build`

---

### Windows + WSL2

1. Use o **Docker Desktop** com a integração WSL ligada (*Settings → Resources → WSL integration*) ou o
   Docker Engine instalado dentro da distro. Confira com `docker compose version` no terminal do WSL.
2. Clone o projeto **dentro do filesystem do Linux** (ex.: `~/projetos`), e não em `/mnt/c/...`. Em
   `/mnt/c`, o I/O é muito mais lento e o watch de arquivos não funciona direito.
3. Instale o Bun no WSL: `curl -fsSL https://bun.sh/install | bash` e reabra o terminal.
4. Se já existir um PostgreSQL rodando na porta 5432 (no Windows ou no WSL), pare-o ou troque a porta
   publicada no `docker-compose.yml` (`"5433:5432"`) e use `TEST_DATABASE_URL` com a nova porta.
5. As portas publicadas (3001–3003, 5432, 4566) ficam acessíveis tanto do WSL quanto do Windows,
   via `localhost`.

---

## Rodando os testes

Os testes de integração e de concorrência usam **PostgreSQL e SQS reais** (os containers do compose).
Nada é mockado.

```bash
docker compose up -d postgres localstack      # só a infra (o banco wagering_test é criado no init)
bun install

bun test test/unit                            # domínio puro (rápido, sem infra)
bun run test:integration                      # banco + fila reais
bun run test:concurrency                      # paralelismo real, 3 processos, crash (SIGKILL)
bun run test:all                              # tudo
bun run test:load                             # teste de carga contra app-1..3 do compose
```

Variáveis usadas pelos testes (os padrões já apontam para o compose):

| Variável | Padrão |
|---|---|
| `TEST_DATABASE_URL` | `postgres://postgres:postgres@localhost:5432/wagering_test` |
| `TEST_SQS_ENDPOINT` | `http://localhost:4566` |

Cada suíte **recria o schema** do banco de teste do zero (rodando as migrations) e usa **filas com
sufixo próprio**, então as suítes não interferem umas nas outras.

### O que cada suíte prova

| Arquivo | Cobre |
|---|---|
| `test/unit/*` | `Money` (escala, entradas inválidas, aritmética exata, conflito de moeda), invariantes da `Wallet`, máquina de estados, regras de BET/WIN/LOSS/REFUND/ROLLBACK, hash de idempotência, outbox/inbox, eventos |
| `integration/schema-constraints` | Migrations reversíveis e constraints atacadas com SQL direto: saldo negativo, ledger append-only, saldo sem lançamento, unicidade, estados terminais, atomicidade (wallet + ledger + inbox + outbox) |
| `integration/wagering` | Idempotência persistente (replay, conflito, saldo do momento), regras com banco real, referência fora de ordem, paginação por cursor |
| `integration/messaging` | Consumidor SQS: inbox, redelivery, ack, DLQ (permanentes), retry → DLQ (transitórios), publishers concorrentes na outbox, falha de publicação com backoff |
| `integration/http-api` | Um status HTTP por situação (201/200/202/400/404/409/422), contratos, health, métricas |
| `concurrency/in-process` | 50× a mesma aposta → 1 débito; cenário 100/80/80; hot wallet; wallets distintas em paralelo (sem lock global) |
| `concurrency/multi-instance` | **3 processos** simultâneos (HTTP e SQS), SIGTERM no meio de uma rajada + restart, `kill -9` depois do commit e antes do ack, morte antes de publicar e publicação duplicada |

Todos os testes de fluxo terminam conferindo a invariante `wallet.balance == saldo reconstruído pelo ledger`.

---

## Usando a API

```bash
# Criar wallet
curl -s -XPOST localhost:3001/wallets -H 'content-type: application/json' -d '{
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "initialBalance": { "amount": "1000.00", "currency": "BRL" }
}'

# Apostar (Idempotency-Key obrigatório)
curl -s -XPOST localhost:3002/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' -d '{
  "providerId": "provider-a",
  "externalTransactionId": "transaction-123",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "walletId": "<id da wallet>",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" }
}'
```

| Método | Rota | |
|---|---|---|
| `POST` | `/wallets` | cria wallet (saldo inicial gera transação `OPENING` + lançamento) |
| `GET` | `/wallets/:walletId` | consulta |
| `GET` | `/wallets/:walletId/ledger?cursor=&limit=50` | extrato paginado (cursor opaco e estável) |
| `POST` | `/wallets/:walletId/reconciliation` | saldo armazenado × saldo reconstruído pelo ledger |
| `POST` | `/wagering/transactions` | submete operação (header `Idempotency-Key`) |
| `GET` | `/wagering/transactions/:transactionId` | consulta por id interno |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | consulta pelo id do provedor |
| `GET` | `/health/live`, `/health/ready` | liveness / readiness (sem autenticação) |
| `GET` | `/metrics` | métricas Prometheus |

Status HTTP (iguais em todos os endpoints — detalhes em `ARCHITECTURE.md` §8):
`201` processada · `200` replay idêntico · `202` pendente de referência · `400` payload inválido ·
`404` não encontrado · `409` conflito · `422` rejeição de negócio (com `failureCode`) · `503` transitório (`Retry-After`).

Header opcional `X-Correlation-Id`: é propagado para logs e eventos e devolvido na resposta.

### Pela fila

Publique em `wager-transactions.fifo` no formato da seção 10 do enunciado, de preferência com
`MessageGroupId = walletId`, para ter ordem por wallet. Exemplo com a AWS CLI:

```bash
aws --endpoint-url=http://localhost:4566 sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id <walletId> --message-deduplication-id msg-123 \
  --message-body '{"messageId":"msg-123","type":"WagerTransactionRequested","occurredAt":"2026-07-29T15:00:00.000Z","data":{...}}'
```

Os eventos publicados vão para `wallet-events.fifo`. Mensagens com erro permanente ou com as tentativas
esgotadas vão para `wager-transactions-dlq.fifo`, com o atributo `failureReason`.

---

## Comandos úteis

```bash
bun run migrate:up        # aplica migrations pendentes
bun run migrate:down      # desfaz a última
bun run migrate:status
bun run typecheck         # tsc --noEmit (strict)
bun run start             # roda uma instância local (usa as variáveis de src/config.ts)
```

Configuração: todas as variáveis de ambiente e seus padrões estão em [`src/config.ts`](./src/config.ts).
Variáveis como `CONSUMER_ENABLED`, `OUTBOX_PUBLISHER_ENABLED` e `HTTP_ENABLED` permitem rodar instâncias
especializadas (ex.: só worker).

## Estrutura

```
src/
  domain/          regras puras: Money, Wallet, WagerTransaction, Ledger, Inbox, Outbox, eventos
  application/     use cases + portas (interfaces) — não conhece banco, fila nem NestJS
  infrastructure/
    persistence/   MikroORM: mapeamento, repositórios, transaction runner, migrations
    messaging/     SQS: consumidor, outbox publisher
    http/          NestJS: controllers, validação, filtro de erros, auth (ponto de extensão)
    observability/ logs JSON (pino) e métricas (prom-client)
    workers/       loop de polling (outbox, pending reference)
  container.ts     composition root (liga implementações às portas)
test/              unit · integration · concurrency · load
```
