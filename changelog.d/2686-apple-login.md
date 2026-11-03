## Added

- Sign in with Apple as a login provider (#2686): registered in the
  generic OIDC provider registry behind `IAAA_WIRING_ENABLED` (button
  appears when `apple` is added to `IAAA_ENABLED_PROVIDERS`), with
  ID-token profile extraction (Apple has no userinfo endpoint),
  nonce bound to the login attempt's state, private-relay-safe
  subject-keyed identity, and a per-exchange minted ES256
  client-secret JWT (no stored secret to expire). Live Apple sign-in
  proof is an owner step (Apple Developer provisioning).
