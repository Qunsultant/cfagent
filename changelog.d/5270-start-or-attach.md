### Fixed

- Re-dispatching a run id through the options host seam attaches to the in-flight workflow instance instead of minting a duplicate (#5270, sub-issue of #4860): the seam reads the residency record first (queued/running attaches with no re-define and no create; paused refuses by name, resume goes through the control plane), and the real-binding create rides the #2989 managed seam with the deterministic id for the job, so racing dispatches converge on one instance. Covers the options, strategy, comparison, and goal legs plus the options-chain seam.
