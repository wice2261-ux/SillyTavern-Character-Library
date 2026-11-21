import { exactAvatar } from './lifecycle.js';
const encoder=new TextEncoder();
export function hostTime(response){const value=Date.parse(response.headers.get('Date'));return Number.isFinite(value)?value:null;}
export function base64(bytes) {
    let raw='';for(let i=0;i<bytes.length;i+=16384)raw+=String.fromCharCode(...bytes.subarray(i,i+16384));return btoa(raw);
}
export function editPayload(avatar,card) {
    exactAvatar(avatar);const c={...card};delete c.json_data;const d=c.data||c,e=d.extensions||{},depth=e.depth_prompt||{};
    return {...d,avatar_url:avatar,ch_name:d.name||c.name,json_data:JSON.stringify(c),chat:c.chat,create_date:c.create_date,
        extensions:JSON.stringify(e),fav:String(c.fav===true||c.fav==='true'||e.fav===true),
        talkativeness:e.talkativeness??c.talkativeness??0.5,world:e.world||'',
        depth_prompt_prompt:depth.prompt||'',depth_prompt_depth:depth.depth??4,depth_prompt_role:depth.role||'system'};
}
function canonical(value){return JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);}
export function savedData(payload,card){
    const data=JSON.parse(JSON.stringify(card.data||{})),e=JSON.parse(payload.extensions||'{}');
    data.name=payload.ch_name;
    for(const field of ['description','personality','scenario','first_mes','mes_example','creator_notes','system_prompt','post_history_instructions','creator','character_version'])data[field]=payload[field]||'';
    data.tags=typeof payload.tags==='string'?payload.tags.split(',').map(x=>x.trim()).filter(Boolean):payload.tags||[];
    data.alternate_greetings=Array.isArray(payload.alternate_greetings)?payload.alternate_greetings:typeof payload.alternate_greetings==='string'?[payload.alternate_greetings]:[];
    data.extensions={talkativeness:payload.talkativeness||0.5,fav:payload.fav==='true',world:payload.world||'',...e,
        depth_prompt:{prompt:payload.depth_prompt_prompt??'',depth:Number.isNaN(Number(payload.depth_prompt_depth))?4:Number(payload.depth_prompt_depth),role:payload.depth_prompt_role??'system',...e.depth_prompt}};
    return data;
}
function numericExtensions(data){
    const e=data.extensions;if(!e)return;
    if(Number.isFinite(Number(e.talkativeness)))e.talkativeness=Number(e.talkativeness);
    if(e.depth_prompt&&Number.isFinite(Number(e.depth_prompt.depth)))e.depth_prompt.depth=Number(e.depth_prompt.depth);
}
const nativeRoot=new Set(['data','avatar','json_data','data_size','chat_size','date_last_chat','date_added','create_date','chat','fav','name','description','personality','scenario','first_mes','mes_example','creatorcomment','talkativeness','tags','spec','spec_version']);
export class NativeStorage {
    constructor(network,headers) {this.network=network;this.headers=headers;this.now=()=>Date.now();this.id=()=>{
        const bytes=crypto.getRandomValues(new Uint8Array(16));return Array.from(bytes,x=>x.toString(16).padStart(2,'0')).join('');};}
    async post(route,body) {
        const response=await this.network('/api/'+route,{method:'POST',headers:this.headers(),body:JSON.stringify(body)});
        if(!response.ok)throw Object.assign(new Error(route+'：'+response.status+' '+(await response.text()).slice(0,250)),{status:response.status});
        return response;
    }
    url(name) {
        // Only this extension's account file names; no arbitrary URL/path access from manifest data.
        if(typeof name!=='string'||!/^[-\w.]+$/.test(name))throw Error('无效的角色库文件名');
        return '/user/files/'+encodeURIComponent(name);
    }
    async read(name) {
        if(!name)return null;
        const r=await this.network(this.url(name),{cache:'no-store'});if(r.status===404)return null;
        if(!r.ok)throw Error('读取角色库文件失败：'+r.status);return r.json();
    }
    async write(name,value) {
        this.url(name);const bytes=value instanceof Uint8Array?value:encoder.encode(JSON.stringify(value));
        const result=await(await this.post('files/upload',{name,data:base64(bytes)})).json();
        if(!result.path)throw Error('文件接口未返回存储位置');
        const r=await this.network(this.url(name),{cache:'no-store'});if(!r.ok)throw Error('归档读回失败：'+r.status);
        const actual=new Uint8Array(await r.arrayBuffer());
        if(actual.length!==bytes.length||actual.some((b,i)=>b!==bytes[i]))throw Error('归档读回核对失败；原卡未收回');return name;
    }
    async remove(name) {
        this.url(name);const response=await this.network('/api/files/delete',{method:'POST',headers:this.headers(),body:JSON.stringify({path:'files/'+name})});
        if(!response.ok&&response.status!==404)throw Error('清理版本失败：'+response.status);
    }
    async readWorldbook(name) {
        const book=await(await this.post('worldinfo/get',{name})).json();
        // Native /get returns the same empty dummy for a missing file and an empty user book.
        if(book&&Object.keys(book).length===1&&book.entries&&Object.keys(book.entries).length===0){
            const names=await(await this.post('worldinfo/list',{})).json();
            if(!names.some(item=>item.file_id===name))return null;
        }
        return book;
    }
    async writeWorldbook(name,data) {
        await this.post('worldinfo/edit',{name,data});
        const actual=await this.readWorldbook(name);
        if(JSON.stringify(actual)!==JSON.stringify(data))throw Error('世界书写入读回核对失败');
    }
    async card(avatar) {const c=await(await this.post('characters/get',{avatar_url:avatar})).json();if(!c||c.error||!c.data)throw Error('原生角色读取失败：'+avatar);delete c.json_data;return c;}
    async edit(avatar,card) {await this.post('characters/edit',editPayload(avatar,card));await this.verify(avatar,card);}
    async verify(avatar,card){
        // Native 1.18 /edit can return 200 even when writeCharacterData returned false.
        const actual=await this.card(avatar),payload=editPayload(avatar,card),expected=savedData(payload,card);
        // A linked native world is materialized by the host; its generated book is the native edit result.
        if(payload.world){if(actual.data.character_book)expected.character_book=actual.data.character_book;else delete expected.character_book;}
        // Multipart form fields are strings; these two native numeric fields have the same meaning after coercion.
        numericExtensions(expected);numericExtensions(actual.data);
        const foreignMismatch=Object.keys(card).some(key=>!nativeRoot.has(key)&&canonical(card[key])!==canonical(actual[key]));
        if(canonical(actual.data)!==canonical(expected)||foreignMismatch||actual.chat!==card.chat||actual.create_date!==card.create_date||
            Boolean(actual.fav)!==Boolean(card.fav===true||card.fav==='true'||card.data?.extensions?.fav===true)||
            actual.name!==payload.ch_name)throw Error('原生写入未生效；保留归档及操作阶段，请重试恢复');
    }
    async png(avatar) {const r=await this.network('/characters/'+encodeURIComponent(avatar),{cache:'no-store'});if(!r.ok)throw Error('原始PNG读取失败：'+r.status);return new Uint8Array(await r.arrayBuffer());}
    async size(avatar){const r=await this.network('/characters/'+encodeURIComponent(avatar),{method:'HEAD',cache:'no-store'});
        if(!r.ok)return (await this.png(avatar)).byteLength;const length=r.headers.get('Content-Length');
        return length!==null&&Number.isFinite(Number(length))?Number(length):(await this.png(avatar)).byteLength;}
    async list({fresh=false}={}) {if(this.listProvider&&!fresh)return this.listProvider();return (await this.post('characters/all',{})).json();}
}
