import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readMeta, readCard, writeChanged, stageSprites } from './card.mjs';

function fail(message, status = 409, code) {
    throw Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
}

function filename(avatar) {
    if (typeof avatar !== 'string' || !avatar.endsWith('.png') || avatar.length <= 4 ||
        /[<>:"/\\|?*\x00-\x1f]/.test(avatar) || /^ |[. ]\.png$/.test(avatar) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(avatar) || Buffer.byteLength(avatar) > 255) {
        fail('无效的角色 PNG 文件名', 400);
    }
    return avatar;
}

// 1.18.0 derives some native write targets by removing the first literal ".png".
function nativeAvatar(avatar) { return avatar.replace('.png', '') + '.png'; }

function stat(file) {
    const s = fs.lstatSync(file, { throwIfNoEntry: false, bigint: true });
    if (!s) return null;
    if (!s.isFile()) fail('角色位置上存在非普通文件');
    return { bytes: Number(s.size), stamp: String(s.mtimeNs), inode: String(s.dev) + ':' + String(s.ino) };
}

function matches(row, file) {
    return row && file && row.bytes === file.bytes && row.stamp === file.stamp && row.inode === file.inode;
}

function item(row) {
    if (!row || row.state === 'reserved') return null;
    const { tags, favorite, stamp, inode, intent, imported_checked, ...rest } = row;
    return { ...rest, tags: JSON.parse(tags), favorite: Boolean(favorite) };
}

function pageNumber(number, fallback, max) {
    const n = Number(number);
    return Number.isSafeInteger(n) ? Math.min(max, Math.max(1, n)) : fallback;
}

// A directory entry is authoritative. Linux names which only differ in case stay distinct.
export function inspectAliases(dirs, db, avatar) {
    filename(avatar);
    const sameName = name => process.platform === 'win32' ? name.toLowerCase() === avatar.toLowerCase() : name === avatar;
    const files = [];
    for (const [directory, state] of [[dirs.characters, 'resident'], [path.join(dirs.root, 'character-library', 'cards'), 'cold']]) {
        const handle = fs.opendirSync(directory);
        try {
            for (let entry; (entry = handle.readSync());) {
                if (sameName(entry.name)) files.push({ avatar:entry.name, state, file:path.join(directory, entry.name), regular:entry.isFile() });
            }
        } finally { handle.closeSync(); }
    }
    const rows = [];
    for (const row of process.platform === 'win32' ? db.prepare('SELECT * FROM cards').iterate() : db.prepare('SELECT * FROM cards WHERE avatar=?').iterate(avatar)) {
        if (sameName(row.avatar)) rows.push(row);
    }
    return { files, rows };
}

export class Store {
    constructor(directories) {
        this.dirs = directories;
        this.base = path.join(directories.root, 'character-library');
        this.cold = path.join(this.base, 'cards');
        fs.mkdirSync(this.cold, { recursive: true, mode: 0o700 });
        if (fs.statSync(this.cold).dev !== fs.statSync(directories.characters).dev) {
            fail('角色库与角色目录必须位于同一个文件系统');
        }
        this.db = new DatabaseSync(path.join(this.base, 'index.sqlite'));
        try {
            this.db.exec(
                'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;' +
                'CREATE TABLE IF NOT EXISTS cards (' +
                'avatar TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, tags TEXT NOT NULL,' +
                'favorite INTEGER NOT NULL, bytes INTEGER NOT NULL, parsedBytes INTEGER NOT NULL,' +
                'imported INTEGER, played INTEGER, state TEXT NOT NULL, stamp TEXT, inode TEXT, intent TEXT, imported_checked INTEGER NOT NULL DEFAULT 0);' +
                'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value INTEGER NOT NULL);'
            );
            if (!this.db.prepare('PRAGMA table_info(cards)').all().some(column => column.name === 'imported_checked'))
                this.db.exec('ALTER TABLE cards ADD COLUMN imported_checked INTEGER NOT NULL DEFAULT 0');
        } catch (error) {
            this.db.close();
            throw error;
        }
    }

    get managed() { return Boolean(this.db.prepare("SELECT value FROM settings WHERE key='managed'").get()?.value); }
    set managed(value) { this.db.prepare("INSERT OR REPLACE INTO settings VALUES ('managed',?)").run(Number(Boolean(value))); }
    get restoring() { return Boolean(this.db.prepare("SELECT value FROM settings WHERE key='restoring'").get()?.value); }
    set restoring(value) { this.db.prepare("INSERT OR REPLACE INTO settings VALUES ('restoring',?)").run(Number(Boolean(value))); }
    finishRestore() { this.db.exec("INSERT OR REPLACE INTO settings VALUES ('restoring',0),('managed',0)"); }
    get importTimeReady() { return this.db.prepare("SELECT value FROM settings WHERE key='import_time_revision'").get()?.value === 1; }
    finishImportTimeUpgrade() { this.db.prepare("INSERT OR REPLACE INTO settings VALUES ('import_time_revision',1)").run(); }
    close() { this.db.close(); }
    raw(avatar) { return this.db.prepare('SELECT * FROM cards WHERE avatar=?').get(filename(avatar)); }
    get(avatar) { return item(this.raw(avatar)); }
    residents() { return this.db.prepare("SELECT * FROM cards WHERE state='resident' ORDER BY played IS NOT NULL, played, avatar").all().map(item); }
    location(avatar, state) { return path.join(state === 'resident' ? this.dirs.characters : this.cold, filename(avatar)); }
    chatDir(avatar) { return path.join(this.dirs.chats, filename(avatar).slice(0, -4)); }

    assertExactName(avatar) {
        filename(avatar);
        if (process.platform !== 'win32') return;
        const { files, rows } = inspectAliases(this.dirs, this.db, avatar);
        if (files.length === 1 && rows.length > 1) {
            fail('同一文件存在多个身份，请停服使用 repair-index.mjs 选择保留 ID：' + files[0].avatar + '；' +
                rows.map(row => row.avatar + ' = ' + row.id).join('；'));
        }
        if (files.some(file => file.avatar !== avatar)) fail('角色文件名拼写不一致，请使用实际文件名：' + files.map(file => file.avatar).join('、'));
    }

    assertWritableName(avatar) {
        this.assertExactName(avatar);
        const reserved = this.reservedRow(avatar);
        if (reserved?.state === 'reserved') fail('文件名已被旧角色保留，请另存同名新卡');
        const target = nativeAvatar(filename(avatar));
        if (target !== avatar) fail(avatar + ' 的原生写入目标为 ' + target + '，聊天目录为 ' + target.slice(0, -4) + '，请先处理文件名歧义');
        if (!avatar.endsWith('.png.png')) return;
        for (const dir of [this.dirs.characters, this.cold]) {
            const alias = fs.readdirSync(dir).find(name => name !== avatar && name.endsWith('.png') && nativeAvatar(name) === avatar);
            if (alias) fail(avatar + ' 与 ' + alias + ' 共用原生写入路径，请先处理文件名歧义');
        }
    }

    hasTagTarget(avatar) {
        // Old tag settings may contain arbitrary keys. Only a single PNG name can denote a card.
        try { filename(avatar); } catch { return false; }
        return Boolean(this.raw(avatar)?.intent || stat(this.location(avatar, 'resident')) || stat(this.location(avatar, 'cold')));
    }

    byDisplayName(name) {
        return this.db.prepare("SELECT avatar FROM cards WHERE state != 'reserved' AND name=? LIMIT 2").all(name);
    }

    restoreCandidates() {
        const names = new Set(fs.readdirSync(this.cold).filter(n => n.toLowerCase().endsWith('.png')));
        for (const row of this.db.prepare("SELECT avatar FROM cards WHERE state='cold' OR intent IS NOT NULL").iterate()) names.add(row.avatar);
        return names;
    }

    isReserved(avatar) {
        const row = this.reservedRow(avatar);
        if (row?.state === 'cold' || row?.state === 'reserved' || row?.intent || fs.existsSync(this.location(avatar, 'cold'))) return true;
        return !fs.existsSync(this.location(avatar, 'resident')) && fs.existsSync(this.chatDir(avatar));
    }

    reservedRow(avatar) {
        filename(avatar);
        if (process.platform !== 'win32') return this.raw(avatar);
        for (const row of this.db.prepare("SELECT * FROM cards WHERE state IN ('reserved','cold') OR intent IS NOT NULL").iterate()) {
            if (row.avatar.toLowerCase() === avatar.toLowerCase()) return row;
        }
        return this.raw(avatar);
    }

    query({ search = '', tag = '', sort = 'imported', direction = 'desc', favoritesFirst = true, page = 1, pageSize = 36 } = {}) {
        const columns = { name: 'name COLLATE NOCASE', imported: 'imported', played: 'played', size: 'bytes' };
        const column = Object.hasOwn(columns, sort) ? columns[sort] : columns.imported;
        const order = direction === 'asc' ? 'ASC' : 'DESC';
        page = pageNumber(page, 1, 100000000);
        pageSize = pageNumber(pageSize, 36, 100);
        const where = ["state != 'reserved'"];
        const params = [];
        if (search) {
            where.push('(instr(lower(name),lower(?)) OR instr(lower(avatar),lower(?)) OR EXISTS (SELECT 1 FROM json_each(cards.tags) WHERE instr(lower(value),lower(?))))');
            params.push(search, search, search);
        }
        if (tag) {
            where.push('EXISTS (SELECT 1 FROM json_each(cards.tags) WHERE value = ? COLLATE NOCASE)');
            params.push(tag);
        }
        const from = ' FROM cards WHERE ' + where.join(' AND ');
        const total = this.db.prepare('SELECT count(*) AS n' + from).get(...params).n;
        const sql = 'SELECT *' + from + ' ORDER BY ' + (favoritesFirst ? 'favorite DESC, ' : '') +
            column + ' ' + order + ' NULLS LAST, id LIMIT ? OFFSET ?';
        const rows = this.db.prepare(sql).all(...params, pageSize, (page - 1) * pageSize);
        return { items: rows.map(item), total, page, pageSize };
    }

    // Called by the process-wide queue, one yielded avatar at a time.
    *discover({ includeUnchanged = false } = {}) {
        for (const [directory, state] of [[this.dirs.characters, 'resident'], [this.cold, 'cold']]) {
            const handle = fs.opendirSync(directory);
            try {
                for (let entry; (entry = handle.readSync());) {
                    if (!entry.name.endsWith('.png')) continue;
                    const avatar = entry.name;
                    let changed = true;
                    try {
                        const row = this.raw(avatar);
                        changed = row?.state !== state || row.intent || !matches(row, stat(path.join(directory, avatar)));
                    } catch {
                        // Let the caller report this entry's error and keep scanning the others.
                    }
                    if (changed || includeUnchanged) yield avatar;
                }
            } finally { handle.closeSync(); }
        }
        for (const row of this.db.prepare("SELECT avatar,state,intent FROM cards WHERE state != 'reserved'").iterate()) {
            if (row.intent || !fs.existsSync(this.location(row.avatar, row.state))) yield row.avatar;
        }
    }

    index(avatar, state, imported, staged, backfillImported = false) {
        this.assertExactName(avatar);
        const file = this.location(avatar, state);
        const before = stat(file);
        if (!before) fail('角色文件不存在', 404);
        const meta = matches(staged?.file, before) ? staged.meta : readMeta(file);
        const previous = this.raw(avatar);
        const recorded = previous ? (backfillImported && !previous.imported_checked && previous.imported === null ? meta.imported : previous.imported) : (imported ?? meta.imported);
        const checked = !previous || backfillImported || previous.imported_checked ? 1 : 0;
        if (!matches(before, stat(file))) fail('角色正在被写入，请重试');
        this.db.prepare('INSERT INTO cards (avatar,id,name,tags,favorite,bytes,parsedBytes,imported,state,stamp,inode,imported_checked)' +
            ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(avatar) DO UPDATE SET name=excluded.name,tags=excluded.tags,' +
            ' favorite=excluded.favorite,bytes=excluded.bytes,parsedBytes=excluded.parsedBytes,state=excluded.state,' +
            ' stamp=excluded.stamp,inode=excluded.inode,intent=NULL,imported=excluded.imported,imported_checked=excluded.imported_checked')
            .run(avatar, randomUUID(), meta.name, JSON.stringify(meta.tags), Number(meta.favorite),
                before.bytes, meta.parsedBytes, recorded ?? null, state, before.stamp, before.inode, checked);
        return this.get(avatar);
    }

    refresh(avatar, { backfillImported = false } = {}) {
        this.assertExactName(avatar);
        const row = this.raw(avatar);
        if (row?.intent === 'load' || row?.intent === 'withdraw') {
            const result = this.finishMove(row);
            return backfillImported ? this.refresh(avatar, { backfillImported }) : result;
        }
        if (row?.intent === 'delete' || row?.intent === 'purge') return this.finishDelete(row);
        const hot = stat(this.location(avatar, 'resident'));
        const cold = stat(this.location(avatar, 'cold'));
        if (hot && cold) fail('酒馆和角色库中有两个同名文件，请先处理冲突');
        if (row?.state === 'reserved' && (hot || cold)) fail('文件名已被旧角色保留，请另存同名新卡');
        if (!hot && !cold) {
            if (row?.state === 'cold') fail('归库文件丢失，请从备份恢复');
            if (row?.state === 'resident') this.forget(avatar);
            return null;
        }
        const state = hot ? 'resident' : 'cold';
        if (row?.state === state && matches(row, hot || cold) && !(backfillImported && !row.imported_checked)) return item(row);
        // Existing timestamps are preserved; new/rebuilt entries use only recorded card dates.
        return this.index(avatar, state, null, undefined, backfillImported);
    }

    recordImported(avatar, time) {
        this.need(avatar);
        this.db.prepare('UPDATE cards SET imported=?,imported_checked=1 WHERE avatar=?').run(time, avatar);
    }

    importTarget(originalName) {
        const ext = path.extname(originalName).toLowerCase();
        if (!['.png','.json'].includes(ext)) fail('请选择 PNG 或 JSON 角色卡',400);
        let stem = filename(originalName.slice(0,-ext.length)+'.png').slice(0,-4);
        if (nativeAvatar(stem+'.png') !== stem+'.png') stem=stem.replaceAll('.png','-png');
        return filename(stem+'.png');
    }

    replaceCard(source, originalName) {
        const avatar=this.importTarget(originalName);
        this.assertWritableName(avatar);
        const row=this.need(avatar);
        if (row.intent) fail('角色移动尚未完成');
        const target=this.location(avatar,row.state), before=stat(target);
        const original=readCard(target).card;
        const stage=path.join(path.dirname(target),'.replace-'+randomUUID());
        const preserve={chat:original.chat,create_date:original.create_date};
        try {
            writeChanged(source,stage,{format:path.extname(originalName).slice(1).toLowerCase(),favorite:row.favorite,preserve});
            readMeta(stage);
            if (!matches(before,stat(target))) fail('替换期间原卡已变化');
            const backup=stage+'.old';
            fs.linkSync(target,backup);
            let swapped=false, committed=false;
            try {
                this.db.exec('BEGIN IMMEDIATE');
                try {
                    fs.renameSync(stage,target); swapped=true;
                    const result=this.refresh(avatar);
                    this.db.exec('COMMIT'); committed=true;
                    return result;
                } catch(error) {
                    if (swapped) fs.renameSync(backup,target);
                    this.db.exec('ROLLBACK');
                    throw error;
                }
            } finally {
                if (committed || !swapped) fs.rmSync(backup,{force:true});
            }
        } finally {fs.rmSync(stage,{force:true});}
    }

    importCard(source, originalName, { rename = false, replace = false, importRisuSprites } = {}) {
        if (replace && this.refresh(this.importTarget(originalName))) return this.replaceCard(source,originalName);
        const ext = path.extname(originalName).toLowerCase();
        if (ext !== '.png' && ext !== '.json') fail('请选择 PNG 或 JSON 角色卡', 400);
        let stem = filename(originalName.slice(0, -ext.length) + '.png').slice(0, -4);
        if (nativeAvatar(stem + '.png') !== stem + '.png') stem = stem.replaceAll('.png', '-png');
        let avatar = filename(stem + '.png');
        const taken = name => this.raw(name) || this.isReserved(name) || fs.existsSync(this.location(name, 'resident'));
        for (let i = 2; taken(avatar); i++) {
            if (!rename) fail('角色文件或保留的聊天已占用这个文件名，可选择另存', 409, 'CHARACTER_LIBRARY_DUPLICATE');
            const numbered = stem + ' (' + i + ').png';
            avatar = filename(nativeAvatar(numbered) === numbered ? numbered : stem.replaceAll('.png', '-png') + ' (' + i + ').png');
        }
        this.assertWritableName(avatar);
        const tmp = fs.mkdtempSync(path.join(this.base, '.import-'));
        const stage = path.join(tmp, 'card');
        const sprites = path.join(tmp, 'sprites');
        const target = this.location(avatar, 'cold');
        const created = [];
        const publish = (file, dest) => {
            const before = stat(file);
            fs.linkSync(file, dest);
            created.push([dest, before]);
        };
        try {
            writeChanged(source, stage, { format: ext.slice(1), importing: true });
            const staged = { file: stat(stage), meta: stageSprites(stage, importRisuSprites, { ...this.dirs, characters: sprites }) };
            publish(stage, target);
            // Keep embedded assets in the card as well. Recovery after a crash
            // can always recover the original sprites from this authoritative file.
            if (fs.existsSync(sprites)) {
                for (const group of fs.readdirSync(sprites, { withFileTypes: true })) {
                    if (!group.isDirectory()) fail('立绘导入目录无效');
                    const folder = path.join(this.dirs.characters, group.name);
                    fs.mkdirSync(folder, { recursive: true });
                    if (!fs.lstatSync(folder).isDirectory()) fail('立绘目标不是普通目录');
                    const staged = path.join(sprites, group.name);
                    for (const sprite of fs.readdirSync(staged, { withFileTypes: true })) {
                        if (!sprite.isFile()) fail('立绘导入文件无效');
                        try { publish(path.join(staged, sprite.name), path.join(folder, sprite.name)); }
                        catch (error) { if (error.code !== 'EEXIST') throw error; }
                    }
                }
            }
            return this.index(avatar, 'cold', Date.now(), staged);
        } catch (error) {
            for (const [dest, before] of created.reverse()) {
                if (matches(before, stat(dest))) fs.unlinkSync(dest);
            }
            throw error;
        } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    }

    need(avatar) {
        const row = this.refresh(avatar);
        if (!row) fail('角色不存在', 404);
        return row;
    }

    filePath(avatar) {
        const row = this.need(avatar);
        return this.location(avatar, row.state);
    }

    move(avatar, destination) {
        const card = this.need(avatar);
        if (card.state === destination) return card;
        if (destination === 'cold' && card.favorite) fail('请先取消收藏');
        const intent = destination === 'resident' ? 'load' : 'withdraw';
        this.db.prepare('UPDATE cards SET intent=? WHERE avatar=?').run(intent, avatar);
        return this.finishMove(this.raw(avatar));
    }

    finishMove(row) {
        this.assertExactName(row.avatar);
        const destination = row.intent === 'load' ? 'resident' : 'cold';
        const source = this.location(row.avatar, row.state);
        const target = this.location(row.avatar, destination);
        const old = stat(source);
        let next = stat(target);
        if (!old && !next) fail('中断的移动缺少原文件，请从备份恢复');
        if (old && !next) {
            if (!matches(row, old)) {
                // A native editor replaced the source before the move started.
                this.db.prepare('UPDATE cards SET intent=NULL WHERE avatar=?').run(row.avatar);
                this.refresh(row.avatar);
                fail('移动前角色已被编辑，请重试');
            }
            fs.linkSync(source, target);
            next = stat(target);
        }
        if (old) {
            if (next.inode !== old.inode) fail('移动遇到两个不同的同名文件，已保留两份');
            fs.unlinkSync(source);
        } else if (next.inode !== row.inode) {
            fail('移动目标已被另一个文件替换，请先处理冲突');
        }
        this.db.prepare('UPDATE cards SET state=?,intent=NULL WHERE avatar=?').run(destination, row.avatar);
        return this.refresh(row.avatar);
    }

    load(avatar) { return this.move(avatar, 'resident'); }
    withdraw(avatar) { return this.move(avatar, 'cold'); }

    touch(avatar) {
        this.db.prepare("UPDATE cards SET played=? WHERE avatar=? AND state='resident'").run(Date.now(), filename(avatar));
        return this.get(avatar);
    }

    setFavorite(avatar, value) {
        this.assertWritableName(avatar);
        if (typeof value !== 'boolean') fail('无效的收藏状态', 400);
        const row = this.need(avatar);
        if (row.favorite === value) return row;
        const file = this.location(avatar, row.state);
        const before = stat(file);
        const stage = path.join(path.dirname(file), '.write-' + randomUUID());
        try {
            writeChanged(file, stage, { favorite: value });
            if (!matches(before, stat(file))) fail('收藏更新期间角色已被编辑，请重试');
            fs.renameSync(stage, file);
        } finally { fs.rmSync(stage, { force: true }); }
        return this.refresh(avatar);
    }

    renamed(oldAvatar, newAvatar) {
        const row = this.raw(oldAvatar);
        if (oldAvatar === newAvatar) return this.refresh(oldAvatar);
        if (!row) return this.refresh(newAvatar);
        if (row.state !== 'resident' || row.intent || this.raw(newAvatar) || stat(this.location(oldAvatar, 'resident')) ||
            stat(this.location(newAvatar, 'cold')) || !stat(this.location(newAvatar, 'resident'))) fail('无法确认原生改名结果');
        this.db.exec('BEGIN IMMEDIATE');
        try {
            this.db.prepare('UPDATE cards SET avatar=? WHERE avatar=?').run(filename(newAvatar), oldAvatar);
            if (this.managed) this.db.prepare("INSERT INTO cards(avatar,id,name,tags,favorite,bytes,parsedBytes,state) VALUES(?,?,?,'[]',0,0,0,'reserved')")
                .run(oldAvatar, randomUUID(), row.name);
            this.db.exec('COMMIT');
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
        return this.refresh(newAvatar);
    }

    remove(avatar, { deleteChats = false } = {}) {
        this.assertWritableName(avatar);
        this.need(avatar);
        this.db.prepare('UPDATE cards SET intent=? WHERE avatar=?').run(deleteChats ? 'purge' : 'delete', avatar);
        return this.finishDelete(this.raw(avatar));
    }

    finishDelete(row) {
        this.assertExactName(row.avatar);
        const file = this.location(row.avatar, row.state);
        const current = stat(file);
        if (stat(this.location(row.avatar, row.state === 'resident' ? 'cold' : 'resident'))) fail('同名文件冲突，删除已停止');
        if (current) {
            if (!matches(row, current)) fail('角色在删除期间已被替换，请先处理冲突');
            fs.unlinkSync(file);
        }
        if (row.intent === 'purge') fs.rmSync(this.chatDir(row.avatar), { recursive: true, force: true });
        this.forget(row.avatar);
        return null;
    }

    forget(avatar) {
        if (this.managed || fs.existsSync(this.chatDir(avatar))) {
            this.db.prepare("UPDATE cards SET state='reserved',intent=NULL WHERE avatar=?").run(avatar);
        } else {
            this.db.prepare('DELETE FROM cards WHERE avatar=?').run(avatar);
        }
    }
}
