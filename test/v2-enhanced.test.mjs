import test from 'node:test';
import assert from 'node:assert/strict';
import { EnhancedLibrary } from '../extension/enhanced.js';

test('enhanced collection drops idle bodies, protects the active card and saves by version', async () => {
    const rows=Array.from({length:10},(_,i)=>({id:String(i),avatar:i+'.png',version:'original',name:String(i),tags:[],size:1}));
    const calls=[];
    const stub={data:{extensions:{character_library:{version:3,cold:true}}}};
    const card={name:'Zero',chat:'history',data:{name:'Zero',description:'complete',extensions:{helper:true}}};
    let tick=0,protocol=1;
    const io={
        now:()=>++tick,
        card:async()=>stub,
        async post(route, body){
            const endpoint=route.split('/').at(-1);
            calls.push(endpoint);
            if(endpoint==='status')return Response.json({protocol,mode:'enhanced'});
            if(endpoint==='directory')return Response.json(rows);
            if(endpoint==='prepare')return Response.json({card,version:'original'});
            if(endpoint==='save'){
                assert.equal(body.version,'original');
                assert.equal(body.card.chat,'history');
                assert.equal(body.card.data.extensions.helper,true);
                rows[0].version='changed';
                return Response.json({id:'0',avatar:'0.png',version:'changed'});
            }
        }
    };
    const library=new EnhancedLibrary(io,{run:work=>work(),protected:async()=>new Set(['0.png'])});
    await library.prepare(rows.map(row=>row.avatar));
    await library.collect();
    assert.equal(library.active.size,8);
    assert.equal(library.active.has('1.png'),false);
    assert.equal((await library.fullCard('0.png')).description,'complete');
    await library.writeEdit('0.png',{ch_name:'Zero edited',json_data:JSON.stringify(card),extensions:'{"helper":true}'},rows[0]);
    await assert.rejects(library.writeEdit('0.png',{},{id:'0',version:'original'}),/已改变/);
    assert.equal(calls.filter(route=>route==='save').length,1);
    protocol=2;
    await assert.rejects(library.prepare(['0.png']),/不匹配/);
    assert.equal(calls.at(-1),'status');
    assert.equal(library.active.get('0.png').version,'changed');
});
