### Correct the INTEGRATION census marker to its true counted value (#4935)

The squash merge of #4966 carried a wrong INTEGRATION marker (682/6529) in
tests/neutrality_census_3525.test.ts: the resolver incremented the stale
marker instead of recounting. Direct recount on current main gives
698 rows / 7062 lines, which the marker and the #4935 paragraph now state.
No BASELINE rows change; no behavior change.
