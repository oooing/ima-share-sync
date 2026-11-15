
const icons = await fetch('/web/icons.json').then(response => response.json());
const $ = selector => document.querySelector(selector);
const icon = name => (icons[name] || '').replace('<svg', '<svg aria-hidden="true"');
const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const preview = $('#preview'), dialog = $('#options');
const defaults = { activeGroup:'source', source:['reports','oct','261031'], includeChildren:true, mode:'new', limit:100, destination:['阅读','研报'], folderCount:10, depth:3, filter:'all', keyword:'', overwrite:false, keepFolder:true, review:false };
const models = Object.fromEntries(['a','b','c'].map(key => [key, structuredClone(defaults)]));
const groups = { source:{name:'来源',icon:'folder',description:'子文件夹层数、检查数量'}, sync:{name:'同步',icon:'clock',description:'新增文件数量、文件筛选'}, save:{name:'保存',icon:'download',description:'同名覆盖、保留目录'} };
const tree = [
 {id:'reports',name:'机构研报',children:[
  {id:'oct',name:'2026年10月',children:[{id:'261031',name:'261031',children:[{id:'charts',name:'图表',children:[]},{id:'appendix',name:'附录',children:[]}]},{id:'261030',name:'261030',children:[]}]},
  {id:'nov',name:'2026年11月',children:[]},{id:'topics',name:'专题研究',children:[]}]},
 {id:'learning',name:'我的学习资料',children:[{id:'notes',name:'学习笔记',children:[]},{id:'reading',name:'阅读清单',children:[]}]},
 {id:'industry',name:'行业观察',children:[{id:'semiconductors',name:'半导体',children:[]},{id:'energy',name:'能源',children:[]}]},
];
const saveTree = [{id:'阅读',name:'阅读',children:[{id:'研报',name:'研报',children:[]},{id:'资料',name:'资料',children:[]}]},{id:'IMA',name:'IMA',children:[]},{id:'学习',name:'学习',children:[]}];
let variant = ['a','b','c'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'a';
let feedbackTimer;
const state = () => models[variant];
const resolvePath = (nodes,path) => path.reduce((result,id) => {const item=(result.at(-1)?.children || nodes).find(node=>node.id===id); if(item)result.push(item);return result;},[]);
const sourceName = () => resolvePath(tree,state().source).map(item=>item.name).join(' / ');
const quantity = () => state().limit ? '每次最多 '+state().limit+' 个新增文件' : '同步全部新增文件';
const option = (value,name,current) => '<option value="'+escape(value)+'"'+(String(value)===String(current)?' selected':'')+'>'+escape(name)+'</option>';
function row(name,control,description='') {
 return '<div class="setting-item"><div class="setting-item-info"><div class="setting-item-name">'+name+'</div>'+(description?'<div class="setting-item-description">'+description+'</div>':'')+'</div><div class="setting-item-control">'+control+'</div></div>';
}
function notify(text) {
 clearTimeout(feedbackTimer); $('#feedback').textContent=text; $('#feedback').classList.add('visible');
 feedbackTimer=setTimeout(()=>$('#feedback').classList.remove('visible'),1700);
}
function groupHead(key) {
 return '<div class="prototype-group-head"><h2>'+groups[key].name+'</h2>'+(variant==='a'?'<button class="prototype-more" type="button" data-advanced="'+key+'" aria-label="'+groups[key].name+'高级设置">'+icon('settings')+'高级设置</button>':'')+'</div>';
}
function render() {
 const s=state();
 document.title='IMA Share Sync · '+variant.toUpperCase()+' 交互稿';
 document.querySelectorAll('.prototype-switcher a').forEach(link=> {
   if(link.hash==='#'+variant)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');
 });
 preview.innerHTML=
 '<div class="ima-share-sync-support"><div class="ima-share-sync-support-icon">'+icon('star')+'</div><div class="ima-share-sync-support-copy"><div class="ima-share-sync-support-title">喜欢这个插件？</div><div class="ima-share-sync-support-description">如果你觉得 IMA Share Sync 对你有帮助，请点赞和分享，让更多人看到。</div></div><a class="ima-share-sync-support-link" href="https://github.com/oooing/ima-share-sync" target="_blank" rel="noopener noreferrer">去 GitHub 点星</a></div>'+
 '<div class="ima-settings-tabs-header">'+[['bar-chart-2','使用统计'],['folder','同步与保存'],['file-text','文档转换'],['bell','通知提醒'],['settings','基础设置']].map(([i,n])=>'<button type="button" class="ima-settings-tab-btn'+(n==='同步与保存'?' is-active':'')+'" data-static-tab="'+n+'"><span>'+icon(i)+'</span><span>'+n+'</span></button>').join('')+'</div>'+
 (variant!=='a'?'<div class="prototype-actions"><button class="prototype-more" type="button" id="advanced">'+icon('settings')+'高级设置</button></div>':'')+
 '<section class="prototype-group" aria-label="来源">'+groupHead('source')+'<div class="prototype-surface">'+
 row('知识库与文件夹','<button type="button" id="source" class="ima-source-chooser prototype-location" aria-label="选择来源"><span>'+escape(sourceName())+'</span><span>'+icon('chevron-down')+'</span></button>')+
 row('同步范围','<div class="ima-scope-segmented" role="group" aria-label="同步范围"><button type="button" data-scope="false" aria-pressed="'+!s.includeChildren+'">'+(s.source.length>1?'仅当前文件夹':'仅知识库本层')+'</button><button type="button" data-scope="true" aria-pressed="'+s.includeChildren+'">包含子文件夹</button></div>')+'</div>'+
 (s.review?'<div class="ima-identity-alert" role="alert"><strong>已切换知识库，请确认同步范围。</strong><button class="ima-identity-alert-close" id="review" aria-label="关闭范围提醒">'+icon('x')+'</button></div>':'')+'</section>'+
 '<section class="prototype-group" aria-label="同步">'+groupHead('sync')+'<div class="ima-mode-columns" role="radiogroup" aria-label="同步方式">'+
 [['all','layers','全部同步','检查所选来源，补齐未同步的文件。'],['new','clock','仅同步新增',quantity()]].map(([mode,i,title,summary])=>
 '<div class="ima-mode-column"><div tabindex="0" role="radio" aria-checked="'+(s.mode===mode)+'" aria-label="'+title+'" data-mode="'+mode+'" class="ima-main-mode-card'+(s.mode===mode?' is-active':'')+'"><div class="ima-card-header-row"><div class="ima-card-icon">'+icon(i)+'</div><div class="ima-check-circle">'+icon('check')+'</div></div><div><div class="ima-card-title">'+title+'</div><div class="ima-card-summary-row">'+(mode==='new'?'<button type="button" class="prototype-quantity" id="quantity" aria-label="选择新增文件数量"><span>'+summary+'</span>'+icon('chevron-down')+'</button>':summary)+'</div></div></div></div>').join('')+'</div></section>'+
 '<section class="prototype-group" aria-label="保存">'+groupHead('save')+'<div class="prototype-surface">'+row('保存位置','<button type="button" id="destination" class="ima-source-chooser prototype-location" aria-label="选择保存位置"><span>'+escape(s.destination.join(' / ')||'当前仓库')+'</span><span>'+icon('chevron-down')+'</span></button>')+'</div></section>';
 $('#source').onclick=()=>browse('source');
 $('#destination').onclick=()=>browse('save');
 document.querySelectorAll('[data-advanced]').forEach(button=>button.onclick=()=>openAdvanced(button.dataset.advanced));
 if($('#advanced'))$('#advanced').onclick=()=>openAdvanced(variant==='c'?null:state().activeGroup);
 document.querySelectorAll('[data-scope]').forEach(button=>button.onclick=()=>{s.includeChildren=button.dataset.scope==='true';render();});
 document.querySelectorAll('[data-mode]').forEach(card=>{
  const activate=()=>{s.mode=card.dataset.mode;render();};
  card.onclick=activate;
  card.onkeydown=event=>{if(event.target===card && ['Enter',' '].includes(event.key)){event.preventDefault();activate();}};
 });
 $('#quantity').onclick=event=>{event.stopPropagation();s.mode='new';render();openQuantity();};
 document.querySelectorAll('[data-static-tab]').forEach(button=>button.onclick=()=>{if(button.dataset.staticTab!=='同步与保存')notify('此交互稿只展示“同步与保存”');});
 if($('#review'))$('#review').onclick=()=>{s.review=false;render();};
}
function modal(title,body,footer,back) {
 const wasOpen=dialog.open;
 dialog.innerHTML='<div class="prototype-modal-head"><div class="prototype-modal-title">'+(back?'<button class="back" type="button" id="modal-back" aria-label="返回分类">'+icon('arrow-left')+'</button>':'')+'<h2 id="dialog-title">'+title+'</h2></div><button type="button" id="close-modal" aria-label="关闭弹窗">'+icon('x')+'</button></div>'+body+'<div class="modal-button-container">'+(footer||'<button type="button" class="mod-cta" id="done">完成</button>')+'</div>';
 $('#close-modal').onclick=()=>dialog.close();
 if($('#done'))$('#done').onclick=()=>dialog.close();
 if(back)$('#modal-back').onclick=back;
 if(!wasOpen)dialog.showModal();
}
function openAdvanced(key) {
 if(variant==='c' && !key) {
   modal('高级设置','<div class="prototype-summary">'+Object.entries(groups).map(([id,group])=>'<button type="button" data-category="'+id+'" aria-label="'+group.name+'高级设置">'+icon(group.icon)+'<span><strong>'+group.name+'</strong><small>'+group.description+'</small></span>'+icon('chevron-right')+'</button>').join('')+'</div>');
   document.querySelectorAll('[data-category]').forEach(button=>button.onclick=()=>openAdvanced(button.dataset.category));
   return;
 }
 state().activeGroup=key;
 const s=state(),tabs=variant==='b'?'<div class="prototype-modal-tabs" role="tablist" aria-label="高级设置分类">'+Object.entries(groups).map(([id,group])=>'<button type="button" role="tab" aria-selected="'+(key===id)+'" data-category="'+id+'">'+group.name+'</button>').join('')+'</div>':'';
 let fields='';
 const select=(key,label,options)=>'<select data-field="'+key+'" aria-label="'+label+'">'+options.map(([v,n])=>option(v,n,s[key])).join('')+'</select>';
 const toggle=(key,label)=>'<input type="checkbox" role="switch" class="web-toggle" data-field="'+key+'" aria-label="'+label+'"'+(s[key]?' checked':'')+'>';
 if(key==='source')fields=
 row('检查子文件夹',select('folderCount','检查子文件夹',[[5,'最近 5 个'],[10,'最近 10 个'],[20,'最近 20 个']]))+
 row('子文件夹层数',select('depth','子文件夹层数',[[1,'1 层'],[2,'2 层'],[3,'3 层'],[4,'4 层'],[5,'5 层']]));
 if(key==='sync')fields=
 row('新增文件数量',select('limit','新增文件数量',[[20,'每次最多 20 个'],[50,'每次最多 50 个'],[100,'每次最多 100 个'],[200,'每次最多 200 个'],[0,'全部新增文件']]))+
 row('文件筛选',select('filter','文件筛选',[['all','所有文件'],['contains','标题包含'],['prefix','标题开头为'],['regex','正则表达式']]))+
 (s.filter!=='all'?row(s.filter==='regex'?'表达式':'关键词','<input type="text" data-field="keyword" aria-label="'+(s.filter==='regex'?'表达式':'关键词')+'" value="'+escape(s.keyword)+'" placeholder="'+(s.filter==='regex'?'输入表达式':'输入关键词')+'">'):'');
 if(key==='save')fields=
 row('同名覆盖',toggle('overwrite','同名覆盖'),'同一文件有更新时，替换已保存的版本。')+
 row('保留目录',toggle('keepFolder','保留目录'),'按来源中的文件夹结构保存。');
 modal(variant==='b'?'高级设置':groups[key].name+'高级设置',tabs+'<div class="prototype-fields"'+(variant==='b'?' role="tabpanel" aria-label="'+groups[key].name+'"':'')+'>'+fields+'</div>',null,variant==='c'?()=>openAdvanced(null):undefined);
 document.querySelectorAll('[data-category]').forEach(button=>button.onclick=()=>openAdvanced(button.dataset.category));
 document.querySelectorAll('[data-field]').forEach(input=>{
  const key=input.dataset.field;
  input.addEventListener(input.type==='text'?'input':'change',()=>{
   s[key]=input.type==='checkbox'?input.checked:['folderCount','depth','limit'].includes(key)?Number(input.value):input.value;
   render();
   if(key==='filter')openAdvanced('sync');
  });
 });
 if(key==='source')document.querySelectorAll('[data-field]').forEach(input=>input.disabled=!s.includeChildren);
 if(key==='sync')dialog.querySelector('[data-field="limit"]').disabled=s.mode==='all';
}
function openQuantity() {
 modal('新增文件数量','<div class="prototype-quantity-list" role="group" aria-label="新增文件数量">'+[20,50,100,200,0].map(n=>'<button type="button" data-limit="'+n+'" aria-pressed="'+(state().limit===n)+'">'+(n?'最多 '+n+' 个新增文件':'全部新增文件')+'</button>').join('')+'</div>');
 document.querySelectorAll('[data-limit]').forEach(button=>button.onclick=()=>{state().limit=Number(button.dataset.limit);render();dialog.close();});
}
function browse(kind) {
 const nodes=kind==='source'?tree:saveTree, s=state();
 let path=[...(kind==='source'?s.source:s.destination)];
 function view() {
  const resolved=resolvePath(nodes,path), current=resolved.at(-1), children=current?current.children:nodes;
  const root=kind==='source'?'全部知识库':'当前仓库';
  const crumbs='<nav class="prototype-crumbs" aria-label="当前位置"><button type="button" data-level="0"'+(!path.length?' aria-current="location"':'')+'>'+root+'</button>'+resolved.map((part,i)=>icon('chevron-right')+'<button type="button" data-level="'+(i+1)+'"'+(i===resolved.length-1?' aria-current="location"':'')+'>'+escape(part.name)+'</button>').join('')+'</nav>';
  modal(kind==='source'?'选择来源':'选择保存位置',crumbs+'<input type="search" class="prototype-search" aria-label="搜索当前位置" placeholder="'+(!path.length&&kind==='source'?'搜索知识库':'搜索当前目录')+'"><div class="prototype-browser"></div>',
   '<button type="button" id="cancel">取消</button><button type="button" id="use-location" class="mod-cta" aria-label="'+(kind==='source'?'使用此来源':'使用此保存位置')+'"'+(kind==='source'&&!path.length?' disabled':'')+'>'+(kind==='source'&&!path.length?'请选择来源':'使用「'+escape(current?.name||root)+'」')+'</button>');
  $('#cancel').onclick=()=>dialog.close();
  $('#use-location').onclick=()=>{
   if(kind==='source'){s.review=s.source[0]!==path[0];s.source=[...path];}else s.destination=[...path];
   render();dialog.close();
  };
  document.querySelectorAll('[data-level]').forEach(button=>button.onclick=()=>{path=path.slice(0,Number(button.dataset.level));view();});
  const showRows=query=>{
   const items=children.filter(item=>item.name.includes(query));
   $('.prototype-browser').innerHTML=items.map(item=>'<button type="button" data-enter="'+escape(item.id)+'" aria-label="进入 '+escape(item.name)+'">'+icon(kind==='source'&&!path.length?'book-open':'folder')+'<span>'+escape(item.name)+'</span>'+icon('chevron-right')+'</button>').join('')||'<p>'+(query?'没有找到匹配项。':'没有子文件夹，可直接使用当前位置。')+'</p>';
   document.querySelectorAll('[data-enter]').forEach(button=>button.onclick=()=>{path.push(button.dataset.enter);view();});
  };
  $('.prototype-search').oninput=event=>showRows(event.target.value);
  showRows('');
 }
 view();
}
window.addEventListener('hashchange',()=>{
 variant=['a','b','c'].includes(location.hash.slice(1))?location.hash.slice(1):'a';
 if(dialog.open)dialog.close();render();
});
$('#theme').onclick=()=>{
 const dark=document.documentElement.dataset.theme!=='dark';
 document.documentElement.dataset.theme=dark?'dark':'light';
 document.body.classList.toggle('theme-dark',dark);document.body.classList.toggle('theme-light',!dark);
 $('#theme').textContent=dark?'浅色':'深色';$('#theme').setAttribute('aria-label',dark?'切换浅色外观':'切换深色外观');
};
$('#reset').onclick=()=>{models[variant]=structuredClone(defaults);if(dialog.open)dialog.close();render();notify('本方案已重置');};
render();
