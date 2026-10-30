import { Migration } from '@mikro-orm/migrations';

/**
 * Schema inicial.
 *
 * As garantias de UNICIDADE, IMUTABILIDADE e NÃO-NEGATIVIDADE ficam aqui, no banco,
 * e não só no código (seção 5, item 9). Mesmo um bug na aplicação — ou alguém
 * rodando SQL na mão — não consegue:
 *   - criar duas wallets para o mesmo player+moeda          (UNIQUE)
 *   - deixar saldo negativo                                  (CHECK)
 *   - mudar o saldo sem um lançamento no ledger              (constraint trigger)
 *   - editar/apagar o ledger                                 (trigger append-only)
 *   - lançamento com aritmética errada                       (CHECK)
 *   - processar a mesma idempotency key duas vezes           (UNIQUE)
 *   - reverter a mesma transação duas vezes                  (índice único parcial)
 *   - tirar uma transação de um estado terminal              (trigger)
 *   - processar a mesma mensagem SQS duas vezes              (PK da inbox)
 *
 * Reversível: `down()` desfaz tudo na ordem inversa.
 */
export class Migration20261030120000_initial_schema extends Migration {
  override async up(): Promise<void> {
    // ------------------------------------------------------------------ wallet
    this.addSql(`
      create table wallet (
        id              uuid           primary key,
        player_id       uuid           not null,
        currency        char(3)        not null,
        balance_amount  numeric(19,2)  not null,
        version         integer        not null,
        created_at      timestamptz    not null,
        updated_at      timestamptz    not null,
        constraint wallet_player_currency_uq unique (player_id, currency),
        constraint wallet_balance_non_negative_ck check (balance_amount >= 0),
        constraint wallet_version_positive_ck check (version >= 1),
        constraint wallet_currency_iso_ck check (currency ~ '^[A-Z]{3}$')
      );
    `);

    // ------------------------------------------------------- wager_transaction
    this.addSql(`
      create table wager_transaction (
        id                                 uuid           primary key,
        provider_id                        varchar(100)   not null,
        external_transaction_id            varchar(200)   not null,
        idempotency_key                    varchar(300)   not null,
        payload_hash                       char(64)       not null,
        wallet_id                          uuid           not null references wallet (id) deferrable initially deferred,
        player_id                          uuid           not null,
        round_id                           varchar(200)   not null,
        game_id                            varchar(200)   not null,
        kind                               varchar(16)    not null,
        amount                             numeric(19,2)  not null,
        currency                           char(3)        not null,
        reference_external_transaction_id  varchar(200),
        reference_transaction_id           uuid           references wager_transaction (id) deferrable initially deferred,
        status                             varchar(20)    not null,
        failure_code                       varchar(50),
        resulting_balance_amount           numeric(19,2),
        reference_attempts                 integer        not null default 0,
        next_reference_attempt_at          timestamptz,
        correlation_id                     varchar(200)   not null,
        created_at                         timestamptz    not null,
        processed_at                       timestamptz,
        updated_at                         timestamptz    not null,

        -- Idempotência: a key é a fonte da verdade; e um id externo por provedor.
        constraint wager_tx_idempotency_key_uq unique (idempotency_key),
        constraint wager_tx_provider_external_uq unique (provider_id, external_transaction_id),

        constraint wager_tx_kind_ck check (kind in ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        constraint wager_tx_status_ck check (status in ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        -- Só LOSS pode ter valor zero; nada é negativo.
        constraint wager_tx_amount_ck check (amount > 0 or (kind = 'LOSS' and amount = 0)),
        constraint wager_tx_resulting_balance_ck check (resulting_balance_amount is null or resulting_balance_amount >= 0),
        -- REFUND/ROLLBACK exigem referência; BET/OPENING não podem ter.
        constraint wager_tx_reference_required_ck check (
          kind not in ('REFUND','ROLLBACK') or reference_external_transaction_id is not null
        ),
        constraint wager_tx_reference_forbidden_ck check (
          kind not in ('BET','OPENING') or reference_external_transaction_id is null
        ),
        -- REJECTED/FAILED sempre têm failureCode; os demais nunca.
        constraint wager_tx_failure_code_ck check (
          (status in ('REJECTED','FAILED')) = (failure_code is not null)
        ),
        constraint wager_tx_processed_at_ck check ((status = 'PROCESSED') = (processed_at is not null)),
        constraint wager_tx_pending_schedule_ck check (
          (status = 'PENDING_REFERENCE') = (next_reference_attempt_at is not null)
        )
      );
    `);

    // Uma transação só pode ser revertida UMA vez (por REFUND ou ROLLBACK).
    this.addSql(`
      create unique index wager_tx_single_reversal_uq
        on wager_transaction (reference_transaction_id)
        where kind in ('REFUND','ROLLBACK') and status = 'PROCESSED';
    `);
    // Worker de PENDING_REFERENCE: busca só o que está vencido.
    this.addSql(`
      create index wager_tx_pending_reference_due_idx
        on wager_transaction (next_reference_attempt_at)
        where status = 'PENDING_REFERENCE';
    `);
    // Acelera "acordar" dependentes quando a referência chega.
    this.addSql(`
      create index wager_tx_waiting_on_reference_idx
        on wager_transaction (provider_id, reference_external_transaction_id)
        where status = 'PENDING_REFERENCE';
    `);
    this.addSql(`create index wager_tx_wallet_created_idx on wager_transaction (wallet_id, created_at);`);

    // ------------------------------------------------------ wallet_ledger_entry
    this.addSql(`
      create table wallet_ledger_entry (
        id              uuid           primary key,
        wallet_id       uuid           not null references wallet (id) deferrable initially deferred,
        transaction_id  uuid           not null references wager_transaction (id) deferrable initially deferred,
        direction       varchar(6)     not null,
        amount          numeric(19,2)  not null,
        currency        char(3)        not null,
        balance_before  numeric(19,2)  not null,
        balance_after   numeric(19,2)  not null,
        wallet_version  integer        not null,
        created_at      timestamptz    not null,

        -- No máximo um lançamento por transação por wallet.
        constraint ledger_transaction_wallet_uq unique (transaction_id, wallet_id),
        -- Encadeamento: versão 1, 2, 3... sem duplicatas. Também é o cursor estável da paginação.
        constraint ledger_wallet_version_uq unique (wallet_id, wallet_version),
        constraint ledger_direction_ck check (direction in ('DEBIT','CREDIT')),
        constraint ledger_amount_positive_ck check (amount > 0),
        constraint ledger_balances_non_negative_ck check (balance_before >= 0 and balance_after >= 0),
        -- Aritmética do lançamento verificada pelo banco.
        constraint ledger_balanced_ck check (
          (direction = 'CREDIT' and balance_after = balance_before + amount) or
          (direction = 'DEBIT'  and balance_after = balance_before - amount)
        )
      );
    `);

    // Ledger append-only: UPDATE, DELETE e TRUNCATE são proibidos.
    this.addSql(`
      create function ledger_block_mutation() returns trigger language plpgsql as $$
      begin
        raise exception 'wallet_ledger_entry is append-only (% is not allowed)', tg_op
          using errcode = 'P0001';
      end;
      $$;
    `);
    this.addSql(`
      create trigger ledger_no_update_delete
        before update or delete on wallet_ledger_entry
        for each row execute function ledger_block_mutation();
    `);
    this.addSql(`
      create trigger ledger_no_truncate
        before truncate on wallet_ledger_entry
        for each statement execute function ledger_block_mutation();
    `);

    // Wallet: campos de identidade imutáveis; saldo só muda junto com version+1
    // e com um lançamento correspondente (checado no COMMIT — constraint trigger deferred).
    this.addSql(`
      create function wallet_guard_identity() returns trigger language plpgsql as $$
      begin
        if new.id <> old.id or new.player_id <> old.player_id or new.currency <> old.currency
           or new.created_at <> old.created_at then
          raise exception 'wallet identity columns are immutable';
        end if;
        if new.balance_amount = old.balance_amount and new.version <> old.version then
          raise exception 'wallet version may only change when the balance changes';
        end if;
        if new.balance_amount <> old.balance_amount and new.version <> old.version + 1 then
          raise exception 'wallet version must increment by exactly 1 when the balance changes';
        end if;
        return new;
      end;
      $$;
    `);
    this.addSql(`
      create trigger wallet_guard_identity
        before update on wallet
        for each row execute function wallet_guard_identity();
    `);
    this.addSql(`
      create function wallet_require_ledger_entry() returns trigger language plpgsql as $$
      begin
        if tg_op = 'INSERT' then
          if new.version <> 1 then
            raise exception 'a new wallet must start at version 1';
          end if;
          if new.balance_amount > 0 and not exists (
            select 1 from wallet_ledger_entry l
             where l.wallet_id = new.id and l.wallet_version = 1
               and l.balance_before = 0 and l.balance_after = new.balance_amount
          ) then
            raise exception 'wallet % opened with balance but without an OPENING ledger entry', new.id;
          end if;
        elsif new.balance_amount <> old.balance_amount then
          if not exists (
            select 1 from wallet_ledger_entry l
             where l.wallet_id = new.id and l.wallet_version = new.version
               and l.balance_before = old.balance_amount and l.balance_after = new.balance_amount
          ) then
            raise exception 'wallet % balance changed without a matching ledger entry', new.id;
          end if;
        end if;
        return null;
      end;
      $$;
    `);
    this.addSql(`
      create constraint trigger wallet_balance_has_ledger_entry
        after insert or update on wallet
        deferrable initially deferred
        for each row execute function wallet_require_ledger_entry();
    `);

    // Transação: campos de negócio imutáveis e estados terminais congelados.
    this.addSql(`
      create function wager_tx_guard() returns trigger language plpgsql as $$
      begin
        if old.status in ('PROCESSED','REJECTED','FAILED') then
          raise exception 'transaction % is terminal (%) and cannot change', old.id, old.status;
        end if;
        if new.provider_id <> old.provider_id
           or new.external_transaction_id <> old.external_transaction_id
           or new.idempotency_key <> old.idempotency_key
           or new.payload_hash <> old.payload_hash
           or new.wallet_id <> old.wallet_id
           or new.kind <> old.kind
           or new.amount <> old.amount
           or new.currency <> old.currency then
          raise exception 'transaction % business fields are immutable', old.id;
        end if;
        return new;
      end;
      $$;
    `);
    this.addSql(`
      create trigger wager_tx_guard
        before update on wager_transaction
        for each row execute function wager_tx_guard();
    `);
    this.addSql(`
      create trigger wager_tx_no_delete
        before delete on wager_transaction
        for each row execute function ledger_block_mutation();
    `);

    // ------------------------------------------------------------- inbox/outbox
    this.addSql(`
      create table inbox_message (
        consumer_name  varchar(100)  not null,
        message_id     varchar(200)  not null,
        payload_hash   char(64)      not null,
        received_at    timestamptz   not null,
        processed_at   timestamptz,
        constraint inbox_message_pk primary key (consumer_name, message_id)
      );
    `);

    this.addSql(`
      create table outbox_message (
        id               uuid          primary key,
        aggregate_id     uuid          not null,
        event_type       varchar(100)  not null,
        payload          jsonb         not null,
        occurred_at      timestamptz   not null,
        attempts         integer       not null default 0,
        next_attempt_at  timestamptz,
        published_at     timestamptz,
        last_error       varchar(500),
        constraint outbox_attempts_ck check (attempts >= 0),
        constraint outbox_schedule_ck check ((published_at is null) = (next_attempt_at is not null))
      );
    `);
    // O worker busca só pendentes e vencidos — índice parcial pequeno.
    this.addSql(`
      create index outbox_pending_due_idx on outbox_message (next_attempt_at) where published_at is null;
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop table if exists outbox_message;');
    this.addSql('drop table if exists inbox_message;');
    this.addSql('drop trigger if exists ledger_no_truncate on wallet_ledger_entry;');
    this.addSql('drop table if exists wallet_ledger_entry;');
    this.addSql('drop table if exists wager_transaction;');
    this.addSql('drop table if exists wallet;');
    this.addSql('drop function if exists wager_tx_guard();');
    this.addSql('drop function if exists wallet_require_ledger_entry();');
    this.addSql('drop function if exists wallet_guard_identity();');
    this.addSql('drop function if exists ledger_block_mutation();');
  }
}
