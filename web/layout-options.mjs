const brand = await (await fetch('/web/obsidian-brand.json')).json();
const icons = await (await fetch('/web/icons.json')).json();
const folderFrame = '<svg class="folder-frame" viewBox="0 0 112 90" aria-hidden="true"><path d="M15 22V15a6 6 0 0 1 6-6h28l8 8h33a7 7 0 0 1 7 7v49H15Z" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".25"/><path d="M8 31a7 7 0 0 1 7-7h23l9 8h50a7 7 0 0 1 7 7v35a7 7 0 0 1-7 7H15a7 7 0 0 1-7-7Z" fill="currentColor" fill-opacity=".08" stroke="currentColor" stroke-width="1.6"/></svg>';
const svg = body => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const chevron = svg('<path d="m9 5 7 7-7 7"/>');
const folder = icons.folder;
const sync = icons['refresh-cw'];
const variants = {a:['整齐分行','标题、图标、内容和操作各占同一行，长文字完整展示。'],b:['简洁摘要','标题一行、路径两行。需要时展开完整名称与路径。'],c:['信息分区','图示在上，信息在下。长路径左对齐，操作统一放在底部。']};
function render(){
  const version = Object.hasOwn(variants,location.hash.slice(1)) ? location.hash.slice(1) : 'a';
  document.querySelector('h1').textContent = variants[version][0];
  document.querySelector('.intro p').textContent = variants[version][1];
  document.querySelectorAll('nav a').forEach(a=>{if(a.hash===`#${version}`)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});
  const long = document.querySelector('#long').checked;
  const data = [
    ['来源',long?'全球金融市场与行业研究精选 · 2026年10月':'2026年10月','2027全球八大顶级投行研报库1','选择来源'],
    ['同步规则','仅同步新增','检查最新 100 个，\n跳过已同步','设置规则'],
    ['保存',long?'2026年10月全球市场与行业研究【最新】':'2026年10月【最新】',`Obsidian · 03投资/投资资料收集/机构研报/${long?'全球金融市场/每月归档/':''}2026年10月【最新】`,'选择位置']
  ];
  const flow = document.querySelector('#flow'); flow.dataset.version=version; flow.replaceChildren();
  data.forEach(([heading,title,detail,action],index)=>{
    const node=document.createElement('article');node.className='node';
    const art=index===1?`<span class="ring">${sync}</span>`:`<div class="folder">${folderFrame}${index===0?`<span class="folder-inner">${folder}</span>`:`<img class="logo" alt="" src="data:image/svg+xml,${encodeURIComponent(brand.svg)}">`}</div>`;
    node.innerHTML=`<h2>${heading}</h2><div class="art" aria-hidden="true">${art}</div><strong></strong><div class="detail"></div><span class="action">${action}${chevron}</span>`;
    node.querySelector('strong').textContent=title;node.querySelector('.detail').textContent=detail;
    if(version==='b'&&index!==1){const more=document.createElement('details');const summary=document.createElement('summary');summary.textContent='完整信息';more.append(summary);const p=document.createElement('p');const b=document.createElement('b');b.textContent=title;p.append(b,detail);more.append(p);node.append(more);}
    flow.append(node);
  });
  ['first','second'].forEach(cls=>{const arrow=document.createElement('span');arrow.className=`arrow ${cls}`;arrow.setAttribute('aria-hidden','true');arrow.innerHTML=chevron;flow.append(arrow);});
}
window.addEventListener('hashchange',render);document.querySelector('#long').addEventListener('change',render);render();
