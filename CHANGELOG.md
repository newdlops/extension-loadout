# Changelog

## 0.2.0

- Clearer folder state: groups are now "ON in this folder", "OFF in this folder" and "Same as global setting", and each extension carries a green ✓ or red ✕ badge, a matching label color, and text such as "ON only here · off elsewhere".
- Each extension shows its own icon and when it starts ("starts always", the languages it is for, "when gradlew exists", "no code"), plus "running now" when it is active.
- Click an extension to open its page in the Extensions view.
- Lighter: Extension Loadout starts at launch only in folders that have `.vscode/extension-loadout.json`; elsewhere it waits until you open its panel or run a command. The installed-extension list is read in the background only while the panel is visible, and cached until extensions change. The Explorer panel starts collapsed.

## 0.1.0

First Marketplace release.

- Loadout view in its own activity bar panel and in the Explorer sidebar, grouping installed extensions into "Turned on here", "Turned off here" and "Following global setting".
- Per-workspace loadout saved in `.vscode/extension-loadout.json`, with JSON schema validation.
- Quick pick to choose this workspace's extensions in one go.
- "Apply Loadout and Restart VS Code": writes the workspace extension state after VS Code exits, then relaunches it.
- Prompt and status bar indicator when a workspace's loadout is not applied yet.
- Warning on extensions whose running state does not match the loadout after a restart.
