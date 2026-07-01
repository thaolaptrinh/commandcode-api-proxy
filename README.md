# Command Code API Proxy

**OpenAI-compatible API proxy for [Command Code](https://commandcode.ai).**
Use your Command Code subscription from **any** OpenAI-compatible client — OpenCode, Continue, the OpenAI SDK, or plain `curl`.

```
npx commandcode-api-proxy
```

## Why?

Command Code exposes two API surfaces:

| Surface                         | Protocol                      | Plan required                   |
| ------------------------------- | ----------------------------- | ------------------------------- |
| `/provider/v1/chat/completions` | OpenAI-compatible             | **Provider** tier (paid add-on) |
| `/alpha/generate`               | Custom (Vercel AI SDK stream) | Your standard subscription      |

This proxy talks `/alpha/generate` upstream and standard OpenAI downstream — so your existing plan works from any tool.

## Quick start

```bash
# Run directly (no install)
npx commandcode-api-proxy

# Or install globally
npm install -g commandcode-api-proxy
commandcode-api-proxy
```

### Authentication

The proxy loads your API key from (in order of priority):

1. `--api-key` CLI flag: `npx commandcode-api-proxy --api-key user_xxx`
2. `CC_API_KEY` environment variable
3. `~/.config/commandcode-api-proxy/auth.json` (saved via `auth login`)

On first run without a key, the proxy prompts you to enter one and persists it.

#### CLI auth commands

```bash
# Save a new API key
commandcode-api-proxy auth login

# Overwrite existing key
commandcode-api-proxy auth login --force

# Remove saved key
commandcode-api-proxy auth logout
```

Get your API key from https://commandcode.ai/settings.

### CLI options

| Option                | Description                       | Default     |
| --------------------- | --------------------------------- | ----------- |
| `--host`              | Bind address                      | `127.0.0.1` |
| `--port`              | Port                              | `8787`      |
| `--api-key`           | Command Code API key              | —           |
| `--setup-opencode`    | Generate OpenCode provider config | —           |
| `--setup-claude-code` | Generate Claude Code model config | —           |

## Endpoints

### `POST /v1/chat/completions` (OpenAI)

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer proxy-managed" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek/deepseek-v4-pro",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

### `POST /v1/messages` (Anthropic)

```bash
curl http://127.0.0.1:8787/v1/messages \
  -H "x-api-key: proxy-managed" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5-20250929",
    "max_tokens": 4096,
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

### `POST /v1/messages/count_tokens` (Anthropic)

```bash
curl http://127.0.0.1:8787/v1/messages/count_tokens \
  -H "x-api-key: proxy-managed" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### Anthropic model mapping

Anthropic clients send Claude model IDs (e.g., `claude-sonnet-4-5-20250929`).
The proxy maps them to CC models via a config file with glob wildcards:

```bash
npx commandcode-api-proxy --setup-claude-code
```

This writes `~/.config/commandcode-api-proxy/anthropic-models.json`:

```json
{
  "default": "deepseek/deepseek-v4-pro",
  "mappings": {
    "claude-sonnet-*": "deepseek/deepseek-v4-pro",
    "claude-opus-*": "deepseek/deepseek-v4-pro",
    "claude-haiku-*": "deepseek/deepseek-v4-flash"
  }
}
```

**Glob matching:** `*` matches any characters. First matching pattern wins —
put specific patterns before general ones (e.g. `claude-sonnet-*` before
`claude-*`). Edit the file to customize mappings, then restart the proxy.

Non-Claude model IDs pass through unchanged.

**Optional override:** Set `ANTHROPIC_DEFAULT_MODEL` env var to override the
config file's `default` field without editing the file.

### Anthropic limitations

- **Thinking signatures**: placeholder only (not cryptographically signed).
- **Cache control**: stripped (no CC analogue).
- **Count tokens**: heuristic estimate, not exact.
- **Built-in/server tools** (`computer_`, `bash_`, `web_search_`, etc.):
  rejected with `invalid_request_error`. Only custom tools supported.
- **`metadata`, `top_k`, `top_p`, `service_tier`**: accepted but dropped.

## Client configuration

### OpenCode

Run setup (writes to `~/.config/opencode/opencode.json`):

```bash
npx commandcode-api-proxy --setup-opencode
```

Or add manually:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "commandcode": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Command Code",
      "options": {
        "baseURL": "http://127.0.0.1:8787/v1",
        "apiKey": "proxy-managed"
      },
      "models": {
        "deepseek-v4-pro": {
          "name": "DeepSeek V4 Pro",
          "limit": { "context": 1048576, "output": 393216 }
        },
        "deepseek-v4-flash": {
          "name": "DeepSeek V4 Flash",
          "limit": { "context": 1048576, "output": 393216 }
        },
        "MiniMax-M2.7": { "name": "MiniMax M2.7", "limit": { "context": 204800, "output": 32768 } },
        "MiniMax-M2.5": { "name": "MiniMax M2.5", "limit": { "context": 204800, "output": 32768 } },
        "GLM-5.1": { "name": "GLM-5.1", "limit": { "context": 200000, "output": 131072 } },
        "GLM-5": { "name": "GLM-5", "limit": { "context": 200000, "output": 131072 } },
        "Kimi-K2.6": { "name": "Kimi K2.6", "limit": { "context": 262144, "output": 98304 } },
        "Kimi-K2.5": { "name": "Kimi K2.5", "limit": { "context": 262144, "output": 98304 } },
        "Qwen3.6-Max-Preview": {
          "name": "Qwen 3.6 Max Preview",
          "limit": { "context": 262144, "output": 65536 }
        },
        "Qwen3.6-Plus": {
          "name": "Qwen 3.6 Plus",
          "limit": { "context": 1048576, "output": 65536 }
        },
        "Qwen3.7-Max": { "name": "Qwen 3.7 Max", "limit": { "context": 1048576, "output": 65536 } },
        "Qwen3.7-Plus": {
          "name": "Qwen 3.7 Plus",
          "limit": { "context": 1048576, "output": 65536 }
        },
        "Step-3.5-Flash": {
          "name": "Step 3.5 Flash",
          "limit": { "context": 262144, "output": 65536 }
        },
        "mimo-v2.5": { "name": "MiMo V2.5", "limit": { "context": 1048576, "output": 131072 } }
      }
    }
  }
}
```

### OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8787/v1",
    api_key="proxy-managed",
)

response = client.chat.completions.create(
    model="deepseek/deepseek-v4-pro",
    messages=[{"role": "user", "content": "Hello!"}],
)
```

### Continue

```json
{
  "models": [
    {
      "title": "Command Code",
      "provider": "openai",
      "model": "deepseek/deepseek-v4-pro",
      "apiKey": "proxy-managed",
      "apiBase": "http://127.0.0.1:8787/v1"
    }
  ]
}
```

### Claude Code

Run the proxy's setup to generate model config and Claude Code settings:

```bash
npx commandcode-api-proxy --setup-claude-code
```

This creates:

1. Model mapping config at `~/.config/commandcode-api-proxy/anthropic-models.json`
2. Claude Code settings at `~/.config/commandcode-api-proxy/claude-settings.json`

Then run:

```bash
claude --settings ~/.config/commandcode-api-proxy/claude-settings.json
```

Or set an alias:

```bash
alias claude-proxy="claude --settings ~/.config/commandcode-api-proxy/claude-settings.json"
claude-proxy
```

### Anthropic SDK (Python)

```python
from anthropic import Anthropic

client = Anthropic(
    base_url="http://127.0.0.1:8787/v1",
    api_key="proxy-managed",
)

message = client.messages.create(
    model="claude-sonnet-4-5-20250929",
    max_tokens=4096,
    messages=[{"role": "user", "content": "Hello!"}],
)
```

## Model aliases

Short names work in addition to full model IDs:

| Alias                                 | Maps to                      |
| ------------------------------------- | ---------------------------- |
| `deepseek-v4-pro`, `deepseek-v4`      | `deepseek/deepseek-v4-pro`   |
| `deepseek-v4-flash`, `deepseek-flash` | `deepseek/deepseek-v4-flash` |
| `minimax-m2.7`, `minimax-m2.5`        | `MiniMaxAI/MiniMax-*`        |
| `glm-5.1`, `glm-5`                    | `zai-org/GLM-*`              |
| `kimi-k2.6`, `kimi-k2.5`              | `moonshotai/Kimi-*`          |
| `qwen3.6-max`, `qwen3.6-plus`         | `Qwen/Qwen3.6-*`             |
| `step3.5`                             | `stepfun/Step-3.5-Flash`     |
| `mimo-v2.5`                           | `xiaomi/mimo-v2.5`           |

Any model ID is passed through as-is — the proxy does not validate against a fixed list.

## License

MIT
