const titles={overview:'总览',servers:'计算服务器',tasks:'服务器任务',workspaces:'项目工作区',clients:'Claude 工具',services:'服务注册',remote:'远程访问',configuration:'配置迁移',help:'使用帮助'};
const aliases={'task-center':'tasks','service-center':'services','workspace-tools':'workspaces'};
export function viewName(hash){const key=String(hash||'').replace(/^#/,'');return aliases[key]|| (Object.hasOwn(titles,key)?key:'overview');}
export function initShell(){
  let status,lastView,ready=false;
  function render(){
    let view=viewName(location.hash);
    if(status?.control.remote!=='local'&&['services','remote','configuration'].includes(view))view='overview';
    for(const section of document.querySelectorAll('[data-page]'))section.hidden=!section.dataset.page.split(' ').includes(view);
    for(const link of document.querySelectorAll('#sidebar-nav a')){
      link.hidden=status?.control.remote!=='local'&&['services','remote','configuration'].includes(link.dataset.view);
      const selected=link.dataset.view===view;link.classList.toggle('active',selected);
      if(selected)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');
    }
    document.getElementById('page-title').textContent=titles[view];document.title=titles[view]+' · Starport Next';
    if(ready&&lastView!==view){lastView=view;document.dispatchEvent(new CustomEvent('starport:view',{detail:view}));window.scrollTo(0,0);}
  }
  const menu=document.getElementById('menu-toggle');
  menu.addEventListener('click',()=>{const opened=document.body.classList.toggle('sidebar-open');menu.setAttribute('aria-expanded',String(opened));});
  document.getElementById('sidebar-nav').addEventListener('click',e=>{if(e.target.closest('a')){if(document.body.classList.contains('sidebar-open'))menu.focus();document.body.classList.remove('sidebar-open');menu.setAttribute('aria-expanded','false');}});
  window.addEventListener('hashchange',render);
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){document.body.classList.remove('sidebar-open');menu.setAttribute('aria-expanded','false');}});
  render();
  return {update(value){status=value;ready=true;document.body.classList.add('authenticated');render();},logout(){ready=false;document.body.classList.remove('authenticated');}};
}
