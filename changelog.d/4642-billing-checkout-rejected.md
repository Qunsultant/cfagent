### Fixed

- **Billing checkout reports a rejected mapped price honestly (#4642):** when Stripe rejects the operator-mapped price in a subscription-mode checkout (e.g. a one-time price, which subscription mode does not accept), the mint returns the new `FAILURE_BILLING_CHECKOUT_REJECTED` outcome instead of the generic 503, and the Selling section shows the honest message instead of "not configured yet". The unset-mapping 503 is unchanged.
