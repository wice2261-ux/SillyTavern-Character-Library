import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';
export function exportMetadata(db,account) {
    const records=db.prepare("SELECT id,avatar,name,imported,played,favorite FROM cards WHERE state!='reserved'").all()
        .map(row=>({...row,favorite:Boolean(row.favorite)}));
    return {format:'character-library-1-metadata',account,records};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
    const [accountRoot,output]=process.argv.slice(2);
    if(!accountRoot||!output){console.error('用法：node export-v1-metadata.mjs <账户根目录> <新输出.json>\n先停止旧酒馆；此工具只读SQLite，不读取PNG或聊天。需要支持node:sqlite的Node。');process.exitCode=1;}
    else{
        let db;try{
            db=new DatabaseSync(path.join(path.resolve(accountRoot),'character-library','index.sqlite'),{readOnly:true});
            const data=exportMetadata(db,path.basename(path.resolve(accountRoot)));
            fs.writeFileSync(output,JSON.stringify(data,null,2),{flag:'wx'});console.log('已导出 '+data.records.length+' 条：'+path.resolve(output));
        }catch(e){console.error(e.message);process.exitCode=1;}finally{db?.close();}
    }
}
