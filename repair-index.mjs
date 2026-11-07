import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { inspectAliases } from './server/store.mjs';

const help = '用法：node repair-index.mjs 账户根目录 --avatar 实际文件名 [--keep-id 保留的旧ID] [--apply]\n' +
    '默认只预览。应用前停止酒馆；只修复一个实际 PNG 对应两个索引 ID 的情况，不修改 PNG 或聊天。';
const conflict = message => Object.assign(new Error(message), { status:409 });

export function repairIndex(root, { avatar, keepId, apply = false } = {}) {
    root = fs.realpathSync(root);
    if (apply && !keepId) throw new Error('应用必须明确指定 --keep-id');
    const base = path.join(root, 'character-library');
    const index = path.join(base, 'index.sqlite');
    if (!fs.lstatSync(index).isFile()) throw new Error('索引不是普通文件');
    const db = new DatabaseSync(index, { readOnly:!apply });
    let transaction = false;
    try {
        if (apply) { db.exec('BEGIN IMMEDIATE'); transaction = true; }
        const {files, rows} = inspectAliases({root, characters:path.join(root,'characters')}, db, avatar);
        if (files.length !== 1 || !files[0].regular || files[0].avatar !== avatar || rows.length !== 2 ||
            rows.some(row => row.intent || row.state !== files[0].state)) {
            throw conflict('不是一个实际文件对应两个无未完成操作的索引，请保留现状并检查文件与索引');
        }
        if (keepId && !rows.some(row => row.id === keepId)) throw conflict('--keep-id 必须是这两条记录中的旧 ID');
        const result = {avatar, state:files[0].state, rows, keepId:keepId ?? null, applied:false};
        if (!apply) return result;
        const backup = path.join(base, 'index-repair-' + Date.now() + '-' + randomUUID() + '.json');
        fs.writeFileSync(backup, JSON.stringify(result, null, 2) + '\n', {flag:'wx',mode:0o600});
        for (const row of rows) if (row.id !== keepId) db.prepare('DELETE FROM cards WHERE id=?').run(row.id);
        db.prepare('UPDATE cards SET avatar=? WHERE id=?').run(avatar,keepId);
        db.exec('COMMIT'); transaction = false;
        return {...result, applied:true, backup};
    } finally {
        if (transaction) db.exec('ROLLBACK');
        db.close();
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    try {
        const args = process.argv.slice(2);
        if (args.length === 1 && args[0] === '--help') console.log(help);
        else {
            const root = args.shift();
            if (!root || root.startsWith('--')) throw new Error(help);
            const options = {};
            for (let i = 0; i < args.length; i++) {
                if (args[i] === '--apply' && !options.apply) options.apply = true;
                else if (['--avatar','--keep-id'].includes(args[i]) && args[i+1] && !args[i+1].startsWith('--')) {
                    const key = args[i] === '--avatar' ? 'avatar' : 'keepId';
                    if (options[key]) throw new Error(help);
                    options[key] = args[++i];
                } else throw new Error(help);
            }
            if (!options.avatar) throw new Error(help);
            console.log(JSON.stringify(repairIndex(root,options),null,2));
        }
    } catch (error) {
        console.error(error.message);
        process.exitCode = error.status === 409 ? 2 : 1;
    }
}
