import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readCard } from './read-card.mjs';
import { characterChunk } from './png-chunk.mjs';
import { importedTime } from '../extension/lifecycle.js';

export const directoryName = 'character-library-enhanced.json';
export const archiveName = 'character-library-enhanced';

export function avatarName(value) {
    if (typeof value !== 'string' || !/^[^<>:"/\\|?*\x00-\x1f]+\.png$/.test(value)
        || value.indexOf('.png') !== value.length - 4) throw new Error('无效的角色文件名');
    return value;
}

export async function atomicWrite(filename, bytes) {
    const temporary = path.join(path.dirname(filename), '.character-library-' + randomUUID() + '.tmp');
    try {
        await writeFile(temporary, bytes, {flag:'wx'});
        await rename(temporary, filename);
    } finally {
        await rm(temporary, {force:true});
    }
}

async function json(filename) {
    try { return JSON.parse(await readFile(filename, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Retain the original PNG image chunks and remove only old role metadata.
export function encodeCard(image, card) {
    if(image.length<8||image.readBigUInt64BE(0)!==0x89504e470d0a1a0an)throw new Error('无效的 PNG 签名');
    const chunks = [image.subarray(0, 8)];
    for (let offset = 8; offset + 12 <= image.length;) {
        const length = image.readUInt32BE(offset);
        const end = offset + 12 + length;
        if (end > image.length) throw new Error('PNG 块截断');
        const type = image.toString('ascii', offset + 4, offset + 8);
        if (type === 'IEND') return Buffer.concat([...chunks, characterChunk(card), image.subarray(offset, end)]);
        const keyword = type === 'tEXt' ? image.toString('latin1', offset + 8, offset + 8 + Math.min(length, 6)).split('\0')[0].toLowerCase() : '';
        if (keyword !== 'chara' && keyword !== 'ccv3') chunks.push(image.subarray(offset, end));
        offset = end;
    }
    throw new Error('PNG 缺少 IEND');
}

function summary(card) {
    const data = card.data ?? card;
    const name = data.name ?? card.name;
    if (typeof name !== 'string' || !name.trim()) throw new Error('角色缺少名称');
    const tags = Array.isArray(data.tags) ? data.tags.filter(tag => typeof tag === 'string') : [];
    return {name,tags,chat:card.chat,create_date:card.create_date,
        favorite:[card.fav,data.extensions?.fav].some(value => value === true || value === 'true')};
}

function placeholder(card, id) {
    const {name,tags,chat,create_date,favorite} = summary(card);
    return {spec:'chara_card_v2',spec_version:'2.0',name,chat,create_date,fav:favorite,
        data:{name,tags,description:'',personality:'',scenario:'',first_mes:'',mes_example:'',
            extensions:{fav:favorite,character_library:{version:3,id,cold:true}}}};
}

export class Vault {
    constructor(dirs) {
        this.dirs = dirs;
        this.directory = path.join(dirs.files, directoryName);
        this.archive = path.join(dirs.root, archiveName);
    }

    async load() {
        const state = await json(this.directory);
        if (state && state.schemaVersion !== 1) throw new Error('未知增强目录格式');
        return state ?? {schemaVersion:1, mode:'staging', records:{}};
    }

    async commit(state) { await atomicWrite(this.directory, JSON.stringify(state)); }

    async enumerate() {
        return (await readdir(this.dirs.characters, {withFileTypes:true}))
            .filter(entry => entry.isFile() && entry.name.endsWith('.png')).map(entry => entry.name);
    }

    async stage(state, avatar, source, metadata = {}, fullCard) {
        avatarName(avatar);
        const previous = state.records[avatar];
        if (previous?.current) return previous;
        const card = fullCard ?? await readCard(source);
        const fields = summary(card);
        if (card.data?.extensions?.character_library?.cold) throw new Error('占位缺少完整正文');
        await mkdir(this.archive, {recursive:true});
        const id = previous?.id ?? metadata.id ?? randomUUID();
        if (!/^[a-zA-Z0-9_-]+$/.test(id) || Object.values(state.records).some(row => row.avatar !== avatar && row.id === id)) {
            throw new Error('角色身份冲突');
        }
        const row = {...fields,id,avatar,size:(await stat(source)).size,online:false,
            favorite:metadata.favorite ?? fields.favorite, imported:Object.hasOwn(metadata,'imported')?metadata.imported:importedTime(card),
            played:metadata.played ?? null,original:previous?.original ?? id+'-'+randomUUID()+'.png',current:null,operation:'staging'};
        if(metadata.rollbackOnRecovery)row.rollbackOnRecovery=true;
        state.records[avatar] = row;
        await this.commit(state);
        await copyFile(source,path.join(this.archive,row.original));
        const version = randomUUID()+'.json';
        const serialized=JSON.stringify(card);
        await atomicWrite(path.join(this.archive,version),serialized);
        row.parsedBytes=Buffer.byteLength(serialized);
        row.current = version;
        row.operation = 'installing';
        delete row.rollbackOnRecovery;
        await this.commit(state);
        return row;
    }

    async body(row) {
        if (!/^[a-f0-9-]+\.json$/.test(row.current ?? '')) throw new Error('正文引用无效');
        return JSON.parse(await readFile(path.join(this.archive,row.current),'utf8'));
    }

    async target(state, avatar, id, version) {
        const row = state.records[avatarName(avatar)];
        if (!row || row.id !== id || row.operation || (version!==undefined&&row.current!==version)) {
            throw Object.assign(new Error('角色身份或状态已改变'),{status:409});
        }
        return row;
    }

    async duplicate(state, source, avatar) {
        const occupied = [...await this.enumerate(),...Object.keys(state.records),...(state.reserved ?? [])];
        if (avatar === undefined) {
            const names = new Set(occupied.map(item=>item.toLowerCase()));
            const stem = source.avatar.slice(0,-4);
            let suffix=1;
            do { avatar=stem+'_'+suffix+'.png'; suffix++; } while(names.has(avatar.toLowerCase()));
        }
        avatarName(avatar);
        if (occupied.some(item=>item.toLowerCase()===avatar.toLowerCase())) {
            throw Object.assign(new Error('目标文件名已占用'),{status:409});
        }
        const card = await this.body(source);
        delete card.chat;
        delete card.avatar;
        if (card.data?.extensions) delete card.data.extensions.character_library;
        card.create_date = new Date().toISOString();
        const row = await this.stage(state,avatar,this.imagePath(source),{imported:Date.now(),rollbackOnRecovery:true},card);
        await this.install(state,row);
        return {id:row.id,avatar:row.avatar,version:row.current};
    }

    imagePath(row) {
        const name=row.image ?? row.original;
        if(!/^[\w-]+\.png$/.test(name ?? ''))throw new Error('角色图片引用无效');
        return path.join(this.archive,name);
    }

    async install(state, row) {
        const card = await this.body(row);
        const target = path.join(this.dirs.characters,avatarName(row.avatar));
        const image = await readFile(this.imagePath(row));
        const stub = placeholder(card,row.id);
        stub.fav = stub.data.extensions.fav = row.favorite;
        await atomicWrite(target,encodeCard(image,stub));
        if ((await readCard(target)).data.extensions.character_library.id !== row.id) throw new Error('占位读回失败');
        if(row.image&&this.dirs.thumbnailsAvatar)await rm(path.join(this.dirs.thumbnailsAvatar,row.avatar),{force:true});
        row.operation = null;
        await this.commit(state);
    }

    async recover(state, row) {
        if (row.operation === 'staging'&&row.rollbackOnRecovery) {
            const target=path.join(this.dirs.characters,avatarName(row.avatar));
            const exists=await stat(target).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
            if(exists)throw Object.assign(new Error('未完成的新增角色与磁盘文件冲突'),{status:409});
            delete state.records[row.avatar];
            await this.commit(state);
        } else if (row.operation === 'saving') {
            // Current still identifies the last committed version.
            if (/^[a-f0-9-]+\.json$/.test(row.pending ?? '')) {
                await rm(path.join(this.archive,row.pending),{force:true});
            }
            if (/^[a-f0-9-]+\.png$/.test(row.pendingImage ?? '')) {
                await rm(path.join(this.archive,row.pendingImage),{force:true});
            }
            delete row.pending;
            delete row.pendingImage;
            row.operation = null;
            await this.commit(state);
        } else if (row.operation === 'installing') {
            await this.install(state,row);
        } else if (row.operation === 'deleting') {
            await this.removePlaceholder(state,row);
        } else if (row.operation === 'renaming') {
            await this.finishRename(state,row);
        }
    }

    async rename(state,binding,requested) {
        const row=await this.target(state,binding.avatar,binding.id,binding.version);
        if(typeof requested!=='string'||!requested.trim())throw new Error('无效的角色名称');
        avatarName(requested+'.png');
        if(!this.dirs.chats||!this.dirs.groups)throw new Error('宿主缺少改名所需的会话目录');
        const names=new Set([...await this.enumerate(),...Object.keys(state.records),...(state.reserved??[])].map(name=>name.toLowerCase()));
        let avatar=requested+'.png',suffix=1;
        while(names.has(avatar.toLowerCase())){avatar=requested+'_'+suffix+'.png';suffix++;}
        const destination=path.join(this.dirs.chats,avatar.slice(0,-4));
        if(await stat(destination).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;}))
            throw Object.assign(new Error('新名称已有聊天目录'),{status:409});
        row.operation='renaming';
        row.renaming={avatar,name:requested,version:randomUUID()+'.json'};
        await this.commit(state);
        return this.finishRename(state,row);
    }

    async finishRename(state,row) {
        const {avatar,name,version}=row.renaming;
        const previousAvatar=avatarName(row.avatar);
        const from=path.join(this.dirs.characters,previousAvatar);
        const to=path.join(this.dirs.characters,avatarName(avatar));
        for(const filename of [from,to]){
            const card=await readCard(filename).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
            const tag=card?.data?.extensions?.character_library;
            if(card&&(tag?.id!==row.id||tag.version!==3||!tag.cold))throw Object.assign(new Error('改名路径角色已改变'),{status:409});
        }
        const card=await this.body(row);
        card.name=name;
        card.data??={};
        card.data.name=name;
        await atomicWrite(path.join(this.archive,version),JSON.stringify(card));
        const stub=placeholder(card,row.id);
        stub.fav=stub.data.extensions.fav=row.favorite;
        await atomicWrite(to,encodeCard(await readFile(this.imagePath(row)),stub));
        const currentChatDir=path.join(this.dirs.chats,previousAvatar.slice(0,-4));
        const newChatDir=path.join(this.dirs.chats,avatar.slice(0,-4));
        await rename(currentChatDir,newChatDir).catch(error=>{if(error.code!=='ENOENT')throw error;});
        for(const entry of await readdir(this.dirs.groups,{withFileTypes:true})){
            if(!entry.isFile()||!entry.name.endsWith('.json'))continue;
            const filename=path.join(this.dirs.groups,entry.name);
            const group=await json(filename);
            let changed=false;
            for(const field of ['members','disabled_members']){
                if(!Array.isArray(group?.[field])||!group[field].includes(previousAvatar))continue;
                group[field]=group[field].map(value=>value===previousAvatar?avatar:value);
                changed=true;
            }
            if(changed)await atomicWrite(filename,JSON.stringify(group));
        }
        await rm(from,{force:true});
        const oldPrevious=row.previous;
        delete state.records[previousAvatar];
        (state.reserved??=[]).push(previousAvatar);
        Object.assign(row,{avatar,name,current:version,previous:row.current,operation:null});
        delete row.renaming;
        state.records[avatar]=row;
        await this.commit(state);
        if(/^[a-f0-9-]+\.json$/.test(oldPrevious??''))await rm(path.join(this.archive,oldPrevious),{force:true});
        return {id:row.id,avatar,version};
    }

    async removePlaceholder(state,row) {
        const filename=path.join(this.dirs.characters,avatarName(row.avatar));
        const card=await readCard(filename).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
        const marker=card?.data?.extensions?.character_library;
        if(card&&(marker?.version!==3||marker.id!==row.id||marker.cold!==true))
            throw Object.assign(new Error('磁盘角色已改变，删除已暂停'),{status:409});
        await rm(filename,{force:true});
        delete state.records[row.avatar];
        (state.reserved ??= []).push(row.avatar);
        await this.commit(state);
    }

    async delete(state,binding) {
        const row=await this.target(state,binding.avatar,binding.id);
        if(row.current!==binding.version)throw Object.assign(new Error('角色版本已改变'),{status:409});
        row.operation='deleting';
        await this.commit(state);
        await this.removePlaceholder(state,row);
        return {id:row.id,avatar:row.avatar};
    }

    async save(state, target, card, image) {
        const row = Object.hasOwn(state.records, target.avatar) ? state.records[avatarName(target.avatar)] : null;
        if (!row || row.id !== target.id || row.current !== target.version || row.operation) {
            throw Object.assign(new Error('角色身份、版本或操作阶段已改变'),{status:409});
        }
        if (card?.data?.extensions?.character_library?.cold) throw new Error('不能保存占位正文');
        const fields = summary(card);
        if(image)encodeCard(image,placeholder(card,row.id));
        const oldPrevious = row.previous;
        const oldImage=row.image;
        const version = randomUUID()+'.json';
        row.operation = 'saving';
        row.pending = version;
        if(image)row.pendingImage=version.replace('.json','.png');
        await this.commit(state);
        const file = path.join(this.archive,version);
        const serialized=JSON.stringify(card);
        await atomicWrite(file,serialized);
        if(image){
            await atomicWrite(path.join(this.archive,row.pendingImage),image);
            row.image=row.pendingImage;
        }
        Object.assign(row,fields,{previous:row.current,current:version,operation:'installing',parsedBytes:Buffer.byteLength(serialized)});
        delete row.pending;
        delete row.pendingImage;
        await this.commit(state);
        await this.install(state,row);
        if (/^[a-f0-9-]+\.json$/.test(oldPrevious ?? '')) await rm(path.join(this.archive,oldPrevious),{force:true});
        if(image&&oldImage&&oldImage!==row.original&&/^[a-f0-9-]+\.png$/.test(oldImage))await rm(path.join(this.archive,oldImage),{force:true});
        return {id:row.id,avatar:row.avatar,version};
    }

    async release(state, mode, apply) {
        if (!['enhanced','releasing-'+mode].includes(state.mode)) throw new Error('账户未处于可交还状态');
        const rows = Object.values(state.records);
        for (const row of rows) {
            avatarName(row.avatar);
            if (row.operation && !['saving','installing'].includes(row.operation)) throw new Error('请先完成待处理写入：'+row.avatar);
            await this.body(row);
        }
        const report={mode,apply,characters:rows.length};
        if (!apply) return report;
        for (const row of rows) await this.recover(state,row);
        state.mode = 'releasing-'+mode;
        await this.commit(state);
        if (mode === 'basic') {
            const basic = {schemaVersion:2,managed:true,restoring:false,records:{},garbage:[]};
            for (const row of rows) {
                const card = await this.body(row);
                const original = 'cl2-'+row.id+'-enhanced-original.png';
                const current = 'cl2-'+row.id+'-enhanced-'+row.current;
                await copyFile(this.imagePath(row),path.join(this.dirs.files,original));
                await copyFile(path.join(this.archive,row.current),path.join(this.dirs.files,current));
                const stub = placeholder(card,row.id);
                stub.fav = stub.data.extensions.fav = row.favorite;
                stub.data.extensions.character_library.version = 2;
                const target = path.join(this.dirs.characters,row.avatar);
                await atomicWrite(target,encodeCard(await readFile(this.imagePath(row)),stub));
                basic.records[row.avatar] = {...row,original,current,previous:null,parsedBytes:Buffer.byteLength(JSON.stringify(card))};
            }
            await atomicWrite(path.join(this.dirs.files,'character-library-v2.json'),JSON.stringify(basic));
        } else {
            for (const row of rows) {
                const card = await this.body(row);
                if (card.data?.extensions) delete card.data.extensions.character_library;
                if(row.favorite!==summary(card).favorite){
                    if(card.data){card.data.extensions ??= {};card.data.extensions.fav=row.favorite;}
                    card.fav=row.favorite;
                }
                await atomicWrite(path.join(this.dirs.characters,row.avatar),
                    encodeCard(await readFile(this.imagePath(row)),card));
            }
            await atomicWrite(path.join(this.dirs.files,'character-library-v2.json'),
                JSON.stringify({schemaVersion:2,managed:false,restoring:false,records:{},garbage:[]}));
        }
        state.mode = 'released';
        await this.commit(state);
        return report;
    }
}
