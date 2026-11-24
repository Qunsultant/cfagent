### The report has a shareable link, not just a download (#6473)

- The Opportunity Hunt panel now keeps the generated report's URL and shows it: an **Open report** link, the URL in plain text, and a **Share** button (Web Share where the platform has it, clipboard otherwise). A **Report link** button gets the link without downloading.
- A refused clipboard says "copy the link from the line below" — the panel never claims a copy it did not make.
- The row is its own module over `ui/` primitives, so it is testable without the charting dependency the panel module carries.
