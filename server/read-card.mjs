import { open } from 'node:fs/promises';
import { crc32 } from './png-chunk.mjs';

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export async function readCard(filename) {
    const file = await open(filename, 'r');
    try {
        const {size} = await file.stat();
        async function read(length, position) {
            const buffer = Buffer.alloc(length);
            let offset = 0;
            while (offset < length) {
                const {bytesRead} = await file.read(buffer, offset, length - offset, position + offset);
                if (!bytesRead) throw new Error('PNG 文件截断');
                offset += bytesRead;
            }
            return buffer;
        }
        if (!(await read(8, 0)).equals(signature)) throw new Error('不是 PNG 文件');
        let legacy, modern, ended = false;
        for (let offset = 8; offset + 12 <= size;) {
            const header = await read(8, offset);
            const length = header.readUInt32BE(0);
            const type = header.toString('ascii', 4);
            if (offset + length + 12 > size) throw new Error('PNG 块截断');
            if (type === 'tEXt' && !modern && length) {
                const prefix = await read(Math.min(length, 80), offset + 8);
                const separator = prefix.indexOf(0);
                if (separator > 0) {
                    const key = prefix.toString('latin1', 0, separator).toLowerCase();
                    const loc = {length, offset:offset + 8, separator};
                    if (key === 'ccv3') modern = loc;
                    if (key === 'chara' && !legacy) legacy = loc;
                }
            }
            if (type === 'IEND') { ended = true; break; }
            offset += length + 12;
        }
        if (!ended) throw new Error('PNG 缺少 IEND');
        const selected = modern ?? legacy;
        if (!selected) throw new Error('PNG 缺少角色正文');
        const payload = await read(selected.length, selected.offset);
        const checksum = await read(4, selected.offset + selected.length);
        if (crc32(Buffer.from('tEXt'), payload) !== checksum.readUInt32BE()) throw new Error('角色文本块 CRC 不匹配');
        const encoded = payload.subarray(selected.separator + 1);
        if (encoded.includes(0)) throw new Error('PNG 文本含空字节');
        return JSON.parse(Buffer.from(encoded.toString('latin1'), 'base64').toString('utf8'));
    } finally {
        await file.close();
    }
}
