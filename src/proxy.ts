#!/usr/bin/env node

import { loadConfig, fetchLatestCliVersion } from "@/config.js";
import { createServer } from "@/server.js";
import { setupOpenCodeConfig } from "@/setup/opencode.js";
import { initLogger } from "@/logger.js";

const cli = process.argv.slice(2);
if (cli.includes("--setup-opencode")) {
  await setupOpenCodeConfig();
  process.exit(0);
}

const config = loadConfig();
initLogger(config.logLevel);

// Refresh the CLI version from npm so requests look current (CC blocks stale
// versions). Env override (CC_CLI_VERSION) always wins; the fetch only fills
// in when no override is set.
if (!process.env.CC_CLI_VERSION) {
  const latest = await fetchLatestCliVersion();
  if (latest) config.ccVersion = latest;
}

if (!config.apiKey) {
  console.error("FATAL: No Command Code API key found.");
  console.error("  Set CC_API_KEY environment variable or");
  console.error("  run `npx command-code` to authenticate first.");
  process.exit(1);
}

const server = createServer(config);

server.listen(config.port, config.host, () => {
  console.log(`\n  Command Code API Proxy v${process.env.npm_package_version ?? "0.1.0"}`);
  console.log(`  ${"=".repeat(50)}`);
  console.log(`  Listening on  http://${config.host}:${config.port}`);
  console.log(`  Auth: ${config.apiKey ? "ENABLED (Bearer token or x-api-key)" : "DISABLED"}`);
  console.log("");
  console.log("  Endpoints:");
  console.log("    GET  /health");
  console.log("    GET  /v1/models");
  console.log("    POST /v1/chat/completions  (OpenAI format)");
  console.log("");
  console.log("  Press Ctrl+C to stop\n");
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n  Shutting down...");
  server.close(() => process.exit(0));
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
