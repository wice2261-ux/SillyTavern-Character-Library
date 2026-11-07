import * as native from '/script.js';
import { DOMPurify } from '/lib.js';
import { getContext } from '/scripts/extensions.js';
import { humanizedDateTime } from '/scripts/RossAscends-mods.js';
import { createLibrary } from './library.js';
import { createSettings } from './settings.js';

const base = '/api/plugins/character-library';
// A fresh ID for every document, including tabs duplicated by the browser.
const client = Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('');
let managed;
let available;
let pending = Promise.resolve();
let lastHeartbeatError = '';
let inFlight = 0;
let lastPublishedAvatar;
let showLibrary, settings, eventsInstalled = false;
const coldSlot = Symbol('character-library-cold-slot');

async function request(url, options) {
    const response = await fetch(url, {method: 'POST', ...options});
    if (!response.ok) {
        let message = response.statusText, code;
        const body = await response.text();
        try {
            const error = JSON.parse(body);
            message = error.message || error.error || message;
            code = error.code;
        } catch {
            if (body && !body.trim().startsWith('<')) message = body.slice(0, 300);
        }
        if (response.status === 404 && url.startsWith(base) && body.trim().startsWith('<')) {
            message = '角色库服务端未安装或未启用。';
        }
        throw Object.assign(new Error(String(message || '请求失败') + ' (' + response.status + ')'), {status:response.status, code});
    }
    return response.json();
}

async function api(path, body = {}) {
    let result;
    try {
        result = await request(base + path, {
            headers: native.getRequestHeaders(),
            body: JSON.stringify({ ...body, client, adapter: window.STCharacterLibraryAdapter }),
        });
    } catch (error) {
        if (path === '/status' || !error.status || error.status === 404 || error.status >= 500) settings?.update(undefined, error);
        throw error;
    }
    available = true;
    if (typeof result.managed === 'boolean') {
        managed = result.managed;
        window.STCharacterLibraryManaged = managed;
    }
    settings?.update(result, undefined, path === '/status');
    return result;
}

async function upload(file, mode = 'rename') {
    const query = new URLSearchParams({name:file.name, mode, adapter: String(window.STCharacterLibraryAdapter || '')});
    const result = await request(base + '/import?' + query, {
        headers: {...native.getRequestHeaders({omitContentType:true}), 'Content-Type':'application/octet-stream'}, body:file,
    });
    if (mode === 'replace') {
        const index = native.characters.findIndex(card => card.avatar === result.item.avatar);
        if (index >= 0) {
            const previous = native.characters[index];
            // Keep array positions used by the native UI, but never reuse the replaced full card.
            native.characters[index] = { avatar: result.item.avatar, libraryId: result.item.id,
                name: result.item.name, chat: previous.chat, shallow: true, fav: result.item.favorite,
                tags: result.item.tags, data: { name:result.item.name, extensions:{} } };
        }
    }
    return result;
}

function serialized(operation) {
    const next = pending.then(operation);
    pending = next.catch(() => {});
    return next;
}

function currentAvatars() {
    const ctx = getContext();
    const group = ctx.groups.find(group => String(group.id) === String(ctx.groupId));
    const members = (group?.members || []).flatMap(member => /\.png$/i.test(member) ? [member]
        : native.characters.filter(card => card.name === member).map(card => card.avatar));
    const selected = native.characters[native.this_chid]?.avatar;
    if (selected) members.push(selected);
    return [...new Set(members)];
}

function shallowSlot(card) {
    return { [coldSlot]:true, shallow:true, avatar:card.avatar, name:card.name, chat:card.chat,
        fav:card.fav, tags:card.tags || [], data:{name:card.name, tags:card.tags || [], extensions:{}} };
}

function preserveSelection(fresh, previousAvatar, previousId) {
    if (!previousAvatar || !(managed || window.STCharacterLibraryManaged)) return;
    const from = fresh.findIndex(c => c.avatar === previousAvatar);
    const to = Number(previousId);
    if (from < 0 || from === to || !Number.isInteger(to) || to < 0) return;
    if (to >= fresh.length) {
        const present = new Set(fresh.map(c => c.avatar));
        for (const card of native.characters) {
            if (!present.has(card.avatar)) fresh.push(shallowSlot(card));
            if (to < fresh.length) break;
        }
    }
    if (to < fresh.length) [fresh[from], fresh[to]] = [fresh[to], fresh[from]];
}

async function sync(result, change = {}) {
    const records = native.characters;
    const selected = records[native.this_chid]?.avatar;
    const selectedId = native.this_chid;
    const evicted = new Set(result.evicted || []);
    if (change.deleted) evicted.add(change.deleted);
    const online = Array.isArray(result.online) ? new Set(result.online) : null;
    const keep = new Set(currentAvatars());
    let changed = false;
    if (!native.isGenerating() && !native.isChatSaving && (online || evicted.size)) {
        // Helper 4.12 saves variables using the ID captured on a real CHAT_CHANGED.
        const bindings = ['.open_alternate_greetings', '#set_character_world'].map(selector => {
            const node = window.jQuery(selector);
            return [node, records[node.data('chid')]?.avatar];
        });
        for (let i = records.length - 1; i >= 0; --i) {
            const avatar = records[i].avatar;
            if (!keep.has(avatar) && (evicted.has(avatar) || (online && !online.has(avatar)))) {
                if (selected && i < Number(selectedId)) {
                    // On the very first migration the current card may still have an old, high index.
                    // Release its neighbors' full data now; remove these slots at the next chat change.
                    const card = records[i];
                    if (!card[coldSlot]) {
                        records[i] = shallowSlot(card);
                        changed = true;
                    }
                } else {
                    records.splice(i, 1);
                    changed = true;
                }
            }
        }
        if (changed) {
            if (selected && records[selectedId]?.avatar !== selected) native.setCharacterId(records.findIndex(c => c.avatar === selected));
            for (const [node, avatar] of bindings) if (avatar) node.data('chid', records.findIndex(c => c.avatar === avatar));
        }
    }
    if (change.avatar && typeof change.favorite === 'boolean') {
        const card = records.find(c => c.avatar === change.avatar);
        if (card) {
            card.fav = change.favorite;
            if (card.data?.extensions) card.data.extensions.fav = change.favorite;
            if (selected === change.avatar) native.updateFavButtonState?.(change.favorite);
            changed = true;
        }
    }
    if (changed) await native.printCharacters(true);
}

function beforeChatChanged() {
    const records = native.characters;
    const index = Number(native.this_chid);
    const selected = records[index]?.avatar;
    if (selected === lastPublishedAvatar) return;
    lastPublishedAvatar = selected;
    if (!(managed || window.STCharacterLibraryManaged)) return;
    let changed = false;
    if (selected && index > 0) {
        [records[0], records[index]] = [records[index], records[0]];
        native.setCharacterId(0);
        changed = true;
    }
    for (let i = records.length - 1; i >= 0; --i) {
        if (records[i][coldSlot]) {
            records.splice(i, 1);
            changed = true;
        }
    }
    if (changed) void serialized(() => native.printCharacters(true)).catch(error => console.warn('角色库列表刷新失败', error));
}

async function resolveAvatar(name) {
    if (available === false) return null;
    const { avatars } = await api('/resolve', {members:[name]});
    return avatars[0];
}

async function resolveAvatars(members) {
    if (members.every(name => /\.png$/i.test(name))) return members;
    // Only legacy display names need an account-wide uniqueness check.
    let avatars;
    if (available) {
        ({ avatars } = await api('/resolve', {members}));
    } else {
        avatars = members.map(name => {
            if (/\.png$/i.test(name)) return name;
            const matches = native.characters.filter(card => card.name === name);
            return matches.length === 1 ? matches[0].avatar : null;
        });
    }
    const missing = avatars.findIndex(avatar => !avatar);
    if (missing >= 0) throw new Error('无法唯一识别群成员「' + members[missing] + '」，请检查角色名。');
    return avatars;
}

async function prepareOperation(members) {
    if (!members.length) return [];
    if (available === undefined) {
        try { await api('/status'); }
        catch (error) {
            if (error.status !== 404) throw error;
            available = false;
        }
    }
    const resolved = await resolveAvatars(members);
    const avatars = [...new Set(resolved)];
    const local = avatars.every(avatar => native.characters.some(card => card.avatar === avatar));
    if (!available || (!managed && local)) {
        if (local) return resolved;
        if (!available) throw new Error('打开此角色需要启用角色库服务端。');
    }
    // Report the still-open chat before preparing a replacement in this or another tab.
    await api('/lease', {avatars:currentAvatars(), played:false});
    const prepared = await api('/prepare', {avatars});
    const ids = new Map(prepared.identities.map(({avatar, id}) => [avatar, id]));
    const additions = [];
    for (const avatar of avatars) {
        const item = native.characters.find(c => c.avatar === avatar);
        if (item?.data && !item.shallow && item.libraryId === ids.get(avatar)) continue;
        const card = await request('/api/characters/get', {
            headers: native.getRequestHeaders(), body: JSON.stringify({avatar_url:avatar}),
        });
        if (card.avatar !== avatar || card.libraryId !== ids.get(avatar) || !card.name || !card.data || card.shallow) {
            throw new Error('酒馆未能解析角色卡 ' + avatar);
        }
        card.name = DOMPurify.sanitize(card.name);
        card.chat = String(card.chat || (card.name + ' - ' + humanizedDateTime()));
        additions.push(card);
    }
    // Commit only once all members have been read. No chat/assistant events fire during preparation.
    for (const card of additions) {
        const id = native.characters.findIndex(c => c.avatar === card.avatar);
        if (id < 0) native.characters.push(card);
        else native.characters[id] = card;
    }
    await sync(prepared);
    if (additions.length) await native.printCharacters(true);
    return resolved;
}

function prepare(avatars) {
    return serialized(() => prepareOperation(avatars));
}

async function lease(played) {
    if (available === false) return;
    const avatars = currentAvatars();
    const result = await api('/lease', {avatars, played: Boolean(played && avatars.length)});
    await sync(result);
}

function heartbeat(played = false) {
    if (inFlight && !played) return;
    ++inFlight;
    void serialized(() => lease(played)).then(() => { lastHeartbeatError = ''; }).catch(error => {
        if (error.status === 404 && !managed) { available = false; return; }
        if (managed && lastHeartbeatError !== error.message) window.toastr?.warning(error.message, '角色库占用同步');
        lastHeartbeatError = error.message;
    }).finally(() => { --inFlight; });
}

const preflight = () => serialized(async () => {
    await sync(await api('/lease', {avatars:currentAvatars(), played:false}));
});

async function openChat(avatar) {
    await prepare([avatar]);
    const id = native.characters.findIndex(c => c.avatar === avatar);
    if (id < 0) throw new Error('角色尚未载入，请重试。');
    await native.selectCharacterById(id, {switchMenu:false, preparedAvatar:avatar});
    const ctx = getContext();
    if (ctx.groupId || native.characters[native.this_chid]?.avatar !== avatar) {
        throw new Error('酒馆当前正在保存或生成，请完成后再打开角色。');
    }
}

// This hook must exist before the native startup code restores the previous chat.
window.STCharacterLibrary = {
    client, prepare, resolveAvatar, beforeChatChanged, preserveSelection,
    identity(card) { return card?.libraryId ? { avatar:card.avatar, id:card.libraryId } : undefined; },
    async tagTargets(avatars) { return (await api('/tag-targets', {avatars})).present; },
};

function install() {
    const ctx = getContext();
    const shared = {
        api, preflight, sync: (result, change) => serialized(() => sync(result, change)),
        refreshNative: () => native.getCharacters({throwOnError:true}),
    };
    showLibrary ||= createLibrary({
        ...shared, upload, openChat,
        async notifyDeleted(result) {
            const index = native.characters.findIndex(card => card.avatar === result.deleted.avatar && card.libraryId === result.deleted.id);
            await native.afterLibraryCharacterDeleted(native.characters[index] || result.deleted,
                index < 0 ? undefined : index, result.chatFiles);
        },
        preferences: ctx.extensionSettings.characterLibrary || {},
        savePreferences(value) { ctx.extensionSettings.characterLibrary = value; ctx.saveSettingsDebounced(); },
    });
    if (!settings) {
        const version = fetch(new URL('./manifest.json', import.meta.url)).then(response => {
            if (!response.ok) throw new Error(response.statusText);
            return response.json();
        }).then(manifest => manifest.version || '未知').catch(() => '无法读取');
        settings = createSettings({ ...shared, version, refreshLibrary: () => showLibrary.refresh() });
    }
    const settingsHost = document.getElementById('extensions_settings');
    if (settingsHost && !document.getElementById('cl-library-settings')) settingsHost.append(settings.panel);
    const bookHost = document.getElementById('rm_button_create');
    if (bookHost && !document.getElementById('cl-library-open')) {
        const entry = document.createElement('button');
        entry.id = 'cl-library-open';
        entry.type = 'button';
        entry.className = 'menu_button fa-solid fa-book-open';
        entry.title = '打开角色库';
        entry.setAttribute('aria-label', entry.title);
        entry.onclick = () => void showLibrary();
        bookHost.before(entry);
    }
    const menuHost = document.getElementById('extensionsMenu');
    if (menuHost && !document.getElementById('cl-library-menu')) {
        const entry = document.createElement('div');
        entry.id = 'cl-library-menu';
        entry.className = 'list-group-item flex-container flexGap5';
        entry.tabIndex = 0;
        entry.setAttribute('role', 'button');
        entry.innerHTML = '<div class="fa-fw fa-solid fa-book-open extensionsMenuExtensionButton" aria-hidden="true"></div><span>角色库</span>';
        // Let the native delegated click close the wand menu before opening the modal.
        entry.onclick = () => { setTimeout(() => void showLibrary(), 0); };
        entry.onkeydown = event => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); entry.click(); }
        };
        menuHost.append(entry);
    }
    if (eventsInstalled) return;
    eventsInstalled = true;
    ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, () => heartbeat(true));
    ctx.eventSource.on(ctx.eventTypes.GROUP_UPDATED, () => heartbeat(false));
    ctx.eventSource.on(ctx.eventTypes.APP_READY, () => {
        install();
        void api('/status').then(() => heartbeat(false)).catch(error => {
            if (error.status === 404) available = false;
        });
    });
    window.addEventListener('pagehide', event => {
        if (event.persisted || !available || native.isChatSaving || native.isGenerating()) return;
        void fetch(base + '/lease', { method:'POST', headers:native.getRequestHeaders(), keepalive:true,
            body:JSON.stringify({client, avatars:[], played:false, adapter:window.STCharacterLibraryAdapter}) }).catch(() => {});
    });
    setInterval(heartbeat, 15000);
}

install();
