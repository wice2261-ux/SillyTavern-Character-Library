import { confirmAction } from './library.js';
export function createSettings({api,refreshNative,refreshLibrary,version,exportRecovery,importMetadata,worldbook,setKeepFavoritesLoaded}) {
    const panel=document.createElement('div');panel.id='cl-library-settings';panel.className='extension_container';
    panel.innerHTML=`<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header" role="button" tabindex="0" aria-expanded="false">
        <b>角色库</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down" aria-hidden="true"></div></div>
        <div class="inline-drawer-content"><div class="cl-settings-body"><p>角色库版本：${version}</p><p data-el="state" role="status">正在读取账户目录…</p>
        <p data-el="resources"></p><small>预算为当前账户的管理目标，并非浏览器或服务端内存硬上限。原生缓存配置：未知。</small>
        <label><input type="checkbox" data-el="keepFavoritesLoaded"> 保持收藏卡加载</label>
        <small>默认关闭：收藏仅高亮／置顶，与普通卡同样收回。开启后已加载收藏卡不自动收回；归库收藏卡使用时恢复，不批量预载。</small>
        <div class="cl-settings-actions"><button class="menu_button" data-el="migrate">启用自动收回</button><button class="menu_button" data-el="stop">停止后续迁移</button>
        <button class="menu_button" data-el="restore">恢复全部并停用自动收回</button><button class="menu_button" data-el="export">导出恢复资料</button>
        <button class="menu_button" data-el="releaseBasic" hidden>交还基础模式</button><button class="menu_button" data-el="releaseNative" hidden>恢复完整 PNG</button>
        <button class="menu_button" data-el="metadata">导入1.x元数据</button><input type="file" accept=".json" data-el="metadataFile" hidden></div><p data-el="result" role="status"></p>
        <div class="cl-settings-actions"><label><input type="checkbox" data-el="worldbookAuto"> 自动更新专用世界书</label>
        <button class="menu_button" data-el="worldbookUpdate">手动更新世界书</button></div><p data-el="worldbookStatus" role="status"></p>
        <small>仅生成轻量资料，不含正文、不自动绑定。更新会覆盖生成条目的手动修改；关闭自动更新后仍可手动更新。</small></div></div></div>`;
    const el=Object.fromEntries([...panel.querySelectorAll('[data-el]')].map(n=>[n.dataset.el,n]));let busy=false,state,error;
    function update(result,failure){if(failure)error=failure.message;else{error=null;if(result)state=result;}render();}
    let worldbookState=worldbook?.status(),worldbookBusy=false;
    function updateWorldbook(value){worldbookState=value;renderWorldbook();}
    function renderWorldbook(){const s=worldbookState||{};el.worldbookAuto.checked=s.autoUpdate===true;
        el.worldbookAuto.disabled=!worldbook||!state||Boolean(error);
        el.worldbookUpdate.disabled=!worldbook||!state||Boolean(error)||worldbookBusy||Boolean(s.updating);
        el.worldbookStatus.textContent=[s.updating?'更新中':s.error?'更新失败：'+s.error:s.pending?'待核对／待更新':s.name?(s.checked?'本次已核对':'已存在（本次未核对）'):'未创建',
            s.lastSuccessAt?'最后成功：'+new Date(s.lastSuccessAt).toLocaleString():'',s.name?'世界书：'+s.name:''].filter(Boolean).join('；');
    }
    function render(){el.state.textContent=error?'状态读取失败：'+error:state?[
        '原生存储可用；当前账户：'+(state.restoring?'恢复未完成':state.managed?'已托管':'未托管')+'。',
        '协调模式：'+(state.coordination==='tabs'?'同来源同账户标签页增强':'当前页面保护')+'。在线卡：'+state.online+'。',
        state.mode==='enhanced'?'运行模式：增强。角色正文由增强后端按需提供。':'运行模式：基础。角色读写使用宿主原生接口。',
        ({available:'已检测到增强后端。账户接管请使用离线工具。',absent:'未检测到增强后端。',incompatible:'增强后端协议不匹配。',unavailable:'增强后端暂不可用。'})[state.enhancement],
        state.oldDetected?'检测到1.x管理或原生适配，当前账户无法启用基础托管。':'',
        state.overTarget?'在线数据仍超目标：'+(state.keepFavoritesLoaded?'收藏或已知占用':'已知占用')+'受保护，不强行收回。':'',
        state.progress?.running?'迁移进度：'+state.progress.done+'/'+state.progress.total:'',
        ...(state.errors||[]).map(x=>x.avatar+'：'+x.message)].filter(Boolean).join('\n'):'正在读取账户目录…';
        el.resources.textContent=state?(state.keepFavoritesLoaded?'普通在线目标（不含受保护收藏）':'在线目标（含收藏）')+'：'+state.resources.onlineLimit+'；活动数据估算目标：'+state.resources.budgetMiB+' MiB。':'';
        el.keepFavoritesLoaded.checked=state?.keepFavoritesLoaded===true;
        el.keepFavoritesLoaded.disabled=busy||!state||Boolean(error);
        el.migrate.disabled=busy||!state||Boolean(error)||state.mode==='enhanced'||state.restoring||state.progress?.running;
        el.migrate.textContent=state?.managed?'继续整理未迁移角色':'启用自动收回';
        el.restore.disabled=busy||!state||Boolean(error)||state.mode==='enhanced'||(!state.managed&&!state.restoring);
        el.restore.textContent=state?.restoring?'继续恢复剩余角色':'恢复全部并停用自动收回';
        for(const button of [el.releaseBasic,el.releaseNative]){
            button.hidden=state?.mode!=='enhanced';
            button.disabled=busy||Boolean(error);
        }
        el.stop.disabled=!state?.progress?.running;el.export.disabled=!state;el.metadata.disabled=busy||state?.managed;
        renderWorldbook();
    }
    async function refresh(){try{update(await api('/status'));updateWorldbook(worldbook?.status());}catch(e){update(null,e);}}
    async function act(work){if(busy)return;busy=true;render();el.result.textContent='';try{await work();}catch(e){el.result.textContent=e.message;}finally{busy=false;await refresh();await refreshLibrary();}}
    const header=panel.querySelector('.inline-drawer-toggle');header.onclick=()=>{const expanded=header.getAttribute('aria-expanded')!=='true';header.setAttribute('aria-expanded',String(expanded));if(expanded)void refresh();};
    header.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();e.stopPropagation();header.click();}};
    el.migrate.onclick=()=>void act(async()=>{
        const preview=await api('/migrate',{preview:true});
        if(preview.conflicts.length)el.result.textContent='下列卡将保留原位：\n'+preview.conflicts.map(x=>x.avatar+'：'+x.message).join('\n');
        if(!await confirmAction('启用自动收回','当前 '+preview.resident+' 张，收藏 '+preview.favorites+' 张。'+(state.keepFavoritesLoaded?'收藏卡将保留在线。':'闲置收藏卡与普通卡同样归库。')+'新增归档空间约 '+(preview.estimatedBytes/1048576).toFixed(1)+' MiB（原PNG与正文估算，含格式误差）。首次原生列表可能已解析完整卡。可以停止后续迁移。','启用并整理'))return;
        const result=await api('/migrate');update(result);await refreshNative();el.result.textContent='整理结束，失败 '+(result.errors?.length||0)+' 项。';
    });
    el.stop.onclick=()=>void api('/stop').then(refresh);
    function release(mode){return act(async()=>{
        const preview=await api('/release',{mode,apply:false});
        const native=mode==='restore';
        const title=native?'恢复完整 PNG':'交还基础模式';
        const cost=native?'下次启动可能解析整库全文。':'打开归库大卡时会重新使用宿主原生解析。';
        if(!await confirmAction(title,'将交还 '+preview.characters+' 张卡并刷新页面。'+cost,'确认交还'))return;
        await api('/release',{mode,apply:true});
        location.reload();
    });}
    el.releaseBasic.onclick=()=>void release('basic');
    el.releaseNative.onclick=()=>void release('restore');
    el.restore.onclick=()=>void act(async()=>{
        if(!await confirmAction('恢复全部','恢复后会回到原生整库内存开销。卸载插件前须恢复全部。','恢复并停用'))return;
        const result=await api('/restore');el.result.textContent='已恢复 '+result.restored+' 张。'+(result.restoring?'仍有失败，请处理后继续恢复。':'自动收回已停用。');
        try{await refreshNative();}catch(e){el.result.textContent+=' 页面刷新失败：'+e.message;}
    });
    el.export.onclick=()=>void act(exportRecovery);el.metadata.onclick=()=>el.metadataFile.click();
    el.metadataFile.onchange=()=>void act(async()=>{const file=el.metadataFile.files[0];el.metadataFile.value='';if(file){await importMetadata(JSON.parse(await file.text()));el.result.textContent='元数据已读取，将在启用时按精确文件名交接。';}});
    async function worldbookAction(work){if(worldbookBusy)return;worldbookBusy=true;renderWorldbook();
        try{await work();updateWorldbook(worldbook.status());}catch(e){updateWorldbook({...worldbook.status(),error:e.message});}
        finally{worldbookBusy=false;renderWorldbook();}}
    el.worldbookAuto.onchange=async()=>{try{await worldbook.setAutoUpdate(el.worldbookAuto.checked);updateWorldbook(worldbook.status());}
        catch(e){updateWorldbook({...worldbook.status(),error:e.message});}};
    el.worldbookUpdate.onclick=()=>worldbookAction(()=>worldbook.updateNow());
    el.keepFavoritesLoaded.onchange=()=>{const value=el.keepFavoritesLoaded.checked;return act(()=>setKeepFavoritesLoaded(value));};
    render();return {panel,update,refresh,updateWorldbook};
}
