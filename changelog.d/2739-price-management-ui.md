### Client

- **Price management UI for store operators (#2739)** — the price approval section now reads full price entries (price, status, approver, approval and update times) from a new operator-only read route, edits prices per family with client-side validation, saves with a visible needs-re-approval consequence, and saves with approval in a single request; non-operators see no editing controls and no status badges.
