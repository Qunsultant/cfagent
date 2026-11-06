### Fixed

- **Policy Gate check (j) deprecation marker scoping (#3504):** scoped deprecation marker detection to explicit deprecation tags (`@deprecated`, all-caps `DEPRECATED`, and comment-leading `Deprecated:`) so conversational prose mentioning the word "deprecated" in comments or identifiers does not falsely fail the gate.
