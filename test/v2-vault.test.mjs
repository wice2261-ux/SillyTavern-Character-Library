import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Vault, encodeCard } from '../server/vault.mjs';
import { readCard } from '../server/read-card.mjs';
import { init } from '../server/index.mjs';

const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFZkAAAAASUVORK5CYII=','base64');
const tool=fileURLToPath(new URL('../tools/handoff.mjs',import.meta.url));

test('enhanced install recovery, save and restore keep a 239-byte avatar filename',async()=>{
    const root=await mkdtemp(path.join(os.tmpdir(),'cl-long-'));
    try {
        const files=path.join(root,'user','files'),characters=path.join(root,'characters');
        await Promise.all([mkdir(files,{recursive:true}),mkdir(characters)]);
        const avatar='a'.repeat(235)+'.png';
        const target=path.join(characters,avatar);
        const card={name:'Long avatar',chat:'Original',data:{name:'Long avatar',description:'Original text'}};
        await writeFile(target,encodeCard(image,card));
        const vault=new Vault({root,files,characters});
        await vault.stage(await vault.load(),avatar,target);
        const state=await vault.load(),row=state.records[avatar];
        assert.equal(row.operation,'installing');
        await vault.recover(state,row);
        assert.equal((await readCard(target)).data.extensions.character_library.id,row.id);
        state.mode='enhanced';
        await vault.commit(state);
        card.data.description='Updated text';
        await vault.save(state,{avatar,id:row.id,version:row.current},card);
        assert.deepEqual(await vault.body(row),card);
        await vault.release(state,'restore',true);
        assert.deepEqual(await readCard(target),card);
    } finally { await rm(root,{recursive:true,force:true}); }
});

test('stage, save and restore preserves the original and keeps disk metadata shallow while enhanced',async()=>{
    const root = await mkdtemp(path.join(os.tmpdir(),'cl23-'));
    try {
        const files=path.join(root,'user','files'), characters=path.join(root,'characters');
        await mkdir(files,{recursive:true}); await mkdir(characters);
        const target=path.join(characters,'Alice.png');
        const card={name:'Alice',chat:'Original',data:{name:'Alice',description:'full',extensions:{helper:{seed:1}}}};
        const original=encodeCard(image,card);
        await writeFile(target,original);
        const chats=path.join(root,'chats'),groups=path.join(root,'groups');
        await Promise.all([mkdir(chats),mkdir(groups)]);
        const vault=new Vault({root,files,characters,chats,groups});
        const state=await vault.load();
        const row=await vault.stage(state,'Alice.png',target);
        await vault.install(state,row);
        state.mode='enhanced';
        await vault.commit(state);
        assert.equal((await readCard(target)).data.description,'');
        assert.deepEqual(await vault.body(row),card);
        const binding={id:row.id,avatar:row.avatar,version:row.current};
        const routes = new Map();
        await init({post:(name,handler)=>routes.set(name,handler)});
        async function request(name,body,user={directories:{root,files,characters}}) {
            const result={status:200};
            await routes.get(name)({user,body},{
                json:value=>{result.value=value;},
                type:value=>{result.type=value;return {send:value=>{result.value=value;}};},
                status:code=>{result.status=code;return {json:value=>{result.value=value;}};},
                sendStatus:code=>{result.status=code;}
            });
            return result;
        }
        assert.equal((await request('/prepare',binding,null)).status,401);
        assert.deepEqual((await request('/prepare',binding)).value.card,card);
        assert.equal((await request('/draw',{count:3})).value.items[0].id,row.id);
        assert.equal((await request('/list',{})).value.items[0].current,undefined);
        const exported=await request('/export-file',{...binding,format:'png'});
        assert.equal(exported.type,'png');
        const exportedPath=path.join(root,'exported.png');
        await writeFile(exportedPath,exported.value);
        const exportedCard=await readCard(exportedPath);
        assert.equal(exportedCard.chat,undefined);
        assert.equal(exportedCard.data.description,'full');
        assert.equal(exportedCard.data.extensions.helper.seed,1);
        card.data.description='edited';
        assert.equal((await request('/save',{...binding,card})).status,200);
        assert.equal((await request('/save',{...binding,card})).status,409);
        Object.assign(row,(await vault.load()).records['Alice.png']);
        assert.equal((await readCard(target)).data.description,'');
        assert.deepEqual(await readFile(path.join(vault.archive,row.original)),original);
        const replacement={...card,chat:'Wrong history',data:{...card.data,description:'replacement'}};
        const imported=await request('/import-card',{id:row.id,avatar:row.avatar,version:row.current,mode:'replace',
            png:encodeCard(image,replacement).toString('base64')});
        assert.equal(imported.status,200);
        const afterImport=(await vault.load()).records[row.avatar];
        assert.equal((await vault.body(afterImport)).chat,'Original');
        assert.equal((await vault.body(afterImport)).data.description,'replacement');
        assert.deepEqual(await readFile(path.join(vault.archive,row.original)),original);
        assert.equal((await readCard(target)).data.description,'');
        assert.equal((await request('/import-card',{avatar:row.avatar,mode:'skip'})).value.skipped,true);
        const restoredAfterTest=await request('/save',{id:row.id,avatar:row.avatar,version:afterImport.current,card});
        assert.equal(restoredAfterTest.status,200);
        Object.assign(row,(await vault.load()).records[row.avatar]);
        const duplicate = await vault.duplicate(state,row,'Copy.png');
        assert.notEqual(duplicate.id,row.id);
        assert.equal((await readCard(path.join(characters,'Copy.png'))).data.description,'');
        assert.equal((await vault.body(state.records['Copy.png'])).chat,undefined);
        await assert.rejects(vault.duplicate(state,row,'copy.png'),/已占用/);
        await mkdir(path.join(chats,'Copy'));
        await writeFile(path.join(chats,'Copy','History.jsonl'),'history');
        await writeFile(path.join(groups,'group.json'),JSON.stringify({members:['Copy.png'],disabled_members:['Copy.png']}));
        const renamed=await vault.rename(state,duplicate,'Renamed');
        assert.equal(renamed.avatar,'Renamed.png');
        assert.equal(await readFile(path.join(chats,'Renamed','History.jsonl'),'utf8'),'history');
        assert.deepEqual(JSON.parse(await readFile(path.join(groups,'group.json'),'utf8')),
            {members:['Renamed.png'],disabled_members:['Renamed.png']});
        await vault.delete(state,renamed);
        await assert.rejects(readFile(path.join(characters,'Copy.png')),{code:'ENOENT'});
        await assert.rejects(vault.duplicate(state,row,'copy.png'),/已占用/);
        await vault.release(state,'restore',true);
        assert.deepEqual(await readCard(target),card);
        assert.equal((await vault.load()).mode,'released');
        const staged = {...state,mode:'staging',records:{}};
        const changed = await vault.stage(staged,'Alice.png',target);
        await vault.install(staged,changed);
        staged.mode='enhanced';
        await vault.commit(staged);
        await vault.release(staged,'basic',true);
        const basic = JSON.parse(await readFile(path.join(files,'character-library-v2.json'),'utf8'));
        assert.equal(basic.records['Alice.png'].online,false);
        assert.equal((await readCard(target)).data.extensions.character_library.version,2);
        assert.deepEqual(JSON.parse(await readFile(path.join(files,basic.records['Alice.png'].current),'utf8')),card);
        execFileSync(process.execPath,[tool,'takeover',root,'--apply']);
        const reattached=await vault.load();
        assert.equal(reattached.mode,'enhanced');
        assert.equal(reattached.records['Alice.png'].id,changed.id);
        assert.deepEqual(await vault.body(reattached.records['Alice.png']),card);
    } finally { await rm(root,{recursive:true,force:true}); }
});

test('legacy handoff resumes an archived cold card without restoring it to native storage',async()=>{
    const root=await mkdtemp(path.join(os.tmpdir(),'cl23-legacy-'));
    try {
        const files=path.join(root,'user','files'),characters=path.join(root,'characters');
        const legacy=path.join(root,'character-library'),cold=path.join(legacy,'cards');
        await Promise.all([mkdir(files,{recursive:true}),mkdir(characters),mkdir(cold,{recursive:true})]);
        const db=new DatabaseSync(path.join(legacy,'index.sqlite'));
        try {
            db.exec(`CREATE TABLE cards (id TEXT, avatar TEXT, state TEXT, intent TEXT, favorite INTEGER, imported INTEGER, played INTEGER);
                INSERT INTO cards VALUES ('legacy-id','Cold.png','cold',NULL,1,500,600),('reserved-id','Reserved.png','reserved',NULL,0,NULL,NULL);`);
        } finally { db.close(); }
        const card={name:'Cold',chat:'Original',data:{name:'Cold',description:'Full',extensions:{helper:{seed:1}}}};
        const png=encodeCard(image,card),source=path.join(cold,'Cold.png');
        await writeFile(source,png);
        const vault=new Vault({root,files,characters});
        const state=await vault.load();
        await vault.stage(state,'Cold.png',source,{id:'legacy-id',favorite:true,imported:500,played:600});
        await assert.rejects(readFile(path.join(characters,'Cold.png')),{code:'ENOENT'});
        execFileSync(process.execPath,[tool,'legacy',root,'--apply']);
        const result=await vault.load(),row=result.records['Cold.png'];
        assert.equal(result.mode,'enhanced');
        assert.deepEqual(result.reserved,['Reserved.png']);
        assert.deepEqual([row.id,row.favorite,row.imported,row.played],['legacy-id',true,500,600]);
        assert.equal((await readCard(path.join(characters,'Cold.png'))).data.description,'');
        assert.deepEqual(await vault.body(row),card);
        assert.deepEqual(await readFile(source),png);
    } finally { await rm(root,{recursive:true,force:true}); }
});
