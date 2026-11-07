import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const help = '用法：node recover.mjs [账户数据根目录] [--apply]\n' +
    '默认在当前目录预览。应用前请停止酒馆；恢复后先禁用角色库并撤销适配，再启动酒馆。\n' +
    '本工具仅处理 PNG 文件，保留 SQLite 和聊天记录。同名冲突时保留两份并返回退出码 2。';

function sameFile(a, b) {
    return a.isFile() && b?.isFile() && a.ino !== 0n && a.ino === b.ino && a.dev === b.dev;
}

/** Recover physical cards without loading the plugin, native dependencies, or its index. */
export function recover(root, apply = false, report = () => {}) {
    root = fs.realpathSync(root);
    const base = path.join(root, 'character-library');
    const hot = path.join(root, 'characters');
    const cold = path.join(base, 'cards');
    for (const dir of [hot, base, cold]) {
        if (!fs.lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
            throw new Error('缺少普通目录：' + dir + '。请指定单个酒馆账户的数据根目录');
        }
    }
    if (fs.statSync(hot).dev !== fs.statSync(cold).dev) throw new Error('两处目录必须在同一文件系统上');
    const result = { pending: 0, restored: 0, conflicts: 0 };
    const entries = fs.readdirSync(cold, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.name.toLowerCase().endsWith('.png')) continue;
        const source = path.join(cold, entry.name);
        const dest = path.join(hot, entry.name);
        try {
            if (!entry.isFile()) throw new Error('归库侧不是普通文件');
            const before = fs.lstatSync(source, { bigint: true });
            if (!before.isFile()) throw new Error('归库侧不是普通文件');
            const target = fs.lstatSync(dest, { bigint: true, throwIfNoEntry: false });
            if (target && !sameFile(before, target)) throw new Error('酒馆侧已存在不同的同名文件');
            if (!apply) {
                result.pending++;
                report('可恢复', entry.name);
                continue;
            }
            if (!target) fs.linkSync(source, dest);
            if (!sameFile(before, fs.lstatSync(source, { bigint: true })) || !sameFile(before, fs.lstatSync(dest, { bigint: true }))) {
                throw new Error('恢复过程中目标身份发生变化，请检查两处文件');
            }
            fs.unlinkSync(source);
            result.restored++;
            report('已恢复', entry.name);
        } catch (error) {
            result.conflicts++;
            report('保留待处理', entry.name, error.message);
        }
    }
    return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    const args = process.argv.slice(2);
    const positional = args.filter(arg => !arg.startsWith('--'));
    try {
        if (args.includes('--help')) console.log(help);
        else {
            if (positional.length > 1 || args.some(arg => arg.startsWith('--') && arg !== '--apply')) throw new Error(help);
            const apply = args.includes('--apply');
            const res = recover(positional[0] ?? process.cwd(), apply, (...line) => console.log(...line));
            console.log((apply ? '执行' : '预览') + '：' + JSON.stringify(res));
            if (res.conflicts) process.exitCode = 2;
        }
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
