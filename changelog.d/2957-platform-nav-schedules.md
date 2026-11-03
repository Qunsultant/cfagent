### Fixed
- Schedules no longer opens the Platform Admin menu: the schedules route's navGroup is now "schedules" (was "platform-admin" via the #2709 follow-up), so landing on ?tab=schedules highlights Schedules, not Platform Admin, and Platform Admin's sub-menu stays collapsed (#2957).
- Edit frequency is now offered on every generic schedule row, including one-shot (delayed/scheduled) rows; picking a cadence converts a one-shot to a recurring schedule, and the cadence dialog warns one-shot rows before they pick (#2957).
