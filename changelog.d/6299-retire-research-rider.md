### Retire the research tick rider (#6299 b)

- The 30-minute tick no longer POSTs `/research/scheduled-tick`: the OODA cadence is the stored schedule record #6029 (a) landed, fired by the tick's own schedule evaluation — one scheduler, not two.
- The S5 parity suite's pinned rider order is updated with the removal (five riders, not six); the "a failing rider does not fail the tick" observer pin is retargeted to another rider rather than deleted.
- The route remains for manual and webhook triggers (#5977); nothing in the tick names it any more.
