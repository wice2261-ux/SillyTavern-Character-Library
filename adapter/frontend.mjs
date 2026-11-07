function edit(source, anchor, replacement) {
    if (source.split(anchor).length !== 2) throw Error('Missing or ambiguous anchor: ' + anchor);
    return source.replace(anchor, () => replacement);
}

const importPrepare = "import { prepareLibraryCharacters } from '../script.js';\n";

function bindNativeWrites(source) {
    source = edit(source, 'export async function saveChatConditional() {',
        'export async function saveChatConditional({ throwOnError = false } = {}) {');
    source = edit(source, "        console.warn('Timeout waiting for chat to save');\n        return;",
        "        if (throwOnError) throw Object.assign(Error('等待聊天保存超时，请稍后重试。'), { librarySaveFailed: true });\n        console.warn('Timeout waiting for chat to save');\n        return;");
    source = edit(source, '            await saveChat();\n        }\n\n        // Save token',
        '            await saveChat({ throwOnError });\n        }\n\n        // Save token');
    source = edit(source, 'export async function saveChat({ chatName, withMetadata, mesId, force = false, chatData = undefined } = {}) {',
        'export async function saveChat({ chatName, withMetadata, mesId, force = false, chatData = undefined, throwOnError = false } = {}) {');
    const headers = 'export function getRequestHeaders({ omitContentType = false } = {}) {';
    source = edit(source, headers, `let libraryChatIdentity;
let libraryFormIdentity;
const libraryIdentity = card => window.STCharacterLibrary?.identity(card) ?? null;

export function getRequestHeaders({ omitContentType = false, libraryIdentity: binding = libraryChatIdentity } = {}) {`);
    source = edit(source, "    if (omitContentType) {", `    if (binding?.id) {
        headers['X-ST-Library-Id'] = binding.id;
    }
    if (window.STCharacterLibrary) {
        headers['X-ST-Library-Client'] = window.STCharacterLibrary.client;
    }
    if (omitContentType) {`);
    const opening = 'export async function getChat() {\n    try {\n        await unshallowCharacter(this_chid);';
    source = edit(source, opening, opening + '\n        libraryChatIdentity = libraryIdentity(characters[this_chid]);');
    const form = 'export function select_selected_character(chid, { switchMenu = true } = {}) {';
    source = edit(source, form, form + "\n    if (characters[chid]?.shallow) throw Error('角色全文尚未载入，请重新打开角色。');\n    libraryFormIdentity = libraryIdentity(characters[chid]);");
    const formData = "    formData.set('fav', String(fav_ch_checked));";
    source = edit(source, formData, "    const editIdentity = libraryFormIdentity;\n" + formData);
    const createHeaders = "    const headers = getRequestHeaders({ omitContentType: true });\n\n    if ($('#form_create')";
    source = edit(source, createHeaders, createHeaders.replace('omitContentType: true', 'omitContentType: true, libraryIdentity: editIdentity'));
    const failedEdit = "            if (!fetchResult.ok) {\n                throw new Error('Fetch result is not ok');\n            }\n\n            await getOneCharacter";
    source = edit(source, failedEdit, failedEdit.replace('if (!fetchResult.ok)', 'if (await showLibraryConflict(fetchResult)) return;\n            if (!fetchResult.ok)'));
    const failedCreate = "            if (!fetchResult.ok) {\n                throw new Error('Fetch result is not ok');\n            }\n\n            const avatarId";
    source = edit(source, failedCreate, failedCreate.replace('if (!fetchResult.ok)', 'if (await showLibraryConflict(fetchResult)) return;\n            if (!fetchResult.ok)'));
    const importError = "        if (!result.ok) {\n            throw new Error(`Failed to import character: ${result.statusText}`);";
    source = edit(source, importError, '        if (await showLibraryConflict(result)) return;\n' + importError);
    const oldAvatar = '    const oldAvatar = characters[this_chid].avatar;';
    source = edit(source, oldAvatar, oldAvatar + '\n    const renameIdentity = libraryFormIdentity;');
    source = requestHeadersFor(source, '/api/characters/rename', 'renameIdentity');
    source = edit(source, "    try {\n        if (response.ok) {\n            const data = await response.json();\n            const newAvatar = data.avatar;",
        "    if (await showLibraryConflict(response)) return false;\n    try {\n        if (response.ok) {\n            const data = await response.json();\n            const newAvatar = data.avatar;");
    source = edit(source, 'await renamePastChats(oldAvatar, newAvatar, newValue);',
        'await renamePastChats(oldAvatar, newAvatar, newValue, renameIdentity && { ...renameIdentity, avatar: newAvatar });');
    source = edit(source, 'async function renamePastChats(oldAvatar, newAvatar, newName)', 'async function renamePastChats(oldAvatar, newAvatar, newName, identity)');
    source = edit(source, "                const saveChatRequest = await compressRequest({\n                    method: 'POST',\n                    headers: getRequestHeaders(),", 
        "                const saveChatRequest = await compressRequest({\n                    method: 'POST',\n                    headers: getRequestHeaders({ libraryIdentity: identity }),");
    const chatConflict = '        const errorData = await result.json();\n        const isIntegrityError';
    source = edit(source, chatConflict, '        await throwLibraryConflict(result);\n' + chatConflict);
    source = edit(source, '        const forceSaveConfirmed = popupResult === \'OVERWRITE\';',
        "        if (savingIdentity && (libraryChatIdentity?.id !== savingIdentity.id || libraryChatIdentity.avatar !== savingIdentity.avatar)) {\n            throw libraryConflict('聊天已切换，请重新打开原角色再保存。');\n        }\n        const forceSaveConfirmed = popupResult === 'OVERWRITE';");
    source = edit(source, '        if (!forceSaveConfirmed) {',
        "        if (!forceSaveConfirmed) {\n            if (throwOnError) throw Error('聊天完整性校验未通过，未确认覆盖，已保留当前聊天。');");
    source = edit(source, '            t`<p>After you click OK, the page will be reloaded to prevent data corruption.</p>',
        '            throwOnError ? t`<p>聊天尚未保存。关闭此提示会保留当前聊天并停止后续操作。确认覆盖请输入 <code>OVERWRITE</code>；覆盖可能丢失服务器上的数据。</p>` : t`<p>After you click OK, the page will be reloaded to prevent data corruption.</p>');
    source = edit(source, '    const metadata = { ...chat_metadata, ...(withMetadata || {}) };', `    if (libraryChatIdentity && characters[this_chid]?.avatar !== libraryChatIdentity.avatar) {
        throw libraryConflict('当前聊天的角色已变更，请重新打开角色。');
    }
    const savingIdentity = libraryChatIdentity;
    const metadata = { ...chat_metadata, ...(withMetadata || {}) };`);
    source = edit(source, "    } catch (error) {\n        console.error(error);\n        toastr.error(t`Check the server connection", "    } catch (error) {\n        if (throwOnError) throw Object.assign(error, { librarySaveFailed: true });\n        if (error.code === 'CHARACTER_LIBRARY_CONFLICT') throw error;\n        console.error(error);\n        toastr.error(t`Check the server connection");
    source = edit(source, "    } catch (error) {\n        console.error('Error saving chat', error);", "    } catch (error) {\n        if (throwOnError) throw Object.assign(error, { librarySaveFailed: true });\n        if (error.code === 'CHARACTER_LIBRARY_CONFLICT') throw error;\n        console.error('Error saving chat', error);");
    source = edit(source, "        await saveChatConditional();\n        console.debug('Chat saved');", "        try {\n            await saveChatConditional();\n            console.debug('Chat saved');\n        } catch (error) { reportLibrarySaveConflict(error); }");
    source = edit(source, 'await saveChat({ chatName, withMetadata, mesId, force: true });', 'await saveChat({ chatName, withMetadata, mesId, force: true, chatData, throwOnError });');
    source = edit(source, '    await getOneCharacter(avatar);\n}\n\nexport async function getChat()',
        "    await getOneCharacter(avatar);\n    const loaded = characters.find(card => card.avatar === avatar);\n    if (!loaded?.data || loaded.shallow) throw Error('角色全文未能载入，请重试。');\n}\n\nexport async function getChat()");
    source = edit(source, '    } catch (error) {\n        await getChatResult();\n        console.log(error);',
        "    } catch (error) {\n        if (characters[this_chid]?.shallow || error.code === 'CHARACTER_LIBRARY_CONFLICT') throw error;\n        await getChatResult();\n        console.log(error);");
    source = requestHeadersFor(source, '/api/characters/merge-attributes', 'libraryIdentity(character)');
    const confirm = '    // Show confirmation unless silent';
    source = edit(source, confirm, '    const duplicateIdentity = libraryIdentity(characters.find(c => c.avatar === targetAvatar));\n' + confirm);
    source = requestHeadersFor(source, '/api/characters/duplicate', 'duplicateIdentity');
    const beforeClose = '    const inTempChat = this_chid === undefined && name2 === neutralCharacterName;\n    if (inTempChat)';
    source = edit(source, beforeClose, '    const deletionTargets = characterKey.map(key => characters.find(x => x.avatar === key));\n' + beforeClose);
    source = edit(source, '    for (const key of characterKey) {\n        const character = characters.find(x => x.avatar == key);',
        '    for (const [index, key] of characterKey.entries()) {\n        const character = deletionTargets[index];');
    source = edit(source, '        const chid = characters.indexOf(character);\n        const pastChats = await getPastCharacterChats(chid);',
        '        const chid = characters.findIndex(card => card.avatar === character.avatar);\n        const pastChats = deleteChats ? await getPastCharacterChats(chid) : [];');
    source = requestHeadersFor(source, '/api/characters/delete', 'libraryIdentity(character)');
    const start = source.indexOf('        accountStorage.removeItem(`AlertWI_');
    const end = source.indexOf('        deleted = true;', start);
    if (start < 0 || end < 0) throw Error('Missing native deletion cleanup');
    let cleanup = source.slice(start, end).replace(/^    /gm, '');
    cleanup = edit(cleanup, "    select_rm_info('char_delete', character.name);\n", '');
    cleanup = edit(cleanup, "    if (deleteChats) {\n        for (const chat of pastChats) {\n            const name = chat.file_name.replace('.jsonl', '');\n            await eventSource.emit(event_types.CHAT_DELETED, name);\n        }\n    }",
        "    for (const filename of pastChats) await eventSource.emit(event_types.CHAT_DELETED, filename.replace(/\\.jsonl$/, ''));");
    source = source.slice(0, start) + "        select_rm_info('char_delete', character.name);\n        await afterLibraryCharacterDeleted(character, chid, deleteChats ? pastChats.map(chat => chat.file_name) : []);\n" + source.slice(end);
    return source + `
export async function afterLibraryCharacterDeleted(character, chid, pastChats) {
${cleanup}    saveSettingsDebounced();
}

async function showLibraryConflict(response) {
    if (response.status !== 409) return false;
    const data = await response.clone().json().catch(() => null);
    if (data?.code !== 'CHARACTER_LIBRARY_CONFLICT') return false;
    toastr.warning(data.message || data.error, '角色库');
    return true;
}

function libraryConflict(message) {
    return Object.assign(new Error(message), { code: 'CHARACTER_LIBRARY_CONFLICT' });
}

async function throwLibraryConflict(response) {
    if (response.status !== 409) return;
    const data = await response.clone().json().catch(() => null);
    if (data?.code === 'CHARACTER_LIBRARY_CONFLICT') throw libraryConflict(data.message || data.error);
}

export function reportLibrarySaveConflict(error) {
    if (error.code !== 'CHARACTER_LIBRARY_CONFLICT' && !error.librarySaveFailed) throw error;
    toastr.warning(error.message, '角色库');
}
`;
}

function requestHeadersFor(source, route, identity) {
    const prefix = "fetch('" + route + "', {\n";
    const pos = source.indexOf(prefix);
    if (pos < 0 || source.indexOf(prefix, pos + 1) >= 0) throw Error('Missing or repeated write endpoint: ' + route);
    const start = source.indexOf('headers: getRequestHeaders(', pos);
    const end = source.indexOf('),', start);
    if (start < pos || end > pos + 200) throw Error('Missing headers: ' + route);
    const options = source.slice(start, end).includes('omitContentType') ? 'omitContentType: true, ' : '';
    return source.slice(0, start) + 'headers: getRequestHeaders({ ' + options + 'libraryIdentity: ' + identity + ' })' + source.slice(end + 1);
}

function notifyChatChange(source) {
    return source.replace(/^( *)await eventSource\.emit\(event_types\.CHAT_CHANGED,/gm,
        '$1window.STCharacterLibrary?.beforeChatChanged?.();\n$1await eventSource.emit(event_types.CHAT_CHANGED,');
}

function replacementFlow(source) {
    source = edit(source, 'export async function processDroppedFiles(files, data = new Map()) {',
        'export async function processDroppedFiles(files, data = new Map(), libraryReplacement = null) {');
    source = edit(source, 'await importCharacter(file, { preserveFileName: preservedName });',
        'await importCharacter(file, { preserveFileName: preservedName, libraryReplacement });');
    source = edit(source, '        selectImportedChar(avatarFileNames[avatarFileNames.length - 1]);\n    }\n}',
        '        if (!libraryReplacement) selectImportedChar(avatarFileNames[avatarFileNames.length - 1]);\n    }\n    return avatarFileNames;\n}');
    source = edit(source, "async function importCharacter(file, { preserveFileName = '', importTags = false } = {}) {",
        "async function importCharacter(file, { preserveFileName = '', importTags = false, libraryReplacement = null } = {}) {");
    source = edit(source, "    if (preserveFileName) formData.append('preserved_name', preserveFileName);",
        "    if (preserveFileName) formData.append('preserved_name', preserveFileName);\n    if (libraryReplacement) formData.append('library_replace_avatar', libraryReplacement.avatar);");
    source = requestHeadersFor(source, '/api/characters/import', 'libraryReplacement');
    source = edit(source, "            case 'replace_update': {\n                let onlineUrl", `            case 'replace_update': {
                const replacementTarget = characters[this_chid];
                const libraryReplacement = { avatar: replacementTarget.avatar, id: libraryIdentity(replacementTarget)?.id, chat: replacementTarget.chat };
                const replacementChatMetadata = chat_metadata;
                try { await saveChatConditional({ throwOnError: true }); }
                catch (error) { reportLibrarySaveConflict(error); break; }
                let onlineUrl`);
    source = edit(source, '                const currentChatFile = characters[this_chid].chat;\n                async function postReplace() {\n                    await openCharacterChat(currentChatFile);\n                }', `                const currentChatFile = libraryReplacement.chat;
                async function postReplace() {
                    // The upload may finish after the user has selected another character.
                    if (characters[this_chid]?.avatar !== libraryReplacement.avatar || chat_metadata !== replacementChatMetadata) return;
                    try { await saveChat({ chatName: currentChatFile, throwOnError: true }); }
                    catch (error) {
                        toastr.warning('角色卡已更新，聊天未保存：' + error.message, '角色库');
                        return;
                    }
                    if (characters[this_chid]?.avatar !== libraryReplacement.avatar || chat_metadata !== replacementChatMetadata) return;
                    await getOneCharacter(libraryReplacement.avatar);
                    if (characters[this_chid]?.avatar !== libraryReplacement.avatar || chat_metadata !== replacementChatMetadata) return;
                    try { await openCharacterChat(currentChatFile, { saveCurrent: false }); }
                    catch (error) { reportLibrarySaveConflict(error); }
                }`);
    source = edit(source, '                                data.set(file, characters[this_chid].avatar);\n                                await processDroppedFiles([file], data);\n                                await postReplace();',
        '                                data.set(file, libraryReplacement.avatar);\n                                const imported = await processDroppedFiles([file], data, libraryReplacement);\n                                if (imported.includes(libraryReplacement.avatar)) await postReplace();');
    source = edit(source, '                        await importFromExternalUrl(onlineUrl, { preserveFileName: characters[this_chid].avatar });\n                        await postReplace();',
        '                        const imported = await importFromExternalUrl(onlineUrl, { preserveFileName: libraryReplacement.avatar, libraryReplacement });\n                        if (imported?.includes(libraryReplacement.avatar)) await postReplace();');
    return source;
}

// Catch only failures from the strict save path at a complete user operation boundary.
function saveBoundary(source, signature) {
    const start = source.indexOf(signature);
    if (start < 0) throw Error('Missing save boundary: ' + signature);
    const body = start + signature.length;
    const end = source.indexOf('\n}', body);
    if (end < 0) throw Error('Missing save boundary end');
    return source.slice(0, body) + '\n    try {' + source.slice(body, end) + `
    } catch (error) {
        if (error.code !== 'CHARACTER_LIBRARY_CONFLICT' && !error.librarySaveFailed) throw error;
        reportLibrarySaveConflict(error);
        return null;
    }` + source.slice(end);
}

export function bookmarks(source) {
    source = edit(source, 'await saveChat({ chatName: name, withMetadata: newMetadata, mesId, chatData: branchChatSnapshot });',
        'await saveChat({ chatName: name, withMetadata: newMetadata, mesId, chatData: branchChatSnapshot, throwOnError: true });');
    source = edit(source, 'await saveChat({ chatName: name, withMetadata: newMetadata, mesId });',
        'await saveChat({ chatName: name, withMetadata: newMetadata, mesId, throwOnError: true });');
    source = edit(source, "        const chats = Object.values(data).map(x => x.file_name.replace('.jsonl', ''));",
        "        // Native also returns this sentinel for a new card without a chat directory.\n        if (data?.error === true) return [];\n        const chats = Object.values(data).map(x => x.file_name.replace('.jsonl', ''));");
    source = edit(source, '    lastMes.extra.bookmark_link = name;\n\n    const mes = $(`.mes[mesid="${mesId}"]`);\n    updateBookmarkDisplay(mes, name);\n\n    await saveChatConditional();', `    const previousLink = lastMes.extra.bookmark_link;
    const hadLink = Object.hasOwn(lastMes.extra, 'bookmark_link');
    lastMes.extra.bookmark_link = name;
    try { await saveChatConditional({ throwOnError: true }); }
    catch (error) {
        if (hadLink) lastMes.extra.bookmark_link = previousLink;
        else delete lastMes.extra.bookmark_link;
        if (error.code === 'CHARACTER_LIBRARY_CONFLICT' || error.librarySaveFailed) error.message += ' 检查点副本已保存，原聊天关联未保存。';
        throw error;
    }
    const mes = $(\`.mes[mesid="\${mesId}"]\`);
    updateBookmarkDisplay(mes, name);`);
    source = saveBoundary(source, 'export async function createBranch(mesId, { swipeId = null } = {}) {');
    source = saveBoundary(source, 'export async function createNewBookmark(mesId, { forceName = null } = {}) {');
    source = saveBoundary(source, 'async function backToMainChat() {');
    source = edit(source, '        } finally {\n            await loaderHandle.hide();',
        "        } catch (error) {\n            reportLibrarySaveConflict(error);\n            return;\n        } finally {\n            await loaderHandle.hide();");
    const start = source.indexOf('export async function branchChat(');
    const end = source.indexOf('\n}', start);
    let branch = source.slice(start, end);
    branch = edit(branch, '    await saveItemizedPrompts(fileName);', '    const branchMessage = chat[mesId];\n    try {\n    await saveItemizedPrompts(fileName);');
    branch += `
    } catch (error) {
        if (error.code !== 'CHARACTER_LIBRARY_CONFLICT' && !error.librarySaveFailed) throw error;
        const names = branchMessage?.extra?.branches;
        const index = names?.lastIndexOf(fileName) ?? -1;
        if (index >= 0) names.splice(index, 1);
        error.message += ' 分支副本已保存，原聊天关联未保存。';
        reportLibrarySaveConflict(error);
        return null;
    }`;
    source = source.slice(0, start) + branch + source.slice(end);
    return source + "\nimport { reportLibrarySaveConflict } from '../script.js';\n";
}

export function utils(source) {
    source = edit(source, 'export async function importFromExternalUrl(url, { preserveFileName = null } = {}) {',
        'export async function importFromExternalUrl(url, { preserveFileName = null, libraryReplacement = null } = {}) {');
    source = edit(source, '    switch (customContentType) {', `    if (libraryReplacement && customContentType !== 'character') {
        toastr.warning('替换角色需要角色卡文件。');
        return [];
    }
    switch (customContentType) {`);
    source = edit(source, "        case 'character':\n            await processDroppedFiles([file], extraData);\n            break;",
        "        case 'character':\n            return await processDroppedFiles([file], extraData, libraryReplacement);");
    return source;
}

export function main(source) {
    const select = 'export async function selectCharacterById(id, { switchMenu = true } = {}) {';
    source = edit(source, select, `window.STCharacterLibraryAdapter = '1.18.0';

export async function prepareLibraryCharacters(avatars) {
    if (!avatars?.length) return;
    try {
        if (window.STCharacterLibrary) {
            return await window.STCharacterLibrary.prepare(avatars);
        } else if (window.STCharacterLibraryManaged) {
            throw Error('请启用配套角色库前端扩展后再打开聊天。');
        }
    } catch (error) {
        toastr.error(error.message, '角色库');
        throw error;
    }
}

` + select.replace('switchMenu = true', 'switchMenu = true, preparedAvatar'));
    const guard = '        if (!is_send_press) {\n            setCharacterId(undefined);';
    source = edit(source, guard, `        if (!is_send_press) {
            const avatar = characters[id].avatar;
            if (preparedAvatar !== avatar) await prepareLibraryCharacters([avatar]);
            id = characters.findIndex(character => character.avatar === avatar);
            if (id < 0 || is_send_press || isChatSaving || is_group_generating) return;
            setCharacterId(undefined);`);
    const list = '        const previousAvatar = this_chid !== undefined ? characters[this_chid]?.avatar : null;';
    source = edit(source, list, "        const libraryState = response.headers.get('X-ST-Character-Library');\n        window.STCharacterLibraryManaged = libraryState === 'managed';\n        window.STCharacterLibraryAvailable = libraryState === 'available' || window.STCharacterLibraryManaged;\n" + list);
    source = edit(source, '        characters.splice(0, characters.length);\n        const getData = await response.json();',
        '        const getData = await response.json();\n        window.STCharacterLibrary?.preserveSelection?.(getData, previousAvatar, this_chid);\n        characters.splice(0, characters.length);');
    source = edit(source, 'function updateFavButtonState(state)', 'export function updateFavButtonState(state)');
    const reload = 'export async function reloadCurrentChatUnsafe() {';
    source = edit(source, reload, reload + `
    const group = selected_group && groups.find(item => item.id === selected_group);
    if (group) await prepareLibraryGroup(group);
    else if (characters[this_chid]) await prepareLibraryCharacters([characters[this_chid].avatar]);`);
    source = edit(source, 'await getGroupChat(selected_group, true);', 'await getGroupChat(selected_group, true, true);');
    source = notifyChatChange(source);
    source = edit(source, '    select_selected_character(this_chid);\n\n    window.STCharacterLibrary?.beforeChatChanged?.();',
        '    window.STCharacterLibrary?.beforeChatChanged?.();\n    select_selected_character(this_chid);\n');
    source = edit(source, 'export async function getCharacters() {', 'export async function getCharacters({ throwOnError = false } = {}) {');
    source = edit(source, "        console.error('Failed to fetch characters:', response.statusText);",
        "        if (throwOnError) throw Error('读取角色列表失败（' + response.status + '）');\n        console.error('Failed to fetch characters:', response.statusText);");
    source = edit(source, "    $('#rm_button_selected_ch').on('click', function () {", "    $('#rm_button_selected_ch').on('click', async function () {");
    source = edit(source, "            selected_button = 'character_edit';\n            select_selected_character(this_chid);", "            await unshallowCharacter(this_chid);\n            selected_button = 'character_edit';\n            select_selected_character(this_chid);");
    source = edit(source, 'export async function openCharacterChat(file_name) {\n    await waitUntilCondition(() => !isChatSaving, debounce_timeout.extended, 10);', `export async function openCharacterChat(file_name, { saveCurrent = true } = {}) {
    const openingAvatar = characters[this_chid]?.avatar;
    const openingMetadata = chat_metadata;
    if (saveCurrent) await saveChatConditional({ throwOnError: true });
    await waitUntilCondition(() => !isChatSaving, debounce_timeout.extended, 10);
    if (!openingAvatar || characters[this_chid]?.avatar !== openingAvatar || chat_metadata !== openingMetadata) {
        throw libraryConflict('聊天已切换，已取消打开原会话。');
    }`);
    source = replacementFlow(source);
    return bindNativeWrites(source) + "\nimport { prepareLibraryGroup } from './scripts/group-chats.js';\n";
}

export function groups(source) {
    const memberLookup = 'const character = characters.find(x => x.avatar === member || x.name === member);';
    if (source.split(memberLookup).length !== 4) throw Error('Unexpected group member lookup count');
    source = source.replaceAll(memberLookup,
        'const character = characters.find(x => x.avatar === member) || (!window.STCharacterLibraryAvailable && !window.STCharacterLibraryManaged ? characters.find(x => x.name === member) : undefined);');
    const validate = 'async function validateGroup(group) {';
    source = edit(source, validate, `export async function prepareLibraryGroup(group) {
    if (!group?.members?.length) return;
    const avatars = await prepareLibraryCharacters(group.members);
    if (!window.STCharacterLibraryManaged && (!window.STCharacterLibraryAvailable || !window.STCharacterLibrary)) return;
    if (!avatars || avatars.some(avatar => !characters.some(x => x.avatar === avatar))) {
        throw Error('无法准备所有群成员，已保留群设置。');
    }
    if (avatars.some((avatar, i) => group.members[i] !== avatar)) {
        const byName = new Map(group.members.map((member, i) => [member, avatars[i]]));
        group.members = avatars;
        group.disabled_members = (group.disabled_members || []).map(member => byName.get(member) || member);
    }
}

` + validate);
    source = edit(source, 'export async function getGroupChat(groupId, reload = false)', 'export async function getGroupChat(groupId, reload = false, prepared = false)');
    source = edit(source, '    // Run validation before any loading', '    if (!prepared) await prepareLibraryGroup(group);\n    // Run validation before any loading');
    source = edit(source, '    let dirty = false;\n    group.members = group.members.filter', `    if (window.STCharacterLibraryManaged && group.members.some(member => !characters.some(x => x.avatar === member || x.name === member))) {
        throw Error('无法识别归库角色，已保留群设置。');
    }
    let dirty = false;
    group.members = group.members.filter`);
    source = edit(source, '        select_group_chats(groupId, false);',
        '        await prepareLibraryGroup(groups.find(group => group.id === groupId));\n        if (isChatSaving || is_send_press || is_group_generating) return false;\n        select_group_chats(groupId, false);');
    source = edit(source, '    await clearChat({ clearData: true });\n    const newChatName', '    await prepareLibraryGroup(group);\n    await clearChat({ clearData: true });\n    const newChatName');
    source = edit(source, '    await clearChat({ clearData: true });\n    group.chat_id = chatId;', '    await prepareLibraryGroup(group);\n    await clearChat({ clearData: true });\n    group.chat_id = chatId;');
    source = source.replaceAll('await getGroupChat(groupId);', 'await getGroupChat(groupId, false, true);')
        .replace('await getGroupChat(group.id);', 'await getGroupChat(group.id, false, true);');
    source = edit(source, '    try {\n        await unshallowGroupMembers(selected_group);', '    try {\n        await prepareLibraryGroup(group);\n        await unshallowGroupMembers(selected_group);');
    source = edit(source, '            if (memberAvatars.length === 4) {', "            if (window.STCharacterLibraryManaged && charIndex < 0) memberAvatars.push('/api/plugins/character-library/thumbnail?avatar=' + encodeURIComponent(member));\n            if (memberAvatars.length === 4) {");
    source = edit(source, '                group.members = group.members\n                    .map(x => characters.find(y => y.name == x)?.avatar)',
        '                if (!window.STCharacterLibraryAvailable && !window.STCharacterLibraryManaged) group.members = group.members\n                    .map(x => characters.find(y => y.name == x)?.avatar)');
    const names = '                namesList.push(character.name);\n                count++;';
    source = edit(source, names, names + "\n            } else if (window.STCharacterLibraryManaged) {\n                namesList.push(member.replace(/\\.png$/i, ''));\n                count++;");
    return notifyChatChange(source) + '\n' + importPrepare;
}

export function resume(source) {
    const find = '        const active_character_id = characters.findIndex';
    return edit(source, find, '        if (!characters.some(x => x.avatar === active_character)) await prepareLibraryCharacters([active_character]);\n' + find) + '\n' + importPrepare;
}

export function welcome(source) {
    for (const action of ['open', 'rename', 'delete']) {
        const fn = 'async function ' + action + 'RecentCharacterChat(avatarId, fileName) {';
        source = edit(source, fn, fn + '\n    if (!characters.some(x => x.avatar === avatarId)) await prepareLibraryCharacters([avatarId]);');
    }
    source = edit(source, '.filter(t => t.character || t.group)', '.filter(t => t.character || t.group || (window.STCharacterLibraryManaged && t.chat.avatar))');
    source = edit(source, '        await selectCharacterById(characterId);\n        setActiveCharacter(avatarId);',
        '        await selectCharacterById(characterId);\n        if (window.STCharacterLibraryManaged && (selected_group || characters[this_chid]?.avatar !== avatarId)) return;\n        setActiveCharacter(avatarId);');
    source = edit(source, '        await openGroupById(groupId);\n        setActiveGroup(groupId);',
        '        await openGroupById(groupId);\n        if (window.STCharacterLibraryManaged && selected_group !== groupId) return;\n        setActiveGroup(groupId);');
    source = edit(source, "chat.char_name = character?.name || group?.name || '';", "chat.char_name = character?.name || group?.name || chat.avatar?.replace(/\\.png$/i, '') || '';");
    source = edit(source, "        chat.char_thumbnail = character ? getThumbnailUrl('avatar', character.avatar) : system_avatar;",
        "        chat.char_thumbnail = character ? getThumbnailUrl('avatar', character.avatar) : (chat.avatar && window.STCharacterLibraryManaged ? '/api/plugins/character-library/thumbnail?avatar=' + encodeURIComponent(chat.avatar) : system_avatar);");
    return source + "\nimport { selected_group } from './group-chats.js';\n" + importPrepare;
}

export function slash(source) {
    source = edit(source, '    // If a specific field is requested\n    if (args.field)', `    if (character.shallow) {
        const avatar = character.avatar;
        await getOneCharacter(avatar);
        character = characters.find(card => card.avatar === avatar);
        if (!character || character.shallow) throw Error('角色全文未能载入');
    }
    // If a specific field is requested
    if (args.field)`);
    const group = "    const group = groups.find(it => equalsIgnoreCaseAndAccents(it.name, name));";
    const select = '    const character = findChar({ name: name });\n    if (character) {\n        const chid = getCharIndex(character);\n        await openChat(String(chid));';
    source = edit(source, select, `    let character = findChar({ name: name });
    const group = groups.find(it => equalsIgnoreCaseAndAccents(it.name, name));
    if (!character && !group && window.STCharacterLibrary) {
        const avatar = await window.STCharacterLibrary.resolveAvatar(name);
        if (avatar) {
            await prepareLibraryCharacters([avatar]);
            character = characters.find(x => x.avatar === avatar);
        }
    }
    if (character) {
        const chid = getCharIndex(character);
        if (window.STCharacterLibraryManaged) {
            await selectCharacterById(chid);
            if (selected_group || characters[this_chid]?.avatar !== character.avatar) return '';
        }
        else await openChat(String(chid));`);
    source = edit(source, '    }\n' + group + '\n    if (group)', '    }\n    if (group)');
    source = edit(source, '        await openGroupById(group.id);\n        setActiveCharacter(null);',
        "        await openGroupById(group.id);\n        if (window.STCharacterLibraryManaged && selected_group !== group.id) return '';\n        setActiveCharacter(null);");
    const upload = 'async function uploadCharacterAvatar(avatarKey, base64Data, { resizePrompt = false } = {}) {';
    source = edit(source, upload, upload + '\n    const identity = window.STCharacterLibrary?.identity(characters.find(c => c.avatar === avatarKey)) ?? null;');
    source = requestHeadersFor(source, '/api/characters/edit-avatar', 'identity');
    source = requestHeadersFor(source, '/api/characters/merge-attributes', 'window.STCharacterLibrary?.identity(character) ?? null');
    return source + '\n' + importPrepare;
}

export function extensions(source) {
    const single = "        headers: getRequestHeaders(),\n        body: JSON.stringify(saveDataRequest),";
    source = edit(source, single, single.replace('getRequestHeaders()', 'getRequestHeaders({ libraryIdentity: window.STCharacterLibrary?.identity(character) ?? null })'));
    const insert = '    // Default filter: when unsetting, only touch characters that have the field';
    return edit(source, insert, `    if (window.STCharacterLibraryManaged && window.STCharacterLibrary) {
        const targets = requestBody.avatars.length
            ? requestBody.avatars.map(avatar => context.characters.find(card => card.avatar === avatar))
            : context.characters.filter(card => card.libraryId);
        if (!targets.length) return { updated: [], skipped: [], failed: [] };
        requestBody.libraryIdentities = targets.map(card => window.STCharacterLibrary.identity(card)).filter(Boolean);
        if (!requestBody.avatars.length) requestBody.avatars = targets.map(card => card.avatar);
    }
` + insert);
}

export function bulk(source) {
    source = requestHeadersFor(source, '/api/characters/duplicate', 'identity');
    source = edit(source, '    static duplicate = async (characterId) => {\n        const character = CharacterContextMenu.#getCharacter(characterId);',
        '    static duplicate = async (character, identity) => {');
    const handler = '    handleContextMenuDuplicate = () => Promise.all(this.selectedCharacters.map(async characterId => CharacterContextMenu.duplicate(characterId)))\n        .then(() => getCharacters())\n        .then(() => this.browseState());';
    source = edit(source, handler, `    handleContextMenuDuplicate = async () => {
        const targets = this.selectedCharacters.map(id => characters[id]).map(character => ({
            character, identity: window.STCharacterLibrary?.identity(character) ?? null,
        }));
        let completed = 0;
        const failed = [];
        for (const target of targets) {
            const { character } = target;
            try {
                if (!target.identity && window.STCharacterLibraryManaged && window.STCharacterLibrary) {
                    await window.STCharacterLibrary.prepare([character.avatar]);
                    target.identity = window.STCharacterLibrary.identity(characters.find(card => card.avatar === character.avatar)) ?? null;
                }
                await CharacterContextMenu.duplicate(character, target.identity); completed++;
            }
            catch (error) { failed.push(character.avatar + ': ' + error.message); }
        }
        if (failed.length) toastr.warning('已复制 ' + completed + ' 张。' + failed.join('; '));
        await getCharacters();
        this.browseState();
    };`);
    return requestHeadersFor(source, '/api/characters/merge-attributes', 'window.STCharacterLibrary?.identity(character) ?? null');
}

export function world(source) {
    source = edit(source, '            linkedChIDs.push(chid);', '            linkedChIDs.push(character);');
    source = edit(source, '        for (const chid of linkedChIDs) {\n            const character = characters[chid];',
        '        for (const character of linkedChIDs) {\n            const chid = characters.findIndex(card => card.avatar === character.avatar);');
    return requestHeadersFor(source, '/api/characters/merge-attributes', 'window.STCharacterLibrary?.identity(character) ?? null');
}

export function tags(source) {
    const candidates = '    const tagMapsToPrune = Object.keys(tag_map).filter(key => !allEntityKeys.has(key));';
    return edit(source, candidates, candidates.replace('const ', 'let ') + `
    if (window.STCharacterLibraryManaged && tagMapsToPrune.length) {
        try {
            const candidates = tagMapsToPrune.filter(key => /\\.png$/i.test(key));
            if (candidates.length) {
                const present = new Set(await window.STCharacterLibrary.tagTargets(candidates));
                tagMapsToPrune = tagMapsToPrune.filter(key => !present.has(key));
            }
        } catch (error) {
            toastr.error(error.message, '无法核对归库卡的标签');
            return;
        }
    }`);
}

export function chats(source) {
    const router = 'export const router = express.Router();';
    source = edit(source, router, router + `
router.use(['/get', '/rename', '/delete', '/import'], (request, response, next) => {
    try {
        if (request.body?.avatar_url && !request.body.is_group) {
            globalThis[Symbol.for('st.character-library')]?.assertWritableName(request.user.directories, request.body.avatar_url);
        }
        next();
    } catch (error) {
        if (error.status === 409) return response.status(409).send({ code: 'CHARACTER_LIBRARY_CONFLICT', error: error.message, message: error.message });
        next(error);
    }
});`);
    const save = "router.post('/save', validateAvatarUrlMiddleware, async function (request, response) {";
    source = edit(source, save, `router.post('/save', validateAvatarUrlMiddleware, async function (request, response, next) {
    const library = globalThis[Symbol.for('st.character-library')];
    const save = async () => {`);
    const end = "        return response.status(500).send({ error: 'An error has occurred, see the console logs for more information.' });\n    }\n});\n\n/**\n * Gets the chat as an object.";
    source = edit(source, end, end.replace('\n});', `
    };
    try {
        return await (library ? library.runNative(request, save, 'chat-save') : save());
    } catch (error) {
        if (error.status === 409) return response.status(409).send({ code: 'CHARACTER_LIBRARY_CONFLICT', message: error.message, error: error.message });
        return next(error);
    }
});`));
    // /get normally creates the directory. In managed mode only a validated save may create it.
    source = edit(source, '            fs.mkdirSync(directoryPath);\n            return response.send({});',
        "            if (!globalThis[Symbol.for('st.character-library')]?.managed(request.user.directories)) fs.mkdirSync(directoryPath);\n            return response.send({});");
    const anchor = '            for (const pngFile of pngFiles) {';
    return edit(source, anchor, `            const library = globalThis[Symbol.for('st.character-library')];
            if (library?.managed(request.user.directories)) {
                const listed = new Set(pngFiles);
                const histories = await fs.promises.readdir(request.user.directories.chats, { withFileTypes: true });
                for (const history of histories) {
                    const avatar = history.name + '.png';
                    if (history.isDirectory() && !listed.has(avatar) && library.hasCard(request.user.directories, avatar)) pngFiles.push(avatar);
                }
            }
` + anchor);
}
