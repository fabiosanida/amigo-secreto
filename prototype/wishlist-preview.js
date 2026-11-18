// Review-only prototype. All interactions use fictional in-memory data.
// This module is intentionally excluded from scripts/build.mjs and the live app.
import { icon, brand, avatar, escapeHtml as esc } from './ui.js';

const extraIcons = {
  edit: '<path d="m15 4 5 5M4 20l5-1L20 8a3 3 0 0 0-5-5L4 14z"/>',
  link: '<path d="m10 13 4-4M8 15l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m2 3 2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0" transform="translate(1 1) scale(.9)"/>',
  external: '<path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
};
const glyph = (name, size=20) => extraIcons[name] ? `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${extraIcons[name]}</svg>` : icon(name,size);
const groupName='Amigo secreto da família';
const screens=[
  ['antes','01 · Grupo antes do sorteio'],
  ['apos','02 · Grupo após o sorteio'],
  ['minha-lista','03 · Editar minhas sugestões'],
  ['lista-vazia','04 · Cadastrar a primeira sugestão'],
  ['meu-amigo','05 · Meu amigo secreto'],
  ['sugestoes','06 · Presentes do amigo secreto'],
  ['sem-sugestoes','07 · Amigo sem sugestões'],
  ['dependente','08 · Sugestões de um dependente'],
];
const ownSeed=[
  {text:'Um livro de mistério ou suspense. Adoro histórias com uma boa reviravolta!',url:''},
  {text:'Uma caneca de cerâmica, de preferência em verde ou terracota.',url:'https://exemplo.com/caneca-de-ceramica'},
];
const friendSeed=[
  {text:'Um caderno sem pauta para desenhar. Gosto de capas lisas, em tons de verde.',url:'https://exemplo.com/caderno-verde'},
  {text:'Café especial, moído para coador. Adoro experimentar sabores novos!',url:''},
  {text:'Uma caneca grande de cerâmica, em cores claras. A partir de 300 ml seria perfeito.',url:'https://exemplo.com/caneca-ceramica'},
];
const childSeed=[{text:'Um livro ilustrado sobre animais ou dinossauros. Pode ser para a faixa de 6 a 8 anos.',url:''}];
const state={own:structuredClone(ownSeed),child:structuredClone(childSeed),draft:[],person:'self',drawn:true,dirty:false,returnScreen:'apos'};
const app=document.querySelector('#wish-app');
const gifts=document.querySelector('#wp-gift-dialog');
const discard=document.querySelector('#wp-discard-dialog');
let screen=screens.some(([key])=>key===location.hash.slice(1))?location.hash.slice(1):'apos';
let nextId=0,toastTimer,pendingScreen='';
const itemId=()=>`wish-${++nextId}`;
const isEditor=()=>['minha-lista','lista-vazia','dependente'].includes(screen);
const counter=(n)=>`${n} ${n===1?'sugestão':'sugestões'}`;
const back=(target,label='Voltar para o grupo')=>`<a class="group-back" href="#${target}" data-screen="${target}">${glyph('arrow-left',16)} ${label}</a>`;
const badge=(text,kind='green')=>`<span class="pill pill-${kind}">${glyph(kind==='green'?'check-circle':'clock',14)} ${text}</span>`;

function header(){return `<header class="app-header wp-header"><a class="app-brand-link" href="#antes" data-screen="antes" aria-label="Amigo Secreto, grupo de exemplo">${brand()}</a><nav class="app-nav" aria-label="Navegação principal"><button class="active" data-screen="antes">Meus grupos</button><button data-action="demo-info">Como funciona</button></nav><div class="app-account"><span class="account-name">Fábio</span><button data-action="demo-info" aria-label="Minha conta de exemplo">${avatar('Fábio Almeida',0)}</button></div></header>`;}
function facts(){return `<div class="wp-event-strip"><div class="wp-fact">${glyph('calendar',23)}<div><small>DATA DA TROCA</small><strong>22 de dezembro</strong></div></div><div class="wp-fact">${glyph('gift',23)}<div><small>VALOR SUGERIDO</small><strong>R$ 50,00</strong></div></div><div class="wp-fact">${glyph('heart',23)}<div><small>NOSSO PONTO DE ENCONTRO</small><strong>Casa da família</strong></div></div><span class="wp-strip-flower" aria-hidden="true">✳</span></div>`;}
function ownCard(featured=false,compact=false){
  const count=state.own.length;
  return `<section class="wp-own-card ${featured?'is-featured':''} ${compact?'is-compact':''}" aria-labelledby="wp-own-title"><span class="wp-own-symbol">${glyph(featured?'sparkles':'gift',28)}</span><div class="wp-own-copy"><span class="eyebrow">${featured?'JÁ TEM ALGUÉM PENSANDO NO SEU PRESENTE':'UMAS PISTAS PARA ACERTAR NO CARINHO'}</span><h2 id="wp-own-title">${featured?'O que faria você sorrir?':'O que você gostaria de ganhar?'}</h2><p>${featured?'Ajude quem tirou você a escolher. Complete suas sugestões para este grupo e deixe a surpresa com a sua cara.':'Conte seus desejos para este amigo secreto. Você pode começar agora e editar depois do sorteio.'}</p>${count?`<div class="wp-mini-items"><span>${glyph('check-circle',15)} ${counter(count)} na sua lista</span>${state.own.slice(0,2).map(item=>`<span>${esc(item.text.length>38?item.text.slice(0,35)+'…':item.text)}</span>`).join('')}</div>`:''}</div><div class="wp-own-actions"><button class="btn ${featured?'btn-coral':'btn-secondary'}" data-action="edit-own">${glyph(count?'edit':'plus',17)} ${count?'Editar minhas sugestões':'Adicionar sugestões'}</button><small>${featured?'Dê pistas. Guarde a surpresa.':'Uma lista só para este grupo.'}</small></div></section>`;
}
function roster(){
  const names=['Carol Oliveira','Guilherme Santos','Bruno Lima','Fábio Almeida','Ana Oliveira','Sofia Costa'];
  return `<section class="panel wp-roster"><div class="wp-roster-heading"><div><h2>A turma <span>${names.length}</span></h2><p>Quem vai fazer parte dessa história.</p></div></div><div class="wp-roster-tabs">${glyph('users',18)} Participantes <button class="wp-subtle" data-action="refresh">${glyph('refresh',15)} Atualizar lista</button></div><div class="wp-people">${names.map((name,i)=>`<div class="wp-person">${avatar(name,i)}<div><strong>${name}${i===3?' <span class="wp-you">você</span>':''}</strong><small>${i===0?'Organizadora':i===3?'Sua participação está confirmada':'Participante confirmado'}</small></div><span class="pill pill-green">${glyph('check-circle',13)} Participando</span></div>`).join('')}</div><div class="wp-roster-foot">${glyph('lock',15)} Cada pessoa consulta apenas o próprio resultado.</div></section>`;
}
function groupPage(drawn){
  state.drawn=drawn;
  return `<section>${back('antes','Meus grupos')}<div class="wp-group-heading"><div><span class="eyebrow">GENTE QUERIDA, PRESENTE CERTO</span><h1>${groupName}</h1><p>Comes, bebes e diversão.</p></div>${badge(drawn?'Sorteio realizado':'Aguardando sorteio',drawn?'green':'orange')}</div>${facts()}${ownCard(drawn)}<div class="wp-group-grid">${roster()}<aside class="wp-sidebar"><div class="panel wp-side-card"><span class="wp-side-symbol">${glyph(drawn?'gift':'check',28)}</span><span class="eyebrow">${drawn?'A SURPRESA JÁ TEM DESTINO':'VOCÊ FAZ PARTE'}</span><h2>${drawn?'Um presente.<br>Alguém especial.':'Sua participação<br>está confirmada.'}</h2><p>${drawn?'Seu amigo secreto está esperando seu carinho. Descubra quem é e veja as pistas que essa pessoa deixou.':'Enquanto a turma se reúne, você já pode deixar algumas ideias de presente na sua lista.'}</p>${drawn?`<button class="btn btn-primary btn-block" data-screen="meu-amigo">Ver meu amigo secreto ${glyph('arrow-right',18)}</button>`:`<div class="wp-waiting">${glyph('clock',17)} Aguardando o sorteio</div>`}</div><p class="wp-private-note">${glyph('lock',17)} ${drawn?'Ver sugestões não revela quem tirou você.':'Suas sugestões ficarão disponíveis para quem tirar você.'}</p></aside></div></section>`;
}
function editItem(item,index){return `<article class="wp-item" data-item="${item.id}"><div class="wp-item-top"><span class="wp-number">${String(index+1).padStart(2,'0')}</span><h3>Sugestão ${index+1}</h3><button type="button" class="wp-remove" data-remove="${item.id}" aria-label="Remover sugestão ${index+1}">${glyph('trash',16)} <span>Remover</span></button></div><label class="field" for="text-${item.id}">O que você gostaria de ganhar?<textarea id="text-${item.id}" name="text-${item.id}" data-field="text" rows="3" placeholder="Ex.: um livro de suspense, uma camiseta tamanho M, um café especial..." aria-describedby="error-${item.id}">${esc(item.text)}</textarea></label><label class="field wp-link-field" for="url-${item.id}"><span>Link do presente <small>opcional</small></span><span class="wp-input-icon">${glyph('link',17)}<input type="text" inputmode="url" id="url-${item.id}" data-field="url" name="url-${item.id}" placeholder="https://loja.com/presente" value="${esc(item.url)}" aria-describedby="error-${item.id}" autocomplete="off"></span></label><p class="wp-field-error" id="error-${item.id}" role="alert" hidden></p></article>`;}
function editor(){
  const child=state.person==='child';
  return `<section class="wp-editor">${back(state.returnScreen)}<div class="wp-editor-heading"><span class="eyebrow">${groupName.toUpperCase()}</span><h1>${child?'Os desejos de Bia.':'Pequenas pistas. Boas surpresas.'}</h1><p>${child?'Ajude quem tirar Bia a escolher um presente com a cara dela.':'Conte o que você gostaria de ganhar. Uma ideia por item, do seu jeito.'}</p></div><div class="wp-editor-grid"><form class="wp-form" novalidate><div class="wp-person-switch" aria-label="De quem são estas sugestões?"><button type="button" data-person="self" class="${child?'':'active'}" aria-pressed="${!child}">${avatar('Fábio Almeida',0,'small')} Para mim</button><button type="button" data-person="child" class="${child?'active':''}" aria-pressed="${child}">${avatar('Bia Almeida',1,'small')} Para Bia <span>dependente</span></button></div>${child?`<div class="wp-child-note">${glyph('users',18)} Você está definindo os presentes que <strong>Bia Almeida</strong> gostaria de ganhar neste grupo.</div>`:''}<div class="wp-items">${state.draft.map(editItem).join('')}</div><button class="btn btn-secondary wp-add" type="button" data-action="add-item">${glyph('plus',19)} Adicionar outra sugestão</button><p class="wp-unlimited">Quantas ideias quiser. O link é sempre opcional.</p><div class="wp-editor-footer"><div>${glyph('lock',15)} <span>Lista de ${child?'Bia':'Fábio'} · só neste grupo</span></div><div><button class="btn btn-secondary" type="button" data-screen="${state.returnScreen}">Cancelar</button><button class="btn btn-primary" type="submit">${glyph('check',18)} Salvar sugestões</button></div></div></form><aside class="wp-editor-aside"><div class="wp-tip-card"><span class="wp-tip-symbol">${glyph('heart',27)}</span><span class="eyebrow">O CARINHO ESTÁ NOS DETALHES</span><h2>Uma dica faz<br>toda a diferença.</h2><p>Vale contar a cor favorita, o tamanho, o estilo ou o tipo de presente que combina com ${child?'Bia':'você'}.</p><div class="wp-tip-example"><span>POR EXEMPLO</span><p>“Uma camiseta básica, tamanho M. Gosto de verde, azul e cores neutras.”</p></div><div class="wp-budget-note">${glyph('gift',21)}<div><span>Valor combinado no grupo</span><strong>R$ 50,00</strong></div></div><p class="wp-tip-foot">São sugestões para inspirar. O presente continua sendo uma surpresa.</p></div><p class="wp-private-note">${glyph('lock',18)} Depois do sorteio, quem tirar ${child?'Bia':'você'} poderá consultar esta lista. As sugestões podem ser atualizadas mesmo depois do sorteio.</p></aside></div></section>`;
}
function reveal(){return `<section class="wp-reveal">${back('apos')}<div class="wp-reveal-heading"><span class="eyebrow">${groupName.toUpperCase()}</span></div><div class="wp-reveal-grid"><article class="wp-match-card"><span class="eyebrow">SEU AMIGO SECRETO É</span><div class="wp-match-photo">${avatar('Ana Oliveira',2,'large')}</div><h2>Ana Oliveira</h2><button class="btn btn-primary btn-block" data-action="open-suggestions">${glyph('gift',18)} Ver sugestões de presentes ${glyph('arrow-right',17)}</button></article></div><div class="wp-reveal-bottom"><button class="btn btn-secondary" data-screen="apos">${glyph('arrow-left',17)} Voltar para o grupo</button></div></section>`;}
function giftDialog(empty=false){
  return `<div class="wp-dialog-header">${avatar('Ana Oliveira',2,'large')}<div><span class="eyebrow">UMAS PISTAS PARA A SUA SURPRESA</span><h2 id="wp-dialog-title">Os desejos de Ana</h2><p>Sugestões para ${groupName.toLowerCase()}</p></div><button class="wp-close icon-button" data-action="close-gifts" aria-label="Fechar sugestões">${glyph('x',20)}</button></div><div class="wp-dialog-context"><span>${glyph('gift',17)} Valor combinado: <strong>R$ 50,00</strong></span><span>${counter(empty?0:friendSeed.length)}</span></div>${empty?`<div class="wp-empty-state"><span>${glyph('gift',40)}</span><h3>As pistas ainda<br>estão a caminho.</h3><p>Ana ainda não adicionou sugestões para este grupo. Volte mais tarde para conferir.</p><div>${glyph('heart',17)} Até lá, pense no que faz Ana sorrir.</div></div>`:`<div class="wp-gift-list">${friendSeed.map((item,i)=>`<article class="wp-gift-card"><span class="wp-number">${String(i+1).padStart(2,'0')}</span><div><p>${esc(item.text)}</p>${item.url?`<a class="wp-product-link" href="${item.url}" target="_blank" rel="noopener noreferrer" data-demo-link>${glyph('external',16)} Ver referência do presente <span>exemplo.com</span></a>`:'<span class="wp-no-link">Uma ideia, do seu jeito.</span>'}</div></article>`).join('')}</div>`}<div class="wp-dialog-footer"><p>${glyph('heart',17)} São ideias para inspirar, não uma lista de obrigações.</p><button class="btn btn-secondary" data-action="close-gifts">Voltar ao meu amigo secreto</button></div>`;
}
function render(){
  const content=isEditor()?editor():['meu-amigo','sugestoes','sem-sugestoes'].includes(screen)?reveal():groupPage(screen==='apos');
  app.innerHTML=`${header()}<main id="main" class="app-main wp-main">${content}</main><footer class="app-footer"><span>${glyph('heart',14)} Gente querida. Boas surpresas.</span><span>Feito para aproximar.</span></footer>`;
  document.querySelector('#wp-review').innerHTML=`<span class="wp-review-label"><i></i> PRÉVIA DE LAYOUTS</span><label class="wp-screen-label" for="wp-screen-select">Tela</label><select id="wp-screen-select" aria-label="Escolher layout">${screens.map(([key,label])=>`<option value="${key}" ${key===screen?'selected':''}>${label}</option>`).join('')}</select><div class="wp-review-arrows"><button class="icon-button" data-action="previous" aria-label="Layout anterior">${glyph('arrow-left',17)}</button><button class="icon-button" data-action="next" aria-label="Próximo layout">${glyph('arrow-right',17)}</button></div><small>Dados fictícios · nada é salvo na aplicação</small>`;
  document.title=`${screens.find(([key])=>key===screen)?.[1].slice(5)} · Prévia Amigo Secreto`;
  document.querySelector('.wp-form')?.addEventListener('submit',save);
  document.querySelector('#wp-screen-select').addEventListener('change',event=>navigate(event.target.value,true));
}
function toast(message){clearTimeout(toastTimer);const el=document.querySelector('#wp-toast');el.textContent=message;el.classList.add('show');toastTimer=setTimeout(()=>el.classList.remove('show'),4500);}
function beginEditor(target){
  state.person=target==='dependente'?'child':'self';
  const items=target==='lista-vazia'?[{text:'',url:''}]:state.person==='child'?state.child:state.own;
  state.draft=(items.length?items:[{text:'',url:''}]).map(item=>({...item,id:itemId()}));state.dirty=false;
}
function navigate(target,fromReview=false,force=false){
  if(!screens.some(([key])=>key===target))return;
  if(isEditor()&&state.dirty&&!force){pendingScreen=target;discard.innerHTML=`<div class="wp-dialog-header"><div><span class="eyebrow">ANTES DE SAIR</span><h2 id="wp-discard-title">Guardar essas ideias?</h2><p>Você tem alterações que ainda não salvou.</p></div></div><div class="wp-dialog-footer"><button class="btn btn-secondary" data-action="discard-changes">Descartar alterações</button><button class="btn btn-primary" data-action="keep-editing">Continuar editando</button></div>`;discard.showModal();document.querySelector('#wp-screen-select').value=screen;return;}
  gifts.close();discard.close();
  if(['minha-lista','lista-vazia','dependente'].includes(target)){if(!isEditor())state.returnScreen=['meu-amigo','sugestoes','sem-sugestoes'].includes(screen)?'meu-amigo':screen==='antes'?'antes':'apos';beginEditor(target);}
  screen=target;history.replaceState(null,'',`#${screen}`);render();window.scrollTo({top:0,behavior:'instant'});
  if(['sugestoes','sem-sugestoes'].includes(screen)){gifts.innerHTML=giftDialog(screen==='sem-sugestoes');gifts.showModal();}
}
function save(event){
  event.preventDefault();let firstInvalid=null;
  for(const item of state.draft){
    let error='';const row=document.querySelector(`[data-item="${item.id}"]`),text=row.querySelector('textarea'),url=row.querySelector('input');
    if(!item.text.trim())error='Escreva sua sugestão ou remova este item antes de salvar.';
    else if(item.url.trim()){try{const parsed=new URL(item.url.trim());if(!['https:','http:'].includes(parsed.protocol)||!parsed.hostname.includes('.'))throw new Error();}catch{error='Informe um link válido começando com https:// ou deixe este campo vazio.';}}
    const message=row.querySelector('.wp-field-error');message.textContent=error;message.hidden=!error;
    text.setAttribute('aria-invalid',String(Boolean(error&&!item.text.trim())));url.setAttribute('aria-invalid',String(Boolean(error&&item.text.trim())));
    if(error&&!firstInvalid)firstInvalid=item.text.trim()?url:text;
  }
  if(firstInvalid){firstInvalid.focus();return;}
  state[state.person==='child'?'child':'own']=state.draft.map(({text,url})=>({text:text.trim(),url:url.trim()}));state.dirty=false;
  const target=state.returnScreen;navigate(target,false,true);toast('Sugestões salvas nesta prévia. Você pode editar quando quiser.');
}
document.addEventListener('input',event=>{
  const field=event.target.closest('[data-field]');if(!field)return;const item=state.draft.find(item=>item.id===field.closest('[data-item]').dataset.item);if(item){item[field.dataset.field]=field.value;state.dirty=true;}
});
document.addEventListener('click',event=>{
  const target=event.target.closest('button,a');if(!target)return;
  if(target.dataset.screen){event.preventDefault();navigate(target.dataset.screen);return;}
  if(target.hasAttribute('data-demo-link')){event.preventDefault();toast('Link ilustrativo. Na aplicação, abrirá a referência em uma nova aba.');return;}
  if(target.dataset.person){const next=target.dataset.person==='child'?'dependente':'minha-lista';if(state.person!==target.dataset.person)navigate(next);return;}
  if(target.dataset.remove){const index=state.draft.findIndex(item=>item.id===target.dataset.remove);state.draft.splice(index,1);state.dirty=true;document.querySelector('.wp-items').innerHTML=state.draft.map(editItem).join('');toast('Sugestão removida do rascunho. Salve para confirmar.');return;}
  switch(target.dataset.action){
    case 'edit-own':navigate('minha-lista');break;
    case 'add-item':{const item={id:itemId(),text:'',url:''};state.draft.push(item);state.dirty=true;document.querySelector('.wp-items').insertAdjacentHTML('beforeend',editItem(item,state.draft.length-1));document.querySelector(`#text-${item.id}`).focus();break;}
    case 'open-suggestions':gifts.innerHTML=giftDialog(screen==='sem-sugestoes');gifts.showModal();break;
    case 'close-gifts':gifts.close();break;
    case 'discard-changes':state.dirty=false;navigate(pendingScreen,false,true);break;
    case 'keep-editing':discard.close();break;
    case 'next':case 'previous':{const index=screens.findIndex(([key])=>key===screen);navigate(screens[(index+(target.dataset.action==='next'?1:screens.length-1))%screens.length][0],true);break;}
    case 'refresh':toast('Lista demonstrativa atualizada.');break;
    case 'demo-info':toast('Prévia das sugestões de presentes. Use a barra inferior para explorar os layouts.');break;
  }
});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&gifts.open)gifts.close();});
window.addEventListener('hashchange',()=>navigate(location.hash.slice(1)));
if(isEditor())beginEditor(screen);
render();
if(['sugestoes','sem-sugestoes'].includes(screen)){gifts.innerHTML=giftDialog(screen==='sem-sugestoes');gifts.showModal();}
