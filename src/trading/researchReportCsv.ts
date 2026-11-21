/**
 * Research-run CSV (#2167).
 *
 * The machine-readable mirror of the workbook's `Ideas` tab: one row per
 * ranked idea, the same 15 columns in the same order, so a spreadsheet,
 * a notebook and a diff all agree with the PDF.
 */

import type { ResearchReport } from "../services/researchPipeline";
import { RESEARCH_CSV_COLUMNS, RESEARCH_IDEA_COLUMNS, RESEARCH_SYMBOL_EVALUATION_COLUMNS, researchIdeaRows, researchSymbolEvaluationRows } from "./researchReportData";

function csvEscape(value: string | number | boolean | null): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function generateResearchReportCsv(report: ResearchReport): string {
  const empty = Object.fromEntries([...RESEARCH_IDEA_COLUMNS, ...RESEARCH_SYMBOL_EVALUATION_COLUMNS].map((column) => [column, null])) as Record<string, string | number | boolean | null>;
  const records: Array<Record<string, string | number | boolean | null>> = [
    ...researchIdeaRows(report).map((row) => ({ ...empty, record_type: "idea", ...row })),
    ...researchSymbolEvaluationRows(report).map((row) => ({ ...empty, record_type: "symbol_evaluation", ...row })),
  ];
  const lines = [
    RESEARCH_CSV_COLUMNS.join(","),
    ...records.map((row) =>
      RESEARCH_CSV_COLUMNS.map((column) => csvEscape(row[column])).join(","),
    ),
  ];
  return `${lines.join("\n")}\n`;
}
