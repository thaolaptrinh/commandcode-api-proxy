import { readAuthKey } from "@/auth.js";

interface CliArgs {
  host?: string;
  port?: string;
  "api-key"?: string;
  "setup-opencode"?: boolean;
}

export interface Config {
  host: string;
  port: number;
  apiKey: string | null;
  ccApiBase: string;
  ccVersion: string;
  logLevel: string;
  corsOrigin: string;
  /** Max wall-clock ms for upstream to send response headers + first byte. */
  upstreamTimeoutMs: number;
  /** Max ms between consecutive chunks during streaming. 0 = disabled. */
  idleTimeoutMs: number;
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
      } else {
        (map as Record<string, boolean>)[key] = true;
      }
    }
  }
  return map;
}

export function loadConfig(): Config {
  const cli = parseCliArgs();

  const host = cli.host || process.env.HOST || "127.0.0.1";
  const port = parseInt(cli.port || process.env.PORT || "8787", 10);
  const apiKey = cli["api-key"] || process.env.CC_API_KEY || readAuthKey();
  const ccApiBase = process.env.CC_API_BASE || "https://api.commandcode.ai";
  const ccVersion = process.env.CC_CLI_VERSION || cachedVersion || DEFAULT_CC_VERSION;
  const logLevel = process.env.LOG_LEVEL || "info";
  // `*` is fine for a localhost proxy; restrict (e.g. to an origin or leave
  // empty to disable) before exposing the proxy on a network.
  const corsOrigin = process.env.CORS_ORIGIN ?? "*";

  // Upstream timeouts. The connection timeout covers the wall-clock time
  // until the upstream returns response headers + first byte — bump it for
  // slow reasoning models. The idle timeout catches stalled streams where
  // the upstream opened the connection but stopped sending chunks
  // mid-response (e.g. tool call hung on the upstream side). Set
  // CC_IDLE_TIMEOUT_MS=0 to disable idle detection entirely.
  const upstreamTimeoutMs = parsePositiveInt(
    process.env.CC_UPSTREAM_TIMEOUT_MS,
    600_000, // 10 minutes — covers high-effort reasoning models
  );
  const idleTimeoutMs = parsePositiveInt(process.env.CC_IDLE_TIMEOUT_MS, 120_000); // 2 minutes

  return {
    host,
    port,
    apiKey,
    ccApiBase,
    ccVersion,
    logLevel,
    corsOrigin,
    upstreamTimeoutMs,
    idleTimeoutMs,
  };
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}
