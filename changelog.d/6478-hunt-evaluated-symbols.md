### The hunt report shows every symbol it evaluated (#6478)

- **No-setup symbols are retained.** The run keeps a capped trailing series for every symbol it scanned, not only the ones that fired a setup; a symbol skipped for short history still has none. The row shape carries that series, so a no-setup symbol is a real table row with `0` patterns, its last close, and its chart.
- **Both surfaces draw them.** The PDF's table is headed "Symbols evaluated (N)" (with the setup population stated separately), the pattern-count chart covers the evaluated population, and every no-setup symbol gets its own detail section saying it was evaluated with no signal plus its price chart. The panel's row opens a dialog titled "no setup" with the same chart.
- **A zero-setup run is still a report.** It keeps the counts explanation, the evaluated table, and a chart per symbol instead of collapsing to a single empty-state line.
- Setup symbols' rows, counts, ranges, and charts are unchanged.
