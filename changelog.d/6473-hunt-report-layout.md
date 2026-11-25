### The report's charts keep their headings and their labels (#6473)

- **No more orphaned headings.** A bar chart now reserves room for its title plus the first bars *before* drawing the title, so "Pattern count by symbol (top 20 of 64)" can no longer land at the foot of one page while its symbols start the next. A chart longer than a page still re-draws its title on each continuation page.
- **Entry and exit labels no longer overlap.** Level labels are placed by a helper that keeps a readable gap between them and clamps into the chart box: a crowded stack (entry, stop-loss, take-profit within a few points) keeps every label, none dropped and none stacked on another.
- Both live in the hunt renderer; the shared drawing layer's table rendering is untouched.
