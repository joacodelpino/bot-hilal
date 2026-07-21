FROM oven/bun:1.2-alpine

WORKDIR /app

# Dependencias primero (capa cacheada)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Prisma schema para generar el client
COPY prisma ./prisma
RUN bunx prisma generate

# Código fuente y datos
COPY src ./src
COPY data ./data
COPY tsconfig.json ./

EXPOSE 3001

CMD ["bun", "run", "src/index.ts"]
