import test from 'node:test';
import assert from 'node:assert/strict';
import { drawCards } from '../extension/draw.js';

test('draw samples across pages and returns only lightweight fields', () => {
    const rows = Array.from({length: 3003}, (_, i) => ({
        id:String(i), avatar:i+'.png', name:'角色 '+i, tags:i >= 3000 ? ['match'] : [],
        description:'full body', online:false
    }));
    const result = drawCards([...rows, rows.at(-1)], ' MATCH ', 12);
    assert.deepEqual(result.items.map(row => row.id), ['3000', '3001', '3002']);
    assert.equal(result.total, 3);
    assert.ok(result.items.every(row => !Object.hasOwn(row, 'description') && !row.online));
    assert.deepEqual(drawCards(rows, 'missing', 3), {items:[], total:0});
    assert.equal(drawCards(rows, '', undefined).items.length, 3);
    assert.ok(drawCards(rows, '', 1, () => 0).items.some(row => row.id === '3002'));
});
