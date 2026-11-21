export function buildRecovery(directory) {
    const details=new Map();
    for(const row of Object.values(directory.records))for(const [role,name] of [
        ['original',row.original],['current',row.current],['previous',row.previous],['operation.pending',row.operation?.pending]]){
        if(!name)continue;
        if(!details.has(name))details.set(name,{name,references:[]});
        details.get(name).references.push({id:row.id,avatar:row.avatar,role});
    }
    return {format:'character-library-2-recovery',directory,files:[...details.keys()],fileDetails:[...details.values()],
        instructions:'此资料是目录和文件清单，不含全文。备份完整酒馆账户及user/files中的所列文件。original是原PNG，current是当前归档，previous是必要前一版，operation.pending属于未完成操作，不能直接视为最新正文。重新安装插件后继续恢复；不得仅用原始PNG覆盖编辑后的卡。'};
}
