// Smoke test of the async window hooks (task #144): window-created only queues, the idle drain writes the
// windows mapping and arms the save, saved session files have the usual content, restore reads them back,
// disabling with a non-empty queue leaves nothing running.
// Run: tests/run.sh smoke [--profile]. Writes $DIR/out.json (normalized, to compare old / new code).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const UUID = 'another-window-session-manager@gmail.com';
const decode = b => new TextDecoder().decode(b);

function fakeWindow() {
    const handlers = new Map();
    let n = 0;
    return {
        connect(sig, cb) { handlers.set(++n, [sig, cb]); return n; },
        disconnect(id) { handlers.delete(id); },
        emit(sig) { for (const [s, cb] of [...handlers.values()]) if (s === sig) cb(); },
        get handlerCount() { return handlers.size; },
    };
}

export default async function (t) {
    const {Main} = t;
    const em = Main.extensionManager;
    const ext = await t.until(() => em.lookup(UUID)?.state === 1 ? em.lookup(UUID) : null, 15000);
    if (!t.check(!!ext, 'extension enabled'))
        return;
    await t.wait(2000);
    const inst = ext.stateObj;
    const tracker = inst._tracker;       // absent in the old code (comparison runs)
    const settings = inst._settings;
    const out = {};

    // 1. queue module on fake windows: drop on unmanaging, budget per turn, one commit per turn, flush
    const Q = await import(`file://${ext.path}/utils/windowQueue.js`).catch(() => null);
    if (Q) {
        const seen = [];
        let commits = 0;
        const burn = ms => { const s = GLib.get_monotonic_time(); while (GLib.get_monotonic_time() - s < ms * 1000); };
        const q = new Q.WindowQueue(w => { seen.push(w.id); burn(3); }, () => commits++, 4000);
        const ws = [1, 2, 3, 4, 5].map(id => Object.assign(fakeWindow(), {id}));
        ws.forEach(w => q.push(w));
        ws[1].emit('unmanaging');
        t.check(q.size === 4, `fake windows queued (${q.size}), unmanaged one dropped`);
        await t.until(() => q.size === 0 ? true : null, 2000);
        t.check(seen.join() === '1,3,4,5' && q.turns >= 2 && commits === q.turns,
            `drained in ${q.turns} idle turns (budget 4 ms), ${commits} commits, order ${seen}`);
        t.check(ws.every(w => w.handlerCount === 0), 'unmanaging handlers disconnected after processing');
        ws.forEach(w => q.push(w));
        q.flush();
        t.check(q.size === 0 && seen.length === 9, 'flush() drains synchronously');
        q.destroy();
        // the test's own queue neither registers nor unregisters the tracker's one
        if (tracker) {
            const wq = tracker._windowQueue;
            const origHandler = wq._handler;
            let handled = 0;
            wq._handler = () => handled++;
            wq.push(fakeWindow());
            Q.flushPendingWindows();
            wq._handler = origHandler;
            t.check(wq.size === 0 && handled === 1, 'flushPendingWindows() still reaches the tracker queue after a test queue was destroyed');
        }
    }

    // 1b. /proc process info against `ps` for a long-running process (the nested shell itself)
    const SubprocessUtils = await import(`file://${ext.path}/utils/subprocessUtils.js`);
    const [, stat] = GLib.file_get_contents('/proc/self/stat');
    const pid = parseInt(decode(stat));
    const fakeApp = {get_windows: () => [{get_pid: () => pid}]};
    const info = (await SubprocessUtils.getProcessInfo([fakeApp])).get(pid);
    const psArr = decode(GLib.spawn_command_line_sync(`ps --no-headers -p ${pid} -o lstart,%cpu,%mem,pid,command`)[1]).trim().split(' ').filter(a => a);
    t.check(!!info && info.slice(0, 5).join(' ') === psArr.slice(0, 5).join(' '), `start time same as ps (${info?.slice(0, 5).join(' ')})`);
    t.check(!!info && info[7] === psArr[7] && info.slice(8).join(' ') === psArr.slice(8).join(' '), 'pid and command same as ps');
    t.check(!!info && Math.abs(parseFloat(info[5]) - parseFloat(psArr[5])) < 5 && Math.abs(parseFloat(info[6]) - parseFloat(psArr[6])) < 0.5,
        `cpu / mem near ps (${info?.[5]}/${info?.[6]} vs ${psArr[5]}/${psArr[6]})`);

    // 1c. a vanished pid: no entry, no throw
    const gone = await SubprocessUtils.getProcessInfo([{get_windows: () => [{get_pid: () => 4194000}]}]);
    t.check(gone instanceof Map && gone.size === 0, 'getProcessInfo on a vanished pid: no entry, no throw');

    // 1d. write chain: a rejected write does not stop the next one, order kept; works after destroy() too
    const SaveSession = await import(`file://${ext.path}/saveSession.js`).catch(() => null);
    if (SaveSession?.SaveSession) {
        const ss = new SaveSession.SaveSession();
        const log = [];
        ss._writeSessionConfigAsync = (cfg) => new Promise((resolve, reject) => {
            log.push(`start ${cfg.n}`);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, cfg.n === 1 ? 150 : 10, () => {
                log.push(`end ${cfg.n}`);
                cfg.n === 1 ? reject(new Error('write 1 failed')) : resolve(true);
                return GLib.SOURCE_REMOVE;
            });
        });
        const w1 = ss._saveSessionConfigAsync({session_name: 'chain.json', n: 1}, '/tmp/awsm-chain').catch(e => e.message);
        const w2 = ss._saveSessionConfigAsync({session_name: 'chain.json', n: 2}, '/tmp/awsm-chain');
        const [r1, r2] = await Promise.all([w1, w2]);
        t.check(r1 === 'write 1 failed' && r2 === true && log.join() === 'start 1,end 1,start 2,end 2',
            `write chain: write 1 rejects, write 2 still runs after it (${log})`);
        ss.destroy();
        t.check(await ss._saveSessionConfigAsync({session_name: 'chain.json', n: 3}, '/tmp/awsm-chain') === true,
            'save after destroy() still runs (unchained)');
    }

    // 2. real windows: open 3, check the hook cost and the drain
    const work = GLib.build_filenamev([GLib.get_tmp_dir(), `awsm-test-${GLib.get_monotonic_time()}`]);
    GLib.mkdir_with_parents(work, 0o700);
    const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
    launcher.set_cwd(work);
    const procs = [];
    await t.profileMark('start');
    for (let i = 0; i < 3; i++) {
        procs.push(launcher.spawnv(['zenity', '--info', `--title=awsm-test-${i}`, '--text=window', '--timeout=120']));
        await t.wait(500);
    }
    await t.profileMark('end');
    const wins = () => global.get_window_actors().map(a => a.meta_window).filter(w => w.get_title()?.startsWith('awsm-test-'));
    const got = await t.until(() => wins().length === 3 ? wins() : null, 15000);
    t.check(!!got, `3 test windows open (${wins().length})`);
    if (!got) return;
    if (tracker)
        t.check(await t.until(() => tracker._windowQueue.size === 0 ? true : null, 1000), 'queue drained within 1 s');
    await t.wait(1500);

    const mapping = new Map(JSON.parse(settings.get_string('windows-mapping')));
    const entries = [...mapping.values()].flatMap(o => Object.values(o)).filter(e => 'windowTitle' in e);
    // keyed by xid (get_description): on Wayland the 3 windows can share one xid, as with the old code
    t.check(entries.length >= 1 && entries.length <= 3, `windows-mapping has the test windows (${entries.length} entries)`);
    out.mapping = {entries: entries.length, shape: entries.map(e => Object.keys(e).sort().join()).filter((v, i, a) => a.indexOf(v) === i)};

    // saved session files
    const base = GLib.build_filenamev([GLib.get_user_config_dir(), 'another-window-session-manager', 'currentSession']);
    const sessions = [];
    for (const w of wins()) {
        const path = `${base}/${w.get_wm_class()}/${w.get_stable_sequence()}.json`;
        const file = await t.until(() => {
            const dir = Gio.File.new_for_path(`${base}/${w.get_wm_class()}`);
            try {
                for (const info of dir.enumerate_children('standard::name', 0, null)) {
                    const [ok, c] = dir.get_child(info.get_name()).load_contents(null);
                    const obj = JSON.parse(decode(c));
                    if (obj.window_title === w.get_title()) return {obj, path: `${dir.get_path()}/${info.get_name()}`};
                }
            } catch (e) { /* not written yet */ }
            return null;
        }, 6000);
        t.check(!!file, `session file saved for ${w.get_title()}`);
        if (file) sessions.push(file.obj);
    }
    if (sessions.length === 3) {
        // the saved process info has the ps layout
        const s0 = sessions[0];
        t.check(/^\w{3} \w{3} \d{1,2} \d\d:\d\d:\d\d \d{4}$/.test(s0.process_create_time) && /^\d+(\.\d)?$/.test(s0.cpu_percent)
            && /^\d+(\.\d)?$/.test(s0.memory_percent) && s0.cmd[0].endsWith('zenity'),
            `process fields in ps layout (${s0.process_create_time}, ${s0.cpu_percent}, ${s0.memory_percent}, ${s0.cmd?.[0]})`);
        out.sessions = sessions.map(s => ({
            keys: Object.keys(s).sort(), title: s.window_title, app_name: s.app_name, wm_class: s.wm_class,
            desktop_number: s.desktop_number, window_position: Object.keys(s.window_position), cmdHead: s.cmd?.[0]?.split('/').pop(),
            pidIsNumber: Number.isInteger(s.pid),
        })).sort((a, b) => a.title.localeCompare(b.title));

        // 3. restore round trip (critical): the saved file is read back at "startup" and handed to the mover
        if (tracker) {
            tracker._restoringSession = true;
            tracker._allSavedWindowSessions = [];
            wins().forEach(w => tracker._restoreWindowState(w));
            const back = tracker._allSavedWindowSessions;
            t.check(back.length === 3 && back.every(b => sessions.some(s => JSON.stringify(s) === JSON.stringify(b))),
                `restore reads the 3 saved sessions back identically (${back.length})`);
            await tracker._moveSession.moveApps(back);
            t.check(wins().every(w => w.get_workspace()?.index() === back.find(b => b.window_title === w.get_title()).desktop_number),
                'moveApps keeps the windows on their saved workspaces');
            tracker._restoringSession = false;
            out.restored = back.length;
        }
    }
    const outFile = GLib.getenv('NESTED_TEST_DIR') ?? GLib.get_tmp_dir();
    GLib.file_set_contents(`${outFile}/out.json`, JSON.stringify(out, null, 2));

    // 4. disable with a non-empty queue leaves nothing running
    if (tracker) {
        const q = tracker._windowQueue;
        wins().slice(0, 2).forEach(w => q.push(w));
        t.check(q.size === 2, 'queue holds 2 windows right before disable');
        inst.disable();
        t.check(q.size === 0 && q._idleId === 0 && !inst._tracker, 'disable: queue flushed, no idle source left');
        await t.wait(1500);
        t.check(true, 'no error 1.5 s after disable (shell.log checked by run.sh)');
    }
    procs.forEach(p => { try { p.force_exit(); } catch (e) { /* gone */ } });
    try { Gio.File.new_for_path(work).delete(null); } catch (e) { /* ignore */ }
}
