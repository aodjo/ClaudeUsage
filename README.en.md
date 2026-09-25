# ClaudeUsage

[![Build](https://github.com/aodjo/ClaudeUsage/actions/workflows/build.yml/badge.svg)](https://github.com/aodjo/ClaudeUsage/actions/workflows/build.yml)
[![Release](https://img.shields.io/github/v/release/aodjo/ClaudeUsage)](https://github.com/aodjo/ClaudeUsage/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/aodjo/ClaudeUsage/total)](https://github.com/aodjo/ClaudeUsage/releases)
[![License](https://img.shields.io/github/license/aodjo/ClaudeUsage)](LICENSE)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)

A small always-on-top widget that shows your Claude plan usage (the 5-hour and weekly limits).

<img src="docs/screenshot.png" alt="ClaudeUsage widget" width="260">

## Supported Languages
[한국어](README.md)

## Install

Download the file for your system from [Releases](https://github.com/aodjo/ClaudeUsage/releases/latest).

| System | File |
|---|---|
| macOS (Apple Silicon) | `ClaudeUsage-mac-arm64.dmg` |
| macOS (Intel) | `ClaudeUsage-mac-x64.dmg` |
| macOS (both) | `ClaudeUsage-mac-universal.dmg` |
| Windows (x64) | `ClaudeUsage-win-x64.exe` |
| Windows (ARM) | `ClaudeUsage-win-arm64.exe` |
| Linux (x64) | `ClaudeUsage-linux-x86_64.AppImage` |
| Linux (ARM) | `ClaudeUsage-linux-arm64.AppImage` |

### First launch

The app is not code-signed, so your system warns you the first time you open it.

- **macOS**: Open the dmg, move ClaudeUsage to Applications, and launch it. If macOS says it can't verify the app, go to **System Settings → Privacy & Security** and click **Open Anyway**. Alternatively, run this once in Terminal:
  ```bash
  xattr -dr com.apple.quarantine /Applications/ClaudeUsage.app
  ```
- **Windows**: If "Windows protected your PC" appears, click **More info → Run anyway**.
- **Linux**: Make the file executable and run it. If it doesn't start, install FUSE 2 (`libfuse2` on Ubuntu 22.04, `libfuse2t64` on 24.04).
  ```bash
  chmod +x ClaudeUsage-linux-*.AppImage
  ./ClaudeUsage-linux-x86_64.AppImage
  ```

## Usage

The widget reads your usage with Claude Code's login. First run `claude` in a terminal and use `/login` to sign in with a claude.ai subscription account (Pro, Max, etc.).

When launched, the widget appears in the top-right corner of the screen. It doesn't show up in the Dock or taskbar.

| To | Do this |
|---|---|
| Move it | Drag the widget. It opens in the same place next time. |
| Refresh now | Click ↻ in the top-right corner. It also refreshes on its own every 2 minutes. |
| Toggle always on top | Right-click → **항상 위에** (Always on top) |
| Quit | Right-click → **종료** (Quit) |

- Bars turn amber at 75% and red at 90%.
- Hover over the time left to see the exact reset time.
- If it says the token has expired (토큰이 만료됐습니다), run Claude Code once. The widget shows your usage again as soon as the token is renewed.
