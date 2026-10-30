/**
 * Erro de domínio: representa uma REGRA DE NEGÓCIO violada
 * (ex.: moeda diferente, valor inválido), e não uma falha técnica
 * (ex.: banco fora do ar).
 *
 * Todo erro de domínio tem um `code` estável e legível por máquina.
 * A camada HTTP usa esse code para escolher o status (400/409/422...)
 * sem precisar interpretar a mensagem de texto.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Entrada que viola o contrato (formato inválido). Mapeado para HTTP 400. */
export class ValidationError extends DomainError {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Violação de invariante que NUNCA deveria acontecer se o código estiver correto
 * (ex.: transicionar uma transação já terminal). É erro de programação,
 * não caminho de negócio — por isso não vira 4xx, vira 500 e alerta.
 */
export class InvariantViolationError extends DomainError {
  readonly code = 'INVARIANT_VIOLATION';

  constructor(message: string) {
    super(message);
  }
}
