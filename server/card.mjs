import fs from 'node:fs';
import { crc32 } from 'node:zlib';

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const emptyAvatar = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPYs2XFfwAHYAMYLtd0uQAAAABJRU5ErkJggg==', 'base64');
const maxText = 64 * 1024 * 1024;

function read(fd, position, length) {
    const bytes = Buffer.allocUnsafe(length);
    let done = 0;
    while (done < length) {
        const count = fs.readSync(fd, bytes, done, length - done, position + done);
        if (!count) throw new Error('PNG 文件不完整');
        done += count;
    }
    return bytes;
}

function write(fd, bytes) {
    let offset = 0;
    while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
}

function* chunks(fd) {
    const size = fs.fstatSync(fd).size;
    if (!read(fd, 0, 8).equals(PNG)) throw new Error('无效的 PNG 文件签名');
    let hasImage = false;
    for (let offset = 8; offset + 12 <= size;) {
        const header = read(fd, offset, 8);
        const type = header.toString('latin1', 4);
        const length = header.readUInt32BE(0);
        if (offset === 8 && (type !== 'IHDR' || length !== 13)) throw new Error('无效的 PNG 图像头');
        if (length > size - offset - 12) throw new Error('PNG 数据块不完整');
        if (type === 'IDAT') hasImage = true;
        if (type === 'IEND' && (!hasImage || length !== 0)) throw new Error('缺少 PNG 图像数据');
        let key = null;
        if (type === 'tEXt') {
            const prefix = read(fd, offset + 8, Math.min(6, length));
            const end = prefix.indexOf(0);
            if (end > 0) {
                const keyword = prefix.toString('latin1', 0, end).toLowerCase();
                if (keyword === 'ccv3' || keyword === 'chara') key = keyword;
            }
        }
        yield { offset, type, length, key };
        offset += length + 12;
        if (type === 'IEND') return;
    }
    throw new Error('缺少 PNG 结束标记');
}

function json(buffer) {
    let card;
    try { card = JSON.parse(buffer.toString('utf8').replace(/^\uFEFF/, '')); }
    catch { throw new Error('角色卡 JSON 无法解析'); }
    if (typeof (card?.data?.name ?? card?.name) !== 'string' || !(card.data?.name ?? card.name).trim()) {
        throw new Error('角色卡缺少名称');
    }
    return card;
}

function decode(fd, chunk) {
    if (chunk.length > maxText) throw new Error('角色卡单个文本块超过 64 MiB');
    const bytes = read(fd, chunk.offset + 8, chunk.length);
    const storedCRC = read(fd, chunk.offset + 8 + chunk.length, 4).readUInt32BE(0);
    if (crc32(bytes, crc32('tEXt')) !== storedCRC) throw new Error('PNG 角色数据校验失败');
    const payload = Buffer.from(bytes.toString('latin1', chunk.key.length + 1), 'base64');
    return { card: json(payload), parsedBytes: payload.length };
}

function importDate(value) {
    if (typeof value !== 'string') return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
    if (!match) return null;
    const [, year, month, day, hour, minute, second] = match.map(Number);
    if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() || hour > 23 || minute > 59 || second > 59) return null;
    const time = Date.parse(value);
    return Number.isFinite(time) ? time : null;
}

function metadata(card, parsedBytes) {
    const data = card.data ?? card;
    const tags = Array.isArray(data.tags) ? data.tags : [];
    const fav = data.extensions?.fav ?? card.fav;
    return { name: data.name.slice(0, 512), tags: tags.filter(t => typeof t === 'string').slice(0, 128).map(t => t.slice(0, 256)),
        favorite: fav === true || fav === 'true', parsedBytes, imported: importDate(card.create_date) };
}

export function readCard(filename) {
    const fd = fs.openSync(filename, 'r');
    try {
        let chosen;
        for (const chunk of chunks(fd)) {
            if (chunk.key && (!chosen || (chunk.key === 'ccv3' && chosen.key !== 'ccv3'))) chosen = chunk;
        }
        if (!chosen) throw new Error('PNG 未包含 chara 或 ccv3 角色数据');
        return decode(fd, chosen);
    } finally { fs.closeSync(fd); }
}

export function readMeta(filename) {
    const { card, parsedBytes } = readCard(filename);
    return metadata(card, parsedBytes);
}

function encode(fd, key, card) {
    const text = Buffer.from(JSON.stringify(card)).toString('base64');
    const payload = Buffer.from(key + '\0' + text, 'latin1');
    if (payload.length > maxText) throw new Error('角色卡单个文本块超过 64 MiB');
    const header = Buffer.alloc(8);
    header.writeUInt32BE(payload.length);
    header.write('tEXt', 4);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(payload, crc32('tEXt')));
    write(fd, header); write(fd, payload); write(fd, checksum);
}

function change(card, favorite, importing, date, preserve) {
    card.fav = favorite;
    if (card.data) {
        card.data.extensions ??= {};
        card.data.extensions.fav = favorite;
    }
    if (importing) {
        // A distributed card must never select a chat from its source account.
        card.chat = 'Chat - ' + date.replace(/:/g, '-');
        delete card.json_data;
        card.create_date = date;
        const safeName = (card.data?.name ?? card.name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim();
        if (!safeName) throw new Error('角色卡缺少有效名称');
        card.name = safeName;
        if (card.data) card.data.name = safeName;
    }
    if (preserve) Object.assign(card, preserve);
    return card;
}

export function stageSprites(filename, callback, directories) {
    const { card, parsedBytes } = readCard(filename);
    const meta = metadata(card, parsedBytes);
    const risu = card.data?.extensions?.risuai;
    if (!risu?.additionalAssets?.length && !risu?.emotions?.length) return meta;
    if (!callback) throw new Error('Risu 立绘需要酒馆原生导入适配');
    callback(directories, card);
    // The 1.18.0 native importer logs errors and clears these fields on success.
    if (risu.additionalAssets?.length || risu.emotions?.length) throw new Error('酒馆未能导入内嵌立绘');
    return meta;
}

// Rewrite only character tEXt chunks. Transfer artwork in bounded blocks,
// including ancillary chunks from other tools, without decoding image pixels.
export function writeChanged(source, destination, { format = 'png', favorite = false, importing = false, preserve } = {}) {
    const out = fs.openSync(destination, 'wx', 0o600);
    const date = new Date().toISOString();
    try {
        if (format === 'json') {
            if (fs.statSync(source).size > maxText * 0.75) throw new Error('角色 JSON 超过 48 MiB');
            const card = change(json(fs.readFileSync(source)), favorite, importing, date, preserve);
            write(out, emptyAvatar.subarray(0, -12));
            encode(out, 'chara', card);
            if (card.spec === 'chara_card_v3') encode(out, 'ccv3', card);
            write(out, emptyAvatar.subarray(-12));
        } else {
            const fd = fs.openSync(source, 'r');
            try {
                write(out, PNG);
                let found = false;
                for (const chunk of chunks(fd)) {
                    if (chunk.key) {
                        const { card } = decode(fd, chunk);
                        encode(out, chunk.key, change(card, favorite, importing, date, preserve));
                        found = true;
                    } else {
                        const end = chunk.offset + chunk.length + 8;
                        write(out, read(fd, chunk.offset, 4));
                        let crc = 0;
                        for (let pos = chunk.offset + 4; pos < end; pos += 131072) {
                            const bytes = read(fd, pos, Math.min(131072, end - pos));
                            crc = crc32(bytes, crc);
                            write(out, bytes);
                        }
                        const checksum = read(fd, end, 4);
                        if (crc !== checksum.readUInt32BE(0)) throw new Error('PNG 图像数据校验失败');
                        write(out, checksum);
                    }
                }
                if (!found) throw new Error('PNG 未包含角色数据');
            } finally { fs.closeSync(fd); }
        }
        fs.fsyncSync(out);
    } finally { fs.closeSync(out); }
}
