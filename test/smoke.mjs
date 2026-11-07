// Run only against a disposable 1.18.0 instance containing synthetic cards.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
if (process.env.ST_LIBRARY_SMOKE !== 'isolated') throw Error('Requires an isolated test instance');
const origin = new URL(process.argv[2] || 'http://127.0.0.1:8000');
if (origin.hostname !== '127.0.0.1') throw Error('Loopback test instances only');
const csrf = await fetch(new URL('/csrf-token', origin));
const { token } = await csrf.json();
const cookie = csrf.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
const headers = { Cookie: cookie, 'X-CSRF-Token': token, 'Content-Type': 'application/json' };
const base = '/api/plugins/character-library';
const client = 'smoke-test-window';
const account = process.argv[3];
async function call(route, data = {}, expected = 200, identity) {
    const res = await fetch(new URL(route, origin), {
        method: 'POST', headers: { ...headers, 'x-st-library-client': data.client ?? client,
            ...(identity ? { 'x-st-library-id':identity } : {}) },
        signal:AbortSignal.timeout(30000), body: JSON.stringify({ client, adapter: '1.18.0', ...data }),
    });
    const body = await res.text();
    assert.equal(res.status, expected, route + ': ' + body.slice(0, 300));
    return res.headers.get('content-type')?.includes('json') ? JSON.parse(body) : body;
}
const api = (name, data, status) => call(base + '/' + name, data, status);
assert.equal((await api('status')).adapted, true);
assert.equal((await api('status')).managed, false);
const originalFiles = account && fs.readdirSync(path.join(account, 'characters')).sort();
const initial = await call('/api/characters/all');
assert.ok(initial.length && initial.every(item => item.shallow && !item.data?.description && !item.data?.extensions?.tavern_helper));
const scripted = initial.find(item => item.avatar === 'ProbeA.png');
const initialFull = await call('/api/characters/get', {avatar_url:(scripted ?? initial[0]).avatar});
assert.equal(initialFull.shallow, undefined);
assert.equal(initialFull.libraryId, undefined, 'an unmanaged first read does not force library indexing');
assert.equal(typeof initialFull.data.description, 'string');
if (scripted) assert.ok(initialFull.data.extensions.tavern_helper.scripts[0].content);
if (account) assert.deepEqual(fs.readdirSync(path.join(account, 'characters')).sort(), originalFiles);
console.log('pre-migration shallow records=' + initial.length + ', full native /get available');
await api('migrate', {preview:true});
await api('migrate');
const originalAvatar = (scripted ?? initial[0]).avatar;
const originalBinding = (await api('prepare', {avatars:[originalAvatar]})).identities[0];
assert.equal((await call('/api/characters/get', {avatar_url:originalAvatar})).libraryId, originalBinding.id);
await api('lease', {avatars:[],played:true});
let avatar = 'Library-Smoke.png';
const card = { name:'Library-Smoke', description:'test', first_mes:'hi', scenario:'', personality:'', mes_example:'',
    spec:'chara_card_v2', spec_version:'2.0', data:{ name:'Library-Smoke', description:'test', personality:'',
        scenario:'', first_mes:'hi', mes_example:'', creator_notes:'', system_prompt:'', post_history_instructions:'',
        alternate_greetings:[], tags:['isolated'], creator:'test', character_version:'1',
        extensions:{ probe:{ variable:'retained' } } } };
const upload = await fetch(new URL(base + '/import?adapter=1.18.0&name=Library-Smoke.json', origin), {
    method:'POST', headers:{...headers, 'Content-Type':'application/octet-stream'}, body:JSON.stringify(card),
});
const uploaded = await upload.text();
assert.equal(upload.status, 200, uploaded);
const row = JSON.parse(uploaded).item;
assert.equal(row.online,false); assert.equal(row.avatar,avatar);
assert.equal((await api('list', {search:'isolated'})).items.some(r => r.id === row.id),true);
const thumb = await fetch(new URL(base + '/thumbnail?avatar=' + avatar, origin), {headers:{cookie}});
if (!thumb.ok) throw Error('Thumbnail: ' + await thumb.text());
assert.match(thumb.headers.get('content-type'), /image\/jpeg/);
const staleDelete = await api('delete', {avatar,id:'an-old-identity',deleteChats:true},409);
assert.match(staleDelete.error, /身份/);

// With the account directory available on this machine, use the spool file as
// the receipt signal so this tests a genuinely paused request, without a sleep race.
const importURL = name => new URL(base + '/import?adapter=1.18.0&name=' + name, origin);
async function waitFor(predicate, label) {
    for (let i = 0; i < 150; i++) {
        if (predicate()) return;
        await sleep(40);
    }
    throw Error('Timed out: ' + label);
}
if (account) {
    const spooled = () => fs.readdirSync(path.join(account,'character-library')).some(n => n.startsWith('.upload-'));
    const rawHeaders = {...headers, 'Content-Type':'application/octet-stream'};
    assert.equal(spooled(), false);
    const slow = http.request(importURL('Paused.json'), {method:'POST', headers:rawHeaders});
    slow.on('error', error => { if (error.code !== 'ECONNRESET') console.error(error); });
    try {
        slow.write('{');
        await waitFor(spooled, 'paused upload spool file');
        const busy = await fetch(importURL('Concurrent.json'), {method:'POST',headers:rawHeaders,body:'{}'});
        assert.equal(busy.status,429,await busy.text());
        assert.deepEqual((await api('prepare',{avatars:[avatar]})).identities,[{id:row.id,avatar}]);
        await api('lease',{avatars:[avatar],played:true});
        await call('/api/characters/merge-attributes',{avatars:[avatar],data:{data:{description:'during upload'}}},200,row.id);
        assert.equal((await call('/api/characters/get',{avatar_url:avatar})).data.description,'during upload');
    } finally { slow.destroy(); }
    await waitFor(() => !spooled(), 'aborted upload cleanup');
    const again = await fetch(importURL('Upload-Released.json'), {method:'POST',headers:rawHeaders,body:JSON.stringify(card)});
    assert.equal(again.status,200);
    const imported = (await again.json()).item;
    await api('delete', {avatar:imported.avatar,id:imported.id});
    console.log('slow upload remained open across prepare, lease and edit; abort released file and import slot');
}
assert.deepEqual((await api('prepare',{avatars:[avatar]})).identities,[{id:row.id,avatar}]);
await api('lease',{avatars:[avatar],played:true});
const read = () => call('/api/characters/get',{avatar_url:avatar});
assert.equal((await read()).data.extensions.probe.variable,'retained');
const edited = await call('/api/characters/merge-attributes',{avatars:[avatar],data:{data:{description:'saved'}}},200,row.id);
assert.deepEqual(edited.updated,[avatar]);
await api('favorite',{avatar,favorite:true});
assert.equal((await read()).data.extensions.fav,true);
await api('delete',{avatar,id:row.id},409);
await api('lease',{avatars:[],played:true});
await api('favorite',{avatar,favorite:false});
await api('migrate');
assert.equal((await api('list',{search:'Library-Smoke'})).items[0].online,false);
await call('/api/characters/edit',{avatar_url:avatar,ch_name:'stale cold card'},409,row.id);
const save = (target, line, status = 200) => call('/api/chats/save', {
    avatar_url:target,file_name:'Synthetic-history',force:true,chat:[{chat_metadata:{}},{mes:line}],
},status,row.id);
await save(avatar,'stale cold chat',409);
await api('prepare',{avatars:[avatar]});
assert.equal((await read()).data.description,'saved');
assert.equal((await read()).data.extensions.probe.variable,'retained');
const nativeList = await call('/api/characters/all');
assert.ok(nativeList.some(r => r.avatar === avatar && r.shallow));
await call('/api/chats/get',{avatar_url:avatar,file_name:'Synthetic-history'});
await save(avatar, 'before rename');
const other = 'another-test-window';
await api('lease',{client:other,avatars:[avatar],played:true});
const rename = status => call('/api/characters/rename',{avatar_url:avatar,new_name:'Library-Smoke-Renamed'},status,row.id);
await rename(409);
await api('lease',{client:other,avatars:[],played:true});
const oldAvatar = avatar;
avatar = (await rename(200)).avatar;
assert.equal(avatar,'Library-Smoke-Renamed.png');
await call('/api/characters/edit',{avatar_url:oldAvatar,ch_name:'stale after rename'},409,row.id);
await save(oldAvatar, 'stale after rename',409);
await save(avatar, 'current identity');
assert.equal((await call('/api/chats/get',{avatar_url:avatar,file_name:'Synthetic-history'}))[1].mes,'current identity');
if (account) {
    assert.equal(fs.existsSync(path.join(account,'characters',oldAvatar)),false);
    assert.equal(fs.existsSync(path.join(account,'chats',oldAvatar.slice(0,-4))),false);
}
await api('lease',{avatars:[],played:true});
await api('delete',{avatar,id:row.id,deleteChats:false});
assert.equal((await api('list',{search:'Library-Smoke'})).total,0);
if (process.env.ST_LIBRARY_LARGE_TEST === '1') {
    const big = 'Library-Large-Probe.png';
    await api('prepare',{avatars:[big]});
    const res = await fetch(new URL('/api/characters/get', origin), {
        method:'POST',headers,body:JSON.stringify({avatar_url:big}),
    });
    assert.equal(res.status,200);
    let length = 0, found = false, previous = '';
    for await (const chunk of res.body) {
        length += chunk.length;
        const text = previous + Buffer.from(chunk).toString('latin1');
        found ||= text.includes('END-LARGE-LIBRARY-PROBE');
        previous = text.slice(-24);
    }
    assert.ok(length > 28 * 1024 * 1024 && found, 'full large character response');
    await api('lease',{avatars:[],played:true});
    await api('migrate');
    assert.equal((await api('list',{search:big})).items[0].online,false);
    console.log('large_native_get_bytes=' + length);
}
await api('restore');
assert.equal((await api('status')).managed,false);
console.log('PASS: stale delete, pin, withdraw/reopen, other-window rename guard, stale card and forced chat save, native rename and valid chat save, delete, restore');
