// Run each size in a fresh process: node --expose-gc test/scale.mjs 303 WORK_TEMP
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Library } from '../server/runtime.mjs';
import { writeChanged } from '../server/card.mjs';

const size = Number(process.argv[2]);
if (![303, 606].includes(size) || !process.argv[3] || !global.gc) {
    throw new Error('Use node --expose-gc test/scale.mjs 303|606 WORK_TEMP');
}
const root = fs.mkdtempSync(path.join(path.resolve(process.argv[3]), 'scale-' + size + '-'));
const dirs = { root, characters: path.join(root, 'characters'), chats: path.join(root, 'chats'), groups: path.join(root, 'groups') };
for (const dir of [dirs.characters, dirs.chats, dirs.groups]) fs.mkdirSync(dir);
const avatar = n => 'sample-' + String(n).padStart(4, '0') + '.png';
const sizes = [512, 65536, 4 * 1024 * 1024];
for (const bytes of sizes) {
    const json = path.join(root, 'sample-' + bytes + '.json');
    fs.writeFileSync(json, JSON.stringify({ spec: 'chara_card_v2', data: { name: 'Fixture-' + bytes,
        tags: ['sample'], extensions: { tavern_helper: { scripts: [{ content: 'x'.repeat(bytes) }] } } } }));
    writeChanged(json, json + '.png', { format: 'json' });
}
for (let i = 0; i < size; i++) {
    const bytes = sizes[i === 0 ? 2 : i % 5 === 0 ? 1 : 0];
    fs.copyFileSync(path.join(root, 'sample-' + bytes + '.json.png'), path.join(dirs.characters, avatar(i)));
}
const owner = 'switching-window', other = 'second-window';
const report = { size, node: process.version, sequence: Array.from({ length: 12 }, (_, i) => i),
    limits: { nonFavorite: 8, totalMiB: 192, nativeMiB: 100, headroomMiB: 24 }, rounds: [] };
let engine, account, indexed, indexEndPeak;
const mib = n => Math.round(n / 1048576 * 10) / 10;
function sample() {
    const { heapUsed, rss } = process.memoryUsage();
    return { heapMiB: mib(heapUsed), rssMiB: mib(rss) };
}
function start() {
    engine = new Library({ limit: 8, budget: 192, nativeCache: 100 * 1048576 });
    account = engine.account(dirs);
    indexed = 0;
    indexEndPeak = 0;
    const store = account.store;
    const index = store.index.bind(store);
    store.index = (...args) => {
        indexed++;
        const row = index(...args);
        indexEndPeak = Math.max(indexEndPeak, process.memoryUsage().rss);
        return row;
    };
}
async function time(fn) {
    const start = performance.now();
    await fn();
    return Math.round(performance.now() - start);
}
const open = async (id, ids) => {
    const names = ids.map(avatar);
    await engine.queue.run(() => engine.prepare(account, id, names));
    await engine.queue.run(() => engine.heartbeat(account, id, names, true));
};
start();
global.gc();
report.firstScanMs = await time(() => engine.scan(account));
assert.equal(account.progress.failed, 0);
assert.equal(indexed, size);
report.initialIndexes = indexed;
report.maxRssAtIndexEndMiB = mib(indexEndPeak);
report.migrationMs = await time(() => engine.migrate(account, false));
assert.equal(account.store.residents().length, 0);
engine.close();
start();
report.restartMs = await time(() => engine.scan(account));
assert.equal(indexed, 0);
assert.equal(account.progress.done, 0);
report.restartIndexes = indexed;
let before = indexed;
report.sortedPagesMs = await time(() => {
    for (const sort of ['name', 'imported', 'played', 'size']) {
        for (const direction of ['asc','desc']) {
            assert.equal(account.store.query({ sort, direction, search: 'sample', page: 2 }).total, size);
        }
    }
});
assert.equal(indexed, before);
report.browseIndexes = indexed - before;
// With no previous chat to release, switching headroom cannot admit a ninth member.
await assert.rejects(engine.queue.run(() => engine.prepare(account, owner, report.sequence.slice(0, 9).map(avatar))), /预算/);
assert.equal(account.store.residents().length, 0);
await open(other, [20]);
await open(owner, [0, 1]);
// Exceed the active count even after every eligible victim has been considered.
await assert.rejects(engine.queue.run(() => engine.prepare(account, owner, report.sequence.map(avatar))), /预算/);
for (const n of [0, 1, 20]) assert.equal(account.store.get(avatar(n)).state, 'resident');
assert.deepEqual(engine.protected(account), new Set([avatar(0), avatar(1), avatar(20)]));
for (let round = 0; round < 4; round++) {
    const ms = await time(async () => {
        for (const n of report.sequence) {
            await open(owner, [n]);
            assert.equal(account.store.get(avatar(20)).state, 'resident');
        }
    });
    global.gc();
    if (round) report.rounds.push({ ms, resident: account.store.residents().length, ...sample() });
    assert.ok(account.store.residents().length <= 8);
    assert.equal(account.store.get(avatar(0)).state, 'cold');
}
engine.close();
console.log(JSON.stringify(report));
