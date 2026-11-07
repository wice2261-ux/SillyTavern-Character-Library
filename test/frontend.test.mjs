import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import test from 'node:test';
const adapters = await import(process.env.ST_LIBRARY_FRONTEND_ADAPTER || '../adapter/frontend.mjs');

const root = process.env.ST_LIBRARY_UPSTREAM;
const parse = root && createRequire(path.join(root, 'package.json'))('acorn').parse;
function source(file, transform) {
    const saved = path.join(root, '.st-character-library-adapter-1.18.0', file);
    const text = fs.readFileSync(fs.existsSync(saved) ? saved : path.join(root, file), 'utf8').replaceAll('\r\n', '\n');
    return transform ? transform(text) : text;
}
function functions(text, names, context) {
    const ast = parse(text, { ecmaVersion:'latest', sourceType:'module' });
    const declarations = ast.body.map(n => n.declaration ?? n).filter(n => names.includes(n.id?.name));
    const sandbox = vm.createContext(context);
    vm.runInContext(declarations.map(n => text.slice(n.start, n.end)).join('\n'), sandbox);
    return sandbox;
}
function nestedFunction(text, name, context) {
    let found;
    const visit = node => {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'FunctionDeclaration' && node.id?.name === name) found = node;
        else for (const value of Object.values(node)) {
            if (Array.isArray(value)) value.forEach(visit);
            else if (value?.type) visit(value);
        }
    };
    visit(parse(text,{ecmaVersion:'latest',sourceType:'module'}));
    assert.ok(found,name);
    const sandbox=vm.createContext(context);
    vm.runInContext(text.slice(found.start,found.end),sandbox);
    return sandbox;
}
const conflict = () => Object.assign(Error('stale identity'), {code:'CHARACTER_LIBRARY_CONFLICT'});

for (const failure of ['network', 'http500', 'conflict', 'integrity']) test('strict history save stops on ' + failure, {skip:!root}, async () => {
    let clears=0, loads=0, notices=0, reloads=0;
    const c=functions(source('public/script.js',adapters.main),['saveChat','saveChatConditional','openCharacterChat','throwLibraryConflict','libraryConflict'],{
        selected_group:null,libraryChatIdentity:{avatar:'A.png',id:'a'},characters:[{avatar:'A.png',name:'A',chat:'Original'}],this_chid:0,
        chat_metadata:{},chat:[{mes:'UNSAVED'}],name2:'A',neutralCharacterName:'neutral',isChatSaving:false,
        compressRequest:async r=>r,getRequestHeaders:()=>({}),fetch:async()=>{
            if(failure==='network')throw Error('offline');
            return new Response(JSON.stringify(failure==='conflict'?{code:'CHARACTER_LIBRARY_CONFLICT',message:'stale'}:failure==='integrity'?{error:'integrity'}:{}),{status:failure==='conflict'?409:500});
        },toastr:{error:()=>notices++},console:{error(){},warn(){}},t:s=>s[0],
        waitUntilCondition:async()=>{},DEFAULT_SAVE_EDIT_TIMEOUT:1,cancelDebouncedChatSave(){},saveTokenCache(){},saveItemizedPrompts(){},getCurrentChatId:()=> 'Original',
        debounce_timeout:{extended:1},clearChat:async()=>clears++,getChat:async()=>loads++,$:()=>({val(){}}),createOrEditCharacter:async()=>{},CustomEvent:class{},
        Popup:{show:{input:async()=>''}},window:{location:{reload:()=>reloads++}},
    });
    await assert.rejects(c.openCharacterChat('Other'));
    assert.equal(clears,0);assert.equal(loads,0);assert.equal(c.chat[0].mes,'UNSAVED');assert.equal(c.isChatSaving,false);assert.equal(notices,0);assert.equal(reloads,0);
});

test('strict conditional timeout retains the other save owner', {skip:!root},async()=>{
    let saves=0;
    const c=functions(source('public/script.js',adapters.main),['saveChatConditional'],{
        isChatSaving:true,DEFAULT_SAVE_EDIT_TIMEOUT:1,waitUntilCondition:async()=>{throw Error('timeout');},console:{warn(){}},saveChat:async()=>saves++,
    });
    await assert.rejects(c.saveChatConditional({throwOnError:true}));assert.equal(c.isChatSaving,true);assert.equal(saves,0);
});

test('replacement pre-save is strict and stops before import on ordinary failure', {skip:!root},async()=>{
    const text=source('public/script.js',adapters.main);
    const begin=text.indexOf("case 'replace_update': {");
    const end=text.indexOf('                let onlineUrl',begin);
    let imported=0,notices=0,strict;
    const c=vm.createContext({characters:[{avatar:'A.png',chat:'Original'}],this_chid:0,chat_metadata:{},libraryIdentity:()=>({id:'a'}),
        saveChatConditional:async options=>{strict=options?.throwOnError;if(strict)throw Object.assign(Error('offline'),{librarySaveFailed:true});},
        reportLibrarySaveConflict:()=>notices++,importCard:()=>imported++,
    });
    await vm.runInContext("(async()=>{switch('replace_update'){"+text.slice(begin,end)+"importCard();break;}}})()",c);
    assert.equal(strict,true);assert.equal(imported,0);assert.equal(notices,1);
});
test('native save rejects identity conflicts through conditional save and releases saving state', {skip:!root}, async () => {
    let warnings = 0;
    const c = functions(source('public/script.js', adapters.main), ['saveChat','saveChatConditional','showLibraryConflict','throwLibraryConflict','libraryConflict'], {
        selected_group:null, libraryChatIdentity:{avatar:'A.png',id:'old'}, characters:[{avatar:'A.png',name:'A',chat:'Session'}], this_chid:0,
        chat_metadata:{}, chat:[{mes:'unsaved'}], name2:'A', neutralCharacterName:'neutral',
        compressRequest:async r => r, getRequestHeaders:() => ({}), fetch:async () => new Response(JSON.stringify({code:'CHARACTER_LIBRARY_CONFLICT',message:'stale'}), {status:409}),
        toastr:{error:()=>warnings++,warning:()=>warnings++}, console, t:s=>s[0],
        isChatSaving:false, waitUntilCondition:async()=>{}, DEFAULT_SAVE_EDIT_TIMEOUT:1,cancelDebouncedChatSave:()=>{},
    });
    await assert.rejects(c.saveChatConditional(), e => e.code === 'CHARACTER_LIBRARY_CONFLICT');
    assert.equal(c.isChatSaving, false);
    assert.equal(c.chat[0].mes, 'unsaved');
    assert.equal(warnings, 0, 'lower save layers must not duplicate operation notifications');
});
for (const kind of ['conflict','ordinary']) test('checkpoint link is restored when the second save fails: '+kind, {skip:!root}, async () => {
    let successes=0, warnings=0, flags=0;
    const c = functions(source('public/scripts/bookmarks.js', adapters.bookmarks), ['createNewBookmark','reportLibrarySaveConflict'], {
        this_chid:0, selected_group:null, characters:[{chat:'Original'}], chat:[{mes:'unsaved',extra:{bookmark_link:'previous'}}],
        getBookmarkName:async()=> 'checkpoint', saveItemizedPrompts:async()=>{}, saveChat:async()=>{}, saveChatConditional:async()=>{throw kind==='conflict'?conflict():Object.assign(Error('offline'),{librarySaveFailed:true});},
        toastr:{success:()=>successes++,warning:()=>warnings++}, reportLibrarySaveConflict:()=>warnings++, $:()=>({}), updateBookmarkDisplay:()=>flags++,
    });
    await c.createNewBookmark(0);
    assert.equal(c.chat[0].extra.bookmark_link, 'previous');
    assert.equal(flags,0); assert.equal(successes,0); assert.equal(warnings,1);
});

test('branch second-save ordinary failure removes only the newly appended name', {skip:!root},async()=>{
    let notices=0;
    const c=functions(source('public/scripts/bookmarks.js',adapters.bookmarks),['branchChat'],{
        this_chid:0,selected_group:null,chat:[{extra:{branches:['Existing']}}],
        createBranch:async()=>{c.chat[0].extra.branches.push('New');return 'New';},saveItemizedPrompts:async()=>{},
        openCharacterChat:async()=>{throw Object.assign(Error('offline'),{librarySaveFailed:true});},reportLibrarySaveConflict:()=>notices++,
    });
    assert.equal(await c.branchChat(0),null);assert.deepEqual(Array.from(c.chat[0].extra.branches),['Existing']);assert.equal(notices,1);
});
test('URL replacement passes its original binding and returns the real import result', {skip:!root}, async () => {
    const binding={avatar:'A.png',id:'id-a',chat:'Original'};
    let passed;
    const c = functions(source('public/scripts/utils.js', adapters.utils), ['importFromExternalUrl'], {
        isValidUrl:()=>true, console, getRequestHeaders:()=>({}),
        fetch:async()=>new Response('card', {headers:{'X-Custom-Content-Type':'character','Content-Disposition':'attachment; filename="card.png"','Content-Type':'image/png'}}),
        File, processDroppedFiles:async (files,data,replacement) => { passed=replacement; return []; },
        toastr:{info:()=>{},warning:()=>{}},
    });
    const result = await c.importFromExternalUrl('https://example.invalid/card', {preserveFileName:'A.png',libraryReplacement:binding});
    assert.equal(passed,binding);
    assert.equal(result.length,0, 'failed import must remain false at the replacement caller');
});
test('unshallow rejects a failed full fetch instead of exposing an editable preview', {skip:!root}, async () => {
    const c = functions(source('public/script.js', adapters.main), ['unshallowCharacter'], {
        characters:[{avatar:'A.png',shallow:true,data:{creator_notes:'preview'}}], getOneCharacter:async()=>{}, console,
    });
    await assert.rejects(c.unshallowCharacter(0), /全文/);
});
test('fresh group greeting resolves exact avatar before a colliding display name', {skip:!root}, async () => {
    const c = functions(source('public/scripts/group-chats.js',adapters.groups), ['getGroupChat'], {
        groups:[{id:'group',members:['Alice.png'],chat_id:'group-chat'}],
        characters:[{avatar:'Bob.png',name:'Alice.png'},{avatar:'Alice.png',name:'Alice'}],
        window:{STCharacterLibraryManaged:true}, validateGroup:async()=>{}, unshallowGroupMembers:async()=>{},
        loadGroupChat:async()=>[], uuidv4:()=> 'integrity', loadItemizedPrompts:async()=>{}, getCurrentChatId:()=> 'group-chat',
        chat:[], chatElement:{find:()=>({remove(){}})}, getFirstCharacterMessage:async card=>({mes:card.avatar}),
        eventSource:{emit:async()=>{}}, event_types:{}, addOneMessage:()=>{}, saveGroupChat:async()=>{}, updateChatMetadata:()=>{},
    });
    await c.getGroupChat('group',false,true);
    assert.equal(c.chat[0].mes,'Alice.png');
});
test('file import uses explicit replacement identity and ordinary import clears default identity', {skip:!root}, async () => {
    let options, request, warnings=0;
    const binding={avatar:'A.png',id:'id-a',chat:'Original'};
    const c = functions(source('public/script.js',adapters.main),['importCharacter','showLibraryConflict'],{
        is_group_generating:false,is_send_press:false,characters:[{avatar:'A.png'}],name1:'user',FormData,
        $:()=>({val:()=>{}}), getRequestHeaders:o=>{options=o; return {};},
        fetch:async (url,req)=>{request=req;return new Response(JSON.stringify({code:'CHARACTER_LIBRARY_CONFLICT',message:'stale'}),{status:409});},
        toastr:{warning:()=>warnings++,error:()=>assert.fail('duplicate notification')},console,t:s=>s[0],
    });
    const card = new File(['{}'],'card.json',{type:'application/json'});
    assert.equal(await c.importCharacter(card),undefined);
    assert.equal(options.libraryIdentity,null);
    assert.equal(request.body.has('library_replace_avatar'),false);
    assert.equal(await c.importCharacter(card,{preserveFileName:'A.png',libraryReplacement:binding}),undefined);
    assert.equal(options.libraryIdentity,binding);
    assert.equal(request.body.get('library_replace_avatar'),'A.png');
    assert.equal(warnings,2);
});
test('opening a branch cannot clear chat after source save conflict', {skip:!root},async()=>{
    let cleared=0;
    const c = functions(source('public/script.js',adapters.main),['openCharacterChat'],{
        saveChatConditional:async()=>{throw conflict();},waitUntilCondition:async()=>{},isChatSaving:false,
        debounce_timeout:{extended:1},clearChat:()=>cleared++,characters:[{avatar:'A.png',chat:'Original'}],this_chid:0,chat_metadata:{},
        getChat:async()=>{},$:()=>({val:()=>{}}),createOrEditCharacter:async()=>{},CustomEvent:class {},
    });
    await assert.rejects(c.openCharacterChat('branch'),e=>e.code==='CHARACTER_LIBRARY_CONFLICT');
    assert.equal(cleared,0);assert.equal(c.characters[0].chat,'Original');
});
test('history and bookmark clicks report save conflicts once and release their loader', {skip:!root},async()=>{
    let handler, notices=0, hidden=0, closed=0;
    const document={};
    const element={};
    const jq=value=> value===document ? {on:(event,selector,callback)=>{if(selector==='.select_chat_block, .mes_bookmark') handler=callback;}} :
        value===element ? {closest:()=>({length:0,attr:()=> 'History'}),hasClass:()=>false,attr:()=> 'History'} :
        {on(){},css:()=>closed++};
    const c=functions(source('public/scripts/bookmarks.js',adapters.bookmarks),['initBookmarks'],{
        $,document,selected_group:null,saveBookmarkMenu(){},backToMainChat(){},convertSoloToGroupChat(){},registerBookmarksSlashCommands(){},
        openCharacterChat:async()=>{throw conflict();},reportLibrarySaveConflict:e=>{assert.equal(e.code,'CHARACTER_LIBRARY_CONFLICT');notices++;},
        loader:{ToastMode:{STATIC:0},show:()=>({hide:async()=>hidden++})},t:s=>s[0],
    });
    function $(value){return jq(value);}
    c.initBookmarks();
    await handler.call(element,{shiftKey:false});
    assert.equal(notices,1);assert.equal(hidden,1);assert.equal(closed,0);
});
test('back to main chat reports a save conflict and returns no destination', {skip:!root},async()=>{
    let notices=0;
    const c=functions(source('public/scripts/bookmarks.js',adapters.bookmarks),['backToMainChat'],{
        getMainChatName:()=> 'Main',getExistingChatNames:async()=>['Main'],selected_group:null,
        openCharacterChat:async()=>{throw conflict();},reportLibrarySaveConflict:()=>notices++,
    });
    assert.equal(await c.backToMainChat(),null);assert.equal(notices,1);
});
test('missing native history directory permits a first branch but stale identity still fails at save', {skip:!root},async()=>{
    let stale=false,notices=0,saved=0;
    const c=functions(source('public/scripts/bookmarks.js',adapters.bookmarks),['getExistingChatNames','createBranch'],{
        selected_group:null,this_chid:0,characters:[{avatar:'New.png'}],chat:[{mes:'unsaved',extra:{}}],
        getRequestHeaders:()=>({}),fetch:async()=>new Response(JSON.stringify({error:true}),{status:200}),
        getCurrentChatDetails:()=>({sessionName:'Original'}),
        getUniqueName:(name,taken,{nameBuilder})=>nameBuilder(name,1),getBranchChatSnapshot:()=>[{mes:'unsaved'}],
        saveChat:async()=>{if(stale)throw conflict();saved++;},reportLibrarySaveConflict:()=>notices++,console,
    });
    assert.equal((await c.getExistingChatNames()).length,0);
    const name=await c.createBranch(0);
    assert.equal(name,'Original - Branch #1');assert.equal(saved,1);assert.equal(c.chat[0].extra.branches[0],name);
    stale=true;c.chat[0].extra={};
    assert.equal(await c.createBranch(0),null);assert.equal(saved,1);assert.equal(notices,1);
    assert.equal(c.chat[0].extra.branches,undefined);
});
test('replacement preserves edits made during upload by saving the captured original chat first', {skip:!root},async()=>{
    const metadata={};let saved,opened;
    const c=nestedFunction(source('public/script.js',adapters.main),'postReplace',{
        characters:[{avatar:'A.png',chat:'ImportGenerated'}],this_chid:0,chat_metadata:metadata,replacementChatMetadata:metadata,
        libraryReplacement:{avatar:'A.png'},currentChatFile:'Original',chat:[{mes:'edited during upload'}],
        saveChat:async options=>{saved={...options,messages:c.chat.map(m=>m.mes)};},getOneCharacter:async()=>{},
        openCharacterChat:async(name,options)=>{opened={name,options};},
    });
    await c.postReplace();
    assert.equal(saved?.chatName,'Original');assert.equal(saved?.throwOnError,true);
    assert.deepEqual(saved?.messages,['edited during upload']);
    assert.equal(opened.name,'Original');assert.equal(opened.options.saveCurrent,false);
});
test('replacement save failure retains the page and reports the partial result', {skip:!root},async()=>{
    const metadata={};let opened=0,notice='';
    const c=nestedFunction(source('public/script.js',adapters.main),'postReplace',{
        characters:[{avatar:'A.png'}],this_chid:0,chat_metadata:metadata,replacementChatMetadata:metadata,
        libraryReplacement:{avatar:'A.png'},currentChatFile:'Original',saveChat:async()=>{throw Error('offline');},
        getOneCharacter:async()=>{},openCharacterChat:async()=>opened++,toastr:{warning:msg=>notice=msg},
    });
    await c.postReplace();assert.equal(opened,0);assert.match(notice,/卡.*更新.*聊天.*保存/);
});
test('replacement save opts into network failure propagation without a duplicate toast', {skip:!root},async()=>{
    let notices=0;
    const c=functions(source('public/script.js',adapters.main),['saveChat'],{
        selected_group:null,libraryChatIdentity:{avatar:'A.png',id:'a'},characters:[{avatar:'A.png',name:'A',chat:'Generated'}],this_chid:0,
        chat_metadata:{},chat:[{mes:'edited during upload'}],name2:'A',neutralCharacterName:'neutral',
        getRequestHeaders:()=>({}),compressRequest:async r=>r,fetch:async()=>{throw Error('offline');},
        toastr:{error:()=>notices++},console:{error(){}},t:s=>s[0],
    });
    await assert.rejects(c.saveChat({chatName:'Original',throwOnError:true}),/offline/);
    assert.equal(notices,0);
    await c.saveChat({chatName:'Original'});
    assert.equal(notices,1,'ordinary native calls preserve their existing error notification');
});
test('replacement never opens A history in B after a switch during the full read', {skip:!root},async()=>{
    const metadata={};let opened=0;
    const c=nestedFunction(source('public/script.js',adapters.main),'postReplace',{
        characters:[{avatar:'A.png'},{avatar:'B.png'}],this_chid:0,chat_metadata:metadata,replacementChatMetadata:metadata,
        libraryReplacement:{avatar:'A.png'},currentChatFile:'Original',saveChat:async()=>{},
        getOneCharacter:async()=>{c.this_chid=1;c.chat_metadata={};},openCharacterChat:async()=>opened++,
    });
    await c.postReplace();assert.equal(opened,0);
});

test('replacement leaves a different history of the same card selected', {skip:!root},async()=>{
    let calls=0;
    const c=nestedFunction(source('public/script.js',adapters.main),'postReplace',{
        characters:[{avatar:'A.png',chat:'New-history'}],this_chid:0,chat_metadata:{},replacementChatMetadata:{},
        libraryReplacement:{avatar:'A.png'},currentChatFile:'Old-history',
        saveChat:async()=>calls++,getOneCharacter:async()=>calls++,openCharacterChat:async()=>calls++,
    });
    await c.postReplace();assert.equal(calls,0);assert.equal(c.characters[0].chat,'New-history');
});
test('openCharacterChat rejects a target switch while waiting before clearing or writing', {skip:!root},async()=>{
    let cleared=0;
    const c=functions(source('public/script.js',adapters.main),['openCharacterChat','libraryConflict'],{
        characters:[{avatar:'A.png',chat:'Original'},{avatar:'B.png',chat:'B-history'}],this_chid:0,chat_metadata:{},
        waitUntilCondition:async()=>{c.this_chid=1;c.chat_metadata={};},debounce_timeout:{extended:1},
        clearChat:async()=>cleared++,getChat:async()=>{},$:()=>({val(){}}),createOrEditCharacter:async()=>{},CustomEvent:class{},
    });
    await assert.rejects(c.openCharacterChat('A-history',{saveCurrent:false}),e=>e.code==='CHARACTER_LIBRARY_CONFLICT');
    assert.equal(cleared,0);assert.equal(c.characters[1].chat,'B-history');
});
test('all frontend transforms generate valid modules', {skip:!root}, () => {
    const targets = {main:'public/script.js',groups:'public/scripts/group-chats.js',slash:'public/scripts/slash-commands.js',bulk:'public/scripts/BulkEditOverlay.js',bookmarks:'public/scripts/bookmarks.js',utils:'public/scripts/utils.js'};
    for(const [name,file] of Object.entries(targets)) {
        assert.equal(typeof adapters[name], 'function', name);
        parse(source(file,adapters[name]),{ecmaVersion:'latest',sourceType:'module'});
    }
});
