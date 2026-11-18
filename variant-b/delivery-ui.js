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
function clientTimeline(client){
 const notes=(client.notes||[]).map(note=>`<p>${esc(typeof note==='string'?note:(note.text||''))}</p>`).join('');
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
