import { isDeepStrictEqual } from "node:util";

/** Reconcile canonical arguments with bytes already sent to an SDK. */
export function toolArgumentSuffix(emitted: string, canonical: string): string {
  if (canonical.startsWith(emitted)) return canonical.slice(emitted.length);
  try {
    // Canonical objects may be serialized with different whitespace/key order.
    if (isDeepStrictEqual(JSON.parse(emitted), JSON.parse(canonical))) return "";
  } catch {
    // Incomplete JSON may still match after ignoring insignificant whitespace.
  }
  let offset = 0;
  let inString = false;
  let escaped = false;
  for (const char of emitted) {
    if (!inString) {
      if (/[ \t\r\n]/.test(char)) continue;
      while (offset < canonical.length && /[ \t\r\n]/.test(canonical[offset])) offset++;
    }
    if (!canonical.startsWith(char, offset)) {
      throw new Error("Inconsistent upstream tool arguments");
    }
    offset += char.length;
    if (escaped) escaped = false;
    else if (inString && char === "\\") escaped = true;
    else if (char === '"') inString = !inString;
  }
  const suffix = canonical.slice(offset);
  try {
    // Skipping whitespace must not splice a number/literal token, e.g. `1 2`.
    if (isDeepStrictEqual(JSON.parse(emitted + suffix), JSON.parse(canonical))) return suffix;
  } catch {
    // The original bytes plus the suffix must still form valid JSON.
  }
  throw new Error("Inconsistent upstream tool arguments");
}
