/**
 * Shared WinAnsi text sanitizer for the pdf-lib report renderers (#5109).
 *
 * pdf-lib's standard Helvetica fonts are WinAnsi-encoded: any character
 * outside WinAnsi (e.g. "≥" U+2265, "⚠" U+26A0) aborts the whole PDF when
 * measured or drawn. Every renderer must sanitize free text through this
 * one function before measuring/drawing — it is the single home for the
 * replacements (reuse, don't copy per renderer). Previously the screener
 * and options renderers each carried their own copy (the options copy
 * lacked the ▲/▼ replacements) and the research and discovery renderers
 * had none, so a "≥" in a rejection reason crashed the research PDF.
 */
export function cleanForPdf(str: string): string {
  return String(str ?? "")
    .replace(/Δ/g, "Delta ")
    .replace(/▲/g, "+")
    .replace(/▼/g, "-")
    .replace(/→/g, "->")
    .replace(/←/g, "<-")
    .replace(/•/g, "*")
    .replace(/—/g, "-")
    .replace(/–/g, "-")
    .replace(/“|”/g, '"')
    .replace(/‘|’/g, "'")
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, " ");
}
