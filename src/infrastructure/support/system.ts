import type { Clock, IdGenerator } from '../../application/ports';

/** UUID v7: ordenável por tempo (bom para índices) e gerado sem coordenação entre instâncias. */
export class UuidV7Generator implements IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
