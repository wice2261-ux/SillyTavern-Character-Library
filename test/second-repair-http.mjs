// Run against a disposable instance after the ordinary smoke test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
if (process.env.ST_LIBRARY_SMOKE !== 'isolated') throw Error('Requires an isolated instance');
const origin = new URL(process.argv[2]);
if (origin.hostname !== '127.0.0.1') throw Error('Loopback only');
const account = path.resolve(process.argv[3]);
const csrf = await fetch(new URL('/csrf-token', origin));
const headers = {Cookie:csrf.headers.getSetCookie().map(x=>x.split(';')[0]).join('; '),
    'X-CSRF-Token':(await csrf.json()).token,'Content-Type':'application/json','X-ST-Library-Client':'second-http-window'};
async function request(route, body = {}, id, status = 200) {
    const res = await fetch(new URL('/api/' + route, origin), {method:'POST',
        headers:{...headers,...(id ? {'X-ST-Library-Id':id} : {})},body:JSON.stringify(body)});
    const text = await res.text();
    assert.equal(res.status,status,route + ': ' + text.slice(0,500));
    return res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text;
}
const meta={adapter:'1.18.0',client:'second-http-window'};
const api=(route,body={},status=200)=>request('plugins/character-library/'+route,{...meta,...body},null,status);
const card = name => ({spec:'chara_card_v2',spec_version:'2.0',name,data:{name,description:'original',first_mes:'Hello',
    personality:'',scenario:'',mes_example:'',creator_notes:'original-notes',system_prompt:'',post_history_instructions:'',
    alternate_greetings:[],tags:[],creator:'test',character_version:'1',extensions:{probe:{variable:'retained'}}}});
async function upload(name, value=card(name), expected=200) {
    const res=await fetch(new URL('/api/plugins/character-library/import?adapter=1.18.0&name='+name+'.json',origin),{
        method:'POST',headers:{...headers,'Content-Type':'application/octet-stream'},body:JSON.stringify(value)});
    const data=await res.json();assert.equal(res.status,expected,JSON.stringify(data));return data;
}
async function replace(target, id, value, {expected=200,explicit=true,client='second-http-window'}={}) {
    const form=new FormData();form.set('avatar',new Blob([typeof value==='string'?value:JSON.stringify(value)]),'replacement.json');
    form.set('file_type','json');form.set('preserved_name',target);
    if(explicit)form.set('library_replace_avatar',target);
    const h={...headers,'X-ST-Library-Client':client,...(id?{'X-ST-Library-Id':id}:{})};delete h['Content-Type'];
    const res=await fetch(new URL('/api/characters/import',origin),{method:'POST',headers:h,body:form});
    const data=await res.json();assert.equal(res.status,expected,JSON.stringify(data));return data;
}
const read=avatar=>request('characters/get',{avatar_url:avatar});
const save=(avatar,id,line,status=200)=>request('chats/save',{avatar_url:avatar,file_name:'Second-history',force:true,
    chat:[{chat_metadata:{}},{name:'User',is_user:true,mes:line}]},id,status);
const file=avatar=>path.join(account,'characters',avatar);
const attempts=[];
const label='Second-'+Date.now();
await api('lease',{avatars:[],played:true});
await api('migrate');
const a=(await upload(label+'-A')).item,b=(await upload(label+'-B')).item;
await api('prepare',{avatars:[a.avatar,b.avatar]});
await api('lease',{avatars:[a.avatar,b.avatar],played:true});
const beforeA=fs.readFileSync(file(a.avatar)),beforeB=fs.readFileSync(file(b.avatar));
await request('characters/merge-attributes',{avatar_url:a.avatar,avatar:b.avatar,data:{description:'wrong'}},a.id,409);
assert.deepEqual(fs.readFileSync(file(a.avatar)),beforeA);assert.deepEqual(fs.readFileSync(file(b.avatar)),beforeB);
await request('characters/merge-attributes',{avatar_url:a.avatar,avatar:b.avatar,data:{description:'correct'}},b.id);
assert.equal((await read(b.avatar)).data.description,'correct');assert.equal((await read(a.avatar)).data.description,'original');
attempts.push('A1: conflicting locator cannot redirect identity; valid native target succeeds');
const duplicate=await upload(label+'-A',card(label+'-A'),409);assert.equal(duplicate.code,'CHARACTER_LIBRARY_DUPLICATE');
await save(a.avatar,a.id,'history before replacement');
await request('characters/merge-attributes',{avatar:a.avatar,chat:'Second-history'},a.id);
const replacement=card('Updated A');replacement.data.description='replacement';
replacement.chat='Foreign-imported-history';
assert.equal((await replace(a.avatar,a.id,replacement)).file_name,a.avatar.slice(0,-4));
const updated=await read(a.avatar);assert.equal(updated.libraryId,a.id);assert.equal(updated.data.description,'replacement');
assert.equal(updated.chat,'Second-history','replacement preserves the server current chat without a frontend repair');
assert.equal((await request('chats/get',{avatar_url:a.avatar,file_name:'Second-history'}))[1].mes,'history before replacement');
const validBytes=fs.readFileSync(file(a.avatar));
await replace(a.avatar,'stale-id',replacement,{expected:409});
await replace(a.avatar,a.id,replacement,{expected:409,explicit:false});
await api('lease',{client:'other-second-window',avatars:[a.avatar],played:true});
await replace(a.avatar,a.id,replacement,{expected:409});
await api('lease',{client:'other-second-window',avatars:[],played:true});
const invalid=await replace(a.avatar,a.id,'invalid json');assert.ok(invalid.error);
assert.deepEqual(fs.readFileSync(file(a.avatar)),validBytes);
const uploadDir=path.join(path.dirname(account),'_uploads');
if(fs.existsSync(uploadDir)){
    // The native response can reach the client just before the queue's finally.
    for(let n=0;n<100 && fs.readdirSync(uploadDir).length;n++)await sleep(20);
    assert.deepEqual(fs.readdirSync(uploadDir),[],'all original multipart uploads cleaned');
}
attempts.push('A6/B1 + third repair A2: same identity replacement preserves chat pointer and history without frontend; stale/occupied/implicit/bad input refused; duplicate classified');
if(process.platform==='win32'){
    await api('prepare',{avatars:[a.avatar.toLowerCase()]},409);
    await api('lease',{avatars:[a.avatar.toLowerCase()]},409);
    await request('characters/delete',{avatar_url:a.avatar.toLowerCase()},a.id,409);
    assert.deepEqual(fs.readFileSync(file(a.avatar)),validBytes);
    attempts.push('A4: Windows alias cannot prepare, lease or delete protected entity');
}
const renamed=(await request('characters/rename',{avatar_url:b.avatar,new_name:label+'-Renamed'},b.id)).avatar;
await save(renamed,b.id,'current history');
await api('restore');assert.equal((await api('status')).managed,false);
await request('characters/edit',{avatar_url:b.avatar,ch_name:'stale'},b.id,409);
await save(b.avatar,b.id,'stale after restore',409);
assert.equal(fs.existsSync(file(b.avatar)),false);
assert.equal(fs.existsSync(path.join(account,'chats',b.avatar.slice(0,-4))),false);
await save(renamed,b.id,'valid after restore');
assert.equal((await request('chats/get',{avatar_url:renamed,file_name:'Second-history'}))[1].mes,'valid after restore');
const unmanaged=await upload('Unmanaged',card('Unmanaged'),409);assert.notEqual(unmanaged.code,'CHARACTER_LIBRARY_DUPLICATE');
attempts.push('A2: restoration retains stale-write protection and accepts valid identity');
console.log(JSON.stringify({passed:attempts},null,2));
