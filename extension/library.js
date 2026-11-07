function button(label, action, title) {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'menu_button';
    element.textContent = label;
    if (title) element.setAttribute('aria-label', title);
    element.addEventListener('click', action);
    return element;
}

export function confirmAction(title, description, confirmLabel, allowChatDelete = false) {
    const dialog = document.createElement('dialog');
    dialog.className = 'cl-library cl-confirm';
    dialog.setAttribute('aria-label', title);
    dialog.innerHTML = `<div class="cl-layout"><strong></strong><p></p>
        <label hidden><input type="checkbox">同时删除该角色的单聊记录</label><div class="cl-tools"></div></div>`;
    dialog.querySelector('strong').textContent = title;
    dialog.querySelector('p').textContent = description;
    const check = dialog.querySelector('input');
    if (allowChatDelete) dialog.querySelector('label').hidden = false;
    const cancel = button('取消', () => dialog.close());
    cancel.autofocus = true;
    const submit = button(confirmLabel, () => dialog.close('confirmed'));
    check.addEventListener('change', () => { submit.textContent = check.checked ? '删除角色及单聊记录' : confirmLabel; });
    dialog.querySelector('.cl-tools').append(cancel, submit);
    document.body.append(dialog);
    return new Promise(resolve => {
        dialog.addEventListener('close', () => {
            const result = dialog.returnValue === 'confirmed' ? { deleteChats: check.checked } : null;
            dialog.remove();
            resolve(result);
        }, { once: true });
        dialog.showModal();
    });
}

function fileSize(bytes) {
    return bytes < 1024 * 1024 ? Math.ceil(bytes / 1024) + ' KiB' : (bytes / (1024 * 1024)).toFixed(1) + ' MiB';
}

export function createLibrary({ api, upload, openChat, sync, notifyDeleted, preferences, savePreferences, preflight }) {
    const dialog = document.createElement('dialog');
    dialog.className = 'cl-library';
    dialog.setAttribute('aria-label', '角色库');
    dialog.innerHTML = `<div class="cl-layout">
        <header class="cl-header"><h2>角色库</h2><button type="button" class="menu_button" data-el="close">关闭</button></header>
        <div class="cl-tools">
            <input class="text_pole cl-search" data-el="search" type="search" aria-label="按角色名、文件名或标签搜索" placeholder="搜索角色名、文件名或标签">
            <select data-el="sort" aria-label="排序字段"><option value="imported">导入酒馆时间</option><option value="played">游玩时间</option><option value="name">名称</option><option value="size">文件大小</option></select>
            <select data-el="dir" aria-label="排序方向"><option value="desc">降序</option><option value="asc">升序</option></select>
            <label><input data-el="pin" type="checkbox" checked>收藏置顶</label>
        </div>
        <div class="cl-tools"><button type="button" class="menu_button" data-el="add">添加角色卡</button>
            <select data-el="duplicate" aria-label="同名文件处理"><option value="rename">同名另存</option><option value="skip">同名跳过</option><option value="replace">同名替换</option></select>
            <input data-el="files" hidden type="file" multiple accept=".png,.json,image/png,application/json">
        </div>
        <p class="cl-status" data-el="status" role="status"></p>
        <p class="cl-status" data-el="listState" role="status"></p>
        <ul class="cl-rows" data-el="rows" aria-label="角色卡"></ul>
        <nav class="cl-pagination" aria-label="角色库分页"><button class="menu_button" type="button" data-el="prev">上一页</button>
            <span data-el="pages"></span><button class="menu_button" type="button" data-el="next">下一页</button></nav>
    </div>`;
    document.body.append(dialog);
    const el = Object.fromEntries([...dialog.querySelectorAll('[data-el]')].map(node => [node.dataset.el, node]));
    for (const key of ['sort', 'dir']) {
        if ([...el[key].options].some(option => option.value === preferences[key])) el[key].value = preferences[key];
    }
    el.pin.checked = preferences.pinnedFirst !== false;
    let page = 1, pages = 1, busy = false, sequence = 0, timer;
    let managed = false, restoring = false;

    function updateControls() {
        for (const key of ['sort','dir','search','pin']) el[key].disabled = busy;
        el.add.disabled = el.duplicate.disabled = busy || restoring;
        el.prev.disabled = busy || page <= 1;
        el.next.disabled = busy || page >= pages;
        for (const node of el.rows.querySelectorAll('button')) node.disabled = busy || (restoring && node.hasAttribute('data-needs-management'));
    }

    async function act(operation) {
        if (busy) return;
        busy = true;
        ++sequence;
        clearTimeout(timer);
        updateControls();
        el.status.textContent = '';
        try { await operation(); }
        catch (error) { el.status.textContent = error.message; }
        finally {
            busy = false;
            updateControls();
            if (dialog.open) await load();
        }
    }

    function row(item) {
        const node = document.createElement('li');
        node.className = 'cl-row';
        const image = document.createElement('img');
        image.className = 'cl-avatar';
        image.loading = 'lazy';
        image.alt = '';
        image.src = '/api/plugins/character-library/thumbnail?avatar=' + encodeURIComponent(item.avatar);
        image.addEventListener('error', () => { image.hidden = true; }, {once: true});
        const info = document.createElement('div');
        info.className = 'cl-card-info';
        const name = document.createElement('span');
        name.className = 'cl-name';
        name.textContent = item.name;
        const detail = document.createElement('small');
        detail.className = 'cl-detail';
        detail.textContent = [item.avatar, item.online ? '已载入' : '已收回', fileSize(item.size), ...(item.tags || []).slice(0,3)].join(' · ');
        const imported = document.createElement('small');
        imported.className = 'cl-detail';
        imported.textContent = typeof item.imported === 'number' && Number.isFinite(item.imported)
            ? '导入酒馆时间：' + new Date(item.imported).toLocaleString()
            : '导入时间未知';
        info.append(name, detail, imported);
        const star = button(item.favorite ? '★' : '☆', () => act(async () => {
            await preflight();
            const result = await api('/favorite', {avatar: item.avatar, favorite: !item.favorite});
            await sync(result, { avatar: item.avatar, favorite: !item.favorite });
        }), (item.favorite ? '取消收藏 ' : '收藏并固定 ') + item.name);
        star.classList.add('cl-star');
        star.setAttribute('aria-pressed', String(Boolean(item.favorite)));
        const open = button('打开聊天', () => act(async () => {
            await openChat(item.avatar);
            dialog.close();
        }), '打开与 ' + item.name + ' 的聊天');
        const remove = button('删除', () => act(async () => {
            const choice = await confirmAction('删除角色卡', item.name + '（' + item.avatar + '）。默认保留单聊记录。', '删除角色卡', true);
            if (!choice) return;
            await preflight();
            const result = await api('/delete', {avatar: item.avatar, id: item.id, deleteChats: choice.deleteChats});
            await notifyDeleted(result);
            await sync(result, {deleted: item.avatar});
        }), '删除 ' + item.name);
        star.dataset.needsManagement = remove.dataset.needsManagement = '';
        if (!item.online) open.dataset.needsManagement = '';
        node.append(image, info, star, open, remove);
        return node;
    }

    async function load() {
        const current = ++sequence;
        clearTimeout(timer);
        el.listState.textContent = '正在读取角色库…';
        try {
            const result = await api('/list', {search: el.search.value.trim(), sort: el.sort.value, dir: el.dir.value,
                pinnedFirst: el.pin.checked, page, pageSize: 24});
            if (current !== sequence || !dialog.open) return;
            managed = Boolean(result.managed);
            restoring = Boolean(result.restoring);
            pages = Math.max(1, Math.ceil(result.total / result.pageSize));
            if (page > pages) { page = pages; return load(); }
            el.rows.replaceChildren(...result.items.map(row));
            el.pages.textContent = page + ' / ' + pages + ' · 共 ' + result.total + ' 张';
            const progress = result.progress;
            const pending = Boolean(progress?.running);
            const failed = progress?.failed || 0;
            const state = [restoring ? '恢复未完成。已恢复的角色可直接打开；处理冲突后请到顶部扩展设置继续恢复。'
                : managed ? '已启用自动收回。' : '尚未启用自动收回，请到顶部扩展设置中的角色库启用。',
                pending ? '正在建立索引，已处理 ' + (progress.done || 0) + ' 项。' : '',
                failed ? failed + ' 项索引失败。' + (progress.errors || []).map(x => x.avatar + '：' + x.message).join('；') : '',
                !result.total && !pending ? (el.search.value ? '没有匹配的角色卡。' : '角色库为空。') : ''];
            el.listState.textContent = state.filter(Boolean).join(' ');
            if (pending) timer = setTimeout(load, 1200);
        } catch (error) {
            if (current !== sequence || !dialog.open) return;
            el.rows.replaceChildren();
            el.pages.textContent = '';
            el.listState.textContent = error.message;
        }
        updateControls();
    }

    el.close.onclick = () => dialog.close();
    dialog.addEventListener('close', () => { clearTimeout(timer); ++sequence; });
    el.search.oninput = () => { ++sequence; clearTimeout(timer); page = 1; timer = setTimeout(load, 200); };
    for (const control of [el.sort, el.dir, el.pin]) control.onchange = () => {
        savePreferences({sort: el.sort.value, dir: el.dir.value, pinnedFirst: el.pin.checked});
        page = 1;
        void load();
    };
    el.prev.onclick = () => { if (page > 1) { --page; void load(); } };
    el.next.onclick = () => { if (page < pages) { ++page; void load(); } };
    el.add.onclick = () => el.files.click();
    el.files.onchange = () => {
        const files = Array.from(el.files.files);
        el.files.value = '';
        void act(async () => {
            let added = 0, skipped = 0;
            const errors = [];
            for (const [index, file] of files.entries()) {
                el.status.textContent = '正在添加 ' + (index + 1) + '/' + files.length + ' · ' + file.name;
                try { await upload(file, el.duplicate.value); ++added; }
                catch (error) {
                    if (error.code === 'CHARACTER_LIBRARY_DUPLICATE' && el.duplicate.value === 'skip') ++skipped;
                    else {
                        errors.push(file.name + '：' + error.message);
                        if (error.status === 409 && error.code !== 'CHARACTER_LIBRARY_DUPLICATE') break;
                    }
                }
            }
            page = 1;
            el.status.textContent = ['已添加 ' + added + ' 张，跳过 ' + skipped + ' 张。', ...errors].join('\n');
        });
    };
    const show = async () => {
        if (!dialog.open) dialog.showModal();
        if (!busy) await load();
    };
    show.refresh = async () => { if (dialog.open && !busy) await load(); };
    return show;
}

