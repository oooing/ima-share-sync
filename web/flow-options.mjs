
const [icons, brand] = await Promise.all([
 fetch('/web/icons.json').then(r=>r.json()), fetch('/web/obsidian-brand.json').then(r=>r.json()),
]);
const $=(s,root=document)=>root.querySelector(s), $$=(s,root=document)=>Array.from(root.querySelectorAll(s));
const icon=name=>(icons[name]||'').replace('<svg','<svg aria-hidden="true"');
const logo='data:image/svg+xml,'+encodeURIComponent(brand.svg);
const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const groups={source:{name:'来源',icon:'folder'},sync:{name:'同步规则',icon:'refresh-cw'},save:{name:'保存',icon:'folder'}};
const defaults={source:['reports','oct'],destination:['阅读','研报'],children:true,mode:'new',limit:100,depth:3,folderCount:10,filter:'all',keyword:'',overwrite:false,keepFolder:true,review:false,active:null,extra:{source:false,sync:false,save:false}};
const models=Object.fromEntries(['d','e','f'].map(v=>[v,structuredClone(defaults)]));
models.e.active='source';
let variant=['d','e','f'].includes(location.hash.slice(1))?location.hash.slice(1):'d';
let dialogGroup='source',dialogTab='basic',lastNode='source',toastTimer;
const state=()=>models[variant], config=$('#config'), picker=$('#picker');
const tree=[
 {id:'reports',name:'机构研报',children:[{id:'oct',name:'2026年10月',children:[{id:'261031',name:'261031',children:[{id:'charts',name:'图表',children:[]},{id:'appendix',name:'附录',children:[]}]},{id:'261030',name:'261030',children:[]}]},{id:'nov',name:'2026年11月',children:[]}]},
 {id:'learning',name:'我的学习资料',children:[{id:'notes',name:'学习笔记',children:[]},{id:'books',name:'读书摘录',children:[]}]},
 {id:'industry',name:'行业观察',children:[{id:'chips',name:'半导体',children:[]},{id:'energy',name:'能源',children:[]}]},
];
const saveTree=[{id:'阅读',name:'阅读',children:[{id:'研报',name:'研报',children:[]},{id:'资料',name:'资料',children:[]}]},{id:'学习',name:'学习',children:[]},{id:'IMA',name:'IMA',children:[]}];
function pathNodes(nodes,path){const result=[];let list=nodes;for(const id of path){const node=list.find(n=>n.id===id);if(!node)break;result.push(node);list=node.children;}return result;}
const sourcePath=()=>pathNodes(tree,state().source).map(n=>n.name);
const quantity=()=>state().limit?'每次最多 '+state().limit+' 个新增文件':'全部新增文件';
const folderArt=kind=>'<span class="folder-art" aria-hidden="true"><svg class="folder-frame" viewBox="0 0 112 90" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M15 22V15a6 6 0 0 1 6-6h28l8 8h33a7 7 0 0 1 7 7v49H15Z" stroke="currentColor" stroke-width="1.5" opacity=".25"/><path d="M8 31a7 7 0 0 1 7-7h23l9 8h50a7 7 0 0 1 7 7v35a7 7 0 0 1-7 7H15a7 7 0 0 1-7-7Z" fill="currentColor" fill-opacity=".08" stroke="currentColor" stroke-width="1.6"/></svg><span class="folder-content">'+(kind==='source'?icon('folder'):'<img src="'+logo+'" alt="">')+'</span></span>';
function nodeContent(group){
 const s=state(),parts=sourcePath();
 const graphic=group==='sync'?'<span class="flow-sync-art"><span class="flow-sync-ring">'+icon('refresh-cw')+'</span></span>':folderArt(group);
 const title=group==='source'?parts.at(-1):group==='save'?s.destination.at(-1)||'当前仓库':s.mode==='new'?'仅同步新增':'全部同步';
 const path=group==='source'?(parts.slice(0,-1).join(' / ')||'IMA 知识库'):group==='save'?'Obsidian · '+(s.destination.join(' / ')||'当前仓库'):s.mode==='new'?quantity():'补齐未同步的文件';
 const hint=variant==='f'?'查看设置':group==='source'?'选择来源':group==='save'?'选择位置':'设置规则';
 return '<h2>'+groups[group].name+'</h2>'+graphic+'<strong>'+esc(title)+'</strong><span class="node-path">'+esc(path)+'</span><span class="node-hint">'+hint+icon('chevron-right')+'</span>';
}
function mapMarkup(){
 return ['source','sync','save'].map((group,i)=>(i?'<span class="flow-connector" aria-hidden="true">'+icon('chevron-right')+'</span>':'')+'<button type="button" class="flow-node" data-node="'+group+'" aria-label="'+(group==='source'?'设置来源':group==='sync'?'设置同步规则':'设置保存位置')+'"'+(variant==='d'?' aria-haspopup="dialog"':variant==='e'?' aria-expanded="'+(state().active===group)+'" aria-controls="inline-editor"':' aria-controls="full-'+group+'"')+(variant==='e'?' aria-pressed="'+(state().active===group)+'"':'')+'>'+nodeContent(group)+'</button>').join('');
}
function render(){
 document.title='IMA Share Sync · '+variant.toUpperCase()+' 图示交互稿';
 $$('.new-options a').forEach(a=>a.hash==='#'+variant?a.setAttribute('aria-current','page'):a.removeAttribute('aria-current'));
 $('#preview').innerHTML=
 '<div class="ima-share-sync-support"><div class="ima-share-sync-support-icon">'+icon('star')+'</div><div class="ima-share-sync-support-copy"><div class="ima-share-sync-support-title">喜欢这个插件？</div><div class="ima-share-sync-support-description">如果你觉得 IMA Share Sync 对你有帮助，请点赞和分享，让更多人看到。</div></div><a class="ima-share-sync-support-link" href="https://github.com/oooing/ima-share-sync" target="_blank" rel="noopener noreferrer">去 GitHub 点星</a></div>'+
 '<div class="ima-settings-tabs-header">'+[['bar-chart-2','使用统计'],['folder','同步与保存'],['file-text','文档转换'],['bell','通知提醒'],['settings','基础设置']].map(([i,n])=>'<button type="button" data-static class="ima-settings-tab-btn'+(n==='同步与保存'?' is-active':'')+'" data-app-tab="'+n+'"><span>'+icon(i)+'</span><span>'+n+'</span></button>').join('')+'</div>'+
 '<div id="flow-map" class="flow-map" role="group" aria-label="从 IMA 来源到 Obsidian 保存位置">'+mapMarkup()+'</div>'+
 (variant==='e'?'<div id="inline-editor"></div>':variant==='f'?'<div class="flow-all-panels">'+Object.entries(groups).map(([key,g])=>'<section class="flow-full-panel" id="full-'+key+'" tabindex="-1" aria-label="'+g.name+'设置" data-label="'+g.name+'"><h3>基本设置</h3><div data-basic="'+key+'"></div><h4 class="flow-other-title">其他设置</h4><div data-extra="'+key+'"></div></section>').join('')+'</div>':'');
 $$('[data-node]').forEach(button=>button.onclick=()=>{
  const group=button.dataset.node;lastNode=group;
  if(variant==='d'){dialogGroup=group;dialogTab='basic';renderConfig();config.showModal();}
  else if(variant==='e'){state().active=group;renderInline();updateMap();}
  else {const section=$('#full-'+group);section.scrollIntoView({block:'nearest'});section.focus({preventScroll:true});}
 });
 $$('[data-app-tab]').forEach(button=>button.onclick=()=>{if(button.dataset.appTab!=='同步与保存')notify('此交互稿只展示“同步与保存”');});
 renderEditors();
}
function updateMap(){
 $$('[data-node]').forEach(button=>{
  button.innerHTML=nodeContent(button.dataset.node);
  if(variant==='e'){button.setAttribute('aria-expanded',String(state().active===button.dataset.node));button.setAttribute('aria-pressed',String(state().active===button.dataset.node));}
 });
}
function field(label,control,description='',className=''){
 return '<div class="flow-field '+className+'"><div class="flow-field-label">'+label+(description?'<small>'+description+'</small>':'')+'</div><div class="flow-control">'+control+'</div></div>';
}
function select(key,label,values,disabled=false){
 return '<select data-field="'+key+'" aria-label="'+label+'"'+(disabled?' disabled':'')+'>'+values.map(([value,text])=>'<option value="'+value+'"'+(String(state()[key])===String(value)?' selected':'')+'>'+text+'</option>').join('')+'</select>';
}
function toggle(key,label){return '<input type="checkbox" class="web-toggle" role="switch" aria-label="'+label+'" data-field="'+key+'"'+(state()[key]?' checked':'')+'>';}
function basic(group){
 const s=state();
 if(group==='source')return (s.review?'<div class="flow-review" role="alert"><span>知识库已更换，请确认同步范围。</span><button type="button" data-ack aria-label="关闭范围提醒">'+icon('x')+'</button></div>':'')+
 field('知识库与文件夹','<button type="button" class="path-choice" data-browse="source" aria-label="选择来源"><span>'+esc(sourcePath().join(' / '))+'</span>'+icon('chevron-down')+'</button>')+
 field('同步范围','<div class="flow-segment" role="group" aria-label="同步范围"><button type="button" data-set="children" data-value="false" aria-pressed="'+!s.children+'">'+(s.source.length>1?'仅当前文件夹':'仅知识库本层')+'</button><button type="button" data-set="children" data-value="true" aria-pressed="'+s.children+'">包含子文件夹</button></div>');
 if(group==='sync')return '<div class="flow-mode-options" role="group" aria-label="同步方式">'+[['all','layers','全部同步'],['new','clock','仅同步新增']].map(([mode,i,title])=>'<button type="button" class="flow-mode-choice" data-set="mode" data-value="'+mode+'" aria-pressed="'+(s.mode===mode)+'"><span>'+icon(i)+'<span class="mode-mark">'+icon('check')+'</span></span><strong>'+title+'</strong></button>').join('')+'</div>'+
 field('新增文件数量',select('limit','新增文件数量',[[20,'每次最多 20 个'],[50,'每次最多 50 个'],[100,'每次最多 100 个'],[200,'每次最多 200 个'],[0,'全部新增文件']],s.mode==='all'));
 return field('保存位置','<button type="button" class="path-choice" data-browse="save" aria-label="选择保存位置"><span>'+esc(s.destination.join(' / ')||'当前仓库')+'</span>'+icon('chevron-down')+'</button>');
}
function advanced(group){
 const s=state();
 if(group==='source')return field('检查子文件夹',select('folderCount','检查子文件夹',[[5,'最近 5 个'],[10,'最近 10 个'],[20,'最近 20 个']],!s.children||s.mode==='all'))+
 field('子文件夹层数',select('depth','子文件夹层数',[[1,'1 层'],[2,'2 层'],[3,'3 层'],[4,'4 层'],[5,'5 层']],!s.children));
 if(group==='sync')return field('文件筛选',select('filter','文件筛选',[['all','所有文件'],['contains','标题包含'],['prefix','标题开头为'],['regex','正则表达式']]))+
 (s.filter!=='all'?field(s.filter==='regex'?'表达式':'关键词','<input type="text" data-field="keyword" aria-label="'+(s.filter==='regex'?'表达式':'关键词')+'" value="'+esc(s.keyword)+'" placeholder="'+(s.filter==='regex'?'输入表达式':'输入关键词')+'">'):'');
 return field('同名覆盖',toggle('overwrite','同名覆盖'),'同一文件有更新时，替换已保存版本。','flow-switch-field')+
 field('保留目录',toggle('keepFolder','保留目录'),'按来源中的文件夹结构保存。','flow-switch-field');
}
function bind(root){
 $$('[data-field]',root).forEach(input=>input.addEventListener(input.type==='text'?'input':'change',()=>{
  const key=input.dataset.field;
  state()[key]=input.type==='checkbox'?input.checked:['limit','depth','folderCount'].includes(key)?Number(input.value):input.value;
  updateMap();
  if(key==='filter')refreshFields('field',key);
 }));
 $$('[data-set]',root).forEach(button=>button.onclick=()=>{
  const key=button.dataset.set;state()[key]=key==='children'?button.dataset.value==='true':button.dataset.value;
  updateMap();refreshFields('set',key,button.dataset.value);
 });
 $$('[data-browse]',root).forEach(button=>button.onclick=()=>browse(button.dataset.browse,button));
 $$('[data-ack]',root).forEach(button=>button.onclick=()=>{state().review=false;refreshFields();});
}
function refreshFields(kind,key,value){
 renderEditors();if(config.open)renderConfig();
 const root=config.open?config:$('#preview');
 const target=kind==='field'?$('[data-field="'+key+'"]',root):kind==='set'?$('[data-set="'+key+'"][data-value="'+value+'"]',root):null;
 target?.focus({preventScroll:true});
}
function renderEditors(){
 if(variant==='e')renderInline();
 if(variant==='f')Object.keys(groups).forEach(group=>{
  $('[data-basic="'+group+'"]').innerHTML=basic(group);$('[data-extra="'+group+'"]').innerHTML=advanced(group);
  bind($('#full-'+group));
 });
}
function renderInline(){
 const group=state().active,root=$('#inline-editor');if(!root)return;
 if(!group){root.innerHTML='';return;}
 const open=state().extra[group];
 root.innerHTML='<section class="flow-sheet" aria-label="'+groups[group].name+'设置" style="--panel-anchor:'+({source:'16%',sync:'50%',save:'84%'}[group])+'"><div class="flow-sheet-head"><h2>'+groups[group].name+'</h2><button type="button" data-collapse aria-label="收起设置">'+icon('x')+'</button></div><div class="flow-fields">'+basic(group)+'</div><div class="flow-extra"><button type="button" data-expand aria-expanded="'+open+'">'+icon('chevron-right')+'其他设置</button>'+(open?'<div class="flow-fields">'+advanced(group)+'</div>':'')+'</div></section>';
 bind(root);
 $('[data-collapse]',root).onclick=()=>{state().active=null;renderInline();updateMap();$('[data-node="'+group+'"]')?.focus();};
 $('[data-expand]',root).onclick=()=>{state().extra[group]=!open;renderInline();$('[data-expand]',root)?.focus({preventScroll:true});};
}
function renderConfig(){
 config.innerHTML='<div class="flow-dialog-head"><h2 id="config-title">'+icon(groups[dialogGroup].icon)+groups[dialogGroup].name+'设置</h2><button type="button" data-close-config aria-label="关闭设置弹窗">'+icon('x')+'</button></div>'+
 '<div class="flow-tabs" role="tablist" aria-label="设置层级">'+[['basic','基本设置'],['advanced','高级设置']].map(([id,label])=>'<button class="flow-tab" data-static type="button" role="tab" id="tab-'+id+'" aria-controls="config-panel" aria-selected="'+(id===dialogTab)+'" tabindex="'+(id===dialogTab?'0':'-1')+'" data-tab="'+id+'">'+label+'</button>').join('')+'</div>'+
 '<div class="flow-fields" id="config-panel" role="tabpanel" aria-labelledby="tab-'+dialogTab+'">'+(dialogTab==='basic'?basic(dialogGroup):advanced(dialogGroup))+'</div><div class="flow-modal-foot"><button type="button" class="mod-cta" data-close-config>完成</button></div>';
 $$('[data-close-config]',config).forEach(button=>button.onclick=()=>config.close());
 $$('[data-tab]',config).forEach(button=>{
  const activate=()=>{dialogTab=button.dataset.tab;renderConfig();$('[data-tab="'+dialogTab+'"]',config).focus();};
  button.onclick=activate;
  button.onkeydown=event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();dialogTab=event.key==='Home'?'basic':event.key==='End'?'advanced':dialogTab==='basic'?'advanced':'basic';renderConfig();$('[data-tab="'+dialogTab+'"]',config).focus();}};
 });
 bind(config);
}
config.addEventListener('close',()=>{$('[data-node="'+lastNode+'"]')?.focus({preventScroll:true});});
function browse(kind,trigger){
 const s=state(),nodes=kind==='source'?tree:saveTree;
 let path=[...(kind==='source'?s.source:s.destination)];
 function view(){
  const resolved=pathNodes(nodes,path),current=resolved.at(-1),children=current?current.children:nodes;
  const root=kind==='source'?'全部知识库':'当前仓库';
  picker.innerHTML='<div class="flow-dialog-head"><h2 id="picker-title">'+(kind==='source'?'选择来源':'选择保存位置')+'</h2><button type="button" data-cancel aria-label="关闭选择弹窗">'+icon('x')+'</button></div>'+
   '<nav class="flow-breadcrumb" aria-label="当前位置"><button type="button" data-level="0"'+(!path.length?' aria-current="location"':'')+'>'+root+'</button>'+resolved.map((item,i)=>icon('chevron-right')+'<button type="button" data-level="'+(i+1)+'"'+(i===resolved.length-1?' aria-current="location"':'')+'>'+esc(item.name)+'</button>').join('')+'</nav>'+
   '<input type="search" class="flow-search" aria-label="搜索当前位置" placeholder="'+(!path.length&&kind==='source'?'搜索知识库':'搜索当前目录')+'"><div class="flow-list"></div>'+
   '<div class="flow-modal-foot"><button type="button" data-cancel>取消</button><button type="button" class="mod-cta" id="use-location" aria-label="'+(kind==='source'?'使用此来源':'使用此保存位置')+'"'+(kind==='source'&&!path.length?' disabled':'')+'>'+(kind==='source'&&!path.length?'请选择来源':'使用「'+esc(current?.name||root)+'」')+'</button></div>';
  $$('[data-cancel]',picker).forEach(button=>button.onclick=()=>picker.close());
  $$('[data-level]',picker).forEach(button=>button.onclick=()=>{path=path.slice(0,Number(button.dataset.level));view();});
  $('#use-location',picker).onclick=()=>{
   if(kind==='source'){s.review=s.source[0]!==path[0];s.source=[...path];}else s.destination=[...path];
   picker.close();updateMap();refreshFields();
   const root=config.open?config:$('#preview');$('[data-browse="'+kind+'"]',root)?.focus({preventScroll:true});
  };
  const rows=query=>{
   const matches=children.filter(item=>item.name.includes(query));
   $('.flow-list',picker).innerHTML=matches.map(item=>'<button type="button" data-enter="'+esc(item.id)+'" aria-label="进入 '+esc(item.name)+'">'+icon(!path.length&&kind==='source'?'book-open':'folder')+'<span>'+esc(item.name)+'</span>'+icon('chevron-right')+'</button>').join('')||'<p>'+(query?'没有找到匹配项。':'没有子文件夹，可直接使用当前位置。')+'</p>';
   $$('[data-enter]',picker).forEach(button=>button.onclick=()=>{path.push(button.dataset.enter);view();});
  };
  $('.flow-search',picker).oninput=event=>rows(event.target.value);rows('');
 }
 view();picker.showModal();
 picker.addEventListener('close',()=>{if(trigger.isConnected)trigger.focus({preventScroll:true});},{once:true});
}
function notify(text){clearTimeout(toastTimer);$('#feedback').textContent=text;$('#feedback').classList.add('visible');toastTimer=setTimeout(()=>$('#feedback').classList.remove('visible'),1600);}
document.addEventListener('pointerdown',()=>{document.body.dataset.input='pointer';},{passive:true});
document.addEventListener('keydown',()=>{document.body.dataset.input='keyboard';});
window.addEventListener('hashchange',()=>{
 if(picker.open)picker.close();if(config.open)config.close();
 variant=['d','e','f'].includes(location.hash.slice(1))?location.hash.slice(1):'d';render();
});
$('#theme').onclick=()=>{
 document.documentElement.classList.add('theme-changing');
 const dark=document.documentElement.dataset.theme!=='dark';document.documentElement.dataset.theme=dark?'dark':'light';
 document.body.classList.toggle('theme-dark',dark);document.body.classList.toggle('theme-light',!dark);
 $('#theme').textContent=dark?'浅色':'深色';$('#theme').setAttribute('aria-label',dark?'切换浅色外观':'切换深色外观');
 void document.body.offsetHeight;requestAnimationFrame(()=>requestAnimationFrame(()=>document.documentElement.classList.remove('theme-changing')));
};
$('#reset').onclick=()=>{models[variant]=structuredClone(defaults);if(variant==='e')models.e.active='source';if(picker.open)picker.close();if(config.open)config.close();render();notify('本方案已重置');};
render();
