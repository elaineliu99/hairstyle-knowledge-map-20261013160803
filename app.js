/* 发型知识导图：零依赖本地应用。所有业务数据集中在 state，方便未来替换同步层。 */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const uid = (prefix = 'id') => `${prefix}_${(crypto.randomUUID ? crypto.randomUUID() : Date.now() + '_' + Math.random().toString(16).slice(2))}`;
const now = () => new Date().toISOString();
const clone = (v) => typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v));
const esc = (v = '') => String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const DB_NAME = 'hair-knowledge-map-db';
let db;
let state;
let currentView = 'map';
let selectedNodeId = null;
let noteFilter = 'pending';
let searchFilter = 'all';
let editingNoteId = null;
let noteDraft = null;
let organizeNoteId = null;
let organizeMode = 'attach';
let confirmAction = null;
let saveTimer;
let toastTimer;
let history = { past: [], future: [] };
let viewport = { x: 0, y: 0, scale: 1 };
let drag = null;
let connectionMode = false;
let connectionSourceId = null;
let pendingConnectionTargetId = null;
let connectionStyle = {lineType:'curve',dash:'solid',arrow:'end'};
let selectedElementId = null;
let pendingNodeAction = null;
let linkTargetNodeId = null;

function makeSample() {
  const mapId = uid('map');
  const labels = ['技术','女发','裁剪','九合体系','乐哥','低层次'];
  const root = labels.map((title, i) => ({ id: uid('node'), parentId: i ? null : null, title, x: i * 220, y: 0, color: ['#b8d8f8','#d9eafb','#cce6dc','#f5dfbd','#ead9f2','#f5d3d7'][i], note: i === 5 ? '示例节点：这里可以记录低层次的分区、角度与操作要点。' : '', tags: i === 5 ? ['示例','裁剪'] : [], images: [], links: [], collapsed: false }));
  labels.forEach((_, i) => { if (i > 0) root[i].parentId = root[i - 1].id; });
  root[0].x = 0; root[0].y = 0;
  return { id: mapId, name: '示例 · 技术体系', createdAt: now(), updatedAt: now(), rootId: root[0].id, nodes: root, elements: [], manualLayout: false };
}

function freshState() {
  const sample = makeSample();
  return { version: 1, maps: [sample], notes: [], lastMapId: sample.id, updatedAt: now() };
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('app', { keyPath: 'key' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function dbGet() {
  return new Promise((resolve, reject) => { const req = db.transaction('app').objectStore('app').get('state'); req.onsuccess = () => resolve(req.result?.value || null); req.onerror = () => reject(req.error); });
}
function dbPut(value) {
  return new Promise((resolve, reject) => { const req = db.transaction('app','readwrite').objectStore('app').put({key:'state', value}); req.onsuccess = resolve; req.onerror = () => reject(req.error); });
}
function setSave(status, text) { const dot = $('.save-dot'); dot.className = `save-dot ${status === 'saving' ? 'saving' : status === 'error' ? 'error' : ''}`; $('#saveText').textContent = text; }
function scheduleSave(message = '已保存') {
  setSave('saving', '保存中…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => { try { state.updatedAt = now(); await dbPut(state); setSave('ok', message); refreshStats(); } catch (e) { console.error(e); setSave('error', '保存失败'); toast('保存失败：请先导出备份，当前输入仍保留'); } }, 250);
}
function snapshot() { history.past.push(clone(state)); if (history.past.length > 50) history.past.shift(); history.future = []; updateUndoButtons(); }
function undo() { if (!history.past.length) return; history.future.push(clone(state)); state = history.past.pop(); selectedNodeId = null; selectedElementId = null; renderAll(); scheduleSave('已撤销并保存'); }
function redo() { if (!history.future.length) return; history.past.push(clone(state)); state = history.future.pop(); selectedNodeId = null; selectedElementId = null; renderAll(); scheduleSave('已重做并保存'); }

function currentMap() { return state.maps.find(m => m.id === state.lastMapId) || state.maps[0] || null; }
function nodeById(map, id) { return map?.nodes.find(n => n.id === id); }
function childrenOf(map, id) { return map.nodes.filter(n => n.parentId === id); }
function getPath(map, id) { const out=[]; let n=nodeById(map,id), guard=0; while(n && guard++ < map.nodes.length+2){ out.unshift(n.title); n=nodeById(map,n.parentId); } return out; }
function descendants(map, id) { const out=[]; const walk = pid => childrenOf(map,pid).forEach(n => { out.push(n.id); walk(n.id); }); walk(id); return out; }
function branchSide(map, node, fallback='right') {
  let current=node, guard=0;
  while(current&&guard++<map.nodes.length+2){
    if(current.parentId===map.rootId)return current.side==='left'?'left':'right';
    current=nodeById(map,current.parentId);
  }
  return fallback;
}
function chooseRootSide(map) {
  const root=nodeById(map,map.rootId);
  if(!root)return 'right';
  const children=childrenOf(map,root.id);
  const left=children.filter(n=>n.side==='left').length;
  const right=children.length-left;
  // 原有结构默认保留在右侧；右侧已有较多一级分支后，新增分支自动从左侧展开。
  if(left===0&&right<5)return 'right';
  return left<right?'left':'right';
}
function visibleNodes(map) { const hidden = new Set(); map.nodes.forEach(n => { if(n.collapsed) descendants(map,n.id).forEach(id => hidden.add(id)); }); return map.nodes.filter(n => !hidden.has(n.id)); }
function nodeStats(n) { return [n.note?.trim() ? '笔记' : '', n.images?.length ? `${n.images.length}图` : '', n.links?.length ? `${n.links.length}链` : ''].filter(Boolean).join(' · '); }

const originalMapTree = {title: '技术', children: []};

function normalizeMap(map) {
  map.nodes = (map.nodes || []).map(n => ({...n, x:Number.isFinite(n.x)?n.x:0,y:Number.isFinite(n.y)?n.y:0,color:n.color||'#d9eafb',side:n.side==='left'||(!n.side&&n.parentId===map.rootId&&Number(n.x)<0)?'left':'right',subtitle:stripRichText(n.subtitle||n.note||''),subtitleStyle:{bold:!!n.subtitleStyle?.bold,underline:!!n.subtitleStyle?.underline,strike:!!n.subtitleStyle?.strike,color:n.subtitleStyle?.color||'#5f7891',size:Number(n.subtitleStyle?.size)||11},titleStyle:{bold:!!n.titleStyle?.bold,underline:!!n.titleStyle?.underline,strike:!!n.titleStyle?.strike,color:n.titleStyle?.color||'#203b5b',size:Number(n.titleStyle?.size)||14},showImage:!!n.showImage,note:'',tags:n.tags||[],images:n.images||[],links:n.links||[],collapsed:!!n.collapsed}));
  map.elements = (map.elements || []).map(el => {
    if (el.type !== 'symbol' || !map.nodes.length) return el;
    if (el.anchorNodeId) {
      const dx=Number(el.dx),dy=Number(el.dy), overlaps=Math.abs(dx)<100&&Math.abs(dy)<50;
      if (!el.manualPosition || overlaps) return {...el,dx:0,dy:-78,manualPosition:false};
      return el;
    }
    const ex = Number(el.x), ey = Number(el.y);
    if (!Number.isFinite(ex) || !Number.isFinite(ey)) return el;
    const anchor = map.nodes.reduce((best,n) => {
      const d = Math.hypot(n.x - ex, n.y - ey);
      return !best || d < best.distance ? {node:n,distance:d} : best;
    }, null)?.node;
    if (!anchor) return el;
    return {...el,anchorNodeId:anchor.id,dx:0,dy:-78,manualPosition:false};
  });
  if(typeof map.manualLayout !== 'boolean') map.manualLayout = map.layoutMode === 'free'; delete map.layoutMode; return map;
}

function layoutMap(map) {
  if (!map?.nodes?.length) return;
  const root = nodeById(map,map.rootId) || map.nodes[0];
  if (!root) return;
  if (!map.rootId) map.rootId = root.id;

  // 节点固定为 160×62；118 的纵向步长会留下 56px 空白，
  // 同时给备注、小字和连线保留足够的视觉空间。
  const HORIZONTAL_STEP = 235;
  const VERTICAL_STEP = 118;
  let nextY = 0;
  const placed = new Set();

  // 以叶子节点为基准逐个占用纵向位置，再把父节点放在子树中线。
  // 这样新增同级节点会自然排到当前分支的末端，不会挤到已有节点上。
  const placeTree = (node, depth, inheritedSide='right') => {
    if (!node || placed.has(node.id)) return null;
    placed.add(node.id);
    const side = depth === 1 ? ((node.side === 'left' || (!node.side && node.x < 0) || node.x < 0) ? 'left' : 'right') : inheritedSide;
    const kids = childrenOf(map, node.id).filter(child => !placed.has(child.id));
    if (!kids.length) {
      const y = nextY;
      nextY += VERTICAL_STEP;
      node.x = depth === 0 ? 0 : (side === 'left' ? -1 : 1) * depth * HORIZONTAL_STEP;
      node.y = y;
      return {min:y, max:y};
    }
    const bounds = kids.map(child => placeTree(child, depth + 1, side)).filter(Boolean);
    const min = Math.min(...bounds.map(b => b.min));
    const max = Math.max(...bounds.map(b => b.max));
    node.x = depth === 0 ? 0 : (side === 'left' ? -1 : 1) * depth * HORIZONTAL_STEP;
    node.y = (min + max) / 2;
    return {min, max};
  };

  placeTree(root, 0);

  // 独立主题或历史数据中的断开节点也要按完整子树排布，
  // 不能再简单地全部放到 x=0、y=120 的同一片区域。
  const roots = map.nodes.filter(node => {
    if (placed.has(node.id)) return false;
    return !node.parentId || !nodeById(map, node.parentId);
  });
  roots.forEach(node => placeTree(node, 0));

  // 极端情况下若数据里存在环，保证仍然给未放置节点一个不重叠的位置，
  // 避免布局递归卡死，也不破坏用户已有内容。
  map.nodes.filter(node => !placed.has(node.id)).forEach(node => {
    node.x = 0;
    node.y = nextY;
    nextY += VERTICAL_STEP;
    placed.add(node.id);
  });
  map.updatedAt = now();
}
function isReachable(map, rootId, targetId) { let found=false; const walk=id=>{if(id===targetId) found=true; childrenOf(map,id).forEach(n=>walk(n.id));}; walk(rootId); return found; }
function fitViewport() {
  const map=currentMap(), svg=$('#canvas'); if(!map || !svg) return;
  const nodes=visibleNodes(map); if(!nodes.length) return;
  const rect=svg.getBoundingClientRect(); const minX=Math.min(...nodes.map(n=>n.x-100)), maxX=Math.max(...nodes.map(n=>n.x+100)), minY=Math.min(...nodes.map(n=>n.y-55)), maxY=Math.max(...nodes.map(n=>n.y+55));
  const pad=70, sx=(rect.width-pad*2)/(maxX-minX||1), sy=(rect.height-pad*2)/(maxY-minY||1); viewport.scale=Math.max(.35,Math.min(1.25,sx,sy)); viewport.x=rect.width/2-((minX+maxX)/2)*viewport.scale; viewport.y=rect.height/2-((minY+maxY)/2)*viewport.scale; applyViewport();
}
function applyViewport() { $('#world').setAttribute('transform',`translate(${viewport.x} ${viewport.y}) scale(${viewport.scale})`); $('#zoomLabel').textContent=`${Math.round(viewport.scale*100)}%`; }
function worldPoint(evt) { const r=$('#canvas').getBoundingClientRect(); return {x:(evt.clientX-r.left-viewport.x)/viewport.scale,y:(evt.clientY-r.top-viewport.y)/viewport.scale}; }
function zoomAt(factor, clientX, clientY) { const r=$('#canvas').getBoundingClientRect(); const cx=clientX ?? r.left+r.width/2, cy=clientY ?? r.top+r.height/2; const before={x:(cx-r.left-viewport.x)/viewport.scale,y:(cy-r.top-viewport.y)/viewport.scale}; viewport.scale=Math.max(.3,Math.min(2.4,viewport.scale*factor)); viewport.x=cx-r.left-before.x*viewport.scale; viewport.y=cy-r.top-before.y*viewport.scale; applyViewport(); }
function connectionEndpoints(from, to) {
  const dx = to.x - from.x, dy = to.y - from.y;
  if (!dx && !dy) return {start: {...from}, end: {...to}};
  const edgePoint = (center, vx, vy) => {
    const sx = Math.abs(vx) ? 80 / Math.abs(vx) : Infinity;
    const sy = Math.abs(vy) ? 31 / Math.abs(vy) : Infinity;
    const scale = Math.min(sx, sy);
    return {x: center.x + vx * scale, y: center.y + vy * scale};
  };
  return {start: edgePoint(from, dx, dy), end: edgePoint(to, -dx, -dy)};
}

function renderMapSelect() { const sel=$('#mapSelect'); sel.innerHTML=state.maps.map(m=>`<option value="${m.id}">${esc(m.name)}</option>`).join(''); if(currentMap()) sel.value=currentMap().id; $('#emptyCanvas').hidden=!!state.maps.length; }
function renderCanvas() {
  const map=currentMap(), edges=$('#edges'), extras=$('#extras'), nodes=$('#nodes'); edges.innerHTML=''; extras.innerHTML=''; nodes.innerHTML=''; if(!map){ $('#emptyCanvas').hidden=false; return; } $('#emptyCanvas').hidden=true;
  const visible=visibleNodes(map), visibleIds=new Set(visible.map(n=>n.id)), symbolGroups=[];
  visible.forEach(n=>{const p=nodeById(map,n.parentId); if(p&&visibleIds.has(p.id)){ const path=document.createElementNS('http://www.w3.org/2000/svg','path'); const points=connectionEndpoints(p,n); const dir=n.x>=p.x?1:-1; path.setAttribute('class','edge'); path.setAttribute('d',`M ${points.start.x} ${points.start.y} C ${p.x+145*dir} ${p.y}, ${n.x-145*dir} ${n.y}, ${points.end.x} ${points.end.y}`); edges.appendChild(path); }});
  (map.elements||[]).forEach(el=>{
    if(el.type==='connection'){
      const from=nodeById(map,el.from),to=nodeById(map,el.to);if(!from||!to)return;
      const {start,end}=connectionEndpoints(from,to), midX=(start.x+end.x)/2;
      const path=document.createElementNS('http://www.w3.org/2000/svg','path');let d;
      if(el.lineType==='straight') d=`M ${start.x} ${start.y} L ${end.x} ${end.y}`;
      else if(el.lineType==='orthogonal') d=`M ${start.x} ${start.y} L ${midX} ${start.y} L ${midX} ${end.y} L ${end.x} ${end.y}`;
      else d=`M ${start.x} ${start.y} C ${midX} ${start.y}, ${midX} ${end.y}, ${end.x} ${end.y}`;
      path.setAttribute('class',`edge element-connection ${el.id===selectedElementId?'selected':''}`);path.setAttribute('data-element-id',el.id);path.setAttribute('d',d);path.setAttribute('role','button');path.setAttribute('tabindex','0');path.setAttribute('aria-label','连接线');
      if(el.dash==='dashed')path.setAttribute('stroke-dasharray','9 7');if(el.dash==='dotted')path.setAttribute('stroke-dasharray','2 7');
      if(el.arrow==='end'||el.arrow==='both')path.setAttribute('marker-end','url(#arrowHead)');if(el.arrow==='start'||el.arrow==='both')path.setAttribute('marker-start','url(#arrowHead)');extras.appendChild(path);
      const selectConnection=event=>{selectedElementId=el.id;selectedNodeId=null;renderCanvas();renderInspector();event.stopPropagation();};
      path.addEventListener('click',selectConnection);path.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){selectConnection(event);event.preventDefault();}});
      if(el.label){const label=document.createElementNS('http://www.w3.org/2000/svg','text');label.setAttribute('class','node-meta');label.setAttribute('x',midX);label.setAttribute('y',(start.y+end.y)/2-7);label.setAttribute('text-anchor','middle');label.textContent=el.label;extras.appendChild(label);}
    }else if(el.type==='symbol'){
      const anchor=nodeById(map,el.anchorNodeId);const symbolDx=el.manualPosition?Number(el.dx??0):0;const symbolDy=el.manualPosition?Number(el.dy??-78):-78;const symbolX=anchor?anchor.x+symbolDx:Number(el.x||0);const symbolY=anchor?anchor.y+symbolDy:Number(el.y||0);
      const group=document.createElementNS('http://www.w3.org/2000/svg','g');group.dataset.elementId=el.id;group.setAttribute('data-element-id',el.id);group.setAttribute('class',`symbol-element ${el.id===selectedElementId?'selected':''}`);group.setAttribute('transform',`translate(${symbolX} ${symbolY})`);group.setAttribute('role','button');group.setAttribute('tabindex','0');group.setAttribute('aria-label',`符号 ${el.symbol||'★'}`);
      const circle=document.createElementNS('http://www.w3.org/2000/svg','circle');circle.setAttribute('r','18');circle.setAttribute('fill',el.color||'#fff4c7');circle.setAttribute('stroke',el.id===selectedElementId?'#286ba6':'#e0b65f');circle.setAttribute('stroke-width',el.id===selectedElementId?'3':'1.5');
      const text=document.createElementNS('http://www.w3.org/2000/svg','text');text.setAttribute('text-anchor','middle');text.setAttribute('y','6');text.setAttribute('font-size','20');text.setAttribute('pointer-events','none');text.textContent=el.symbol||'★';group.append(circle,text);symbolGroups.push(group);
      const selectSymbol=event=>{selectedElementId=el.id;selectedNodeId=null;renderCanvas();renderInspector();event.stopPropagation();};
      group.addEventListener('click',selectSymbol);group.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){selectSymbol(event);event.preventDefault();}});
    }
  });
  visible.forEach(n=>{const g=document.createElementNS('http://www.w3.org/2000/svg','g'); g.dataset.id=n.id; g.setAttribute('transform',`translate(${n.x} ${n.y})`); const rect=document.createElementNS('http://www.w3.org/2000/svg','rect'); rect.setAttribute('x','-80');rect.setAttribute('y','-31');rect.setAttribute('width','160');rect.setAttribute('height','62');rect.setAttribute('rx','12');rect.setAttribute('fill',n.color||'#d9eafb');rect.setAttribute('class',`node-rect ${n.id===selectedNodeId?'selected':''}`); g.appendChild(rect);
    if(n.showImage&&n.images?.[0]?.data){const image=document.createElementNS('http://www.w3.org/2000/svg','image');image.setAttribute('href',n.images[0].data);image.setAttribute('x','-73');image.setAttribute('y','-22');image.setAttribute('width','44');image.setAttribute('height','44');image.setAttribute('preserveAspectRatio','xMidYMid slice');image.setAttribute('clip-path','inset(0 round 7px)');g.appendChild(image);}
    g.setAttribute('role','button');g.setAttribute('tabindex','0');g.setAttribute('aria-label',`节点 ${n.title||'未命名'}`);
    g.addEventListener('keydown',event=>{if(event.key!=='Enter'&&event.key!==' ')return;const map=currentMap();if(connectionMode){if(!connectionSourceId){connectionSourceId=n.id;selectedNodeId=n.id;renderCanvas();toast(`已选择起点「${n.title}」，再点一个终点`);}else finishConnection(n.id);}else{selectedNodeId=n.id;selectedElementId=null;renderCanvas();renderInspector();}event.preventDefault();});
    const title=document.createElementNS('http://www.w3.org/2000/svg','text'); const titleStyle=n.titleStyle||{}; const titleSize=Number(titleStyle.size)||14; const titleWeight=titleStyle.bold?'900':'750'; const titleColor=titleStyle.color||'#203b5b'; const titleDecoration=[titleStyle.underline?'underline':'',titleStyle.strike?'line-through':''].filter(Boolean).join(' '); title.setAttribute('class','node-title'); title.setAttribute('text-anchor',n.showImage?'start':'middle'); title.setAttribute('x',n.showImage?'-20':'0'); title.setAttribute('y',n.subtitle?' -7':'-3'); title.setAttribute('font-size',`${titleSize}px`); title.setAttribute('font-weight',titleWeight); title.setAttribute('fill',titleColor); title.setAttribute('text-decoration',titleDecoration); title.setAttribute('text-decoration-line',titleDecoration); title.style.setProperty('font-size',`${titleSize}px`,'important'); title.style.setProperty('font-weight',titleWeight,'important'); title.style.setProperty('fill',titleColor,'important'); title.style.setProperty('text-decoration',titleDecoration,'important'); title.style.setProperty('text-decoration-line',titleDecoration,'important'); title.textContent=(n.title||'未命名').length>16?(n.title||'').slice(0,15)+'…':n.title||'未命名'; g.appendChild(title);
    const meta=document.createElementNS('http://www.w3.org/2000/svg','text');const subtitleStyle=n.subtitleStyle||{};const subtitleText=stripRichText(n.subtitle||n.note||''); const subtitleSize=Number(subtitleStyle.size)||11; const subtitleWeight=subtitleStyle.bold?'800':'400'; const subtitleColor=subtitleStyle.color||'#5f7891'; const subtitleDecoration=[subtitleStyle.underline?'underline':'',subtitleStyle.strike?'line-through':''].filter(Boolean).join(' '); meta.setAttribute('class','node-meta');meta.setAttribute('text-anchor',n.showImage?'start':'middle');meta.setAttribute('x',n.showImage?'-20':'0');meta.setAttribute('y',subtitleText?'15':'18');meta.setAttribute('font-size',`${subtitleSize}px`);meta.setAttribute('font-weight',subtitleWeight);meta.setAttribute('fill',subtitleColor);meta.setAttribute('text-decoration',subtitleDecoration);meta.setAttribute('text-decoration-line',subtitleDecoration);meta.style.setProperty('font-size',`${subtitleSize}px`,'important');meta.style.setProperty('font-weight',subtitleWeight,'important');meta.style.setProperty('fill',subtitleColor,'important');meta.style.setProperty('text-decoration',subtitleDecoration,'important');meta.style.setProperty('text-decoration-line',subtitleDecoration,'important');meta.textContent=subtitleText||nodeStats(n)||(childrenOf(map,n.id).length?`${childrenOf(map,n.id).length} 个分支`:'');g.appendChild(meta);
    if(n.collapsed&&childrenOf(map,n.id).length){const badge=document.createElementNS('http://www.w3.org/2000/svg','circle');badge.setAttribute('cx','69');badge.setAttribute('cy','-20');badge.setAttribute('r','9');badge.setAttribute('fill','#fff');badge.setAttribute('stroke','#aac6df');const bt=document.createElementNS('http://www.w3.org/2000/svg','text');bt.setAttribute('x','69');bt.setAttribute('y','-16');bt.setAttribute('text-anchor','middle');bt.setAttribute('font-size','11');bt.setAttribute('fill','#286ba6');bt.textContent='+';g.append(badge,bt);}
    nodes.appendChild(g);
  }); symbolGroups.forEach(group=>nodes.appendChild(group)); applyViewport();
}
function stripRichText(value=''){const box=document.createElement('div');box.innerHTML=String(value);return box.textContent||box.innerText||'';}
function noteHtml(value=''){const raw=String(value||'');if(!raw)return '';if(!/<[a-z][\s\S]*>/i.test(raw))return esc(raw).replace(/\n/g,'<br>');const box=document.createElement('div');box.innerHTML=raw;const allowed=new Set(['B','STRONG','U','S','BR','P','DIV','SPAN','FONT','EM','I']);box.querySelectorAll('*').forEach(el=>{if(!allowed.has(el.tagName)){el.replaceWith(...el.childNodes);return;}[...el.attributes].forEach(attr=>{if(!['style','color','size'].includes(attr.name))el.removeAttribute(attr.name);if(attr.name==='style'&&!/^(?:\s*(?:color|font-size)\s*:[^;]+;?)+$/i.test(attr.value))el.removeAttribute('style');});});return box.innerHTML;}
function bindRichEditor(editor, node){const toolbar=editor.previousElementSibling;if(!toolbar)return;toolbar.querySelectorAll('[data-rich-cmd]').forEach(btn=>btn.addEventListener('mousedown',e=>{e.preventDefault();editor.focus();document.execCommand(btn.dataset.richCmd,false,null);node.note=noteHtml(editor.innerHTML);scheduleSave();renderCanvas();}));toolbar.querySelector('[data-rich-color]')?.addEventListener('change',e=>{editor.focus();document.execCommand('foreColor',false,e.target.value);node.note=noteHtml(editor.innerHTML);scheduleSave();});toolbar.querySelector('[data-rich-size]')?.addEventListener('change',e=>{editor.focus();document.execCommand('fontSize',false,e.target.value);node.note=noteHtml(editor.innerHTML);scheduleSave();});editor.addEventListener('input',()=>{node.note=noteHtml(editor.innerHTML);scheduleSave();renderCanvas();});editor.addEventListener('blur',()=>{snapshot();node.note=noteHtml(editor.innerHTML);scheduleSave();});}
function nodeOverlaps(a,b){return Math.abs(a.x-b.x)<186&&Math.abs(a.y-b.y)<94;}
function findOpenPosition(map, anchor, relation='child', sideOverride=null) {
  const STEP=118;
  const baseX=anchor?.x||0, baseY=anchor?.y||0;
  const side=sideOverride||branchSide(map,anchor);
  const sign=side==='left'?-1:1;
  const targetX=baseX+(relation==='child'?235*sign:0);
  // 选中的节点也必须参与碰撞检测，否则新增同级节点可能直接盖住它。
  const occupied=map.nodes.filter(Boolean);
  const sameColumn=occupied.filter(n=>Math.abs(n.x-targetX)<186);
  const columnBottom=sameColumn.length?Math.max(...sameColumn.map(n=>n.y)):null;
  const candidates=[];

  // 有同列节点时，从该列最下面继续排；没有同列节点时，先放在锚点旁边。
  // 这比围绕锚点左右上下随机试探更符合“新增节点接在末端”的直觉。
  candidates.push({x:targetX,y:columnBottom==null?baseY:columnBottom+STEP});
  const vertical=[0];
  for(let i=1;i<80;i++){
    const distance=Math.ceil(i/2)*STEP;
    vertical.push(i%2?-distance:distance);
  }
  const horizontal=relation==='child'?[235*sign,-235*sign,445*sign,-445*sign,655*sign,-655*sign,890*sign,-890*sign]:[0,210*sign,-210*sign,420*sign,-420*sign,630*sign,-630*sign,840*sign,-840*sign];
  horizontal.forEach(x=>vertical.forEach(y=>candidates.push({x:baseX+x,y:baseY+y})));
  const open=candidates.find(p=>occupied.every(n=>!nodeOverlaps(n,p)));
  if(open)return open;

  // 极端密集时继续向下寻找，不返回一个可能重叠的兜底坐标。
  let y=(columnBottom==null?baseY:columnBottom)+STEP;
  while(occupied.some(n=>nodeOverlaps(n,{x:targetX,y})))y+=STEP;
  return {x:targetX,y};
}

function moveSubtreeDown(map, id, amount) {
  [id,...descendants(map,id)].forEach(nodeId => {
    const node=nodeById(map,nodeId);
    if(node) node.y+=amount;
  });
}

function subtreeBounds(map, id) {
  const nodes=[id,...descendants(map,id)].map(nodeId=>nodeById(map,nodeId)).filter(Boolean);
  if(!nodes.length)return null;
  return {min:Math.min(...nodes.map(n=>n.y)),max:Math.max(...nodes.map(n=>n.y))};
}

function reflowSiblingBranches(map, parentId) {
  const children=childrenOf(map,parentId);
  if(children.length<2)return;
  const GAP=118;
  const ordered=children.map((node,index)=>({node,index,bounds:subtreeBounds(map,node.id)})).filter(item=>item.bounds).sort((a,b)=>a.bounds.min-b.bounds.min||a.index-b.index);
  let previousBottom=null;
  ordered.forEach(item=>{
    if(previousBottom!==null&&item.bounds.min<previousBottom+GAP){
      const amount=previousBottom+GAP-item.bounds.min;
      moveSubtreeDown(map,item.node.id,amount);
      item.bounds={min:item.bounds.min+amount,max:item.bounds.max+amount};
    }
    previousBottom=item.bounds.max;
  });
}

function reflowAncestorsAfterInsert(map, insertedId) {
  let node=nodeById(map,insertedId), parentId=node?.parentId, guard=0;
  while(parentId&&guard++<map.nodes.length+2){
    reflowSiblingBranches(map,parentId);
    const parent=nodeById(map,parentId);
    parentId=parent?.parentId;
  }
}

function repairOverlapsAfterInsert(map, insertedId) {
  if(!map?.nodes?.length)return;
  const STEP=118;
  const insertedIndex=map.nodes.findIndex(n=>n.id===insertedId);
  const maxPasses=Math.max(20,map.nodes.length*map.nodes.length*2);
  for(let pass=0;pass<maxPasses;pass++){
    let collision=null;
    for(let i=0;i<map.nodes.length&&!collision;i++){
      for(let j=i+1;j<map.nodes.length;j++){
        if(nodeOverlaps(map.nodes[i],map.nodes[j])){collision=[i,j];break;}
      }
    }
    if(!collision)break;
    const [i,j]=collision;
    let moveIndex;
    if(i===insertedIndex) moveIndex=j;
    else if(j===insertedIndex) moveIndex=i;
    else {
      const iSubtree=new Set([map.nodes[i].id,...descendants(map,map.nodes[i].id)]);
      const jSubtree=new Set([map.nodes[j].id,...descendants(map,map.nodes[j].id)]);
      if(iSubtree.has(map.nodes[j].id)) moveIndex=j;
      else if(jSubtree.has(map.nodes[i].id)) moveIndex=i;
      else moveIndex=Math.max(i,j); // 后建立的节点优先让位
    }
    // 不把包含新节点的整棵树一起下移，否则相对位置不变会反复碰撞。
    const moveSubtree=[map.nodes[moveIndex].id,...descendants(map,map.nodes[moveIndex].id)];
    if(moveSubtree.includes(insertedId)) moveIndex=insertedIndex;
    moveSubtreeDown(map,map.nodes[moveIndex].id,STEP);
  }
}
function buildOriginalMap(){
  const nodes=[];
  const addTree=(item,parentId=null)=>{
    const node={id:uid('node'),parentId,title:item.title,subtitle:item.subtitle||'',x:0,y:0,color:parentId?'#d9eafb':'#b8d8f8',showImage:false,note:'',tags:[],images:[],links:[],collapsed:false};
    nodes.push(node);(item.children||[]).forEach(child=>addTree(child,node.id));return node;
  };
  const root=addTree(originalMapTree);
  const map={id:uid('map'),name:'技术 · 原图整理',createdAt:now(),updatedAt:now(),rootId:root.id,nodes,elements:[],manualLayout:false};
  layoutMap(map);return map;
}
function createOriginalMap(){
  const existing=state.maps.find(m=>m.name==='技术 · 原图整理');
  if(existing){state.lastMapId=existing.id;selectedNodeId=existing.rootId;selectedElementId=null;renderAll();scheduleSave('已打开原图整理导图');toast('已打开原图整理导图');return;}
  snapshot();const map=buildOriginalMap();state.maps.push(map);state.lastMapId=map.id;selectedNodeId=map.rootId;selectedElementId=null;renderAll();scheduleSave('原图结构已保存');toast('已建立原图结构：图片和网盘链接留空，后续可自行添加');
}
function ensureOriginalMap(){
  if(state.maps.some(m=>m.name==='技术 · 原图整理'))return false;
  const map=buildOriginalMap();state.maps.push(map);state.lastMapId=map.id;return true;
}
function bindSubtitleControls(field,n){const input=field?.querySelector('#nodeSubtitleInput');if(!input)return;const style=n.subtitleStyle||{};field.querySelector('label').innerHTML='备注 / 小字说明 <small>显示在节点标题下方</small>';input.value=stripRichText(n.subtitle||n.note||'');n.subtitle=input.value;n.note='';field.insertAdjacentHTML('beforeend',`<div class="rich-toolbar" style="margin-top:6px"><button type="button" data-subtitle-cmd="bold" class="${style.bold?'primary':''}" title="加粗">B</button><button type="button" data-subtitle-cmd="underline" class="${style.underline?'primary':''}" title="下划线"><u>U</u></button><button type="button" data-subtitle-cmd="strike" class="${style.strike?'primary':''}" title="删除线"><s>S</s></button><select data-subtitle-size title="字号"><option value="10" ${style.size===10?'selected':''}>小号</option><option value="11" ${(!style.size||style.size===11)?'selected':''}>标准</option><option value="13" ${style.size===13?'selected':''}>大号</option><option value="16" ${style.size===16?'selected':''}>特大</option></select><input type="color" data-subtitle-color value="${esc(style.color||'#5f7891')}" title="小字颜色"></div>`);input.oninput=e=>{n.subtitle=e.target.value;n.note='';scheduleSave();renderCanvas();};input.onchange=()=>{snapshot();scheduleSave();};field.querySelectorAll('[data-subtitle-cmd]').forEach(btn=>{btn.setAttribute('aria-pressed',String(!!style[btn.dataset.subtitleCmd]));btn.addEventListener('click',()=>{snapshot();n.subtitleStyle=n.subtitleStyle||{};n.subtitleStyle[btn.dataset.subtitleCmd]=!n.subtitleStyle[btn.dataset.subtitleCmd];btn.classList.toggle('primary',!!n.subtitleStyle[btn.dataset.subtitleCmd]);btn.setAttribute('aria-pressed',String(!!n.subtitleStyle[btn.dataset.subtitleCmd]));renderCanvas();scheduleSave();});});field.querySelector('[data-subtitle-size]').onchange=e=>{snapshot();n.subtitleStyle=n.subtitleStyle||{};n.subtitleStyle.size=Number(e.target.value);renderCanvas();scheduleSave();};field.querySelector('[data-subtitle-color]').oninput=e=>{n.subtitleStyle=n.subtitleStyle||{};n.subtitleStyle.color=e.target.value;renderCanvas();scheduleSave();};field.querySelector('[data-subtitle-color]').onchange=()=>{snapshot();scheduleSave();};}
function askDeleteElement(id){
  const map=currentMap(), element=(map?.elements||[]).find(e=>e.id===id); if(!element)return;
  const isSymbol=element.type==='symbol';
  $('#confirmTitle').textContent=isSymbol?'删除这个符号？':'删除这条连接线？';
  $('#confirmText').textContent='只会删除画布上的这个元素，不会删除节点。可以用撤销恢复。';
  confirmAction=()=>{snapshot();map.elements=(map.elements||[]).filter(e=>e.id!==id);selectedElementId=null;renderAll();scheduleSave();toast(isSymbol?'符号已删除':'连接线已删除');};
  $('#confirmDialog').showModal();
}
function renderInspector() {
  const el=$('#inspector'), map=currentMap(), selectedElement=(map?.elements||[]).find(e=>e.id===selectedElementId);
  if(selectedElement){
    const isSymbol=selectedElement.type==='symbol';
    el.className='inspector open';
    el.innerHTML=`<div class="inspector-head"><div><div class="eyebrow">画布元素</div><h2>${isSymbol?`当前符号 ${esc(selectedElement.symbol||'★')}`:'当前连接线'}</h2><div class="path">${isSymbol?'可拖动符号微调位置':'已连接两个节点，可点击画布中的其他节点继续添加'}</div></div><button class="btn icon ghost mobile-only" id="closeInspector">×</button></div><div class="quick-actions"><button class="btn danger" id="deleteElementBtn">删除${isSymbol?'符号':'连接线'}</button></div><div class="data-box">删除后不会影响任何节点；如需恢复，可以点击工具栏的撤销。</div>`;
    $('#closeInspector')?.addEventListener('click',()=>el.classList.remove('open'));
    $('#deleteElementBtn').onclick=()=>askDeleteElement(selectedElementId);
    return;
  }
  const n=nodeById(map,selectedNodeId); if(!n){el.className='inspector empty';el.innerHTML='<span>点选画布中的节点，查看笔记、图片、标签和课程链接</span>';return;}
  el.className='inspector open';
  const ts=n.titleStyle||{};
  el.innerHTML=`<div class="inspector-head"><div><div class="eyebrow">当前节点</div><h2>${esc(n.title)}</h2><div class="path">${esc(getPath(map,n.id).join(' / '))}</div></div><button class="btn icon ghost mobile-only" id="closeInspector">×</button></div><div class="quick-actions"><button class="btn primary" id="addChildBtn">＋ 子节点</button><button class="btn" id="addSiblingBtn">＋ 同级</button><button class="btn" id="toggleCollapseBtn">${n.collapsed?'展开分支':'折叠分支'}</button><button class="btn danger" id="deleteNodeBtn">删除分支</button></div><div class="field"><label>节点名称（大字）</label><input id="nodeTitleInput" value="${esc(n.title)}" maxlength="80" /><div class="rich-toolbar" style="margin-top:6px"><button type="button" data-title-cmd="bold" class="${ts.bold?'primary':''}" title="加粗">B</button><button type="button" data-title-cmd="underline" class="${ts.underline?'primary':''}" title="下划线"><u>U</u></button><button type="button" data-title-cmd="strike" class="${ts.strike?'primary':''}" title="删除线"><s>S</s></button><select id="titleSizeInput" title="标题字号"><option value="12" ${ts.size===12?'selected':''}>12</option><option value="14" ${(!ts.size||ts.size===14)?'selected':''}>14</option><option value="16" ${ts.size===16?'selected':''}>16</option><option value="18" ${ts.size===18?'selected':''}>18</option><option value="22" ${ts.size===22?'selected':''}>22</option></select><input id="titleColorInput" type="color" value="${esc(ts.color||'#203b5b')}" title="标题颜色"></div></div><div class="field"><label>小字说明 <small>显示在节点标题下方</small></label><input id="nodeSubtitleInput" value="${esc(n.subtitle||'')}" maxlength="100" placeholder="例如：学习方向、适合脸型、课程备注" /></div><div class="field"><label>备注与文字笔记</label><div class="rich-toolbar"><button type="button" data-rich-cmd="bold" title="加粗">B</button><button type="button" data-rich-cmd="underline" title="下划线"><u>U</u></button><button type="button" data-rich-cmd="strikeThrough" title="删除线"><s>S</s></button><select data-rich-size title="字号"><option value="2">小号</option><option value="3" selected>标准</option><option value="4">大号</option><option value="5">特大</option><option value="6">标题</option></select><input type="color" data-rich-color value="#203b5b" title="文字颜色"></div><div id="nodeNoteInput" class="rich-editor" contenteditable="true" data-placeholder="记录角度、分区、操作要点或课程心得">${noteHtml(n.note)}</div></div><div class="field"><label>标签 <small>回车添加</small></label><div class="tags-input"><input id="tagInput" placeholder="老师、课程、技术关键词" /></div><div class="tag-list">${(n.tags||[]).map((t,i)=>`<span class="tag">${esc(t)} <button data-remove-tag="${i}">×</button></span>`).join('')}</div></div><div class="section-title">图片 <small>${n.images.length} 张 · 支持多选</small></div><label class="image-node-toggle"><input id="showImageInput" type="checkbox" ${n.showImage?'checked':''}> 在画布显示首图（图片节点）</label><div class="image-grid">${n.images.map((img,i)=>`<div class="image-card"><img src="${img.data}" alt="${esc(img.name||'节点图片')}" data-preview-image="${img.data}"><div class="image-tools"><button title="删除图片" data-remove-image="${i}">×</button></div></div>`).join('')}<label class="upload-btn">＋ 上传图片<input id="nodeImageInput" type="file" accept="image/*" multiple></label></div><div class="section-title">资料链接 <small>${n.links.length} 条</small><button class="btn" id="addNodeLinkBtn" style="padding:4px 8px;font-size:11px">＋ 添加</button></div><div id="nodeLinks">${n.links.map((l,i)=>linkCard(l,i,'node')).join('')}</div>`;
  const subtitleField=$('#nodeSubtitleInput')?.closest('.field');const oldNoteField=$('#nodeNoteInput')?.closest('.field');if(oldNoteField)oldNoteField.remove();bindSubtitleControls(subtitleField,n);
  $('#closeInspector')?.addEventListener('click',()=>{el.classList.remove('open');});
  $('#addChildBtn').onclick=()=>addNode(n.id,'child'); $('#addSiblingBtn').onclick=()=>addNode(n.id,'sibling'); $('#toggleCollapseBtn').onclick=()=>{snapshot();n.collapsed=!n.collapsed;renderAll();scheduleSave();}; $('#deleteNodeBtn').onclick=()=>askDeleteNode(n.id);
  $('#nodeTitleInput').oninput=e=>{n.title=e.target.value; scheduleSave(); renderCanvas();}; $('#nodeTitleInput').onchange=()=>{snapshot(); scheduleSave();};
  const titleButtons=el.querySelectorAll('[data-title-cmd]'); titleButtons.forEach(btn=>{btn.setAttribute('aria-pressed',String(!!ts[btn.dataset.titleCmd]));btn.addEventListener('click',()=>{snapshot();n.titleStyle=n.titleStyle||{};n.titleStyle[btn.dataset.titleCmd]=!n.titleStyle[btn.dataset.titleCmd];btn.classList.toggle('primary',!!n.titleStyle[btn.dataset.titleCmd]);btn.setAttribute('aria-pressed',String(!!n.titleStyle[btn.dataset.titleCmd]));renderCanvas();scheduleSave();});}); $('#titleSizeInput').onchange=e=>{snapshot();n.titleStyle=n.titleStyle||{};n.titleStyle.size=Number(e.target.value);renderCanvas();scheduleSave();}; $('#titleColorInput').oninput=e=>{n.titleStyle=n.titleStyle||{};n.titleStyle.color=e.target.value;renderCanvas();scheduleSave();}; $('#titleColorInput').onchange=()=>{snapshot();scheduleSave();};
  $('#showImageInput').onchange=e=>{snapshot();n.showImage=e.target.checked;renderCanvas();scheduleSave();};
  $('#tagInput').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();const t=e.target.value.trim();if(t&&!n.tags.includes(t)){snapshot();n.tags.push(t);e.target.value='';renderInspector();scheduleSave();}}};
  el.querySelectorAll('[data-remove-tag]').forEach(b=>b.onclick=()=>{snapshot();n.tags.splice(+b.dataset.removeTag,1);renderInspector();scheduleSave();});
  el.querySelectorAll('[data-remove-image]').forEach(b=>b.onclick=()=>{snapshot();n.images.splice(+b.dataset.removeImage,1);renderInspector();scheduleSave();toast('图片已删除');});
  el.querySelectorAll('[data-preview-image]').forEach(img=>img.onclick=()=>openImage(img.dataset.previewImage)); $('#nodeImageInput').onchange=e=>addImagesToNode(n,e.target.files);
  $('#addNodeLinkBtn').onclick=()=>addLinkToNode(n); el.querySelectorAll('[data-open-url]').forEach(b=>b.onclick=()=>window.open(b.dataset.openUrl,'_blank','noopener')); el.querySelectorAll('[data-link-remove]').forEach(b=>b.onclick=()=>{snapshot();n.links.splice(+b.dataset.linkRemove,1);renderInspector();scheduleSave();}); el.querySelectorAll('[data-copy-url]').forEach(b=>b.onclick=()=>copyText(b.dataset.copyUrl)); el.querySelectorAll('[data-copy-code]').forEach(b=>b.onclick=()=>copyText(b.dataset.copyCode));
}
function linkCard(l,i,type){ return `<div class="link-card"><strong>${esc(l.name||'未命名资料')}</strong><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.url)}</a>${l.note?`<div style="font-size:11px;color:#7187a0">${esc(l.note)}</div>`:''}${l.code?`<div style="font-size:11px;color:#7187a0;margin-top:3px">提取码：${esc(l.code)}</div>`:''}<div class="link-actions"><button data-open-url="${esc(l.url)}">打开资料</button><button data-copy-url="${esc(l.url)}">复制链接</button>${l.code?`<button data-copy-code="${esc(l.code)}">复制提取码</button>`:''}<button data-link-remove="${i}" style="color:var(--danger)">删除</button></div></div>`; }

function addNode(parentId, mode='child', title='', sideOverride=null) { const map=currentMap();if(!map)return;const base=nodeById(map,parentId);const isRootChild=mode==='child'&&base?.id===map.rootId;const side=sideOverride||(isRootChild?chooseRootSide(map):mode==='sibling'?(base?.side||branchSide(map,base)):branchSide(map,base));if(!title.trim()){pendingNodeAction={parentId,mode,side};openNameDialog(mode==='sibling'?'addSibling':'addChild');return;} snapshot(); const id=uid('node'), position=findOpenPosition(map,base,mode,side); const node={id,parentId:mode==='sibling'?base?.parentId:parentId,title:title.trim(),subtitle:'',x:position.x,y:position.y,color:'#d9eafb',side,isRootBranch:isRootChild||mode==='sibling',showImage:false,note:'',tags:[],images:[],links:[],collapsed:false}; map.nodes.push(node); selectedNodeId=id; if(!map.manualLayout){layoutMap(map);}else{reflowAncestorsAfterInsert(map,id);repairOverlapsAfterInsert(map,id);} renderAll(); scheduleSave(); toast('节点已添加，已自动避开已有节点并调整后续分支'); }
function addIndependentNode(title=''){const map=currentMap();if(!map)return;if(!title.trim()){openNameDialog('newTopic');return;}snapshot();const anchor={x:0,y:0};const position=findOpenPosition(map,anchor,'sibling');const n={id:uid('node'),parentId:null,title:title.trim(),subtitle:'',x:position.x,y:position.y,color:'#d9eafb',showImage:false,note:'',tags:[],images:[],links:[],collapsed:false};map.nodes.push(n);selectedNodeId=n.id;if(!map.manualLayout)layoutMap(map);renderAll();scheduleSave();}
function toggleConnectionMode(){if(connectionMode){connectionMode=false;connectionSourceId=null;pendingConnectionTargetId=null;$('#connectBtn').classList.remove('primary');renderCanvas();toast('已取消连接线');return;}$('#connectionTypeInput').value=connectionStyle.lineType;$('#connectionDashInput').value=connectionStyle.dash;$('#connectionArrowInput').value=connectionStyle.arrow;$('#connectionDialog').showModal();}
function finishConnection(targetId){const map=currentMap();if(!map||!connectionSourceId)return;if(connectionSourceId===targetId){toast('起点和终点不能是同一个节点');return;}snapshot();map.elements=map.elements||[];map.elements.push({id:uid('element'),type:'connection',from:connectionSourceId,to:targetId,lineType:connectionStyle.lineType,dash:connectionStyle.dash,arrow:connectionStyle.arrow,label:''});selectedElementId=map.elements.at(-1).id;connectionSourceId=null;renderCanvas();renderInspector();scheduleSave();toast('连接线已添加，可继续点击下一个起点');}
function saveConnection(){connectionStyle={lineType:$('#connectionTypeInput').value,dash:$('#connectionDashInput').value,arrow:$('#connectionArrowInput').value};connectionMode=true;connectionSourceId=null;pendingConnectionTargetId=null;selectedElementId=null;$('#connectBtn').classList.add('primary');$('#connectionDialog').close();renderCanvas();toast('样式已选择：请点击起点，再点击终点');}
function addSymbol(symbol=''){const map=currentMap();if(!map)return;if(!symbol.trim()){openNameDialog('addSymbol');return;}const base=nodeById(map,selectedNodeId);snapshot();map.elements=map.elements||[];map.elements.push({id:uid('element'),type:'symbol',symbol:symbol.trim().slice(0,2),label:'',anchorNodeId:base?.id||null,dx:0,dy:-78,manualPosition:false,x:base?.x||0,y:(base?.y||0)-78,color:'#fff4c7'});renderCanvas();scheduleSave();toast(base?'符号已放在节点正上方':'符号已添加');}
function openSymbolDialog(){$('#symbolDialog').showModal();}
function askDeleteNode(id){const map=currentMap(),n=nodeById(map,id), count=descendants(map,id).length; if(!n)return; $('#confirmTitle').textContent='删除节点分支？';$('#confirmText').textContent=count?`「${n.title}」下面还有 ${count} 个子节点，确认后会一并删除。可以用撤销恢复。`:`确认删除「${n.title}」？可以用撤销恢复。`;confirmAction=()=>{snapshot();const ids=new Set([id,...descendants(map,id)]);map.nodes=map.nodes.filter(x=>!ids.has(x.id));map.elements=(map.elements||[]).filter(e=>!ids.has(e.from)&&!ids.has(e.to)&&!ids.has(e.anchorNodeId));if(map.rootId===id){map.rootId=map.nodes[0]?.id||null;if(map.nodes[0])map.nodes[0].parentId=null;}selectedNodeId=null;selectedElementId=null;if(!map.manualLayout)layoutMap(map);renderAll();scheduleSave();toast('分支已删除，可点击撤销恢复');};$('#confirmDialog').showModal();}
function addImagesToNode(n,files){if(!files?.length)return;snapshot(); Promise.all([...files].map(fileToCompressedData)).then(images=>{n.images.push(...images);n.showImage=true;renderInspector();renderCanvas();scheduleSave();toast(`已保存 ${images.length} 张图片，已作为图片节点预览`);}).catch(e=>toast(e.message||'图片处理失败'));}
function fileToCompressedData(file){return new Promise((resolve,reject)=>{if(!file.type.startsWith('image/'))return reject(new Error('只支持图片文件'));const reader=new FileReader();reader.onload=()=>{const img=new Image();img.onload=()=>{const max=1800,scale=Math.min(1,max/Math.max(img.width,img.height)),c=document.createElement('canvas');c.width=Math.max(1,Math.round(img.width*scale));c.height=Math.max(1,Math.round(img.height*scale));c.getContext('2d').drawImage(img,0,0,c.width,c.height);const data=c.toDataURL('image/jpeg',.84);resolve({id:uid('img'),name:file.name,data,width:c.width,height:c.height,bytes:data.length});};img.onerror=()=>reject(new Error('无法读取图片'));img.src=reader.result;};reader.onerror=()=>reject(new Error('无法读取图片'));reader.readAsDataURL(file);});}
function addLinkToNode(n){linkTargetNodeId=n.id;$('#linkNameInput').value='';$('#linkUrlInput').value='';$('#linkCodeInput').value='';$('#linkNoteInput').value='';$('#linkDialog').showModal();setTimeout(()=>$('#linkNameInput').focus(),50);}
function finishLinkDialog(){const n=nodeById(currentMap(),linkTargetNodeId),name=$('#linkNameInput').value.trim(),url=$('#linkUrlInput').value.trim();if(!n||!name||!/^https?:\/\//i.test(url)){toast('请填写名称，并输入以 http:// 或 https:// 开头的地址');return;}snapshot();n.links.push({id:uid('link'),name,url,code:$('#linkCodeInput').value.trim(),note:$('#linkNoteInput').value.trim()});$('#linkDialog').close();renderInspector();renderCanvas();scheduleSave();toast('资料链接已保存');}

function renderNotes(){const list=$('#noteList');let notes=state.notes.filter(n=>noteFilter==='all'||(noteFilter==='done'?n.organized:n.organized==null));if(!notes.length){list.innerHTML=`<div class="empty-list" style="grid-column:1/-1">${noteFilter==='pending'?'还没有待分类内容。点右上角「记一条」，先把灵感保存下来。':'没有符合条件的记录。'}</div>`;return;}list.innerHTML=notes.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).map(n=>`<article class="note-card" data-note-id="${n.id}"><div class="note-card-top"><h3>${esc(n.title||'未命名随身记')}</h3><span class="status-pill ${n.organized?'done':''}">${n.organized?'已整理':'待分类'}</span></div><p>${esc(n.body||'（图片记录）')}</p><div class="note-meta"><span>${formatDate(n.updatedAt)} · ${n.images?.length||0}图 ${n.links?.length||0}链</span><span>打开 ›</span></div>${n.organized?`<div style="color:#33865a;font-size:11px;margin-top:8px">归入：${esc((state.maps.find(m=>m.id===n.organized.mapId)?.name||'已删除导图'))} / ${esc(nodeById(state.maps.find(m=>m.id===n.organized.mapId),n.organized.nodeId)?.title||'节点')}</div>`:`<div style="display:flex;gap:6px;margin-top:11px"><button class="btn organize-note" data-organize-note="${n.id}" style="padding:6px 9px;font-size:11px">整理到导图</button><button class="btn danger delete-note" data-delete-note="${n.id}" style="padding:6px 9px;font-size:11px">删除</button></div>`}</article>`).join('');list.querySelectorAll('.note-card').forEach(c=>c.onclick=e=>{if(e.target.closest('button'))return;openNoteDialog(c.dataset.noteId);});list.querySelectorAll('[data-organize-note]').forEach(b=>b.onclick=e=>{e.stopPropagation();openOrganize(b.dataset.organizeNote);});list.querySelectorAll('[data-delete-note]').forEach(b=>b.onclick=e=>{e.stopPropagation();const id=b.dataset.deleteNote;const n=state.notes.find(x=>x.id===id);$('#confirmTitle').textContent='删除这条随身记？';$('#confirmText').textContent=`「${n?.title||'未命名随身记'}」及其图片、链接会被删除，可以用撤销恢复。`;confirmAction=()=>{snapshot();state.notes=state.notes.filter(x=>x.id!==id);renderNotes();scheduleSave();};$('#confirmDialog').showModal();});}
function formatDate(s){const d=new Date(s);return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;}
function renderNoteAttachmentArea(note){const area=$('#noteAttachmentArea');area.innerHTML=`<div class="section-title">附件 <small>${note?.images?.length||0}图 · ${note?.links?.length||0}链</small></div><div class="image-grid">${(note?.images||[]).map((img,i)=>`<div class="image-card"><img src="${img.data}" data-note-preview="${img.data}" alt="图片"><div class="image-tools"><button type="button" data-note-remove-image="${i}">×</button></div></div>`).join('')}<label class="upload-btn">＋ 上传图片<input id="noteImageInput" type="file" accept="image/*" multiple></label></div><div class="link-form"><input id="noteLinkName" placeholder="链接名称（选填）"><input id="noteLinkUrl" placeholder="https://…"><input id="noteLinkCode" placeholder="提取码（选填）"><input id="noteLinkNote" placeholder="链接备注（选填）"><button type="button" class="btn" id="noteAddLink" style="padding:7px 10px">＋ 添加链接</button></div><div id="noteLinksList">${(note?.links||[]).map((l,i)=>linkCard(l,i,'note')).join('')}</div>`;area.querySelectorAll('[data-note-remove-image]').forEach(b=>b.onclick=()=>{snapshot();note.images.splice(+b.dataset.noteRemoveImage,1);renderNoteAttachmentArea(note);scheduleSave();});area.querySelectorAll('[data-note-preview]').forEach(img=>img.onclick=()=>openImage(img.dataset.notePreview));$('#noteImageInput').onchange=e=>{snapshot();Promise.all([...e.target.files].map(fileToCompressedData)).then(imgs=>{note.images.push(...imgs);renderNoteAttachmentArea(note);scheduleSave();toast(`已保存 ${imgs.length} 张图片`);}).catch(e=>toast(e.message));};$('#noteAddLink').onclick=()=>{const url=$('#noteLinkUrl').value.trim();if(!url||!/^https?:\/\//i.test(url)){toast('请输入有效的 http(s) 链接');return;}snapshot();note.links.push({id:uid('link'),name:$('#noteLinkName').value.trim()||'未命名资料',url,code:$('#noteLinkCode').value.trim(),note:$('#noteLinkNote').value.trim()});renderNoteAttachmentArea(note);scheduleSave();};area.querySelectorAll('[data-open-url]').forEach(b=>b.onclick=()=>window.open(b.dataset.openUrl,'_blank','noopener'));area.querySelectorAll('[data-link-remove]').forEach(b=>b.onclick=()=>{snapshot();note.links.splice(+b.dataset.linkRemove,1);renderNoteAttachmentArea(note);scheduleSave();});area.querySelectorAll('[data-copy-url]').forEach(b=>b.onclick=()=>copyText(b.dataset.copyUrl));area.querySelectorAll('[data-copy-code]').forEach(b=>b.onclick=()=>copyText(b.dataset.copyCode));}
function openNoteDialog(id=null){editingNoteId=id;const note=id?state.notes.find(n=>n.id===id):null;noteDraft=note||{images:[],links:[]};$('#noteDialogTitle').textContent=note?'编辑随身记':'记一条';$('#noteTitle').value=note?.title||'';$('#noteBody').value=note?.body||'';renderNoteAttachmentArea(noteDraft);$('#noteDialog').showModal();}
function saveNote(e){e.preventDefault();const title=$('#noteTitle').value.trim(),body=$('#noteBody').value.trim(),draft=editingNoteId?state.notes.find(n=>n.id===editingNoteId):noteDraft;if(!title&&!body&&!(draft?.images?.length)){toast('请先写一点内容或上传图片');return;}snapshot();if(editingNoteId){const n=state.notes.find(x=>x.id===editingNoteId);n.title=title||body.split('\n')[0].slice(0,50)||'未命名随身记';n.body=body;n.updatedAt=now();}else{state.notes.push({id:uid('note'),title:title||body.split('\n')[0].slice(0,50)||'未命名随身记',body,images:clone(noteDraft.images||[]),links:clone(noteDraft.links||[]),createdAt:now(),updatedAt:now()});}noteDraft=null;$('#noteDialog').close();renderNotes();scheduleSave();toast('随身记已保存');}
function openOrganize(id){organizeNoteId=id;organizeMode='attach';$('#organizeDialog').showModal();renderOrganizeOptions();}
function renderOrganizeOptions(){const mapSel=$('#organizeMap'),nodeSel=$('#organizeNode');mapSel.innerHTML=state.maps.map(m=>`<option value="${m.id}">${esc(m.name)}</option>`).join('');if(currentMap())mapSel.value=currentMap().id;const map=state.maps.find(m=>m.id===mapSel.value);nodeSel.innerHTML=(map?.nodes||[]).map(n=>`<option value="${n.id}">${esc(getPath(map,n.id).join(' / '))}</option>`).join('');$('#organizeHint').textContent=organizeMode==='attach'?'文字、图片和链接会附加到目标节点，随身记保留为已整理记录并指向这里。':'会创建一个带有随身记内容和附件的子节点；随身记保留为已整理记录并指向这里。';}
function finishOrganize(){const note=state.notes.find(n=>n.id===organizeNoteId),map=state.maps.find(m=>m.id===$('#organizeMap').value),target=nodeById(map,$('#organizeNode').value);if(!note||!map||!target)return;snapshot();let dest=target;if(organizeMode==='child'){const side=target.id===map.rootId?chooseRootSide(map):branchSide(map,target);const position=findOpenPosition(map,target,'child',side);dest={id:uid('node'),parentId:target.id,title:note.title||'随身记',subtitle:note.body||'随身记',x:position.x,y:position.y,color:'#e8dcf2',side,isRootBranch:target.id===map.rootId,showImage:!!note.images?.length,note:'',tags:[],images:clone(note.images||[]),links:clone(note.links||[]),collapsed:false};map.nodes.push(dest);if(map.manualLayout){reflowAncestorsAfterInsert(map,dest.id);repairOverlapsAfterInsert(map,dest.id);}}else{dest.subtitle=[dest.subtitle,dest.note,note.body].filter(Boolean).join(dest.subtitle||dest.note?'\n\n':'');dest.note='';dest.images.push(...clone(note.images||[]));dest.links.push(...clone(note.links||[]));if(note.images?.length)dest.showImage=true;}note.organized={mapId:map.id,nodeId:dest.id,mode:organizeMode,organizedAt:now()};note.updatedAt=now();state.lastMapId=map.id;selectedNodeId=dest.id;if(!map.manualLayout)layoutMap(map);$('#organizeDialog').close();renderAll();scheduleSave();toast('已整理到导图，内容保留关联');}

function search(){const q=$('#searchInput').value.trim().toLowerCase(),out=[];if(q){state.maps.forEach(map=>map.nodes.forEach(n=>{const noteText=stripRichText(n.note||'');const hay=[map.name,n.title,n.subtitle||'',noteText,(n.tags||[]).join(' '),(n.links||[]).map(l=>`${l.name} ${l.note}`).join(' ')].join(' ').toLowerCase();if(hay.includes(q))out.push({type:'map',mapId:map.id,nodeId:n.id,title:n.title,path:getPath(map,n.id).join(' / '),snippet:highlightSource(q,n.subtitle||noteText||n.tags?.join('、')||n.links?.[0]?.name||map.name)});}));state.notes.forEach(n=>{if([n.title,n.body,(n.links||[]).map(l=>`${l.name} ${l.note}`).join(' ')].join(' ').toLowerCase().includes(q))out.push({type:'note',noteId:n.id,title:n.title,path:n.organized?`已归入：${state.maps.find(m=>m.id===n.organized.mapId)?.name||''}`:'待分类',snippet:highlightSource(q,n.body||'图片记录')});});}const filtered=out.filter(r=>searchFilter==='all'||r.type===searchFilter);$('#searchResults').innerHTML=!q?'<div class="empty-list">输入关键词开始搜索。只搜索本应用已保存的信息。</div>':!filtered.length?'<div class="empty-list">没有找到匹配内容。可以试试节点名称、老师名或课程关键词。</div>':filtered.map(r=>`<div class="result" data-result-type="${r.type}" data-result-id="${r.type==='map'?r.nodeId:r.noteId}" data-map-id="${r.mapId||''}"><div class="result-head"><div class="result-title">${esc(r.title)}</div><span class="result-type">${r.type==='map'?'导图节点':'随身记'}</span></div><div class="result-path">${esc(r.path)}</div><div class="result-snippet">${esc(r.snippet)}</div></div>`).join('');$('#searchResults').querySelectorAll('.result').forEach(el=>el.onclick=()=>{if(el.dataset.resultType==='map'){state.lastMapId=el.dataset.mapId;selectedNodeId=el.dataset.resultId;currentView='map';activateView('map');const map=currentMap(),n=nodeById(map,selectedNodeId);if(map.layoutMode==='auto')layoutMap(map);renderAll();setTimeout(()=>fitViewport(),30);toast(`已定位：${n?.title||'节点'}`);}else openNoteDialog(el.dataset.resultId);});}
function highlightSource(q,s){return String(s||'').slice(0,180);}

function renderAll(){renderMapSelect();const map=currentMap();if(map&&!map.manualLayout)layoutMap(map);renderCanvas();renderInspector();renderNotes();search();updateUndoButtons();refreshStats();}
function updateUndoButtons(){$('#undoBtn').disabled=!history.past.length;$('#redoBtn').disabled=!history.future.length;}
function updateLayoutButtons(){}
function activateView(view){currentView=view;$$('.nav button').forEach(b=>b.classList.toggle('active',b.dataset.view===view));$$('.view').forEach(v=>v.classList.remove('active'));$(`#${view}View`).classList.add('active');if(view==='map')setTimeout(()=>{if(!drag)fitViewport();},20);}
function toast(msg){const t=$('#toast');t.textContent=msg;t.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove('show'),2500);}
async function copyText(text){try{await navigator.clipboard.writeText(text);toast('已复制');}catch{toast('剪贴板不可用，请长按链接手动复制');}}
function openImage(data){$('#imagePreview').src=data;$('#imageDialog').showModal();}
function refreshStats(){const images=state?.maps.reduce((sum,m)=>sum+m.nodes.reduce((s,n)=>s+(n.images?.length||0),0),0)+(state?.notes||[]).reduce((s,n)=>s+(n.images?.length||0),0);const nodes=state?.maps.reduce((s,m)=>s+m.nodes.length,0)||0;const el=$('#dataStats');if(el)el.innerHTML=`导图 ${state?.maps.length||0} 张 · 节点 ${nodes} 个 · 随身记 ${state?.notes.length||0} 条 · 图片 ${images} 张<br>最后保存：${state?.updatedAt?formatDate(state.updatedAt):'—'}<br><span style="color:#a66d17">本设备本地保存，暂无跨设备自动同步</span>`;}

function exportBackup(){const payload={format:'hair-knowledge-map-backup',version:1,exportedAt:now(),data:state};const blob=new Blob([JSON.stringify(payload)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`发型知识导图备份_${new Date().toISOString().slice(0,10)}.hkm.json`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);toast('完整备份已导出');}
function remapImported(data){const maps=data.maps||[], notes=data.notes||[], mapIdMap=new Map(), nodeIdMap=new Map(), noteIdMap=new Map();maps.forEach(m=>mapIdMap.set(m.id,uid('map')));maps.forEach(m=>m.nodes?.forEach(n=>nodeIdMap.set(n.id,uid('node'))));notes.forEach(n=>noteIdMap.set(n.id,uid('note')));return {maps:maps.map(m=>{const nm=clone(m);nm.id=mapIdMap.get(m.id);nm.name=`${m.name||'导入导图'}（导入）`;nm.rootId=nodeIdMap.get(m.rootId)||null;nm.nodes=(m.nodes||[]).map(n=>({...clone(n),id:nodeIdMap.get(n.id),parentId:n.parentId?nodeIdMap.get(n.parentId)||null:null,links:clone(n.links||[]),images:clone(n.images||[])}));return nm;}),notes:notes.map(n=>({...clone(n),id:noteIdMap.get(n.id),organized:n.organized?{...n.organized,mapId:mapIdMap.get(n.organized.mapId)||n.organized.mapId,nodeId:nodeIdMap.get(n.organized.nodeId)||n.organized.nodeId}:undefined}))};}
async function importBackup(file){try{const obj=JSON.parse(await file.text());if(obj.format!=='hair-knowledge-map-backup'||!obj.data)throw new Error('不是有效的发型知识导图备份文件');const incoming=remapImported(obj.data);snapshot();state.maps.push(...incoming.maps.map(normalizeMap));state.notes.push(...incoming.notes);state.lastMapId=incoming.maps[0]?.id||state.lastMapId;renderAll();scheduleSave();toast(`已合并 ${incoming.maps.length} 张导图和 ${incoming.notes.length} 条随身记`);}catch(e){toast(`导入失败：${e.message}`);}}

function onCanvasPointerDown(e){const elementEl=e.target.closest?.('[data-element-id]');const nodeEl=e.target.closest?.('[data-id]');const pt=worldPoint(e);if(elementEl){const map=currentMap(),el=(map?.elements||[]).find(x=>x.id===elementEl.dataset.elementId);if(!el)return;if(connectionMode){e.preventDefault();return;}selectedElementId=el.id;selectedNodeId=null;renderCanvas();renderInspector();if(el.type==='connection'){e.preventDefault();return;}drag={kind:'symbol',id:el.id,startX:pt.x,startY:pt.y,origX:Number(el.x||0),origY:Number(el.y||0),origDx:Number(el.dx??0),origDy:Number(el.dy??-78),anchorId:el.anchorNodeId||null,moved:false};if(e.pointerId)$('#canvas').setPointerCapture(e.pointerId);e.preventDefault();return;}if(nodeEl){const map=currentMap(),n=nodeById(map,nodeEl.dataset.id);if(!n)return;if(connectionMode){if(!connectionSourceId){connectionSourceId=n.id;selectedNodeId=n.id;renderCanvas();toast(`已选择起点「${n.title}」，再点一个终点`);}else finishConnection(n.id);e.preventDefault();return;}const subtreeIds=[n.id,...descendants(map,n.id)];const origPositions=Object.fromEntries(subtreeIds.map(id=>{const item=nodeById(map,id);return [id,{x:item.x,y:item.y}];}));selectedNodeId=n.id;selectedElementId=null;renderCanvas();renderInspector();drag={kind:'node',id:n.id,startX:pt.x,startY:pt.y,origX:n.x,origY:n.y,subtreeIds,origPositions,moved:false};if(e.pointerId)$('#canvas').setPointerCapture(e.pointerId);e.preventDefault();}else{selectedElementId=null;renderInspector();drag={kind:'pan',startClientX:e.clientX,startClientY:e.clientY,origX:viewport.x,origY:viewport.y,moved:false};if(e.pointerId)$('#canvas').setPointerCapture(e.pointerId);}}
function onCanvasPointerMove(e){if(!drag)return;if(drag.kind==='node'){const map=currentMap(),p=worldPoint(e),dx=p.x-drag.startX,dy=p.y-drag.startY;if(Math.abs(dx)+Math.abs(dy)>3){if(!drag.moved){snapshot();drag.moved=true;}drag.subtreeIds.forEach(id=>{const item=nodeById(map,id),origin=drag.origPositions[id];if(item&&origin){item.x=origin.x+dx;item.y=origin.y+dy;}});map.manualLayout=true;renderCanvas();renderInspector();scheduleSave();}}else if(drag.kind==='symbol'){const map=currentMap(),el=(map?.elements||[]).find(x=>x.id===drag.id);if(!el)return;const p=worldPoint(e),dx=p.x-drag.startX,dy=p.y-drag.startY;if(Math.abs(dx)+Math.abs(dy)>3){if(!drag.moved){snapshot();drag.moved=true;}el.manualPosition=true;if(drag.anchorId){el.dx=drag.origDx+dx;el.dy=drag.origDy+dy;}else{el.x=drag.origX+dx;el.y=drag.origY+dy;}renderCanvas();scheduleSave();}}else{viewport.x=drag.origX+(e.clientX-drag.startClientX);viewport.y=drag.origY+(e.clientY-drag.startClientY);drag.moved=true;applyViewport();}}
function onCanvasPointerUp(){drag=null;updateLayoutButtons();}
function bind(){
  $$('.nav button').forEach(b=>b.onclick=()=>activateView(b.dataset.view));
  $('#newMapBtn').onclick=()=>openNameDialog('newMap');$('#emptyNewMapBtn').onclick=()=>openNameDialog('newMap');$('#renameMapBtn').onclick=()=>openNameDialog('renameMap');$('#deleteMapBtn').onclick=()=>{const m=currentMap();if(!m)return;$('#confirmTitle').textContent='删除整张导图？';$('#confirmText').textContent=`「${m.name}」及其 ${m.nodes.length} 个节点会被删除，可以用撤销恢复。`;confirmAction=()=>{snapshot();state.maps=state.maps.filter(x=>x.id!==m.id);state.lastMapId=state.maps[0]?.id||null;selectedNodeId=null;renderAll();scheduleSave();};$('#confirmDialog').showModal();};
  $('#mapSelect').onchange=e=>{state.lastMapId=e.target.value;selectedNodeId=null;selectedElementId=null;history={past:[],future:[]};renderAll();scheduleSave();}; $('#newTopicBtn').onclick=addIndependentNode; $('#seedOriginalBtn').onclick=createOriginalMap; $('#connectBtn').onclick=toggleConnectionMode; $('#symbolBtn').onclick=openSymbolDialog; $('#arrangeBtn').onclick=()=>{const m=currentMap();if(!m)return;snapshot();m.manualLayout=false;layoutMap(m);renderAll();scheduleSave();toast('已重新整理布局');};$('#fitBtn').onclick=fitViewport;$('#centerBtn').onclick=fitViewport;$('#zoomInBtn').onclick=()=>zoomAt(1.18);$('#zoomOutBtn').onclick=()=>zoomAt(.85);$('#undoBtn').onclick=undo;$('#redoBtn').onclick=redo;
  $('#canvas').addEventListener('pointerdown',onCanvasPointerDown);$('#canvas').addEventListener('pointermove',onCanvasPointerMove);$('#canvas').addEventListener('pointerup',onCanvasPointerUp);$('#canvas').addEventListener('pointercancel',onCanvasPointerUp);$('#canvas').addEventListener('wheel',e=>{e.preventDefault();zoomAt(e.deltaY<0?1.1:.9,e.clientX,e.clientY);},{passive:false});$('#canvas').addEventListener('dblclick',e=>{const el=e.target.closest?.('[data-id]');if(el){selectedNodeId=el.dataset.id;renderInspector();$('#nodeTitleInput')?.focus();}});
  $$('#nameDialog [data-close-dialog],#linkDialog [data-close-dialog],#symbolDialog [data-close-dialog],#connectionDialog [data-close-dialog],#noteDialog [data-close-dialog],#organizeDialog [data-close-dialog],#confirmDialog [data-close-dialog],#imageDialog [data-close-dialog]').forEach(b=>b.onclick=()=>b.closest('dialog').close());$('#nameDialogOk').onclick=finishNameDialog;$('#linkDialogOk').onclick=finishLinkDialog;$('#connectionDialogOk').onclick=saveConnection;$$('[data-symbol-choice]').forEach(b=>b.onclick=()=>{$('#symbolDialog').close();addSymbol(b.dataset.symbolChoice);});$('#noteForm').onsubmit=saveNote;$('#newNoteBtn').onclick=()=>openNoteDialog();$$('[data-note-filter]').forEach(b=>b.onclick=()=>{noteFilter=b.dataset.noteFilter;$$('[data-note-filter]').forEach(x=>x.classList.toggle('active',x===b));renderNotes();});$$('[data-search-filter]').forEach(b=>b.onclick=()=>{searchFilter=b.dataset.searchFilter;$$('[data-search-filter]').forEach(x=>x.classList.toggle('active',x===b));search();});$('#searchInput').oninput=search;$('#clearSearchBtn').onclick=()=>{$('#searchInput').value='';search();$('#searchInput').focus();};$('#exportBtn').onclick=exportBackup;$('#importBtn').onclick=()=>$('#importFile').click();$('#importFile').onchange=e=>{if(e.target.files[0])importBackup(e.target.files[0]);e.target.value='';};
  $('#organizeMap').onchange=renderOrganizeOptions;$$('[data-organize-mode]').forEach(b=>b.onclick=()=>{organizeMode=b.dataset.organizeMode;$$('[data-organize-mode]').forEach(x=>x.classList.toggle('active',x===b));renderOrganizeOptions();});$('#organizeOk').onclick=finishOrganize;$('#confirmOk').onclick=()=>{if(confirmAction){const fn=confirmAction;confirmAction=null;$('#confirmDialog').close();fn();}};
}
function openNameDialog(action){$('#nameDialog').dataset.action=action;const m=currentMap();const titles={renameMap:'重命名导图',addChild:'添加子节点',addSibling:'添加同级节点',addSymbol:'添加符号',newTopic:'添加独立主题'};$('#nameDialogTitle').textContent=titles[action]||'新建导图';$('#nameDialogInput').value=action==='renameMap'?(m?.name||''):'';$('#nameDialogInput').placeholder=action==='addSymbol'?'输入符号，例如：★、⚠、✓、❗':action==='addChild'?'例如：裁剪、低层次、乐哥':action==='newTopic'?'例如：课程资料、灵感整理':'例如：我的剪裁技术体系';$('#nameDialog').showModal();setTimeout(()=>$('#nameDialogInput').focus(),50);}
function finishNameDialog(){const input=$('#nameDialogInput'),value=input.value.trim(),action=$('#nameDialog').dataset.action;if(!value){toast('请输入名称');return;}if(action==='addChild'||action==='addSibling'){const pending=pendingNodeAction;pendingNodeAction=null;$('#nameDialog').close();if(pending)addNode(pending.parentId,pending.mode,value);return;}if(action==='addSymbol'){$('#nameDialog').close();addSymbol(value);return;}if(action==='newTopic'){$('#nameDialog').close();addIndependentNode(value);return;}if(action==='renameMap'){const m=currentMap();if(m){snapshot();m.name=value;m.updatedAt=now();}}else{snapshot();const n={id:uid('node'),parentId:null,title:value,subtitle:'',x:0,y:0,color:'#b8d8f8',showImage:false,note:'',tags:[],images:[],links:[],collapsed:false};const m={id:uid('map'),name:value,createdAt:now(),updatedAt:now(),rootId:n.id,nodes:[n],elements:[],manualLayout:false};state.maps.push(m);state.lastMapId=m.id;selectedNodeId=n.id;}$('#nameDialog').close();renderAll();scheduleSave();}

async function init(){try{db=await openDb();state=await dbGet();if(!state){state=freshState();await dbPut(state);}state.maps=(state.maps||[]).map(normalizeMap);const addedOriginal=false;if(addedOriginal)state.maps=state.maps.map(normalizeMap);state.notes=state.notes||[];bind();renderAll();setTimeout(()=>{fitViewport();scheduleSave('已保存');},80);}catch(e){console.error(e);setSave('error','数据库不可用');state=freshState();state.maps=state.maps.map(normalizeMap);bind();renderAll();toast('浏览器数据库不可用，仍可编辑但请及时导出备份');}}
init();
