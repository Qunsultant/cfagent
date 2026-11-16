### Fix — restate the neutrality census INTEGRATION marker to the recounted totals

Corrects the INTEGRATION marker in `tests/neutrality_census_3525.test.ts`
from the wrong 682/6529 (stated by #4966's squash merge, which incremented
the stale 681/6528 marker instead of recounting) to the direct recount of
698 rows / 7061 lines, and corrects the #4935 paragraph prose to match.
No BASELINE row changes; no other marker touched.
