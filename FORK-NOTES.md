# Fork notes (vrgfa)

Fork of [nlpsuge/gnome-shell-extension-another-window-session-manager](https://github.com/nlpsuge/gnome-shell-extension-another-window-session-manager).

## Branches

| Branch | Based on | Purpose | Upstream |
|---|---|---|---|
| `installed` | `gnome-50-support` + `cache-process-info` | **What is installed** (`~/.local/share/gnome-shell/extensions/another-window-session-manager@gmail.com` is a symlink to this clone — keep this branch checked out) | — |
| `gnome-50-support` | upstream `main-gnome-45+` | GNOME 50: replace the removed `Meta.is_wayland_compositor()` | PR #156 (open) |
| `cache-process-info` | upstream `main-gnome-45+` | Cache `ps` results per process instead of spawning `ps` on every window save (gnome-shell idle CPU ~30–40 % → ~19 %) | not opened yet; text in the PR draft |

## Local changes log

- 2026-10-25 — GNOME 50 compatibility (`gnome-50-support`), PR #156.
- 2026-10-28 — `cache-process-info`: `utils/subprocessUtils.js` caches process
  info, validated by the start time in `/proc/<pid>/stat`.
- 2026-10-28 — `installed` branch combining both; clone moved to
  `~/Projects/GnomeExtensions/another-window-session-manager`.

## Known issue (not this extension's bug)

At login, restoring windows to their workspaces together with "Simulate
switching workspaces on active monitor" (GNOME ≤48 only) caused minutes of
"too much recursion" in GNOME's workspace animation; that extension was
disabled on 2026-10-28.
