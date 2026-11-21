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

export function createLibrary({ api, upload, openChat, sync, notifyDeleted, preferences, savePreferences, preflight,onBusyChange=()=>{} }) {
    const dialog = document.createElement('dialog');
    dialog.className = 'cl-library';
    dialog.setAttribute('aria-label', '角色库');
    dialog.innerHTML = `<div class="cl-layout">
        <header class="cl-header"><h2>角色库</h2><button type="button" class="menu_button" data-el="close">关闭</button></header>
        <div class="cl-tools">
            <input class="text_pole cl-search" data-el="search" type="search" aria-label="按角色名、文件名或标签搜索" placeholder="搜索角色名、文件名或标签">
            <label>抽卡数量<select data-el="drawCount">${Array.from({length:12},(_,i)=>'<option>'+(i+1)+'</option>').join('')}</select></label>
            <button type="button" class="menu_button" data-el="draw">抽卡</button>
            <button type="button" class="menu_button" data-el="back" hidden>返回列表</button>
            <select data-el="sort" aria-label="排序字段"><option value="imported">导入酒馆时间</option><option value="played">游玩时间</option><option value="name">名称</option><option value="size">文件大小</option></select>
            <select data-el="dir" aria-label="排序方向"><option value="desc">降序</option><option value="asc">升序</option></select>
            <label><input data-el="pin" type="checkbox" checked>收藏置顶</label>
        </div>
        <div class="cl-tools"><button type="button" class="menu_button" data-el="add">添加角色卡</button>
            <select data-el="duplicate" aria-label="同名文件处理"><option value="rename">同名另存</option><option value="skip">同名跳过</option><option value="replace">同名替换</option></select>
            <input data-el="files" hidden type="file" multiple accept=".png,.json,image/png,application/json">
        </div>
        <div class="cl-tools"><label><input type="checkbox" data-el="selectPage">选择本页</label>
            <button type="button" class="menu_button" data-el="batchFavorite">收藏所选</button>
            <button type="button" class="menu_button" data-el="batchUnfavorite">取消所选收藏</button>
            <button type="button" class="menu_button" data-el="batchDelete">删除所选（保留聊天）</button></div>
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
    let managed = false, restoring = false, enhanced = false;
    let drawing = false;
    el.drawCount.value = String(Math.min(12, Math.max(1, Math.trunc(Number(preferences.drawCount)) || 3)));
    const selected = new Map();let visibleItems=[];

    function updateControls() {
        for (const key of ['sort','dir','search','pin']) el[key].disabled = busy;
        el.add.disabled = el.duplicate.disabled = busy || restoring;
        el.prev.disabled = busy || drawing || page <= 1;
        el.next.disabled = busy || drawing || page >= pages;
        el.draw.disabled = el.drawCount.disabled = el.back.disabled = busy;
        el.draw.textContent = drawing ? '再抽一次' : '抽卡';
        el.back.hidden = !drawing;
        for (const node of el.rows.querySelectorAll('button')) node.disabled = busy || (restoring && node.hasAttribute('data-needs-management'));
        el.selectPage.disabled = busy || drawing;
        for(const key of ['batchFavorite','batchUnfavorite','batchDelete'])el[key].disabled=busy||drawing||restoring||!selected.size;
    }

    async function act(operation) {
        if (busy) return;
        busy = true;
        onBusyChange(true);
        ++sequence;
        clearTimeout(timer);
        updateControls();
        el.status.textContent = '';
        try { await operation(); }
        catch (error) { el.status.textContent = error.message; }
        finally {
            busy = false;
            onBusyChange(false);
            updateControls();
            if (dialog.open && !drawing) await load();
        }
    }

    function row(item) {
        const fromDraw = drawing;
        const node = document.createElement('li');
        node.className = 'cl-row';
        const select=document.createElement('input');select.type='checkbox';select.setAttribute('aria-label','选择 '+item.name);select.checked=selected.has(item.id);
        select.onchange=()=>{if(select.checked)selected.set(item.id,{id:item.id,avatar:item.avatar,name:item.name});else selected.delete(item.id);updateControls();};
        const image = document.createElement('img');
        image.className = 'cl-avatar';
        image.loading = 'lazy';
        image.alt = '';
        image.src = '/thumbnail?type=avatar&file=' + encodeURIComponent(item.avatar);
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
            const result = await api('/favorite', {avatar: item.avatar, id:item.id, favorite: !item.favorite});
            await sync(result, { avatar: item.avatar, favorite: !item.favorite });
        }), (item.favorite ? '取消收藏 ' : '收藏并高亮 ') + item.name);
        star.classList.add('cl-star');
        star.setAttribute('aria-pressed', String(Boolean(item.favorite)));
        const open = button('打开聊天', () => act(async () => {
            if (fromDraw) await api('/draw/check', {avatar:item.avatar,id:item.id});
            await openChat(item.avatar);
            dialog.close();
        }), '打开与 ' + item.name + ' 的聊天');
        const remove = button('删除', () => act(async () => {
            const choice = await confirmAction('删除角色卡', item.name + '（' + item.avatar + '）。保留单聊记录。', '删除角色卡', !enhanced);
            if (!choice) return;
            await preflight();
            const result = await api('/delete', {avatar: item.avatar, id: item.id, deleteChats: choice.deleteChats});
            await notifyDeleted(result);
            await sync(result, {deleted: item.avatar});
        }), '删除 ' + item.name);
        star.dataset.needsManagement = remove.dataset.needsManagement = '';
        if (!item.online) open.dataset.needsManagement = '';
        if (drawing) node.append(image, info, open);
        else node.append(select, image, info, star, open, remove);
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
            enhanced = result.mode==='enhanced';
            restoring = Boolean(result.restoring);
            pages = Math.max(1, Math.ceil(result.total / result.pageSize));
            if (page > pages) { page = pages; return load(); }
            visibleItems=result.items;el.rows.replaceChildren(...result.items.map(row));el.selectPage.checked=false;
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

    async function draw() {
        if (busy) return;
        clearTimeout(timer);
        const request = ++sequence;
        drawing = true;
        visibleItems = [];
        el.rows.replaceChildren();
        el.pages.textContent = '';
        el.listState.textContent = '正在抽卡…';
        updateControls();
        try {
            const result = await api('/draw', {search:el.search.value.trim(),count:Number(el.drawCount.value)});
            if (request !== sequence || !dialog.open) return;
            restoring = Boolean(result.restoring);
            el.rows.replaceChildren(...result.items.map(row));
            el.listState.textContent = result.items.length ? '抽中 '+result.items.length+' 张角色卡。' : '没有匹配的角色卡。';
        } catch (error) {
            if (request === sequence && dialog.open) el.listState.textContent = error.message;
        }
        updateControls();
    }
    el.draw.onclick = () => void draw();
    el.back.onclick = () => { drawing = false; void load(); };
    el.drawCount.onchange = () => savePreferences({drawCount:Number(el.drawCount.value)});
    el.close.onclick = () => dialog.close();
    dialog.addEventListener('close', () => { clearTimeout(timer); ++sequence; });
    el.search.oninput = () => { drawing = false; ++sequence; clearTimeout(timer); page = 1; timer = setTimeout(load, 200); };
    for (const control of [el.sort, el.dir, el.pin]) control.onchange = () => {
        savePreferences({sort: el.sort.value, dir: el.dir.value, pinnedFirst: el.pin.checked});
        drawing = false;
        page = 1;
        void load();
    };
    el.prev.onclick = () => { if (page > 1) { --page; void load(); } };
    el.next.onclick = () => { if (page < pages) { ++page; void load(); } };
    el.add.onclick = () => el.files.click();
    el.selectPage.onchange=()=>{for(const item of visibleItems){if(el.selectPage.checked)selected.set(item.id,{id:item.id,avatar:item.avatar,name:item.name});else selected.delete(item.id);}el.rows.replaceChildren(...visibleItems.map(row));updateControls();};
    async function batch(action){
        const items=[...selected.values()];if(action==='delete'&&!await confirmAction('批量删除角色卡','删除所选 '+items.length+' 张，保留聊天；群引用或占用中的角色将报告失败。','删除所选'))return;
        let done=0;const errors=[];
        for(const item of items)try{await preflight();await api('/'+action,{...item,deleteChats:false,favorite:action==='favorite'});selected.delete(item.id);done++;}
        catch(error){errors.push(item.avatar+'：'+error.message);}
        await sync();el.status.textContent='成功 '+done+' 项。'+errors.join('\n');
    }
    el.batchFavorite.onclick=()=>void act(()=>batch('favorite'));
    el.batchUnfavorite.onclick=()=>void act(()=>batch('unfavorite'));
    el.batchDelete.onclick=()=>void act(()=>batch('delete'));
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
        drawing = false;
        if (!dialog.open) dialog.showModal();
        if (!busy) await load();
    };
    show.refresh = async () => { if (dialog.open && !busy && !drawing) await load(); };
    return show;
}

