import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { backend } from './backend.mjs';
import { bookmarks, bulk, chats, extensions, groups, main, resume, slash, tags, utils, welcome, world } from './frontend.mjs';

const backupFolder = '.st-character-library-adapter-1.18.0';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const decoder = fs.readFileSync(new URL('./png-text-decode.cjs', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const rules = [
    ['public/script.js', ['606762e1e36805a12429708defcafac7287a3df78393813bf460c53524a27403'], main],
    ['public/scripts/group-chats.js', ['2c375d69263c29c99152da99a6fb80e5c3dd573ae28d0e0e5febdc8f23350441'], groups],
    ['public/scripts/RossAscends-mods.js', ['8265825f82cff2bae18d63e78576b1dd397e1c7f3d019fc57735e7830aeb930f'], resume],
    ['public/scripts/welcome-screen.js', ['68877b37728cd4a37938ff0026a4ff54aae99249ba0e74ff4dd3cc864029cdb9'], welcome],
    ['public/scripts/slash-commands.js', ['cbbf8aff280432af7e87085f10284dcb612941bf0f91ce49cd859bbb8dea69a8'], slash],
    ['public/scripts/tags.js', ['db5206a1cff693719fd9734101e8e152be851c9066872d97623b04563f3b7fc6'], tags],
    ['public/scripts/extensions.js', ['42437984d17b8f41dbfeb2ac4e907c89050890193e870a61d4c72b3a5a5a335c'], extensions],
    ['public/scripts/BulkEditOverlay.js', ['75e5974e53d92dadf2b21d49c94e9e208f795deeb3d0c001f6f5419b3b0b2129'], bulk],
    ['public/scripts/world-info.js', ['e273b778269866d32b04eb4b378b3480556818e608af549282f55b2e9c544d38'], world],
    ['public/scripts/bookmarks.js', ['7037bf9d47c16246445c897780bcfa4412b0e994057ec668407be4ca8acd77c3'], bookmarks],
    ['public/scripts/utils.js', ['7236069f0d6c95b0d959e3c574bc7acbd4dc088459371abf38a6a7a77a076067'], utils],
    ['src/endpoints/chats.js', ['5a7ba044c2ee5466c016146caa50369b24ffc76c189f0da5e99e61e62784214f'], chats],
    ['src/endpoints/characters.js', ['255751d3be5fe42faa993882514a3d3da9a19cb5e9c1b7e9883311d84f870b70', '5eda9abf82ef1c949e74b856e7dbb1dd2e53542676e2b0db9c6b5387f50058e2'], backend],
    ['node_modules/png-chunk-text/decode.js', ['cb258467c2b91d647b8e4c84da940b68e8e6c6de2cee16d966090c7d9f9da4e4', '7b50d4bff393e26c51c8fd9d5fba8ceef0445f1e5accb2fa396ebcc7c80009f4'], () => decoder],
];

function replacement(original, hashes, transform, name) {
    const text = original.toString('utf8');
    const normalized = text.replaceAll('\r\n', '\n');
    const known = hashes.includes(sha(normalized.trimEnd() + '\n'));
    if (!known && name.startsWith('node_modules/')) throw Error('Unrecognized dependency source: ' + name);
    const result = transform(normalized);
    if (normalized.trimEnd() === result.trimEnd()) return original;
    return Buffer.from(text.includes('\r\n') ? result.replaceAll('\n', '\r\n') : result);
}

// Each original is saved before the first replacement. A partial apply/revert
// can be continued in either direction; an unrelated edit always stops it.
export function install(action, directory) {
    if (!['check', 'apply', 'revert'].includes(action) || !directory) throw Error('Usage: node install.mjs check|apply|revert SILLYTAVERN_ROOT');
    const root = fs.realpathSync(directory);
    JSON.parse(fs.readFileSync(path.join(root, 'package.json'))); // Source structure, not version text, determines compatibility.
    const backup = path.join(root, backupFolder);
    const exists = fs.existsSync(backup);
    if (exists && !fs.lstatSync(backup).isDirectory()) throw Error('Invalid rollback directory');
    if (!exists && action === 'revert') throw Error('No local rollback copy');

    const entries = rules.map(([name, hashes, transform]) => {
        const target = path.join(root, name);
        const stat = fs.lstatSync(target);
        if (!stat.isFile()) throw Error('Expected regular file: ' + name);
        const current = fs.readFileSync(target);
        const original = exists ? fs.readFileSync(path.join(backup, name)) : current;
        const patched = replacement(original, hashes, transform, name);
        if (!current.equals(original) && !current.equals(patched)) throw Error('Target changed since installation: ' + name);
        return { name, target, current, original, patched, mode: stat.mode };
    });
    if (action === 'check') {
        const changed = entries.filter(x => !x.original.equals(x.patched));
        return changed.every(x => x.current.equals(x.patched)) ? 'applied' :
            changed.every(x => x.current.equals(x.original)) ? 'ready' : 'partial';
    }
    if (!exists) {
        const staging = fs.mkdtempSync(path.join(root, backupFolder + '-'));
        try {
            for (const { name, original } of entries) {
                const saved = path.join(staging, name);
                fs.mkdirSync(path.dirname(saved), { recursive: true });
                fs.writeFileSync(saved, original, { flag: 'wx' });
            }
            fs.renameSync(staging, backup);
        } finally {
            if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true });
        }
    }
    for (const { name, target, current, original, patched, mode } of entries) {
        const bytes = action === 'apply' ? patched : original;
        if (current.equals(bytes)) continue;
        if (!fs.readFileSync(target).equals(current)) throw Error('Concurrent modification: ' + name);
        const stage = target + '.' + randomUUID() + '.st-library';
        try {
            fs.writeFileSync(stage, bytes, { flag: 'wx', mode });
            fs.renameSync(stage, target);
        } finally {
            if (fs.existsSync(stage)) fs.unlinkSync(stage);
        }
    }
    return action === 'apply' ? 'applied' : 'reverted';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { console.log(install(process.argv[2], process.argv[3])); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
}
