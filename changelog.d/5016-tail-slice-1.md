### Changed

- Tail slice 1 (issue #5016): `DataProvidersPanel` and `PlatformAdminPanel` are now zero-bespoke — both interiors render from `ui/` primitives and design tokens only. `dataProvidersPanel.css` is retired in place (header only); its 53 freeze entries and both register entries are removed, and both files join `CONFORMING_INTERIORS`.
