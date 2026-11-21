import { Library, TARGETS, conflict, isPlaceholder } from './lifecycle.js';
import { base64, savedData } from './storage.js';
import { parseReplacement } from './replacement.js';

async function avatarPng(file,crop){
    if(!file?.size)return undefined;
    if(file.size>64*1048576)throw conflict('头像超过 64 MiB');
    const image=await createImageBitmap(file);
    try{
        let {x,y,width,height} = crop ?? {x:0,y:0,width:image.width,height:image.height};
        if(![x,y,width,height].every(Number.isFinite)||!(width>0&&height>0))throw conflict('头像裁剪尺寸无效');
        const canvas=document.createElement('canvas');
        canvas.width=crop?.want_resize?512:width;
        canvas.height=crop?.want_resize?768:height;
        const ratio=canvas.width/canvas.height;
        if(width/height>ratio){const w=height*ratio;x+=(width-w)/2;width=w;}
        else{const h=width/ratio;y+=(height-h)/2;height=h;}
        canvas.getContext('2d').drawImage(image,x,y,width,height,0,0,canvas.width,canvas.height);
        const png=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
        if(!png)throw conflict('头像无法转换为 PNG');
        return base64(new Uint8Array(await png.arrayBuffer()));
    }finally{image.close();}
}

export class EnhancedLibrary extends Library {
    constructor(io, coordinator, options) {
        super(io, coordinator, options);
        this.active = new Map();
    }

    async request(route, body = {}) {
        return (await this.io.post('plugins/character-library-enhanced' + route, body)).json();
    }

    async load() {
        const status = await this.request('/status');
        if (status.protocol !== 1 || status.mode !== 'enhanced') throw conflict('增强后端或账户状态不匹配');
        const items = await this.request('/directory');
        const records = Object.fromEntries(items.map(row => {
            const cached = this.active.get(row.avatar);
            if (cached?.version !== row.version) this.active.delete(row.avatar);
            return [row.avatar, { ...row, online: this.active.has(row.avatar) }];
        }));
        this.state = { managed: true, restoring: false, records };
        return this.state;
    }

    status() { return { ...super.status(), mode: 'enhanced' }; }
    async commit() {}
    async recover() {}
    async markPlayed(avatars) {
        const rows=avatars.map(avatar=>this.row(avatar)).filter(Boolean);
        if(!rows.length)return;
        const {played}=await this.request('/played',{targets:rows.map(({id,avatar})=>({id,avatar}))});
        for(const row of rows)row.played=played;
    }

    async prepareInside(avatar) {
        const row = this.row(avatar);
        if (!row || this.active.has(avatar)) return;
        const result = await this.request('/prepare', { avatar, id: row.id });
        if (isPlaceholder(result.card)) throw conflict('增强归档缺少完整正文');
        this.active.set(avatar, { ...result, used: this.io.now() });
        row.online = true;
    }

    async fullCard(avatar) {
        if (!this.row(avatar)) return this.io.card(avatar);
        await this.prepare([avatar]);
        const cached = this.active.get(avatar);
        cached.used = this.io.now();
        const card = cached.card;
        return { ...card, ...Object.fromEntries(['name','description','personality','scenario','first_mes','mes_example','tags'].map(key =>
            [key, card.data?.[key] ?? card[key]])), avatar, shallow: false };
    }

    async setFavorite(avatar, favorite, id) {
        return this.transaction(async () => {
            const row=this.row(avatar);
            if (row?.id!==id) throw conflict('收藏目标已改变');
            const {version}=await this.request('/favorite',{avatar,id,version:row.version,favorite});
            const cached=this.active.get(avatar);
            if(cached){
                cached.card.fav=favorite;
                cached.card.data.extensions ??= {};
                cached.card.data.extensions.fav=favorite;
                cached.version=version;
            }
            Object.assign(row,{favorite,version});
            return this.status();
        });
    }

    async writeEdit(avatar, payload, identity, crop) {
        return this.transaction(async () => {
            const row = this.row(avatar);
            if (!identity || row?.id !== identity.id || row.version !== identity.version) throw conflict('增强角色已改变，请重新打开编辑');
            if (typeof payload.ch_name !== 'string' || !payload.ch_name.trim() || payload.ch_name === '.')
                throw conflict('角色名称无效');
            const previous = await this.request('/prepare', {avatar, id: row.id});
            if (previous.version !== identity.version) throw conflict('增强角色已改变，请重新打开编辑');
            const submitted = payload.json_data ? JSON.parse(payload.json_data) : previous.card;
            if (isPlaceholder(submitted)) throw conflict('不能保存占位正文');
            const data = savedData(payload, submitted);
            const card = { ...previous.card, ...submitted, ...data, data,
                chat: payload.chat ?? previous.card.chat, create_date: previous.card.create_date };
            for (const key of ['avatar','json_data','shallow']) delete card[key];
            delete card.extensions;
            const image=await avatarPng(payload.avatar,crop);
            const result = await this.request('/save', { avatar, id: row.id, version: identity.version, card, image });
            this.active.set(avatar, { card, version: result.version, used: this.io.now() });
            row.version = result.version;
            row.online = true;
            return result;
        });
    }

    async editAvatar(identity,file,crop){
        const image=await avatarPng(file,crop);
        if(!image)throw conflict('请选择头像图片');
        const result=await this.request('/avatar',{...identity,image});
        const cached=this.active.get(identity.avatar);
        if(cached)cached.version=result.version;
        this.row(identity.avatar).version=result.version;
        return result;
    }

    async createNative(payload,crop){
        const submitted=payload.json_data?JSON.parse(payload.json_data):{};
        if(typeof payload.ch_name!=='string'||!payload.ch_name.trim()||payload.ch_name==='.')throw conflict('角色名称无效');
        const data=savedData(payload,submitted);
        const card={...submitted,...data,spec:'chara_card_v2',spec_version:'2.0',data};
        const avatar=await this.safeAvatar(payload.file_name||data.name);
        return this.request('/import-card',{avatar,mode:'rename',card,image:await avatarPng(payload.avatar,crop)});
    }

    async safeAvatar(name){
        const result=await(await this.io.post('files/sanitize-filename',{fileName:name.replace(/\.png$/i,'')})).json();
        if(!result.fileName)throw conflict('角色文件名无效');
        return result.fileName+'.png';
    }

    async importNative(payload){
        const file=payload.avatar;
        const format=String(payload.file_type||'').toLowerCase();
        if(!file?.size||file.size>64*1048576||!['png','json'].includes(format))throw conflict('增强模式原生导入支持 64 MiB 以内的 PNG 或 JSON');
        const bytes=new Uint8Array(await file.arrayBuffer());
        const fields=format==='png'?{png:base64(bytes)}:{card:parseReplacement(bytes,format)};
        const source=payload.preserved_name||file.name.replace(/\.[^.]+$/,'');
        const avatar=await this.safeAvatar(source);
        return this.request('/import-card',{avatar,mode:'rename',...fields});
    }

    async exportCard(row, format) {
        return this.io.post('plugins/character-library-enhanced/export-file',{avatar:row.avatar,id:row.id,format});
    }

    async collect() {
        return this.transaction(async () => {
            const occupied = await this.coordinator.protected();
            const policy = this.policy();
            const online = Object.values(this.state.records).filter(row => row.online);
            let count = online.filter(row => !this.protectedFavorite(row, policy)).length;
            let bytes = online.reduce((total, row) => total + (row.parsedBytes ?? row.size), 0);
            for (const row of online.sort((a,b) => this.active.get(a.avatar).used - this.active.get(b.avatar).used)) {
                if (count <= TARGETS.onlineLimit && bytes <= TARGETS.budgetMiB * 1048576) break;
                if (occupied.has(row.avatar) || this.protectedFavorite(row, policy)) continue;
                const stub = await this.io.card(row.avatar);
                if (!isPlaceholder(stub)) throw conflict('原生增强占位已改变：' + row.avatar);
                this.active.delete(row.avatar);
                row.online = false;
                count--;
                bytes -= row.parsedBytes ?? row.size;
                this.onCold?.(row, stub);
            }
            this.overTarget = count > TARGETS.onlineLimit || bytes > TARGETS.budgetMiB * 1048576;
        });
    }
}
