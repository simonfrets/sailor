import { StringDecoder } from "node:string_decoder";

import { z } from "zod";

/**
 * What the adapter takes from one line of `claude --print --output-format
 * stream-json`: the assistant's text, each tool use it asked for, the answer
 * to each, and the closing result. Everything else the stream carries - the
 * init message, streaming deltas, the assistant's thinking, usage figures -
 * is left in the transcript file and not in the record of the run.
 */
export type ClaudeStreamItem =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "tool-use";
      readonly id: string;
      readonly name: string;
      readonly input: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "tool-result";
      readonly id: string;
      readonly isError: boolean;
    }
  | {
      readonly kind: "result";
      readonly subtype: string;
      readonly isError: boolean;
      readonly text: string | null;
    }
  | { readonly kind: "unreadable"; readonly line: string };

export interface LineSplitter {
  /** The complete lines this chunk finished, without their line ending. */
  readonly feed: (chunk: Buffer) => readonly string[];
  /** The unterminated last line, if the stream ended without a newline. */
  readonly end: () => readonly string[];
}

/**
 * Turns chunks into lines. A chunk boundary falls anywhere, including inside
 * a multi-byte character, so bytes are decoded through a `StringDecoder`
 * that holds an incomplete sequence back until its continuation arrives.
 */
export const createLineSplitter = (): LineSplitter => {
  const decoder = new StringDecoder("utf8");
  let pending = "";

  const split = (text: string): readonly string[] => {
    const parts = text.split("\n");
    const last = parts.pop();

    pending = last ?? "";

    return parts.map((line) => line.replace(/\r$/, ""));
  };

  return {
    feed: (chunk) => split(pending + decoder.write(chunk)),
    end: () => {
      const rest = pending + decoder.end();

      pending = "";

      return rest === "" ? [] : [rest.replace(/\r$/, "")];
    },
  };
};

const textBlockSchema = z.looseObject({
  type: z.literal("text"),
  text: z.string(),
});

const toolUseBlockSchema = z.looseObject({
  type: z.literal("tool_use"),
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
});

const toolResultBlockSchema = z.looseObject({
  type: z.literal("tool_result"),
  tool_use_id: z.string().min(1),
  is_error: z.boolean().optional(),
});

/**
 * A message's content: a string for a plain prompt, otherwise blocks. Each
 * block is read on its own, so thinking, images and whatever a later CLI
 * adds are present and simply not read.
 */
const contentSchema = z.union([z.string(), z.array(z.unknown())]);

/**
 * The messages the headless-mode reference documents, read loosely: only the
 * fields the adapter uses are required, so a field the CLI adds later does
 * not make a line unreadable.
 */
const streamMessageSchema = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("system") }),
  z.looseObject({ type: z.literal("stream_event") }),
  // Not in the headless-mode reference; printed between turns by 2.1.263
  // with the account's rate-limit windows. Observed on the first live run.
  z.looseObject({ type: z.literal("rate_limit_event") }),
  z.looseObject({
    type: z.literal("assistant"),
    message: z.looseObject({ content: contentSchema }),
  }),
  z.looseObject({
    type: z.literal("user"),
    message: z.looseObject({ content: contentSchema }),
  }),
  z.looseObject({
    type: z.literal("result"),
    subtype: z.string(),
    is_error: z.boolean(),
    result: z.string().optional(),
  }),
]);

const itemsOfContent = (
  content: z.output<typeof contentSchema>
): ClaudeStreamItem[] => {
  if (typeof content === "string") {
    return [];
  }

  return content.flatMap((block): ClaudeStreamItem[] => {
    const text = textBlockSchema.safeParse(block);

    if (text.success) {
      return [{ kind: "text", text: text.data.text }];
    }

    const toolUse = toolUseBlockSchema.safeParse(block);

    if (toolUse.success) {
      return [
        {
          kind: "tool-use",
          id: toolUse.data.id,
          name: toolUse.data.name,
          input: toolUse.data.input,
        },
      ];
    }

    const toolResult = toolResultBlockSchema.safeParse(block);

    if (toolResult.success) {
      return [
        {
          kind: "tool-result",
          id: toolResult.data.tool_use_id,
          isError: toolResult.data.is_error ?? false,
        },
      ];
    }

    return [];
  });
};

/**
 * Reads one line of the stream.
 *
 * A blank line is nothing. A line that is not JSON, or is JSON the schema
 * does not recognise, comes back as `unreadable` with the line intact: the
 * CLI printed it, so the record keeps it, and the adapter reports it as
 * output rather than deciding it did not happen.
 */
export const readClaudeStreamLine = (line: string): ClaudeStreamItem[] => {
  if (line.trim() === "") {
    return [];
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(line);
  } catch {
    return [{ kind: "unreadable", line }];
  }

  const result = streamMessageSchema.safeParse(parsed);

  if (!result.success) {
    return [{ kind: "unreadable", line }];
  }

  const message = result.data;

  switch (message.type) {
    case "system":
    case "stream_event":
    case "rate_limit_event":
      return [];
    case "assistant":
    case "user":
      return itemsOfContent(message.message.content);
    case "result":
      return [
        {
          kind: "result",
          subtype: message.subtype,
          isError: message.is_error,
          text: message.result ?? null,
        },
      ];
  }
};
