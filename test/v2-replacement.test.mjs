import test from 'node:test';import assert from 'node:assert/strict';
import {parseReplacement,replacementForm} from '../extension/replacement.js';
const card={name:'New',data:{name:'New',description:'正文',extensions:{helper:{seed:1}}}};
test('replacement parses JSON before any target write and retains foreign fields',()=>{
    assert.deepEqual(parseReplacement(new TextEncoder().encode(JSON.stringify(card)),'json'),card);
    assert.throws(()=>parseReplacement(new TextEncoder().encode('{bad'),'json'));
});
test('PNG replacement form preserves greeting arrays and does not turn empty tags into a literal bracket tag',()=>{
    const form=replacementForm({tags:[],alternate_greetings:['A','B'],json_data:'{}'},new File(['png'],'card.png'));
    assert.equal(form.get('tags'),'');assert.deepEqual(form.getAll('alternate_greetings'),['A','B']);
    assert.equal(form.get('avatar').name,'card.png');
    const tagged=replacementForm({tags:['one,tag']},new File(['png'],'card.png'));
    assert.deepEqual(tagged.getAll('tags[]'),['one,tag']);
});
test('PNG replacement extracts UTF-8 card text and rejects truncated files',()=>{
    const data=Buffer.from('chara\0'+Buffer.from(JSON.stringify(card)).toString('base64'));
    const chunk=Buffer.alloc(12+data.length);chunk.writeUInt32BE(data.length);chunk.write('tEXt',4);data.copy(chunk,8);
    const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk]);
    assert.deepEqual(parseReplacement(png,'png'),card);assert.throws(()=>parseReplacement(png.subarray(0,png.length-8),'png'));
});
