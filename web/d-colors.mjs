const names={original:'原版紫',muted:'雾紫',blue:'湖蓝',teal:'松绿',graphite:'石墨',lilac:'浅藤紫',cloud:'云灰紫',purple90:'原紫·轻调',purple80:'原紫·柔和'};
const choices=[...document.querySelectorAll('[data-palette-choice]')];
const root=document.documentElement;
function selectPalette(name,updateUrl=true){
 if(!Object.hasOwn(names,name))name='original';
 root.classList.add('theme-changing');
 root.dataset.palette=name;
 choices.forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.paletteChoice===name)));
 document.title='IMA Share Sync · D · '+names[name];
 if(updateUrl){const url=new URL(location.href);url.searchParams.set('palette',name);history.replaceState(null,'',url);}
 void document.body.offsetHeight;
 requestAnimationFrame(()=>requestAnimationFrame(()=>root.classList.remove('theme-changing')));
}
choices.forEach(button=>button.addEventListener('click',()=>selectPalette(button.dataset.paletteChoice)));
selectPalette(new URLSearchParams(location.search).get('palette')||'original',false);
await import('/web/flow-options.mjs');
document.title='IMA Share Sync · D · '+names[root.dataset.palette];
