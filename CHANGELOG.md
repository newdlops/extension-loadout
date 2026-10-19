# Changelog

## 0.6.0

- **Why is it running?** Rows and the dashboard show what started each extension in this window, read from VS Code's extension host log: a file type, startup, or another extension, e.g. *started by Ruff (via Python Environments → Python)*.
- **Suggestions follow chains.** An extension that also starts for common formats is now suggested when it started other extensions here and none of its own files exist. Ruff starts for any Markdown file and then starts the Python extension and Pylance (about 400 MB); in a folder without Python it is suggested, with what it started and their memory.
- **Restart Language Server** on rows whose extension runs a server process (Pylance through the Python extension, rust-analyzer, ESLint, the TypeScript server and others with a restart command), in the panel, the dashboard and the command palette. It reports the memory before and after.

## 0.5.1

- The memory pressure watch also warns when swap is filling up (growing by 256 MB or more a minute, macOS and Linux) and, on macOS, when compressed memory holds 40% or more of physical memory. The kernel (macOS) and PSI (Linux) still decide when memory is critical.
- The memory warning offers **Turn Off … Here** for the heaviest extension you can turn off in this folder.
- The memory warning appears at most once an hour across windows and restarts (sooner only when memory becomes critical), instead of once in every new window.
- End-to-end tests now restart the extension host and check that the extension host process and an extension's child process are replaced, and *Apply to Other Folders* is tested with a real git worktree.

## 0.5.0

**See what each extension costs**
- *Memory in this window*: memory of the processes each extension started (language servers, daemons), in this window and all windows, using the real footprint (compressed memory on macOS, swap on Linux). Heavy extensions are highlighted (`extensionLoadout.heavyThresholdMB`).
- Memory pressure watch: the status bar shows the heaviest extension when the system is tight, with one notification per session (`extensionLoadout.memoryWatch.*`).
- **Restart Extension Host** frees extension memory in this window without restarting VS Code.

**Apply your way, safely**
- **Apply When VS Code Quits**: nothing restarts now; a tiny waiting helper applies the loadout the next time you quit. Cancel from the status bar.
- **Apply to Other Folders…**: one restart also updates the other git worktrees of the repository and any other folder you pick.
- **Undo Last Apply** and **Reset Folder to Global Settings**.

**Smarter suggestions**
- `unwantedRecommendations` in `.vscode/extensions.json` count as certain suggestions; recommended extensions that are off here or not installed get their own group with an install button, and a ★ elsewhere.
- *You usually turn these off*: learned from what you turned off in folders with a similar stack.
- Dependencies: turning off an extension others need asks to turn those off too; turning one on also turns on what it needs; packs expand and handle their members.

**More control**
- Loadout files accept patterns (`ms-toolsai.*`), `!ID` exclusions and `notes`; edits from the panel keep them, and comments too.
- Presets: save, apply and delete loadouts; synced with Settings Sync.
- Filter and sort: all, running here, ⚡ always, using memory; by name or by memory.
- **Loadout Dashboard**: every extension in one sortable, filterable table with bulk actions.
- Multi-root workspaces (`name.loadout.json` next to the workspace file, folder files merged) and VS Code profiles.
- Korean UI.

**Engineering**
- End-to-end tests run on macOS, Ubuntu and Windows in CI, including the restart path on all three.

## 0.4.0

- **Select, then turn off in one go.** Every extension row has a selection checkbox, and a group's checkbox selects the whole group. While something is selected, **Turn Off Selected** and **Clear Selection** appear at the top of the panel, with a "N selected" note.
- Multi-select rows with ⌘/⇧-click and use any inline action (turn on, turn off, same as global) on all of them at once.
- The "Not needed in this folder" group starts with a visible **Turn all N off** row instead of a hover-only button.
- After changing several extensions you get one "Restart VS Code to apply?" prompt, and the command no longer waits on it.

## 0.3.0

- **Not needed in this folder**: a new group at the top lists extensions that are certainly unneeded here, with the reason (for example "No rust files (*.rs), Cargo.toml"). Turn them off one by one or all at once with the button on the group. Only extensions that start for specific languages or files are considered, and only when this folder has none of them. Extensions that start always, target common formats (JSON, Markdown, YAML…), have triggers that cannot be checked, or that another enabled extension depends on are never suggested.
- The check runs in the background once, when the panel is first shown, and only searches for the candidates' file patterns. Run **Find Extensions This Folder Doesn't Need** (lightbulb button) to check again.
- Easier to read: shorter row text ("⚡ always", "● running", "elsewhere: off"), extensions that are on listed before those that are off, the folder summary next to the panel title, and a status bar item showing how many extensions this folder turns on and off.

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
