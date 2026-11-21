export class Coordinator {
    constructor({navigator:nav=globalThis.navigator,storage=globalThis.localStorage,account=null}={}) {
        this.nav=nav;this.storage=storage;this.account=account;this.tail=Promise.resolve();
        this.client=globalThis.crypto?.randomUUID?.()||String(Date.now())+Math.random();
        this.scope='cl2:'+encodeURIComponent(account||'page')+':';this.occupancy={current:[],pending:[],saving:[]};
        this.base={current:[],pending:[],saving:[]};this.holds={current:new Map(),pending:new Map(),saving:new Map()};
        this.mode=nav?.locks?.request&&nav?.locks?.query&&storage&&account?'tabs':'page';
        if(this.mode==='tabs')try{storage.setItem(this.scope+'probe','1');storage.removeItem(this.scope+'probe');}
        catch{this.mode='page';}
        this.live=Promise.resolve();
        if(this.mode==='tabs'){
            this.live=new Promise(resolve=>{
                Promise.resolve().then(()=>this.nav.locks.request(this.scope+'live:'+this.client,()=>{resolve();return new Promise(done=>this.release=done);}))
                    .catch(()=>{this.mode='page';resolve();});
            });
        }
    }
    run(work) {
        const execute=async()=>{await this.live;return this.mode==='tabs'?this.nav.locks.request(this.scope+'mutation',work):work();};
        const next=this.tail.then(execute);this.tail=next.catch(()=>{});return next;
    }
    set(kind,avatars) {this.base[kind]=[...new Set(avatars)];this.refreshOccupancy(kind);}
    hold(kind,avatars){const token={};this.holds[kind].set(token,[...avatars]);this.refreshOccupancy(kind);
        return()=>{this.holds[kind].delete(token);this.refreshOccupancy(kind);};}
    refreshOccupancy(kind){this.occupancy[kind]=[...new Set([...this.base[kind],...[...this.holds[kind].values()].flat()])];this.publish();}
    publish() {if(this.mode==='tabs')try{this.storage.setItem(this.scope+'page:'+this.client,JSON.stringify(this.occupancy));}catch{this.mode='page';}}
    signal() {if(this.mode==='tabs')try{this.storage.setItem(this.scope+'revision',this.client+':'+String(this.revision=(this.revision||0)+1));}catch{this.mode='page';}}
    async protected({othersOnly=false}={}) {
        const result=new Set(othersOnly?[]:Object.values(this.occupancy).flat());
        if(this.mode!=='tabs')return result;
        await this.live;this.publish();let locks;
        try{locks=await this.nav.locks.query();}catch{this.mode='page';return result;}
        const alive=new Set(locks.held.map(x=>x.name));
        for(let i=0;i<this.storage.length;i++) {
            const key=this.storage.key(i);if(!key?.startsWith(this.scope+'page:'))continue;
            const id=key.slice((this.scope+'page:').length);if(othersOnly&&id===this.client)continue;
            if(!alive.has(this.scope+'live:'+id))continue;
            try{for(const avatar of Object.values(JSON.parse(this.storage.getItem(key))).flat())result.add(avatar);}catch{/* Ignore malformed foreign occupancy records. */}
        }
        return result;
    }
    close() {try{this.storage?.removeItem(this.scope+'page:'+this.client);}catch{}this.release?.();}
}
