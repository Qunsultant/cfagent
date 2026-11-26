### Changed

- **Every report-body consumer now goes through the one access point (#6659):** the PDF artifact-key refresh (`refreshCanonicalReportPdfFields`) read and rewrote the body through its own blob store — the last consumer bypassing `reportBodyStore`. It now reads with the bounded/terminal policy and writes through the same seam, so the negative cache is cleared on write and the read inherits the retry bound. A source pin fails if `scheduledReports.ts` builds a blob store of its own again.
