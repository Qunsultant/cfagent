### Workflow platform

- **Decompose the saga into platform capabilities (#2991):** leg registry, journey-gate capability, terminal finisher, Block contract + saga compositions, one planner port with stock and options plan Blocks, contract-stack mapping, risk inventory, and the uniform-execution contract — with no behavior change to #2041.
- **Retire the broker goal guard (#2991):** a goal spec with async requested now routes like any spec, carrying goal provenance through the command; goal dispatch becoming a caller of the one pipeline is a named follow-up.
- **Ship splice (#2991):** leg-registry starting rides the #2989 uniform correlation seam (same create → adopt → fallback algorithm, now shared, not duplicated) so saga legs keep the seam-persisted correlation id; the stock-screen capability status string records the guard retirement alongside G7 #2914's goal-owned execution facts, with the #2882 premise marked superseded by the one-solution direction.
