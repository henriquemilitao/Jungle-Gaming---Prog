/**
 * Backoff exponencial: espera cada vez mais entre tentativas, até um teto.
 *   tentativa 0 → base, 1 → 2×base, 2 → 4×base ... limitado a `maxMs`.
 *
 * Usado pela outbox (republicação) e pelas transações PENDING_REFERENCE.
 * Valores reais vêm da configuração, para que os testes possam usar delays curtos.
 */
export class ExponentialBackoff {
  constructor(
    private readonly baseMs: number,
    private readonly maxMs: number,
  ) {
    if (baseMs <= 0 || maxMs < baseMs) {
      throw new Error(`Invalid backoff configuration: base=${baseMs} max=${maxMs}`);
    }
  }

  delayMs(attempt: number): number {
    const exponent = Math.min(Math.max(attempt, 0), 30); // evita overflow de 2^n
    return Math.min(this.baseMs * 2 ** exponent, this.maxMs);
  }

  nextAttemptAt(now: Date, attempt: number): Date {
    return new Date(now.getTime() + this.delayMs(attempt));
  }
}
