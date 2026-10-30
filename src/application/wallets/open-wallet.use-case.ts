import { Money, type MoneyProps } from '../../domain/money/money';
import { WagerTransactionProcessed, WalletBalanceChanged } from '../../domain/events/wagering-events';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import { UniqueConstraintConflictError, WalletAlreadyExistsError } from '../errors';
import { computePayloadHash } from '../idempotency/payload-hash';
import type { AppLogger } from '../observability';
import type { Clock, IdGenerator, TransactionRunner } from '../ports';

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
}

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export const toWalletView = (w: Wallet): WalletView => ({
  id: w.id,
  playerId: w.playerId,
  balance: w.balance.toJSON(),
  version: w.version,
});

/** Provedor "interno" usado na transação OPENING (não pode ser enviada por provedores reais). */
export const INTERNAL_PROVIDER = 'internal';

/**
 * Cria a wallet. Se o saldo inicial for > 0, na MESMA transação SQL:
 *   wallet (version 1) + transação OPENING (PROCESSED) + lançamento CREDIT + eventos na outbox.
 */
export class OpenWalletUseCase {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly logger: AppLogger,
  ) {}

  async execute(cmd: OpenWalletCommand): Promise<WalletView> {
    const initialBalance = Money.from(cmd.initialBalance);

    try {
      const view = await this.runner.run(async (uow) => {
        const existing = await uow.wallets.findByPlayerAndCurrency(cmd.playerId, initialBalance.currency);
        if (existing) throw new WalletAlreadyExistsError(cmd.playerId, initialBalance.currency);

        const now = this.clock.now();
        const walletId = this.ids.next();
        const opening = initialBalance.isPositive()
          ? this.openingTransaction(walletId, cmd, initialBalance, now)
          : undefined;

        const { wallet, openingEntry } = Wallet.open({
          id: walletId,
          playerId: cmd.playerId,
          initialBalance,
          now,
          opening: opening ? { transactionId: opening.id, ledgerEntryId: this.ids.next() } : undefined,
        });
        await uow.wallets.insert(wallet);

        if (opening && openingEntry) {
          opening.markProcessed(undefined, now, wallet.balance);
          await uow.transactions.insert(opening);
          await uow.ledger.append(openingEntry);
          const ctx = { newId: () => this.ids.next(), correlationId: cmd.correlationId, occurredAt: now };
          await uow.outbox.add(OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, ctx)));
          await uow.outbox.add(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, openingEntry, ctx)));
        }
        return toWalletView(wallet);
      });
      this.logger.info('wallet opened', { walletId: view.id });
      return view;
    } catch (err) {
      // Duas criações simultâneas para o mesmo player+moeda: o UNIQUE do banco decide quem ganha.
      if (err instanceof UniqueConstraintConflictError && err.constraint === 'wallet_player_currency_uq') {
        throw new WalletAlreadyExistsError(cmd.playerId, initialBalance.currency);
      }
      throw err;
    }
  }

  private openingTransaction(walletId: string, cmd: OpenWalletCommand, money: Money, now: Date): WagerTransaction {
    const externalTransactionId = `opening:${walletId}`;
    const payload = {
      providerId: INTERNAL_PROVIDER,
      externalTransactionId,
      playerId: cmd.playerId,
      walletId,
      roundId: 'opening',
      gameId: 'internal',
      kind: 'OPENING',
      money: money.toJSON(),
    };
    return WagerTransaction.createOpening({
      id: this.ids.next(),
      providerId: INTERNAL_PROVIDER,
      externalTransactionId,
      idempotencyKey: `${INTERNAL_PROVIDER}:${externalTransactionId}`,
      payloadHash: computePayloadHash(payload),
      walletId,
      playerId: cmd.playerId,
      roundId: payload.roundId,
      gameId: payload.gameId,
      money,
      correlationId: cmd.correlationId,
      createdAt: now,
    });
  }
}
