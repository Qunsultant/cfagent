### Schedules

- Add the monthly Autopilot evaluation schedule (`autopilot-monthly-evaluation`, `autopilot.evaluate`, `0 9 1 * *` UTC): ScheduledAgent runs the policy-envelope evaluation once a month through the existing POST /api/autopilot/evaluate path with the representative dry-run intent (dry-run only, never places orders), listed and configurable on the Schedules home. The Autopilot page's Policy decisions source line now names the monthly schedule as a verdict writer.
