const escape = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const appUrl=()=>new URL(process.env.APP_URL || 'https://amigosecreto.sanida.me').origin;
const fullName=user=>user?.name || [user?.firstName,user?.lastName].filter(Boolean).join(' ');
const button=(text,href)=>`<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:25px 0"><a href="${escape(href)}" style="display:inline-block;background:#203D35;color:#fff;padding:16px 28px;border-radius:10px;text-decoration:none;font-size:16px;font-weight:bold">${escape(text)} &rarr;</a></td></tr></table>`;
const heading=text=>`<h1 style="font-family:Georgia,serif;font-size:35px;line-height:1.18;font-weight:normal;color:#203D35;margin:0 0 22px">${text}</h1>`;
const copy=text=>`<p style="font-size:16px;line-height:1.7;color:#637365;margin:0 0 20px">${text}</p>`;
const eyebrow=text=>`<p style="font-size:11px;font-weight:bold;letter-spacing:2px;color:#a16b51;margin:0 0 20px">${text}</p>`;
function details(group) {
 const date=group?.date?new Intl.DateTimeFormat('pt-BR',{day:'numeric',month:'long',timeZone:'UTC'}).format(new Date(String(group.date).slice(0,10)+'T12:00:00Z')):'A combinar';
 const budget=Number(group?.budget||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
 return `<div style="background:#F2F5EB;border:1px solid #E5EADB;border-radius:14px;padding:24px;margin:24px 0;text-align:left"><p style="font-size:12px;letter-spacing:1px;color:#7e8b73;margin:0 0 8px">NOSSO ENCONTRO</p><h2 style="font-family:Georgia,serif;font-weight:normal;font-size:26px;margin:0 0 16px;color:#203D35">${escape(group?.name)}</h2><p style="font-size:14px;line-height:1.8;color:#60705d;margin:0">${escape(date)} &nbsp; &middot; &nbsp; ${escape(budget)}<br>${escape(group?.location||'Local a combinar')}</p></div>`;
}
export function notificationContent({kind,user,group,code,token,challengeId,inviteToken,match,dependent,trackingToken}) {
 const origin=appUrl();let subject,body,text,link;
 const first=user?.firstName||fullName(user).split(' ')[0]||'Olá';
 if(kind==='verify') {
  subject='Seu código de acesso · Amigo Secreto';link=`${origin}/#verify-link?token=${encodeURIComponent(token)}${inviteToken?'&invitation='+encodeURIComponent(inviteToken):''}`;
  body=eyebrow('QUE BOM TER VOCÊ POR AQUI')+heading('Uma boa surpresa<br>começa com você.')+copy(`Oi, ${escape(first)}! Confirme seu e-mail para entrar e reunir sua turma. Você pode usar o código abaixo ou o botão de confirmação.`)+`<div style="background:#FAF8F2;border:1px solid #E8E7DF;border-radius:12px;padding:22px 8px;margin:24px 0;font-size:38px;letter-spacing:9px;font-weight:bold;color:#203D35">${escape(code)}</div><p style="font-size:13px;color:#7c857b">Este código e o link são válidos por 10 minutos.</p>`+button('Validar minha conta',link)+copy('Não solicitou este acesso? Basta ignorar esta mensagem.');
  text=`Amigo Secreto\nOlá, ${first}! Seu código de acesso é ${code}. Válido por 10 minutos.\nOu confirme pelo link: ${link}\nSe você não solicitou, ignore esta mensagem.`;
 } else if(kind==='password-reset') {
  subject='Recupere sua senha · Amigo Secreto';
  link=`${origin}/#verify?purpose=recover&challengeId=${encodeURIComponent(challengeId)}&email=${encodeURIComponent(user.email)}${inviteToken?'&invitation='+encodeURIComponent(inviteToken):''}`;
  body=eyebrow('SEU ACESSO, DE VOLTA COM VOCÊ')+heading('Vamos renovar<br>sua senha?')+copy(`Oi, ${escape(first)}! Use o código abaixo na aplicação para definir e confirmar sua nova senha.`)+`<div style="background:#FAF8F2;border:1px solid #E8E7DF;border-radius:12px;padding:22px 8px;margin:24px 0;font-size:38px;letter-spacing:9px;font-weight:bold;color:#203D35">${escape(code)}</div><p style="font-size:13px;color:#7c857b">Este código é válido por 10 minutos e só pode ser usado uma vez.</p>`+button('Informar meu código',link)+copy('Não pediu uma nova senha? Basta ignorar esta mensagem. Sua senha permanece a mesma.');
  text=`Amigo Secreto\nOlá, ${first}! Seu código para recuperar a senha é ${code}. Válido por 10 minutos.\nInforme na aplicação: ${link}\nSe você não solicitou, ignore esta mensagem. Sua senha permanece a mesma.`;
 } else if(kind==='invite') {
  const organizer=group?.organizerName||'Uma pessoa querida';
  subject=`${organizer} convidou você para ${group?.name}`;link=`${origin}/#invitation?token=${encodeURIComponent(inviteToken)}`;
  body=eyebrow('TEM UM LUGAR GUARDADO PARA VOCÊ')+heading(`${escape(organizer)} te chamou<br>para uma boa surpresa.`)+copy('Um encontro, um presente escolhido com carinho e a alegria de estar perto. Sua turma está esperando por você.')+details(group)+button('Quero participar',link)+copy('Ao abrir o convite, entre ou crie sua conta com este mesmo e-mail. Sua participação só é confirmada quando você aceitar.');
  text=`Amigo Secreto\n${organizer} convidou você para ${group?.name}.\nAceite com este mesmo e-mail: ${link}\nSua participação depende do aceite antes do sorteio.`;
 } else if(kind==='result') {
  const dependentName=fullName(dependent);
  const recipientNote=match?.isDependent&&match?.responsibleName?`Dependente de ${match.responsibleName}.`:'';
  subject=dependent?`O amigo secreto de ${dependentName} em ${group?.name}`:`Está sorteado! Seu amigo secreto em ${group?.name}`;
  link=`${origin}/#reveal?id=${encodeURIComponent(group?.id)}`;
  const introduction=dependent
   ? `Oi, ${escape(first)}! O sorteio de <strong>${escape(group?.name)}</strong> aconteceu. Este é o resultado de <strong>${escape(dependentName)}</strong>, dependente sob sua responsabilidade.`
   : `Oi, ${escape(first)}! O sorteio de <strong>${escape(group?.name)}</strong> aconteceu. Agora é hora de preparar um presente especial.`;
  body=eyebrow('O SEGREDO ESTÁ ENTRE NÓS')+heading(dependent?'Uma surpresa<br>para cuidar juntos.':'Cada surpresa<br>encontrou seu destino.')+copy(introduction)+`<div style="background:#F2F5EB;border:1px solid #e3e9d9;border-radius:16px;padding:28px 20px;margin:24px 0"><p style="font-size:11px;letter-spacing:2px;color:#7c896d;margin:0 0 16px">${dependent?`${escape(dependentName)} TIROU`:'SEU AMIGO SECRETO É'}</p><h2 style="font-family:Georgia,serif;font-size:32px;font-weight:normal;color:#203D35;margin:0 0 12px">${escape(fullName(match))}</h2><p style="color:#7c857b;font-size:14px;margin:0">${escape(recipientNote||'Uma pessoa querida. Uma surpresa só sua.')}</p></div>`+details(group)+button(dependent?'Ver resultado do dependente':'Ver meu amigo secreto',link)+copy(dependent?'Este resultado é para você e seu dependente. Guarde a surpresa e não encaminhe esta mensagem.':'Guarde este segredo. Não encaminhe este e-mail nem compartilhe seu resultado com a turma.');
  text=`Amigo Secreto\nOlá, ${first}! Em ${group?.name}, ${dependent?`${dependentName} tirou`:'você tirou'} ${fullName(match)}.${recipientNote?' '+recipientNote:''}\n${dependent?'Você recebe este resultado como responsável pelo dependente.\n':''}Veja os detalhes: ${link}\nNão encaminhe esta mensagem. O resultado é pessoal.`;
 } else throw new Error('Tipo de notificação inválido.');
 const pixel=kind==='invite'&&trackingToken?`<img src="${origin}/api/track/open/${encodeURIComponent(trackingToken)}" alt="" width="1" height="1" style="display:block;border:0">`:'';
 const html=`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#FAF8F2;font-family:Arial,sans-serif"><div style="display:none;max-height:0;overflow:hidden">${escape(subject)}</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAF8F2"><tr><td align="center" style="padding:36px 16px"><table role="presentation" width="580" cellpadding="0" cellspacing="0" style="width:100%;max-width:580px;background:#fff;border:1px solid #E8E7DF;border-radius:20px;overflow:hidden"><tr><td align="center" style="padding:28px 24px;border-bottom:1px solid #f0efe8"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td><img src="${origin}/assets/mark.png?v=1" width="42" height="42" alt="" style="display:block;border:0;border-radius:12px"></td><td style="padding-left:10px;font-size:20px;line-height:1.05;font-weight:bold;letter-spacing:-1px;color:#203D35">amigo<br>secreto<span style="color:#EE775B">.</span></td></tr></table></td></tr><tr><td align="center" style="padding:36px 30px">${body}<p style="font-size:12px;line-height:1.6;word-break:break-word;color:#89917f;margin:18px 0 0">Se o botão não funcionar, copie e cole este endereço no navegador:<br><a style="color:#536d56" href="${escape(link)}">${escape(link)}</a></p></td></tr><tr><td align="center" style="padding:23px;background:#F2F5EB;color:#75816b;font-size:12px;line-height:1.8"><strong style="color:#203D35;font-weight:normal;font-family:Georgia,serif;font-size:18px">Gente querida. Boas surpresas.</strong><br>Amigo Secreto &middot; Feito para aproximar.</td></tr></table></td></tr></table>${pixel}</body></html>`;
 return {subject:subject.slice(0,200).replace(/[\r\n]/g,' '),text,html};
}
export async function sendNotification(payload) {
 const {subject,text,html}=notificationContent(payload);
 if(!process.env.NOTIFICATIONS_API_URL||!process.env.NOTIFICATIONS_API_KEY)throw new Error('Canal de e-mail não configurado.');
 const response=await fetch(`${process.env.NOTIFICATIONS_API_URL.replace(/\/$/,'')}/api/v1/emails`,{
  method:'POST',headers:{Authorization:`Bearer ${process.env.NOTIFICATIONS_API_KEY}`,'Content-Type':'application/json'},
  body:JSON.stringify({to:payload.to,subject,text,html,idempotencyKey:payload.idempotencyKey}),signal:AbortSignal.timeout(20000),
 });
 const result=await response.json().catch(()=>({}));
 if(!response.ok||!result.id||!['queued','processing','sent','delivered'].includes(result.status)) {
  const error=new Error('Não foi possível enviar o e-mail. Tente novamente.');
  error.code='EMAIL_SEND_FAILED';error.status=502;
  error.definitiveFailure=result.status==='failed';error.providerId=result.id||null;throw error;
 }
 return {id:result.id,status:result.status,emailMessageId:result.emailMessageId};
}

export async function getDeliveryReceipt(providerId) {
 if(!/^[a-f\d-]{36}$/i.test(String(providerId))) return null;
 if(!process.env.NOTIFICATIONS_API_URL||!process.env.NOTIFICATIONS_API_KEY) throw new Error('Canal de e-mail não configurado.');
 const response=await fetch(`${process.env.NOTIFICATIONS_API_URL.replace(/\/$/,'')}/api/v1/emails/${encodeURIComponent(providerId)}`,{
  headers:{Authorization:`Bearer ${process.env.NOTIFICATIONS_API_KEY}`,Accept:'application/json'},signal:AbortSignal.timeout(10000),
 });
 if(response.status===404) return null;
 if(!response.ok) throw new Error('Não foi possível consultar o envio.');
 const receipt=await response.json();
 if(receipt.id!==providerId||typeof receipt.status!=='string') throw new Error('Resposta de envio inválida.');
 return receipt;
}
