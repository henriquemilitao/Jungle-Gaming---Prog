/**
 * Injeção de falhas para os testes de recuperação (seção 13: "worker morto depois do
 * commit e antes do ack", "processo morre antes de publicar").
 *
 * Desligado por padrão. Quando FAULT_INJECTION=<ponto> está definido, o processo se mata
 * com SIGKILL (igual a um `kill -9` / OOM: sem cleanup, sem shutdown gracioso) ao passar
 * por aquele ponto. Nunca deve ser configurado em produção.
 */
export type FaultPoint = 'crash-after-commit-before-ack' | 'crash-after-publish-before-mark';

export class FaultInjector {
  constructor(private readonly active: string) {}

  crashIf(point: FaultPoint): void {
    if (this.active !== point) return;
    process.stdout.write(`${JSON.stringify({ level: 'fatal', msg: 'fault injection: killing process', point })}\n`);
    process.kill(process.pid, 'SIGKILL');
  }
}
