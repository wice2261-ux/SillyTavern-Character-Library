import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { backend } from '../adapter/backend.mjs';

// Run against the untouched 1.18.0 endpoint used by the adapter installer.
const originalFile = process.env.ST_LIBRARY_NATIVE_CHARACTERS;
const skip = !originalFile && 'Set ST_LIBRARY_NATIVE_CHARACTERS to the original 1.18.0 characters.js';
function fixture(hook) {
    const original = fs.readFileSync(originalFile, 'utf8').replaceAll('\r\n', '\n');
    const source = backend(original);
    const routes = new Map();
    const root = fs.mkdtempSync(path.join(process.env.CHARLIB_TEST_ROOT, 'backend-'));
    const dirs = { root, characters: path.join(root, 'characters'), chats: path.join(root, 'chats') };
    fs.mkdirSync(dirs.characters); fs.mkdirSync(dirs.chats);
    const context = vm.createContext({
        fs, path, Buffer, process, console: { info() {}, warn() {}, error() {}, log() {} },
        express: { Router: () => ({ post: (route, ...args) => routes.set(route, args.at(-1)) }) },
        MemoryLimitedMap: class extends Map { constructor() { super(); } }, getConfigValue: (_key, fallback) => fallback,
        getFileNameValidationFunction: () => () => {}, validateAvatarUrlMiddleware() {}, cacheBuster() {},
        _: { get: (obj, key, fallback) => key.split('.').reduce((value, part) => value?.[part], obj) ?? fallback },
        sanitize: value => value, invalidateThumbnail() {},
    });
    context[Symbol.for('st.character-library')] = hook;
    vm.runInContext(source.replace(/^import .*;\n/gm, '').replace(/^export /gm, '') +
        '\ndiskCache.instance = async () => ({removeItem: async () => {}}); this.probe = { toShallow, processCharacter, libraryRoute, memoryCache };', context);
    const request = () => ({ body: {}, user: { directories: dirs }, path: '/import' });
    const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; },
        send(body) { this.body = body; return this; }, sendStatus(code) { this.statusCode = code; return this; } });
    const upload = req => {
        const file = path.join(root, 'upload'); fs.writeFileSync(file, 'original upload');
        req.file = { destination: root, filename: 'upload', path: file };
        return file;
    };
    return { source, context, routes, dirs, request, response, upload };
}

test('native shallow notes are bounded without truncating the full object', { skip }, () => {
    const { context } = fixture();
    const notes = '说明'.repeat(8192);
    const character = { name: 'A', data: { creator_notes: notes } };
    const shallow = context.probe.toShallow(character);
    assert.equal(shallow.data.creator_notes.length, 512);
    assert.equal(character.data.creator_notes, notes);
});

test('native request wrapper releases this upload on identity rejection and handler failure', { skip }, async () => {
    const f = fixture({ runNative() { throw Object.assign(new Error('stale identity'), { status: 409 }); } });
    const req = f.request(), res = f.response(), file = f.upload(req);
    await f.context.probe.libraryRoute(() => assert.fail('must reject before handler'))(req, res, assert.fail);
    assert.equal(res.statusCode, 409);
    assert.equal(fs.existsSync(file), false);
    delete f.context[Symbol.for('st.character-library')];
    const req2 = f.request(), file2 = f.upload(req2);
    let error;
    await f.context.probe.libraryRoute(() => { throw new Error('invalid upload'); })(req2, f.response(), e => { error = e; });
    assert.equal(error.message, 'invalid upload');
    assert.equal(fs.existsSync(file2), false);
});

test('only a server-validated replacement may overwrite the preserved avatar', { skip }, async () => {
    const hook = {
        managed: () => true, assertWritableName() {}, reserved: () => false,
        async runNative(req, work) { if (req.body.library_replace_avatar) req.libraryReplacement = true; return work(); },
    };
    const f = fixture(hook);
    const avatar = path.join(f.dirs.characters, 'Alice.png'); fs.writeFileSync(avatar, 'old card');
    f.context.probe.memoryCache.set(avatar + '-old-stamp', 'old full body');
    vm.runInContext("readCharacterData = async () => '{\"name\":\"Alice\",\"chat\":\"Original\"}'; importFromJson = async (_file, {request}, name) => { fs.writeFileSync(path.join(request.user.directories.characters, name + '.png'), 'new card'); return name; };", f.context);
    const req = f.request(), res = f.response(); f.upload(req);
    req.body = { file_type: 'json', preserved_name: 'Alice.png', library_replace_avatar: 'Alice.png' };
    await f.routes.get('/import')(req, res, assert.fail);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.file_name, 'Alice');
    assert.equal(fs.readFileSync(avatar, 'utf8'), 'new card');
    assert.equal(f.context.probe.memoryCache.has(avatar + '-old-stamp'), false, 'replacement releases the previous full card cache');
    const req2 = f.request(), res2 = f.response(); f.upload(req2);
    req2.body = { file_type: 'json', preserved_name: 'Alice.png' };
    await f.routes.get('/import')(req2, res2, assert.fail);
    assert.equal(res2.statusCode, 409);
    hook.managed = () => false;
    const req3 = f.request(), res3 = f.response(); f.upload(req3);
    req3.body = { file_type: 'json', preserved_name: 'Alice.png' };
    await f.routes.get('/import')(req3, res3, assert.fail);
    assert.equal(res3.statusCode, 409, 'leaving management must not turn an implicit import into a replacement');
});

test('batch merge returns exactly its successful targets to the native wrapper', { skip }, async () => {
    const f = fixture({ runNative: (_req, work) => work() });
    f.context._.isPlainObject = value => Boolean(value && typeof value === 'object');
    f.context.forbiddenRegExp = /[\\/]/;
    vm.runInContext("mergeCharacterUpdate = async (_path, avatar) => avatar === 'Good.png' ? {ok:true} : {skipped:true};", f.context);
    const req = f.request(), res = f.response(); req.path = '/merge-attributes';
    req.body = { avatars: ['Good.png', 'Skip.png'], data: { name: 'updated' } };
    await f.routes.get('/merge-attributes')(req, res, assert.fail);
    assert.deepEqual(Array.from(res.body.updated), ['Good.png']);
    assert.deepEqual(Array.from(req.libraryUpdatedAvatars ?? []), ['Good.png']);
});

test('a failed native write is not reported as a successful merge', { skip }, async () => {
    const f = fixture();
    Object.assign(f.context._, { cloneDeep: value => structuredClone(value), unset: (value, key) => delete value[key], isPlainObject: () => false });
    Object.assign(f.context, { deepMerge: (target, update) => Object.assign(target, update), TavernCardValidator: class { validate() { return true; } } });
    vm.runInContext("readCharacterData = async () => '{\"name\":\"Old\"}'; writeCharacterData = async () => false; this.mergeProbe = mergeCharacterUpdate;", f.context);
    const result = await f.context.mergeProbe('unused', 'Alice.png', { name: 'New' }, f.request());
    assert.equal(result.ok, false);
});

test('validated replacement preserves execution-time chat in the common write without a frontend repair', {skip},async()=>{
    const f=fixture({async runNative(req,work){req.libraryReplacement=true;return work();}});
    fs.writeFileSync(path.join(f.dirs.characters,'Alice.png'),'old file');
    f.context.originalChat='Latest-history';
    f.context.writeFileAtomicSync=(file,data)=>fs.writeFileSync(file,data);
    f.context.write=(_image,data)=>Buffer.from(data);
    f.context.humanizedDateTime=()=> 'now';
    vm.runInContext(`readCharacterData=async()=>JSON.stringify({name:'Alice',chat:originalChat,create_date:'2010-01-01T00:00:00Z'});
        parseImageBuffer=async()=>Buffer.from('image');
        importFromJson=async(_file,{request},name)=>{const ok=await writeCharacterData(Buffer.from('image'),JSON.stringify({name:'Updated',chat:'Foreign-history',create_date:'2030-01-01T00:00:00Z'}),name,request);return ok?name:'';};`,f.context);
    const req=f.request(),res=f.response();f.upload(req);
    req.body={file_type:'json',preserved_name:'Alice.png',library_replace_avatar:'Alice.png'};
    await f.routes.get('/import')(req,res,assert.fail);
    assert.equal(res.statusCode,200);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.dirs.characters,'Alice.png'),'utf8')).chat,'Latest-history');
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.dirs.characters,'Alice.png'),'utf8')).create_date,'2010-01-01T00:00:00Z','unindexed replacement retains historical date without requiring an index');
});

test('original read failure stops replacement before the format handler and cleans the upload', {skip},async()=>{
    const f=fixture({async runNative(req,work){req.libraryReplacement=true;return work();}});
    const avatar=path.join(f.dirs.characters,'Alice.png');fs.writeFileSync(avatar,'unchanged');
    let imported=0;f.context.importSpy=()=>imported++;
    vm.runInContext("readCharacterData=async()=>undefined;importFromJson=async()=>{importSpy();return 'Alice';};",f.context);
    const req=f.request(),res=f.response(),upload=f.upload(req);
    req.body={file_type:'json',preserved_name:'Alice.png',library_replace_avatar:'Alice.png'};
    let error;await f.routes.get('/import')(req,res,e=>{error=e;});
    assert.ok(res.statusCode>=400||error);assert.equal(imported,0);assert.equal(fs.readFileSync(avatar,'utf8'),'unchanged');assert.equal(fs.existsSync(upload),false);
});
