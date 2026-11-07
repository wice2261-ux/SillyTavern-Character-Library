import { confirmAction } from './library.js';

export function createSettings({ api, preflight, sync, refreshNative, refreshLibrary, version }) {
    const panel = document.createElement('div');
    panel.id = 'cl-library-settings';
    panel.className = 'extension_container';
    panel.innerHTML = `<div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header" role="button" tabindex="0" aria-expanded="false" aria-controls="cl-library-settings-content">
            <b>角色库</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down" aria-hidden="true"></div>
        </div>
        <div class="inline-drawer-content" id="cl-library-settings-content">
            <div class="cl-settings-body">
                <p data-el="version"></p>
                <p data-el="state" role="status">正在检查服务端…</p>
                <p data-el="resources"></p>
                <small>资源预算由所有托管账户共用。活动数据估算预算含原生缓存和切换预留，不是浏览器或容器内存硬上限；调整请使用服务端环境变量。</small>
                <p>自动收回将闲置卡归库，收藏及使用中的卡保留。这是当前账户的角色管理设置。</p>
                <div class="cl-settings-actions">
                    <button class="menu_button" type="button" data-el="migrate" disabled>启用自动收回</button>
                    <button class="menu_button" type="button" data-el="restore" disabled>恢复全部并停用自动收回</button>
                </div>
                <p data-el="result" role="status"></p>
            </div>
        </div>
    </div>`;
    const el = Object.fromEntries([...panel.querySelectorAll('[data-el]')].map(node => [node.dataset.el, node]));
    const header = panel.querySelector('.inline-drawer-toggle');
    el.version.textContent = '前端扩展版本：正在读取…';
    void version.then(value => { el.version.textContent = '前端扩展版本：' + value; });
    let state, unavailable = '', busy = false;

    function render() {
        if (unavailable) {
            el.state.textContent = '服务端不可用：' + unavailable + '\n适配及当前账户状态暂时无法确认。';
            el.resources.textContent = '资源配置：服务端不可用，暂时无法读取。';
        } else if (state) {
            const progress = state.progress;
            el.state.textContent = ['服务端可用；适配' + (state.adapted ? '已就绪。' : '未就绪。'),
                state.restoring ? '当前账户：恢复未完成，请处理冲突后继续恢复。' : state.managed ? '当前账户：已托管，自动收回已启用。' : '当前账户：未托管。',
                progress?.running ? '正在建立索引，已处理 ' + (progress.done || 0) + ' 项。' : '',
                progress?.failed ? progress.failed + ' 项索引失败。' + describeFiles(progress.errors || []) : ''].filter(Boolean).join('\n');
            const resources = state.resources;
            el.resources.textContent = resources
                ? '未收藏常驻数量上限：' + resources.onlineLimit + '；活动数据估算预算：' + resources.budgetMiB + ' MiB。'
                : '资源配置：当前服务端未提供。';
        }
        const ready = Boolean(state) && !unavailable && !busy;
        el.migrate.disabled = !ready || !state.adapted || state.managed || state.restoring;
        el.restore.disabled = !ready || !state.adapted || !(state.managed || state.restoring);
        el.restore.textContent = state?.restoring ? '继续恢复剩余角色' : '恢复全部并停用自动收回';
    }

    // Full status replaces previous values; operation/heartbeat results only patch account state.
    function update(result, error, full = false) {
        if (error) { state = undefined; unavailable = error.message; }
        else {
            if (full) { state = result; unavailable = ''; }
            else if (state) {
                for (const key of ['managed', 'restoring', 'progress']) {
                    if (Object.hasOwn(result, key)) state[key] = result[key];
                }
            }
        }
        render();
    }

    async function refresh() {
        try { await api('/status'); }
        catch { /* The shared API wrapper publishes the request error. */ }
    }

    header.addEventListener('click', () => {
        const expanded = header.getAttribute('aria-expanded') !== 'true';
        header.setAttribute('aria-expanded', String(expanded));
        if (expanded) void refresh();
    });
    header.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            event.stopPropagation();
            header.click();
        }
    });

    async function act(operation) {
        if (busy) return;
        busy = true;
        el.result.textContent = '';
        render();
        try { await operation(); }
        catch (error) { el.result.textContent = error.message; }
        finally {
            await refresh();
            busy = false;
            render();
            await refreshLibrary();
        }
    }

    el.migrate.onclick = () => void act(async () => {
        await preflight();
        const preview = await api('/migrate', { preview:true });
        if (preview.conflicts?.length) {
            el.result.textContent = '请先处理下列文件再启用自动收回：\n' + describeFiles(preview.conflicts);
            return;
        }
        if (!await confirmAction('启用自动收回', '酒馆当前载入 ' + preview.resident + ' 张，已收藏 ' + preview.favorites + ' 张。闲置卡可收回到库中，收藏及使用中的卡保留。', '启用并整理')) return;
        const result = await api('/migrate', { preview:false });
        await sync(result);
        el.result.textContent = '已启用自动收回。启用前已打开的窗口请刷新后再编辑角色。';
    });
    el.restore.onclick = () => void act(async () => {
        if (!await confirmAction('恢复全部角色', '将归库角色移回酒馆并停用自动收回。原生角色列表可能占用更多内存。', '恢复并停用')) return;
        await preflight();
        const result = await api('/restore', {});
        await sync(result);
        el.result.textContent = '本次已恢复 ' + result.restored + ' 张。' + (result.restoring
            ? '\n恢复未完成，请处理后重试：\n' + describeFiles(result.remaining)
            : '自动收回已停用。');
        // Native refresh may prepare the active chat: sync's serial queue must be released first.
        try { await refreshNative(); }
        catch (error) { el.result.textContent += '\n文件恢复结果已保留，页面刷新失败：' + error.message; }
    });
    return { panel, update, refresh };
}

function describeFiles(files) {
    return files.map(({avatar, message}) => avatar + '：' + message).join('\n');
}
