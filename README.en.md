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

When launched, the widget appears in the top-right corner of the screen. It doesn't show up in the Dock or taskbar.

### Logging in

The first time, the widget shows a **claude.ai 로그인** (Log in to claude.ai) button. Sign in with a claude.ai subscription account (Pro, Max, etc.). Passkeys don't work in the login window, so sign in with your email.

1. Click **claude.ai 로그인**.
2. Enter your email in the login window and choose to continue with email.
3. Open the login link from the email in your usual browser. It shows a verification code.
4. Enter that code in the widget's login window. The window closes by itself and your usage appears.

The login is stored only in the widget and stays after restarts.

### Controls

| To | Do this |
|---|---|
| Move it | Drag the widget. It opens in the same place next time. |
| Refresh now | Click ↻ in the top-right corner. It also refreshes on its own every 2 minutes. |
| Toggle always on top | Right-click → **항상 위에** (Always on top) |
| Log out | Right-click → **claude.ai 로그아웃** (Log out of claude.ai) |
| Quit | Right-click → **종료** (Quit) |

- Bars turn amber at 75% and red at 90%.
- Hover over the time left to see the exact reset time.
- If the login expires, the **claude.ai 로그인** button appears again.
