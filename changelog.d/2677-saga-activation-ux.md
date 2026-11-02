### Client

- **Store price approval UI on the assurance page (#2677)** — lists the four families with price and approval state, and an Approve button per family for store operators only; non-operators and unverifiable sessions get a clear disabled state, never an enabled button that fails.
- **Saga start and progress UI on the goal panel (#2677)** — start form for a paid goal saga journey with live progress polling to the journey gate, a clear disabled state when the monetization flag is OFF, and handover to the existing gate cards and Trading Approvals Queue after the gate.
