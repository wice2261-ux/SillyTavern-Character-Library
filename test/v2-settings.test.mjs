import test from 'node:test';
import assert from 'node:assert/strict';
import {createSettings} from '../extension/settings.js';
test('worldbook settings keep manual update available while automatic updates are off',async()=>{
    const previous=globalThis.document,nodes={},header={setAttribute(){},getAttribute(){return 'false';}};
    globalThis.document={createElement:()=>({set innerHTML(value){for(const [,name] of value.matchAll(/data-el="([^"]+)"/g))nodes[name]={dataset:{el:name}};},
        querySelectorAll:()=>Object.values(nodes),querySelector:()=>header})};
    try{
        let updates=0,worldState={autoUpdate:false};const auto=[],favoritePolicy=[];
        const ui=createSettings({version:'2.1.0',api:async()=>({resources:{onlineLimit:8,budgetMiB:192},online:0}),refreshLibrary:async()=>{},
            worldbook:{status:()=>worldState,updateNow:async()=>{updates++;},setAutoUpdate:async value=>auto.push(value)},
            setKeepFavoritesLoaded:async value=>favoritePolicy.push(value)});
        await ui.refresh();assert.ok(nodes.worldbookUpdate,'manual update control exists');
        assert.equal(nodes.worldbookAuto.checked,false);assert.equal(nodes.worldbookUpdate.disabled,false);
        assert.ok(nodes.keepFavoritesLoaded,'favorite protection setting exists');assert.equal(nodes.keepFavoritesLoaded.checked,false);
        nodes.keepFavoritesLoaded.checked=true;await nodes.keepFavoritesLoaded.onchange();assert.deepEqual(favoritePolicy,[true]);
        await nodes.worldbookUpdate.onclick();assert.equal(updates,1);assert.deepEqual(auto,[]);
        nodes.worldbookAuto.checked=true;await nodes.worldbookAuto.onchange();assert.deepEqual(auto,[true]);
        worldState={autoUpdate:true,name:'Saved book',lastSuccessAt:123};await ui.refresh();
        assert.equal(nodes.worldbookAuto.checked,true);assert.match(nodes.worldbookStatus.textContent,/Saved book/);
    }finally{globalThis.document=previous;}
});
