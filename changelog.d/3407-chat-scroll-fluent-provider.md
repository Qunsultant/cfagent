### Fixed

- Copilot chat scrolls inside its message pane again: the FluentProvider root now carries the flex layout that restores the height chain the Fluent migration (#3146) broke, so new messages scroll the stream instead of pushing the content taller.
