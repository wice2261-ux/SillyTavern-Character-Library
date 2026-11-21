export const DIRECTORY = 'character-library-v2.json';
export const MARKER = 'character_library';
export const TARGETS = Object.freeze({onlineLimit:8, budgetMiB:192});
export function conflict(message) { return Object.assign(new Error(message), {status:409,code:'CHARACTER_LIBRARY_CONFLICT'}); }
export function marker(card) { return card?.data?.extensions?.[MARKER]; }
export function isPlaceholder(card) { const tag=marker(card);return (tag?.version===2||tag?.version===3)&&tag.cold===true; }
export function exactAvatar(avatar) {
    if (typeof avatar !== 'string' || !avatar.endsWith('.png') || /[\\/\x00-\x1f]/.test(avatar) || avatar.replace('.png','')+'.png' !== avatar)
        throw conflict('原生写入文件名存在歧义，请先处理：'+avatar);
    return avatar;
}
export function importedTime(card) {
    const date=card?.create_date;
    if(typeof date!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(date)||!Number.isFinite(Date.parse(date)))return null;
    // Date.parse normalizes invalid dates such as February 31; those are not reliable history.
    if(new Date(date.slice(0,10)+'T00:00:00Z').toISOString().slice(0,10)!==date.slice(0,10))return null;
    return Date.parse(date);
}
function favorite(card) { return card.fav === true || card.fav === 'true' || card.data?.extensions?.fav === true; }
export function placeholder(card,id) {
    const name=card.data?.name || card.name;
    return {name,chat:card.chat,create_date:card.create_date,fav:favorite(card),tags:card.tags||card.data?.tags||[],
        spec:'chara_card_v2',spec_version:'2.0',data:{name,description:'',personality:'',scenario:'',first_mes:'',mes_example:'',
            creator_notes:'',tags:card.tags||card.data?.tags||[],extensions:{fav:favorite(card),[MARKER]:{version:2,id,cold:true}}}};
}
function identified(card,id) {
    const copy=structuredClone(card);delete copy.json_data;
    copy.data ||= {name:copy.name};copy.data.extensions ||= {};
    copy.data.extensions[MARKER]={version:2,id,cold:false};return copy;
}
function empty() { return {schemaVersion:2,managed:false,restoring:false,records:{},garbage:[]}; }
export function pageCards(records,{search='',sort='imported',dir='desc',pinnedFirst=true,page=1,pageSize=24}={}) {
    const q=String(search).trim().toLocaleLowerCase(),sign=dir==='asc'?1:-1;
    if(!['name','imported','played','size'].includes(sort))sort='imported';
    const rows=Object.values(records).filter(r=>[r.name,r.avatar,...r.tags].join(' ').toLocaleLowerCase().includes(q));
    rows.sort((a,b)=>{if(pinnedFirst&&a.favorite!==b.favorite)return a.favorite?-1:1;
        const av=a[sort],bv=b[sort];if(av==null&&bv!=null)return 1;if(bv==null&&av!=null)return -1;
        return (typeof av==='string'?av.localeCompare(bv||''):(av??0)-(bv??0))*sign||a.id.localeCompare(b.id);});
    pageSize=Math.min(100,Math.max(1,Math.trunc(Number(pageSize))||24));page=Math.max(1,Math.trunc(Number(page))||1);
    return {items:rows.slice((page-1)*pageSize,page*pageSize),total:rows.length,pageSize};
}
export class Library {
    constructor(io,coordinator,{getPolicy=()=>({})}={}) { this.io=io;this.coordinator=coordinator;this.getPolicy=getPolicy;this.state=empty();this.errors=[];this.progress=null;this.stop=false; }
    policy(){return {keepFavoritesLoaded:this.getPolicy().keepFavoritesLoaded===true};}
    protectedFavorite(row,policy){return policy.keepFavoritesLoaded&&row.favorite;}
    async load() {
        const saved=await this.io.read(DIRECTORY);
        if(saved && (saved.schemaVersion!==2 || !saved.records))throw conflict('无法读取此角色库目录版本；请保留账户备份');
        this.state=saved||empty();this.state.garbage ||= [];return this.state;
    }
    async commit() { await this.io.write(DIRECTORY,this.state);this.onCommit?.(); }
    async transaction(work) { return this.coordinator.run(async()=>{await this.load();return work();}); }
    row(avatar) { return this.state.records[avatar]; }
    status() {return {managed:this.state.managed,restoring:this.state.restoring,resources:TARGETS,coordination:this.coordinator.mode||'page',
        online:Object.values(this.state.records).filter(r=>r.online).length,keepFavoritesLoaded:this.policy().keepFavoritesLoaded,overTarget:Boolean(this.state.managed&&this.overTarget),progress:this.progress,errors:this.errors};}
    async recordVersion(row,card,kind) {
        const name='cl2-'+row.id+'-'+this.io.id()+'.json';
        if(row.operation?.pending && ![row.original,row.current,row.previous].includes(row.operation.pending))this.state.garbage.push(row.operation.pending);
        row.operation={kind,phase:'uploading',pending:name};await this.commit();
        await this.io.write(name,identified(card,row.id));
        if(row.previous)this.state.garbage.push(row.previous);
        row.previous=row.current||null;row.current=name;
        row.operation.phase='archived';await this.commit();
    }
    update(row,card) {
        row.name=card.data?.name||card.name;row.tags=card.tags||card.data?.tags||[];row.favorite=favorite(card);
        row.chat=card.chat;row.create_date=card.create_date;row.parsedBytes=new TextEncoder().encode(JSON.stringify(card)).byteLength;
    }
    async refresh(row,card){this.update(row,card);row.size=this.io.size?await this.io.size(row.avatar):row.parsedBytes;}
    async checkFree(avatar) {
        if((await this.coordinator.protected()).has(avatar))throw conflict('角色正在使用、准备或保存：'+avatar);
    }
    async migrateOne(avatar,meta) {return this.transaction(()=>this.migrateOneInside(avatar,meta));}
    async migrateOneInside(avatar,meta,policy=this.policy()) {
        if(this.state.restoring)throw conflict('账户恢复中，暂停新迁移');
        exactAvatar(avatar);if(this.row(avatar)?.current)return;
        const card=await this.io.card(avatar);if(isPlaceholder(card))throw conflict('占位卡缺少对应目录，请导入恢复资料：'+avatar);
        if(meta?.favorite!==undefined){card.fav=Boolean(meta.favorite);card.data.extensions ||= {};card.data.extensions.fav=Boolean(meta.favorite);}
        const existing=this.row(avatar);
        const row={id:existing?.id||meta?.id||this.io.id(),avatar,online:true,imported:existing?existing.imported:meta?.imported??importedTime(card),played:existing?.played??meta?.played??null};
        await this.refresh(row,card);if(meta?.favorite!==undefined)row.favorite=Boolean(meta.favorite);
        row.original='cl2-'+row.id+'-original.png';row.operation={kind:'migrate',phase:'original',pending:row.original};
        this.state.records[avatar]=row;await this.commit();
        await this.io.write(row.original,await this.io.png(avatar));
        await this.recordVersion(row,card,'migrate');
        if(!this.protectedFavorite(row,policy) && !(await this.coordinator.protected()).has(avatar)) {
            await this.io.edit(avatar,placeholder(card,row.id));row.online=false;
        }else await this.io.edit(avatar,identified(card,row.id));
        row.operation=null;await this.commit();if(!row.online)this.onCold?.(row,placeholder(card,row.id));await this.cleanupInside();
    }
    async migrate({preview=false,metadata=[]}={}) {
        if(preview) {
            const cards=await this.io.list(),conflicts=[];let estimatedBytes=0;
            for(const card of cards)try{exactAvatar(card.avatar);}catch(e){conflicts.push({avatar:card.avatar,message:e.message});}
            for(const card of cards)if(!this.row(card.avatar)?.current){
                try{estimatedBytes+=(this.io.size?await this.io.size(card.avatar):0)+(Number(card.data_size)||0)+1024;}
                catch(e){conflicts.push({avatar:card.avatar,message:e.message});}
            }
            return {resident:cards.length,favorites:cards.filter(favorite).length,conflicts,
                estimatedBytes};
        }
        await this.transaction(async()=>{if(this.state.restoring)throw conflict('账户恢复中');if(!this.state.managed){this.state.managed=true;await this.commit();}});
        this.stop=false;this.errors=[];
        const avatars=(await this.io.list()).map(c=>c.avatar);this.progress={running:true,done:0,total:avatars.length};
        try{for(const avatar of avatars){if(this.stop)break;try{await this.migrateOne(avatar,metadata.find(m=>m.avatar===avatar));}
            catch(e){if(this.state.restoring)break;this.errors.push({avatar,message:e.message});}this.progress.done++;this.onProgress?.(this.status());}}
        finally{this.progress.running=false;}
        return {...this.status(),progress:{...this.progress,failed:this.errors.length,errors:this.errors}};
    }
    async prepare(avatars,{restoring=false}={}) {return this.transaction(async()=>{
        if(this.state.restoring && !restoring && avatars.some(a=>this.row(a)?.online===false))throw conflict('账户恢复中，请继续恢复后打开归库角色');
        for(const avatar of [...new Set(avatars)])await this.prepareInside(avatar);
    });}
    async prepareInside(avatar) {
        const row=this.row(avatar);if(!row)return;
        exactAvatar(avatar);
        const native=await this.io.card(avatar);
        if(!isPlaceholder(native)){
            if(marker(native)?.id && marker(native).id!==row.id)throw conflict('角色身份与目录不符：'+avatar);
            if(!row.online){row.online=true;await this.refresh(row,native);await this.commit();}return;
        }
        if(marker(native).id!==row.id)throw conflict('占位卡身份与目录不符：'+avatar);
        const card=await this.io.read(row.current);if(!card || isPlaceholder(card))throw conflict('归档正文缺失：'+avatar);
        row.operation={kind:'prepare',phase:'writing',pending:row.current};await this.commit();
        // Favorite/tag changes made while cold belong to the card, not its old archived presentation.
        const next=identified(card,row.id);next.chat=native.chat;next.create_date=native.create_date;
        next.fav=row.favorite;next.tags=row.tags;next.data.tags=row.tags;next.data.extensions.fav=row.favorite;
        await this.io.edit(avatar,next);row.online=true;row.operation=null;await this.refresh(row,next);await this.commit();
    }
    async withdraw(avatar) {return this.transaction(()=>this.withdrawInside(avatar));}
    async withdrawInside(avatar,policy=this.policy()) {
        const row=this.row(avatar);if(!row || !row.online)return;
        if(this.state.restoring)throw conflict('账户恢复中');await this.checkFree(avatar);
        const card=await this.io.card(avatar);if(isPlaceholder(card)){row.online=false;await this.commit();return;}
        if(this.protectedFavorite({favorite:favorite(card)||row.favorite},policy))return;
        if(marker(card)?.id && marker(card).id!==row.id)throw conflict('角色身份已改变：'+avatar);
        exactAvatar(avatar);await this.refresh(row,card);
        await this.recordVersion(row,card,'withdraw');
        if((await this.coordinator.protected()).has(avatar)){
            const operation=row.operation;row.operation=null;
            try{await this.commit();}catch(error){row.operation=operation;throw error;}
            return;
        }
        await this.io.edit(avatar,placeholder(card,row.id));row.online=false;row.operation=null;await this.commit();this.onCold?.(row,placeholder(card,row.id));await this.cleanupInside();
    }
    async cleanupInside() {
        // Only previously registered, unreferenced versions are eligible. Never enumerate/delete foreign files.
        const retained=new Set();for(const r of Object.values(this.state.records))for(const n of [r.original,r.current,r.previous,r.operation?.pending])if(n)retained.add(n);
        const pending=this.state.garbage.filter(n=>!retained.has(n));
        let changed=false;
        for(const name of pending)try{await this.io.remove(name);this.state.garbage=this.state.garbage.filter(n=>n!==name);changed=true;}catch{/* Retry registered cleanup on the next transaction. */}
        if(changed)await this.commit();
    }
    async recover() {return this.transaction(async()=>{
        this.errors=[];
        for(const row of Object.values(this.state.records)) {
            if(!row.operation)continue;
            try{
                if(['native-delete','native-rename'].includes(row.operation.kind)){
                    let present=true;try{await this.io.card(row.avatar);}catch(e){if(e.status===404)present=false;else throw e;}
                    if(!present&&row.operation.kind==='native-delete'){
                        for(const name of [row.original,row.current,row.previous,row.operation.pending])if(name)this.state.garbage.push(name);
                        delete this.state.records[row.avatar];await this.commit();continue;
                    }
                    if(!present){const matches=(await this.io.list({fresh:true})).filter(card=>marker(card)?.id===row.id);
                        if(matches.length!==1)throw conflict('改名结果无法唯一定位，请保留恢复资料');
                        const old=row.avatar;row.avatar=matches[0].avatar;this.state.records[row.avatar]=row;delete this.state.records[old];
                    }
                }
                const card=await this.io.card(row.avatar);
                if(isPlaceholder(card)){
                    if(marker(card).id!==row.id || !await this.io.read(row.current))throw conflict('占位与归档不一致');
                    if(row.operation.pending&&![row.original,row.current,row.previous].includes(row.operation.pending))this.state.garbage.push(row.operation.pending);
                    row.online=false;
                }else{
                    // The native disk may contain an edit saved after the last archived version.
                    if(row.operation.kind==='migrate'&&row.operation.phase==='original')await this.io.write(row.original,await this.io.png(row.avatar));
                    await this.recordVersion(row,card,'recover');row.online=true;await this.refresh(row,card);
                }
                row.operation=null;await this.commit();
            }catch(e){this.errors.push({avatar:row.avatar,message:e.message});}
        }
        await this.cleanupInside();return this.status();
    });}
    async restoreAll() {
        this.stop=true;
        await this.transaction(async()=>{this.state.restoring=true;await this.commit();});
        const remaining=[];let restored=0;
        for(const avatar of Object.keys(this.state.records))try{
            await this.transaction(async()=>{await this.prepareInside(avatar);const r=this.row(avatar);
                const card=await this.io.card(avatar);await this.recordVersion(r,card,'restore');r.operation=null;r.online=true;await this.commit();});restored++;
        }catch(e){remaining.push({avatar,message:e.message});}
        await this.transaction(async()=>{if(!remaining.length){this.state.restoring=false;this.state.managed=false;}await this.commit();});
        return {...this.status(),restored,remaining};
    }
    async collect() {return this.transaction(async()=>{
        if(!this.state.managed || this.state.restoring || this.progress?.running)return;
        const policy=this.policy();
        const occupied=await this.coordinator.protected();
        let online=Object.values(this.state.records).filter(r=>r.online),size=online.reduce((n,r)=>n+(r.parsedBytes||r.size||0),0);
        let count=online.filter(r=>!this.protectedFavorite(r,policy)).length;
        const candidates=online.filter(r=>!this.protectedFavorite(r,policy)&&!occupied.has(r.avatar)&&!r.operation)
            .sort((a,b)=>(a.played||0)-(b.played||0)||a.id.localeCompare(b.id));
        for(const row of candidates){if(count<=TARGETS.onlineLimit && size<=TARGETS.budgetMiB*1024*1024)break;
            try{await this.withdrawInside(row.avatar,policy);if(!row.online){count--;size-=row.parsedBytes||row.size||0;}}
            catch(e){this.errors=[...this.errors.filter(x=>x.avatar!==row.avatar),{avatar:row.avatar,message:e.message}];}}
        this.overTarget=count>TARGETS.onlineLimit||size>TARGETS.budgetMiB*1024*1024;
    });}
    list(query) { return {...this.status(),...pageCards(this.state.records,query)}; }
    async registerCreatedInside(avatar,{imported=null}={}) {
        const policy=this.policy();
        const card=await this.io.card(avatar);
        const row={id:this.io.id(),avatar,online:true,imported,played:null};await this.refresh(row,card);
        if(marker(card))await this.io.edit(avatar,identified(card,row.id));
        this.state.records[avatar]=row;await this.commit();
        if(this.state.managed&&!this.state.restoring)await this.migrateOneInside(avatar,undefined,policy);
    }
    async setFavorite(avatar,value,id) {return this.transaction(async()=>{
        const row=this.row(avatar);if(!row||row.id!==id)throw conflict('收藏目标已改变');
        const card=await this.io.card(avatar);card.fav=Boolean(value);card.data.extensions.fav=Boolean(value);
        await this.io.edit(avatar,card);row.favorite=Boolean(value);await this.commit();return this.status();
    });}
}
