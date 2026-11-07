import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Store } from '../server/store.mjs';
import { Library } from '../server/runtime.mjs';
import { writeChanged } from '../server/card.mjs';
import { recover } from '../recover.mjs';

function fixture(t) {
    const root = fs.mkdtempSync(path.join(process.env.CHARLIB_TEST_ROOT || os.tmpdir(), 'st-library-'));
    const dirs = { root, characters: path.join(root, 'characters'), chats: path.join(root, 'chats') };
    fs.mkdirSync(dirs.characters);
    fs.mkdirSync(dirs.chats);
    const store = new Store(dirs);
    t.after(() => {
        store.close();
        if (!process.env.CHARLIB_TEST_ROOT) fs.rmSync(root, { recursive: true, force: true });
    });
    const card = { spec: 'chara_card_v3', spec_version: '3.0', chat: 'Session A',
        data: { name: 'River', tags: ['riverbank'], extensions: { tavern_helper: { scripts: [{ content: 'window.fixture = true' }] } } } };
    const src = path.join(root, 'card.json');
    fs.writeFileSync(src, JSON.stringify(card));
    return { dirs, store, src, card };
}

test('accounts isolate identical avatar names and share one resident budget', async t => {
    const first = fixture(t);
    const second = fixture(t);
    const engine = new Library({ limit: 1 });
    t.after(() => engine.close());
    const a = engine.account(first.dirs), b = engine.account(second.dirs);
    a.store.managed = b.store.managed = true;
    const one = a.store.importCard(first.src, 'Shared.json');
    assert.equal(b.store.get(one.avatar), null);
    const two = b.store.importCard(second.src, 'Shared.json');
    assert.notEqual(one.id, two.id);
    await engine.prepare(a, 'first-window', [one.avatar]);
    await engine.heartbeat(a, 'first-window', [one.avatar], true);
    await assert.rejects(engine.prepare(b, 'second-window', [two.avatar]), /预算/);
    assert.equal(a.store.get(one.avatar).state, 'resident');
    assert.equal(b.store.get(two.avatar).state, 'cold');
    await engine.heartbeat(a, 'first-window', [], true);
    await engine.prepare(b, 'second-window', [two.avatar]);
    assert.equal(a.store.get(one.avatar).state, 'cold');
    assert.equal(b.store.get(two.avatar).state, 'resident');
});

test('tavern dates backfill an unchanged old index, preserve identity and survive lifecycle', async t=>{
    const {dirs,store,src,card}=fixture(t);
    card.create_date='2020-03-04T05:06:07.000Z';fs.writeFileSync(src,JSON.stringify(card));
    const hot=path.join(dirs.characters,'Early.png');writeChanged(src,hot,{format:'json'});
    const early=store.refresh('Early.png');assert.equal(early.imported,Date.parse(card.create_date));
    store.db.prepare('UPDATE cards SET imported=NULL,imported_checked=0 WHERE avatar=?').run('Early.png');
    const lib=new Library();const a=lib.account(dirs);await lib.scan(a,true);
    assert.equal(a.store.get('Early.png').imported,Date.parse(card.create_date));assert.equal(a.store.get('Early.png').id,early.id);
    a.store.managed=true;a.store.withdraw('Early.png');a.store.load('Early.png');a.store.setFavorite('Early.png',true);
    card.create_date='2025-01-01T00:00:00Z';writeChanged(src,path.join(dirs.characters,'Stage.png'),{format:'json'});fs.renameSync(path.join(dirs.characters,'Stage.png'),hot);
    assert.equal(a.store.refresh('Early.png').imported,Date.parse('2020-03-04T05:06:07Z'));
    lib.close();
});

test('unknown dates sort last within favorites in both directions without filesystem time fallback',t=>{
    const {dirs,store,src,card}=fixture(t);
    for(const [avatar,date] of [['Known.png','2020-01-01T00:00:00+08:00'],['Unknown.png','2020-01-01@00h00m00s000ms'],['Invalid.png','2020-02-30T00:00:00Z']]){
        card.create_date=date;fs.writeFileSync(src,JSON.stringify(card));writeChanged(src,path.join(dirs.characters,avatar),{format:'json'});store.refresh(avatar);
    }
    assert.equal(store.get('Known.png').imported,Date.parse('2020-01-01T00:00:00+08:00'));
    assert.equal(store.get('Unknown.png').imported,null);assert.equal(store.get('Invalid.png').imported,null);
    for(const direction of ['asc','desc'])assert.equal(store.query({sort:'imported',direction}).items[0].avatar,'Known.png');
    store.setFavorite('Unknown.png',true);
    assert.equal(store.query({sort:'imported'}).items[0].avatar,'Unknown.png');
    assert.equal(store.query({sort:'imported',favoritesFirst:false}).items[0].avatar,'Known.png');
});

test('legacy schema upgrade checkpoints unknown dates across failed scans and restart',async t=>{
    const {dirs,store,src,card}=fixture(t);
    writeChanged(src,path.join(dirs.characters,'Unknown.png'),{format:'json'});const original=store.refresh('Unknown.png');
    store.db.exec('ALTER TABLE cards DROP COLUMN imported_checked');
    fs.writeFileSync(path.join(dirs.characters,'Broken.png'),'invalid PNG');
    let engine=new Library();let a=engine.account(dirs);await engine.scan(a,true);
    assert.equal(a.progress.failed,1);assert.equal(a.store.importTimeReady,false);assert.equal(a.store.raw('Unknown.png').imported_checked,1);
    engine.close();card.create_date='2030-01-01T00:00:00Z';fs.writeFileSync(src,JSON.stringify(card));
    const stage=path.join(dirs.characters,'Stage.png');writeChanged(src,stage,{format:'json'});fs.renameSync(stage,path.join(dirs.characters,'Unknown.png'));
    engine=new Library();a=engine.account(dirs);await engine.scan(a,true);
    assert.equal(a.store.get('Unknown.png').imported,null);assert.equal(a.store.get('Unknown.png').id,original.id);
    assert.equal(a.store.importTimeReady,false);engine.close();
});

test('an existing assistant card, saved chat and stable identity survive cold and hot moves', t => {
    const { dirs, store, src, card } = fixture(t);
    const avatar = 'River.png';
    const hot = path.join(dirs.characters, avatar);
    writeChanged(src, hot, { format: 'json' });
    const original = fs.readFileSync(hot);
    fs.mkdirSync(path.join(dirs.chats, 'River'));
    const chat = path.join(dirs.chats, 'River', 'Session A.jsonl');
    fs.writeFileSync(chat, '{"chat_metadata":{"variables":{"scene":2}}}\n');
    assert.deepEqual([...store.discover()], [avatar]);
    const row = store.refresh(avatar);
    assert.equal(row.imported, null);
    assert.deepEqual([...store.discover()], []);
    store.withdraw(avatar);
    assert.equal(store.get(avatar).state, 'cold');
    assert.equal(store.load(avatar).id, row.id);
    assert.deepEqual(fs.readFileSync(hot), original);

    card.data.extensions.tavern_helper.scripts[0].content = 'window.fixture = 42';
    fs.writeFileSync(src, JSON.stringify(card));
    fs.unlinkSync(hot);
    writeChanged(src, hot, { format: 'json' });
    const edited = fs.readFileSync(hot);
    store.withdraw(avatar);
    store.load(avatar);
    assert.deepEqual(fs.readFileSync(hot), edited);
    assert.equal(JSON.parse(fs.readFileSync(chat)).chat_metadata.variables.scene, 2);
    assert.equal(store.setFavorite(avatar, true).favorite, true);
    assert.throws(() => store.withdraw(avatar), /收藏/);
    store.setFavorite(avatar, false);
    store.withdraw(avatar);
    const info = store.query({ search: 'riverbank', tag: 'riverbank' });
    assert.equal(info.total, 1);
    assert.equal(info.items[0].parsedBytes > 0, true);
    assert.equal(store.remove(avatar), null);
    assert.equal(store.isReserved(avatar), true);
    assert.equal(fs.existsSync(chat), true);
    assert.throws(() => store.importCard(src, 'River.json'), /占用/);
    const fresh = store.importCard(src, 'River.json', { rename: true });
    assert.equal(fresh.avatar, 'River (2).png');
    assert.notEqual(fresh.id, row.id);
});

test('recover interrupted linking but keep genuinely different files on both sides', t => {
    const { store, src, dirs } = fixture(t);
    const row = store.importCard(src, 'Fresh.json');
    assert.equal(row.state, 'cold');
    const cold = store.filePath(row.avatar);
    const hot = path.join(dirs.characters, row.avatar);
    store.db.prepare("UPDATE cards SET intent='load' WHERE avatar=?").run(row.avatar);
    fs.linkSync(cold, hot);
    assert.equal(store.refresh(row.avatar).state, 'resident');
    assert.equal(fs.existsSync(cold), false);
    store.db.prepare("UPDATE cards SET intent='withdraw' WHERE avatar=?").run(row.avatar);
    fs.copyFileSync(hot, cold);
    assert.throws(() => store.refresh(row.avatar), /保留两份/);
    assert.equal(fs.existsSync(cold) && fs.existsSync(hot), true);
    assert.throws(() => store.remove('../Fresh.png'), /无效/);
});

test('offline preview and recovery preserve conflicting cards and work without a readable index', t => {
    const root = fs.mkdtempSync(path.join(process.env.CHARLIB_TEST_ROOT || os.tmpdir(), 'st-recover-'));
    t.after(() => { if (!process.env.CHARLIB_TEST_ROOT) fs.rmSync(root, { recursive: true, force: true }); });
    const base = path.join(root, 'character-library');
    const cold = path.join(base, 'cards'), hot = path.join(root, 'characters');
    fs.mkdirSync(cold, { recursive: true });
    fs.mkdirSync(hot);
    fs.writeFileSync(path.join(cold, 'Archived.png'), 'original-bytes');
    fs.writeFileSync(path.join(cold, 'Conflict.png'), 'cold-bytes');
    fs.writeFileSync(path.join(hot, 'Conflict.png'), 'hot-bytes');
    assert.deepEqual(recover(root), { pending: 1, restored: 0, conflicts: 1 });
    assert.equal(fs.existsSync(path.join(hot, 'Archived.png')), false);
    const index = path.join(base, 'index.sqlite');
    fs.writeFileSync(index, 'invalid sqlite');
    const engine = new Library();
    assert.throws(() => engine.account({ root, characters:hot }), /recover\.mjs/);
    engine.close();
    assert.deepEqual(recover(root, true), { pending: 0, restored: 1, conflicts: 1 });
    assert.equal(fs.readFileSync(path.join(hot, 'Archived.png'), 'utf8'), 'original-bytes');
    assert.equal(fs.readFileSync(path.join(hot, 'Conflict.png'), 'utf8'), 'hot-bytes');
    assert.equal(fs.readFileSync(path.join(cold, 'Conflict.png'), 'utf8'), 'cold-bytes');
    assert.equal(fs.readFileSync(index, 'utf8'), 'invalid sqlite');
});

test('cold import stages Risu sprites and keeps existing assets on collision', t => {
    const { store, src, dirs, card } = fixture(t);
    card.data.extensions.risuai = { emotions: [['smile', 'YWJj']] };
    fs.writeFileSync(src, JSON.stringify(card));
    const existing = path.join(dirs.characters, 'River', 'smile.png');
    fs.mkdirSync(path.dirname(existing));
    fs.writeFileSync(existing, 'older image');
    let calls = 0;
    function importRisuSprites(temp, raw) {
        calls++;
        assert.notEqual(temp.characters, dirs.characters);
        const folder = path.join(temp.characters, 'River');
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(path.join(folder, 'smile.png'), 'new image');
        fs.writeFileSync(path.join(folder, 'extra.png'), 'extra image');
        delete raw.data.extensions.risuai.emotions;
    }
    store.importCard(src, 'New.json', { importRisuSprites });
    assert.throws(() => store.importCard(src, 'New.json', { importRisuSprites }), /占用/);
    assert.equal(calls, 1);
    assert.equal(fs.readFileSync(existing, 'utf8'), 'older image');
    assert.equal(fs.readFileSync(path.join(path.dirname(existing), 'extra.png'), 'utf8'), 'extra image');
});

test('native write paths stay distinct, stale identities are rejected and released names stay reserved', async t => {
    const { dirs, src } = fixture(t);
    const engine = new Library();
    t.after(() => engine.close());
    const a = engine.account(dirs);
    const { store } = a;
    store.managed = true;
    assert.equal(store.importCard(src, 'Hero.png.v2.json').avatar, 'Hero-png.v2.png');
    assert.equal(store.importCard(src, 'repeat.png.json').avatar, 'repeat.png.png');
    const old = store.importCard(src, '.Alice.json');
    const prepared = await engine.prepare(a, 'local-window', [old.avatar]);
    assert.deepEqual(prepared.identities, [{ id: old.id, avatar: '.Alice.png' }]);
    assert.equal(engine.assertIdentity(a, old.avatar, old.id).id, old.id);
    assert.throws(() => engine.assertIdentity(a, old.avatar, 'stale-id', { resident:false }), /身份/);
    store.withdraw(old.avatar);
    assert.throws(() => engine.assertIdentity(a, old.avatar, old.id), /位置/);
    assert.equal(store.hasTagTarget(old.avatar), true);
    store.load(old.avatar);
    const renamed = 'Alice (2).png';
    fs.renameSync(store.location(old.avatar, 'resident'), store.location(renamed, 'resident'));
    assert.equal(store.renamed(old.avatar, renamed).id, old.id);
    assert.equal(store.isReserved(old.avatar), true);
    assert.equal(store.hasTagTarget(old.avatar), false);
    store.remove(renamed);
    assert.equal(store.isReserved(renamed), true);
    assert.notEqual(store.importCard(src, '.Alice.json', {rename:true}).id, old.id);

    for (const avatar of ['Hero.png.v2.png', 'Hero.v2.png.png', '.Other.png']) {
        writeChanged(src, store.location(avatar, 'resident'), { format:'json' });
    }
    const preview = await engine.migrate(a, true);
    assert.deepEqual(preview.conflicts.map(x => x.avatar).sort(), ['Hero.png.v2.png','Hero.v2.png.png']);
    assert.equal(store.get('.Other.png').name, 'River');
    assert.throws(() => store.remove('Hero.v2.png.png'), /歧义/);
    for (const avatar of ['.png','..png','...png','../x.png']) assert.throws(() => store.chatDir(avatar), /无效/);
});

test('partial restore survives restart and a different account trimming its resident budget', async t => {
    const first = fixture(t), second = fixture(t);
    let engine = new Library({limit:1});
    t.after(() => engine.close());
    let a = engine.account(first.dirs);
    a.store.managed = true;
    a.store.importCard(first.src, '.Hidden.json');
    writeChanged(first.src, a.store.location('Unindexed.png','cold'), { format:'json' });
    const conflict = a.store.importCard(first.src, 'Conflict.json');
    fs.copyFileSync(a.store.filePath(conflict.avatar), a.store.location(conflict.avatar, 'resident'));
    const partial = await engine.restore(a);
    assert.equal(partial.restored, 2);
    assert.deepEqual(partial.remaining.map(i => i.avatar), [conflict.avatar]);
    assert.equal(partial.restoring, true);
    engine.close();
    engine = new Library({limit:1});
    a = engine.account(first.dirs);
    assert.equal(a.store.restoring, true);
    const b = engine.account(second.dirs);
    b.store.managed = true;
    const other = b.store.importCard(second.src, 'Other.json');
    await engine.prepare(b, 'other-window', [other.avatar]);
    assert.deepEqual(a.store.residents().map(i => i.avatar), ['.Hidden.png','Unindexed.png']);
    fs.unlinkSync(a.store.location(conflict.avatar, 'resident'));
    await assert.rejects(engine.prepare(a, 'local-window', [conflict.avatar]), /恢复未完成/);
    const complete = await engine.restore(a);
    assert.deepEqual(complete.remaining, []);
    assert.equal(complete.restored, 1);
    assert.equal(a.store.managed || a.store.restoring, false);
});

test('group lookup distinguishes exact avatars from unique old display names and leases expire before migration', async t => {
    const { dirs, src, card } = fixture(t);
    const engine = new Library();
    t.after(() => engine.close());
    const a = engine.account(dirs);
    const alice = a.store.importCard(src, 'Alice.json');
    card.data.name = 'Alice.png';
    fs.writeFileSync(src, JSON.stringify(card));
    a.store.importCard(src, 'Bob.json');
    assert.deepEqual(await engine.resolveMembers(a, ['Alice.png','River','missing']), [alice.avatar,alice.avatar,null]);
    a.store.load(alice.avatar);
    engine.lease(a, 'old-window').until = 1;
    await engine.heartbeat(a, 'live-window', [alice.avatar], true);
    engine.expireLeases(a);
    assert.deepEqual([...a.leases.keys()], ['live-window']);
    await engine.migrate(a, false);
    assert.equal(a.store.get(alice.avatar).state, 'resident');
    card.data.name = 'River';
    fs.writeFileSync(src, JSON.stringify(card));
    a.store.importCard(src, 'River2.json');
    await assert.rejects(engine.resolveMembers(a, ['River']), /同名/);
});

test('a rejected old identity does not index a new file and reservations survive restoration', t => {
    const { dirs, src, store } = fixture(t);
    const engine = new Library();
    t.after(() => engine.close());
    const a = engine.account(dirs);
    writeChanged(src, store.location('Unindexed.png', 'resident'), { format:'json' });
    assert.throws(() => engine.assertIdentity(a, 'Unindexed.png', 'stale-id'), /身份/);
    assert.equal(store.raw('Unindexed.png'), undefined);
    store.managed = true;
    const card = store.importCard(src, 'Gone.json');
    store.remove(card.avatar);
    store.finishRestore();
    assert.throws(() => store.assertWritableName(card.avatar), /保留/);
});

test('only genuine import name collisions have a duplicate code', t => {
    const { store, src } = fixture(t);
    store.importCard(src, 'Same.json');
    assert.throws(() => store.importCard(src, 'Same.json'), e => e.status === 409 && e.code === 'CHARACTER_LIBRARY_DUPLICATE');
    assert.throws(() => store.importCard(src, 'Bad.txt'), e => e.code !== 'CHARACTER_LIBRARY_DUPLICATE');
});

test('filesystem spelling cannot create an alias identity or lease', async t => {
    const { store, dirs, src } = fixture(t);
    const actual = store.importCard(src, 'ProbeA.json');
    store.load(actual.avatar);
    const alias = 'probea.png';
    if (process.platform !== 'win32') {
        const other = store.importCard(src, 'probea.json');
        assert.notEqual(other.id, actual.id);
        return;
    }
    assert.throws(() => store.refresh(alias), /拼写/);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM cards').get().n, 1);
    const engine = new Library();
    t.after(() => engine.close());
    const a = engine.account(dirs);
    await assert.rejects(engine.heartbeat(a, 'alias-window', [alias], false), /拼写/);
    store.managed = true;
    store.remove(actual.avatar);
    store.finishRestore();
    assert.equal(store.isReserved(alias), true);
    assert.throws(() => store.assertWritableName(alias), /保留/);
});

test('existing alias pollution is isolated and offline repair requires an explicit retained identity', { skip:process.platform !== 'win32' }, async t => {
    const { dirs, src } = fixture(t);
    const engine = new Library({limit:2});
    t.after(() => engine.close());
    const a = engine.account(dirs), {store} = a;
    store.managed = true;
    const card = store.importCard(src, 'Polluted.json');
    store.load(card.avatar);
    const original = fs.readFileSync(store.location(card.avatar,'resident'));
    fs.mkdirSync(store.chatDir(card.avatar));
    const history = path.join(store.chatDir(card.avatar),'one.jsonl');
    fs.writeFileSync(history,'preserved chat');
    const raw = store.raw(card.avatar);
    const fields = Object.keys(raw);
    store.db.prepare('INSERT INTO cards (' + fields.join(',') + ') VALUES (' + fields.map(() => '?').join(',') + ')')
        .run(...fields.map(k => k === 'avatar' ? 'polluted.png' : k === 'id' ? 'alias-old-id' : raw[k]));
    assert.throws(() => store.refresh(card.avatar), /多个身份/);
    const healthy = store.importCard(src, 'ZZHealthy.json');
    store.load(healthy.avatar);
    await engine.trim(a);
    assert.equal(store.get(healthy.avatar).state,'cold');
    assert.deepEqual(fs.readFileSync(store.location(card.avatar,'resident')),original);
    const {repairIndex} = await import('../repair-index.mjs');
    const preview = repairIndex(dirs.root,{avatar:card.avatar});
    assert.equal(preview.rows.length,2);
    assert.throws(() => repairIndex(dirs.root,{avatar:card.avatar,apply:true}), /keep-id/);
    store.db.prepare("UPDATE cards SET intent='withdraw' WHERE id=?").run('alias-old-id');
    assert.throws(() => repairIndex(dirs.root,{avatar:card.avatar,keepId:'alias-old-id',apply:true}), /未完成操作/);
    store.db.prepare('UPDATE cards SET intent=NULL WHERE id=?').run('alias-old-id');
    const conflicting = store.location(card.avatar,'cold');
    fs.copyFileSync(store.location(card.avatar,'resident'),conflicting);
    assert.throws(() => repairIndex(dirs.root,{avatar:card.avatar,keepId:'alias-old-id',apply:true}), /实际文件/);
    assert.deepEqual(fs.readFileSync(conflicting),original);
    fs.unlinkSync(conflicting);
    const fixed = repairIndex(dirs.root,{avatar:card.avatar,keepId:'alias-old-id',apply:true});
    assert.equal(store.refresh(card.avatar).id,'alias-old-id');
    assert.equal(store.raw('polluted.png'),undefined);
    assert.equal(JSON.parse(fs.readFileSync(fixed.backup,'utf8')).rows.length,2);
    assert.deepEqual(fs.readFileSync(store.location(card.avatar,'resident')),original);
    assert.equal(fs.readFileSync(history,'utf8'),'preserved chat');
    assert.throws(() => engine.assertIdentity(a,card.avatar,card.id), /身份/);
});
