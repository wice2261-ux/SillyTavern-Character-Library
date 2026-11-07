import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { Library, problem } from '../server/runtime.mjs';
import { writeChanged } from '../server/card.mjs';

// Exercise the route guard with the same account/store used by native HTTP handlers.
const source = fs.readFileSync(new URL('../server/index.mjs', import.meta.url), 'utf8');
function guard(runtime) {
    const start = source.indexOf('function nativeTargets(') < 0 ? source.indexOf('function checkNativeWrite(') : source.indexOf('function nativeTargets(');
    return vm.runInNewContext(source.slice(start, source.indexOf('function wrap(', start)) + '\ncheckNativeWrite;', {
        fs, path, runtime, problem, noWrites:new Set(['/get','/all','/chats','/export']),
    });
}
function fixture(t) {
    const root = fs.mkdtempSync(path.join(process.env.CHARLIB_TEST_ROOT || os.tmpdir(), 'st-native-'));
    const dirs = {root, characters:path.join(root,'characters'), chats:path.join(root,'chats'), groups:path.join(root,'groups')};
    for (const dir of [dirs.characters, dirs.chats, dirs.groups]) fs.mkdirSync(dir);
    const src = path.join(root,'source.json');
    fs.writeFileSync(src, JSON.stringify({name:'native',description:'source'}));
    const runtime = new Library();
    const a = runtime.account(dirs);
    for (const name of ['A.png','B.png']) { writeChanged(src, path.join(dirs.characters,name), {format:'json'}); a.store.refresh(name); }
    a.store.managed = true;
    t.after(() => { runtime.close(); if (!process.env.CHARLIB_TEST_ROOT) fs.rmSync(root,{recursive:true,force:true}); });
    return {runtime,a,check:guard(runtime)};
}
const request = (body,id,client='test-window') => ({body,get:name => name === 'x-st-library-id' ? id : client});

test('merge guard uses native avatar rather than unrelated avatar_url', t => {
    const {a,check} = fixture(t);
    assert.throws(() => check(a,request({avatar_url:'A.png',avatar:'B.png'},a.store.get('A.png').id),'/merge-attributes'), /身份/);
    assert.doesNotThrow(() => check(a,request({avatar_url:'A.png',avatar:'B.png'},a.store.get('B.png').id),'/merge-attributes'));
    const batch = request({avatars:[],libraryIdentities:['A.png','B.png'].map(avatar => ({avatar,id:a.store.get(avatar).id}))});
    check(a,batch,'/merge-attributes');
    assert.deepEqual([...batch.body.avatars].sort(),['A.png','B.png']);
});

test('identity remains binding after restoration while ordinary unbound use still works', t => {
    const {a,check} = fixture(t);
    a.store.finishRestore();
    assert.throws(() => check(a,request({avatar_url:'B.png'},a.store.get('A.png').id),'chat-save'), /身份/);
    assert.doesNotThrow(() => check(a,request({avatar_url:'B.png'},a.store.get('B.png').id),'chat-save'));
    assert.doesNotThrow(() => check(a,request({avatar_url:'B.png'},undefined),'chat-save'));
});

test('explicit replacement checks identity, destination and other windows', t => {
    const {a,runtime,check} = fixture(t);
    const body = {library_replace_avatar:'B.png',preserved_name:'B.png'};
    assert.throws(() => check(a,request(body,a.store.get('A.png').id),'/import'), /身份/);
    assert.throws(() => check(a,request({...body,preserved_name:'A.png'},a.store.get('B.png').id),'/import'), /目标/);
    runtime.lease(a,'other-window').current=['B.png'];
    assert.throws(() => check(a,request(body,a.store.get('B.png').id),'/import'), /其他窗口/);
    a.leases.clear();
    const req=request(body,a.store.get('B.png').id);
    check(a,req,'/import');
    assert.equal(req.libraryReplacement,true);
});
