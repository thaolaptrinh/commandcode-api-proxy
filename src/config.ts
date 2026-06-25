import fs from "node:fs";
import path from "node:path";

interface CliArgs {
  host?: string;
  port?: string;
  "api-key"?: string;
}

export interface Config {
  host: string;
  port: number;
  apiKey: string | null;
  ccApiBase: string;
  ccVersion: string;
  logLevel: string;
}

/**
 * Hardcoded CLI version fallback. The real CLI ships frequent releases, so
 * `fetchLatestCliVersion()` should be used to refresh this at startup. CC's
 * server actively blocks requests whose version looks stale or absent.
 */
export const DEFAULT_CC_VERSION = "0.40.3";
const CC_VERSION_REFRESH_MS = 24 * 60 * 60 * 1000;

let cachedVersion: string | null = null;
let lastFetchAt = 0;

/**
 * Fetch the latest published `command-code` CLI version from the npm registry.
 * Returns `null` on any failure (caller falls back to DEFAULT_CC_VERSION).
 * Cached for CC_VERSION_REFRESH_MS.
 */
export async function fetchLatestCliVersion(): Promise<string | null> {
  if (cachedVersion && Date.now() - lastFetchAt < CC_VERSION_REFRESH_MS) {
    return cachedVersion;
  }
  try {
    const res = await fetch("https://registry.npmjs.org/command-code/latest", {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const pkg = (await res.json()) as { version?: string };
    if (pkg.version && typeof pkg.version === "string") {
      cachedVersion = pkg.version;
      lastFetchAt = Date.now();
      return cachedVersion;
    }
    return null;
  } catch {
    return null;
  }
}

function parseCliArgs(): CliArgs {
  const args = process.argv.slice(2);
  const map: CliArgs = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const val = args[i + 1];
      if (val && !val.startsWith("--")) {
        (map as Record<string, string | undefined>)[key] = val;
        i++;
      }
    }
  }
  return map;
}

function readAuthJson(): string | null {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return null;

  const paths = [
    path.join(home, ".commandcode", "auth.json"),
    path.join(home, ".config", "commandcode", "auth.json"),
  ];

  for (const p of paths) {
    try {
      const raw = fs.readFileSync(p, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed.apiKey) return parsed.apiKey;
      if (parsed.accessToken) return parsed.accessToken;
      if (parsed.token) return parsed.token;
    } catch {
      continue;
    }
  }
  return null;
}

export function loadConfig(): Config {
  const cli = parseCliArgs();

  const host = cli.host || process.env.HOST || "127.0.0.1";
  const port = parseInt(cli.port || process.env.PORT || "8787", 10);
  const apiKey = cli["api-key"] || process.env.CC_API_KEY || readAuthJson() || null;
  const ccApiBase = process.env.CC_API_BASE || "https://api.commandcode.ai";
  const ccVersion = process.env.CC_CLI_VERSION || cachedVersion || DEFAULT_CC_VERSION;
  const logLevel = process.env.LOG_LEVEL || "info";

  return { host, port, apiKey, ccApiBase, ccVersion, logLevel };
}
