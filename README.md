# Extension Loadout

Equip each workspace with only the extensions it needs.

VS Code loads every enabled extension into every window. A Python web project ends up starting a Gradle daemon because `node_modules` happens to contain a `build.gradle`, and an Android project carries a dozen language servers it never uses. Each one costs memory and startup time.

Extension Loadout keeps a per-workspace list of extensions to turn **on** or **off**, in a small file next to your code, and applies it with one click.

## How it works

- Open the **Extension Loadout** panel, either from its activity bar icon or in the Explorer sidebar under your files. Every installed extension is in one of three groups:
  - **ON in this folder** (green ✓): runs in this folder, even if it is off globally.
  - **OFF in this folder** (red ✕): never runs in this folder.
  - **Same as global setting**: does whatever the Extensions view says.
- Each row shows the extension's icon and when it starts: *starts always* (it costs memory in every window), the languages it is for, *when gradlew exists*, or *no code* (themes and the like). *running now* marks extensions that are active at the moment. Hover for details, click to open the extension's page.
- **Not needed in this folder** (💡) appears on top when some extensions are certainly unneeded here: they only start for certain languages or files, and this folder has none of them, for example rust-analyzer in a repository without Rust files or `Cargo.toml`. Each row says why. Turn them off one by one, or all at once with the button on the group. Extensions that start in every window, work on common formats such as JSON or Markdown, or that another enabled extension needs are never suggested, so the list can be short or empty. Those "⚡ always" extensions are the ones that cost memory in every window, so they are worth reviewing yourself.
- **Turn off several at once:** tick the checkboxes of the extensions you want (a group's checkbox selects the whole group), then click **Turn Off Selected** (⊘) at the top of the panel. You can also ⌘/⇧-click several rows and use an inline button on all of them.
- Use the inline buttons to move an extension between groups, or run **Extension Loadout: Choose Extensions for This Workspace...** and tick the ones you want.
- Changes are saved to `.vscode/extension-loadout.json`:

  ```json
  {
    "enable": ["vscjava.vscode-gradle"],
    "disable": ["ms-python.python"]
  }
  ```

- Click **Apply Loadout and Restart VS Code** (view title, status bar, or the prompt). VS Code quits, the loadout is written, and VS Code reopens your windows. This takes a few seconds.

Commit the file and everyone who opens the repository gets offered the same loadout. When a workspace's file and its actual extension state differ, for example on a fresh clone, Extension Loadout says so once when the folder opens.

### Turning something off everywhere except one project

Disable the extension globally in the Extensions view, then put it in the `enable` list of the project that needs it.

## Staying light

Extension Loadout starts at launch only in folders that have `.vscode/extension-loadout.json`. The "not needed" check runs once in the background when the panel is first shown, and searches only for the file patterns of the candidate extensions. Everywhere else it stays off until you open its panel or run one of its commands. The list of installed extensions is read in the background only while the panel is visible, and is reused until you install, update or remove an extension.

## Why a restart?

VS Code has no API for one extension to turn another on or off. The per-workspace on/off state lives in VS Code's own workspace storage, which VS Code reads once at startup and keeps in memory, so a window reload does not pick up changes.

Extension Loadout starts a small helper process and asks VS Code to quit. Once VS Code has fully exited, the helper writes the new state into that workspace's storage, which is the same place **Enable (Workspace)** / **Disable (Workspace)** in the Extensions view write to, and starts VS Code again. Unsaved editors are restored by VS Code's hot exit, as on any normal quit.

The helper only touches the two keys VS Code uses for workspace extension enablement (`extensionsIdentifiers/enabled` and `extensionsIdentifiers/disabled`) in the current workspace. Global settings are never changed. If you cancel the quit, nothing is written. The helper's log is in your temp folder as `extension-loadout-restart.log`.

## Limits

- Needs VS Code 1.101 or newer (it uses the SQLite module built into VS Code's Node.js).
- Multi-root workspaces use the first folder's `.vscode/extension-loadout.json`.
- Only extensions in your default profile's extensions folder are listed. Built-in extensions are not listed.
- Restart has been tested on macOS. On Windows and Linux VS Code is relaunched from its executable.
- Extension Loadout always stays on so you can change the loadout.
- If another extension depends on one you turn off, VS Code may keep it running. The view marks that with a warning.

## Development

```sh
npm install
npm run test:unit   # pure logic, SQLite storage, restart helper
npm run test:e2e    # drives a real, isolated VS Code through apply → restart → revert,
                    # once in development mode and once installed from the .vsix with the real `open -n -a` relaunch
```

The end-to-end test uses its own `--user-data-dir` and `--extensions-dir` under `.vscode-test/`, so your own VS Code setup is never touched.
