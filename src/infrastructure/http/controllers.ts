import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { WageringQueries } from '../../application/queries/queries';
import { ProcessWagerTransactionUseCase } from '../../application/wagering/process-wager-transaction.use-case';
import type { WagerResult } from '../../application/wagering/wager-result';
import { OpenWalletUseCase } from '../../application/wallets/open-wallet.use-case';
import { ReconcileWalletUseCase } from '../../application/wallets/reconcile-wallet.use-case';
import { WagerTransactionStatus, type WagerTransactionKind } from '../../domain/wagering/wager-transaction';
import { logContext } from '../observability/log-context';
import { ProviderAuthGuard } from './auth';
import { idempotencyKeySchema, ledgerQuerySchema, openWalletSchema, parse, submitWagerSchema, uuidParam } from './schemas';

/** Status HTTP de um resultado de transação (aceita/rejeitada/pendente). */
export function statusFor(result: WagerResult): number {
  switch (result.status) {
    case WagerTransactionStatus.Processed:
      return result.idempotentReplay ? 200 : 201;
    case WagerTransactionStatus.PendingReference:
      return 202; // aceita; será aplicada quando a referência chegar
    default:
      return 422; // REJECTED (regra de negócio) — o failureCode diz o motivo
  }
}

const correlationId = () => logContext.get().correlationId ?? 'unknown';

@Controller('wallets')
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(
    @Inject(OpenWalletUseCase) private readonly openWallet: OpenWalletUseCase,
    @Inject(ReconcileWalletUseCase) private readonly reconcile: ReconcileWalletUseCase,
    @Inject(WageringQueries) private readonly queries: WageringQueries,
  ) {}

  @Post()
  @HttpCode(201)
  create(@Body() body: unknown) {
    const input = parse(openWalletSchema, body, 'wallet');
    return this.openWallet.execute({ ...input, correlationId: correlationId() });
  }

  @Get(':walletId')
  get(@Param('walletId') walletId: string) {
    return this.queries.getWallet(parse(uuidParam, walletId, 'walletId'));
  }

  @Get(':walletId/ledger')
  ledger(@Param('walletId') walletId: string, @Query() query: unknown) {
    const { cursor, limit } = parse(ledgerQuerySchema, query, 'query');
    return this.queries.getLedger(parse(uuidParam, walletId, 'walletId'), cursor, limit ?? 50);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  reconciliation(@Param('walletId') walletId: string) {
    return this.reconcile.execute(parse(uuidParam, walletId, 'walletId'));
  }
}

@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  constructor(
    @Inject(ProcessWagerTransactionUseCase) private readonly processWager: ProcessWagerTransactionUseCase,
    @Inject(WageringQueries) private readonly queries: WageringQueries,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const idempotencyKey = parse(idempotencyKeySchema, idempotencyKeyHeader, 'Idempotency-Key header');
    const payload = parse(submitWagerSchema, body, 'transaction');
    logContext.set({ walletId: payload.walletId, providerId: payload.providerId });

    const outcome = await this.processWager.execute({
      idempotencyKey,
      payload: { ...payload, kind: payload.kind as WagerTransactionKind },
      source: { type: 'http' },
      correlationId: correlationId(),
    });
    // Pela API nunca há "duplicate_message" (isso é da inbox da fila).
    const result = outcome as WagerResult;
    if (result.transactionId) logContext.set({ transactionId: result.transactionId });

    res.status(statusFor(result));
    const response: Record<string, unknown> = {
      transactionId: result.transactionId,
      status: result.status,
      balance: result.balance,
      idempotentReplay: result.idempotentReplay,
    };
    if (result.failureCode) response.failureCode = result.failureCode;
    return response;
  }

  @Get('wagering/transactions/:transactionId')
  get(@Param('transactionId') transactionId: string) {
    return this.queries.getTransaction(parse(uuidParam, transactionId, 'transactionId'));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  getByExternal(@Param('providerId') providerId: string, @Param('externalTransactionId') externalTransactionId: string) {
    return this.queries.getTransactionByExternalId(providerId, externalTransactionId);
  }
}
