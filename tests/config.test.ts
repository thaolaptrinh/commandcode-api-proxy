import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("loadConfig", () => {
  let tmpHome: string;

  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "cc-home-"));
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("uses default values when no env is set", async () => {
    vi.stubEnv("CC_API_KEY", "");
    vi.stubEnv("HOST", "");
    vi.stubEnv("PORT", "");
    vi.stubEnv("HOME", "");

    const { loadConfig } = await import("@/config.js");
    const config = loadConfig();

    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(8787);
    expect(config.apiKey).toBeNull();
    expect(config.ccApiBase).toBe("https://api.commandcode.ai");
    expect(config.ccVersion).toBe("0.40.3");
  });

  it("reads from environment variables", async () => {
    vi.stubEnv("CC_API_KEY", "user_test_key");
    vi.stubEnv("HOST", "0.0.0.0");
    vi.stubEnv("PORT", "9999");

    const { loadConfig } = await import("@/config.js");
    const config = loadConfig();

    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(9999);
    expect(config.apiKey).toBe("user_test_key");
  });

  it("reads from ~/.commandcode/auth.json when no env key", async () => {
    fs.mkdirSync(path.join(tmpHome, ".commandcode"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, ".commandcode", "auth.json"),
      JSON.stringify({ apiKey: "user_from_auth_json" }),
    );

    vi.stubEnv("CC_API_KEY", "");
    vi.stubEnv("HOME", tmpHome);

    const { loadConfig } = await import("@/config.js");
    const config = loadConfig();

    expect(config.apiKey).toBe("user_from_auth_json");
  });
});

describe("fetchLatestCliVersion", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("returns the latest version from the npm registry", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ version: "0.41.0" }), { status: 200 }),
    );

    const { fetchLatestCliVersion } = await import("@/config.js");
    const version = await fetchLatestCliVersion();

    expect(version).toBe("0.41.0");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://registry.npmjs.org/command-code/latest",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("returns null when the registry responds with an error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("not found", { status: 500 }));

    const { fetchLatestCliVersion } = await import("@/config.js");
    const version = await fetchLatestCliVersion();

    expect(version).toBeNull();
  });

  it("returns null when the request throws", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network down"));

    const { fetchLatestCliVersion } = await import("@/config.js");
    const version = await fetchLatestCliVersion();

    expect(version).toBeNull();
  });

  it("caches the result so subsequent calls do not refetch", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: "0.41.0" }), { status: 200 }));

    const { fetchLatestCliVersion } = await import("@/config.js");
    expect(await fetchLatestCliVersion()).toBe("0.41.0");
    expect(await fetchLatestCliVersion()).toBe("0.41.0");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
