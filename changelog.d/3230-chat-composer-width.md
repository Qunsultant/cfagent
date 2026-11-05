### Fixed
- Chat composer input stretches full length across the composer bar again: the Fluent v9 Input root now grows with the flex bar (Griffel `flexGrow: 1`, `minWidth: 0`), fixing the post-#3146 shrink where the old `.chat-input-bar input { flex: 1 }` rule no longer reached the input through Fluent's wrapper root.
