import test from 'node:test';import assert from 'node:assert/strict';
import { resolveMembers, writeTargets, bindingMatches, mergeBatch, groupGreetings, assertSpelling, emptyGroupHistory, createdAvatar, installEntries, appendGroupMessages } from '../extension/entries.js';
import {Coordinator} from '../extension/coordinator.js';
test('successful native edits notify management only when lightweight presentation changes',async()=>{
    const old={window:globalThis.window,document:globalThis.document,location:globalThis.location};
    let card={avatar:'A.png',name:'A',data:{name:'A',tags:[],extensions:{}}},changes=0;
    const row={id:'a',avatar:'A.png',name:'A',tags:[],favorite:false};
    globalThis.window={fetch:async(_url,init)=>{const body=JSON.parse(init.body);card.data.description=body.description;card.data.tags=body.tags||[];return Response.json({});}};
    globalThis.document={addEventListener(){}};globalThis.location={href:'http://localhost/',origin:'http://localhost'};
    const coordinator=new Coordinator({navigator:{},storage:null});
    try{
        installEntries({native:{characters:[card]},groups:{},ctx:()=>({groups:[]}),
            lib:{state:{managed:true,records:{'A.png':row}},load:async()=>{},row:()=>row,prepareInside:async()=>{},commit:async()=>{},
                refresh:async(r,c)=>{r.tags=c.data.tags;}},io:{card:async()=>card},coordinator,ready:Promise.resolve(true),notify(){},onChanged(){},onManagementChanged:()=>changes++});
        await window.fetch('/api/characters/edit',{method:'POST',body:JSON.stringify({avatar_url:'A.png',description:'body'})});assert.equal(changes,0);
        await window.fetch('/api/characters/edit',{method:'POST',body:JSON.stringify({avatar_url:'A.png',tags:['Changed']})});assert.equal(changes,1);
    }finally{coordinator.close();for(const [k,v]of Object.entries(old))if(v===undefined)delete globalThis[k];else globalThis[k]=v;}
});
test('group uses exact avatar before a misleading display name and fails ambiguous legacy names',()=>{
    const rows=[{avatar:'Bob.png',name:'Alice.png'},{avatar:'Alice.png',name:'same'},{avatar:'Carol.png',name:'same'}];
    assert.deepEqual(resolveMembers(['Alice.png'],rows),['Alice.png']);assert.throws(()=>resolveMembers(['same'],rows),/唯一/);
});
test('import returns a base name while create and duplicate return complete avatars',()=>{
    assert.equal(createdAvatar('import',{file_name:'Bob_2'}),'Bob_2.png');
    assert.equal(createdAvatar('import',{file_name:'Hero.png'}),'Hero.png.png');
    assert.equal(createdAvatar('create',{file_name:'Bob.png'}),'Bob.png');
    assert.equal(createdAvatar('duplicate',{path:'Bob_1.png'}),'Bob_1.png');
});
test('untouched header-only group history is empty, but tainted or message history is retained',()=>{
    assert.equal(emptyGroupHistory([]),true);assert.equal(emptyGroupHistory([{chat_metadata:{}}]),true);
    assert.equal(emptyGroupHistory([{chat_metadata:{tainted:true}}]),false);
    assert.equal(emptyGroupHistory([{chat_metadata:{}},{mes:'retained'}]),false);
});
test('unknown case alias cannot bypass a known identity; two exact native entries remain independent',()=>{
    assert.throws(()=>assertSpelling('alice.png',[{avatar:'Alice.png'}]),/拼写/);
    assert.doesNotThrow(()=>assertSpelling('alice.png',[{avatar:'Alice.png'},{avatar:'alice.png'}]));
});
test('empty group greeting reads the exact avatar even when an earlier card has that display name',async()=>{
    const rows=[{avatar:'Bob.png',name:'Alice.png',first_mes:'WRONG'},{avatar:'Alice.png',name:'Alice',first_mes:'RIGHT'}];
    const messages=await groupGreetings(['Alice.png'],rows,{emit:async()=>{},substitute:x=>x,thumbnail:x=>x,now:()=>0});
    assert.equal(messages[0].mes,'RIGHT');assert.equal(messages[0].original_avatar,'Alice.png');
});
test('fresh group messages preserve received-before-render lifecycle and listener changes',async()=>{
    const order=[],native={chat:[],addOneMessage:message=>{assert.equal(message.extra.initialized,true);order.push('render');}};
    const context={eventTypes:{MESSAGE_RECEIVED:'received',CHARACTER_MESSAGE_RENDERED:'rendered'},eventSource:{emit:async(type,id)=>{
        assert.equal(native.chat[id].mes,'hello');order.push(type);if(type==='received')native.chat[id].extra={initialized:true};}}};
    await appendGroupMessages([{mes:'hello'}],native,context);assert.deepEqual(order,['received','render','rendered']);
    assert.equal(native.chat[0].extra.initialized,true);
});
test('bulk merging calls only one avatar at a time and preserves partial results',async()=>{
    let active=0,peak=0;const result=await mergeBatch(['A.png','B.png','C.png'],async avatar=>{
        active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,1));active--;
        if(avatar==='B.png')throw Error('failed');return {updated:[avatar],skipped:[],failed:[]};
    });assert.equal(peak,1);assert.deepEqual(result.updated,['A.png','C.png']);assert.deepEqual(result.failed,['B.png']);
});
test('merge actual avatar/avatars take precedence over unrelated avatar_url',()=>{
    assert.deepEqual(writeTargets('merge-attributes',{avatar:'B.png',avatar_url:'A.png'},[]),['B.png']);
    assert.deepEqual(writeTargets('merge-attributes',{avatars:[],avatar_url:'A.png'},[{avatar:'B.png'},{avatar:'C.png'}]),['B.png','C.png']);
});
test('old operation binding cannot write a different identity or name',()=>{
    assert.equal(bindingMatches({id:'a',avatar:'A.png'},{id:'b',avatar:'A.png'}),false);
    assert.equal(bindingMatches({id:'a',avatar:'A.png'},{id:'a',avatar:'B.png'}),false);
});
test('command callbacks use host name resolution, hydrate full data and record group play time',async()=>{
    const old={window:globalThis.window,document:globalThis.document,location:globalThis.location};
    globalThis.window={fetch:async()=>Response.json({})};globalThis.document={addEventListener(){}};globalThis.location={href:'http://localhost/',origin:'http://localhost'};
    try{
        const native={characters:[{avatar:'Alice.png',name:'Alice'}],this_chid:undefined,chat:[],isChatSaving:false,
            selectCharacterById:async id=>{native.this_chid=id;context.groupId=null;},setActiveCharacter(){},setActiveGroup(){}};
        const context={groups:[{id:'1',name:'Group',members:['Alice.png'],disabled_members:[]}],groupId:null};
        const row={id:'a',avatar:'Alice.png'},prepared=[];let resolved;
        const lib={state:{managed:true},row:()=>row,prepare:async avatars=>prepared.push([...avatars]),transaction:async f=>f(),commit:async()=>{}};
        const io={now:()=>123,card:async()=>({name:'Alice',chat:'Original',data:{name:'Alice',description:'FULL'}})};
        const coordinator=new Coordinator({navigator:{},storage:null});
        const entry=installEntries({native,groups:{openGroupById:async id=>{if(id==='1')context.groupId=id;}},ctx:()=>({...context,characterId:native.this_chid}),
            lib,io,coordinator,ready:Promise.resolve(true),notify:e=>{throw e;},onChanged(){}});
        const parser={commands:{go:{name:'go',callback:()=>{throw Error('unexpected fallback');}},get:{name:'char-get',callback:()=>native.characters[0].data.description}}};
        entry.commands(parser,{findChar:({name})=>{resolved=name;return native.characters[0];}});
        assert.equal(await parser.commands.go.callback({},'alice'),'Alice');assert.equal(resolved,'alice');
        assert.equal(await parser.commands.get.callback({char:'Alice'}),'FULL');
        await entry.openGroup('1');assert.equal(row.played,123);assert.ok(prepared.length>=3);
        native.characters.push({avatar:'Bob.png',name:'Bob'});context.groups[0].members=['Bob.png'];entry.publishCurrent();
        assert.ok((await coordinator.protected()).has('Alice.png'));assert.ok((await coordinator.protected()).has('Bob.png'));
        context.groupId=null;context.groups[0].id='2';await assert.rejects(entry.openGroup('2'),/未完成群聊切换/);coordinator.close();
    }finally{for(const [key,value]of Object.entries(old)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});
test('native list does not restore a cold last role when host auto-load is disabled',async()=>{
    const old={window:globalThis.window,document:globalThis.document,location:globalThis.location};
    globalThis.window={fetch:async()=>Response.json([{avatar:'A.png',data:{extensions:{character_library:{version:2,id:'a',cold:true}}}}])};
    globalThis.document={addEventListener(){}};globalThis.location={href:'http://localhost/',origin:'http://localhost'};
    const coordinator=new Coordinator({navigator:{},storage:null});let prepares=0;
    try{
        installEntries({native:{characters:[],active_character:'A.png'},groups:{},ctx:()=>({powerUserSettings:{auto_load_chat:false},eventSource:{once(){}},eventTypes:{CHAT_CHANGED:'chat'}}),
            lib:{state:{managed:true},row:()=>({online:false}),transaction:async f=>f(),prepare:async()=>prepares++},io:{},coordinator,ready:Promise.resolve(true),notify(){},onChanged(){}});
        const response=await window.fetch('/api/characters/all',{method:'POST',body:'{}'});await response.json();assert.equal(prepares,0);
    }finally{coordinator.close();for(const [key,value]of Object.entries(old)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});
