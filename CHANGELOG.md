# Changelog

## 0.0.1

- Activity bar view that groups installed extensions into "Turned on here", "Turned off here" and "Following global setting".
- Per-workspace loadout saved in `.vscode/extension-loadout.json`, with JSON schema validation.
- Quick pick to choose this workspace's extensions in one go.
- "Apply Loadout and Restart VS Code": writes the workspace extension state after VS Code exits, then relaunches it.
- Prompt and status bar indicator when a workspace's loadout is not applied yet.
- Warning on extensions whose running state does not match the loadout after a restart.
