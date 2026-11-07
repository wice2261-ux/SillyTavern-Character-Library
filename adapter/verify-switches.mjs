// Exercises the installed native entry points without requiring a model or a live chat.
// Run after "apply" on a disposable 1.18.0 copy: node verify-switches.mjs ST_ROOT
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = process.argv[2];
if (!root) throw Error('Pass a patched test installation');
const source = file => fs.readFileSync(path.join(root, file), 'utf8').replaceAll('\r\n', '\n');
const groupSource = source('public/scripts/group-chats.js');
const main = source('public/script.js');
const resume = source('public/scripts/RossAscends-mods.js');
function functionFrom(text, name) {
    const start = text.indexOf('async function ' + name + '(');
    assert.ok(start >= 0, name);
    const end = text.indexOf('\n}', start);
    assert.ok(end > start);
    return text.slice(start, end + 2);
}
const trace = [];
const group = { id: 'g', members: ['One.png', 'Two.png'], chats: ['old', 'next'], chat_id: 'old' };
const context = vm.createContext({
    window: { STCharacterLibraryManaged: true },
    characters: [{ name: 'One', avatar: 'One.png' }],
    active_character: 'Two.png', groups: [group], selected_group: null,
    isChatSaving: false, is_send_press: false, is_group_generating: false,
    debounce_timeout: { extended: 0 }, waitUntilCondition: async () => {},
    select_group_chats: () => trace.push('select'), clearChat: () => trace.push('clear'),
    updateChatMetadata: () => {}, editGroup: () => trace.push('edit'),
    getGroupChat: (...args) => { trace.push(args); },
    setActiveCharacter: () => trace.push('reset saved character'),
    prepareLibraryCharacters: async () => { throw Error('budget'); },
});
for (const name of ['prepareLibraryGroup', 'openGroupById', 'createNewGroupChat', 'openGroupChat']) {
    vm.runInContext(functionFrom(groupSource, name), context);
}
vm.runInContext(functionFrom(main, 'selectCharacterById'), context);
vm.runInContext(functionFrom(resume, 'RA_autoloadchat'), context);
context.this_chid = '1';
for (const command of ["openGroupById('g')", "openGroupChat('g','next')", "createNewGroupChat('g')", "selectCharacterById(0)", "RA_autoloadchat()"]) {
    await assert.rejects(vm.runInContext(command, context), /budget/);
    assert.deepEqual(trace, []);
    assert.equal(group.chat_id, 'old');
    assert.deepEqual(group.members, ['One.png', 'Two.png']);
}
context.prepareLibraryCharacters = async avatars => {
    assert.deepEqual(Array.from(avatars), ['One.png', 'Two.png']);
    trace.push('prepare');
    context.characters.push({ name: 'Two', avatar: 'Two.png' });
    return avatars;
};
await vm.runInContext("openGroupChat('g','next')", context);
assert.deepEqual(trace, ['prepare', 'clear', 'edit', ['g', false, true]]);
assert.equal(group.chat_id, 'next');
assert.deepEqual(group.members, ['One.png', 'Two.png']);
console.log('Native preparation failure preserved chat/member state; group history opened after preparation.');
