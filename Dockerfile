FROM node:24-alpine AS builder
RUN corepack enable pnpm
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY src/ src/
COPY tsconfig.json ./
RUN pnpm build

FROM node:24-alpine AS runner
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./
EXPOSE 8787
ENV HOST=0.0.0.0
ENV PORT=8787
ENTRYPOINT ["node", "dist/proxy.js"]
