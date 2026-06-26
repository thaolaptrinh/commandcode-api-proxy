import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import tty from "node:tty";

export function getAuthDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) throw new Error("Cannot determine home directory");
  return path.join(home, ".config", "commandcode-api-proxy");
}

export function getAuthPath(): string {
  return path.join(getAuthDir(), "auth.json");
}

export function readAuthKey(): string | null {
  try {
    const raw = fs.readFileSync(getAuthPath(), "utf-8");
    const parsed = JSON.parse(raw);
    return parsed.apiKey || parsed.accessToken || parsed.token || null;
  } catch {
    return null;
  }
}

export function saveApiKey(key: string): void {
  const dir = getAuthDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getAuthPath(), JSON.stringify({ apiKey: key }, null, 2) + "\n");
}

export function deleteAuth(): void {
  try {
    fs.unlinkSync(getAuthPath());
  } catch {
    // Ignore if file doesn't exist
  }
}

export async function promptForApiKey(): Promise<string> {
  const stdin = process.stdin as tty.ReadStream;
  if (!stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
      rl.question("\n  Enter your Command Code API key: ", (a) => {
        rl.close();
        resolve(a.trim());
      });
    });
  }

  return new Promise((resolve) => {
    stdin.setRawMode(true);
    stdin.resume();
    let input = "";
    process.stdout.write("\n  Enter your Command Code API key: ");

    const onData = (chunk: Buffer) => {
      const char = chunk.toString();
      if (char === "\r" || char === "\n") {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolve(input);
      } else if (char === "\x7f" || char === "\b") {
        if (input.length > 0) {
          input = input.slice(0, -1);
        }
      } else if (char === "\x03") {
        stdin.setRawMode(false);
        process.exit(0);
      } else {
        input += char;
      }
    };
    stdin.on("data", onData);
  });
}


