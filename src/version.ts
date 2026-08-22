import { readFileSync } from "node:fs";

let cached: string | undefined;

export function getProxyVersion(): string {
  if (cached) return cached;
  cached = readPackageJsonVersion() ?? process.env.npm_package_version ?? "0.0.0";
  return cached;
}

function readPackageJsonVersion(): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version?: string;
    };
    return typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}
