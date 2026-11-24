### Opportunity hunt report: counts in the header, the arithmetic in the body (#6473)

- The report's title block is the counts headline only; the `SYMBOL:strategy` enumeration it used to append has left the header and lives in the body's table and charts.
- The report now answers "how did N symbols become M setups?" from the run's own numbers — scanned → symbols with setups → setups = entries + exits, with the per-strategy split — so the explanation cannot drift from the charts it explains.
- The wording is one pure helper the PDF renders: the first half of keeping the online report and the PDF in sync.
