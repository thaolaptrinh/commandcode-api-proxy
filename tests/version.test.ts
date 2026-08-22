import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { getProxyVersion } from "@/version.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

describe("getProxyVersion", () => {
  beforeAll(() => {
    delete process.env.npm_package_version;
  });

  it("resolves the version from package.json without npm env vars", () => {
    expect(getProxyVersion()).toBe(pkg.version);
  });

  it("does not fall back to the stale 0.1.0 default", () => {
    expect(getProxyVersion()).not.toBe("0.1.0");
  });
});
