import { LineCounter, parseDocument } from "yaml";
import type { z } from "zod";

import { SailorError } from "../sailor/sailor-error.js";

export interface LoadYamlConfigOptions {
  /** Filename reported in diagnostics. Never an absolute machine path. */
  readonly source: string;
}

/**
 * `Document.toJS()` is declared `any` by the `yaml` typings. Reading it through
 * a structural type that returns `unknown` keeps `any` out of this package
 * without an eslint-disable comment, which `reportUnusedDisableDirectives`
 * would itself flag if it ever became unnecessary.
 */
interface PlainDocument {
  toJS(options: { maxAliasCount: number }): unknown;
}

interface RangedNode {
  readonly range: readonly [number, number, number];
}

const MAX_ALIAS_COUNT = 64;

const hasRange = (node: unknown): node is RangedNode =>
  typeof node === "object" &&
  node !== null &&
  "range" in node &&
  Array.isArray(node.range);

const stripByteOrderMark = (text: string): string =>
  text.startsWith("﻿") ? text.slice(1) : text;

const normalizeNewlines = (text: string): string =>
  text.replace(/\r\n?/g, "\n");

const formatPath = (path: readonly PropertyKey[]): string =>
  path.map((segment) => String(segment)).join(".");

/**
 * Parses and validates one YAML configuration file.
 *
 * Rule bundles deliberately do not come through here: `loadRuleBundle` raises a
 * `RuleValidationError` carrying structured issues, because `sailor rules
 * explain` renders them individually. A malformed config is instead a plain
 * `SailorError` with `invalid-config`, which is what the CLI turns into an
 * exit code and what `sailor doctor` reports.
 *
 * Every issue in the file is collected in one pass, so a config with four
 * mistakes is fixed in one edit rather than four runs.
 */
export const loadYamlConfig = <Schema extends z.ZodType>(
  text: string,
  schema: Schema,
  options: LoadYamlConfigOptions
): z.output<Schema> => {
  const lineCounter = new LineCounter();
  const document = parseDocument(normalizeNewlines(stripByteOrderMark(text)), {
    lineCounter,
    prettyErrors: true,
  });

  const at = (path: readonly PropertyKey[]): string => {
    for (let end = path.length; end >= 0; end -= 1) {
      const node: unknown = document.getIn(path.slice(0, end), true);

      if (hasRange(node)) {
        const { line, col } = lineCounter.linePos(node.range[0]);

        return `${options.source}:${String(line)}:${String(col)}`;
      }
    }

    return options.source;
  };

  if (document.errors.length > 0) {
    throw new SailorError(
      "invalid-config",
      `${options.source} is not valid YAML`,
      document.errors.map((error) => {
        const { line, col } = lineCounter.linePos(error.pos[0]);

        return `${options.source}:${String(line)}:${String(col)}: ${error.message}`;
      })
    );
  }

  const plain = (document as unknown as PlainDocument).toJS({
    maxAliasCount: MAX_ALIAS_COUNT,
  });
  const parsed = schema.safeParse(plain);

  if (!parsed.success) {
    throw new SailorError(
      "invalid-config",
      `${options.source} is not a valid sailor config file`,
      parsed.error.issues.map(
        (issue) =>
          `${at(issue.path)}: ${issue.message}${
            issue.path.length === 0 ? "" : ` (at ${formatPath(issue.path)})`
          }`
      )
    );
  }

  return parsed.data;
};
