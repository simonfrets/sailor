import type {
  Diagnostic,
  DiagnosticStatus,
  SailorDiagnosis,
} from "../install/diagnose-sailor.js";

const labelFor = (status: DiagnosticStatus): string => {
  switch (status) {
    case "ok":
      return "OK  ";
    case "warning":
      return "WARN";
    case "problem":
      return "FAIL";
  }
};

const renderDiagnostic = (entry: Diagnostic): readonly string[] => {
  const [first = "", ...rest] = entry.detail.split("\n");

  return [
    `  ${labelFor(entry.status)} ${entry.title} — ${first}`,
    ...rest.map((line) => `         ${line}`),
  ];
};

const plural = (count: number, noun: string): string =>
  `${String(count)} ${noun}${count === 1 ? "" : "s"}`;

/**
 * Renders a diagnosis for a terminal.
 *
 * Passing checks are printed as well as failing ones: a doctor that only listed
 * problems would leave someone unable to tell a check that passed from one that
 * this build never ran.
 */
export const formatDiagnosis = (diagnosis: SailorDiagnosis): string =>
  `${[
    `Sailor diagnosis for ${diagnosis.projectRoot}`,
    "",
    ...diagnosis.diagnostics.flatMap(renderDiagnostic),
    "",
    diagnosis.healthy && diagnosis.warningCount === 0
      ? "Result: healthy"
      : `Result: ${plural(diagnosis.problemCount, "problem")}, ${plural(
          diagnosis.warningCount,
          "warning"
        )}`,
  ].join("\n")}\n`;
