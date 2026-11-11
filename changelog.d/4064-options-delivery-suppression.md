### Options delivery suppression (#4064)

- The options deliver stage now claims its (runId, destination) pairs through the ONE delivery suppressor (following #3943's re-homing): a re-run/replay of a delivered options report never re-sends to the same destination — Slack (bridge scheduling or direct A2A) and email (email:<recipient>) both record already_delivered instead of sending again.
- A failed send releases its claim, so a retry may send; a pair that cannot be attempted (deferred delivery, Slack disabled, no email recipient) never claims. A suppressed pair counts as delivered.
- The manual route injects a suppressor backed by the durable mas_delivery_claims table in the route DO's SQLite — the same table and key space the followup.deliver executor claims into.
- The goal leg's deliver is unchanged: it defers to the goal run (deliveryState deferred-to-goal-run), sends nothing, and claims nothing.
