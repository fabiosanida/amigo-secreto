import { setupInviteFields } from './invite-fields.js';
import { setupGroupFields, parseBudget } from './group-fields.js';
import { setupOTP } from './otp.js';
import { icon, brand, avatar, escapeHtml } from './ui.js';
import { renderAuth, AUTH_ROUTES } from './auth.js';
import { renderGroups, GROUP_ROUTES } from './groups.js';
import { renderEmails, EMAIL_ROUTES } from './emails.js';
import { renderBrand } from './brand.js';
import { createCycle } from './draw.js';

const seedParticipants = [
  {name:'Fábio Almeida',email:'fabio@exemplo.com',status:'accepted',color:0},
  {name:'Ana Oliveira',email:'ana@exemplo.com',status:'accepted',color:1},
  {name:'Bruno Santos',email:'bruno@exemplo.com',status:'accepted',color:2},
  {name:'Carla Lima',email:'carla@exemplo.com',status:'accepted',color:3},
  {name:'Diego Costa',email:'diego@exemplo.com',status:'accepted',color:4},
  {name:'Elisa Rocha',email:'elisa@exemplo.com',status:'accepted',color:5},
  {name:'Marina Alves',email:'marina@exemplo.com',status:'opened',color:0},
  {name:'Rafael Souza',email:'rafael@exemplo.com',status:'delivered',color:4},
  {name:'Júlia Melo',email:'julia@exemplo.com',status:'sent',color:5},
  {name:'Pedro Nunes',email:'pedro@exemplo.com',status:'failed',color:2},
];
const seedGroup = {name:'Natal da família',date:'2026-12-24',budget:100,location:'Casa da vó Lúcia',description:'Uma noite para celebrar quem faz parte da nossa história.'};
const makeState = () => ({
  user:{firstName:'Fábio',lastName:'Almeida',email:'fabio@exemplo.com'},
  group:{...seedGroup},participants:structuredClone(seedParticipants),
  inviteContext:false,drawn:false,revealed:false,customGroup:false,
  inviteEmails:['marina@exemplo.com','rafael@exemplo.com','julia@exemplo.com'],
  match:{name:'Ana Oliveira',email:'ana@exemplo.com'},
  verified:false,newAccount:false,editing:false,resendAt:0,
});
let state = makeState();
let route = location.hash.slice(1) || 'welcome';
let drawTimer, toastTimer;
const sections = [
  {title:'01 · Boas-vindas e acesso',items:[['welcome','Página de entrada'],['register','Criar conta'],['login','Entrar com e-mail'],['verify','Validar código'],['verify-error','Código incorreto'],['verify-expired','Código expirado'],['account-ready','Conta validada']]},
  {title:'02 · Grupos e convites',items:[['dashboard','Meus grupos'],['dashboard-empty','Nenhum grupo ainda'],['create-group','Criar amigo secreto'],['group','Acompanhar participantes'],['invite','Convidar pessoas'],['invites-sent','Convites enviados']]},
  {title:'03 · Quem recebe o convite',items:[['invitation','Convite · já tenho conta'],['invitation-new','Convite · nova conta'],['invitation-accepted','Participação confirmada'],['invitation-expired','Convite indisponível'],['invitation-closed','Sorteio já realizado']]},
  {title:'04 · A hora da surpresa',items:[['draw-confirm','Confirmar sorteio'],['draw-running','Sorteio em andamento'],['drawn','Sorteio concluído'],['reveal','Revelar meu amigo']]},
  {title:'05 · E-mails da aplicação',items:[['email-verify','E-mail · validar conta'],['email-invite','E-mail · convite'],['email-result','E-mail · resultado']]},
  {title:'06 · Identidade visual',items:[['brand','Marca, cores e tipografia']]},
];
const routes=sections.flatMap(section=>section.items);
const isValidRoute=value=>routes.some(([key])=>key===value);
const safeState=()=>structuredClone(state);
const titleFor=value=>routes.find(([key])=>key===value)?.[1]||'Amigo Secreto';

function appShell(content) {
 return `<header class="app-header"><a class="app-brand-link" href="#dashboard" aria-label="Amigo Secreto, meus grupos">${brand()}</a><nav class="app-nav" aria-label="Navegação principal"><button class="${route!=='brand'?'active':''}" data-route="dashboard">Meus grupos</button><button data-action="help">Como funciona</button></nav><div class="app-account"><button class="icon-button" data-action="notifications" aria-label="Ver notificações">${icon('bell',19)}</button><span class="account-name">${escapeHtml(state.user.firstName)}</span><button data-action="profile" aria-label="Minha conta">${avatar(state.user.firstName+' '+state.user.lastName,0)}</button></div></header><main id="main" class="app-main transition-in">${content}</main><footer class="app-footer"><span>${icon('heart',13)} Gente querida. Boas surpresas.</span><button data-action="help">Feito para aproximar.</button></footer>`;
}

function render() {
 if (!isValidRoute(route)) { route='welcome'; history.replaceState(null,'','#welcome'); }
 const snapshot=safeState();
 let content=renderAuth(route,snapshot) ?? renderGroups(route,snapshot) ?? renderEmails(route,snapshot) ?? renderBrand(route,snapshot);
 if (content==null) content='<main id="main" class="app-main"><h1>Vamos começar?</h1><button class="btn btn-primary" data-route="welcome">Voltar ao início</button></main>';
 document.querySelector('#app').innerHTML=(GROUP_ROUTES.includes(route)||route==='brand')?appShell(content):content;
 document.body.dataset.screen=route;
 document.title=`${titleFor(route)} · Amigo Secreto`;
 renderToolbar();
 window.scrollTo({top:0,behavior:'instant'});
 document.querySelectorAll('form').forEach(form=>form.addEventListener('submit',handleSubmit));
 setupOTP(document.querySelector('#app'));
 setupInviteFields(document.querySelector('#app'));
 setupGroupFields(document.querySelector('#app'));
 updateCountdown();
}

function renderToolbar() {
 const index=routes.findIndex(([key])=>key===route);
 const inviteFlow=['group','invite','invites-sent'].includes(route)&&!state.drawn;
 document.querySelector('#review-tools').innerHTML=`<aside class="review-bar" aria-label="Ferramentas de revisão do protótipo"><div class="review-left"><span class="review-badge"><span class="review-dot"></span>Prévia visual</span><span class="review-divider"></span><button class="review-control" data-action="open-picker">${icon('grid',14)} Todas as telas <span class="review-count">${routes.length}</span></button><span class="review-hint">${['verify','verify-error','verify-expired'].includes(route)?'Código de demonstração: 123456':'Dados demonstrativos · sem envios reais'}</span>${inviteFlow?'<button class="review-control" data-action="demo-accept" title="Simular confirmações de participantes neste protótipo">Simular aceites</button>':''}</div><div class="review-right"><button class="review-control review-reset" data-action="reset">Reiniciar</button><button class="review-arrow" data-action="previous-screen" aria-label="Tela anterior">${icon('arrow-left',15)}</button><span class="review-current">${escapeHtml(titleFor(route))}</span><span class="review-count">${index+1}/${routes.length}</span><button class="review-arrow" data-action="next-screen" aria-label="Próxima tela">${icon('arrow-right',15)}</button></div></aside>`;
}

function navigate(next, {gallery=false}={}) {
 if (!isValidRoute(next)) return;
 clearTimeout(drawTimer);
 if(gallery) {
   state.newAccount=false;
   if(['group','draw-confirm','draw-running','drawn','reveal','email-result'].includes(next)) {
     state.group={...seedGroup}; state.participants=structuredClone(seedParticipants);
     state.match={name:'Ana Oliveira',email:'ana@exemplo.com'};
   }
   state.drawn=['drawn','reveal','email-result','invitation-closed'].includes(next);
   state.revealed=false;
   if(['verify','verify-error','verify-expired'].includes(next)) state.resendAt=0;
   if(next==='create-group') state.editing=false;
 }
 if(next==='dashboard'&&state.newAccount&&!state.customGroup&&!gallery) next='dashboard-empty';
 if(next==='invitation'&&state.drawn) next='invitation-closed';
 route=next;
 if(location.hash!==`#${next}`) history.pushState(null,'',`#${next}`);
 document.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close());
 render();
 if(next==='draw-running') scheduleDraw();
}

function toast(message) {
 const element=document.querySelector('#toast');
 element.textContent=message; element.classList.add('show');
 clearTimeout(toastTimer); toastTimer=setTimeout(()=>element.classList.remove('show'),4000);
}
function formError(form,message) {
 let element=form.querySelector('.form-error');
 if(!element) {element=document.createElement('div');element.className='form-error';element.setAttribute('role','alert');form.prepend(element);}
 element.textContent=message; element.scrollIntoView({block:'nearest'});
}
function handleSubmit(event) {
 event.preventDefault();
 const form=event.currentTarget;
 if(!form.reportValidity()) return;
 const data=new FormData(form);
 const value=key=>String(data.get(key)||'').trim();
 switch(form.dataset.form) {
 case 'register':
   if(!value('firstName')||!value('lastName')) {formError(form,'Preencha seu nome e sobrenome para continuar.');return;}
   state.user={firstName:value('firstName'),lastName:value('lastName'),email:value('email').toLowerCase()};
   state.newAccount=true;
   state.resendAt=Date.now()+30000; navigate('verify'); break;
 case 'login':
   state.user.email=value('email').toLowerCase(); state.newAccount=false; state.resendAt=Date.now()+30000; navigate('verify'); break;
 case 'verify':
   if(value('code')!=='123456') {navigate('verify-error');return;}
   state.verified=true;
   navigate(state.inviteContext?'invitation':'account-ready');break;
 case 'create-group': {
   const date=value('date');
   if(!date||date<new Intl.DateTimeFormat('en-CA',{timeZone:'America/Maceio'}).format(new Date())) {formError(form,'Escolha uma data válida a partir de hoje.');return;}
   const budget=parseBudget(value('budget'));
   if(!Number.isFinite(budget)||budget<1) {formError(form,'Informe um valor de presente a partir de R$ 1,00.');return;}
   state.group={name:value('name'),date,budget,location:value('location'),description:value('description')};
   if(!state.editing) {
     state.participants=[{name:state.user.firstName+' '+state.user.lastName,email:state.user.email,status:'accepted',color:0}];
     state.drawn=false;state.revealed=false;state.inviteEmails=[];
   }
   state.customGroup=true;
   navigate(state.editing?'group':'invite');state.editing=false;toast('Grupo salvo na prévia.');break;
 }
 case 'invite': {
   const entries=data.getAll('emails').map(item=>String(item).trim().toLowerCase());
   if(!entries.length||entries.length>50||entries.some(email=>!email)) {formError(form,'Preencha de 1 a 50 campos de e-mail antes de enviar.');return;}
   const emails=[...new Set(entries)];
   const invalid=emails.filter(email=>! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
   if(invalid.length) {formError(form,`Confira estes endereços: ${invalid.join(', ')}.`);return;}
   const newEmails=emails.filter(email=>!state.participants.some(person=>person.email===email));
   if(!newEmails.length) {formError(form,'Esses e-mails já fazem parte da lista de convidados.');return;}
   state.inviteEmails=newEmails;
   newEmails.forEach((email,index)=>state.participants.push({name:email.split('@')[0].replace(/[._-]/g,' ').replace(/\b\w/g,letter=>letter.toUpperCase()),email,status:'sent',color:index%6}));
   navigate('invites-sent');break;
 }
 default: toast('Dados conferidos nesta prévia.');
 }
}

function showPicker() {
 const dialog=document.querySelector('#screen-picker');
 dialog.innerHTML=`<div class="picker-header"><div><span class="eyebrow">O caminho completo da surpresa</span><h2>Uma aplicação, ${routes.length} momentos.</h2><p>Explore as telas, as confirmações e as mensagens que chegam por e-mail.</p></div><button class="icon-button" data-action="close-dialog" aria-label="Fechar galeria">${icon('x')}</button></div><div class="picker-content">${sections.map(section=>`<section class="picker-group"><h3>${section.title}</h3>${section.items.map(([key,label])=>`<button class="picker-item${key===route?' current':''}" data-preview-route="${key}"><span>${icon(key.startsWith('email')?'mail':key==='brand'?'sparkles':key.startsWith('draw')?'gift':'chevron-right',15)}${label}</span>${key===route?icon('check',14):''}</button>`).join('')}</section>`).join('')}</div><div class="picker-footer">Os formulários e botões simulam o fluxo. Código de validação: <strong>123456</strong>. E-mails e banco serão conectados após a aprovação dos layouts.</div>`;
 dialog.showModal();
}
function showHelp(profile=false) {
 const dialog=document.querySelector('#help-dialog');
 dialog.innerHTML=`<div class="help-body"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:28px">${brand()}<button class="icon-button" data-action="close-dialog" aria-label="Fechar">${icon('x')}</button></div>${profile?`<span class="eyebrow">Sua conta</span><h2 id="help-title">Olá, ${escapeHtml(state.user.firstName)}.</h2><p>${escapeHtml(state.user.firstName+' '+state.user.lastName)}<br><span class="muted">${escapeHtml(state.user.email)}</span></p><span class="pill pill-green">${icon('check',13)} E-mail validado</span><button class="btn btn-secondary btn-block" style="margin-top:28px" data-action="logout">Sair da conta</button>`:`<span class="eyebrow">Simples do começo à surpresa</span><h2 id="help-title">Reúna. Convide. Surpreenda.</h2><div class="help-step"><span class="help-number">1</span><div><h3>Junte sua turma</h3><p class="muted">Crie seu grupo, combine a data e o valor do presente.</p></div></div><div class="help-step"><span class="help-number">2</span><div><h3>Convide por e-mail</h3><p class="muted">Cada pessoa confirma sua participação. Você acompanha tudo no grupo.</p></div></div><div class="help-step"><span class="help-number">3</span><div><h3>Deixe a surpresa acontecer</h3><p class="muted">Com pelo menos 3 pessoas confirmadas, faça o sorteio. Cada pessoa presenteia outra em um único ciclo, sem tirar a si mesma ou formar pares recíprocos.</p></div></div><button class="btn btn-primary btn-block" data-action="close-dialog">Entendi, vamos lá ${icon('arrow-right',16)}</button>`}</div>`;
 dialog.showModal();
}
function runDraw() {
 if(state.drawn) {navigate('drawn');return;}
 if(state.participants.filter(person=>person.status==='accepted').length<3) {toast('Confirme pelo menos 3 participantes antes de sortear.');return;}
 const checkbox=document.querySelector('input[name="drawConsent"]');
 if(checkbox&&!checkbox.checked) {checkbox.required=true;checkbox.reportValidity();return;}
 navigate('draw-running');
}
function scheduleDraw() {
 drawTimer=setTimeout(()=>{
   const accepted=state.participants.filter(person=>person.status==='accepted');
   if(accepted.length<3) {navigate('draw-confirm');return;}
   const cycle=createCycle(accepted);
   state.match=cycle.find(pair=>pair.giver.email===state.user.email)?.receiver||cycle[0].receiver;
   state.drawn=true;state.revealed=false;navigate('drawn');
 },2200);
}
function updateCountdown() {
 const seconds=Math.max(0,Math.ceil((state.resendAt-Date.now())/1000));
 document.querySelectorAll('[data-countdown]').forEach(el=>{el.textContent=seconds?`00:${String(seconds).padStart(2,'0')}`:'';});
 document.querySelectorAll('[data-action="resend-code"]').forEach(el=>{el.disabled=seconds>0;});
}

document.addEventListener('click',event=>{
 if(event.target.closest('.skip-link')) {
   event.preventDefault();const main=document.querySelector('#main');
   if(main) {main.tabIndex=-1;main.focus();main.scrollIntoView({block:'start'});}return;
 }
 const target=event.target.closest('[data-route],[data-preview-route],[data-action]');
 if(!target||target.disabled) return;
 if(target.dataset.previewRoute) {event.preventDefault();navigate(target.dataset.previewRoute,{gallery:true});return;}
 if(target.dataset.route) {event.preventDefault();navigate(target.dataset.route);return;}
 const action=target.dataset.action;
 if(!action) return;
 event.preventDefault();
 switch(action) {
 case 'open-picker':showPicker();break;
 case 'close-dialog':target.closest('dialog')?.close();break;
 case 'next-screen':case 'previous-screen': {
   const index=routes.findIndex(([key])=>key===route);
   navigate(routes[(index+(action==='next-screen'?1:-1)+routes.length)%routes.length][0],{gallery:true});break;
 }
 case 'reset':state=makeState();navigate('welcome');toast('Prévia reiniciada.');break;
 case 'help':showHelp();break;
 case 'profile':showHelp(true);break;
 case 'logout':state.verified=false;navigate('welcome');break;
 case 'notifications':navigate(state.drawn?'email-result':'email-invite');break;
 case 'verify-email-link':state.verified=true;navigate(state.inviteContext?'invitation':'account-ready');break;
 case 'register-invited':state.inviteContext=true;navigate('register');break;
 case 'login-invited':state.inviteContext=true;navigate('login');break;
 case 'resend-code':
   if(Date.now()<state.resendAt) return;
   state.resendAt=Date.now()+30000;navigate('verify');toast('Novo código simulado. Use 123456 para continuar.');break;
 case 'accept-invite':
   if(state.drawn) {navigate('invitation-closed');return;}
   state.newAccount=false;
   if(!state.participants.some(person=>person.email===state.user.email)) state.participants.push({name:state.user.firstName+' '+state.user.lastName,email:state.user.email,status:'accepted',color:0});
   else state.participants.find(person=>person.email===state.user.email).status='accepted';
   navigate('invitation-accepted');break;
 case 'run-draw':runDraw();break;
 case 'reveal':state.revealed=true;if(route!=='reveal') navigate('reveal');else render();break;
 case 'hide-result':state.revealed=false;render();break;
 case 'demo-accept':
   state.participants.forEach(person=>{if(person.status!=='failed') person.status='accepted';});
   render();toast('Aceites simulados. Os convidados confirmados já podem participar.');break;
 case 'resend-invite': {
   const person=state.participants.find(item=>item.email===target.dataset.email);
   if(person) person.status='sent';render();toast('Reenvio simulado. O convite voltou para a fila.');break;
 }
 case 'resend-all':
   state.participants.forEach(person=>{if(person.status!=='accepted') person.status='sent';});render();toast('Reenvio dos convites pendentes simulado.');break;
 case 'edit-group':state.editing=true;navigate('create-group');break;
 case 'copy-invite':
   navigator.clipboard?.writeText(`${location.origin}/#invitation`).then(()=>toast('Link da prévia copiado.')).catch(()=>toast('Abra a tela “Convite” e copie o endereço do navegador.'));break;
 default:toast('Explore este momento pela opção “Todas as telas”.');
 }
});
document.querySelectorAll('dialog').forEach(dialog=>dialog.addEventListener('click',event=>{if(event.target===dialog) {const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom) dialog.close();}}));
window.addEventListener('popstate',()=>{route=location.hash.slice(1)||'welcome';clearTimeout(drawTimer);render();if(route==='draw-running')scheduleDraw();});
window.addEventListener('hashchange',()=>{const next=location.hash.slice(1)||'welcome';if(next!==route){route=next;render();}});
setInterval(updateCountdown,1000);
render();
if(route==='draw-running')scheduleDraw();
