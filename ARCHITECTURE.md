# ARCHITECTURE

Este documento explica **o que** foi construído, **por que** cada decisão foi tomada e **o que ficou de fora**.

Princípio que guiou tudo: **o PostgreSQL é a fonte da verdade das invariantes.**
Fila, cache e código de aplicação ajudam, mas nenhuma garantia financeira depende só deles.

---

## 1. Visão geral

```
 Provedor ──HTTP POST /wagering/transactions──┐
          └──SQS wager-transactions.fifo───────┤  (mesmo use case)
                                               ▼
                         ProcessWagerTransactionUseCase
                                               │  1 transação SQL:
                                               │  inbox + transação + wallet + ledger + outbox
                                               ▼
                                          PostgreSQL
                                               │  OutboxPublisher (FOR UPDATE SKIP LOCKED)
                                               ▼
                                     SQS wallet-events.fifo ──► outros sistemas
```

Cada instância da aplicação roda, no mesmo processo:

- **API HTTP** (NestJS);
- **consumidor SQS** (N loops de long polling);
- **worker da outbox**, que publica os eventos;
- **worker de PENDING_REFERENCE**, que reprocessa as referências fora de ordem.

Todas as instâncias são iguais e não guardam estado em memória: subir 3 ou 30 não muda a correção.

### Camadas (boundaries)

| Camada | Conteúdo | Depende de |
|---|---|---|
| `domain/` | `Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, `InboxMessage`, `OutboxMessage`, eventos, `WagerTransactionProcessor` (regras da seção 7) | nada (TypeScript puro + `decimal.js`) |
| `application/` | use cases, **portas** (`WalletRepository`, `TransactionRunner`, `Metrics`...), hash de idempotência, erros com categoria | `domain` |
| `infrastructure/` | MikroORM, SQS, NestJS, pino, prom-client | `application`, `domain` |
| `container.ts` | composition root: liga as implementações às portas | tudo |

O domínio não importa nada de NestJS nem do ORM. Toda a regra de negócio está em
`WagerTransactionProcessor`, um serviço puro. HTTP, SQS e o worker de PENDING_REFERENCE chamam
**exatamente a mesma função**, e ela é testada por testes unitários sem banco.

**Modelagem (6.0):** todas as entidades e value objects têm construtor `private` e são criados por
factories (`Money.from/zero`, `Wallet.open`, `WagerTransaction.create/createOpening`,
`WalletLedgerEntry.create`, `InboxMessage.receive`, `OutboxMessage.enqueue`). A leitura do banco
sempre passa por `rehydrate`, que não revalida transições. O estado mutável é privado e só muda pelos
métodos de transição.

---

## 2. ORM e persistência

### Por que MikroORM (e não TypeORM)

- `em.transactional()`: delimita a transação de forma explícita, e o callback recebe um EntityManager
  isolado.
- **Unit of Work + Identity Map:** as escritas de um processamento (transação, wallet, ledger, outbox,
  inbox) são acumuladas e enviadas num único flush, logo antes do COMMIT.
- `LockMode`: `PESSIMISTIC_WRITE` (`FOR UPDATE`), `PESSIMISTIC_READ` (`FOR SHARE`) e
  `PESSIMISTIC_PARTIAL_WRITE` (`FOR UPDATE SKIP LOCKED`). São exatamente os três locks usados no projeto.
- `allowGlobalContext: false`: obriga cada operação a usar um `fork()` próprio. Assim é impossível
  requisições concorrentes compartilharem um Identity Map por engano.

**Domínio separado do mapeamento.** O mapeamento usa `EntitySchema` (sem decorators) sobre *records*
de persistência (`records.ts`). Os repositórios convertem record ⇄ domínio (`mappers.ts`). O custo é
um pouco de código de mapeamento; o ganho é que o domínio continua puro, como pede a seção 6.1.

**Versões:** fixei NestJS 11 e MikroORM 6. São linhas estáveis e bem documentadas, e preferi evitar
surpresas de majors recentes num prazo curto.

### Mapeamento do `Money`

| Camada | Representação |
|---|---|
| Contratos (API, fila, eventos) | `{ "amount": "25.00", "currency": "BRL" }`: **string** com 2 casas |
| Domínio | `Money` imutável sobre `decimal.js`. Nunca `number`. |
| Banco | **duas colunas**: `NUMERIC(19,2)` + `CHAR(3)` |
| ORM | tipo `decimal` → o MikroORM devolve **string** (`"975.00"`), reidratada com `Money.rehydrate` |

- `NUMERIC(19,2)` é exato (não é ponto flutuante) e cabe até ~10¹⁷.
- A entrada aceita no máximo 15 dígitos inteiros, com folga.
- Somas feitas pelo banco (reconciliação) também são em `NUMERIC`: nenhum valor passa por `number` em
  nenhum ponto.

**Validação** (`Money.from`): regex `^(0|[1-9]\d{0,14})\.\d{2}$` + moeda `^[A-Z]{3}$`.
Rejeita `NaN`, `Infinity`, notação científica, string vazia, mais de 2 casas, escala diferente de 2
(`"10.5"`), negativos, zeros à esquerda e espaços.

**Não há arredondamento:** valores com mais de 2 casas são rejeitados, nunca arredondados em silêncio.

### Estratégia transacional

`MikroOrmTransactionRunner.run(work)`:

1. `em.fork().transactional(...)` → `BEGIN` (READ COMMITTED).
2. `SET LOCAL lock_timeout = 5s` e `SET LOCAL statement_timeout = 15s`: ninguém espera para sempre.
3. Executa `work(uow)`. Os repositórios acumulam as escritas no Unit of Work.
4. Flush + `COMMIT`. As constraints `DEFERRABLE INITIALLY DEFERRED` são verificadas aqui.
5. **Retry da transação inteira** (máx. 3) em violação de unicidade por corrida e em deadlock. Na nova
   tentativa, a leitura enxerga o vencedor e devolve replay ou conflito. A exceção é a unicidade que é
   regra (`wallet_player_currency_uq`), que vira 409 direto.
6. Tradução de erros do banco para erros de aplicação com categoria:
   - `55P03` (lock timeout) → `LOCK_TIMEOUT`;
   - conexão perdida ou banco reiniciando → `DATABASE_UNAVAILABLE`;
   - os dois são `transient` → HTTP 503 e retry na fila.

As FKs são `DEFERRABLE INITIALLY DEFERRED`. Assim a ordem dos INSERTs dentro do flush não importa: a
integridade referencial é checada no COMMIT.

---

## 3. Concorrência

**Unidade de concorrência = `walletId`.**

**Estratégia: lock pessimista na linha da wallet** (`SELECT ... FOR UPDATE`) + constraints no banco
como rede de segurança.

```
BEGIN
  SELECT ... FROM wallet WHERE id = $1 FOR UPDATE     ← só ESTA wallet; as outras seguem em paralelo
  ler saldo → regras de negócio → calcular novo saldo
  INSERT wager_transaction / wallet_ledger_entry / outbox_message (/ inbox_message)
  UPDATE wallet SET balance_amount, version = version + 1
COMMIT                                                ← libera o lock
```

O "ler → calcular → gravar" acontece com exclusão mútua **por wallet**. Não existe lock global: o teste
`concurrency/in-process` segura o lock de uma wallet e mostra que as outras 9 processam em menos de
1 s nesse meio-tempo.

### Por que pessimista e não otimista

| | Pessimista (escolhido) | Otimista (`version` + retry) | UPDATE condicional |
|---|---|---|---|
| Hot wallet (muitas ops na mesma wallet) | ops **esperam a vez**; nenhuma falha à toa | colisões em cascata; com "retry limitado", ops **válidas** podem ser rejeitadas por esgotar tentativas | bom para BET isolada |
| Regras com várias leituras (referência, já revertida, idempotência) | todas leem dentro do lock, estado estável | precisa revalidar tudo a cada retry | difícil expressar num único UPDATE |
| Raciocínio / prova de correção | simples: seção crítica por wallet | mais sutil | sutil quando há várias tabelas |
| Custo | segura uma conexão enquanto espera | sem espera, mas com retrabalho | mínimo |

O enunciado testa justamente a **hot wallet** (50 envios simultâneos, 100/80/80). Nesse cenário o
conflito é esperado, não raro, e o lock otimista perde a vantagem.

O `version` continua existindo, como exige a seção 6.2:

- começa em 1;
- sobe exatamente +1 a cada mudança de saldo (garantido por trigger);
- vai nos eventos (`walletVersion`);
- é a chave de ordenação do ledger.

**Camadas de proteção (defesa em profundidade):**

1. Lock pessimista por wallet (aplicação).
2. `CHECK (balance_amount >= 0)`: mesmo com bug, o banco recusa saldo negativo.
3. Trigger deferred que exige um lançamento correspondente a cada mudança de saldo.
4. Trigger de `version` (+1 por mudança).
5. `UNIQUE` de idempotência.

**Deadlock:** cada transação trava **uma** wallet só, então não há ciclo possível no fluxo principal.
O worker de PENDING_REFERENCE usa a mesma ordem (wallet → transação).

**Observabilidade do lock:** antes do lock bloqueante, uma sondagem `FOR UPDATE NOWAIT` dentro de um
`SAVEPOINT` detecta se outra transação já segura a wallet. Isso incrementa
`wagering_lock_conflicts_total{reason="contended"}` sem mudar o comportamento. Custa ~3 statements por
operação. É um trade-off aceito pelo diagnóstico de hot wallets.

**Por que não confiar no FIFO do SQS:** o `MessageGroupId = walletId` ordena as mensagens **de uma
fila**, mas a mesma wallet também recebe operações por HTTP, de outros provedores e do worker de
pendências. O FIFO é otimização; o lock e as constraints são a garantia.

---

## 4. Idempotência

Existem **duas camadas**, com propósitos diferentes:

| | Inbox | Idempotency-Key |
|---|---|---|
| Responde | "esta **entrega** da fila já foi processada?" | "esta **operação de negócio** já existe?" |
| Chave | `(consumer_name, message_id)` (PK) | `idempotency_key` (UNIQUE) + `(provider_id, external_transaction_id)` (UNIQUE) |
| Pega | redelivery do SQS (at-least-once), crash depois do commit e antes do ack | reenvio pelo provedor (mesma op com outro messageId, ou por HTTP) |

Tudo é **persistente no Postgres**, gravado na mesma transação SQL do efeito financeiro. Nada em memória.

### `payloadHash` (algoritmo)

1. Subconjunto de negócio:
   - `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`;
   - `money.{amount,currency}`;
   - `referenceExternalTransactionId` (quando houver).
2. **JSON canônico:** chaves ordenadas por código de caractere em todos os níveis, sem espaços, campos
   `undefined` omitidos.
3. `SHA-256` → hex de 64 caracteres.

O header `Idempotency-Key`, o `messageId`, o `occurredAt` e outros metadados de transporte **não entram**
no hash. Por isso a mesma operação vinda por HTTP ou por SQS gera o mesmo hash.

### Fluxo

1. Busca pela key, **sem lock**: replays não disputam o lock da wallet.
   - Achou com o mesmo hash → **replay**: devolve o resultado original, com o saldo **observado
     naquele momento** (coluna `resulting_balance_amount`) e `idempotentReplay: true`.
   - Achou com hash diferente → **409 `IDEMPOTENCY_KEY_CONFLICT`** (não é replay).
   - O mesmo `(providerId, externalTransactionId)` com outra key → **409
     `EXTERNAL_TRANSACTION_CONFLICT`**.
2. Trava a wallet e **repete a busca**: outra requisição com a mesma key pode ter commitado enquanto
   esperávamos.
3. Se duas transações ainda assim tentarem inserir a mesma key (caminhos sem a mesma wallet), o
   `UNIQUE` falha no COMMIT de uma delas. O runner refaz a transação, que agora encontra a vencedora e
   devolve o replay.

Resultado testado: **50 envios paralelos (e 60 espalhados por 3 processos) → 1 débito**.

---

## 5. Schema: garantias no banco

| Garantia | Onde |
|---|---|
| Uma wallet por player + moeda | `UNIQUE (player_id, currency)` |
| Saldo nunca negativo | `CHECK (balance_amount >= 0)` na wallet; `CHECK` nos saldos do ledger e no `resulting_balance` |
| Toda mudança de saldo tem lançamento | constraint trigger **deferred** `wallet_balance_has_ledger_entry`: exige um lançamento com `wallet_version = NEW.version`, `balance_before = OLD` e `balance_after = NEW`; na criação com saldo, exige o lançamento OPENING |
| `version` começa em 1 e só muda com o saldo, +1 | trigger `wallet_guard_identity` + checagem no INSERT |
| Identidade da wallet imutável | trigger (`id`, `player_id`, `currency`, `created_at`) |
| Lançamento aritmeticamente correto | `CHECK ((CREDIT and after = before + amount) or (DEBIT and after = before - amount))` |
| Ledger append-only | triggers bloqueiam `UPDATE`, `DELETE` e `TRUNCATE` |
| ≤ 1 lançamento por transação por wallet | `UNIQUE (transaction_id, wallet_id)` |
| Encadeamento do extrato | `UNIQUE (wallet_id, wallet_version)` |
| Idempotência | `UNIQUE (idempotency_key)`, `UNIQUE (provider_id, external_transaction_id)` |
| Reverter no máximo uma vez | índice único parcial `(reference_transaction_id) WHERE kind IN (REFUND, ROLLBACK) AND status = 'PROCESSED'` |
| Estado terminal congelado | trigger `wager_tx_guard` (bloqueia alterar PROCESSED/REJECTED/FAILED e campos de negócio); `DELETE` bloqueado |
| Coerência de status | `CHECK`s: REJECTED/FAILED ⇔ `failure_code`; PROCESSED ⇔ `processed_at`; PENDING_REFERENCE ⇔ `next_reference_attempt_at`; REFUND/ROLLBACK exigem referência; BET/OPENING não podem ter |
| Só LOSS pode ter valor 0 | `CHECK (amount > 0 OR (kind = 'LOSS' AND amount = 0))` |
| Dedup da fila | `PRIMARY KEY (consumer_name, message_id)` na inbox |
| Outbox coerente | `CHECK ((published_at IS NULL) = (next_attempt_at IS NOT NULL))` |

**Índices pensados para os acessos reais:**

- **parciais** para o worker da outbox (`WHERE published_at IS NULL`);
- **parciais** para as pendências (`WHERE status = 'PENDING_REFERENCE'`);
- `(wallet_id, wallet_version)` para a paginação do ledger.

Os testes de `schema-constraints` atacam cada garantia com SQL direto, contornando a aplicação.

**Migrations** versionadas (timestamp no nome, listadas explicitamente na config) e **reversíveis**
(`down()` desfaz tudo). Isso é testado com `down` + `up`.

---

## 6. Máquina de estados de `WagerTransaction`

```
              ┌──────────────► PROCESSED   (terminal)
              ├──────────────► REJECTED    (terminal)
   PENDING ───┼──────────────► FAILED      (terminal)
              └──► PENDING_REFERENCE ──► PROCESSED | REJECTED | FAILED
                         └──┐ (nova tentativa agendada: continua PENDING_REFERENCE)
                            └──┘
```

- Transições fora dessa tabela lançam `InvalidTransactionStateError`. É um erro de programação: vira
  500, não 4xx. O trigger `wager_tx_guard` repete a regra no banco.
- **`PENDING` nunca é persistido:** a transação nasce e é decidida dentro da mesma transação SQL. Ela é
  gravada direto em PROCESSED, REJECTED ou PENDING_REFERENCE.
- **`FAILED`** = erro permanente de infraestrutura. É usado quando o reprocessamento de uma
  PENDING_REFERENCE falha de forma inesperada (não transitória): a transação vira FAILED com
  `PROCESSING_FAILED` em vez de tentar para sempre. Fica auditável.

---

## 7. Regras de negócio e interpretações adotadas

Todas estão em `WagerTransactionProcessor`:

| Operação | Saldo | Ledger | Referência |
|---|---|---|---|
| BET | débito | DEBIT | proibida |
| WIN | crédito | CREDIT | opcional; se informada, deve ser BET da mesma rodada |
| LOSS | — | nenhum | opcional (idem WIN); valor pode ser `0.00` |
| REFUND | crédito | CREDIT | obrigatória; só BET |
| ROLLBACK | inverso da referência (BET→CREDIT; WIN/REFUND→DEBIT) | 1 lançamento | obrigatória; BET, WIN ou REFUND |

A referência é resolvida por `(providerId, referenceExternalTransactionId)` e precisa ter o **mesmo**
provider, player, wallet, moeda e rodada (senão `REFERENCE_MISMATCH`). Ela também precisa estar
PROCESSED (senão `REFERENCE_NOT_PROCESSED`) e ter o **mesmo valor** (senão `REVERSAL_AMOUNT_MISMATCH`).

**Interpretações adicionais (documentadas conforme pede a seção 7):**

1. **Uma transação pode ser revertida no máximo UMA vez, por qualquer tipo.** O texto diz "não pode ser
   revertida duas vezes pelo **mesmo** tipo". Mas permitir REFUND **e** ROLLBACK da mesma BET creditaria
   o valor duas vezes, o que viola a invariante global "não duplicar créditos". Por isso adotei a
   leitura mais restritiva (`ALREADY_REVERSED`), garantida por índice único parcial. Reverter a
   *reversão* continua permitido (ROLLBACK de um REFUND), porque é outra referência.
2. **OPENING é interna:** `WagerTransaction.create` recusa OPENING (`KIND_NOT_ALLOWED`, HTTP 400 / DLQ).
   Só `createOpening` cria, chamado pelo use case de abrir wallet, com `providerId = "internal"`.
3. **`walletId` inexistente:** é rejeição de negócio (`WALLET_NOT_FOUND`, 422 / ack), mas **não é
   persistida**, porque a FK exige uma wallet. A resposta é determinística, então o reenvio é seguro.
4. **Wallet de outro player:** `PLAYER_MISMATCH`. **Moeda diferente da wallet:** `CURRENCY_MISMATCH`.
   As duas são persistidas como REJECTED e auditáveis.
5. **Rejeições guardam o saldo observado** (`resulting_balance_amount`), para o replay devolver
   exatamente a mesma resposta.
6. **Referência que também está PENDING_REFERENCE** (ex.: ROLLBACK de um REFUND que ainda espera a BET)
   é tratada como ainda ausente: espera junto.
7. `idempotency_key` do provedor é aceita como veio (1 a 300 caracteres). O formato
   `{providerId}:{externalTransactionId}` é recomendado, mas não obrigatório.

### 7.1 Referências fora de ordem

- A transação é gravada como `PENDING_REFERENCE`, com `next_reference_attempt_at`, e o evento
  `WagerTransactionPendingReference` é publicado. A resposta é HTTP 202 (pela fila, ack).
- Um **worker agendado** em todas as instâncias busca as pendências vencidas e reprocessa cada uma com a
  wallet travada, rechecando o status depois do lock. Assim é seguro com várias instâncias.
- **Backoff exponencial:** 1 s, 2 s, 4 s, ..., com teto de 120 s.
- **Limite: 10 tentativas** (~8 minutos no total). Esgotado → `REJECTED` / `REFERENCE_NOT_FOUND` +
  evento `WagerTransactionRejected`.
- **Justificativa do limite:** fora de ordem normalmente é questão de milissegundos ou segundos (entregas
  paralelas, retries do provedor). Oito minutos cobrem os retries típicos de um provedor e uma
  indisponibilidade curta. Esperar mais deixa o provedor e o jogador sem uma resposta definitiva por
  tempo demais. Os valores são configuráveis (`PENDING_REFERENCE_*`).
- **Atalho:** quando a transação referenciada chega e é processada, o mesmo COMMIT antecipa
  `next_reference_attempt_at` das dependentes para "agora". Na prática, a resolução acontece no
  próximo ciclo do worker (≤ 1 s), não no fim do backoff.

### 7.2 Taxonomia de `failureCode` (rejeições de negócio, HTTP 422)

| Código | Situação | O provedor deve |
|---|---|---|
| `INSUFFICIENT_FUNDS` | BET maior que o saldo | **desistir** (reenviar não muda nada) |
| `REVERSAL_INSUFFICIENT_FUNDS` | ROLLBACK de crédito que deixaria saldo negativo | **escalar** para operação/antifraude (situação diferente de aposta sem saldo) |
| `CURRENCY_MISMATCH` | moeda da operação ≠ moeda da wallet | **corrigir** o payload |
| `PLAYER_MISMATCH` | wallet pertence a outro player | **corrigir** |
| `WALLET_NOT_FOUND` | walletId inexistente | **corrigir** |
| `REFERENCE_MISMATCH` | referência de outro player/wallet/moeda/rodada | **corrigir** |
| `INVALID_REFERENCE_KIND` | ex.: REFUND de WIN, ROLLBACK de LOSS | **corrigir** |
| `REVERSAL_AMOUNT_MISMATCH` | valor ≠ valor da referência | **corrigir** |
| `REFERENCE_NOT_PROCESSED` | referência foi REJECTED/FAILED | **desistir** (não há o que reverter) |
| `ALREADY_REVERSED` | referência já revertida | **desistir** (já foi feito) |
| `REFERENCE_NOT_FOUND` | referência não chegou dentro do limite | **desistir/investigar** |
| `PROCESSING_FAILED` | status FAILED, erro permanente de infra | **investigar** |

Erros que **não** são rejeições de negócio (e não geram transação persistida) usam o envelope
`{ "error": { "code", "message", "retryable" } }`:

- **400:** `INVALID_PAYLOAD`, `INVALID_MONEY`, `KIND_NOT_ALLOWED`, `REFERENCE_REQUIRED`,
  `REFERENCE_NOT_ALLOWED`, `INVALID_CURSOR`;
- **409:** `IDEMPOTENCY_KEY_CONFLICT`, `EXTERNAL_TRANSACTION_CONFLICT`, `WALLET_ALREADY_EXISTS`;
- **404:** `WALLET_NOT_FOUND` / `TRANSACTION_NOT_FOUND` nas consultas;
- **503:** `LOCK_TIMEOUT`, `DATABASE_UNAVAILABLE`, `DATABASE_TIMEOUT`.

---

## 8. Mapeamento HTTP

Um único mapeamento, aplicado por um filtro global (`HttpErrorFilter`) e por `statusFor()`. É igual em
todos os endpoints:

| Situação | Status | Reenviar? |
|---|---|---|
| Transação processada | **201** | — |
| Replay idêntico de transação processada | **200** (`idempotentReplay: true`) | — |
| Aceita, processamento pendente (PENDING_REFERENCE) | **202** | não precisa; consultar depois |
| Rejeição por regra de negócio | **422** + `failureCode` | ver tabela 7.2 |
| Payload inválido | **400** | só corrigido |
| Conflito de idempotência / duplicidade | **409** | não |
| Recurso inexistente (consultas) | **404** | não |
| Falha transitória de infraestrutura | **503** + `Retry-After` | **sim, com a mesma Idempotency-Key** |
| Erro inesperado | 500 | sim, é seguro (idempotente) |

O provedor decide pelo **status** (e por `error.retryable`), sem interpretar texto.

---

## 9. Consumo SQS

- Filas `wager-transactions.fifo` → DLQ `wager-transactions-dlq.fifo`.
- Recomenda-se ao produtor usar `MessageGroupId = walletId`: ordem por wallet e paralelismo entre wallets.
- Long polling; `SQS_CONSUMER_CONCURRENCY` loops por instância.
- **Mesmo use case da API.** Dedup pela **inbox** (`consumerName = "wager-transactions-consumer"`,
  `messageId` do envelope). A mesma `messageId` com conteúdo diferente vai para a DLQ
  (`INBOX_PAYLOAD_MISMATCH`).
- **Ack somente depois do commit:** o use case só retorna depois do COMMIT; só então vem o
  `DeleteMessage`.

| Resultado | Ação |
|---|---|
| PROCESSED / REJECTED (negócio) / PENDING_REFERENCE / duplicata | **ack**: terminal; reenviar não muda nada |
| Payload inválido, OPENING, conflito de idempotência | **DLQ imediata** (permanente), com `failureReason` |
| Transitório (banco fora, lock timeout) ou inesperado | **sem ack**: `ChangeMessageVisibility` com backoff exponencial (2 s, 4 s, 8 s...) |
| Tentativas esgotadas (`ApproximateReceiveCount ≥ 5`) | **DLQ** com `MAX_RECEIVES_EXCEEDED:<motivo>` |

- O limite é aplicado **pela aplicação**. O `RedrivePolicy` do SQS fica configurado com folga (limite + 2)
  como rede de segurança para a "mensagem venenosa" que derruba o processo antes que ele consiga decidir.
- Ao mover para a DLQ, primeiro faz `SendMessage` para a DLQ e depois `DeleteMessage`. Se morrer entre
  os dois, a mensagem é reprocessada, e a inbox evita efeito duplicado.
- **SIGTERM:** para de buscar (aborta o long poll), termina a mensagem em andamento e devolve a
  visibilidade (`VisibilityTimeout=0`) das já recebidas e não iniciadas, na ordem, preservando o FIFO.
  Depois para os workers e fecha conexões. Sai com código 0. O tempo é limitado por `SHUTDOWN_GRACE_MS`
  (o compose dá 30 s de `stop_grace_period`).
- **Crash entre commit e ack** (testado com `kill -9`): a mensagem reaparece depois do visibility
  timeout. Outra instância a recebe, a inbox diz "já processada", e ela só faz o ack.

---

## 10. Transactional Outbox

- Os eventos são gravados em `outbox_message` **na mesma transação SQL** da alteração financeira. Nunca
  se publica antes do commit.
- `OutboxPublisher` roda em **todas as instâncias**:
  - `SELECT ... WHERE published_at IS NULL AND next_attempt_at <= now() ORDER BY occurred_at FOR UPDATE SKIP LOCKED LIMIT 50`;
  - publica em lotes de 10 (`SendMessageBatch`, `MessageGroupId = aggregateId`,
    `MessageDeduplicationId = eventId`), em **5 pistas paralelas**. Cada wallet cai sempre na mesma
    pista, então a ordem por wallet dentro do lote é preservada. Se um evento falha, os seguintes da
    mesma wallet esperam o retry;
  - marca `published_at` e faz COMMIT.
- `SKIP LOCKED`: publishers concorrentes pegam **linhas diferentes**, sem esperar e sem publicar a
  mesma linha ao mesmo tempo.
- **Falha ao publicar:** `scheduleRetry` (`attempts++`, backoff exponencial até 60 s), registra
  `last_error`. **Nunca desiste:** evento confirmado não pode ser perdido. A demora aparece na métrica
  de outbox lag.
- **Garantia: at-least-once.**
  - Morte antes de publicar → a linha continua pendente → outra instância publica. (Testado.)
  - Morte **depois** de publicar e **antes** do COMMIT → publicação duplicada. (Testado com
    `crash-after-publish-before-mark`.)
  - A duplicata é segura: o `eventId` é estável (é o id da linha) e o consumidor deduplica por ele. A
    fila FIFO também descarta a duplicata dentro de 5 minutos pelo `MessageDeduplicationId`, mas isso é
    otimização, não garantia.
- **Ordem:** dentro de um lote, os eventos de uma wallet saem em ordem (mesma pista). Entre publishers concorrentes, a
  ordem global por wallet **não** é garantida. Consumidores devem usar `walletVersion`
  (`WalletBalanceChanged`) para ordenar ou descartar eventos antigos. Ver limitações.

### Eventos

Uma classe abstrata `IntegrationEvent<T>` e uma subclasse por evento, com `eventType` e `version`
definidos **no tipo**. `toJSON()` produz o envelope gravado na outbox:

`{ eventId, eventType, aggregateId, correlationId, causationId?, occurredAt (ISO), version, data }`

| Evento | Quando | Observação |
|---|---|---|
| `WagerTransactionProcessed` | toda transação aplicada, **inclusive LOSS e OPENING** | inclui o saldo resultante |
| `WalletBalanceChanged` | **somente** quando há lançamento | construído a partir do lançamento; carrega `walletVersion` |
| `WagerTransactionRejected` | rejeição de negócio (inclui REFERENCE_NOT_FOUND) | `failureCode` |
| `WagerTransactionPendingReference` | ao **entrar** em espera | não repete a cada tentativa |

- `aggregateId = walletId` em todos: a wallet é a unidade de concorrência e de ordenação.
- `data` usa `MoneyProps` (string).
- `correlationId` vem do header `X-Correlation-Id`, do envelope da fila ou é gerado.
- `causationId` = `messageId` (fila), `Idempotency-Key` (HTTP) ou id da transação (worker).

Destino: `wallet-events.fifo`. O enunciado não define o destino; escolhi FIFO para preservar a ordem
por wallet entre os eventos de um mesmo lote.

---

## 11. Reconciliação

`POST /wallets/:id/reconciliation`:

- Lê a wallet com **`FOR SHARE`** (impede escritas nela durante a leitura, então saldo e ledger são
  lidos no mesmo instante lógico, sem falso alarme por corrida).
- Soma o ledger **no banco**, em `NUMERIC`: `Σ créditos − Σ débitos`, e conta os lançamentos.
- **Não corrige nada.** Uma divergência:
  - é logada como `error` (com saldo armazenado, calculado e diferença);
  - incrementa `wagering_reconciliations_total{result="mismatch"}`;
  - volta com `consistent: false`.
  Corrigir automaticamente esconderia um bug.

---

## 12. Observabilidade

**Logs (pino, JSON, uma linha por evento):**

- `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId` entram em todo log da
  operação, via `AsyncLocalStorage` (sem repassar à mão);
- `instanceId` e `service` em todos;
- **não** se loga payload financeiro nem corpo de requisição. Os logs têm só ids, status e códigos. Por
  segurança, `redact` remove campos como `payload`, `body`, `data`, `money` e `authorization`, caso
  alguém os passe por engano.

**Métricas (`GET /metrics`, Prometheus):**

| Métrica | Cobre |
|---|---|
| `wagering_transactions_total{status,kind,source}` | transações por status |
| `wagering_duplicates_detected_total{kind}` | `idempotent_replay`, `inbox_redelivery` |
| `wagering_retries_total{operation}` | `db_transaction`, `sqs_message`, `outbox_publish`, `pending_reference` |
| `wagering_dlq_messages_total{reason}` + `wagering_dlq_depth` | mensagens em DLQ (enviadas por esta instância + profundidade atual da fila) |
| `wagering_lock_conflicts_total{reason}` | `contended`, `timeout`, `deadlock` |
| `wagering_outbox_lag_seconds`, `wagering_outbox_pending_messages` | outbox lag (idade do evento pendente mais antigo) |
| `wagering_processing_duration_seconds{source}` | latência de processamento (histograma) |
| `wagering_reconciliations_total{result}` | divergências |

Os gauges de outbox e DLQ são calculados **na hora do scrape**, consultando o banco ou o SQS. Assim
refletem o estado global, não só o desta instância.

**Health:**

- `/health/live`: só o processo. Não depende de nada externo, então uma queda do banco não faz o
  orquestrador reiniciar todas as instâncias à toa.
- `/health/ready`: `SELECT 1` + `GetQueueAttributes`, com timeout de 2 s → 200 ou 503. A aplicação sobe
  mesmo com o banco fora (conexão sob demanda) e passa a ficar "ready" quando ele volta.

---

## 13. Autenticação (decisão: não implementada)

Conforme a seção 2, autenticação não vale pontos. Usei o tempo nas garantias financeiras.

**O que existe no código:**

- `ProviderIdentityPort`, com a implementação `NoopProviderIdentity`;
- `ProviderAuthGuard`, aplicado aos controllers de negócio;
- health e `/metrics` ficam abertos.

**Desenho que eu adotaria:**

1. **Keycloak** no compose: um *client* confidencial por provedor, com fluxo OAuth2
   `client_credentials`.
2. O provedor obtém um access token (JWT) e chama a API com `Authorization: Bearer`.
3. A implementação real de `ProviderIdentityPort` valida o JWT localmente:
   - assinatura via **JWKS** do realm (em cache, com rotação);
   - `iss`, `aud` e `exp`.
   Depois mapeia o client (`azp` ou um claim `provider_id`) para o `providerId`.
4. O guard responde **401** sem token válido e **403** se o `providerId` do body for diferente do
   autenticado. Assim um provedor não consegue operar como outro.
5. **Fila:** é tratada como canal interno confiável (a autorização fica na IAM da AWS). Mas o
   `providerId` da mensagem continua passando pelas mesmas validações de domínio (referência do mesmo
   provider, etc.).

Para ativar, basta trocar a implementação da porta. Controllers e use cases não mudam.

---

## 14. Testes

| Nível | O que garante | Infra |
|---|---|---|
| Unidade (95 de 166) | regras de domínio, máquina de estados, Money, hash, eventos | nenhuma |
| Integração | constraints atacadas por SQL, atomicidade, idempotência, inbox/redelivery, retry/DLQ, publishers concorrentes, contrato HTTP | **PostgreSQL + LocalStack em containers** |
| Concorrência | paralelismo real (dezenas de conexões), **3 processos separados**, SIGKILL depois do commit/antes do ack, SIGKILL antes de publicar, publicação duplicada, SIGTERM + restart no meio de uma rajada | **PostgreSQL + LocalStack em containers** |

- **Determinismo:**
  - as asserções verificam **invariantes** (1 débito, saldo final, status "um PROCESSED e um REJECTED"),
    não ordens de chegada;
  - esperas usam `waitUntil(condição)` em vez de sleeps fixos;
  - cada suíte recria o schema e usa filas próprias;
  - os pontos de crash são **injetados de forma determinística** (`FAULT_INJECTION`, desligado por
    padrão; o processo se mata com SIGKILL exatamente no ponto crítico).
- **Invariante final:** todos os testes de fluxo terminam com a reconciliação
  `wallet.balance == saldo reconstruído pelo ledger`.

---

## 15. Teste de carga (diferencial)

`bun run test:load`. Por padrão bate nas 3 instâncias do compose; `LOAD_SPAWN=3` sobe 3 processos locais.

**Metodologia:**

- 40 usuários virtuais em loop fechado (cada um manda a próxima requisição quando recebe a resposta);
- apostas de `1.00`, espalhadas em round-robin pelas 3 instâncias;
- **20%** das apostas na **mesma** wallet (hot wallet), o resto em 200 wallets;
- **10%** reenvios idênticos (replays);
- durante o teste, um "sistema downstream" consome a fila de eventos e deduplica por `eventId`;
- depois da carga:
  - mede quanto tempo a outbox leva para zerar;
  - soma as métricas das 3 instâncias;
  - roda a **reconciliação de todas as wallets**.

**Ambiente:** notebook de desenvolvimento com Windows + WSL2 e Docker Desktop, rodando **tudo junto na
mesma máquina**: o `docker compose` completo (PostgreSQL 16, LocalStack 4.12 e as 3 instâncias
`app-1..3`) e o próprio gerador de carga. Bun 1.4.4.

| Métrica | Resultado |
|---|---|
| Duração | 30 s |
| Requisições | 4.708 |
| Throughput | **~154 req/s** |
| Latência p50 / p95 / p99 | **65 ms / 1,5 s / 1,9 s** (máx. 2,8 s) |
| Taxa de erro | **0%** |
| Status | 4.262 × 201, 446 × 200 (replay) |
| Conflitos de lock (`contended`) | 900 |
| Retries de transação | 0 |
| Outbox lag ao final da carga | **0 s** (nada pendente) |
| Eventos recebidos downstream | 8.926, **todos com eventId único** (= 4.262 × 2 + 201 × 2 da abertura) |
| Reconciliação | **201/201 wallets consistentes** |

**Análise:**

- **O número absoluto diz pouco:** banco, emulador de SQS, 3 instâncias e o gerador disputam a mesma
  máquina. Isso mede o *comportamento* sob contenção, não a capacidade de produção.
- **A cauda (p95/p99) vem da hot wallet,** e é a consequência esperada da escolha pelo lock pessimista.
  As ~8 VUs simultâneas na mesma wallet fazem **fila** (900 esperas registradas em
  `lock_conflicts{contended}`), em vez de falharem. Nenhuma requisição foi rejeitada por concorrência e
  nenhum retry foi necessário. A mediana (65 ms) reflete as wallets sem disputa.
- **Outbox:** o publisher envia em **pistas paralelas por wallet** (preservando a ordem de cada wallet)
  e acompanhou a carga: nenhum evento pendente ao final. Em um ambiente mais lento (emulador SQS com
  `SendMessageBatch` levando ~1 s), o lag chegou a alguns segundos durante a carga e zerou logo depois.
  A métrica `wagering_outbox_lag_seconds` existe justamente para mostrar isso.
- **O que importa no desafio:** zero inconsistências, zero débitos duplicados (446 replays corretos),
  zero eventos perdidos e nenhuma duplicata por `eventId`.

---

## 16. Trade-offs e limitações

- **Lock pessimista segura conexões enquanto espera.** Uma wallet extremamente quente pode esgotar o pool.
  Mitigações: `lock_timeout` (5 s → 503, com retry seguro), pool configurável, métricas de contenção.
  Para escala maior, eu particionaria o consumo por `MessageGroupId = walletId` (já recomendado) para que
  a fila faça a serialização e o banco só a confirme.
- **Ordem global de eventos por wallet** não é garantida entre publishers concorrentes. Mitigação:
  `walletVersion` nos eventos. Alternativa: um publisher por partição de wallet (com lease), ao custo de
  mais complexidade.
- **Sondagem `NOWAIT` + `SAVEPOINT`** para medir contenção adiciona ~3 round-trips por operação. Pode
  ser removida se a métrica não for necessária.
- **Inbox e outbox crescem indefinidamente.** Faltam jobs de limpeza: inbox mais antiga que a janela de
  redelivery e outbox publicada há mais de N dias, ou particionamento por data.
- **Reconciliação é por wallet e sob demanda.** Uma varredura periódica de todas as wallets (com
  alerta) seria o próximo passo.
- **`WALLET_NOT_FOUND` não é persistido** (FK). A resposta é estável, mas não fica trilha no banco, só
  no log e na métrica.
- **Moeda:** o modelo é multi-moeda (wallet por player + moeda, validação e testes de conflito), mas não
  há conversão nem a regra de casas decimais por moeda (todas com 2, como pede o enunciado).
- **Autenticação** não implementada (ver §13).
- **Partidas dobradas** (double-entry) não implementado (opcional). O ledger é de entrada simples por
  wallet, com encadeamento por `wallet_version` e verificação aritmética no banco.
- **OpenTelemetry/dashboard** não implementados (opcionais). O `correlationId` atravessa HTTP, fila,
  logs e eventos, o que já permite rastrear manualmente.
- **Ambiente de validação:** a suíte inteira (166 testes) roda contra o PostgreSQL 16 e o LocalStack do
  `docker compose`, em containers, em Windows + WSL2 (~1 min). Os testes também funcionam com outros
  emuladores de SQS (MiniStack), porque só usam a API do SQS via SDK.
