FROM oven/bun:1 AS base
WORKDIR /app

# Dependências primeiro (melhor cache de camadas)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

ENV NODE_ENV=production
EXPOSE 3000

# Bun executa TypeScript diretamente, sem etapa de build.
# Bun é o PID 1 do container e recebe o SIGTERM do Docker diretamente.
CMD ["bun", "run", "src/main.ts"]
