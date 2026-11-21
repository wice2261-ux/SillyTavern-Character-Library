import test from 'node:test';
import assert from 'node:assert/strict';
import {buildWorldbook,Worldbook,managementKey,withNativeTags,tagSignature} from '../extension/worldbook.js';
test('tag signature ignores unrelated tags, folders and colors but follows exported associations and names',()=>{
    const rows=[{avatar:'A.png',tags:['Card']}],a={tags:[{id:1,name:'Local',color:'red'},{id:2,name:'Unused'}],tagMap:{'A.png':[1],'group':[2]}};
    const b=structuredClone(a);b.tags[0].color='blue';b.tags[0].folder_type='open';b.tags[1].name='Other';b.tagMap.group=[];
    assert.equal(tagSignature(rows,a),tagSignature(rows,b));b.tags[0].name='Renamed';assert.notEqual(tagSignature(rows,a),tagSignature(rows,b));
    b.tags[0].name='Local';b.tagMap['A.png']=[];assert.notEqual(tagSignature(rows,a),tagSignature(rows,b));
});
test('host account tag names join card tags without loading cards',()=>{
    const rows=[{id:'a',avatar:'A.png',tags:['Card']}];
    const out=withNativeTags(rows,{tags:[{id:1,name:'Local'}],tagMap:{'A.png':[1]}});
    assert.deepEqual(out[0].tags,['Card','Local']);assert.deepEqual(rows[0].tags,['Card']);
});
test('management key ignores play time and online lifecycle but detects presentation changes',()=>{
    const row={id:'a',avatar:'A.png',name:'A',tags:[],favorite:false};
    assert.equal(managementKey(row),managementKey({...row,played:123,online:false,imported:456}));
    assert.notEqual(managementKey(row),managementKey({...row,favorite:true}));
});
function fixture(){
    const books=new Map(),preferences={};let writes=0,reads=0;
    const rows=[{id:'b',avatar:'B.png',name:'Bob',tags:['tag'],favorite:true,imported:null,played:123,description:'SECRET',current:'SECRET.json'},
        {id:'a',avatar:'A.png',name:'Alice',tags:[],favorite:false,imported:123,played:null}];
    const io={id:()=> 'owner',readWorldbook:async n=>{reads++;return structuredClone(books.get(n)||null);},writeWorldbook:async(n,d)=>{writes++;books.set(n,structuredClone(d));}};
    const wb=new Worldbook({io,snapshot:async()=>structuredClone(rows),getPreferences:()=>preferences,savePreferences:p=>Object.assign(preferences,p),now:()=>1700000000000});
    return {wb,io,books,rows,preferences,get writes(){return writes;},get reads(){return reads;}};
}
test('worldbook generator only includes light fields, deterministic disabled entries and no bindings',()=>{
    const f=fixture(),book=buildWorldbook(f.rows,{owner:'owner',generatedAt:123});
    assert.equal(book.entries[0].comment,'Alice');assert.equal(book.entries[0].uid,0);
    assert.ok(Object.values(book.entries).every(e=>e.disable===true&&e.constant===false));
    assert.ok(!JSON.stringify(book).includes('SECRET'));assert.match(book.entries[1].content,/导入时间未知/);
    assert.equal(book.extensions.character_library.owner,'owner');assert.equal(book.entries[1].key.length,0);
});
test('default off, manual works without enabling, equal business data does not rewrite',async()=>{
    const f=fixture();f.wb.markChanged();await f.wb.flush();assert.equal(f.writes,0);
    await f.wb.updateNow();assert.equal(f.writes,1);assert.equal(f.preferences.autoUpdate,undefined);
    await f.wb.updateNow();assert.equal(f.writes,1);assert.equal(f.wb.status().pending,false);
});
test('collision is preserved and failures remain pending without retry loops',async()=>{
    const f=fixture();f.books.set('角色库资料（自动生成）',{entries:{}});
    await f.wb.updateNow();assert.equal(f.preferences.name,'角色库资料（自动生成） 1');
    assert.deepEqual(f.books.get('角色库资料（自动生成）'),{entries:{}});
    f.rows[0].favorite=false;f.wb.markChanged();f.io.writeWorldbook=async()=>{throw Error('offline');};
    await assert.rejects(f.wb.updateNow(),/offline/);assert.equal(f.wb.status().pending,true);
    assert.match(f.wb.status().error,/offline/);assert.equal(f.writes,1);
});
test('automatic batches merge and disabling cancels not-started work',async()=>{
    const f=fixture();await f.wb.setAutoUpdate(true);assert.equal(f.writes,1);
    f.rows[0].name='Updated';f.wb.markChanged();f.wb.markChanged();
    await Promise.all([f.wb.flush(),f.wb.flush()]);assert.equal(f.writes,2);
    f.rows[0].name='Not sent';f.wb.markChanged();await f.wb.setAutoUpdate(false);await f.wb.flush();assert.equal(f.writes,2);
    await f.wb.updateNow();assert.equal(f.writes,3);
});
test('management changes during a write stay pending and requests share one flight',async()=>{
    const f=fixture();let resume;const write=f.io.writeWorldbook;
    f.io.writeWorldbook=async(...args)=>{await new Promise(r=>resume=r);await write(...args);};
    const one=f.wb.updateNow();while(!resume)await new Promise(r=>setTimeout(r,0));
    f.rows[0].name='New';f.wb.markChanged();const two=f.wb.updateNow();resume();await Promise.all([one,two]);
    assert.equal(f.writes,1);assert.equal(f.wb.status().pending,true);
    f.io.writeWorldbook=write;await f.wb.updateNow();assert.equal(f.writes,2);assert.equal(f.wb.status().pending,false);
});
test('owner mismatch and read failure never overwrite or create a substitute',async()=>{
    const f=fixture();await f.wb.updateNow();const name=f.preferences.name;
    f.books.get(name).extensions.character_library.owner='someone';
    await assert.rejects(f.wb.updateNow(),/归属/);assert.equal(f.writes,1);
    f.io.readWorldbook=async()=>{throw Error('read failed');};await assert.rejects(f.wb.updateNow(),/read failed/);assert.equal(f.writes,1);
});
test('automatic update drains a newer management change after a slow successful write',async()=>{
    const f=fixture();f.preferences.autoUpdate=true;let resume;const write=f.io.writeWorldbook;
    f.io.writeWorldbook=async(...args)=>{if(!resume)await new Promise(r=>resume=r);await write(...args);};
    f.wb.markChanged();const first=f.wb.flush();while(!resume)await new Promise(r=>setTimeout(r,0));
    f.rows[0].name='Newer';f.wb.markChanged();const delayed=f.wb.flush();resume();await Promise.all([first,delayed]);
    await new Promise(r=>setTimeout(r,0));
    assert.equal(f.writes,2);assert.equal(f.wb.status().pending,false);
    assert.match(f.books.get(f.preferences.name).entries[1].content,/Newer/);
});
test('startup with automatic updating rechecks a failed or deferred update from the previous page',async()=>{
    const f=fixture();await f.wb.updateNow();f.preferences.autoUpdate=true;f.rows[0].name='NEW';
    const wb=new Worldbook({io:f.io,snapshot:async()=>f.rows,getPreferences:()=>f.preferences,savePreferences:p=>Object.assign(f.preferences,p)});
    assert.equal(wb.status().checked,false);await wb.start();
    assert.equal(f.writes,2);assert.equal(wb.status().checked,true);await wb.start();assert.equal(f.writes,2);
});
test('startup with automatic updating off neither reads nor claims the existing copy is current',async()=>{
    const f=fixture();f.preferences.name='Book';await f.wb.start();
    assert.equal(f.reads,0);assert.equal(f.wb.status().checked,false);
});
