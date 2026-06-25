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
make install       # Install dependencies
make dev           # Dev mode with hot reload
make build         # Build to dist/
make test          # Run tests
make test-watch    # Run tests in watch mode
make test-coverage # Run tests with coverage
make lint          # Lint with oxlint
make fmt           # Format with oxfmt
make typecheck     # Type-check with tsc
make check         # Format + lint + typecheck + test + build
make docker-build  # Build Docker image
```

## Project structure

```
src/
├── proxy.ts              # Entry point
├── config.ts             # Config loader (env, CLI, auth.json)
├── logger.ts             # Structured logger
├── server.ts             # HTTP server & routes
├── models.json           # Model list & aliases
├── stream.ts             # NDJSON parser & SSE formatter
├── upstream.ts           # CC API client
├── setup/
│   └── opencode.ts       # opencode.json bootstrap helper
└── translate/
    ├── types.ts          # Shared types
    ├── models.ts         # Model resolution & aliasing
    ├── util.ts           # CC helpers (messageId, usage, tool pruning)
    ├── validation.ts     # Request validation
    └── openai.ts         # OpenAI ↔ CC translation
tests/
├── config.test.ts        # Config loader tests
├── server.test.ts        # HTTP server tests
├── stream.test.ts        # NDJSON parser & SSE tests
├── translate.test.ts     # Translation layer tests
├── upstream.test.ts      # Upstream client tests
├── openai-schema.test.ts # ModelMessage[] schema conformance & usage
└── e2e.test.ts           # End-to-end integration tests
```

## Docker

```bash
# Build
docker build -t commandcode-api-proxy .

# Run
docker run --rm -p 8787:8787 \
  -e CC_API_KEY=user_xxx \
  commandcode-api-proxy

# Or mount auth.json
docker run --rm -p 8787:8787 \
  -v ~/.commandcode:/home/node/.commandcode:ro \
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
