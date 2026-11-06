'use strict';

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Log from './log.js';


// pid -> {startTime, processInfoArray}
//
// Windows are saved on every title / position / size change, and some apps
// (terminals, chat apps) change their title several times a second. The start
// time and command line of a process never change, so query each process once
// and reuse the result while the process (pid + start time) is the same.
//
// The info is read from /proc with asynchronous Gio file reads: no `ps`
// subprocess (spawning one forks the whole - often >1 GB - shell process: 30-40 ms
// on the main loop per new window, task #144) and no blocking reads. The result
// has the same layout as the former `ps -o lstart,%cpu,%mem,pid,command` line split
// on spaces: [weekday, month, day, time, year, %cpu, %mem, pid, ...command].
const _processInfoCache = new Map();
const MAX_CACHED_PROCESSES = 256;
const CLK_TCK = 100;        // USER_HZ, fixed at 100 on Linux
const PAGE_KB = 4;          // kB per page, for the rss field of /proc/<pid>/stat

let _systemInfo = null;     // {btime, memTotalKb}, constant while the system runs

function _readFileAsync(path) {
    return new Promise(resolve => {
        try {
            Gio.File.new_for_path(path).load_contents_async(null, (file, res) => {
                try {
                    const [ok, contents] = file.load_contents_finish(res);
                    resolve(ok ? new TextDecoder().decode(contents) : null);
                } catch (e) {
                    resolve(null);
                }
            });
        } catch (e) {
            resolve(null);
        }
    });
}

// Fields of /proc/<pid>/stat after the "(comm)" field: index 0 is field 3 (state)
function _parseStat(stat) {
    if (!stat) return null;
    // The process name (field 2) is in parentheses and may contain spaces
    const close = stat.lastIndexOf(')');
    if (close < 0) return null;
    return {
        comm: stat.slice(stat.indexOf('(') + 1, close),
        fields: stat.slice(close + 2).trim().split(' '),
    };
}

// Field 22 of /proc/<pid>/stat, in clock ticks since boot. Together with the
// pid it identifies a process, even if the pid gets reused later.
async function _getProcessStartTime(pid) {
    const stat = _parseStat(await _readFileAsync(`/proc/${pid}/stat`));
    return stat?.fields[19] ?? null;
}

function _pruneProcessInfoCache() {
    if (_processInfoCache.size <= MAX_CACHED_PROCESSES) return;
    for (const [pid, cached] of [..._processInfoCache]) {
        _getProcessStartTime(pid).then(startTime => {
            if (startTime !== cached.startTime && _processInfoCache.get(pid) === cached)
                _processInfoCache.delete(pid);
        });
    }
}

async function _getSystemInfo() {
    if (_systemInfo) return _systemInfo;
    const [stat, meminfo] = await Promise.all([_readFileAsync('/proc/stat'), _readFileAsync('/proc/meminfo')]);
    const btime = Number(/^btime\s+(\d+)/m.exec(stat ?? '')?.[1]);
    const memTotalKb = Number(/^MemTotal:\s+(\d+)/m.exec(meminfo ?? '')?.[1]);
    if (!btime || !memTotalKb) return null;
    return _systemInfo = {btime, memTotalKb};
}

// ps: %cpu = cpu time / elapsed time since start, %mem = rss / total memory, both with 1 decimal
async function _readProcessInfo(pid, statText, sys) {
    const stat = _parseStat(statText);
    const cmdline = await _readFileAsync(`/proc/${pid}/cmdline`);
    if (!stat || cmdline === null || !sys) return null;

    const f = stat.fields;   // f[0] = field 3; utime = field 14, stime = 15, starttime = 22, rss = 24
    const startTicks = Number(f[19]);
    const cpuTicks = Number(f[11]) + Number(f[12]);
    const rssPages = Number(f[21]);

    const uptimeText = await _readFileAsync('/proc/uptime');
    const uptime = Number(uptimeText?.split(' ')[0]);
    const startSeconds = startTicks / CLK_TCK;
    const elapsed = uptime - startSeconds;
    const cpu = elapsed > 0 ? Math.min(Math.floor(cpuTicks / CLK_TCK * 1000 / elapsed) / 10, 99.9) : 0;
    const mem = Math.floor(rssPages * PAGE_KB * 1000 / sys.memTotalKb) / 10;

    const started = GLib.DateTime.new_from_unix_local(sys.btime + Math.floor(startSeconds));
    // like `ps -o lstart`: "Fri Nov  6 10:00:00 2026"
    const lstart = started.format('%a %b %e %H:%M:%S %Y').split(' ').filter(a => a);

    // `ps -o command` is the command line, or [comm] for a process without one
    const command = cmdline.replace(/\0+$/, '').split('\0').join(' ');
    const commandArray = (command || `[${stat.comm}]`).split(' ').filter(a => a);

    return [...lstart, cpu.toFixed(1), mem.toFixed(1), String(pid), ...commandArray];
}

export async function getProcessInfo(apps /*ShellApp*/, ignoreWindowsCb) {
    try {
        const pidSet = new Set();
        for (const app of apps) {
            let metaWindows = app.get_windows();
            for (const metaWindow of metaWindows) {
                if (ignoreWindowsCb && ignoreWindowsCb(metaWindow)) {
                    continue;
                }

                const pid = metaWindow.get_pid();
                // pid is `0` if not known
                if (pid > 0) pidSet.add(pid);
            }
        }

        if (!pidSet.size) return;

        const processInfoMap = new Map();
        await Promise.all([...pidSet].map(async pid => {
            const statText = await _readFileAsync(`/proc/${pid}/stat`);
            const startTime = _parseStat(statText)?.fields[19] ?? null;
            const cached = _processInfoCache.get(pid);
            if (startTime !== null && cached && cached.startTime === startTime) {
                processInfoMap.set(pid, cached.processInfoArray);
                return;
            }

            const processInfoArray = await _readProcessInfo(pid, statText, await _getSystemInfo());
            if (!processInfoArray) return;   // the process is gone: no info, as `ps` printed nothing
            processInfoMap.set(pid, processInfoArray);
            if (startTime !== null)
                _processInfoCache.set(pid, {startTime, processInfoArray});
        }));
        _pruneProcessInfoCache();
        return processInfoMap;
    } catch (e) {
        Log.Log.getDefault().error(e);
    }
}

// A simple asynchronous read loop
function readOutput(stream, lineBuffer) {
    stream.read_line_async(0, null, (stream, res) => {
        try {
            let line = stream.read_line_finish_utf8(res)[0];

            if (line !== null) {
                lineBuffer.push(line);
                readOutput(stream, lineBuffer);
            }
        } catch (e) {
            logError(e);
        }
    });
}

/**
 * We can get the pid after `proc.wait_finish(res)`, but note that the 
 * subprocess might exit later with failure.
 * 
 */
export const trySpawnCmdstr = function(commandLineString, callBackOnSuccess, callBackOnFailure) {
    let success_, argv;

    try {
        [success_, argv] = GLib.shell_parse_argv(commandLineString);
    } catch (err) {
        // Replace "Error invoking GLib.shell_parse_argv: " with
        // something nicer
        err.message = err.message.replace(/[^:]*: /, `${_('Could not parse command:')}\n`);
        throw err;
    }

    let proc = Gio.Subprocess.new(
        argv,
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
    );
    return new Promise((resolve, reject) => {
        proc.wait_async(null, (proc, res) => {
            try {
                let successful = proc.wait_finish(res);
                let status = proc.get_exit_status();
                let stdoutInputStream = proc.get_stdout_pipe();
                let stderrInputStream = proc.get_stderr_pipe();
                if (!(stdoutInputStream instanceof Gio.DataInputStream)) {
                    stdoutInputStream = new Gio.DataInputStream({
                        base_stream: stdoutInputStream,
                    });
                }

                if (!(stderrInputStream instanceof Gio.DataInputStream)) {
                    stderrInputStream = new Gio.DataInputStream({
                        base_stream: stderrInputStream,
                    });
                }

                resolve([status === 0, status, stdoutInputStream, stderrInputStream]);
            } catch(e) {
                Log.Log.getDefault().error(e);
                reject(e);
            }
        });
    });
}

/**
 * Deprecated. Use `trySpawnCmdstr()` instead.
 * 
 * Since `proc.communicate_utf8_finish(res)` only returns value
 * after the subprocess (created by `commandLineString`)
 * exits, we cannot get the pid right after the subprocess launches. 
 * So there will be some kind of blocking here. 
 */
export const trySpawnCmdstrWithBlocking = function(commandLineString, callBackOnSuccess, callBackOnFailure) {
    let success_, argv;

    try {
        [success_, argv] = GLib.shell_parse_argv(commandLineString);
    } catch (err) {
        // Replace "Error invoking GLib.shell_parse_argv: " with
        // something nicer
        err.message = err.message.replace(/[^:]*: /, `${_('Could not parse command:')}\n`);
        throw err;
    }

    let proc = Gio.Subprocess.new(
        argv,
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
    );
    return new Promise((resolve, reject) => {
        proc.communicate_utf8_async(null, null, (proc, res) => {
            try {
                let [, stdout, stderr] = proc.communicate_utf8_finish(res);
                let status = proc.get_exit_status();
                resolve([status === 0, status, stdout, stderr]);
            } catch(e) {
                Log.Log.getDefault().error(e);
                reject(e);
            }
        });
    });
}

export const trySpawn = async function(commandLineArray, callBackOnSuccess, callBackOnFailure) {
    try {
        return await new Promise((resolve, reject) => {
            trySpawnAsync(commandLineArray,
                (output) => {
                    if (callBackOnSuccess) {
                        callBackOnSuccess(output);
                    }
                    resolve(output);
                },
                (output, status) => {
                    if (callBackOnFailure) {
                        callBackOnFailure(output, status);
                    }
                    reject(new Error(output));
                });
        });
    } catch (e) {
        Log.Log.getDefault().error(e);
    }
}
/** 
 * Based on:
 * 1. https://gjs.guide/guides/gio/subprocesses.html#asynchronous-communication
 * 2. https://gitlab.gnome.org/GNOME/gnome-shell/blob/8fda3116f03d95fabf3fac6d082b5fa268158d00/js/misc/util.js:L111
 * 
 * This implement will return the `stderr` and `stdout` to caller via two callback 
 * `callBackOnFailure` and `callBackOnFailure`
 * 
 */
export const trySpawnAsync = function(commandLineArray, callBackOnSuccess, callBackOnFailure) {
    try {
        let [, pid, stdin, stdout, stderr] = GLib.spawn_async_with_pipes(
            // Working directory, passing %null to use the parent's
            null,
            // An array of arguments
            commandLineArray,
            // Process ENV, passing %null to use the parent's
            null,
            // Flags; we need to use PATH so `ls` can be found and also need to know
            // when the process has finished to check the output and status.
            GLib.SpawnFlags.SEARCH_PATH | GLib.SpawnFlags.DO_NOT_REAP_CHILD,
            // Child setup function
            () => {
                try {
                    global.context.restore_rlimit_nofile();
                } catch (err) {
                }
            }
        );

        // Any unsused streams still have to be closed explicitly, otherwise the
        // file descriptors may be left open
        GLib.close(stdin);

        // Okay, now let's get output stream for `stdout`
        let stdoutStream = new Gio.DataInputStream({
            base_stream: new Gio.UnixInputStream({
                fd: stdout,
                close_fd: true
            }),
            close_base_stream: true
        });

        // We'll read the output asynchronously to avoid blocking the main thread
        let stdoutLines = [];
        readOutput(stdoutStream, stdoutLines);

        // We want the real error from `stderr`, so we'll have to do the same here
        let stderrStream = new Gio.DataInputStream({
            base_stream: new Gio.UnixInputStream({
                fd: stderr,
                close_fd: true
            }),
            close_base_stream: true
        });

        let stderrLines = [];
        readOutput(stderrStream, stderrLines);

        // Watch for the process to finish, being sure to set a lower priority than
        // we set for the read loop, so we get all the output
        GLib.child_watch_add(GLib.PRIORITY_DEFAULT_IDLE, pid, (pid, status) => {
            // TODO Note that this status is usually not equal to the integer passed to `exit()`
            // See: https://gitlab.gnome.org/GNOME/glib/-/blob/5d498f4d1ce0fd124cbfb065fb2155a2e964bf5f/glib/gmain.h#L244
            if (status === 0) {
                if (callBackOnSuccess) {
                    callBackOnSuccess(stdoutLines.join('\n'));
                }
            } else {
                if (callBackOnFailure) {
                    callBackOnFailure(stderrLines.join('\n'));
                }
            }

            // Ensure we close the remaining streams and process
            stdoutStream.close(null);
            stderrStream.close(null);
            GLib.spawn_close_pid(pid);

        });
    } catch (e) {
        logError(e);
    }
}


/**
 * Execute a command asynchronously and check the exit status.
 *
 * If given, @cancellable can be used to stop the process before it finishes.
 *
 * @param {string[]} argv - a list of string arguments
 * @param {Gio.Cancellable} [cancellable] - optional cancellable object
 * @returns {Promise<boolean>} - The process success
 */
export async function execCheck(argv, cancellable = null) {
    let cancelId = 0;
    let proc = new Gio.Subprocess({
        argv: argv,
        flags: Gio.SubprocessFlags.NONE
    });
    proc.init(cancellable);

    if (cancellable instanceof Gio.Cancellable) {
        cancelId = cancellable.connect(() => proc.force_exit());
    }

    return new Promise((resolve, reject) => {
        proc.wait_check_async(null, (proc, res) => {
            try {
                if (!proc.wait_check_finish(res)) {
                    let status = proc.get_exit_status();

                    throw new Gio.IOErrorEnum({
                        code: Gio.io_error_from_errno(status),
                        message: GLib.strerror(status)
                    });
                }

                resolve();
            } catch (e) {
                reject(e);
            } finally {
                if (cancelId > 0) {
                    cancellable.disconnect(cancelId);
                }
            }
        });
    });
}

