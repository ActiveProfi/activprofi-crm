(function(root){
const M=root.CRMModel||(typeof require==='function'?require('./model.js'):null);
const categories={sales:'Менеджер 1 категории',sales_intern:'Менеджер-стажёр'};
const fields={name:'Имя / ФИО',company:'Компания',phone:'Телефон',email:'Email',source:'Источник',amount:'Сумма сделки',stage:'Этап',next:'Следующее действие',notes:'Комментарий'};
const aliases={name:['имя','фио','контакт','контактное лицо','name','full name','клиент'],company:['компания','организация','company','название компании'],phone:['телефон','номер телефона','мобильный','phone','тел','phone number'],email:['email','e mail','почта','электронная почта'],source:['источник','канал','source'],amount:['сумма','сумма сделки','бюджет','amount'],stage:['этап','статус','stage','status'],next:['следующее действие','следующий шаг','next'],notes:['комментарий','комментарии','примечание','результат звонка','notes','comment']};
const norm=v=>String(v??'').trim().toLowerCase().replace(/[._-]/g,' ').replace(/\s+/g,' ');
fields.contactBundle='Сайты и мессенджеры';
aliases.contactBundle=['сайты и соцсети','мессенджеры компании','мессенджеры','сайты и социальные сети'];
aliases.phone.push('телефоны','телефоны компании (все)','телефон компании');
aliases.email.push('эл почта (email) компании','эл почта','email компании');
const splitContacts=v=>String(v||'').split(/[\n;,]+/).map(v=>v.trim()).filter(Boolean);
const phone=v=>{let n=String(v??'').replace(/\D/g,'');return n.length===11&&n[0]==='8'?'7'+n.slice(1):n};
const category=u=>(!u.permissionsUntil||u.permissionsUntil>=new Date().toISOString().slice(0,10))&&u.assignmentCategory?u.assignmentCategory:u.role;
const isSales=u=>!!categories[category(u)],canImport=(u,s={})=>M.has(s,u,'leads.manage')&&!M.onProbation(u);
const socialFields={socials:'Соцсети — ссылки на профили',telegram:'Telegram',vk:'ВКонтакте',instagram:'Instagram',whatsapp:'WhatsApp',ok:'Одноклассники'};
Object.assign(fields,socialFields);Object.assign(aliases,{socials:['соцсети','социальные сети','соц сети','профиль','ссылка на профиль','ссылка','social','socials','social media','контакты'],telegram:['telegram','телеграм','телеграмм','tg','тг'],vk:['vk','вк','вконтакте','vkontakte'],instagram:['instagram','инстаграм','инстаграмм','inst'],whatsapp:['whatsapp','ватсап','ватсапп','вотсап'],ok:['ok','одноклассники','ок']});
function socialLinks(data){
 const result=[];for(const key of Object.keys(socialFields)){for(let raw of String(data[key]||'').split(/[\n;,]+/).map(x=>x.trim()).filter(Boolean)){
  let value=raw;
  if(!/^https?:\/\//i.test(value)){
   if(/^[\w.-]+\.[a-z]{2,}\//i.test(value))value='https://'+value;
   else {const handle=value.replace(/^@/,'');if(key==='whatsapp'&&/^\+?[\d\s()-]+$/.test(value))value='https://wa.me/'+phone(value);else if(['telegram','vk','instagram','ok'].includes(key)&&/^[\w.]+$/.test(handle))value='https://'+({telegram:'t.me/',vk:'vk.com/',instagram:'instagram.com/',ok:'ok.ru/profile/'}[key])+handle;else throw Error('Укажите полную ссылку на профиль: '+raw)}
  }
  let url;try{url=new URL(value)}catch{throw Error('Некорректная ссылка: '+raw)}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||!url.hostname.includes('.')||!url.pathname.replace(/\//g,''))throw Error('Нужна ссылка на конкретный профиль: '+raw);
  let host=url.hostname.toLowerCase().replace(/^www\./,'').replace(/^m\.(vk\.com|ok\.ru)$/,'$1');if(host==='telegram.me')host='t.me';if(host==='vk.ru')host='vk.com';
  let path=url.pathname.replace(/\/+$/,'');if(['t.me','vk.com','instagram.com','wa.me','ok.ru'].includes(host)){path=path.toLowerCase();url.search='';url.hash=''}
  url.hostname=host;url.protocol='https:';url.pathname=path;
  const link=url.href.replace(/\/$/,'');if(!result.includes(link))result.push(link);
 }}return result;
}
function upgrade(s){s.leadBatches??=[];if(!s.leadsVersion){s.users.push({id:'rop',name:'Ирина',role:'rop',active:true},{id:'intern',name:'Никита',role:'sales_intern',active:true});s.leadsVersion=1}migrateCold(s);
 if(!s.manualFunnelVersion){
  for(const c of s.clients){const b=s.leadBatches.find(b=>b.id===c.batchId),last=c.stageHistory?.at(-1);if(b?.group&&!c.inLeadBase&&!c.processedAt&&['Ждут КП','Ждут звонка','Прислать КП','Перезвонить'].includes(M.stage(s,c)?.name)&&(last?.reason?.startsWith('Распределение по комментариям:')||c.stageHistory?.length===1)){c.inLeadBase=true;c.stageId='';c.stage='';c.stageHistory.push({at:M.today(),stageId:'',reason:'Возврат в базу: воронка только после отработки'});b.baseOnly=true}}
  s.manualFunnelVersion=1;
 }
 for(const c of s.clients){if(!String(c.sourceComment||'').trim()){const text=deriveSourceComment(c);if(text)c.sourceComment=text}}
 for(const pipeline of s.pipelines||[])ensureProposalStage(pipeline);
 return s}
// Этап «Отправлено КП» стоит перед успешной сделкой. Уже лежащие карточки не переносятся.
function ensureProposalStage(pipeline){
 if(!pipeline?.stages?.length)return false;
 if(pipeline.stages.some(stage=>stage.systemKey==='proposal_sent'||norm(stage.name)==='отправлено кп'))return false;
 let id='kp-'+pipeline.id;
 if(pipeline.stages.some(stage=>stage.id===id))id='kp-sent-'+pipeline.id;
 const stage={id,name:'Отправлено КП',kind:'open',systemKey:'proposal_sent'};
 const won=pipeline.stages.findIndex(item=>item.kind==='won');
 const lost=pipeline.stages.findIndex(item=>item.kind==='lost');
 pipeline.stages.splice(won>=0?won:(lost>=0?lost:pipeline.stages.length),0,stage);
 return true;
}
function findStage(pipeline,token){
 const text=norm(token);
 if(!text)return null;
 return pipeline.stages.find(stage=>stage.id===token||stage.systemKey===token||norm(stage.name)===text)||null;
}
function acceptIntegrationDeals(state,records,opts){
 const pipeline=state.pipelines.find(item=>item.id===opts.pipelineId);
 if(!pipeline)throw Error('Воронка не найдена');
 const headers=['name','company','phone','email','vk','telegram','source','notes'];
 const map=['name','company','phone','email','vk','telegram','source','notes'];
 const rows=[],accepted=[];
 for(const record of records){
  if(record.kpLink&&!/^https?:\/\/\S+$/i.test(record.kpLink))throw Error('Ссылка на КП должна начинаться с http:// или https://');
  const token=record.stageId||record.stage||record.stageName||opts.stageId||opts.stage||opts.stageName||'';
  const stage=findStage(pipeline,token);
  if(!stage)throw Error('Этап не найден: '+(token||'не указан'));
  rows.push([record.name||'',record.company||record.description||'',record.phone||'',record.email||'',record.vk||'',record.telegram||'',record.source||opts.source||'Интеграция',record.comment||'']);
  accepted.push({record,stage});
 }
 const previewRows=preview(state,headers,rows,map,{name:opts.name||'Интеграция',pipelineId:pipeline.id,stageId:accepted[0].stage.id,destination:'funnel',kind:'called',source:opts.source||'Интеграция',headerRow:0});
 const deals=[];
 previewRows.forEach((row,index)=>{
  const {record,stage}=accepted[index];
  if(row.status!=='ready'){
   const links=String(row.data.socials||'').split('\n').filter(Boolean);
   const existing=state.clients.find(client=>(row.data.phone&&phone(client.phone)===phone(row.data.phone))||(row.data.email&&norm(client.email)===norm(row.data.email))||(links.length&&(()=>{try{return socialLinks(client).some(link=>links.includes(link))}catch{return false}})()));
   deals.push({id:existing?.id||'',name:record.name||row.data.name||'',status:row.status,reason:row.reason||''});
   return;
  }
  const comment=String(record.comment||'').trim();
  const client={...row.data,id:M.uid(),pipelineId:pipeline.id,stageId:stage.id,stage:stage.name,inLeadBase:false,ownerId:'',batchId:'',project:'',createdAt:M.today(),dealDate:record.date||record.dealDate||M.today(),description:record.description||'',company:row.data.company||record.description||'',clientTask:record.clientTask||'',kpVariants:record.kpVariants||'',kpLink:record.kpLink||'',callAt:record.callAt||'',statusNote:record.statusNote||'',when:record.callAt||'',next:record.statusNote||'Связаться с клиентом',source:record.source||opts.source||'Интеграция',sourceComment:comment,notes:comment?[comment,...(row.data.notes||[]).filter(note=>note!==comment)]:(row.data.notes||[]),stageHistory:[{at:M.today(),stageId:stage.id,reason:'Создано по API'}]};
  state.clients.push(client);
  deals.push({id:client.id,name:client.name,status:'created'});
 });
 return deals;
}
function migrateCold(s){
 if(s.coldStageVersion===2)return;
 const pending=s.clients.filter(c=>{const batch=s.leadBatches.find(b=>b.id===c.batchId),t=M.stage(s,c);return c.batchId&&(c.baseKind==='cold'||batch?.kind==='cold')&&t?.kind==='open'&&(c.stageHistory||[]).length<=1&&['новый','база клиентов','холод'].includes(norm(t.name))});
 for(const c of pending){const t=ensureColdStage(s,c.pipelineId);if(c.stageId!==t.id){c.stageHistory??=[];c.stageHistory.push({at:M.today(),stageId:t.id,reason:'Перенос импортированной холодной базы'})}c.stageId=t.id;c.stage=t.name}
 for(const p of s.pipelines){const t=p.stages.find(t=>t.systemKey==='cold');if(t){t.name='ХОЛОД';for(const c of s.clients.filter(c=>c.stageId===t.id))c.stage=t.name}}
 s.coldStageVersion=2;
}
function isCommentHeader(header){
 const title=norm(header).replace(/ё/g,'е');
 if(!title||/аудио|запись|пост|публикаци/.test(title))return false;
 // \w не включает кириллицу, поэтому русские заголовки ищем по основе слова.
 return /коммент|примеч|заметк|результат\s+звон|итог\s+(?:звон|обзвон|разговор)|(?:^|[^a-z])(?:notes?|comments?|remarks?)(?:$|[^a-z])/.test(title);
}
function sourceCommentFrom(headers,row,map){
 const parts=[];(row||[]).forEach((v,i)=>{const text=String(v??'').trim();if(!text)return;if((map&&map[i]==='notes')||isCommentHeader(headers?.[i]))parts.push(text)});
 return [...new Set(parts)].join('\n');
}
// Текст ячейки Excel: формула, rich text и подпись ссылки не должны превращаться в пустую строку.
function excelValue(value){
 if(value==null)return '';
 if(value instanceof Date)return value.toISOString().slice(0,10);
 if(typeof value!=='object')return String(value);
 if(Array.isArray(value.richText))return value.richText.map(part=>part?.text||'').join('');
 if(value.text&&typeof value.text==='object')return excelValue(value.text);
 if(value.result!=null&&typeof value.result!=='object')return String(value.result);
 if(value.result&&typeof value.result==='object')return excelValue(value.result);
 if(typeof value.text==='string')return value.text;
 if(value.hyperlink)return String(value.hyperlink);
 return '';
}
function excelNote(note){
 if(!note)return '';
 if(typeof note==='string')return note.trim();
 if(Array.isArray(note.texts))return note.texts.map(part=>part?.text||'').join('').trim();
 if(typeof note.text==='string')return note.text.trim();
 return '';
}
function sheetBounds(sheet){
 let rows=Math.max(sheet?.rowCount||0,sheet?.actualRowCount||0),cols=Math.max(sheet?.columnCount||0,sheet?.actualColumnCount||0);
 if(typeof sheet?.eachRow==='function')sheet.eachRow({includeEmpty:true},row=>{rows=Math.max(rows,row.number||0);cols=Math.max(cols,row.cellCount||0,row.actualCellCount||0);if(typeof row.eachCell==='function')row.eachCell({includeEmpty:false},cell=>{cols=Math.max(cols,cell.col||0)})});
 return {rows,cols};
}
function withCellNotes(headers,dataRows,notes){
 if(!notes?.some(v=>String(v||'').trim()))return {headers,rows:dataRows};
 return {headers:[...headers,'Комментарий ячейки'],rows:dataRows.map((row,i)=>[...row,String(notes[i]||'').trim()])};
}
function nowStamp(){
 const parts=new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Vladivostok',hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}).formatToParts(new Date());
 const g=type=>parts.find(part=>part.type===type).value;
 let hour=g('hour');if(hour==='24')hour='00';
 return `${g('year')}-${g('month')}-${g('day')}T${hour}:${g('minute')}:${g('second')}+10:00`;
}
function deriveSourceComment(c){
 if(String(c?.sourceComment||'').trim())return String(c.sourceComment).trim();
 const lines=(c?.notes||[]).map(n=>String(n||'').trim()).filter(Boolean);
 const labeled=lines.map(line=>{const m=line.match(/^([^:]{1,80}):\s*([\s\S]+)$/);return m&&isCommentHeader(m[1])?m[2].trim():''}).filter(Boolean);
 if(labeled.length)return [...new Set(labeled)].join('\n');
 if(c?.batchId&&lines.length){const first=lines[0];if(!/^[^:]{1,80}:\s/.test(first))return first}
 return '';
}
function attachSourceComment(c){
 const text=deriveSourceComment(c);if(!text)return;
 c.sourceComment=text;c.notes??=[];
 const blob=c.notes.join('\n'),parts=text.split('\n').map(x=>x.trim()).filter(Boolean);
 if(blob.includes(text)||parts.every(part=>blob.includes(part)))return;
 c.notes.unshift('Комментарий из базы: '+text);
}
function batchProgress(s,batchId){
 const clients=s.clients.filter(c=>c.batchId===batchId),sent=clients.filter(c=>!c.inLeadBase).length;
 return {total:clients.length,sent,left:clients.length-sent};
}
function canTouchBatch(s,u,b){
 if(!b||b.groupedInto)return false;
 if(canImport(u,s))return true;
 if(!M.has(s,u,'clients.edit'))return false;
 return s.clients.some(c=>c.batchId===b.id&&M.canClient(s,u,c));
}
function mapping(headers,rows){
 let used=new Set();return headers.map((h,i)=>{
  const title=norm(h),samples=(rows||[]).map(r=>String(r[i]??'').trim()).filter(Boolean).slice(0,30);
  if(/запись|пост|публикаци|post|publication/.test(title))return '';
  let k=Object.keys(aliases).find(k=>(['socials','contactBundle'].includes(k)||!used.has(k))&&(aliases[k].includes(title)||Object.keys(socialFields).includes(k)&&aliases[k].some(a=>title===a+' профиль'||title===a+' ссылка')));
  const isProfile=v=>{try{const links=socialLinks({socials:v});return links.length>0&&!links.some(x=>/\/(wall|video|photo|topic|reel|stories|p\/)/i.test(new URL(x).pathname))}catch{return false}};
  // "Профиль" can mean a campaign/search profile, not a person's URL.
  if(k==='socials'&&samples.length&&!samples.some(isProfile))k='';
  if(!k&&samples.length&&samples.every(isProfile)&&!/источник|source/.test(title))k='socials';
  if(!k&&isCommentHeader(h)&&!used.has('notes'))k='notes';
  if(k)used.add(k);return k||'';
 });
}
function preview(s,headers,rows,map,opts){
 if(!opts.name?.trim())throw Error('Укажите название базы');
 const cold=(opts.kind||'cold')==='cold',p=s.pipelines.find(p=>p.id===opts.pipelineId);if(!p)throw Error('Выберите воронку');
 const fallback=cold?(p.stages.find(t=>t.systemKey==='cold'||norm(t.name)==='холод')||{id:'cold-'+p.id,name:'ХОЛОД',kind:'open'}):p.stages.find(t=>t.id===opts.stageId);if(!fallback)throw Error('Выберите этап');
 const chosen=map.filter(k=>k&&!['socials','contactBundle'].includes(k));if(new Set(chosen).size!==chosen.length)throw Error('Одно поле карточки нельзя назначить двум колонкам');
 if(!map.some(k=>['phone','email','contactBundle',...Object.keys(socialFields)].includes(k)))throw Error('Сопоставьте телефон, email или профиль соцсети');
 const phones=new Set(s.clients.flatMap(c=>[c.phone,...(c.phones||[])].map(phone)).filter(Boolean)),emails=new Set(s.clients.flatMap(c=>[c.email,...(c.emails||[])].map(norm)).filter(Boolean));
 const profiles=new Set(s.clients.flatMap(c=>{try{return socialLinks(c)}catch{return []}}));
 return rows.filter(r=>r.some(v=>String(v??'').trim())).map((row,i)=>{
  let data={},extra=[];row.forEach((v,j)=>{v=String(v??'').trim();if(map[j])data[map[j]]=['socials','contactBundle'].includes(map[j])&&data[map[j]]?data[map[j]]+'\n'+v:v;else if(v)extra.push((headers[j]||'Колонка '+(j+1))+': '+v)});
  let errors=[];
  data.phones=[...new Set(splitContacts(data.phone).map(v=>v.replace(/^tel:\/*/i,'')))];
  data.emails=[...new Set(splitContacts(data.email).map(v=>v.replace(/^mailto:/i,'').toLowerCase()))];
  data.phone=data.phones[0]||'';data.email=data.emails[0]||'';const pn=phone(data.phone);
  if(data.phones.length>1)extra.push('Все телефоны: '+data.phones.join('; '));
  if(data.emails.length>1)extra.push('Все email: '+data.emails.join('; '));
  if(data.contactBundle){
   extra.push('Сайты и мессенджеры (исходные данные): '+data.contactBundle);
   for(const value of splitContacts(data.contactBundle)){
    if(!/^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me|vk\.com|vk\.ru|ok\.ru|wa\.me|instagram\.com)\//i.test(value))continue;
    try{const found=socialLinks({socials:value});data.socials=[data.socials,...found].filter(Boolean).join('\n')}catch{extra.push('Проверьте контакт: '+value)}
   }
   delete data.contactBundle;
  }
  let links=[];try{links=socialLinks(data)}catch(e){errors.push(e.message)};data.socials=links.join('\n');for(const k of Object.keys(socialFields))if(k!=='socials')delete data[k];
  if(!pn&&!data.email&&!links.length)errors.push('Нет телефона, email или профиля соцсети');
  if(data.phones.some(v=>phone(v).length<10||phone(v).length>15||/[a-zа-я]/i.test(v)))errors.push('Некорректный телефон');
  if(data.emails.some(v=>! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)))errors.push('Некорректный email');
  const amount=String(data.amount||'0').replace(/[\s₽]/g,'').replace(',','.');if(!Number.isFinite(+amount)||+amount<0)errors.push('Некорректная сумма');
  let stage=cold?fallback:data.stage?p.stages.find(t=>norm(t.name)===norm(data.stage)||t.id===data.stage):fallback;
  let warning=opts.destination==='base'?'Сохранится в базе лидов, вне воронки':cold?'Холодная база → первый этап «ХОЛОД»':'';if(cold&&data.stage)extra.push('Статус в исходной базе: '+data.stage);
  if(!stage&&['new','new lead','новый','новый лид'].includes(norm(data.stage))){stage=fallback;warning='Статус «'+data.stage+'» → выбранный этап «'+fallback.name+'»';extra.push('Статус в исходной базе: '+data.stage)}
  if(!stage)errors.push('Этап не найден: '+data.stage+'. Выберите для этой колонки «Сохранить в заметках» или исправьте этап');
  const duplicate=data.phones.some(v=>phones.has(phone(v)))||data.emails.some(v=>emails.has(norm(v)))||links.some(x=>profiles.has(x));
  const status=errors.length?'error':duplicate?'duplicate':'ready';if(status==='ready'){data.phones.forEach(v=>phones.add(phone(v)));data.emails.forEach(v=>emails.add(norm(v)));links.forEach(x=>profiles.add(x))}
  const sourceComment=sourceCommentFrom(headers,row,map);
  return {row:i+(opts.headerRow||1)+1,status,warning,reason:errors.join('; ')||(duplicate?'Контакт уже в CRM / выше в файле (телефон, email или профиль)':''),data:{...data,name:data.name||data.company||data.phone||data.email||links[0],company:data.company||'',amount:+amount||0,source:data.source||opts.source||opts.name,stageId:stage?.id,notes:[data.notes,...extra].filter(Boolean),sourceComment}};
 });
}
function manualStage(s,pipelineId){const p=s.pipelines.find(p=>p.id===pipelineId);if(!p)throw Error('Воронка не найдена');let t=p.stages.find(t=>norm(t.name)==='новый'&&t.kind==='open'&&t.systemKey!=='cold');if(!t){t={id:M.uid(),name:'Новый',kind:'open'};p.stages.splice(p.stages[0]?.systemKey==='cold'?1:0,0,t)}return t}
function ensureColdStage(s,pipelineId){const p=s.pipelines.find(p=>p.id===pipelineId);if(!p)throw Error('Воронка не найдена');let stage=p.stages.find(t=>t.systemKey==='cold'||norm(t.name)==='холод');if(!stage)stage={id:'cold-'+p.id,name:'ХОЛОД',kind:'open'};stage.systemKey='cold';stage.name='ХОЛОД';stage.kind='open';p.stages=[stage,...p.stages.filter(t=>t.id!==stage.id)];return stage}
function commit(s,u,headers,rows,map,opts){if(!canImport(u,s))throw Error('Импорт доступен админу и РОП');const result=preview(s,headers,rows,map,opts),ready=result.filter(r=>r.status==='ready');if(!ready.length)throw Error('Нет новых корректных лидов');if(opts.destination!=='base'&&(opts.kind||'cold')==='cold'){const cold=ensureColdStage(s,opts.pipelineId);ready.forEach(r=>r.data.stageId=cold.id)}const id=M.uid(),at=M.today();const batch={id,name:opts.name.trim(),pipelineId:opts.pipelineId,ingress:opts.ingress||'file',kind:opts.kind||'cold',source:opts.source||opts.name,file:opts.file||'',at,createdBy:u.id,skipped:result.length-ready.length};
 const clients=ready.map(r=>({...r.data,id:M.uid(),batchId:id,baseKind:batch.kind,ownerId:'',pipelineId:opts.pipelineId,stage:s.pipelines.find(p=>p.id===opts.pipelineId).stages.find(t=>t.id===r.data.stageId)?.name||'',stageHistory:[{at,stageId:r.data.stageId}],createdAt:at,project:'',when:'',next:r.data.next||(batch.kind==='called'?'Повторный контакт':(r.data.phone||r.data.email?'Первый звонок / письмо':'Написать в соцсети'))}));if(opts.destination==='base'){batch.baseOnly=true;for(const c of clients){c.inLeadBase=true;c.stageId='';c.stage='';c.stageHistory=[]}}s.clients.push(...clients);s.leadBatches.push(batch);return batch;
}
function distribution(s,u,batchId,category){if(!canImport(u,s))throw Error('Распределение доступно админу и РОП');if(!categories[category])throw Error('Выберите категорию');if(!s.leadBatches.some(b=>b.id===batchId))throw Error('База не найдена');const managers=s.users.filter(x=>((!x.permissionsUntil||x.permissionsUntil>=M.today())&&x.assignmentCategory?x.assignmentCategory:x.role)===category&&x.active!==false).map(x=>({id:x.id,name:x.name,before:s.clients.filter(c=>c.ownerId===x.id&&M.stage(s,c)?.kind==='open').length,added:0})).sort((a,b)=>a.id.localeCompare(b.id));if(!managers.length)throw Error('В категории нет активных менеджеров');
 const assignments=[];for(const c of s.clients.filter(c=>c.batchId===batchId&&!c.ownerId&&(M.stage(s,c)?.kind==='open'||c.inLeadBase))){const m=[...managers].sort((a,b)=>(a.before+a.added)-(b.before+b.added)||a.id.localeCompare(b.id))[0];m.added++;assignments.push({clientId:c.id,ownerId:m.id})}return {managers:managers.map(m=>({...m,after:m.before+m.added})),assignments};
}
function distribute(s,u,batchId,category){const plan=distribution(s,u,batchId,category);if(!plan.assignments.length)throw Error('Нет нераспределённых активных лидов');plan.assignments.forEach(a=>{const c=s.clients.find(c=>c.id===a.clientId);c.ownerId=a.ownerId;c.assignedAt=M.today()});s.leadBatches.find(b=>b.id===batchId).lastDistribution={at:M.today(),by:u.id,category,count:plan.assignments.length};return plan}
// Shared intake for a future authenticated integration adapter; no external connection here.
function ingestIntegration(s,u,records,opts){const headers=[...new Set(records.flatMap(r=>Object.keys(r)))];return commit(s,u,headers,records.map(r=>headers.map(h=>r[h]??'')),headers.map(h=>fields[h]?h:''),{...opts,ingress:'integration'})}
const commentGroups={irrelevant:'Не актуально',refused:'Отказ',has_crm:'Уже есть решение',proposal:'Прислать КП',callback:'Перезвонить',review:'Требуют проверки'};
function classifyComment(value){
 const t=norm(value).replace(/ё/g,'е');if(!t)return 'review';
 // Negated actions and conflicting outcomes need a human decision.
 if(/не\s+(?:надо|нужно|нужен|нужна|жд[еу]т|хоч[еу]т|присыла|отправля|звон|перезван|перезвон)|не\s+отказ/.test(t))return 'review';
 const hits=[];
 if(/не\s*актуаль|не\s*интерес|не\s*нужда/.test(t))hits.push('irrelevant');
 if(/отказ|отклонил/.test(t))hits.push('refused');
 if(/(?:уже\s+)?(?:есть|имеется|стоит|установлена|внедрен[ао]?|использу[ею]т|работа[ею]т\s+в)\s+(?:своя\s+)?(?:crm|срм|црм|битрикс|амо)|(?:crm|срм|црм)\s+(?:уже\s+)?(?:есть|внедрена|установлена)/.test(t)&&! /нет\s+(?:crm|срм|црм)/.test(t))hits.push('has_crm');
 if(/(?:^|\s)кп\s+(?:на|в|для)\s|(?:жд|ждем|ожида|прос|присла|отправ|высл|направ).{0,45}(?:\bкп\b|кп(?:\s|$|[.,!])|коммерческ.{0,15}предлож)|(?:кп|коммерческ.{0,15}предлож).{0,25}(?:жд|ожида)/.test(t))hits.push('proposal');
 if(/перезвон|перезван|(?:жд|ожида|назнач|договор).{0,35}(?:звон|созвон)|(?:позвон|созвон).{0,25}(?:завтра|позже|после|в\s+\d)/.test(t))hits.push('callback');
 if(/(?:уже\s+)?есть\s+(?:свое\s+)?решение|все\s+автоматизировано/.test(t)&&!hits.includes('has_crm'))hits.push('has_crm');
 if(hits.includes('has_crm')&&hits.every(k=>['has_crm','irrelevant'].includes(k)))return 'has_crm';
 if(hits.includes('refused')&&hits.every(k=>['refused','irrelevant'].includes(k)))return 'refused';
 return hits.length===1?hits[0]:'review';
}
function importComment(headers,row,map){return sourceCommentFrom(headers,row,map)}
function groupedCommit(s,u,headers,rows,map,opts,choices){
 if(!canImport(u,s))throw Error('Нет доступа к импорту');
 const checked=preview(s,headers,rows,map,opts),ready=checked.filter(r=>r.status==='ready');
 if(!ready.length)throw Error('Нет новых корректных лидов');
 if(ready.some(r=>!Object.hasOwn(commentGroups,choices[r.row])))throw Error('Проверьте группы всех новых лидов');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(opts.fileDate||''))throw Error('Укажите дату файла');
 const copy=JSON.parse(JSON.stringify(s)),pipe=copy.pipelines.find(p=>p.id===opts.pipelineId);
 // Reuse validation/deduplication, then route before publishing any changes.
 const batch=commit(copy,u,headers,rows,map,{...opts,destination:'base'}),clients=copy.clients.filter(c=>c.batchId===batch.id),groups=[];
 for(const key of Object.keys(commentGroups)){
  const members=clients.filter((c,i)=>choices[ready[i].row]===key);if(!members.length)continue;
  const active=false;let stage;
  if(active){stage=pipe.stages.find(t=>[commentGroups[key],key==='proposal'?'Ждут КП':'Ждут звонка'].includes(t.name)&&t.kind==='open');if(!stage){stage={id:M.uid(),name:key==='proposal'?'Ждут КП':'Ждут звонка',kind:'open'};const terminal=pipe.stages.findIndex(t=>t.kind!=='open');pipe.stages.splice(terminal<0?pipe.stages.length:terminal,0,stage)}}
  const group={...batch,id:M.uid(),importId:batch.id,group:key,fileDate:opts.fileDate,baseName:opts.name,name:opts.name+' · '+opts.fileDate+' · '+commentGroups[key],kind:'called',baseOnly:!active};groups.push(group);
  for(const c of members){c.batchId=group.id;c.commentGroup=key;c.inLeadBase=!active;c.baseKind='called';c.stageId=stage?.id||'';c.stage=stage?.name||'';c.stageHistory=stage?[{at:M.today(),stageId:stage.id}]:[];c.next=key==='proposal'?'Подготовить и отправить КП':key==='callback'?'Связаться с клиентом':key==='review'?'Проверить комментарий':'Хранится в общей базе';}
 }
 copy.leadBatches=copy.leadBatches.filter(b=>b.id!==batch.id).concat(groups);
 s.clients=copy.clients;s.pipelines=copy.pipelines;s.leadBatches=copy.leadBatches;return groups;
}
function batchCandidates(s,u,batchId){return M.visibleClients(s,u).filter(c=>c.batchId===batchId&&c.inLeadBase)}
function promoteBatch(s,u,batchId,pipelineId,stageId){
 const b=s.leadBatches.find(b=>b.id===batchId);if(!b||b.groupedInto)throw Error('База не найдена');
 const clients=batchCandidates(s,u,batchId);if(!clients.length)throw Error('Все доступные контакты этой базы уже в воронке');
 const result=promote(s,u,clients.map(c=>c.id),pipelineId,stageId);
 const at=nowStamp(),progress=batchProgress(s,batchId);
 b.funnelLoads??=[];b.funnelLoads.push({at,by:u.id,pipelineId,stageId,count:result.length});
 b.lastFunnelAt=at;b.funnelSent=progress.sent;b.funnelTotal=progress.total;
 if(progress.total>0&&progress.left===0){b.archived=true;b.archivedAt=at}
 return result;
}
function archiveBatch(s,u,batchId){
 if(M.onProbation(u))throw Error('Новичку недоступны архив и удаление баз');
 const b=s.leadBatches.find(x=>x.id===batchId);if(!canTouchBatch(s,u,b))throw Error('База не найдена или недоступна');
 const progress=batchProgress(s,batchId);if(!progress.total||progress.left)throw Error('В архив уходит база, только когда в воронку перенесены все её контакты');
 b.archived=true;b.archivedAt=b.archivedAt||b.lastFunnelAt||nowStamp();b.funnelSent=progress.sent;b.funnelTotal=progress.total;return b;
}
function restoreBatch(s,u,batchId){
 if(M.onProbation(u))throw Error('Новичку недоступны архив и удаление баз');
 const b=s.leadBatches.find(x=>x.id===batchId);if(!canTouchBatch(s,u,b))throw Error('База не найдена или недоступна');
 if(!b.archived)throw Error('База не в архиве');
 b.archived=false;b.restoredAt=nowStamp();return b;
}
function promote(s,u,ids,pipelineId,stageId){
 if(!M.has(s,u,'clients.edit')||!ids.length)throw Error('Выберите доступные контакты');
 if(!s.pipelines.find(p=>p.id===pipelineId)?.stages.some(t=>t.id===stageId))throw Error('Выберите этап воронки');
 const clients=[...new Set(ids)].map(id=>s.clients.find(c=>c.id===id));
 if(clients.some(c=>!c||!c.inLeadBase||!M.canClient(s,u,c)))throw Error('Контакт недоступен или уже находится в воронке');
 for(const c of clients){attachSourceComment(c);M.moveClient(s,u,c.id,pipelineId,stageId);c.processedAt=M.today();c.processedBy=u.id}
 return clients;
}
function groupExisting(s,u,batchId,choices,fileDate){
 if(!canImport(u,s))throw Error('Нет доступа к распределению базы');
 const batch=s.leadBatches.find(b=>b.id===batchId);if(!batch||batch.groupedInto)throw Error('База уже распределена или не найдена');
 const clients=s.clients.filter(c=>c.batchId===batchId);if(!clients.length)throw Error('В базе нет лидов');
 if(clients.some(c=>!Object.hasOwn(commentGroups,choices[c.id])))throw Error('Проверьте группы всех лидов');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(fileDate||''))throw Error('Укажите дату базы');
 const pipe=s.pipelines.find(p=>p.id===batch.pipelineId);if(!pipe)throw Error('Воронка базы не найдена');
 const groups=[];
 for(const key of Object.keys(commentGroups)){
  const members=clients.filter(c=>choices[c.id]===key);if(!members.length)continue;
  const active=false;let stage;
  if(active){stage=pipe.stages.find(t=>[commentGroups[key],key==='proposal'?'Ждут КП':'Ждут звонка'].includes(t.name)&&t.kind==='open');if(!stage){stage={id:M.uid(),name:key==='proposal'?'Ждут КП':'Ждут звонка',kind:'open'};const i=pipe.stages.findIndex(t=>t.kind!=='open');pipe.stages.splice(i<0?pipe.stages.length:i,0,stage)}}
  const group={...batch,id:M.uid(),importId:batch.importId||batch.id,group:key,fileDate,baseName:batch.baseName||batch.name,name:(batch.baseName||batch.name)+' · '+fileDate+' · '+commentGroups[key],kind:'called',baseOnly:!active};delete group.groupedInto;groups.push(group);
  for(const c of members){c.originalBatchId??=batch.id;c.batchId=group.id;c.commentGroup=key;c.inLeadBase=!active;c.baseKind='called';c.stageId=stage?.id||'';c.stage=stage?.name||'';c.stageHistory??=[];c.stageHistory.push({at:M.today(),stageId:c.stageId,reason:'Распределение по комментариям: '+commentGroups[key]});c.next=key==='proposal'?'Подготовить и отправить КП':key==='callback'?'Связаться с клиентом':key==='review'?'Проверить комментарий':'Хранится в общей базе';}
 }
 batch.groupedInto=groups.map(b=>b.id);s.leadBatches.push(...groups);return groups;
}
const api={batchCandidates,batchProgress,archiveBatch,restoreBatch,promoteBatch,promote,groupExisting,commentGroups,classifyComment,importComment,groupedCommit,manualStage,migrateCold,ensureColdStage,ensureProposalStage,acceptIntegrationDeals,ingestIntegration,socialLinks,socialFields,categories,fields,isSales,canImport,upgrade,mapping,preview,commit,distribution,distribute,phone,isCommentHeader,sourceCommentFrom,excelValue,excelNote,sheetBounds,withCellNotes,deriveSourceComment};if(typeof module!=='undefined')module.exports=api;root.LeadModel=api;
})(globalThis);
