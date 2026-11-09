### Fixed
- The Think webhook channel can now receive its credential: `THINK_WEBHOOK_SECRET` is in the deploy workflow's Worker-secret sync list (optional — deploys report its absence until the operator sets the GitHub secret, and the channel keeps failing closed meanwhile) (#3821).
