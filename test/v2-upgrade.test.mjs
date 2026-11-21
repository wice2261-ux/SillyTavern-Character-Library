import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {exportMetadata} from '../tools/export-v1-metadata.mjs';
test('legacy metadata exports only active lightweight records, with unknown dates kept unknown',()=>{
    const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE cards(id TEXT,avatar TEXT,name TEXT,imported INTEGER,played INTEGER,favorite INTEGER,state TEXT);');
    db.prepare('INSERT INTO cards VALUES(?,?,?,?,?,?,?)').run('a','A.png','A',null,123,1,'resident');
    db.prepare('INSERT INTO cards VALUES(?,?,?,?,?,?,?)').run('b','B.png','B',456,0,0,'reserved');
    const data=exportMetadata(db,'test-user');assert.equal(data.format,'character-library-1-metadata');assert.equal(data.records.length,1);
    assert.equal(data.records[0].imported,null);assert.equal(data.records[0].favorite,true);assert.equal(data.account,'test-user');db.close();
});
