const TITLE='角色库资料（自动生成）';
export function managementKey(row){return row?JSON.stringify([row.id,row.avatar,row.name,row.tags,row.favorite]):null;}
export function withNativeTags(rows,{tags=[],tagMap={}}={}){
    const names=new Map(tags.map(tag=>[String(tag.id),tag.name]));
    return rows.map(row=>({...row,tags:[...new Set([...(row.tags||[]),...(tagMap[row.avatar]||[]).map(id=>names.get(String(id))).filter(Boolean)])]}));
}
export function tagSignature(rows,context){return JSON.stringify(withNativeTags(rows,context)
    .map(row=>[row.avatar,row.tags]).sort((a,b)=>a[0].localeCompare(b[0])));}
const date=value=>Number.isFinite(value)?new Date(value).toISOString():'未知';
export function buildWorldbook(records,{owner,generatedAt}) {
    const entries={};
    [...records].sort((a,b)=>a.id.localeCompare(b.id)).forEach((row,uid)=>{
        entries[uid]={uid,key:[],keysecondary:[],comment:row.name||row.avatar,
            content:['ID：'+row.id,'文件：'+row.avatar,'名称：'+(row.name||''),'标签：'+(row.tags||[]).join('、'),
                '收藏：'+(row.favorite?'是':'否'),row.imported==null?'导入时间未知':'导入酒馆时间：'+date(row.imported),
                '最近游玩时间：'+date(row.played)].join('\n'),
            disable:true,constant:false,vectorized:false,selective:true,selectiveLogic:0,order:100,position:0,
            addMemo:true,excludeRecursion:true,preventRecursion:true,probability:100,useProbability:true,depth:4};
    });
    return {entries,extensions:{character_library:{version:1,owner,generatedAt,
        note:'此为角色库资料快照，不是恢复原件。生成条目的手动修改会在更新时被覆盖。'}}};
}
export class Worldbook {
    constructor({io,snapshot,getPreferences,savePreferences,now=()=>Date.now(),onStatus=()=>{}}){
        Object.assign(this,{io,snapshot,getPreferences,savePreferences,now,onStatus});
        this.revision=0;this.completed=0;this.flight=null;this.error=null;this.checked=false;this.started=false;
    }
    status(){const p=this.getPreferences();return {autoUpdate:p.autoUpdate===true,name:p.name,lastSuccessAt:p.lastSuccessAt,
        pending:this.revision!==this.completed,updating:Boolean(this.flight),checked:this.checked,error:this.error};}
    async start(){if(this.started)return this.flight;this.started=true;
        if(this.getPreferences().autoUpdate){this.markChanged();await this.flush();}}
    markChanged(){this.revision++;this.onStatus(this.status());}
    async setAutoUpdate(value){this.savePreferences({...this.getPreferences(),autoUpdate:Boolean(value)});this.onStatus(this.status());
        if(value){this.markChanged();await this.updateNow();}}
    async flush(){if(this.getPreferences().autoUpdate&&this.revision!==this.completed)try{await this.updateNow();}catch{/* Optional copy failure is shown in its own status. */}}
    updateNow(){
        if(this.flight)return this.flight;
        const revision=this.revision;this.error=null;let succeeded=false;
        this.flight=Promise.resolve().then(()=>this.update(revision)).then(()=>{succeeded=true;}).catch(error=>{
            this.error=error.message;if(this.revision===this.completed)this.revision++;throw error;
        }).finally(()=>{this.flight=null;this.onStatus(this.status());
            if(succeeded&&this.getPreferences().autoUpdate&&this.revision!==this.completed)void this.flush();});
        this.onStatus(this.status());return this.flight;
    }
    async update(revision){
        let p=this.getPreferences();
        if(!p.owner){this.savePreferences({...p,owner:this.io.id()});p=this.getPreferences();}
        let name=p.name,previous;
        if(name){previous=await this.io.readWorldbook(name);
            if(previous&&previous.extensions?.character_library?.owner!==p.owner)throw Error('世界书归属不符，请保留原书并检查角色库设置');
        }else{
            name=TITLE;let suffix=0;
            while((previous=await this.io.readWorldbook(name))!==null){
                if(previous.extensions?.character_library?.owner===p.owner)break;
                name=TITLE+' '+(++suffix);
            }
        }
        const book=buildWorldbook(await this.snapshot(),{owner:p.owner,generatedAt:this.now()});
        if(!previous||JSON.stringify(previous.entries)!==JSON.stringify(book.entries))await this.io.writeWorldbook(name,book);
        this.savePreferences({...this.getPreferences(),name,lastSuccessAt:this.now()});this.completed=revision;this.checked=true;
    }
}
