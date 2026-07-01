# Development

## Prerequisites

- Node.js >= 24
- pnpm

## Setup

```bash
git clone https://github.com/thaolaptrinh/commandcode-api-proxy.git
cd commandcode-api-proxy
pnpm install
```

## Commands

```bash
pnpm install      # Install dependencies
pnpm dev          # Dev mode with hot reload (tsx)
pnpm build        # Build to dist/
pnpm test         # Run tests
pnpm test:watch   # Run tests in watch mode
pnpm test:coverage # Run tests with coverage

# Auth management
pnpm auth login   # Save API key
pnpm auth logout  # Remove saved API key

# OpenCode setup
pnpm build && node dist/proxy.js --setup-opencode
```

Scripts are defined in `package.json`. The `make` shortcuts are also available if you have `make` installed.

## Project structure

```
src/
├── proxy.ts              # Entry point (server, auth CLI, setup)
├── auth.ts               # Auth helpers: read/save/delete key, masked prompt
├── config.ts             # Config loader (env, CLI, auth.json)
├── logger.ts             # Structured logger
├── server.ts             # HTTP server & routes
├── models.json           # Model list, aliases, context windows
├── stream.ts             # NDJSON parser & SSE formatter
├── upstream.ts           # CC API client
├── setup/
│   └── opencode.ts       # opencode.json bootstrap helper
├── translate/
│   ├── types.ts          # Shared types (OpenAI, CC, UsageData)
│   ├── models.ts         # Model resolution & aliasing
│   ├── util.ts           # CC helpers (usage, tool pruning, safeguard)
│   ├── validation.ts     # Request validation (OpenAI + Anthropic)
│   ├── openai.ts         # OpenAI ↔ CC translation
│   ├── anthropic-types.ts # Anthropic API types
│   ├── anthropic-models.ts # Env-based Anthropic model mapping
│   └── anthropic.ts      # Anthropic ↔ CC translation
setup/
│   └── opencode.ts       # opencode.json bootstrap helper
tests/
├── auth.test.ts          # Auth module tests
├── config.test.ts        # Config loader tests
├── server.test.ts        # HTTP server tests
├── stream.test.ts        # NDJSON parser & SSE tests
├── translate.test.ts     # OpenAI translation layer tests
├── translate-anthropic.test.ts # Anthropic translation tests
├── anthropic-models.test.ts    # Model mapping tests
├── upstream.test.ts      # Upstream client tests
├── openai-schema.test.ts # ModelMessage[] schema conformance & usage
└── e2e.test.ts           # End-to-end integration tests
```

## Docker

```bash
# Build
docker build -t commandcode-api-proxy .

# Run with env var
docker run --rm -p 8787:8787 \
  -e CC_API_KEY=user_xxx \
  commandcode-api-proxy

# Or mount auth.json
docker run --rm -p 8787:8787 \
  -v ~/.config/commandcode-api-proxy:/home/node/.config/commandcode-api-proxy:ro \
  commandcode-api-proxy

# Using docker compose
docker compose up -d
```

## Tech stack

- **Runtime:** Node.js (zero runtime dependencies)
- **Build:** TypeScript + tsc-alias
- **Test:** Vitest
- **Lint:** Oxlint (via vite-plus)
- **Format:** Oxfmt (via vite-plus)
