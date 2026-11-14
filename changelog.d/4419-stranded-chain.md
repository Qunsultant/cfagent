### Fixed

- **A stranded chain now says so (#4419):** the read model computes `stranded` for a job-chain run whose feed stage failed in full and which has no downstream stage row at all — the chain cannot advance without a retry — and the run detail renders a **Stranded chain** notice explaining that no downstream stage was planned. A partially-failed chain, or one with any downstream row (even a queued one), is never labelled stranded. #autoclaw-001
