import * as native from '/script.js';
import * as groups from '/scripts/group-chats.js';
import { getContext } from '/scripts/extensions.js';
import { NativeStorage, base64, editPayload, hostTime } from './storage.js';
import { parseReplacement, replacementForm } from './replacement.js';
import { Library, isPlaceholder, importedTime, conflict, exactAvatar } from './lifecycle.js';
import { Coordinator } from './coordinator.js';
import { installEntries, assertSpelling, createdAvatar } from './entries.js';
import { createLibrary } from './library.js';
import { createSettings } from './settings.js';
import { drawCards } from './draw.js';
import { buildRecovery } from './recovery.js';
import { Worldbook, managementKey, withNativeTags, tagSignature } from './worldbook.js';
import { EnhancedLibrary } from './enhanced.js';
const VERSION='2.3.2',network=window.fetch.bind(window),ctx=()=>getContext();
const io=new NativeStorage(network,()=>native.getRequestHeaders());
io.listProvider=()=>native.characters.map(c=>({avatar:c.avatar,name:c.name,fav:c.fav,tags:c.tags||[],data_size:c.data_size||0,create_date:c.create_date}));
let settings,showLibrary,entries,library,coordinator,worldbook,scheduled,worldbookScheduled,oldDetected=false,capabilityError=null;
let enhancedPending=false;
let managementBusy=false,nativeTagsKey;
const preferences=()=>ctx().extensionSettings.characterLibrary||{};
function savePreferences(value){ctx().extensionSettings.characterLibrary={...preferences(),...value};ctx().saveSettingsDebounced();}
function flushWorldbook(){clearTimeout(worldbookScheduled);if(!managementBusy)worldbookScheduled=setTimeout(()=>void worldbook?.flush(),800);}
function managementChanged(){nativeTagsKey=hostTagsKey();worldbook?.markChanged();flushWorldbook();}
function snapshotRows(){return withNativeTags(Object.values(library.state.records).map(row=>({
    id:row.id,avatar:row.avatar,name:row.name,tags:[...(row.tags||[])],favorite:row.favorite,imported:row.imported,played:row.played})),ctx());}
function hostTagsKey(){return tagSignature(Object.values(library?.state.records||{}),ctx());}
function notice(error){globalThis.toastr?.error(error.message,'角色库',{preventDuplicates:true});}
const ready=(async()=>{
    let account=null;try{const user=await network('/api/users/me',{headers:native.getRequestHeaders()});if(user.ok)account=(await user.json()).handle;}catch{}
    let storage=null;try{storage=window.localStorage;}catch{}
    coordinator=new Coordinator({navigator,storage,account});library=new Library(io,coordinator,{getPolicy:()=>({keepFavoritesLoaded:preferences().keepFavoritesLoaded===true})});
    const enhanced = await io.read('character-library-enhanced.json');
    enhancedPending=Boolean(enhanced && enhanced.mode!=='released');
    if(enhancedPending){
        if(enhanced.mode!=='enhanced')throw conflict('检测到尚未完成的增强交接，请先完成离线交接。');
        library=new EnhancedLibrary(io,coordinator,{getPolicy:()=>({keepFavoritesLoaded:preferences().keepFavoritesLoaded===true})});
    }
    worldbook=new Worldbook({io,snapshot:()=>library.transaction(async()=>snapshotRows()),
        getPreferences:()=>preferences().worldbook||{},savePreferences:value=>savePreferences({worldbook:value}),
        onStatus:value=>settings?.updateWorldbook(value)});
    library.onProgress=value=>settings?.update(value);
    library.onCommit=()=>coordinator.signal();
    library.onCold=(row,card)=>{const index=native.characters.findIndex(c=>c.avatar===row.avatar);
        if(index>=0)native.characters[index]={...card,avatar:row.avatar,shallow:true};};
    await coordinator.run(async()=>{await library.load();});
    oldDetected=Boolean(window.STCharacterLibraryAdapter||window.STCharacterLibraryManaged);
    if(!oldDetected){try{const r=await network('/api/plugins/character-library/status',{method:'POST',headers:native.getRequestHeaders(),body:'{}'});
        if(r.ok){const s=await r.json();oldDetected=Boolean(s.managed||s.restoring);}}catch{}}
    if(enhancedPending&&oldDetected)throw conflict('检测到 1.x 仍在管理此账户，请先完成交接并停用旧后端与适配。');
    if(!oldDetected&&Object.keys(library.state.records).length)await library.recover();
    return true;
})().catch(error=>{capabilityError=error;settings?.update(null,error);return false;});
// Install synchronously, before native startup lists and automatic selection.
const proxyLibrary=new Proxy({}, {get:(_,key)=>{
    if(key==='state')return library?.state;const value=library?.[key];return typeof value==='function'?value.bind(library):value;
}});
const proxyCoordinator=new Proxy({}, {get:(_,key)=>{const value=coordinator?.[key];return typeof value==='function'?value.bind(coordinator):value;}});
entries=installEntries({native,groups,ctx,lib:proxyLibrary,io,coordinator:proxyCoordinator,ready,notify:notice,onChanged:schedule,onManagementChanged:managementChanged,replace:replacement,enhancedUnavailable:()=>enhancedPending,enhanced:()=>library instanceof EnhancedLibrary?library:null});
function checkOld(){if(oldDetected)throw conflict('请先交接 1.x 账户，撤销原生适配并停用旧服务端。');if(capabilityError)throw capabilityError;}
async function status(){
    await ready;if(capabilityError)throw capabilityError;
    await library.transaction(async()=>{});
    let enhancement=library instanceof EnhancedLibrary?'active':'absent';
    if(enhancement==='absent'){
        try{
            const probe=await io.post('plugins/character-library-enhanced/status',{});
            enhancement=(await probe.json()).protocol===1?'available':'incompatible';
        }catch(error){if(error.status!==404)enhancement='unavailable';}
    }
    return {...library.status(),oldDetected,enhancement};
}
function schedule(){clearTimeout(scheduled);scheduled=setTimeout(async()=>{
    try{await ready;if(oldDetected)return;entries.publishCurrent();await library.collect();await replaceColdSlots();settings?.update(library.status());await showLibrary?.refresh();}
    catch(error){settings?.update(null,error);}
},800);}
async function replaceColdSlots(){
    for(let i=0;i<native.characters.length;i++){const previous=native.characters[i],row=library.row(previous.avatar);
        if(row?.online===false&&!isPlaceholder(previous)&&!(library instanceof EnhancedLibrary&&previous.shallow)){
            const card=await io.card(row.avatar);card.avatar=row.avatar;card.shallow=true;native.characters[i]=card;
        }}
}
async function list(body){
    await ready;await library.transaction(async()=>{});
    // Unmanaged native cards remain browsable without writing an archive/index or retaining their full objects here.
    const records=library.state.records,extra=[];
    for(const card of native.characters)if(!records[card.avatar])extra.push({id:'native:'+card.avatar,avatar:card.avatar,name:card.name,
        tags:card.tags||card.data?.tags||[],favorite:card.fav===true,online:!isPlaceholder(card),size:card.data_size||0,imported:importedTime(card),played:null});
    const all={...records};for(const row of extra)all[row.avatar]=row;
    if(body.draw)return {...library.status(),...drawCards(Object.values(all),body.search,body.count)};
    const saved=library.state.records;library.state.records=all;
    try{return library.list(body);}finally{library.state.records=saved;}
}
async function api(route,body={}){
    await ready;if(capabilityError)throw capabilityError;let result;
    if(library instanceof EnhancedLibrary){
        if(route==='/draw')return {...library.status(),...await library.request('/draw',body)};
        if(route==='/list'){
            const result=await library.request('/list',body);
            return {...library.status(),...result,items:result.items.map(item=>({...item,online:library.active.has(item.avatar)}))};
        }
        if(route==='/release'){
            if(body.apply)await entries.strictSave();
            return coordinator.run(()=>library.request('/release',body));
        }
        if(!['/status','/list','/draw/check','/favorite','/unfavorite','/delete'].includes(route))throw conflict('该管理操作暂未接通增强账户');
        if(route==='/delete'&&body.deleteChats)throw conflict('增强模式目前仅支持保留聊天的删除');
    }
    switch(route){
        case '/status':result=await status();break;
        case '/list':return list(body);
        case '/draw':return list({...body, draw:true});
        case '/draw/check':{
            return library.transaction(async()=>{
                const row=library.row(body.avatar);
                const id=row?.id ?? (native.characters.some(card=>card.avatar===body.avatar)?'native:'+body.avatar:null);
                if(id!==body.id)throw conflict('角色已变更，请再抽一次。');
            });
        }
        case '/stop':library.stop=true;return library.status();
        case '/migrate':{checkOld();const before=Object.keys(library.state.records).length;
            result=await library.migrate({...body,metadata:(await io.read('cl2-legacy-metadata.json'))?.records||[]});
            if(!body.preview&&Object.keys(library.state.records).length!==before)managementChanged();break;}
        case '/restore':checkOld();result=await library.restoreAll();break;
        case '/unfavorite':body.favorite=false;
        case '/favorite':{
            const row=library.row(body.avatar);
            if(row){const previous=managementKey(row);result=await library.setFavorite(body.avatar,body.favorite,body.id);if(previous!==managementKey(library.row(body.avatar)))managementChanged();}
            else{await coordinator.run(async()=>{const card=await io.card(body.avatar);card.fav=body.favorite;card.data.extensions.fav=body.favorite;await io.edit(body.avatar,card);});result=library.status();}
            break;
        }
        case '/delete':{
            const row=library.row(body.avatar);if(row&&row.id!==body.id)throw conflict('删除目标已改变');
            if((await coordinator.protected()).has(body.avatar))throw conflict('角色正在使用，请先切换到其他聊天');
            if(ctx().groups.some(g=>g.members.includes(body.avatar)))throw conflict('请先从群聊移除此角色');
            const card=native.characters.find(c=>c.avatar===body.avatar);
            await entries.strictSave();
            const deleted=await native.deleteCharacter([body.avatar],{deleteChats:body.deleteChats});if(!deleted)throw Error('角色未删除');
            result={...library.status(),deleted:card||body};break;
        }
        default:throw Error('未知的角色库操作：'+route);
    }
    if(result.resources)settings?.update(result);if(!(route==='/migrate'&&body.preview))schedule();return result;
}
async function upload(file,mode='rename',replaceAvatar=null,bound=null){
    await ready;checkOld();if(library.state.restoring)throw conflict('账户恢复中');
    if(file.size>64*1024*1024)throw Error('角色卡超过64 MiB导入上限');
    const format=file.name.split('.').pop().toLowerCase();if(!['png','json'].includes(format))throw Error('仅支持PNG和JSON角色卡');
    const rawName=file.name.slice(0,-format.length-1);
    const {fileName}=await(await io.post('files/sanitize-filename',{fileName:rawName})).json();if(!fileName)throw Error('无效的文件名');
    if(library instanceof EnhancedLibrary){
        const avatar=exactAvatar(replaceAvatar||fileName+'.png');
        const bytes=new Uint8Array(await file.arrayBuffer());
        const fields=format==='png'?{png:base64(bytes)}:{card:parseReplacement(bytes,format)};
        const result=await library.transaction(async()=>{
            const row=library.row(avatar);
            if(bound&&(row?.id!==bound.id||avatar!==bound.avatar))throw conflict('替换目标已改变');
            if(mode==='replace'&&row&&(await coordinator.protected({othersOnly:Boolean(replaceAvatar)})).has(avatar))
                throw conflict('角色正在使用，不能替换');
            const release=coordinator.hold('saving',[avatar]);
            try{
                const item=await library.request('/import-card',{avatar,mode,id:mode==='replace'?row?.id:undefined,
                    version:mode==='replace'?row?.version:undefined,...fields});
                if(item.skipped)throw Object.assign(conflict('同名文件已存在'),{code:'CHARACTER_LIBRARY_DUPLICATE'});
                library.active.delete(avatar);
                await library.load();
                return {item:library.row(item.avatar)};
            }finally{release();}
        });
        managementChanged();schedule();await native.getCharacters();return result;
    }
    return coordinator.run(async()=>{
        await library.load();if(library.state.restoring)throw conflict('账户恢复中');
        const names=new Set([...native.characters.map(c=>c.avatar),...Object.keys(library.state.records)]);
        let avatar=replaceAvatar||fileName+'.png',existing=names.has(avatar),before;
        const alias=!existing&&[...names].find(n=>n.toLocaleLowerCase()===avatar.toLocaleLowerCase());
        if(alias&&mode==='replace')assertSpelling(avatar,[...names].map(avatar=>({avatar})));
        if(alias&&mode==='skip')throw Object.assign(conflict('同名文件已存在：'+alias),{code:'CHARACTER_LIBRARY_DUPLICATE'});
        if(bound&&(!library.row(avatar)||library.row(avatar).id!==bound.id||avatar!==bound.avatar))throw conflict('替换目标已改变');
        if(existing&&mode==='skip')throw Object.assign(conflict('同名文件已存在'),{code:'CHARACTER_LIBRARY_DUPLICATE'});
        if((existing||alias)&&mode==='rename'){let i=1;const folded=new Set([...names].map(n=>n.toLocaleLowerCase()));while(folded.has((fileName+'_'+i+'.png').toLocaleLowerCase()))i++;avatar=fileName+'_'+i+'.png';existing=false;}
        exactAvatar(avatar);
        if(existing){if((await coordinator.protected({othersOnly:Boolean(replaceAvatar)})).has(avatar))throw conflict('角色正在使用，不能替换');
            await library.prepareInside(avatar);before=await io.card(avatar);}
        const release=coordinator.hold('saving',[avatar]);
        try{
            if(existing){
                if(format==='png'){const image=new Image(),url=URL.createObjectURL(file);try{image.src=url;await image.decode();}finally{URL.revokeObjectURL(url);}}
                const card=parseReplacement(new Uint8Array(await file.arrayBuffer()),format),row=library.row(avatar);
                card.data ||= {...card};card.data.extensions ||= {};card.chat=before.chat;card.create_date=before.create_date;
                card.fav=before.fav;card.data.extensions.fav=before.fav===true;
                if(row)card.data.extensions.character_library={version:2,id:row.id,cold:false};
                else delete card.data.extensions.character_library;
                const payload=editPayload(avatar,card);
                const response=format==='png'?await network('/api/characters/edit',{method:'POST',headers:native.getRequestHeaders({omitContentType:true}),body:replacementForm(payload,file)}):await io.post('characters/edit',payload);
                if(!response.ok)throw Error('替换失败：'+response.status);
                await io.verify(avatar,card);
                if(row)try{const previous=managementKey(row);row.online=true;await library.refresh(row,await io.card(avatar));await library.commit();if(previous!==managementKey(row))managementChanged();}
                catch(error){notice(new Error('替换已完成，目录更新失败；在线卡已保留：'+error.message));}
                return {item:row||{avatar}};
            }
            const data=new FormData();data.set('avatar',file,file.name);data.set('file_type',format);data.set('preserved_name',avatar);
            const response=await network('/api/characters/import',{method:'POST',headers:native.getRequestHeaders({omitContentType:true}),body:data});
            const result=await response.json();if(!response.ok||result.error||!result.file_name)throw Error('原生导入失败：'+response.status);
            if(createdAvatar('import',result)!==avatar)throw conflict('原生导入实际文件名与目标不符：'+result.file_name);
            try{await library.registerCreatedInside(avatar,{imported:hostTime(response)});managementChanged();}catch(error){notice(new Error('角色已导入，目录更新失败；请继续整理未迁移角色：'+error.message));}
            return {item:library.row(avatar)||{avatar}};
        }finally{release();schedule();}
    }).then(async result=>{await native.getCharacters();return result;});
}
async function replacement(avatar,bound){
    const dialog=document.createElement('dialog');dialog.className='cl-library cl-confirm';
    dialog.innerHTML='<div class="cl-layout"><strong>替换角色卡</strong><p></p><div class="cl-tools"><button class="menu_button" data-mode="file">选择文件</button><button class="menu_button" data-mode="url">从URL下载</button><button class="menu_button" data-mode="cancel">取消</button></div></div>';
    dialog.querySelector('p').textContent='目标：'+avatar+'。保留身份、聊天和导入时间。';document.body.append(dialog);
    const choice=await new Promise(resolve=>{dialog.addEventListener('close',()=>resolve(dialog.returnValue),{once:true});
        for(const button of dialog.querySelectorAll('button'))button.onclick=()=>dialog.close(button.dataset.mode);dialog.showModal();});dialog.remove();
    let file;
    if(choice==='file'){
        const input=document.createElement('input');input.type='file';input.accept='.png,.json';
        file=await new Promise(resolve=>{input.onchange=()=>resolve(input.files[0]);input.oncancel=()=>resolve(null);input.click();});
    }else if(choice==='url'){
        const url=window.prompt('输入角色卡URL或UUID');if(!url)return;
        const route=/^https?:\/\//i.test(url)?'content/importURL':'content/importUUID';
        const response=await io.post(route,{url});if(response.headers.get('X-Custom-Content-Type')!=='character')throw Error('下载内容不是角色卡');
        const name=response.headers.get('Content-Disposition')?.split('filename=')[1]?.replaceAll('"','')||'replacement.png';
        file=new File([await response.blob()],name,{type:response.headers.get('Content-Type')||'image/png'});
    }
    if(!file)return;await upload(file,'replace',avatar,bound);
    if(native.characters[native.this_chid]?.avatar===avatar)await entries.hydrate([avatar]);
}
async function importMetadata(value){
    await ready;if(library.state.managed)throw conflict('请在迁移前导入旧元数据');
    if(value?.format!=='character-library-1-metadata'||!Array.isArray(value.records))throw Error('不是1.x元数据导出文件');
    const seen=new Set(),ids=new Set();for(const row of value.records){exactAvatar(row.avatar);if(!row.id||seen.has(row.avatar)||ids.has(row.id))throw Error('元数据存在重复或缺少身份');seen.add(row.avatar);ids.add(row.id);}
    await io.write('cl2-legacy-metadata.json',value);
}
function download(name,value){const blob=new Blob([JSON.stringify(value,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
async function exportRecovery(){await ready;await library.transaction(async()=>{
    if(library instanceof EnhancedLibrary)download('角色库增强恢复资料.json',await library.request('/recovery'));
    else download('角色库2.1恢复资料.json',buildRecovery(library.state));
});}
function install(){
    if(!document.getElementById('extensions_settings'))return;
    showLibrary ||= createLibrary({api,upload,openChat:entries.open,preflight:async()=>ready,
        sync:async()=>{await native.getCharacters();},notifyDeleted:async()=>{},preferences:preferences(),savePreferences,
        onBusyChange:busy=>{managementBusy=busy;if(busy)clearTimeout(worldbookScheduled);else flushWorldbook();}});
    settings ||= createSettings({api,version:VERSION,refreshNative:()=>native.getCharacters(),refreshLibrary:()=>showLibrary.refresh(),exportRecovery,importMetadata,
        setKeepFavoritesLoaded:async value=>{await ready;savePreferences({keepFavoritesLoaded:value===true});if(!value)schedule();},
        worldbook:{status:()=>worldbook?.status(),setAutoUpdate:async value=>{await ready;checkOld();return worldbook.setAutoUpdate(value);},updateNow:async()=>{await ready;checkOld();return worldbook.updateNow();}}});
    const host=document.getElementById('extensions_settings');if(!document.getElementById('cl-library-settings'))host.append(settings.panel);
    const bookHost=document.getElementById('rm_button_create');if(bookHost&&!document.getElementById('cl-library-open')){
        const book=document.createElement('button');book.type='button';book.id='cl-library-open';book.className='menu_button fa-solid fa-book-open';book.title='打开角色库';book.onclick=()=>void showLibrary();bookHost.before(book);}
    const menu=document.getElementById('extensionsMenu');if(menu&&!document.getElementById('cl-library-menu')){
        const item=document.createElement('div');item.id='cl-library-menu';item.className='list-group-item flex-container flexGap5';item.tabIndex=0;item.role='button';
        item.innerHTML='<div class="fa-fw fa-solid fa-book-open extensionsMenuExtensionButton"></div><span>角色库</span>';
        item.onclick=()=>setTimeout(()=>void showLibrary(),0);item.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();item.click();}};menu.append(item);}
}
install();
const context=ctx();
context.eventSource.on(context.eventTypes.APP_READY,async()=>{
    install();try{await ready;entries.publishCurrent();await settings.refresh();
        nativeTagsKey=hostTagsKey();
        if(!oldDetected&&!capabilityError)void worldbook.start();
        const [{SlashCommandParser},utils]=await Promise.all([import('/scripts/slash-commands/SlashCommandParser.js'),import('/scripts/utils.js')]);entries.commands(SlashCommandParser,utils);
        schedule();}catch(e){settings?.update(null,e);}
});
context.eventSource.on(context.eventTypes.CHAT_CHANGED,()=>{entries.publishCurrent();schedule();});
context.eventSource.on(context.eventTypes.GROUP_UPDATED,()=>{entries.publishCurrent();schedule();});
context.eventSource.on(context.eventTypes.SETTINGS_UPDATED,()=>{
    const key=hostTagsKey();if(nativeTagsKey!==undefined&&nativeTagsKey!==key)managementChanged();nativeTagsKey=key;
});
window.addEventListener('pagehide',e=>{if(!e.persisted)coordinator?.close();});
setInterval(()=>{if(library?.state.managed&&!library.state.restoring)schedule();},30000);
window.addEventListener('storage',e=>{if(e.key?.startsWith(coordinator?.scope)){void ready.then(()=>library.transaction(async()=>{})).then(replaceColdSlots).catch(notice);}});
// Small public integration surface; no full cards are stored here.
window.CharacterLibrary={version:VERSION,ready,status,prepare:avatars=>ready.then(()=>entries.prepared(avatars,async()=>{})),
    open:avatar=>ready.then(()=>entries.open(avatar)),migrate:options=>api('/migrate',options),restore:()=>api('/restore'),collect:()=>ready.then(()=>library.collect()).then(replaceColdSlots),
    exportRecovery,importMetadata,stop:()=>api('/stop')};
