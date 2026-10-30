/**
 * Taxonomia de falhas de NEGÓCIO e de falhas permanentes de infraestrutura.
 *
 * Cada código é estável (contrato com o provedor) e diz o que o provedor deve fazer:
 * reenviar, corrigir o payload ou desistir. A tabela completa está em ARCHITECTURE.md.
 *
 * Erros de VALIDAÇÃO de payload (HTTP 400) e de CONFLITO (HTTP 409) não ficam aqui:
 * eles não geram transação persistida — ver src/application/errors.ts.
 */
export enum FailureCode {
  /** BET maior que o saldo. Provedor: desistir (não adianta reenviar). */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** ROLLBACK de crédito (WIN/REFUND) que deixaria saldo negativo. Provedor: escalar para operação. */
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  /** Moeda da operação ≠ moeda da wallet. Provedor: corrigir payload. */
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  /** A wallet informada pertence a outro player. Provedor: corrigir payload. */
  PlayerMismatch = 'PLAYER_MISMATCH',
  /** walletId inexistente. Provedor: corrigir payload. */
  WalletNotFound = 'WALLET_NOT_FOUND',
  /** Referência não apareceu dentro do limite de tentativas. Provedor: desistir/investigar. */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** Referência existe mas é de outro player/wallet/moeda/rodada. Provedor: corrigir payload. */
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  /** REFUND referenciando não-BET, ROLLBACK de LOSS/OPENING, etc. Provedor: corrigir payload. */
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND',
  /** A referência existe mas foi REJECTED/FAILED — não há o que reverter. Provedor: desistir. */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  /** Valor do REFUND/ROLLBACK ≠ valor da referência (reversão parcial fora de escopo). */
  ReversalAmountMismatch = 'REVERSAL_AMOUNT_MISMATCH',
  /** A referência já foi revertida. Provedor: desistir (já foi feito). */
  AlreadyReversed = 'ALREADY_REVERSED',
  /** Status FAILED: erro permanente de infraestrutura ao reprocessar. Auditável. */
  ProcessingFailed = 'PROCESSING_FAILED',
}
