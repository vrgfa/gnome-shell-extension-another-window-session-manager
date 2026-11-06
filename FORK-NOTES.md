# Fork notes (vrgfa)

Fork of [nlpsuge/gnome-shell-extension-another-window-session-manager](https://github.com/nlpsuge/gnome-shell-extension-another-window-session-manager).

## Branches

| Branch | Based on | Purpose | Upstream |
|---|---|---|---|
| `installed` | `gnome-50-support` + `cache-process-info` | **What is installed** (`~/.local/share/gnome-shell/extensions/another-window-session-manager@gmail.com` is a symlink to this clone — keep this branch checked out) | — |
| `t144-async-hooks` | `installed` | Window-created hook only queues (idle drain, 4 ms budget); process info from `/proc` via async Gio reads instead of `ps`; per-file ordered session writes; `tests/` nested smoke test | not opened |
| `gnome-50-support` | upstream `main-gnome-45+` | GNOME 50: replace the removed `Meta.is_wayland_compositor()` | PR #156 (open) |
| `cache-process-info` | upstream `main-gnome-45+` | Cache `ps` results per process instead of spawning `ps` on every window save (gnome-shell idle CPU ~30–40 % → ~19 %) | not opened yet; text in the PR draft |

## Local changes log

- 2026-10-25 — GNOME 50 compatibility (`gnome-50-support`), PR #156.
- 2026-10-28 — `cache-process-info`: `utils/subprocessUtils.js` caches process
  info, validated by the start time in `/proc/<pid>/stat`.
- 2026-10-28 — `installed` branch combining both; clone moved to
  `~/Projects/GnomeExtensions/another-window-session-manager`.

- 2026-11-06 — `t144-async-hooks`: ~100 ms JS per window open -> ~0 on the open path.
  `utils/windowQueue.js` (hook pushes, `GLib.idle_add(PRIORITY_LOW)` drain, one windows-mapping write per
  idle turn, flushed by logout/reboot/shutdown, `CloseSession._sortWindowsOnX11` and `destroy()`);
  `utils/subprocessUtils.js getProcessInfo` reads /proc/<pid>/{stat,cmdline} async (same array layout as the
  former `ps -o lstart,%cpu,%mem,pid,command`, cache kept); `saveSession.js` chains writes per file.
  Test: `tests/run.sh smoke [--profile]` (nested shell, headless, ~15 s).

## Known issue (not this extension's bug)

At login, restoring windows to their workspaces together with "Simulate
switching workspaces on active monitor" (GNOME ≤48 only) caused minutes of
"too much recursion" in GNOME's workspace animation; that extension was
disabled on 2026-10-28.

## Task branches (2026-11-06)

`installed` stays the installed and checked-out branch (upstream-compatible naming; a short-lived `main` was merged back into it and removed). `git config workbench.mainBranch installed` (local) tells the workbench's `worktree.sh` to branch task worktrees from it and merge them back into it.
