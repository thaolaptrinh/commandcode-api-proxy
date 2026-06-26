import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("auth module", () => {
  let tmpHome: string;

  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "cc-auth-"));
    vi.stubEnv("HOME", tmpHome);
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  describe("getAuthPath", () => {
    it("returns the correct auth file path", async () => {
      const { getAuthPath } = await import("@/auth.js");
      expect(getAuthPath()).toBe(
        path.join(tmpHome, ".config", "commandcode-api-proxy", "auth.json"),
      );
    });
  });

  describe("saveApiKey / readAuthKey", () => {
    it("saves and reads an API key", async () => {
      const { saveApiKey, readAuthKey } = await import("@/auth.js");
      saveApiKey("cc-sk_test_key_123");
      expect(readAuthKey()).toBe("cc-sk_test_key_123");
    });

    it("overwrites an existing key", async () => {
      const { saveApiKey, readAuthKey } = await import("@/auth.js");
      saveApiKey("first_key");
      saveApiKey("second_key");
      expect(readAuthKey()).toBe("second_key");
    });
  });

  describe("readAuthKey", () => {
    it("returns null when no auth file exists", async () => {
      const { readAuthKey } = await import("@/auth.js");
      expect(readAuthKey()).toBeNull();
    });

    it("returns null when auth file has no recognized key field", async () => {
      const { getAuthPath } = await import("@/auth.js");
      const dir = path.dirname(getAuthPath());
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(getAuthPath(), JSON.stringify({ foo: "bar" }));
      const { readAuthKey: read } = await import("@/auth.js");
      expect(read()).toBeNull();
    });
  });

  describe("deleteAuth", () => {
    it("removes the auth file", async () => {
      const { saveApiKey, readAuthKey, deleteAuth } = await import("@/auth.js");
      saveApiKey("cc-sk_test_key_123");
      expect(readAuthKey()).not.toBeNull();
      deleteAuth();
      expect(readAuthKey()).toBeNull();
    });

    it("does not throw when no auth file exists", async () => {
      const { deleteAuth } = await import("@/auth.js");
      expect(() => deleteAuth()).not.toThrow();
    });
  });
});
