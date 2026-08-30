import { vi } from "vitest";

/**
 * Mock only the CC provider models endpoint. Other fetches (e.g. requests to
 * the test server itself) must reach the real network stack — a blanket fetch
 * mock silently swallows them and the test reads the mock payload instead of
 * the server's actual response.
 */
export function mockCcModelsFetch(models: unknown, calls: { count: number } = { count: 0 }) {
  const realFetch = globalThis.fetch.bind(globalThis);
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url ?? String(input);
    if (!url.includes("/provider/v1/models")) return realFetch(input, init);
    calls.count += 1;
    return new Response(JSON.stringify({ object: "list", data: models }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }) as unknown as Response;
  });
}
