import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Vault, avatarName, encodeCard } from './vault.mjs';
import { readCard } from './read-card.mjs';
import { drawCards } from '../extension/draw.js';
import { pageCards } from '../extension/lifecycle.js';

export const info = {id:'character-library-enhanced',name:'角色库增强后端',description:'账户级角色归档与按需读取'};
const queues = new Map();

function cardSummary({id,avatar,name,tags,favorite,online,size,imported,played}) {
    return {id,avatar,name,tags,favorite,online,size,imported,played};
}

function plain(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mergeFields(base,update) {
    const result={...base};
    for(const [key,value] of Object.entries(update)){
        if(['__proto__','prototype','constructor','json_data','character_library'].includes(key))continue;
        if(value==='__@@UNSET@@__')delete result[key];
        else result[key]=plain(value)?mergeFields(plain(result[key])?result[key]:{},value):value;
    }
    return result;
}

export async function init(router) {
    function route(name, work) {
        router.post(name, async (req,res) => {
            const dirs = req.user?.directories;
            if (!dirs?.root || !dirs.files || !dirs.characters) return res.sendStatus(401);
            const pending = (queues.get(dirs.root) ?? Promise.resolve()).then(async () => {
                const vault = new Vault(dirs);
                const state = await vault.load();
                if (state.mode === 'enhanced') {
                    for (const row of Object.values(state.records)) {
                        if (row.operation) await vault.recover(state,row);
                    }
                }
                return work(vault,state,req.body ?? {});
            });
            const settled = pending.catch(()=>{});
            queues.set(dirs.root,settled);
            try {
                const result=await pending;
                if (Buffer.isBuffer(result))res.type('png').send(result);
                else res.json(result);
            }
            catch (error) { res.status(error.status ?? 500).json({error:error.message}); }
            finally { if (queues.get(dirs.root) === settled) queues.delete(dirs.root); }
        });
    }
    route('/status',async (_vault,state)=>({protocol:1,mode:state.mode,records:Object.keys(state.records).length}));
    route('/release',async (vault,state,body)=>{
        if(!['restore','basic'].includes(body.mode))throw Object.assign(new Error('未知的交还模式'),{status:400});
        return vault.release(state,body.mode,body.apply===true);
    });
    function active(state) {
        if (state.mode !== 'enhanced') throw Object.assign(new Error('增强账户尚未接管'),{status:409});
        return Object.values(state.records);
    }
    route('/directory',async (_vault,state)=>active(state).map(row=>({...cardSummary(row),parsedBytes:row.parsedBytes,version:row.current})));
    route('/recovery',async (_vault,state)=>{
        active(state);
        return {format:'character-library-enhanced-recovery',directory:state,
            instructions:'备份账户目录及增强归档。停服后使用 tools/handoff.mjs restore 或 basic 预览交还。'};
    });
    route('/list',async (_vault,state,body)=>{
        return pageCards(active(state).map(cardSummary),body);
    });
    route('/draw',async (_vault,state,body)=>drawCards(active(state),body.search,body.count));
    route('/prepare',async (vault,state,body)=>{
        active(state);
        const row = await vault.target(state,body.avatar,body.id);
        return {card:await vault.body(row),version:row.current};
    });
    route('/played',async (vault,state,body)=>{
        active(state);
        const played=Date.now(),rows=[];
        for(const identity of body.targets??[])rows.push(await vault.target(state,identity.avatar,identity.id));
        for(const row of rows)row.played=played;
        if(rows.length)await vault.commit(state);
        return {played};
    });
    route('/save',async (vault,state,body)=>{
        active(state);
        const image=body.image?Buffer.from(body.image,'base64'):undefined;
        return vault.save(state,body,body.card,image);
    });
    route('/avatar',async (vault,state,body)=>{
        active(state);
        const row=await vault.target(state,body.avatar,body.id,body.version);
        if(typeof body.image!=='string'||!body.image.length)throw Object.assign(new Error('缺少头像图片'),{status:400});
        return vault.save(state,body,await vault.body(row),Buffer.from(body.image,'base64'));
    });
    route('/favorite',async (vault,state,body)=>{
        active(state);
        const row=await vault.target(state,body.avatar,body.id);
        if(row.current!==body.version)throw Object.assign(new Error('角色版本已改变'),{status:409});
        const card=await vault.body(row);
        card.data ??= {name:card.name};
        card.data.extensions ??= {};
        card.fav=card.data.extensions.fav=Boolean(body.favorite);
        return vault.save(state,body,card);
    });
    route('/attribute',async (vault,state,body)=>{
        active(state);
        const row=await vault.target(state,body.avatar,body.id,body.version);
        const card=await vault.body(row);
        const field=body.field;
        const reserved=['data','json_data','character_library','extensions','avatar'];
        if(typeof field!=='string'||reserved.includes(field)||
            (!Object.hasOwn(card,field)&&!Object.hasOwn(card.data??{},field)))
            throw Object.assign(new Error('无效的角色属性'),{status:400});
        Object.defineProperty(card,field,{value:body.value,writable:true,enumerable:true,configurable:true});
        card.data ??= {};
        Object.defineProperty(card.data,field,{value:body.value,writable:true,enumerable:true,configurable:true});
        return vault.save(state,body,card);
    });
    route('/merge',async (vault,state,body)=>{
        active(state);
        const row=await vault.target(state,body.avatar,body.id,body.version);
        const card=await vault.body(row);
        if(!plain(body.update))throw Object.assign(new Error('无效的合并内容'),{status:400});
        if(typeof body.filter==='string'){
            const parts=body.filter.replace(/\[(\d+)\]/g,'.$1').split('.');
            const present=parts.reduce((value,key)=>value!=null&&Object.hasOwn(value,key)?value[key]:undefined,card);
            if(present===undefined)return {skipped:true};
        }
        const {avatar,chat,create_date,...fields}=body.update;
        const merged=mergeFields(card,fields);
        if(card.data&&!plain(merged.data))throw Object.assign(new Error('合并不能删除角色数据'),{status:400});
        return vault.save(state,body,merged);
    });
    route('/duplicate',async (vault,state,body)=>{
        active(state);
        return vault.duplicate(state,await vault.target(state,body.avatar,body.id),body.newAvatar);
    });
    route('/delete',async (vault,state,body)=>{
        active(state);
        return vault.delete(state,body);
    });
    route('/rename',async (vault,state,body)=>{
        active(state);
        if(!body.version)throw Object.assign(new Error('缺少角色版本'),{status:409});
        return vault.rename(state,body,body.name);
    });
    route('/import-card',async (vault,state,body)=>{
        active(state);
        let avatar=avatarName(body.avatar);
        const names=new Set([...await vault.enumerate(),...Object.keys(state.records),...(state.reserved??[])].map(name=>name.toLowerCase()));
        const row=state.records[avatar];
        const replace=body.mode==='replace'&&names.has(avatar.toLowerCase());
        if(body.id&&!replace)throw Object.assign(new Error('替换目标已改变'),{status:409});
        if(replace)await vault.target(state,avatar,body.id,body.version);
        else if(names.has(avatar.toLowerCase())){
            if(body.mode==='skip')return {skipped:true};
            const stem=avatar.slice(0,-4);
            let suffix=1;
            do{avatar=stem+'_'+suffix+'.png';suffix++;}while(names.has(avatar.toLowerCase()));
        }
        if(body.png&&(!/^[a-zA-Z0-9+/]+={0,2}$/.test(body.png)||body.png.length>Math.ceil(64*1048576/3)*4))
            throw Object.assign(new Error('PNG 大小或编码无效'),{status:400});
        await mkdir(vault.archive,{recursive:true});
        const file=path.join(vault.archive,randomUUID()+'.upload');
        try{
            let image,card;
            if(body.png){
                image=Buffer.from(body.png,'base64');
                await writeFile(file,image,{flag:'wx'});
                card=await readCard(file);
            }else{
                card=body.card;
                if(!plain(card))throw Object.assign(new Error('角色正文无效'),{status:400});
                if(typeof body.image==='string'&&body.image){
                    image=Buffer.from(body.image,'base64');
                    encodeCard(image,card);
                    await writeFile(file,image,{flag:'wx'});
                }
            }
            if(card.data?.extensions?.character_library?.cold)throw Object.assign(new Error('不能导入占位正文'),{status:400});
            if(!card.data)card={...card,data:{...card}};
            card.data.extensions??={};
            delete card.data.extensions.character_library;
            delete card.json_data;
            delete card.avatar;
            if(replace){
                card.chat=row.chat;
                card.create_date=row.create_date;
                card.fav=card.data.extensions.fav=row.favorite;
                return vault.save(state,body,card,image);
            }
            const now=new Date().toISOString();
            card.chat=(card.data.name??card.name)+' - '+now.replace(/[:.]/g,'-');
            card.create_date=now;
            if(!image)await writeFile(file,await readFile('public/img/ai4.png'),{flag:'wx'});
            const added=await vault.stage(state,avatar,file,{imported:Date.now(),rollbackOnRecovery:true},card);
            await vault.install(state,added);
            return {avatar,id:added.id,version:added.current};
        }finally{await rm(file,{force:true});}
    });
    route('/export',async (vault,state,body)=>{
        active(state);
        return {card:await vault.body(await vault.target(state,body.avatar,body.id))};
    });
    route('/export-file',async (vault,state,body)=>{
        active(state);
        const row=await vault.target(state,body.avatar,body.id);
        const card=await vault.body(row);
        delete card.chat;
        card.fav=false;
        if(card.data?.extensions){card.data.extensions.fav=false;delete card.data.extensions.character_library;}
        if(body.format==='json')return card;
        if(body.format==='png')return encodeCard(await readFile(vault.imagePath(row)),card);
        throw Object.assign(new Error('未知的导出格式'),{status:400});
    });
}
