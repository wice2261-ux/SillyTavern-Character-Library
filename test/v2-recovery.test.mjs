import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRecovery} from '../extension/recovery.js';
test('recovery lists all roles without reading bodies or mutating the directory',()=>{
    const directory={schemaVersion:2,records:{'A.png':{id:'a',avatar:'A.png',original:'a.png',current:'now.json',previous:null,operation:{pending:'now.json'}},
        'B.png':{id:'b',avatar:'B.png',current:'now.json',previous:'prev.json',operation:{pending:'pending.json'}}},garbage:['trash.json']};
    const saved=structuredClone(directory),out=buildRecovery(directory);
    assert.equal(out.format,'character-library-2-recovery');assert.deepEqual(directory,saved);
    assert.deepEqual(out.files,['a.png','now.json','prev.json','pending.json']);
    assert.deepEqual(out.fileDetails.find(x=>x.name==='now.json').references,[{id:'a',avatar:'A.png',role:'current'},{id:'a',avatar:'A.png',role:'operation.pending'},{id:'b',avatar:'B.png',role:'current'}]);
    assert.ok(!out.files.includes('trash.json'));assert.equal(out.directory,directory);
});
