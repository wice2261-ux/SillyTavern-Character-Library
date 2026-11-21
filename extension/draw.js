export function drawCards(rows, search, count, random = Math.random) {
    const query = String(search ?? '').trim().toLocaleLowerCase();
    const limit = Math.min(12, Math.max(1, Math.trunc(Number(count)) || 3));
    const seen = new Set();
    const items = [];
    for (const row of rows) {
        if (seen.has(row.id)) continue;
        const tags = row.tags ?? [];
        if (![row.name, row.avatar, ...tags].join(' ').toLocaleLowerCase().includes(query)) continue;
        seen.add(row.id);
        const item = { id: row.id, avatar: row.avatar, name: row.name, tags, favorite: row.favorite,
            online: row.online, size: row.size, imported: row.imported };
        if (items.length < limit) items.push(item);
        else {
            const index = Math.floor(random() * seen.size);
            if (index < limit) items[index] = item;
        }
    }
    return { items, total: seen.size };
}
