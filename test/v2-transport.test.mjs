import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeStorage, editPayload } from '../extension/storage.js';
import { Coordinator } from '../extension/coordinator.js';
test('worldbook missing dummy is distinguished from an existing empty user book',async()=>{
    let exists=true;
    const io=new NativeStorage(async url=>url.endsWith('/list')?Response.json(exists?[{file_id:'Book'}]:[]):Response.json({entries:{}}),()=>({}));
    assert.deepEqual(await io.readWorldbook('Book'),{entries:{}});exists=false;assert.equal(await io.readWorldbook('Book'),null);
});
test('worldbook read errors do not turn into missing files',async()=>{
    const io=new NativeStorage(async()=>new Response('offline',{status:500}),()=>({}));
    await assert.rejects(io.readWorldbook('Book'),/500/);
});
test('file writes are read back and a corrupt upload is rejected',async()=>{
    let bytes;
    const io=new NativeStorage(async(url,init)=>{
        if(url==='/api/files/upload'){bytes=Uint8Array.from(atob(JSON.parse(init.body).data),c=>c.charCodeAt(0));return Response.json({path:'user/files/x.json'});}
        return new Response(new Uint8Array([...bytes,0]));
    },()=>({}));
    await assert.rejects(io.write('x.json',{hello:'world'}),/核对/);
});
test('native edit carries pointer, foreign keys, book and extensions, without recursive json_data',()=>{
    const c={name:'A',chat:'Original',create_date:'2020-01-01T00:00:00Z',json_data:'stale',foreign:'keep',
        data:{name:'A',description:'Full',character_book:{entries:[{content:'book'}]},extensions:{helper:{seed:1},depth_prompt:{prompt:'depth',depth:5,role:'assistant'}}}};
    const p=editPayload('A.png',c);assert.equal(p.chat,'Original');assert.equal(JSON.parse(p.json_data).foreign,'keep');
    assert.equal(JSON.parse(p.json_data).json_data,undefined);assert.equal(JSON.parse(p.extensions).helper.seed,1);
    assert.equal(p.depth_prompt_depth,5);assert.equal(JSON.parse(p.json_data).data.character_book.entries.length,1);
});
test('no Web Locks still serializes work and protects pending until current is set',async()=>{
    const c=new Coordinator({navigator:{},storage:null,account:null});let finish;const steps=[];
    const a=c.run(async()=>{steps.push(1);await new Promise(r=>finish=r);steps.push(2);});
    const b=c.run(async()=>steps.push(3));await new Promise(r=>setTimeout(r,0));assert.deepEqual(steps,[1]);finish();await Promise.all([a,b]);
    c.set('pending',['A.png']);assert.ok((await c.protected()).has('A.png'));
    c.set('current',['A.png']);c.set('pending',[]);assert.ok((await c.protected()).has('A.png'));assert.equal(c.mode,'page');c.close();
});
test('present but denied Web Locks falls back to page management',async()=>{
    const c=new Coordinator({navigator:{locks:{request(){throw new DOMException('Denied','SecurityError');},query:async()=>({held:[]})}},
        storage:{setItem(){},removeItem(){}},account:'A'});
    assert.equal(await c.run(()=>42),42);assert.equal(c.mode,'page');c.close();
});
test('overlapping preparations keep the second occupant after the first releases',async()=>{
    const c=new Coordinator({navigator:{},storage:null});const a=c.hold('pending',['A.png']),b=c.hold('pending',['B.png']);
    a();assert.deepEqual([...(await c.protected())],['B.png']);b();assert.equal((await c.protected()).size,0);c.close();
});
test('native edit HTTP 200 is insufficient if the card remained unchanged',async()=>{
    const old={chat:'Original',data:{name:'A',description:'old',extensions:{}}};
    const io=new NativeStorage(async url=>url.endsWith('/edit')?new Response('OK'):Response.json(old),()=>({}));
    await assert.rejects(io.edit('A.png',{...old,data:{...old.data,description:'new'}}),/未生效/);
});
test('migration list reuses lightweight host records without another all-body response',async()=>{
    const io=new NativeStorage(async()=>{throw Error('unexpected all request');},()=>({}));
    io.listProvider=()=>[{avatar:'A.png',name:'A'}];assert.deepEqual(await io.list(),[{avatar:'A.png',name:'A'}]);
});
test('write readback detects a failed change outside description and notes',async()=>{
    const old={chat:'Original',data:{name:'A',description:'same',creator_notes:'same',first_mes:'old',extensions:{helper:{seed:1}}}};
    const io=new NativeStorage(async url=>url.endsWith('/edit')?new Response('OK'):Response.json(old),()=>({}));
    await assert.rejects(io.edit('A.png',{...old,data:{...old.data,first_mes:'new',extensions:{helper:{seed:2}}}}),/未生效/);
});
