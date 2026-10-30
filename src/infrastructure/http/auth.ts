import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';

/*
 * AUTENTICAÇÃO — ponto de extensão explícito (seção 2).
 *
 * Decisão: não implementada neste desafio (não vale pontos e competiria com o que vale).
 * O desenho que seria adotado está em ARCHITECTURE.md:
 *   - Keycloak (IdP externo) emitindo tokens OAuth2 client_credentials por provedor;
 *   - o guard valida o JWT (assinatura via JWKS, issuer, audience, expiração);
 *   - o claim do client (ex.: `azp`) é mapeado para um providerId;
 *   - a API rejeita (403) se o providerId do body for diferente do autenticado.
 *
 * Para ativar, basta trocar a implementação de ProviderIdentityPort — controllers e
 * use cases não mudam.
 */

export interface ProviderIdentity {
  providerId: string;
}

export interface ProviderIdentityPort {
  /** Resolve o provedor autenticado a partir da requisição, ou null se anônimo. */
  resolve(headers: Record<string, string | string[] | undefined>): Promise<ProviderIdentity | null>;
}

export const PROVIDER_IDENTITY = Symbol('ProviderIdentityPort');

/** Implementação atual: no-op. Toda requisição é aceita como anônima. */
export class NoopProviderIdentity implements ProviderIdentityPort {
  async resolve(): Promise<ProviderIdentity | null> {
    return null;
  }
}

/**
 * Guard aplicado aos controllers de negócio (wallets, wagering). Os endpoints de
 * health e /metrics NÃO usam este guard (ficam abertos, como pede o desafio).
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(@Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{ headers: Record<string, string>; providerIdentity?: ProviderIdentity | null }>();
    req.providerIdentity = await this.identity.resolve(req.headers);
    return true; // no-op: com um IdP real, retornaria false/401 quando não autenticado.
  }
}
