const table = Uint32Array.from({ length: 256 }, (_, value) => {
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    return value;
});

export function crc32(...buffers) {
    let crc = 0xffffffff;
    for (const buffer of buffers) {
        for (const byte of buffer) crc = (crc >>> 8) ^ table[(crc ^ byte) & 255];
    }
    return (crc ^ 0xffffffff) >>> 0;
}

export function characterChunk(card) {
    const type = Buffer.from('tEXt');
    const payload = Buffer.from('chara\0' + Buffer.from(JSON.stringify(card)).toString('base64'));
    const chunk = Buffer.alloc(payload.length + 12);
    chunk.writeUInt32BE(payload.length);
    type.copy(chunk, 4);
    payload.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(type, payload), payload.length + 8);
    return chunk;
}
