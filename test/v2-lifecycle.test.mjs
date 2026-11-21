import test from 'node:test';
import assert from 'node:assert/strict';
import { Library, placeholder, isPlaceholder, importedTime } from '../extension/lifecycle.js';

const full = (name = 'Alice') => ({name, avatar:name+'.png', chat:'Original', create_date:'2020-02-03T04:05:06Z',
    data:{name,description:'FULL BODY',creator_notes:'notes',extensions:{helper:{seed:'retained'}}}});
function fixture() {
    const cards = new Map([['Alice.png', full()]]), files = new Map();
    const io = {read:async name => files.has(name) ? structuredClone(files.get(name)) : null,
        write:async (name,value) => { files.set(name,structuredClone(value)); return name; }, remove:async name=>files.delete(name),
        card:async avatar=>{if(!cards.has(avatar))throw Object.assign(Error('missing'),{status:404});return structuredClone(cards.get(avatar));},
        edit:async (avatar,card)=>cards.set(avatar,structuredClone(card)), png:async()=>new Uint8Array([1,2,3]),
        list:async()=>[...cards].map(([avatar,card])=>({...structuredClone(card),avatar})), now:()=>1700000000000,
        id:(()=>{let n=0;return()=>String(++n);})()};
    const coordinator={run:async work=>work(),protected:async()=>new Set()};
    return {cards,files,io,lib:new Library(io,coordinator)};
}

test('recovery with no pending work does not rewrite the directory',async()=>{
    const {lib,io}=fixture();await lib.migrateOne('Alice.png');let writes=0;
    const write=io.write;io.write=async(...args)=>{writes++;return write(...args);};
    await lib.recover();await lib.collect();assert.equal(writes,0);
});

test('failed garbage removal does not rewrite unchanged cleanup state',async()=>{
    const {lib,io}=fixture();await lib.migrateOne('Alice.png');lib.state.garbage=['old.json'];await lib.commit();
    io.remove=async()=>{throw Error('busy');};let writes=0;const write=io.write;
    io.write=async(...args)=>{writes++;return write(...args);};await lib.transaction(()=>lib.cleanupInside());
    assert.equal(writes,0);assert.deepEqual(lib.state.garbage,['old.json']);
});
test('archive failure leaves the native card intact',async()=>{
    const {lib,io,cards}=fixture(); await lib.load(); io.write=async name=>{if(name.endsWith('.png'))throw Error('disk full');};
    await assert.rejects(lib.migrateOne('Alice.png'),/disk full/);assert.equal(cards.get('Alice.png').data.description,'FULL BODY');
});
test('new occupancy cancels withdrawal cleanly and immediately allows reopening and saving',async()=>{
    const {lib,cards}=fixture();await lib.migrateOne('Alice.png');await lib.prepare(['Alice.png']);
    let checks=0;lib.coordinator.protected=async()=>++checks===2?new Set(['Alice.png']):new Set();
    await lib.withdraw('Alice.png');await lib.prepare(['Alice.png']);
    assert.equal(lib.row('Alice.png').operation,null);assert.equal(lib.row('Alice.png').online,true);
    cards.get('Alice.png').data.description='SAVED';await lib.refresh(lib.row('Alice.png'),cards.get('Alice.png'));await lib.commit();
    assert.equal(lib.row('Alice.png').chat,'Original');assert.equal(isPlaceholder(cards.get('Alice.png')),false);
});
test('failed cancellation commit keeps recoverable operation on disk and reports failure',async()=>{
    const {lib,io,files}=fixture();await lib.migrateOne('Alice.png');await lib.prepare(['Alice.png']);
    let checks=0;lib.coordinator.protected=async()=>++checks===2?new Set(['Alice.png']):new Set();
    const write=io.write;io.write=async(name,data)=>{if(name==='character-library-v2.json'&&data.records['Alice.png'].operation===null)throw Error('commit failed');return write(name,data);};
    await assert.rejects(lib.withdraw('Alice.png'),/commit failed/);
    assert.equal(files.get('character-library-v2.json').records['Alice.png'].operation.phase,'archived');
});
test('occupancy lookup failure is not treated as a safe cancellation',async()=>{
    const {lib}=fixture();await lib.migrateOne('Alice.png');await lib.prepare(['Alice.png']);let checks=0;
    lib.coordinator.protected=async()=>{if(++checks===2)throw Error('lookup failed');return new Set();};
    await assert.rejects(lib.withdraw('Alice.png'),/lookup failed/);assert.equal(lib.row('Alice.png').operation.phase,'archived');
});
test('original bytes, stable identity, latest edit and pointer survive withdrawal and reopen',async()=>{
    const {lib,files,cards}=fixture();await lib.load();await lib.migrateOne('Alice.png');
    const id=lib.row('Alice.png').id;assert.equal(isPlaceholder(cards.get('Alice.png')),true);
    await lib.prepare(['Alice.png']);cards.get('Alice.png').data.description='LATEST';cards.get('Alice.png').chat='Another';
    await lib.withdraw('Alice.png');await lib.prepare(['Alice.png']);
    assert.equal(cards.get('Alice.png').data.description,'LATEST');assert.equal(cards.get('Alice.png').chat,'Another');
    assert.equal(cards.get('Alice.png').data.extensions.helper.seed,'retained');assert.equal(lib.row('Alice.png').id,id);
    assert.deepEqual([...files.get(lib.row('Alice.png').original)],[1,2,3]);
});
for(const after of [false,true])test('startup recovers interruption '+(after?'after':'before')+' placeholder write',async()=>{
    const {lib,io,cards}=fixture();await lib.load();await lib.migrateOne('Alice.png');await lib.prepare(['Alice.png']);
    cards.get('Alice.png').data.description='NEWEST';const original=io.edit;
    io.edit=async(a,c)=>{if(isPlaceholder(c)){if(after)await original(a,c);throw Error('interrupted');}return original(a,c);};
    await assert.rejects(lib.withdraw('Alice.png'),/interrupted/);io.edit=original;
    const restarted=new Library(io,{run:async f=>f(),protected:async()=>new Set()});await restarted.load();await restarted.recover();
    await restarted.prepare(['Alice.png']);assert.equal(cards.get('Alice.png').data.description,'NEWEST');
});
test('placeholder omits full bodies and private script extensions',()=>{
    const card=placeholder(full(),'id');assert.equal(card.data.description,'');assert.equal(card.data.extensions.helper,undefined);
    assert.equal(card.chat,'Original');assert.equal(isPlaceholder(card),true);
});
test('partial restore continues and does not stop after one missing archive',async()=>{
    const {lib,cards,files}=fixture();cards.set('Bob.png',full('Bob'));await lib.load();
    await lib.migrateOne('Alice.png');await lib.migrateOne('Bob.png');lib.state.managed=true;
    files.delete(lib.row('Alice.png').current);const result=await lib.restoreAll();
    assert.equal(result.restoring,true);assert.equal(isPlaceholder(cards.get('Bob.png')),false);
    assert.equal(result.remaining.length,1);
});
test('automatic collection protects current and actually reaches the online target',async()=>{
    const {lib,cards}=fixture();for(let i=0;i<11;i++)cards.set('Card'+i+'.png',full('Card'+i));await lib.load();
    lib.coordinator.protected=async()=>new Set(['Alice.png']);
    await lib.migrate();for(const avatar of cards.keys())await lib.prepare([avatar]);
    await lib.collect();const online=Object.values(lib.state.records).filter(x=>x.online);
    assert.ok(online.length<=9);assert.equal(lib.row('Alice.png').online,true);
});
test('archive versions remain bounded after repeated actual edits and withdrawals',async()=>{
    const {lib,cards,files}=fixture();await lib.load();await lib.migrateOne('Alice.png');
    for(let i=0;i<8;i++){await lib.prepare(['Alice.png']);cards.get('Alice.png').data.description='EDIT '+i;await lib.withdraw('Alice.png');}
    assert.equal(files.size,4);assert.equal(lib.state.garbage.length,0);
});
test('unknown import times stay last in both directions, including favorite groups',async()=>{
    const {lib}=fixture();await lib.load();lib.state.records={a:{id:'a',avatar:'A.png',name:'A',tags:[],imported:null,favorite:true},
        b:{id:'b',avatar:'B.png',name:'B',tags:[],imported:1,favorite:true},c:{id:'c',avatar:'C.png',name:'C',tags:[],imported:2,favorite:false}};
    for(const dir of ['asc','desc'])assert.deepEqual(lib.list({dir,pinnedFirst:true}).items.map(x=>x.id),['b','a','c']);
    assert.equal(lib.list({pinnedFirst:false}).items.at(-1).id,'a');
});
test('history import accepts timezone ISO only and rejects invalid calendar dates',()=>{
    assert.equal(importedTime({create_date:'2020-02-03T04:05:06Z'}),1580702706000);
    for(const create_date of ['2020-02-03 04:05:06','2020-02-31T04:05:06Z','2020-02-03T04:05:06'])assert.equal(importedTime({create_date}),null);
});
test('file sorting bytes are independent from the active text estimate',async()=>{
    const {lib,io}=fixture();io.size=async()=>98765;await lib.load();await lib.migrateOne('Alice.png');
    assert.equal(lib.row('Alice.png').size,98765);assert.ok(lib.row('Alice.png').parsedBytes<98765);
});
test('native rename/delete intents recover when their final index commit was interrupted',async()=>{
    for(const kind of ['native-rename','native-delete']){
        const {lib,io,cards}=fixture();await lib.load();await lib.migrateOne('Alice.png');await lib.prepare(['Alice.png']);
        const row=lib.row('Alice.png');row.operation={kind,phase:'writing',pending:row.current};await lib.commit();
        if(kind==='native-rename')cards.set('New.png',cards.get('Alice.png'));cards.delete('Alice.png');
        const restarted=new Library(io,{run:async f=>f(),protected:async()=>new Set()});await restarted.load();await restarted.recover();
        assert.equal(restarted.row('Alice.png'),undefined);if(kind==='native-rename')assert.equal(restarted.row('New.png').id,row.id);
        assert.deepEqual(restarted.errors,[]);
    }
});
test('new copy import time uses the host operation time, not copied create_date or client clock',async()=>{
    const {lib}=fixture();await lib.load();await lib.registerCreatedInside('Alice.png',{imported:1800000000000});
    assert.equal(lib.row('Alice.png').imported,1800000000000);
});
test('each migrated cold card releases the host full slot before the migration batch finishes',async()=>{
    const {lib}=fixture();await lib.load();let slot=full();
    lib.onCold=(row,card)=>{assert.equal(row.avatar,'Alice.png');slot=card;};
    await lib.migrateOne('Alice.png');assert.equal(isPlaceholder(slot),true);assert.equal(slot.data.description,'');
});
test('restoring account accepts a new native full card without archiving or creating more placeholders',async()=>{
    const {lib,cards}=fixture();await lib.load();lib.state.managed=true;lib.state.restoring=true;await lib.commit();
    await lib.registerCreatedInside('Alice.png',{imported:123});assert.equal(isPlaceholder(cards.get('Alice.png')),false);
    assert.equal(lib.row('Alice.png').current,undefined);await assert.rejects(lib.migrateOne('Alice.png'),/恢复中/);
});
test('default policy treats ten favorites like ordinary cards in migration and collection',async()=>{
    const {lib,cards}=fixture();cards.clear();
    for(let i=0;i<12;i++){const c=full('Card'+i);c.fav=i<10;cards.set('Card'+i+'.png',c);}
    await lib.migrate();assert.equal(Object.values(lib.state.records).filter(r=>r.online).length,0);
    for(const avatar of cards.keys())await lib.prepare([avatar]);await lib.collect();
    assert.equal(Object.values(lib.state.records).filter(r=>r.online).length,8);
    assert.equal(lib.row('Card0.png').favorite,true);assert.equal(isPlaceholder(cards.get('Card0.png')),true);
    await lib.prepare(['Card0.png']);assert.equal(cards.get('Card0.png').fav,true);
});
test('optional protection preserves online favorites without waking cold cards and can be disabled',async()=>{
    const {lib,cards}=fixture();cards.get('Alice.png').fav=true;
    await lib.migrate();assert.equal(lib.row('Alice.png').online,false);
    let enabled=true;lib.getPolicy=()=>({keepFavoritesLoaded:enabled});
    await lib.collect();assert.equal(lib.row('Alice.png').online,false);
    await lib.prepare(['Alice.png']);await lib.withdraw('Alice.png');assert.equal(lib.row('Alice.png').online,true);
    for(let i=0;i<11;i++){const c=full('Card'+i);c.fav=true;cards.set('Card'+i+'.png',c);await lib.migrateOne('Card'+i+'.png');}
    await lib.collect();assert.equal(Object.values(lib.state.records).filter(r=>r.online).length,12);
    enabled=false;await lib.collect();assert.equal(Object.values(lib.state.records).filter(r=>r.online).length,8);
});
test('3003 metadata rows use one policy snapshot and select ordinary LRU favorites when protection is off',async()=>{
    const {lib}=fixture();await lib.load();lib.state.managed=true;
    lib.state.records=Object.fromEntries(Array.from({length:3003},(_,i)=>{const avatar='Card'+i+'.png';return [avatar,{id:String(i).padStart(5,'0'),avatar,name:avatar,tags:[],favorite:true,online:true,parsedBytes:100,played:i}];}));
    await lib.commit();let reads=0;lib.getPolicy=()=>{reads++;return {keepFavoritesLoaded:false};};
    const selected=[];lib.withdrawInside=async avatar=>{selected.push(avatar);lib.row(avatar).online=false;};
    await lib.collect();assert.equal(reads,1);assert.equal(selected.length,2995);assert.equal(selected[0],'Card0.png');
    assert.equal(Object.values(lib.state.records).filter(r=>r.online).length,8);
});
