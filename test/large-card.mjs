// Synthesize a dual-block PNG before starting the disposable VPS test server.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writeChanged } from '../server/card.mjs';
if (process.env.ST_LIBRARY_SMOKE !== 'isolated') throw Error('Requires an isolated test instance');
const chars = path.resolve(process.argv[2]);
fs.mkdirSync(chars, {recursive:true});
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'library-large-'));
const input = path.join(temp, 'large.json');
const output = path.join(chars, 'Library-Large-Probe.png');
const card = { spec:'chara_card_v3', spec_version:'3.0', name:'Library-Large-Probe',
    data:{name:'Library-Large-Probe',description:'',first_mes:'hello', extensions:{
        library_probe:'q'.repeat(Math.floor(14.4 * 1024 * 1024)) + 'END-LARGE-LIBRARY-PROBE' } } };
fs.writeFileSync(input,JSON.stringify(card));
writeChanged(input,output,{format:'json'});
console.log('dual_block_png_bytes=' + fs.statSync(output).size);
