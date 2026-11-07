import fs from 'node:fs';
import path from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { Store } from './store.mjs';

const MiB = 1024 * 1024;
const invalidate = Symbol.for('st.character-library.invalidate');
export function problem(status, message) {
    return Object.assign(new Error(message), { status });
}
function positive(value, fallback) {
    const n = Number(value ?? fallback);
    if (!Number.isSafeInteger(n) || n < 1) throw new Error('角色库预算应为正整数');
    return n;
}

// Native handlers and library jobs enter the same queue. Pending entries keep paths, never card bodies.
export class Queue {
    tail = Promise.resolve();
    count = 0;
    run(work) {
        if (this.count >= 32) return Promise.reject(problem(503, '角色解析队列已满，请稍后重试'));
        this.count++;
        const task = this.tail.then(work).finally(() => { this.count--; });
        this.tail = task.catch(() => {});
        return task;
    }
}

export class Library {
    queue = new Queue();
    accounts = new Map();
    constructor({ limit, budget, nativeCache = 100 * MiB } = {}) {
        this.limit = positive(limit ?? process.env.ST_LIBRARY_ONLINE, 8);
        this.budget = positive(budget ?? process.env.ST_LIBRARY_BUDGET_MIB, 192) * MiB;
        this.available = this.budget - nativeCache - 24 * MiB;
    }
    account(dirs) {
        if (!dirs?.root || !dirs.characters) throw problem(401, '需要有效的酒馆账户');
        const key = path.resolve(dirs.root);
        let a = this.accounts.get(key);
        if (!a) {
            let store;
            try { store = new Store(dirs); }
            catch (error) { throw problem(error.status ?? 503, '无法打开账户角色库，请停服后使用 recover.mjs 预览离线恢复：' + error.message); }
            a = { store, dirs, leases: new Map(), scan: null, scanned: 0,
                progress: { running: false, done: 0, failed: 0, errors: [] } };
            this.accounts.set(key, a);
        }
        return a;
    }
    scan(a, force = false) {
        if (a.scan) return a.scan;
        if (!force && Date.now() - a.scanned < 60000) return Promise.resolve();
        const p = a.progress = { running: true, done: 0, failed: 0, errors: [] };
        const upgradeTime = !a.store.importTimeReady;
        const failed = (avatar, error) => {
            p.failed++;
            if (p.errors.length < 16) p.errors.push({ avatar, message: error.message });
        };
        a.scan = (async () => {
            try {
                for (const avatar of a.store.discover({ includeUnchanged: upgradeTime })) {
                    try { await this.queue.run(() => a.store.refresh(avatar, { backfillImported: upgradeTime })); }
                    catch (err) { failed(avatar, err); }
                    p.done++;
                    await yieldTurn();
                }
                if (upgradeTime && !p.failed) a.store.finishImportTimeUpgrade();
            } catch (err) { failed('', err); }
            finally { p.running = false; a.scanned = Date.now(); }
        })().finally(() => { a.scan = null; });
        return a.scan;
    }
    lease(a, id) {
        if (typeof id !== 'string' || !/^[\w-]{8,100}$/.test(id)) throw problem(400, '无效的窗口标识');
        let l = a.leases.get(id);
        if (!l || l.until < Date.now()) {
            l = { current: [], pending: [], until: 0, pendingUntil: 0 };
            a.leases.set(id, l);
        }
        l.until = Date.now() + 90000;
        return l;
    }
    expireLeases(a) {
        const now = Date.now();
        for (const [id,l] of a.leases) if (l.until <= now) a.leases.delete(id);
    }
    protected(a, exceptClient) {
        this.expireLeases(a);
        const names = new Set();
        for (const [id,l] of a.leases) {
            if (id === exceptClient) continue;
            for (const n of l.current) names.add(n);
            if (l.pendingUntil > Date.now()) for (const n of l.pending) names.add(n);
        }
        return names;
    }
    row(a, avatar) {
        const row = a.store.refresh(avatar);
        if (!row) throw problem(404, '找不到角色卡：' + avatar);
        return row;
    }
    assertIdentity(a, avatar, id, { resident = true } = {}) {
        a.store.assertWritableName(avatar);
        const previous = a.store.raw(avatar);
        if (!id || !previous || previous.id !== id) throw problem(409, '角色身份已变，请重新打开角色后再操作');
        const row = a.store.refresh(avatar);
        if (!row || row.id !== id || (resident && row.state !== 'resident'))
            throw problem(409, '角色身份或位置已变，请重新打开角色后再操作');
        return row;
    }
    async resolveMembers(a, members) {
        if (members.some(n => !n.toLowerCase().endsWith('.png'))) {
            await this.scan(a, true);
            if (a.progress.failed) throw problem(409, '角色索引不完整，无法确认成员');
        }
        return members.map(n => {
            if (n.toLowerCase().endsWith('.png')) return n;
            const matches = a.store.byDisplayName(n);
            if (matches.length > 1) throw problem(409, '有多个同名角色：' + n + '，请使用完整文件名');
            return matches[0]?.avatar ?? null;
        });
    }
    async evict(a, avatar) {
        await globalThis[invalidate]?.(a.dirs, avatar);
        a.store.withdraw(avatar);
    }
    // Choose all victims before moving a file, so a protected working set can reject a switch intact.
    async trim(target, wanted = [], strict = false, switchingClient) {
        if (!target.store.managed || target.store.restoring) return [];
        const candidates = [], wantedNames = new Set(wanted.map(r => r.avatar));
        let count = 0, bytes = 0;
        const cost = r => 2 * (r.parsedBytes || r.bytes);
        for (const a of this.accounts.values()) {
            if (!a.store.managed || a.store.restoring) continue;
            const held = this.protected(a);
            for (const r of a.store.residents()) {
                bytes += cost(r);
                if (!r.favorite) count++;
                if (!r.favorite && !held.has(r.avatar) && !(a === target && wantedNames.has(r.avatar))) {
                    try { a.store.assertExactName(r.avatar); }
                    catch (error) { if (error.status === 409) continue; throw error; }
                    candidates.push({ a, r });
                }
            }
        }
        for (const r of wanted) if (r.state !== 'resident') {
            bytes += cost(r);
            if (!r.favorite) count++;
        }
        candidates.sort((x,y) => (x.r.played ?? 0) - (y.r.played ?? 0) || x.r.avatar.localeCompare(y.r.avatar));
        const victims = [];
        // A switch may briefly hold the old and new chat. The memory allowance already excludes switching headroom.
        let countLimit = this.limit;
        if (strict && switchingClient) {
            const otherWindows = this.protected(target, switchingClient);
            const previous = target.leases.get(switchingClient)?.current ?? [];
            if (previous.some(n => {
                const row = target.store.get(n);
                return row?.state === 'resident' && !row.favorite && !wantedNames.has(n) && !otherWindows.has(n);
            })) countLimit++;
        }
        for (const v of candidates) {
            if (count <= countLimit && bytes <= this.available) break;
            victims.push(v); count--; bytes -= cost(v.r);
        }
        if (strict && (bytes > this.available || count > countLimit))
            throw problem(409, '当前聊天、群成员或收藏已占满预算，请释放其他窗口、减少固定或调整服务端预算');
        const evicted = [];
        for (const { a, r } of victims) {
            await this.evict(a, r.avatar);
            if (a === target) evicted.push(r.avatar);
        }
        return evicted;
    }
    snapshot(a, evicted = []) {
        const result = { managed: a.store.managed, restoring: a.store.restoring, evicted };
        if (result.managed) result.online = a.store.residents().map(r => r.avatar);
        return result;
    }
    async prepare(a, id, avatars) {
        const l = this.lease(a, id);
        const rows = avatars.map(n => this.row(a, n));
        if (a.store.restoring && rows.some(r => r.state !== 'resident')) throw problem(409, '恢复未完成，请先处理剩余归库卡');
        if (rows.some(r => r.state !== 'resident') && !a.store.managed)
            throw problem(409, '请先在角色库开启管理，或恢复全部卡片');
        const evicted = rows.some(r => r.state !== 'resident') ? await this.trim(a, rows, true, id) : [];
        const loaded = [];
        try {
            for (const r of rows) if (r.state !== 'resident') { a.store.load(r.avatar); loaded.push(r); }
        } catch (err) {
            for (const r of loaded) if (!r.favorite) await this.evict(a, r.avatar);
            throw err;
        }
        l.pending = avatars; l.pendingUntil = Date.now() + 90000;
        return { ...this.snapshot(a, evicted), avatars, identities: rows.map(({ avatar, id }) => ({ avatar, id })) };
    }
    async heartbeat(a, id, avatars, played) {
        for (const avatar of avatars) a.store.assertExactName(avatar);
        const l = this.lease(a, id);
        l.current = avatars;
        if (played || l.pending.every(n => avatars.includes(n))) { l.pending = []; l.pendingUntil = 0; }
        if (played) for (const n of avatars) if (a.store.get(n)) a.store.touch(n);
        return this.snapshot(a, await this.trim(a));
    }
    async migrate(a, preview) {
        if (a.store.restoring) throw problem(409, '恢复未完成，请先完成恢复');
        await this.scan(a, true);
        const rows = a.store.residents();
        const conflicts = [...a.progress.errors];
        for (const { avatar } of rows) {
            try { a.store.assertWritableName(avatar); }
            catch (error) { conflicts.push({ avatar, message: error.message }); }
        }
        if (preview) return { managed: a.store.managed, resident: rows.length, favorites: rows.filter(r => r.favorite).length, conflicts };
        if (conflicts.length) throw problem(409, '角色索引或文件名冲突，请先查看迁移预览：' + conflicts[0].message);
        a.store.managed = true;
        const evicted = [];
        for (const r of rows) {
            await this.queue.run(async () => {
                const now = a.store.refresh(r.avatar);
                if (now?.state === 'resident' && !now.favorite && !this.protected(a).has(r.avatar)) {
                    await this.evict(a, r.avatar); evicted.push(r.avatar);
                }
            });
            await yieldTurn();
        }
        return { ...this.snapshot(a, evicted), retained: a.store.residents().length };
    }
    async restore(a) {
        a.store.restoring = true;
        let restored = 0;
        const errors = new Map();
        try {
            if (a.scan) await a.scan;
            for (const avatar of a.store.restoreCandidates()) {
                try {
                    await this.queue.run(() => {
                        const row = a.store.refresh(avatar);
                        if (row?.state === 'cold') { a.store.load(avatar); restored++; }
                    });
                } catch (error) { errors.set(avatar, error.message); }
                await yieldTurn();
            }
            const remaining = [...a.store.restoreCandidates()].map(avatar => ({
                avatar, message: errors.get(avatar) ?? '归库文件或移动记录尚未恢复',
            }));
            if (!remaining.length) a.store.finishRestore();
            a.scanned = 0;
            return { ...this.snapshot(a), restored, remaining };
        } catch (error) {
            throw problem(409, '无法读取账户目录或索引，请停服后使用 recover.mjs 离线恢复：' + error.message);
        }
    }
    referenced(a, avatar) {
        const name = a.store.get(avatar)?.name;
        for (const file of fs.readdirSync(a.dirs.groups, { withFileTypes: true })) {
            if (!file.isFile() || !file.name.endsWith('.json')) continue;
            const group = JSON.parse(fs.readFileSync(path.join(a.dirs.groups, file.name), 'utf8'));
            if (group.members?.includes(avatar) || (name && !name.toLowerCase().endsWith('.png') && group.members?.includes(name))) return group.name || file.name;
        }
        return null;
    }
    deletable(a, avatar) {
        if (this.protected(a).has(avatar)) throw problem(409, '请先退出所有正在使用这个角色的聊天窗口');
        const group = this.referenced(a, avatar);
        if (group) throw problem(409, '该角色仍属于群聊「' + group + '」，请先在群成员管理中移除');
    }
    close() { for (const a of this.accounts.values()) a.store.close(); }
}
