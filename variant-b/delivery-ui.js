function deliveryBoard(){
 const stages=DeliveryModel.stages;
 const projects=vp();
 const mine=!M.has(state,u(),'tasks.all');
 return heading('Разработка','Проект идёт от выигранной сделки до техподдержки. Карточку можно перетащить или перевести списком.',mine?'':action('Задача разработчику','dev-task','',true))+`<p class="hint">${mine?'Вы видите проекты, в которых участвуете, и только свои задачи.':'Админ, проджект-менеджер и начальник разработки видят все проекты и все задачи. Разработчик видит только свои.'}</p><div class="funnel-board dev-board">${stages.map((stage,index)=>{
  const cards=projects.filter(project=>DeliveryModel.stageById(project.devStage)?.id===stage.id||(!DeliveryModel.stageById(project.devStage)&&stage.id==='dev-start'));
  return `<section class="stage-column" data-drop-dev="${stage.id}" aria-label="${stage.name}"><div class="stage-head"><h3>${index} · ${esc(stage.name)} <span>${cards.length}</span></h3></div>${cards.map(project=>deliveryCard(project)).join('')}${cards.length?'':'<p class="drop-hint">Переместите проект сюда</p>'}</section>`;
 }).join('')}</div>`;
}
function deliveryCard(project){
 const tasks=vt().filter(task=>task.projectId===project.id);
 const move=DeliveryModel.canMove(state,u(),project.id);
 return `<article class="dev-card"${move?' draggable="true"':''} data-drag-project="${project.id}"><strong>${esc(project.title)}</strong><p>${esc(project.client||'Заказчик не указан')}</p><small>${tasks.length?tasks.length+' '+(M.has(state,u(),'tasks.all')?'задач':'ваших задач'):'Задач пока нет'}</small><ul class="dev-tasks">${tasks.map(task=>`<li>${esc(task.title)} · ${esc(name(task.assigneeId))} · ${esc(task.status)}</li>`).join('')}</ul><div class="actions">${action('Открыть','project',project.id)}${M.canAssign(state,u(),project.id)?action('Задача','dev-task',project.id):''}</div>${move?`<label class="field dev-move">Перевести на этап<select class="dev-stage" data-id="${project.id}" aria-label="Этап проекта ${esc(project.title)}">${DeliveryModel.stages.map(stage=>option(stage.id,stage.name,project.devStage||'dev-start')).join('')}</select></label>`:''}</article>`;
}
function deliveryTaskForm(projectId){
 const projects=vp().filter(project=>M.canAssign(state,u(),project.id));
 if(!projects.length)throw Error('Назначать задачи могут админ, начальник разработки и руководитель проекта');
 const picked=projects.some(project=>project.id===projectId)?projectId:projects[0].id;
 const developers=state.users.filter(user=>user.role==='developer'&&user.active!==false);
 if(!developers.length)throw Error('В команде пока нет разработчиков. Добавьте их в разделе «Команда и роли».');
 modal('Задача разработчику',selectField('Проект','projectId',projects.map(project=>option(project.id,project.title,picked)).join(''))+field('Что сделать','title','','text',true)+selectField('Разработчик','assigneeId',developers.map(user=>option(user.id,user.name,developers[0].id)).join(''))+field('Срок','due',M.today(),'date',true),'Поставить задачу',fd=>{
  const id=fd.get('projectId');
  const assigneeId=fd.get('assigneeId');
  const project=M.project(state,id);
  if(!project||!M.canAssign(state,u(),id))throw Error('Нет права назначать задачи в этом проекте');
  if(!developers.some(user=>user.id===assigneeId))throw Error('Исполнителем может быть разработчик');
  if(!project.members.includes(assigneeId)){
   if(!M.canManage(state,u(),id))throw Error('Сначала добавьте разработчика в участники проекта');
   project.members.push(assigneeId);
  }
  M.addTask(state,u(),{projectId:id,title:fd.get('title'),due:fd.get('due'),start:M.today(),estimate:8,remaining:8,type:'work',assigneeId,description:''});
  toast('Задача назначена. Разработчик увидит проект и только свою задачу.');
 });
}
function personContact(user){
 if(!user)return '';
 const telegram=String(user.telegram||'').replace(/^@/,'');
 const extra=[M.roles[user.role]||'',telegram?'Telegram @'+telegram:'',user.sipuniExtension?'внутр. '+user.sipuniExtension:''].filter(Boolean).join(' · ');
 return `<p><b>${esc(user.name)}</b>${extra?' · '+esc(extra):''}</p>`;
}
function handoverBriefView(brief){
 if(!brief?.sold)return '';
 const link=String(brief.kpLink||'').trim();
 const linkHtml=link?`<p><b>Ссылка на КП.</b> ${/^https?:\/\//i.test(link)?`<a href="${esc(link)}" target="_blank" rel="noopener noreferrer">${esc(link)}</a>`:esc(link)}</p>`:'<p><b>Ссылка на КП.</b> нет</p>';
 const files=(brief.files||[]).length?brief.files.map(name=>esc(name)).join(', '):'не приложены';
 return `<div class="handover-brief"><p><b>Что продали.</b> ${esc(brief.sold)}</p><p><b>Вариант КП.</b> ${esc(brief.kp||'не указан')}</p><p><b>Сумма.</b> ${money(brief.amount||0)}</p><p><b>Срок.</b> ${esc(brief.due||'не указан')}</p><p><b>Контакты.</b> ${esc(brief.contacts||'не указаны')}</p>${linkHtml}<p><b>Файлы.</b> ${files}</p></div>`;
}
function handoverBrief(project){
 return project?.handover?.sold?`<section class="handover-card"><h3>Бриф от менеджера</h3>${handoverBriefView(project.handover)}</section>`:'';
}
function projectDevelopers(project){
 return (project.members||[]).map(id=>state.users.find(user=>user.id===id)).filter(user=>user&&(user.role==='developer'||user.role==='dev_head'));
}
function projectHandover(client){
 if(M.stage(state,client)?.kind!=='won')return '';
 const project=client.project&&M.project(state,client.project);
 if(!project)return '';
 const stage=DeliveryModel.stageById(project.devStage);
 const pm=project.pmId&&state.users.find(user=>user.id===project.pmId);
 const developers=projectDevelopers(project);
 const missing=!pm||!developers.length;
 const linked=typeof telegramLinked!=='undefined'&&telegramLinked.includes(project.id);
 const thread=(state.messages||[]).filter(item=>item.projectId===project.id).slice(-3);
 return `<section class="handover-card"><h3>Проект</h3><p><b>${esc(project.title)}</b></p><p>Статус: ${esc(project.status||'не указан')}. Этап разработки: ${esc(stage?.name||'Начало проекта')}. Этап меняет руководитель, не менеджер.</p><div class="actions">${action('Открыть проект','project',project.id)}</div><h3>Проджект</h3>${pm?personContact(pm):'<p>Проджект ещё не назначен</p>'}<h3>Разработчики</h3>${developers.length?developers.map(personContact).join(''):'<p>Разработчик ещё не назначен</p>'}${missing?`<div class="actions">${action('Попросить назначить','ask-assign',project.id)}</div>`:''}${handoverBriefView(project.handover||client.handover)}<h3>Написать команде</h3>${thread.map(item=>`<p><b>${esc(name(item.from))}</b> → ${esc(item.to?name(item.to):'команде проекта')}: ${esc(item.text)}</p>`).join('')||'<p>Обсуждений пока нет.</p>'}<div class="actions">${action('Написать в обсуждение','deal-discuss',client.id)}${linked?action('Написать в группу проекта','deal-telegram',client.id):''}</div></section>`;
}
function handoverForm(client,stageId){
 if(!client||!M.canClient(state,u(),client))throw Error('Клиент недоступен');
 const materials=(state.materials||[]).filter(item=>item.projectId&&item.projectId===client.project);
 const files=materials.map(item=>`<label class="member-choice"><input type="checkbox" name="file" value="${esc(item.name)}" checked>${esc(item.name)}</label>`).join('');
 const contacts=[client.phone,client.email,client.socials].map(value=>String(value||'').trim()).filter(Boolean).join('\n');
 modal('Передать в проект','<p class="hint">Бриф сохранится в проекте. Его увидят проджект и разработчики. Доску разработки менеджер не двигает.</p>'+area('Что продали','sold',client.description||client.clientTask||'')+area('Выбранный вариант КП','kp',client.kpVariants||'')+field('Сумма','amount',client.amount||0,'number',true)+field('Срок','due',client.dealDate||'','date')+area('Контакты клиента','contacts',contacts)+field('Ссылка на КП','kpLink',client.kpLink||'','text')+(files?`<h3>Файлы</h3>${files}`:'<p class="hint">Отдельных файлов пока нет. Ссылка на КП сохранится в брифе.</p>'),'Передать в проект',fd=>{
  const sold=String(fd.get('sold')||'').trim();
  if(!sold)throw Error('Напишите, что продали');
  client.handover={sold,kp:String(fd.get('kp')||'').trim(),amount:Number(fd.get('amount'))||0,due:String(fd.get('due')||'').trim(),contacts:String(fd.get('contacts')||'').trim(),kpLink:String(fd.get('kpLink')||'').trim(),files:fd.getAll('file'),at:new Date().toISOString(),by:u().id};
  client.amount=client.handover.amount;
  client.kpVariants=client.handover.kp;
  client.kpLink=client.handover.kpLink;
  client.description=sold;
  M.moveClient(state,u(),client.id,client.pipelineId,stageId);
  toast('Сделка передана в проект');
 });
}
function dealDiscuss(id){
 const client=vc().find(item=>item.id===id);
 const project=client?.project&&M.project(state,client.project);
 if(!client||!project||!M.canProject(state,u(),project.id))throw Error('Проект недоступен');
 const pm=project.pmId&&state.users.find(user=>user.id===project.pmId);
 const developer=projectDevelopers(project)[0];
 const target=pm||developer;
 modal('Обсуждение проекта',`<p class="hint">Сообщение попадёт в обсуждения проекта «${esc(project.title)}». ${target?'Получатель: '+esc(target.name)+'.':'Проджект ещё не назначен, сообщение увидит команда проекта.'}</p>`+area('Сообщение','text','',true),'Отправить',fd=>{
  const text=String(fd.get('text')||'').trim();
  if(!text)throw Error('Введите сообщение');
  state.messages.push({id:M.uid(),projectId:project.id,taskId:'',from:u().id,to:target?.id||'',text,at:new Date().toISOString()});
  toast('Сообщение в обсуждении проекта');
 });
}
function dealTelegram(id){
 const client=vc().find(item=>item.id===id);
 const project=client?.project&&M.project(state,client.project);
 if(!client||!project||!M.canProject(state,u(),project.id))throw Error('Проект недоступен');
 const label='группа проекта «'+project.title+'»';
 modal('Сообщение в группу проекта',`<p class="mail-confirm"><strong>Кому:</strong> ${esc(label)}, <strong>канал:</strong> Telegram</p>`+area('Сообщение','text',''),'Отправить',async fd=>{
  const text=String(fd.get('text')||'').trim();
  if(!text)throw Error('Введите сообщение');
  if(!window.confirm('Кому: '+label+', канал: Telegram?'))return false;
  await telegramApi('/api/telegram/project-send',{method:'POST',body:{projectId:project.id,text,confirmTo:label}});
  toast('Отправлено: '+label);
  return 'saved';
 });
}
async function askAssign(projectId){
 const project=M.project(state,projectId);
 if(!project||!M.canProject(state,u(),project.id))throw Error('Проект недоступен');
 await telegramApi('/api/telegram/ask',{method:'POST',body:{scope:'assign',projectId}});
 toast('Просьба отправлена руководителю');
}
function dealCard(client){
 const rows=[['Дата сделки',client.dealDate],['Описание',client.description],['Задача клиента',client.clientTask],['Варианты КП',client.kpVariants],['Созвон',client.callAt],['Статус',client.statusNote]];
 const filled=rows.filter(([,value])=>String(value||'').trim());
 const link=String(client.kpLink||'').trim();
 if(!filled.length&&!link)return '';
 const linkHtml=link?`<p><b>Ссылка на КП.</b> ${/^https?:\/\//i.test(link)?`<a href="${esc(link)}" target="_blank" rel="noopener noreferrer">${esc(link)}</a>`:esc(link)}</p>`:'';
 return `<section class="source-comment"><small>Карточка сделки</small>${filled.map(([label,value])=>`<p><b>${esc(label)}.</b> ${esc(value)}</p>`).join('')}${linkHtml}</section>`;
}
function handoverLead(id){
 const client=vc().find(item=>item.id===id);
 if(!client||!LeadModel.canImport(u(),state))throw Error('Передавать лид может администратор или РОП');
 const managers=state.users.filter(user=>LeadModel.isSales(user)&&user.active!==false);
 if(!managers.length)throw Error('Нет менеджеров, которым можно передать лид');
 modal('Передать менеджеру','<p class="hint">Лид сохранится на сервере. Выбранный менеджер увидит его у себя. Другие менеджеры эту карточку не увидят.</p>'+selectField('Ответственный менеджер','ownerId',managers.map(user=>option(user.id,user.name+' · '+M.roles[user.role],client.ownerId||managers[0].id)).join('')),'Передать',fd=>{
  const ownerId=fd.get('ownerId');
  if(!managers.some(user=>user.id===ownerId))throw Error('Этот сотрудник не принимает лиды');
  const previous=client.ownerId||'';
  client.ownerId=ownerId;
  client.notes||=[];
  if(previous!==ownerId)client.notes.unshift('Лид передан менеджеру '+name(ownerId)+' · '+name(u().id)+' · '+M.today());
  toast('Лид передан: '+name(ownerId));
 });
}
function callNote(note){
 const raw=typeof note==='string'?note:(note.text||'');
 const record=(raw.match(/\[\[record:([^\]]+)\]\]/)||[])[1]||'';
 const text=raw.replace(/\[\[call:[^\]]+\]\]/g,'').replace(/\[\[record:[^\]]+\]\]/g,'').trim();
 const safe=record&&(/^\/api\/sipuni\/record\?id=[\w.%:-]+$/.test(record)||/^https:\/\//i.test(record));
 const link=safe?` <a href="${esc(record)}" target="_blank" rel="noopener noreferrer">Запись</a>`:'';
 return `<p>${esc(text)}${link}</p>`;
}
function clientTimeline(client){
 const notes=(client.notes||[]).map(note=>callNote(note)).join('');
 const history=(client.stageHistory||[]).map(item=>{
  const pipeline=state.pipelines.find(pipe=>pipe.id===client.pipelineId);
  const stage=pipeline?.stages.find(row=>row.id===item.stageId);
  const label=item.stageId?(stage?.name||'Этап'):'База лидов';
  return `<p><small>${esc(item.at||'')} · ${esc(label)}${item.reason?' · '+esc(item.reason):''}</small></p>`;
 }).join('');
 return `<h3 style="margin-top:22px">Комментарии</h3><div class="timeline">${notes||'<p>Пока нет комментариев. Напишите итог разговора ниже.</p>'}</div><h3>История этапов</h3><div class="timeline">${history||'<p>История появится, когда лид сменит этап.</p>'}</div>`;
}
let dragProject='';
document.addEventListener('dragstart',event=>{const card=event.target.closest('[data-drag-project]');if(!card)return;dragProject=card.dataset.dragProject;event.dataTransfer.setData('text/plain',dragProject);event.dataTransfer.effectAllowed='move'});
document.addEventListener('dragend',()=>{dragProject=''});
document.addEventListener('dragover',event=>{if(event.target.closest('[data-drop-dev]'))event.preventDefault()});
document.addEventListener('drop',event=>{const column=event.target.closest('[data-drop-dev]');if(!column||!dragProject)return;event.preventDefault();try{DeliveryModel.moveProject(state,u(),dragProject,column.dataset.dropDev);if(!persist())return;render();toast('Проект переведён: '+DeliveryModel.stageById(column.dataset.dropDev).name)}catch(error){toast(error.message)}});
