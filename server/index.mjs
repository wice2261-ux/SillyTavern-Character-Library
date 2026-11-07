import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { Library, problem } from './runtime.mjs';

export const info = { id: 'character-library', name: '低内存角色库', description: '按需载入酒馆角色卡' };
// Historical adapter protocol identifier; not the plugin or installed Tavern version.
const adapterProtocol = '1.18.0';
const hooks = Symbol.for('st.character-library');
const invalidate = Symbol.for('st.character-library.invalidate');
const fromST = file => import(pathToFileURL(path.resolve('src', file)).href);
let runtime, timer;
let receivingUpload = false;
const thumbnails = new Map();
const noWrites = new Set(['/get', '/all', '/chats', '/export']);
function array(input) {
    if (!Array.isArray(input) || input.length > 1024 || input.some(n => typeof n !== 'string' || n.length > 255))
        throw problem(400, '角色文件名列表无效');
    return [...new Set(input)];
}
function assertAdapter(req) {
    if (typeof globalThis[invalidate] !== 'function' || (req.body?.adapter ?? req.query?.adapter) !== adapterProtocol)
        throw problem(409, '适配未就绪或前后端协议不匹配，请检查配套适配并刷新酒馆');
}
function publicRow(row) {
    return { avatar: row.avatar, id: row.id, name: row.name, tags: row.tags, favorite: row.favorite,
        online: row.state === 'resident', size: row.bytes, imported: row.imported, played: row.played };
}
function writable(a) {
    if (a.operation) throw problem(409, '迁移或恢复进行中，请稍后再修改卡片');
}
function checkActive(a) {
    if (!a.store.managed) throw problem(409, '请先预览并开启角色库管理');
    if (a.store.restoring) throw problem(409, '恢复未完成，请先处理剩余文件并重试恢复');
}

function nativeTargets(a, req, route) {
    if (noWrites.has(route) || route === '/create') return [];
    const body = req.body;
    if (route === '/import') return Object.hasOwn(body, 'library_replace_avatar') ? [body.library_replace_avatar] : [];
    if (route === '/merge-attributes' && Array.isArray(body.avatars)) {
        // The native handler consumes this same snapshot, including the empty-array 'all' form.
        body.avatars = body.avatars.length ? body.avatars : fs.readdirSync(a.dirs.characters).filter(name => name.toLowerCase().endsWith('.png'));
        return body.avatars;
    }
    return [route === '/merge-attributes' ? body.avatar : body.avatar_url];
}

function checkNativeWrite(a, req, route, avatars = nativeTargets(a, req, route)) {
    const body = req.body;
    const replacing = route === '/import' && Object.hasOwn(body, 'library_replace_avatar');
    if (replacing && (typeof body.preserved_name !== 'string' || !body.preserved_name ||
        path.parse(body.preserved_name).name + '.png' !== body.library_replace_avatar)) throw problem(409, '替换目标与原卡文件名不一致');
    const batchIds = new Map((Array.isArray(body.libraryIdentities) ? body.libraryIdentities : []).map(item => [item.avatar, item.id]));
    const client = req.get('x-st-library-client');
    for (const avatar of avatars) {
        const id = batchIds.get(avatar) ?? (avatars.length === 1 ? req.get('x-st-library-id') : undefined);
        a.store.assertWritableName(avatar);
        if (a.store.managed || id || (replacing && a.store.raw(avatar))) runtime.assertIdentity(a, avatar, id);
        if (!a.store.importTimeReady && a.store.raw(avatar)) a.store.refresh(avatar, { backfillImported:true });
        if (replacing) {
            if (a.store.isReserved(avatar) || !fs.existsSync(a.store.location(avatar, 'resident'))) throw problem(409, '原卡已不在酒馆，请重新打开后替换');
            if (!client) throw problem(409, '缺少替换窗口标识，请重新打开角色');
        }
        if ((route === '/rename' || replacing) && runtime.protected(a, client).has(avatar)) throw problem(409, '其他窗口仍在使用该角色，请先退出角色再操作');
        if (route === '/delete') {
            if (runtime.protected(a, client).has(avatar)) throw problem(409, '其他窗口仍在使用该角色');
            const group = runtime.referenced(a, avatar);
            if (group) throw problem(409, '该角色仍属于群聊「' + group + '」');
        }
    }
    if (replacing) req.libraryReplacement = true;
}
function wrap(work) {
    return async (req, res) => {
        try {
            const account = runtime.account(req.user?.directories);
            const data = await work(account, req, res);
            if (!res.headersSent) res.json(data);
        }
        catch (err) { if (!res.headersSent) res.status(err.status || 500).json({ error: err.message, ...(err.code ? { code:err.code } : {}) }); }
    };
}

async function thumbnail(a, req, res) {
    const avatar = req.query.avatar;
    const buffer = await runtime.queue.run(async () => {
        const src = a.store.filePath(avatar);
        const stat = fs.statSync(src);
        const key = JSON.stringify([src, stat.mtimeMs, stat.size]);
        if (thumbnails.has(key)) return thumbnails.get(key);
        const fd = fs.openSync(src, 'r');
        const header = Buffer.alloc(24);
        try { fs.readSync(fd, header, 0, 24, 0); } finally { fs.closeSync(fd); }
        if (stat.size > 64 * 1024 * 1024 || header.readUInt32BE(16) * header.readUInt32BE(20) > 8e6)
            throw problem(413, '图片超出缩略图解码预算');
        const { makeThumbnail } = await import('./thumbnail.mjs');
        const result = await makeThumbnail(src);
        if (thumbnails.size >= 96) thumbnails.delete(thumbnails.keys().next().value);
        thumbnails.set(key, result);
        return result;
    });
    res.set('Cache-Control', 'private, no-cache').type('image/jpeg').send(buffer);
}

export async function init(router) {
    const [{ getConfigValue }, { default: byteSize }, { getUserDirectoriesList }, { importRisuSprites }] = await Promise.all([
        fromST('util.js'), import('bytes'), fromST('users.js'), fromST('endpoints/sprites.js'),
    ]);
    runtime = new Library({ nativeCache: byteSize.parse(getConfigValue('performance.memoryCacheCapacity', '100mb')) ?? 0 });
    for (const dirs of await getUserDirectoriesList()) {
        if (!fs.existsSync(path.join(dirs.root, 'character-library', 'index.sqlite'))) continue;
        try { runtime.account(dirs); }
        catch (error) { console.warn('[角色库]', error.message); }
    }
    globalThis[hooks] = {
        managed: dirs => runtime.account(dirs).store.managed,
        cardId(dirs, avatar, ensure = false) {
            const {store} = runtime.account(dirs);
            store.assertExactName(avatar);
            return (store.get(avatar) ?? (ensure && store.managed ? store.refresh(avatar) : null))?.id;
        },
        assertWritableName: (dirs, avatar) => runtime.account(dirs).store.assertWritableName(avatar),
        hasCard: (dirs, avatar) => Boolean(runtime.account(dirs).store.get(avatar)),
        reserved: (dirs, avatar) => runtime.account(dirs).store.isReserved(avatar),
        renamed(dirs, from, to) {
            const a = runtime.account(dirs);
            if (a.store.get(from)) a.store.renamed(from, to);
            for (const l of a.leases.values()) for (const field of ['current','pending'])
                l[field] = l[field].map(n => n === from ? to : n);
        },
        runNative(req, work, operation) {
            return runtime.queue.run(async () => {
                const a = runtime.account(req.user.directories);
                const route = operation ?? req.path;
                if (route === '/get' || route === '/chats' || route === '/export') a.store.assertExactName(req.body.avatar_url);
                const targets = nativeTargets(a, req, route);
                if (!noWrites.has(route)) {
                    if (a.operation && !(a.store.restoring && route === 'chat-save')) writable(a);
                    checkNativeWrite(a, req, route, targets);
                }
                const result = await work();
                if (route !== 'chat-save' && !noWrites.has(route) && (req.res?.statusCode ?? 200) < 400) {
                    for (const name of req.libraryCreatedAvatars ?? []) {
                        try { a.store.recordImported(name, Date.now()); }
                        catch (error) { console.warn('[角色库] 新卡时间索引未完成：', name, error.message); }
                    }
                    if (route !== '/rename') for (const name of req.libraryUpdatedAvatars ?? targets) {
                        if (a.store.managed || a.store.raw(name)) a.store.refresh(name);
                    }
                    a.scanned = 0;
                    if (a.store.managed && (route === '/create' || route === '/duplicate' || (route === '/import' && !targets.length)))
                        setImmediate(() => runtime?.scan(a));
                }
                return result;
            });
        },
    };
    const post = (name, fn) => router.post('/' + name, wrap(fn));
    post('status', a => ({ managed: a.store.managed, restoring: a.store.restoring, adapted: Boolean(globalThis[invalidate]), progress: a.progress,
        resources: { onlineLimit: runtime.limit, budgetMiB: runtime.budget / (1024 * 1024) } }));
    post('list', (a, req) => {
        runtime.scan(a);
        const b = req.body;
        const result = a.store.query({ search: b.search, tag: b.tag, sort: b.sort, direction: b.dir,
            favoritesFirst: b.pinnedFirst ?? true, page: b.page, pageSize: b.pageSize ?? 24 });
        return { ...result, items: result.items.map(publicRow), progress: a.progress, managed: a.store.managed, restoring: a.store.restoring };
    });
    post('resolve', async (a, req) => {
        const members = req.body.members;
        array(members);
        return { avatars: await runtime.resolveMembers(a, members) };
    });
    post('tag-targets', (a, req) => {
        const avatars = req.body.avatars;
        if (!Array.isArray(avatars) || avatars.some(n => typeof n !== 'string')) throw problem(400, '标签候选无效');
        return { present: avatars.filter(avatar => a.store.hasTagTarget(avatar)) };
    });
    post('prepare', (a, req) => {
        if (a.store.managed) assertAdapter(req);
        return runtime.queue.run(() => runtime.prepare(a, req.body.client, array(req.body.avatars)));
    });
    post('lease', (a, req) => runtime.queue.run(() => runtime.heartbeat(a, req.body.client, array(req.body.avatars), req.body.played === true)));
    for (const op of ['migrate','restore']) post(op, async (a, req) => {
        if (op === 'migrate' && req.body.preview === true) return runtime.migrate(a, true);
        assertAdapter(req); writable(a);
        a.operation = op;
        try { return await (op === 'migrate' ? runtime.migrate(a, false) : runtime.restore(a)); }
        finally { a.operation = null; }
    });
    post('favorite', (a, req) => runtime.queue.run(async () => {
        writable(a); assertAdapter(req); checkActive(a);
        const { avatar, favorite } = req.body;
        if (typeof favorite !== 'boolean') throw problem(400, '收藏状态无效');
        const row = runtime.row(a, avatar);
        const evicted = [];
        if (favorite && row.state === 'cold') {
            evicted.push(...await runtime.trim(a, [{ ...row, favorite: true }], true));
            a.store.load(avatar);
        }
        if (a.store.get(avatar)?.state === 'resident') await globalThis[invalidate]?.(a.dirs, avatar);
        a.store.setFavorite(avatar, favorite);
        evicted.push(...await runtime.trim(a));
        return { ...runtime.snapshot(a, evicted), item: publicRow(a.store.get(avatar)) };
    }));
    post('delete', (a, req) => runtime.queue.run(async () => {
        writable(a); assertAdapter(req); checkActive(a);
        const { avatar, id, deleteChats } = req.body;
        const row = runtime.assertIdentity(a, avatar, id, { resident:false });
        runtime.deletable(a, avatar);
        const folder = a.store.chatDir(avatar);
        const chatFiles = deleteChats === true && fs.existsSync(folder)
            ? fs.readdirSync(folder, { withFileTypes:true }).filter(f => f.isFile() && f.name.endsWith('.jsonl')).map(f => f.name) : [];
        if (row.state === 'resident') await globalThis[invalidate]?.(a.dirs, avatar);
        a.store.remove(avatar, { deleteChats: deleteChats === true });
        return { ...runtime.snapshot(a, [avatar]), deleted:{ avatar, id, name:row.name }, deleteChats:deleteChats === true, chatFiles };
    }));
    post('import', async (a, req) => {
        writable(a); assertAdapter(req); checkActive(a);
        if (!req.is('application/octet-stream')) throw problem(415, '请上传 PNG 或 JSON 原文件');
        if (typeof req.query.name !== 'string') throw problem(400, '缺少文件名');
        if (receivingUpload) throw problem(429, '上传忙，请稍后重试');
        const file = path.join(a.store.base, '.upload-' + randomUUID());
        let size = 0;
        const bounded = new Transform({ transform(chunk, _, callback) {
            size += chunk.length;
            if (size > 64 * 1024 * 1024) callback(problem(413, '单张上传超过 64 MiB'));
            else callback(null, chunk);
        } });
        receivingUpload = true;
        try {
            await pipeline(req, bounded, fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }));
            return await runtime.queue.run(async () => {
                writable(a); checkActive(a);
                const mode = req.query.mode ?? (req.query.rename === '1' ? 'rename' : 'skip');
                if (!['rename', 'skip', 'replace'].includes(mode)) throw problem(400, '无效的同名处理选项');
                if (mode === 'replace') {
                    const avatar = a.store.importTarget(req.query.name);
                    const previous = a.store.refresh(avatar);
                    if (previous) {
                        runtime.assertIdentity(a, avatar, previous.id, { resident:false });
                        if (runtime.protected(a).has(avatar)) throw problem(409, '角色仍被窗口使用，请先退出该角色再替换');
                        if (previous.state === 'resident') await globalThis[invalidate]?.(a.dirs, avatar);
                    }
                }
                const row = a.store.importCard(file, req.query.name, { rename: mode === 'rename', replace: mode === 'replace', importRisuSprites });
                return { item: publicRow(row) };
            });
        } finally {
            try { fs.rmSync(file, { force:true }); } finally { receivingUpload = false; }
        }
    });
    router.get('/thumbnail', wrap(thumbnail));
    timer = setInterval(() => {
        for (const a of runtime.accounts.values()) {
            runtime.expireLeases(a);
            if (!a.store.managed || a.store.restoring || a.operation) continue;
            runtime.scan(a);
            runtime.queue.run(() => runtime.trim(a)).catch(err => console.warn('[角色库]', err.message));
        }
    }, 60000);
    timer.unref();
}

export async function exit() {
    clearInterval(timer);
    delete globalThis[hooks];
    await Promise.all([...runtime.accounts.values()].map(a => a.scan));
    await runtime.queue.tail;
    runtime.close(); thumbnails.clear();
}
