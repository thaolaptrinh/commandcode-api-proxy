#!/usr/bin/env node

import { loadConfig, fetchLatestCliVersion } from "@/config.js";
import { createServer } from "@/server.js";
import { saveApiKey, promptForApiKey, readAuthKey, deleteAuth } from "@/auth.js";
import { setupOpenCodeConfig } from "@/setup/opencode.js";
import { setupClaudeCodeConfig } from "@/setup/claude-code.js";
import { logger, initLogger } from "@/logger.js";
import { getProxyVersion } from "@/version.js";

const args = process.argv.slice(2);

if (args[0] === "auth") {
  const sub = args[1];
  if (sub === "login") {
    const force = args.includes("--force");
    const existing = readAuthKey();
    if (existing && !force) {
      console.log("\n  You are already logged in. Use `auth login --force` to overwrite.\n");
      process.exit(0);
    }
    console.log("\n  Get your API key from https://commandcode.ai/settings\n");
    const key = await promptForApiKey();
    if (!key) {
      console.error("  FATAL: API key is required.\n");
      process.exit(1);
    }
    saveApiKey(key);
    console.log("  ✓ API key saved to ~/.config/commandcode-api-proxy/auth.json\n");
  } else if (sub === "logout") {
    deleteAuth();
    console.log("\n  ✓ API key removed\n");
  } else {
    console.error("\n  Usage: commandcode-api-proxy auth <login|logout>\n");
  }
  process.exit(0);
}

if (args.includes("--setup-opencode")) {
  await setupOpenCodeConfig();
  process.exit(0);
}

if (args.includes("--setup-claude-code")) {
  const force = args.includes("--force");
  await setupClaudeCodeConfig(force);
  process.exit(0);
}

const config = loadConfig();
initLogger(config.logLevel);

logger.info(
  `API key source: ${process.env.CC_API_KEY ? "env CC_API_KEY" : config.apiKey ? "auth.json" : "none"} (length: ${config.apiKey?.length ?? 0})`,
);

if (!process.env.CC_CLI_VERSION) {
  const latest = await fetchLatestCliVersion();
  if (latest) config.ccVersion = latest;
}

if (!config.apiKey) {
  console.log("\n  No Command Code API key found.");
  console.log("  You can get one from https://commandcode.ai/settings\n");
  const key = await promptForApiKey();
  if (!key) {
    console.error("  FATAL: API key is required.\n");
    process.exit(1);
  }
  saveApiKey(key);
  config.apiKey = key;
  console.log("  ✓ API key saved to ~/.config/commandcode-api-proxy/auth.json\n");
}

const server = createServer(config);

server.listen(config.port, config.host, () => {
  console.log(`\n  Command Code API Proxy v${getProxyVersion()}`);
  console.log(`  ${"=".repeat(50)}`);
  console.log(`  Listening on  http://${config.host}:${config.port}`);
  console.log(`  Auth: ${config.apiKey ? "ENABLED (Bearer token or x-api-key)" : "DISABLED"}`);
  console.log("");
  console.log("  Endpoints:");
  console.log("    GET  /health");
  console.log("    GET  /v1/models");
  console.log("    POST /v1/chat/completions  (OpenAI format)");
  console.log("    POST /v1/messages          (Anthropic format)");
  console.log("    POST /v1/messages/count_tokens  (Anthropic format)");
  console.log("");
  console.log("  Press Ctrl+C to stop\n");
});

// Never let an unexpected async error crash the proxy silently — log and keep
// serving. (Route handlers already catch their own errors; this is a backstop.)
process.on("unhandledRejection", (reason) => {
  logger.error("[fatal] Unhandled promise rejection:", reason);
});
process.on("uncaughtException", (err) => {
  logger.error("[fatal] Uncaught exception:", err);
});

const shutdown = (signal: string): void => {
  logger.info(`Received ${signal}, shutting down...`);
  // Don't hang forever waiting on a stuck streaming connection.
  const force = setTimeout(() => {
    logger.warn("Forcing shutdown after 10s timeout");
    process.exit(1);
  }, 10_000);
  force.unref();
  server.close(() => process.exit(0));
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
