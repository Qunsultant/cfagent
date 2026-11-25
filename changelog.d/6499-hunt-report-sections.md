### The hunt report separates patterned symbols from quiet ones (#6499)

- **Two counted sections.** The single `Symbols evaluated (N)` table is now `Symbols with patterns (N)` and `Symbols with no patterns (M)`, on both the page and the PDF. A reader can see the boundary between symbols that fired and symbols that were evaluated and found uninteresting.
- **Ordered for reading.** The patterned section is sorted by pattern count descending, then symbol A→Z; the no-pattern section is symbol A→Z. The page keeps sortable headers within each section.
- **Exits are red.** The PDF's Exits column is drawn in the danger red via an additive `renderTable` column-colour option; the page's exit badges already used the danger tone.
- A section with no rows still shows its heading and count (`None.` in the PDF, an empty state on the page). All other report content is unchanged.
