### Broker neutrality

- **Gates fail-closed (#3460)**: the broker gate now returns a named 503 (`FAILURE_BROKER_STORE_UNAVAILABLE`) when the tenant broker selection cannot be read, instead of failing open to E*TRADE; the manual screen entry and the goal leg read the broker through the presence-aware seam and refuse with a named error when unconfigured or when the store fails, instead of defaulting to E*TRADE.
