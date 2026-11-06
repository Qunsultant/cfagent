### Changed

- **Multi-Copilot Sub-Tabs & Architecture Extensibility (#3449):** Organized all copilots into distinct, accessible sub-tabs within `CapabilityNavBar` on the chat page (`?tab=chat`): General Copilot, Options Copilot, and Stock Copilot. Resolves the visual overlap where `StockCopilotPanel` previously sat unconditionally pinned across all chat sub-views. The Stock Copilot panel now renders cleanly in its dedicated custom workspace surface, while General and Options copilots retain full-height chat stream visibility. Introduces a modular, typed `copilotRegistry` supporting dynamic registration of future domain copilots with customized layouts, banners, tooltips, and composer prompts. #ceo-aimp

