import type { MoneyProps } from '../../domain/money/money';
import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { NotFoundError } from '../errors';
import type { TransactionRunner } from '../ports';
import { toWalletView, type WalletView } from '../wallets/open-wallet.use-case';

export const MAX_LEDGER_PAGE = 200;

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
  createdAt: string;
}

export interface LedgerPageView {
  items: LedgerEntryView[];
  nextCursor: string | null;
}

export interface TransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  status: string;
  failureCode?: string;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  balance: MoneyProps | null;
  createdAt: string;
  processedAt?: string;
}

/**
 * Cursor OPACO: o cliente só devolve o valor recebido, sem interpretar.
 * Por dentro é base64url de {v: walletVersion}. Como walletVersion é único e crescente
 * por wallet (e o ledger é append-only), a paginação é ESTÁVEL: não pula nem repete itens
 * mesmo com novos lançamentos chegando entre as páginas.
 */
export const encodeCursor = (walletVersion: number): string =>
  Buffer.from(JSON.stringify({ v: walletVersion }), 'utf8').toString('base64url');

export function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { v?: unknown };
    if (typeof parsed.v === 'number' && Number.isInteger(parsed.v) && parsed.v >= 0) return parsed.v;
  } catch {
    /* cai no erro abaixo */
  }
  throw new InvalidCursorError();
}

export class InvalidCursorError extends Error {
  readonly code = 'INVALID_CURSOR';
  constructor() {
    super('Invalid cursor');
  }
}

const toLedgerView = (e: WalletLedgerEntry): LedgerEntryView => ({
  id: e.id,
  transactionId: e.transactionId,
  direction: e.direction,
  money: e.money.toJSON(),
  balanceBefore: e.balanceBefore.toJSON(),
  balanceAfter: e.balanceAfter.toJSON(),
  walletVersion: e.walletVersion,
  createdAt: e.createdAt.toISOString(),
});

export const toTransactionView = (tx: WagerTransaction): TransactionView => {
  const view: TransactionView = {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    status: tx.status,
    balance: tx.resultingBalance?.toJSON() ?? null,
    createdAt: tx.createdAt.toISOString(),
  };
  if (tx.failureCode) view.failureCode = tx.failureCode;
  if (tx.referenceExternalTransactionId) view.referenceExternalTransactionId = tx.referenceExternalTransactionId;
  if (tx.referenceTransactionId) view.referenceTransactionId = tx.referenceTransactionId;
  if (tx.processedAt) view.processedAt = tx.processedAt.toISOString();
  return view;
};

/** Consultas de leitura (sem lock). */
export class WageringQueries {
  constructor(private readonly runner: TransactionRunner) {}

  getWallet(walletId: string): Promise<WalletView> {
    return this.runner.run(async (uow) => {
      const wallet = await uow.wallets.findById(walletId);
      if (!wallet) throw new NotFoundError('WALLET_NOT_FOUND', `Wallet ${walletId} not found`);
      return toWalletView(wallet);
    });
  }

  getLedger(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPageView> {
    const afterVersion = decodeCursor(cursor);
    const pageSize = Math.min(Math.max(limit, 1), MAX_LEDGER_PAGE);
    return this.runner.run(async (uow) => {
      const wallet = await uow.wallets.findById(walletId);
      if (!wallet) throw new NotFoundError('WALLET_NOT_FOUND', `Wallet ${walletId} not found`);
      const page = await uow.ledger.listByWallet(walletId, afterVersion, pageSize);
      const last = page.entries.at(-1);
      return {
        items: page.entries.map(toLedgerView),
        nextCursor: page.hasMore && last ? encodeCursor(last.walletVersion) : null,
      };
    });
  }

  getTransaction(transactionId: string): Promise<TransactionView> {
    return this.runner.run(async (uow) => {
      const tx = await uow.transactions.findById(transactionId);
      if (!tx) throw new NotFoundError('TRANSACTION_NOT_FOUND', `Transaction ${transactionId} not found`);
      return toTransactionView(tx);
    });
  }

  getTransactionByExternalId(providerId: string, externalTransactionId: string): Promise<TransactionView> {
    return this.runner.run(async (uow) => {
      const tx = await uow.transactions.findByExternalId(providerId, externalTransactionId);
      if (!tx) {
        throw new NotFoundError('TRANSACTION_NOT_FOUND', `Transaction ${providerId}/${externalTransactionId} not found`);
      }
      return toTransactionView(tx);
    });
  }
}
