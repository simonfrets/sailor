import {
  createLineSplitter,
  readClaudeStreamLine,
} from "../../../../src/providers/claude/claude-stream.js";

const line = (value: unknown): string => JSON.stringify(value);

describe("createLineSplitter", () => {
  it("yields each complete line once, however the chunks fall", () => {
    const splitter = createLineSplitter();

    expect(splitter.feed(Buffer.from("one\ntw"))).toEqual(["one"]);
    expect(splitter.feed(Buffer.from("o\n\nthree"))).toEqual(["two", ""]);
    expect(splitter.feed(Buffer.from(""))).toEqual([]);
    expect(splitter.end()).toEqual(["three"]);
  });

  it("decodes a multi-byte character split across chunks", () => {
    const splitter = createLineSplitter();
    const bytes = Buffer.from("\u{1F600}\n");

    expect(splitter.feed(bytes.subarray(0, 2))).toEqual([]);
    expect(splitter.feed(bytes.subarray(2))).toEqual(["\u{1F600}"]);
  });

  it("drops a carriage return before the newline and ends with nothing when the last line was complete", () => {
    const splitter = createLineSplitter();

    expect(splitter.feed(Buffer.from("a\r\nb\n"))).toEqual(["a", "b"]);
    expect(splitter.end()).toEqual([]);
  });
});

describe("readClaudeStreamLine", () => {
  it("reads the assistant's text and tool uses out of an assistant message", () => {
    expect(
      readClaudeStreamLine(
        line({
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "Reading the spec." },
              {
                type: "tool_use",
                id: "toolu_01",
                name: "Read",
                input: { file_path: "docs/spec.md" },
              },
              { type: "thinking", thinking: "..." },
            ],
          },
        })
      )
    ).toEqual([
      { kind: "text", text: "Reading the spec." },
      {
        kind: "tool-use",
        id: "toolu_01",
        name: "Read",
        input: { file_path: "docs/spec.md" },
      },
    ]);
  });

  it("reads which tool use a user message answers, and whether it errored", () => {
    expect(
      readClaudeStreamLine(
        line({
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_01",
                content: "file contents",
              },
              {
                type: "tool_result",
                tool_use_id: "toolu_02",
                content: [{ type: "text", text: "denied" }],
                is_error: true,
              },
            ],
          },
        })
      )
    ).toEqual([
      { kind: "tool-result", id: "toolu_01", isError: false },
      { kind: "tool-result", id: "toolu_02", isError: true },
    ]);
    expect(
      readClaudeStreamLine(
        line({ type: "user", message: { role: "user", content: "a prompt" } })
      )
    ).toEqual([]);
  });

  it("reads the closing result with its error flag and text", () => {
    expect(
      readClaudeStreamLine(
        line({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "Done.",
          num_turns: 3,
          total_cost_usd: 0.01,
          permission_denials: [],
        })
      )
    ).toEqual([
      { kind: "result", subtype: "success", isError: false, text: "Done." },
    ]);
    expect(
      readClaudeStreamLine(
        line({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
        })
      )
    ).toEqual([
      {
        kind: "result",
        subtype: "error_during_execution",
        isError: true,
        text: null,
      },
    ]);
  });

  it("ignores the init message and streaming deltas, which carry nothing the record needs", () => {
    expect(
      readClaudeStreamLine(
        line({ type: "system", subtype: "init", tools: ["Read"] })
      )
    ).toEqual([]);
    expect(
      readClaudeStreamLine(
        line({ type: "stream_event", event: { type: "text_delta" } })
      )
    ).toEqual([]);
    expect(
      readClaudeStreamLine(
        line({
          type: "rate_limit_event",
          rate_limit_info: { status: "allowed", rateLimitType: "five_hour" },
        })
      )
    ).toEqual([]);
  });

  it("keeps a line it cannot read as what it was, rather than losing it", () => {
    expect(readClaudeStreamLine("not json")).toEqual([
      { kind: "unreadable", line: "not json" },
    ]);
    expect(readClaudeStreamLine(line({ type: "banner" }))).toEqual([
      { kind: "unreadable", line: line({ type: "banner" }) },
    ]);
    expect(
      readClaudeStreamLine(line({ type: "assistant", message: "no content" }))
    ).toEqual([
      {
        kind: "unreadable",
        line: line({ type: "assistant", message: "no content" }),
      },
    ]);
    expect(readClaudeStreamLine("")).toEqual([]);
    expect(readClaudeStreamLine("   ")).toEqual([]);
  });
});
