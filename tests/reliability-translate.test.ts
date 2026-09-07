import { describe, expect, it } from "vitest";
import { OpenAIStreamEncoder, buildNonStreamingResponse } from "@/translate/openai.js";
import { AnthropicStreamEncoder, buildAnthropicResponse } from "@/translate/anthropic.js";
import type { CCEvent } from "@/translate/types.js";

// Synthetic protocol fixtures. These reducers model SDK concatenation by index.
const delta = (id: string, args: string): CCEvent => ({
  type: "tool-call-delta",
  data: { toolCallId: id, name: "fixture_tool", arguments: args },
});
const final = (id: string, input: unknown): CCEvent => ({
  type: "tool-call",
  data: { toolCallId: id, toolName: "fixture_tool", input },
});
function encode(protocol: string, events: CCEvent[]) {
  const encoder =
    protocol === "OpenAI"
      ? new OpenAIStreamEncoder("fixture")
      : new AnthropicStreamEncoder("fixture");
  const records = [
    ...events,
    { type: "finish", data: { finishReason: "tool-calls" } } as CCEvent,
  ].flatMap((e) => encoder.emit(e)) as any[];
  const calls = new Map<number, { id: string; args: string; closed?: boolean }>();
  for (const r of records) {
    if (protocol === "OpenAI") {
      for (const tc of r.choices?.[0]?.delta?.tool_calls ?? []) {
        const call = calls.get(tc.index) ?? { id: tc.id, args: "" };
        call.args += tc.function?.arguments ?? "";
        calls.set(tc.index, call);
      }
    } else {
      if (r.event === "content_block_start" && r.data.content_block.type === "tool_use") {
        expect(calls.has(r.data.index)).toBe(false);
        calls.set(r.data.index, { id: r.data.content_block.id, args: "", closed: false });
      }
      if (r.event === "content_block_delta" && r.data.delta.type === "input_json_delta") {
        const call = calls.get(r.data.index)!;
        expect(call.closed).toBe(false);
        call.args += r.data.delta.partial_json;
      }
      if (r.event === "content_block_stop" && calls.has(r.data.index)) {
        const call = calls.get(r.data.index)!;
        expect(call.closed).toBe(false);
        call.closed = true;
      }
    }
  }
  if (protocol === "Anthropic") for (const call of calls.values()) expect(call.closed).toBe(true);
  return [...calls.values()].map(({ id, args }) => ({ id, args }));
}

describe("OpenAI SDK metadata accumulation", () => {
  it.each([
    [delta("call-a", '{"x":1}'), final("call-a", { x: 1 })],
    [delta("call-a", '{"x":'), delta("call-a", "1}"), final("call-a", { x: 1 })],
    [final("call-a", { x: 1 }), final("call-a", { x: 1 })],
  ])("emits complete id/name metadata only once per tool index (%#)", (...events) => {
    const encoder = new OpenAIStreamEncoder("fixture");
    const accumulated = { id: "", name: "", arguments: "" };
    for (const event of events) {
      for (const chunk of encoder.emit(event) as any[]) {
        for (const call of chunk.choices?.[0]?.delta?.tool_calls ?? []) {
          accumulated.id += call.id ?? "";
          accumulated.name += call.function?.name ?? "";
          accumulated.arguments += call.function?.arguments ?? "";
        }
      }
    }
    expect(accumulated).toEqual({ id: "call-a", name: "fixture_tool", arguments: '{"x":1}' });
  });
});

describe.each(["OpenAI", "Anthropic"])("%s tool argument reliability", (protocol) => {
  it("does not duplicate complete streamed JSON in the canonical event", () => {
    const calls = encode(protocol, [delta("a", '{"x":1}'), final("a", { x: 1 })]);
    expect(calls).toEqual([{ id: "a", args: '{"x":1}' }]);
    expect(JSON.parse(calls[0].args)).toEqual({ x: 1 });
  });
  it("emits only the missing canonical suffix", () => {
    expect(encode(protocol, [delta("a", '{"x":'), final("a", { x: 1 })])).toEqual([
      { id: "a", args: '{"x":1}' },
    ]);
  });
  it.each([
    ['{"x": ', { x: 1 }, '1}'],
    [' \t{\r\n "x" \t: [ 1 , ', { x: [1, true] }, 'true]}'],
    ['{"x": 1 \t', { x: 1 }, '}'],
    ['{"x": tr', { x: true }, 'ue}'],
    ['{"x": 1e', { x: 1e21 }, '+21}'],
    ['{"x": "a ', { x: "a b" }, 'b"}'],
    ['{"x": "a\\" ', { x: 'a" b' }, 'b"}'],
    ['{"x": "a\\', { x: 'a" b' }, '" b"}'],
    ['{"x": "a\\\\', { x: "a\\ b" }, ' b"}'],
  ])("reconciles partial whitespace without changing emitted bytes (%#)", (prefix, input, suffix) => {
    const calls = encode(protocol, [delta("a", prefix as string), final("a", input)]);
    expect(calls).toEqual([{ id: "a", args: `${prefix}${suffix}` }]);
    expect(JSON.parse(calls[0].args)).toEqual(input);
  });
  it.each([
    ['{ "x": 2', { x: 1 }],
    ['{"x": "a ', { x: "ab" }],
    ['{"x": "a\\" ', { x: 'a"b' }],
    ['{"x": 1 ', { x: 12 }],
    ['{"x": 1 .', { x: 1.5 }],
    ['{"x": 1e ', { x: 1e21 }],
    ['{"x": tr ', { x: true }],
    ['{"x": f al', { x: false }],
    ['{"x": n u', { x: null }],
    ['{"x":\u00a0', { x: 1 }],
  ])("rejects inconsistent values or whitespace splitting JSON tokens (%#)", (prefix, input) => {
    expect(() => encode(protocol, [delta("a", prefix as string), final("a", input)])).toThrow(
      "Inconsistent upstream tool arguments",
    );
  });
  it("preserves final-only tool calls", () => {
    expect(encode(protocol, [final("a", { x: 1 })])).toEqual([{ id: "a", args: '{"x":1}' }]);
  });
  it("keeps interleaved tool arguments on their original SDK indices", () => {
    expect(
      encode(protocol, [
        delta("a", '{"x":'),
        delta("b", '{"y":'),
        delta("a", "1}"),
        final("a", { x: 1 }),
        final("b", { y: 2 }),
      ]),
    ).toEqual([
      { id: "a", args: '{"x":1}' },
      { id: "b", args: '{"y":2}' },
    ]);
  });
  it("rejects a final payload inconsistent with already emitted arguments", () => {
    expect(() => encode(protocol, [delta("a", '{"x":1}'), final("a", { x: 2 })])).toThrow(
      "Inconsistent upstream tool arguments",
    );
  });
  it("accepts semantically equal complete JSON with different whitespace", () => {
    expect(encode(protocol, [delta("a", '{ "x": 1 }'), final("a", { x: 1 })])).toEqual([
      { id: "a", args: '{ "x": 1 }' },
    ]);
  });
  it("does not duplicate a repeated canonical event", () => {
    expect(encode(protocol, [final("a", { x: 1 }), final("a", { x: 1 })])).toEqual([
      { id: "a", args: '{"x":1}' },
    ]);
  });
  it("rejects error events when building nonstream responses", () => {
    const build = protocol === "OpenAI" ? buildNonStreamingResponse : buildAnthropicResponse;
    expect(() =>
      build(
        [{ type: "error", data: { message: "synthetic-private-diagnostic" } }],
        "fixture",
        "id",
      ),
    ).toThrow("CC upstream generation failed");
  });
});
