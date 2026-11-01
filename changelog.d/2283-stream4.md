### Changed
- Interaction consistency (#2283, stream 4): async buttons use the Button `loading` prop instead of swapping labels mid-flight; loading is never presented as an empty state (Spinner while in flight, EmptyState only for settled-empty); silent provider/limits saves now confirm via the global Toast. `docs/agents/ux-architecture.md` §6 documents the standard.
