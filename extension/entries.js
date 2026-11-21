import { conflict, marker, isPlaceholder, exactAvatar } from './lifecycle.js';
import {hostTime} from './storage.js';
import {managementKey} from './worldbook.js';
export function resolveMembers(members,rows) {
    return members.map(member=>{if(rows.some(r=>r.avatar===member))return member;
        const matches=rows.filter(r=>r.name===member);if(matches.length!==1)throw conflict('群成员无法唯一匹配：'+member);return matches[0].avatar;});
}
export function writeTargets(route,body,rows) {
    if(route==='merge-attributes')return Array.isArray(body.avatars)?(body.avatars.length?[...body.avatars]:rows.map(r=>r.avatar)):[body.avatar];
    if(route==='import')return body.preserved_name?[body.preserved_name.replace(/\.[^.]+$/,'')+'.png']:[];
    return body.avatar_url?[body.avatar_url]:[];
}
export function bindingMatches(binding,row) {return Boolean(binding&&row&&binding.id===row.id&&binding.avatar===row.avatar);}
export function createdAvatar(route,result){
    if(route==='import')return result?.file_name?result.file_name+'.png':null;
    if(route==='create')return result?.file_name||null;
    return route==='duplicate'?result?.path||null:null;
}
export function assertSpelling(avatar,rows){
    if(rows.some(r=>r.avatar===avatar))return;
    const match=rows.find(r=>r.avatar.toLocaleLowerCase()===avatar?.toLocaleLowerCase());
    if(match)throw conflict('角色文件名拼写不一致，请使用：'+match.avatar);
}
export function emptyGroupHistory(data){return Array.isArray(data)&&(data.length===0||data.length===1&&Object.hasOwn(data[0],'chat_metadata')&&!data[0].chat_metadata?.tainted);}
export async function mergeBatch(targets,send) {
    const result={updated:[],skipped:[],failed:[]};
    for(const avatar of targets)try{const item=await send(avatar);for(const key of Object.keys(result))result[key].push(...(item[key]||[]));}
    catch{result.failed.push(avatar);}return result;
}
export async function groupGreetings(members,rows,{emit,substitute,thumbnail,now}) {
    const messages=[];
    for(const avatar of members){const card=rows.find(r=>r.avatar===avatar);if(!card)throw conflict('群成员不存在：'+avatar);
        const choices=[card.first_mes,...(card.data?.alternate_greetings||[])].filter(Boolean);
        const text=choices[Math.floor(Math.random()*choices.length)]||'';
        const event={input:text,output:'',character:card};await emit(event);
        const content=event.output||text;if(!content)continue;
        messages.push({is_user:false,is_system:false,name:card.name,send_date:new Date(now()).toISOString(),original_avatar:avatar,
            force_avatar:thumbnail(avatar),extra:{gen_id:now()*Math.random()*1000000},mes:substitute(content.trim(),card.name)});
    }
    return messages;
}
export async function appendGroupMessages(messages,native,context){
    for(const message of messages){
        const id=native.chat.push(message)-1;
        await context.eventSource.emit(context.eventTypes.MESSAGE_RECEIVED,id,'first_message');
        native.addOneMessage(message);
        await context.eventSource.emit(context.eventTypes.CHARACTER_MESSAGE_RENDERED,id,'first_message');
    }
}
const writeRoutes=new Set(['edit','edit-avatar','edit-attribute','merge-attributes','rename','delete','duplicate','import','create']);
export function installEntries({native:n,groups:g,ctx,lib,io,coordinator:c,ready,notify,onChanged,onManagementChanged=()=>{},replace,enhancedUnavailable=()=>false,enhanced=()=>null}) {
    let transition=false,replay=false,editorBinding=null;
    const binding=avatar=>{const row=lib.row(avatar),visible=n.characters.find(x=>x.avatar===avatar);return row?{id:marker(visible)?.id||row.id,avatar,version:row.version}:null;};
    const current=()=>{
        const context=ctx(),group=context.groups?.find(x=>String(x.id)===String(context.groupId));
        const single=n.characters[context.characterId]?.avatar;
        return [...new Set([...(group?resolveMembers(group.members,n.characters):[]),...(single?[single]:[])])];
    };
    function publishCurrent(){if(!c.set)return;try{c.set('current',current());}catch{c.set('current',[]);}editorBinding=binding(n.characters[n.this_chid]?.avatar);}
    function retainSaving(avatars) {return c.hold('saving',avatars);}
    async function startupPrepare(avatars){
        const release=c.hold('pending',avatars);
        try{await lib.prepare(avatars);ctx().eventSource.once(ctx().eventTypes.CHAT_CHANGED,()=>{publishCurrent();release();});}
        catch(error){release();throw error;}
    }
    async function hydrate(avatars) {
        for(const avatar of avatars){const index=n.characters.findIndex(x=>x.avatar===avatar);if(index>=0){const card=await (enhanced()?.fullCard(avatar) ?? io.card(avatar));
            if(isPlaceholder(card))throw conflict('角色仍是占位，缺少可用目录或归档：'+avatar);
            card.avatar=avatar;n.characters[index]=card;}}
    }
    async function prepared(avatars,work) {
        const release=c.hold('pending',avatars);
        try{await lib.prepare(avatars);await hydrate(avatars);return await work();}
        finally{publishCurrent();release();}
    }
    async function strictSave() {
        const started=Date.now();while(n.isChatSaving){if(Date.now()-started>10000)throw Error('等待聊天保存超时');await new Promise(r=>setTimeout(r,50));}
        const avatars=current();if(!avatars.length||!n.chat?.length)return;
        const before=avatars.join('\0'),release=retainSaving(avatars);
        try{
            if(ctx().groupId){const group=ctx().groups.find(x=>String(x.id)===String(ctx().groupId));
                await io.post('chats/group/save',{id:group.chat_id,chat:[{user_name:'unused',character_name:'unused',chat_metadata:ctx().chatMetadata||{}},...n.chat]});
                if(before!==current().join('\0'))throw conflict('保存期间会话已改变');return;}
            const avatar=avatars[0],identity=binding(avatar),card=n.characters[n.this_chid];
            await c.run(async()=>{
                await lib.load();if(identity&&!bindingMatches(identity,lib.row(avatar)))throw conflict('保存目标已改变');
                if(before!==current().join('\0'))throw conflict('保存期间会话已改变');
                await io.post('chats/save',{ch_name:card.name,avatar_url:avatar,file_name:card.chat,
                    chat:[{user_name:'unused',character_name:'unused',chat_metadata:ctx().chatMetadata||{}},...n.chat]});
            });
        }finally{release();}
    }
    async function action(work) {
        if(transition)return;transition=true;
        try{await ready;return await work();}catch(e){notify(e);throw e;}finally{transition=false;onChanged();}
    }
    async function markPlayed(avatars){
        const backend=enhanced();
        if(backend){
            try{await backend.markPlayed(avatars);}catch(error){notify(error);}
        }else await lib.transaction(async()=>{
            let changed=false;
            for(const avatar of avatars){
                if(!lib.row(avatar))continue;
                lib.row(avatar).played=io.now();
                changed=true;
            }
            if(changed)await lib.commit();
        });
    }
    async function open(avatar) {return action(async()=>{
        await strictSave();if(!n.characters.some(c=>c.avatar===avatar))await n.getCharacters();await prepared([avatar],async()=>{
            const index=n.characters.findIndex(r=>r.avatar===avatar);if(index<0)throw conflict('角色不在原生列表');
            await n.selectCharacterById(index);if(n.characters[n.this_chid]?.avatar!==avatar)throw Error('酒馆未完成角色切换');
            n.setActiveCharacter?.(avatar);n.setActiveGroup?.(null);
        });
        await markPlayed([avatar]);
    });}
    async function openGroup(id) {return action(async()=>{
        const group=ctx().groups.find(x=>String(x.id)===String(id));if(!group)throw Error('群聊不存在');
        const members=resolveMembers(group.members,n.characters),disabled=resolveMembers(group.disabled_members||[],n.characters);
        await strictSave();await prepared(members,async()=>{
            group.members=members;group.disabled_members=disabled;
            await g.openGroupById(group.id);if(String(ctx().groupId)!==String(group.id))throw Error('酒馆未完成群聊切换');
            n.setActiveCharacter?.(null);n.setActiveGroup?.(group.id);
        });
        if(String(ctx().groupId)===String(group.id))await markPlayed(members);
    });}
    async function history(name) {return action(async()=>{await strictSave();const avatars=current();await prepared(avatars,async()=>{
        if(ctx().groupId)await g.openGroupChat(ctx().groupId,name);else await n.openCharacterChat(name);
        document.querySelector('#shadow_select_chat_popup')?.style.setProperty('display','none');
    });});}
    async function requestBody(input,init) {
        const body=init?.body;
        function fields(form){
            const values=Object.fromEntries(form.entries());
            if(form.has('alternate_greetings'))values.alternate_greetings=form.getAll('alternate_greetings');
            return values;
        }
        if(body instanceof FormData)return fields(body);
        if(typeof body==='string')try{return JSON.parse(body);}catch{return {};}
        if(input instanceof Request){const type=input.headers.get('Content-Type')||'';if(type.includes('multipart'))return fields(await input.clone().formData());}
        const headers=new Headers(init?.headers||(input instanceof Request?input.headers:{}));
        if(headers.get('Content-Encoding')==='gzip'&&body){const stream=new Response(body).body.pipeThrough(new DecompressionStream('gzip'));return JSON.parse(await new Response(stream).text());}
        if(input instanceof Request)try{return await input.clone().json();}catch{return {};}
        return {};
    }
    const original=window.fetch.bind(window);
    window.fetch=async(input,init)=>{
        const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href);
        if(url.origin!==location.origin||!/^\/api\/(characters|chats|groups)\//.test(url.pathname))return original(input,init);
        const initialized=await ready;
        if(initialized===false){
            if(enhancedUnavailable() && url.pathname.startsWith('/api/characters/') && url.pathname!=='/api/characters/all'
                && url.pathname!=='/api/characters/chats'){
                throw conflict('增强账户未就绪，角色操作已暂停');
            }
            const attempted=await requestBody(input,init);
            const visible=n.characters.find(x=>x.avatar===attempted.avatar_url);
            if(visible&&isPlaceholder(visible))throw conflict('归档能力不可用，请保留恢复资料后恢复此卡');
            if(url.pathname==='/api/characters/all'){
                const response=await original(input,init);if(!response.ok)return response;const rows=await response.json();
                for(const card of rows)if(isPlaceholder(card))card.shallow=true;return jsonResponse(response,rows);
            }
            return original(input,init);
        }
        const [,family,route]=url.pathname.match(/^\/api\/([^/]+)\/(.+)$/),body=await requestBody(input,init);
        const backend=enhanced();
        if(backend&&family==='characters'&&['create','import'].includes(route)){
            const created=route==='create'?
                await backend.createNative(body,JSON.parse(url.searchParams.get('crop')??'null')):await backend.importNative(body);
            await backend.load();
            onManagementChanged();onChanged();
            if(route==='create')return new Response(created.avatar);
            return Response.json({file_name:created.avatar.slice(0,-4)});
        }
        if(backend&&family==='characters'&&route==='get'&&lib.row(body.avatar_url)){
            const release=c.hold('pending',[body.avatar_url]);
            try{
                const card=await backend.fullCard(body.avatar_url);
                return Response.json({...card,json_data:JSON.stringify(card)});
            }finally{release();onChanged();}
        }
        if(backend&&family==='characters'&&route==='edit'&&lib.row(body.avatar_url)){
            const avatar=body.avatar_url,identity=editorBinding?.avatar===avatar?editorBinding:binding(avatar);
            const release=retainSaving([avatar]);
            try{
                const saved=await backend.writeEdit(avatar,body,identity,JSON.parse(url.searchParams.get('crop')??'null'));
                if(editorBinding?.avatar===avatar)editorBinding={avatar,id:saved.id,version:saved.version};
                return new Response('OK');
            }finally{release();onChanged();}
        }
        if(backend&&family==='characters'&&route==='edit-avatar'&&lib.row(body.avatar_url)){
            const avatar=body.avatar_url,identity=binding(avatar),release=retainSaving([avatar]);
            try{
                const saved=await backend.editAvatar(identity,body.avatar,JSON.parse(url.searchParams.get('crop')??'null'));
                if(editorBinding?.avatar===avatar)editorBinding={...identity,version:saved.version};
                return new Response('OK');
            }finally{release();onChanged();}
        }
        if(backend&&family==='characters'&&route==='export'&&lib.row(body.avatar_url)){
            const row=lib.row(body.avatar_url);
            return backend.exportCard(row,body.format);
        }
        if(backend&&family==='characters'&&route==='duplicate'&&lib.row(body.avatar_url)){
            const row=lib.row(body.avatar_url);
            const result=await backend.request('/duplicate',{avatar:row.avatar,id:row.id});
            onManagementChanged();onChanged();
            return Response.json({path:result.avatar});
        }
        if(backend&&family==='characters'&&route==='edit-attribute'&&lib.row(body.avatar_url)){
            const avatar=body.avatar_url,identity=binding(avatar),release=retainSaving([avatar]);
            try{
                const saved=await backend.request('/attribute',{...identity,field:body.field,value:body.value});
                backend.active.delete(avatar);lib.row(avatar).online=false;lib.row(avatar).version=saved.version;
                if(editorBinding?.avatar===avatar)editorBinding={...identity,version:saved.version};
                if(current().includes(avatar))await hydrate([avatar]);
                onManagementChanged();
                return new Response('OK');
            }finally{release();onChanged();}
        }
        if(backend&&family==='characters'&&route==='merge-attributes'){
            const targets=writeTargets(route,body,n.characters);
            if(targets.some(avatar=>lib.row(avatar))){
                const bulk=Array.isArray(body.avatars),release=retainSaving(targets);
                try{
                    const send=async avatar=>{
                        if(!lib.row(avatar)){
                            const response=await original(input,{...init,body:JSON.stringify({...body,avatars:[avatar]})});
                            if(!response.ok)throw Error('原生角色属性更新失败');
                            return response.json();
                        }
                        const identity=binding(avatar);
                        const saved=await backend.request('/merge',{...identity,update:bulk?body.data:body,filter:body.filter?.path});
                        if(saved.skipped)return {skipped:[avatar]};
                        backend.active.delete(avatar);lib.row(avatar).online=false;lib.row(avatar).version=saved.version;
                        if(editorBinding?.avatar===avatar)editorBinding={...identity,version:saved.version};
                        if(current().includes(avatar))await hydrate([avatar]);
                        return {updated:[avatar]};
                    };
                    if(bulk){
                        const result=await mergeBatch(targets,send);
                        onManagementChanged();
                        return Response.json(result);
                    }
                    await send(targets[0]);
                    onManagementChanged();
                    return new Response('OK');
                }finally{release();onChanged();}
            }
        }
        if(backend&&family==='characters'&&route==='delete'&&lib.row(body.avatar_url)){
            const avatar=body.avatar_url,identity=binding(avatar);
            if(body.delete_chats)throw conflict('增强模式目前仅支持保留聊天的删除');
            await backend.transaction(async()=>{
                const row=backend.row(avatar);
                if(row?.id!==identity?.id||row.version!==identity.version)throw conflict('删除目标已改变');
                if((await c.protected()).has(avatar))throw conflict('角色正在使用');
                if(ctx().groups.some(group=>group.members.includes(avatar)))throw conflict('请先从群聊移除此角色');
                await backend.request('/delete',identity);
                delete backend.state.records[avatar];
                backend.active.delete(avatar);
            });
            onManagementChanged();onChanged();
            return new Response('OK');
        }
        if(backend&&family==='characters'&&route==='rename'&&lib.row(body.avatar_url)){
            const avatar=body.avatar_url,identity=binding(avatar);
            await strictSave();
            const {fileName}=await(await io.post('files/sanitize-filename',{fileName:body.new_name})).json();
            const result=await backend.transaction(async()=>{
                const before=backend.row(avatar);
                if(before?.id!==identity.id||before.version!==identity.version)throw conflict('改名目标已改变');
                if((await c.protected({othersOnly:true})).has(avatar))throw conflict('其他页面仍在使用角色');
                if(c.occupancy.pending.includes(avatar)||c.occupancy.saving.includes(avatar)||ctx().groupId&&current().includes(avatar))
                    throw conflict('角色正在准备、保存或群聊中');
                const release=retainSaving([avatar]);
                try{
                    const renamed=await backend.request('/rename',{...identity,name:fileName});
                    backend.active.delete(avatar);
                    await backend.load();
                    return renamed;
                }finally{release();}
            });
            for(const group of ctx().groups)for(const field of ['members','disabled_members']){
                if(Array.isArray(group[field]))group[field]=group[field].map(member=>member===avatar?result.avatar:member);
            }
            onManagementChanged();onChanged();
            return Response.json({avatar:result.avatar});
        }
        if(backend&&family==='characters'&&(writeRoutes.has(route)||route==='export')){
            const targets=writeTargets(route,body,n.characters);
            if(['create','import'].includes(route)||targets.some(avatar=>lib.row(avatar)))
                throw conflict('此原生操作暂未接通增强账户：'+route);
        }
        if(family==='characters'&&route==='all'){
            await lib.transaction(async()=>{});
            // Startup restore must precede native auto-selection. No need to restore the entire list.
            const active=n.active_character;if(ctx().powerUserSettings?.auto_load_chat&&active&&lib.row(active)?.online===false)await startupPrepare([active]);
            const response=await original(input,init);if(!response.ok)return response;
            const rows=await response.json();
            for(const card of rows){
                const row=backend?.row(card.avatar);
                if(row&&card.shallow){
                    card.data ??= {};
                    card.data.extensions ??= {};
                    card.data.extensions.character_library={version:3,id:row.id,cold:true};
                }
                if(isPlaceholder(card))card.shallow=true;
            }
            return jsonResponse(response,rows);
        }
        if(family==='groups'&&route==='all'){
            const response=await original(input,init);if(!response.ok)return response;
            const rows=await response.clone().json(),active=ctx().powerUserSettings?.auto_load_chat&&rows.find(x=>String(x.id)===String(n.active_group));
            if(active){const members=resolveMembers(active.members,n.characters);await startupPrepare(members);await hydrate(members);active.members=members;return jsonResponse(response,rows);}return response;
        }
        if(family==='groups'&&route==='create'&&lib.state.managed){
            const members=resolveMembers(body.members||[],n.characters),release=c.hold('pending',resolveMembers(body.members||[],n.characters));
            try{
                await lib.prepare(members);await hydrate(members);
                const response=await original(input,init);if(!response.ok){release();return response;}
                ctx().eventSource.once(ctx().eventTypes.CHAT_CHANGED,()=>{publishCurrent();release();});return response;
            }catch(error){release();throw error;}
        }
        if(family==='characters'&&['get','export'].includes(route)){
            assertSpelling(body.avatar_url,n.characters);
            if(!lib.row(body.avatar_url)&&isPlaceholder(n.characters.find(r=>r.avatar===body.avatar_url)))throw conflict('占位卡缺少归档目录，请恢复账户文件备份');
            const release=c.hold('pending',[body.avatar_url]);
            try{if(lib.row(body.avatar_url))await lib.prepare([body.avatar_url]);
                const response=await original(input,init),bytes=await response.arrayBuffer(),headers=new Headers(response.headers);
                headers.delete('Content-Length');headers.delete('Content-Encoding');
                return new Response(bytes,{status:response.status,statusText:response.statusText,headers});
            }finally{release();onChanged();}
        }
        if(family==='chats'&&route==='group/get'&&lib.state.managed){
            const response=await original(input,init);if(!response.ok)return response;
            const data=await response.clone().json();
            const group=ctx().groups.find(x=>x.chat_id===body.id);
            if(!group||String(ctx().groupId)!==String(group.id)||!emptyGroupHistory(data))return response;
            const members=resolveMembers(group.members,n.characters);
            // Native 1.18 uses avatar || display-name matching here; generate only empty-history greetings by exact avatar.
            const metadata={...(data[0]?.chat_metadata||{}),integrity:data[0]?.chat_metadata?.integrity||io.id()};
            n.updateChatMetadata(metadata,true);n.chat.splice(0,n.chat.length);n.chatElement.find('.mes').remove();
            for(const avatar of members){
                const messages=await groupGreetings([avatar],n.characters,{now:io.now,thumbnail:a=>n.getThumbnailUrl('avatar',a),
                    substitute:(text,name)=>n.substituteParams(text,{name2Override:name}),
                    emit:args=>ctx().eventSource.emit(ctx().eventTypes.CHARACTER_FIRST_MESSAGE_SELECTED,args)});
                await appendGroupMessages(messages,n,ctx());
            }
            const header={user_name:'unused',character_name:'unused',chat_metadata:{...metadata,...ctx().chatMetadata}};
            group.date_last_chat=io.now();await io.post('chats/group/save',{id:body.id,chat:[header,...n.chat]});
            // Native sees a non-fresh header and no messages to print again. The native lifecycle above ran exactly once.
            return jsonResponse(response,[header]);
        }
        const isChatSave=family==='chats'&&route==='save';
        if((family==='characters'&&writeRoutes.has(route))||isChatSave){
            const targets=writeTargets(route,body,n.characters).filter(Boolean);
            if(route==='merge-attributes'&&Array.isArray(body.avatars)&&targets.length>1&&lib.state.managed){
                const result=await mergeBatch(targets,async avatar=>{
                    const cold=lib.row(avatar)?.online===false;
                    const response=await window.fetch('/api/characters/merge-attributes',{method:'POST',headers:io.headers(),body:JSON.stringify({...body,avatars:[avatar]})});
                    if(!response.ok)throw Error('属性更新失败');const result=await response.json();
                    if(cold)await lib.withdraw(avatar);return result;
                });return Response.json(result);
            }
            const bound=targets.map(avatar=>({avatar,binding:editorBinding?.avatar===avatar&&['edit','edit-avatar'].includes(route)?editorBinding:binding(avatar)}));
            const previousSaving=[...c.occupancy.saving];
            const release=retainSaving(targets);
            try{return await c.run(async()=>{
                await lib.load();
                for(const avatar of targets)assertSpelling(avatar,[...n.characters,...Object.values(lib.state.records)]);
                for(const b of bound){const row=lib.row(b.avatar);if(b.binding&&!bindingMatches(b.binding,row))throw conflict('操作目标已改变：'+b.avatar);
                    if(!row&&isPlaceholder(n.characters.find(r=>r.avatar===b.avatar)))throw conflict('占位卡缺少归档目录，不能写入占位正文');
                    if(row?.operation)throw conflict('角色有未完成操作，请继续恢复：'+b.avatar);
                    if(row&&!(backend&&isChatSave)){exactAvatar(b.avatar);const disk=await io.card(b.avatar);if(marker(disk)?.id&&marker(disk).id!==row.id)throw conflict('角色身份已改变');
                        if(['rename','delete','import'].includes(route)&&(await c.protected({othersOnly:true})).has(b.avatar))throw conflict('其他页面仍在使用角色');
                        if(['rename','delete','import'].includes(route)&&[...c.occupancy.current,...c.occupancy.pending,...previousSaving].includes(b.avatar))throw conflict('当前页面仍在使用、准备或保存角色');
                        if(route==='delete'&&ctx().groups.some(group=>group.members.includes(b.avatar)))throw conflict('请先从群聊移除此角色');
                        await lib.prepareInside(b.avatar);
                        if(route==='edit'&&isPlaceholder(safeJSON(body.json_data)))throw conflict('不能将占位正文保存为完整角色');
                        const submitted=marker(safeJSON(body.json_data));
                        if(submitted?.id&&submitted.id!==row.id)throw conflict('提交的角色正文属于旧身份');
                    }
                }
                if(route==='merge-attributes'&&Array.isArray(body.avatars)&&!body.avatars.length){body.avatars=targets;init={...init,body:JSON.stringify(body)};}
                let replaced;
                const previousMetadata=targets.map(avatar=>managementKey(lib.row(avatar)));
                if(family==='characters'&&route==='import'&&targets.length){const avatar=targets[0];replaced={avatar,card:await io.card(avatar),row:lib.row(avatar)};}
                if(['rename','delete'].includes(route))for(const avatar of targets){const row=lib.row(avatar);if(row){row.operation={kind:'native-'+route,phase:'writing',pending:row.current};await lib.commit();}}
                const response=await original(input,init);if(!response.ok){
                    if(['rename','delete'].includes(route))for(const avatar of targets)if(lib.row(avatar)){lib.row(avatar).operation=null;await lib.commit();}return response;
                }
                let result=await response.clone().json().catch(()=>null);
                if(route==='create'&&!result)result={file_name:await response.clone().text()};
                if(result?.error)return response;
                if(isChatSave)return response;
                try{
                if(route==='delete'){for(const avatar of targets){const row=lib.row(avatar);if(row)for(const name of [row.original,row.current,row.previous,row.operation?.pending])if(name)lib.state.garbage.push(name);delete lib.state.records[avatar];}await lib.commit();await lib.cleanupInside();}
                else if(route==='rename'){
                    const old=targets[0],avatar=result?.avatar||result?.avatar_url;
                    if(lib.row(old)&&avatar){const row=lib.row(old);delete lib.state.records[old];row.avatar=avatar;row.operation=null;lib.state.records[avatar]=row;await lib.refresh(row,await io.card(avatar));await lib.commit();}
                }else if(replaced){const card=await io.card(replaced.avatar);card.chat=replaced.card.chat;card.create_date=replaced.card.create_date;
                    if(replaced.row){card.data.extensions ||= {};card.data.extensions.character_library={version:2,id:replaced.row.id,cold:false};}
                    await io.edit(replaced.avatar,card);if(replaced.row){await lib.refresh(replaced.row,card);replaced.row.online=true;await lib.commit();}}
                else{
                    const avatar=createdAvatar(route,result);
                    if(avatar)await lib.registerCreatedInside(avatar,{imported:hostTime(response)});
                    else for(const avatar of targets)if(lib.row(avatar)){await lib.refresh(lib.row(avatar),await io.card(avatar));await lib.commit();}
                }
                const changedAvatar=createdAvatar(route,result)||result?.avatar||result?.avatar_url;
                if(targets.some((avatar,i)=>previousMetadata[i]!==managementKey(lib.row(avatar)))||
                    (changedAvatar&&!targets.includes(changedAvatar)&&lib.row(changedAvatar)))onManagementChanged();
                }catch(error){notify(new Error('原生操作已成功，角色库目录更新失败；请保留在线卡并重新加载恢复：'+error.message));console.warn('角色已写入，角色库元数据未更新',error);}
                return response;
            });}finally{release();onChanged();}
        }
        return original(input,init);
    };
    function replayEvent(target,event) {replay=true;try{target.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,shiftKey:event.shiftKey}));}finally{replay=false;}}
    document.addEventListener('click',event=>{
        if(replay||!(event.target instanceof Element))return;
        if(!lib.state?.managed&&!lib.state?.restoring&&!n.characters.some(isPlaceholder))return;
        const selected=event.target.closest('.character_select,.group_select,.select_chat_block,.mes_bookmark');
        if(selected){
            event.preventDefault();event.stopImmediatePropagation();
            let work;
            if(selected.matches('.group_select'))work=()=>openGroup(selected.dataset.grid);
            else if(selected.matches('.character_select')){const avatar=n.characters[Number(selected.dataset.chid)]?.avatar;work=()=>open(avatar);}
            else if(event.shiftKey&&selected.matches('.mes_bookmark'))work=()=>checkpoint(Number(selected.closest('.mes')?.getAttribute('mesid')));
            else work=()=>history(selected.getAttribute('file_name')||selected.closest('.mes')?.getAttribute('bookmark_link'));
            void work().catch(()=>{});return;
        }
        const bookmark=event.target.closest('.mes_create_branch,.mes_create_bookmark,#option_new_bookmark');
        if(bookmark){event.preventDefault();event.stopImmediatePropagation();const mes=bookmark.closest('.mes');
            const id=mes?Number(mes.getAttribute('mesid')):n.chat.length-1;
            void(bookmark.matches('.mes_create_branch')?branch(id):checkpoint(id)).catch(()=>{});return;}
        const back=event.target.closest('#option_back_to_main');
        if(back&&ctx().chatMetadata?.main_chat){event.preventDefault();event.stopImmediatePropagation();void history(ctx().chatMetadata.main_chat).catch(()=>{});return;}
        const member=event.target.closest('.group_member .right_menu_button');
        if(member?.dataset.action==='view'){
            const avatar=member.closest('.group_member').dataset.id;event.preventDefault();event.stopImmediatePropagation();
            void action(()=>prepared([avatar],()=>replayEvent(member,event))).catch(()=>{});return;
        }
        const full=event.target.closest('#export_button,.export_format,.group_member .avatar,.group_member .ch_name');
        if(full&&current().some(a=>lib.row(a)?.online===false)){event.preventDefault();event.stopImmediatePropagation();
            void action(()=>prepared(current(),()=>replayEvent(full,event))).catch(()=>{});}
    },true);
    document.addEventListener('change',event=>{
        if(event.target?.id!=='char-management-dropdown'||event.target.selectedOptions?.[0]?.id!=='replace_update'||!lib.state?.managed)return;
        event.preventDefault();event.stopImmediatePropagation();event.target.selectedIndex=0;
        const avatar=n.characters[n.this_chid]?.avatar,bound=binding(avatar);
        void action(async()=>{await strictSave();await prepared([avatar],async()=>{});})
            .then(()=>replace(avatar,bound)).catch(notify);
    },true);
    async function saveSnapshot(avatar,name,messages,metadata) {
        if(ctx().groupId){await io.post('chats/group/save',{id:name,chat:[{user_name:'unused',character_name:'unused',chat_metadata:metadata},...messages]});return;}
        await io.post('chats/save',{avatar_url:avatar,ch_name:n.characters.find(c=>c.avatar===avatar)?.name,file_name:name,
            chat:[{user_name:'unused',character_name:'unused',chat_metadata:metadata},...messages]});
    }
    async function checkpoint(mesId,forceName) {return action(async()=>{
        await strictSave();const avatar=current()[0],mes=n.chat[mesId];if((!avatar&&!ctx().groupId)||!mes)throw Error('没有可创建检查点的消息');
        const main=ctx().groupId?ctx().groups.find(x=>String(x.id)===String(ctx().groupId)).chat_id:n.characters[n.this_chid].chat;
        const name=forceName||window.prompt('检查点名称',main+' - Checkpoint '+Date.now());if(!name)return;
        await saveSnapshot(avatar,name,n.chat.slice(0,mesId+1),{...ctx().chatMetadata,main_chat:main});
        mes.extra ||= {};const old=mes.extra.bookmark_link;mes.extra.bookmark_link=name;
        try{await strictSave();}catch(e){if(old===undefined)delete mes.extra.bookmark_link;else mes.extra.bookmark_link=old;throw Error('检查点副本已保存，关联未保存：'+e.message);}
        document.querySelector('.mes[mesid="'+mesId+'"]')?.setAttribute('bookmark_link',name);return name;
    });}
    async function branch(mesId) {return action(async()=>{
        await strictSave();const avatar=current()[0],mes=n.chat[mesId];if((!avatar&&!ctx().groupId)||!mes)throw Error('没有可创建分支的消息');
        const main=ctx().groupId?ctx().groups.find(x=>String(x.id)===String(ctx().groupId)).chat_id:n.characters[n.this_chid].chat;
        const name=main+' - Branch '+Date.now();
        await saveSnapshot(avatar,name,n.chat.slice(0,mesId+1),{...ctx().chatMetadata,main_chat:main});
        mes.extra ||= {};mes.extra.branches ||= [];mes.extra.branches.push(name);
        try{await strictSave();}catch(e){mes.extra.branches.splice(mes.extra.branches.lastIndexOf(name),1);throw Error('分支副本已保存，关联未保存：'+e.message);}
        if(ctx().groupId)await g.openGroupChat(ctx().groupId,name);else await n.openCharacterChat(name);publishCurrent();return name;
    });}
    function commands(parser,utils={}) {
        const seen=new Set();for(const command of Object.values(parser.commands||{})){
            if(seen.has(command))continue;seen.add(command);const previous=command.callback;
            if(command.name==='go')command.callback=async(args,name)=>{
                await ready;const rows=n.characters,match=rows.find(c=>c.avatar===name)||utils.findChar?.({name,quiet:true})||rows.find(c=>c.name===name);
                if(match){await open(match.avatar);return match.name;}const group=ctx().groups.find(g=>utils.equalsIgnoreCaseAndAccents?utils.equalsIgnoreCaseAndAccents(g.name,name):g.name===name);
                if(group){await openGroup(group.id);return group.name;}return previous(args,name);
            };
            else if(command.name==='char-get')command.callback=async(args,...rest)=>{
                await ready;const card=args.char?(n.characters.find(c=>c.avatar===args.char)||utils.findChar?.({name:args.char,quiet:true})||n.characters.find(c=>c.name===args.char)):n.characters[n.this_chid];
                return card?prepared([card.avatar],()=>previous(args,...rest)):previous(args,...rest);
            };
            else if(command.name==='branch-create')command.callback=(args,text)=>lib.state?.managed?branch(Number(args.mesId??text??n.chat.length-1)):previous(args,text);
            else if(command.name==='checkpoint-create')command.callback=(args,text)=>lib.state?.managed?checkpoint(Number(args.mesId??n.chat.length-1),text):previous(args,text);
            else if(command.name==='checkpoint-go')command.callback=(args,text)=>{
                if(!lib.state?.managed)return previous(args,text);const mes=n.chat[Number(args.mesId??text??n.chat.length-1)];
                return mes?.extra?.bookmark_link?history(mes.extra.bookmark_link):'';
            };
            else if(command.name==='checkpoint-exit')command.callback=(args,text)=>lib.state?.managed&&ctx().chatMetadata?.main_chat?history(ctx().chatMetadata.main_chat):previous(args,text);
        }
    }
    return {open,openGroup,history,prepared,strictSave,publishCurrent,commands,hydrate,checkpoint,branch};
}
function safeJSON(value){try{return JSON.parse(value);}catch{return null;}}
function jsonResponse(response,value){const headers=new Headers(response.headers);headers.delete('Content-Length');headers.delete('Content-Encoding');return new Response(JSON.stringify(value),{status:response.status,headers});}
