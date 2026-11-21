import { access, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { Vault, avatarName } from '../server/vault.mjs';

const [action, root, ...flags] = process.argv.slice(2);
const allowed = ['legacy','takeover','restore','basic'];
if (!root || !allowed.includes(action) || flags.some(flag => flag !== '--apply')) {
    console.error('用法: node tools/handoff.mjs <legacy|takeover|restore|basic> <已停服账户目录> [--apply]');
    process.exitCode = 1;
} else {
    try { await run(); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
}

async function exists(filename) {
    try { await access(filename); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function run() {
    const account = path.resolve(root);
    const vault = new Vault({root:account,files:path.join(account,'user','files'),characters:path.join(account,'characters')});
    const apply = flags.includes('--apply');
    if (action === 'restore' || action === 'basic') {
        const state = await vault.load();
        console.log(JSON.stringify(await vault.release(state,action,apply)));
        return;
    }
    const state = await vault.load();
    if(action==='takeover'&&state.mode==='released'){
        state.mode='staging';
        state.records={};
    }
    const base = await readFile(path.join(vault.dirs.files,'character-library-v2.json'),'utf8').then(JSON.parse).catch(error=>{
        if (error.code === 'ENOENT') return null;
        throw error;
    });
    const inputs = new Map();
    for (const avatar of await vault.enumerate()) inputs.set(avatar,{source:path.join(vault.dirs.characters,avatar)});
    if (action === 'legacy') {
        const {DatabaseSync} = await import('node:sqlite');
        const db = new DatabaseSync(path.join(account,'character-library','index.sqlite'),{readOnly:true});
        try {
            const indexed = new Set();
            state.reserved ??= [];
            for (const row of db.prepare('SELECT * FROM cards').iterate()) {
                const avatar = avatarName(row.avatar);
                indexed.add(avatar);
                const cold = path.join(account,'character-library','cards',avatar);
                const hasCold = await exists(cold);
                if (row.state === 'reserved') {
                    if (hasCold || inputs.has(avatar) || row.intent) throw new Error('旧库保留文件名存在冲突：'+avatar);
                    if (!state.reserved.includes(avatar)) state.reserved.push(avatar);
                    continue;
                }
                if (state.mode === 'staging' && state.records[avatar]?.current) continue;
                if (row.intent || (hasCold && inputs.has(avatar)) || (!hasCold && !inputs.has(avatar))) {
                    throw new Error('旧库位置或意图冲突：'+avatar);
                }
                inputs.set(avatar,{source:hasCold ? cold : inputs.get(avatar).source,metadata:{...row,favorite:Boolean(row.favorite)}});
            }
            const coldDir = path.join(account,'character-library','cards');
            if (await exists(coldDir)) {
                for (const avatar of await readdir(coldDir)) {
                    if (avatar.endsWith('.png') && !indexed.has(avatar)) throw new Error('归库 PNG 缺少旧索引：'+avatar);
                }
            }
        } finally { db.close(); }
    } else {
        for (const row of Object.values(base?.records ?? {})) {
            const avatar = avatarName(row.avatar);
            if (row.operation) throw new Error('请先处理未完成操作：'+avatar);
            const input = inputs.get(avatar);
            if (!input) throw new Error('缺少角色 PNG：'+avatar);
            input.metadata = row;
            if (!row.online) {
                if (!/^cl2-[\w-]+\.json$/.test(row.current)) throw new Error('归档引用无效：'+avatar);
                input.version = path.join(vault.dirs.files,row.current);
            }
        }
    }
    const folded = new Set();
    let sourceBytes=0;
    for (const [avatar,input] of inputs) {
        const key = avatar.toLowerCase();
        if (folded.has(key)) throw new Error('存在大小写冲突，需先处理：'+avatar);
        folded.add(key);
        sourceBytes+=(await stat(input.source)).size;
        if(input.version)sourceBytes+=(await stat(input.version)).size;
    }
    console.log(JSON.stringify({action,apply,characters:inputs.size,sourceBytes,estimatedExtraBytes:sourceBytes*2}));
    if (!apply) return;
    if (state.mode !== 'staging') throw new Error('账户已有增强接管记录');
    for (const [avatar,input] of inputs) {
        const card = input.version && !state.records[avatar]?.current ? JSON.parse(await readFile(input.version,'utf8')) : undefined;
        await vault.stage(state,avatar,input.source,input.metadata,card);
    }
    for (const row of Object.values(state.records)) if (row.operation === 'installing') await vault.install(state,row);
    state.mode = 'enhanced';
    await vault.commit(state);
}
