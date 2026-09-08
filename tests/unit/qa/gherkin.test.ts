import { SailorError } from "../../../src/sailor/sailor-error.js";
import { listScenarios } from "../../../src/qa/gherkin.js";
import { captureError } from "../../helpers/expect-error.js";

const SOURCE = { source: "features/login.feature" };

describe("listScenarios", () => {
  it("lists scenarios and scenario outlines in the order the feature declares them", () => {
    const text = [
      "Feature: Login",
      "",
      "  Background:",
      "    Given a user exists",
      "",
      "  Scenario: Happy path",
      "    When they log in",
      "    Then it works",
      "",
      "  Scenario Outline: Bad passwords",
      "    When they try <pw>",
      "    Then they are refused",
      "    Examples:",
      "      | pw |",
      "      | x  |",
      "",
    ].join("\n");

    expect(listScenarios(text, SOURCE)).toEqual([
      "Happy path",
      "Bad passwords",
    ]);
  });

  it("reaches scenarios nested under a Rule", () => {
    const text = [
      "Feature: Login",
      "  Rule: Valid users may enter",
      "    Scenario: Happy path",
      "      When they log in",
      "  Rule: Invalid users may not",
      "    Scenario: Wrong password",
      "      When they log in badly",
      "",
    ].join("\n");

    expect(listScenarios(text, SOURCE)).toEqual([
      "Happy path",
      "Wrong password",
    ]);
  });

  it("does not mistake scenario-shaped text in a docstring or comment for a scenario", () => {
    const text = [
      "Feature: Login",
      "  # Scenario: not this one",
      "  Scenario: Real",
      "    Given a docstring",
      '      """',
      "      Scenario: nor this one",
      '      """',
      "    Then it works",
      "",
    ].join("\n");

    expect(listScenarios(text, SOURCE)).toEqual(["Real"]);
  });

  it("finds nothing in an empty file or a feature with no scenarios", () => {
    expect(listScenarios("", SOURCE)).toEqual([]);
    expect(
      listScenarios("Feature: Login\n\n  Some description.\n", SOURCE)
    ).toEqual([]);
  });

  it("refuses a scenario with no name, because evidence is recorded against the name", () => {
    const text = [
      "Feature: Login",
      "  Scenario:",
      "    When something",
      "",
    ].join("\n");
    const error = captureError(() => listScenarios(text, SOURCE), SailorError);

    expect(error.kind).toBe("invalid-config");
    expect(error.message).toContain("features/login.feature");
    expect(error.message).toContain("unnamed scenario");
  });

  it("refuses two scenarios sharing a name, which one result could not tell apart", () => {
    const text = [
      "Feature: Login",
      "  Scenario: Same",
      "    When a",
      "  Scenario: Same",
      "    When b",
      "",
    ].join("\n");
    const error = captureError(() => listScenarios(text, SOURCE), SailorError);

    expect(error.kind).toBe("invalid-config");
    expect(error.message).toContain("`Same` is declared more than once");
  });

  it("refuses text that is not Gherkin, naming the source", () => {
    const error = captureError(
      () => listScenarios("this is prose, not gherkin\n", SOURCE),
      SailorError
    );

    expect(error.kind).toBe("invalid-config");
    expect(error.message).toContain(
      "features/login.feature is not valid Gherkin"
    );
  });
});
