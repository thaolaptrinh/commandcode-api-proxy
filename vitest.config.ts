import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "src");

export default defineConfig({
  resolve: {
    alias: [{ find: /^@\//, replacement: srcDir + "/" }],
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
