export function parseReplacement(bytes,format){
    const decoder=new TextDecoder();let text;
    if(format==='json')text=decoder.decode(bytes).replace(/^\uFEFF/,'');
    else{
        if(bytes.length<8||![137,80,78,71,13,10,26,10].every((b,i)=>bytes[i]===b))throw Error('不是PNG角色卡');
        const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let found;
        for(let offset=8;offset+12<=bytes.length;){
            const length=view.getUint32(offset);if(offset+12+length>bytes.length)throw Error('PNG文件不完整');
            const type=decoder.decode(bytes.subarray(offset+4,offset+8));
            if(type==='tEXt'){
                const data=bytes.subarray(offset+8,offset+8+length),zero=data.indexOf(0),key=decoder.decode(data.subarray(0,zero));
                if(zero>=0&&['chara','ccv3'].includes(key)){
                    const raw=atob(decoder.decode(data.subarray(zero+1))),decoded=Uint8Array.from(raw,c=>c.charCodeAt(0));
                    if(!found||key==='ccv3')found={key,text:decoder.decode(decoded)};
                }
            }
            offset+=12+length;
        }
        if(!found)throw Error('PNG没有可读取的chara/ccv3文本；原卡未改动');text=found.text;
    }
    const card=JSON.parse(text);if(!card||typeof card!=='object'||!(card.data?.name||card.name))throw Error('替换卡缺少角色名');
    return card;
}
export function replacementForm(payload,file){
    const data=new FormData();
    for(const [key,value]of Object.entries(payload)){
        if(value===undefined)continue;
        if(key==='alternate_greetings'){for(const text of value||[])data.append(key,text);}
        else if(key==='tags'&&Array.isArray(value)&&value.length){for(const tag of value)data.append('tags[]',tag);}
        else if(key==='tags')data.set(key,Array.isArray(value)?'':value);
        else data.set(key,typeof value==='string'?value:JSON.stringify(value));
    }
    data.set('avatar',file,file.name);return data;
}
