### Added
- Order page (`src/client/OrderTicketPanel.tsx`) renders PageTemplate by construction: the form card is a WorkCard, the quote peek is a ContextStrip in the `contextStrip` slot (ticket tab only), and the approvals queue is a QueueFeed in the `queueRail` slot — zero behavior change, same tabs, seeding, ticket state, and approvals flow (#3138).
