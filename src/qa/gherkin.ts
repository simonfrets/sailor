import {
  AstBuilder,
  GherkinClassicTokenMatcher,
  Parser,
} from "@cucumber/gherkin";
import { IdGenerator } from "@cucumber/messages";
import type { FeatureChild, RuleChild } from "@cucumber/messages";

import { SailorError } from "../sailor/sailor-error.js";

export interface ListScenariosOptions {
  /** Filename reported in diagnostics. Never an absolute machine path. */
  readonly source: string;
}

const scenarioNames = (
  children: readonly (FeatureChild | RuleChild)[]
): readonly string[] =>
  children.flatMap((child) => {
    // `in` narrows the optional property to present, but the parser builds
    // plain objects, so presence is still checked at run time via the local.
    const rule = "rule" in child ? child.rule : undefined;

    if (rule !== undefined) {
      return scenarioNames(rule.children);
    }

    return child.scenario === undefined ? [] : [child.scenario.name.trim()];
  });

/**
 * The scenarios a feature file accepts, in declaration order.
 *
 * Parsed with the official Gherkin parser rather than by matching lines,
 * because the line that says `Scenario:` inside a docstring or a comment is
 * not a scenario, a `Rule:` block nests its scenarios one level down, and a
 * `# language:` header changes every keyword. Those are exactly the cases a
 * hand-rolled parser gets wrong, and a scenario this misses is a scenario
 * nothing will demand evidence for.
 *
 * Names are the identity here: completion evidence is recorded per scenario
 * name, so a scenario without one, or two sharing one, is refused at the
 * parse rather than surfacing later as evidence that names nothing.
 */
export const listScenarios = (
  text: string,
  options: ListScenariosOptions
): readonly string[] => {
  const parser = new Parser(
    new AstBuilder(IdGenerator.uuid()),
    new GherkinClassicTokenMatcher()
  );

  let names: readonly string[];

  try {
    const document = parser.parse(text);

    names =
      document.feature === undefined
        ? []
        : scenarioNames(document.feature.children);
  } catch (error: unknown) {
    throw new SailorError(
      "invalid-config",
      `${options.source} is not valid Gherkin`,
      (error instanceof Error ? error.message : String(error))
        .split("\n")
        .filter((line) => line.trim() !== "")
    );
  }

  const seen = new Set<string>();
  const issues: string[] = [];

  for (const name of names) {
    if (name === "") {
      issues.push(
        "an unnamed scenario cannot carry evidence; give every scenario a name"
      );
    } else if (seen.has(name)) {
      issues.push(`\`${name}\` is declared more than once`);
    }

    seen.add(name);
  }

  if (issues.length > 0) {
    throw new SailorError(
      "invalid-config",
      `${options.source} declares scenarios evidence could not be recorded against`,
      issues
    );
  }

  return names;
};
