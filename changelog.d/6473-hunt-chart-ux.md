### A trend in every row, the chart in a dialog (#6473)

- The Opportunity Hunt table gains a **Trend** column: an inline SVG sparkline of the symbol's last 40 closes, labelled for assistive tech (`Trend for <symbol>, last N closes`). A symbol with fewer than two closes shows `—`, never a flat line pretending to be a trend.
- Clicking a row now opens the symbol's recommendations **and its full chart in a dialog** (the existing `ui/` Modal), instead of an inline card below the table.
- The sparkline is deliberately not a second chart instance: sixty-plus symbols would mean sixty-plus canvases for a shape read at 40px, while the full chart is one click away.
