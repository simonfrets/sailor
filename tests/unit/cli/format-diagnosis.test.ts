import { formatDiagnosis } from "../../../src/cli/format-diagnosis.js";
import type {
  Diagnostic,
  SailorDiagnosis,
} from "../../../src/install/diagnose-sailor.js";

const diagnosis = (diagnostics: readonly Diagnostic[]): SailorDiagnosis => ({
  projectRoot: "/tmp/host",
  diagnostics,
  problemCount: diagnostics.filter((entry) => entry.status === "problem")
    .length,
  warningCount: diagnostics.filter((entry) => entry.status === "warning")
    .length,
  healthy: diagnostics.every((entry) => entry.status !== "problem"),
});

describe("formatDiagnosis", () => {
  it("names the project it examined", () => {
    expect(formatDiagnosis(diagnosis([]))).toContain(
      "Sailor diagnosis for /tmp/host"
    );
  });

  it("labels each status distinctly", () => {
    const text = formatDiagnosis(
      diagnosis([
        { id: "node", title: "Node.js", status: "ok", detail: "22.22.1" },
        { id: "hooks", title: "Git hooks", status: "warning", detail: "unset" },
        { id: "rules", title: "Rules", status: "problem", detail: "broken" },
      ])
    );

    expect(text).toContain("OK   Node.js — 22.22.1");
    expect(text).toContain("WARN Git hooks — unset");
    expect(text).toContain("FAIL Rules — broken");
  });

  it("indents the continuation of a multi-line detail", () => {
    const text = formatDiagnosis(
      diagnosis([
        {
          id: "config",
          title: "Configuration",
          status: "problem",
          detail: "project.yaml is missing\nhooks.yaml is missing",
        },
      ])
    );

    expect(text).toContain("FAIL Configuration — project.yaml is missing");
    expect(text).toContain("\n         hooks.yaml is missing");
  });

  it("reports a healthy installation in one line", () => {
    expect(
      formatDiagnosis(
        diagnosis([
          { id: "node", title: "Node.js", status: "ok", detail: "ok" },
        ])
      )
    ).toContain("Result: healthy");
  });

  it("counts problems and warnings when either is present", () => {
    expect(
      formatDiagnosis(
        diagnosis([
          { id: "rules", title: "Rules", status: "problem", detail: "broken" },
          {
            id: "hooks",
            title: "Git hooks",
            status: "warning",
            detail: "unset",
          },
        ])
      )
    ).toContain("Result: 1 problem, 1 warning");
  });

  it("does not call an installation healthy while it carries a warning", () => {
    expect(
      formatDiagnosis(
        diagnosis([
          {
            id: "hooks",
            title: "Git hooks",
            status: "warning",
            detail: "unset",
          },
        ])
      )
    ).toContain("Result: 0 problems, 1 warning");
  });
});
