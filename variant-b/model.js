(function(root){
const Access=root.CRMAccess||(typeof require==='function'?require('./assets/access-model.js'):null);
const has=(s,u,k)=>Access.has(s,u,k);
const roles={admin:'Админ',leader:'Руководитель проекта',sales:'Менеджер 1 категории',sales_intern:'Менеджер-стажёр',rop:'РОП — руководитель отдела продаж',pm:'Проджект-менеджер',dev_head:'Начальник разработки',developer:'Разработчик'};
const uid=()=>globalThis.crypto?.randomUUID?.()||'id-'+Date.now()+'-'+Math.random().toString(36).slice(2);
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Vladivostok',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const statuses=['В очереди','В работе','На проверке','Готово'];
function migrate(old){
 const users=[{id:'admin',name:'Ксения',role:'admin'},{id:'lead',name:'Мария',role:'leader'},{id:'sales',name:'Елена',role:'sales'},{id:'pm',name:'Дмитрий',role:'pm'},{id:'anna',name:'Анна',role:'developer'},{id:'dev2',name:'Алексей',role:'developer'},{id:'sales2',name:'Олег',role:'sales'},{id:'lead2',name:'Светлана',role:'leader'}];
 const names=['Новый','Контакт','Квалификация','Предложение','В проекте','Отказ'];
 const pipeline={id:'inbound',name:'Входящие заявки',stages:names.map((name,i)=>({id:'stage-'+i,name,kind:i===4?'won':i===5?'lost':'open'}))};
 const outbound={id:'outbound',name:'Исходящие обращения',stages:[{id:'out-1',name:'База клиентов',kind:'open'},{id:'out-2',name:'Первый контакт',kind:'open'},{id:'out-3',name:'Согласование',kind:'open'},{id:'out-4',name:'В проекте',kind:'won'}]};
 const projects=old.projects.map((p,i)=>({...p,id:String(p.id),leaderId:i===2?'lead2':'lead',pmId:'pm',members:[i===2?'lead2':'lead','pm',i===2?'dev2':'anna',i===2?'sales2':'sales'],start:'2026-10-22',due:i===0?'2026-11-02':i===1?'2026-11-04':'2026-11-12',budget:[170000,140000,390000][i],description:'Автоматизация рабочего процесса: '+p.title,recipients:[{id:uid(),name:'Представитель заказчика',email:'client'+(i+1)+'@example.test'}],board:{notes:[{id:'note-'+i+'-1',x:90,y:90,color:'yellow',text:'Задача клиента\n'+p.title,author:'lead'},{id:'note-'+i+'-2',x:400,y:180,color:'blue',text:'Первый этап\nСогласовать сценарий и макет',author:'pm'}],links:[],comments:[]},mockup:{name:'Эскиз интерфейса',data:''}}));
 const clients=old.clients.map((c,i)=>({...c,id:String(c.id),project:c.project?String(c.project):'',ownerId:i===2?'sales2':'sales',pipelineId:'inbound',stageId:pipeline.stages.find(s=>s.name===c.stage)?.id||'stage-0',createdAt:'2026-10-22',stageHistory:[{at:'2026-10-22',stageId:pipeline.stages.find(s=>s.name===c.stage)?.id||'stage-0'}]}));
 const tasks=[];
 for(const [i,p] of projects.entries())for(const [j,[text,done]] of (p.tasks||[]).entries())tasks.push({id:uid(),projectId:p.id,title:text,status:done?'Готово':j===2?'В работе':'В очереди',assigneeId:i===2?'dev2':'anna',createdBy:p.leaderId,start:'2026-10-'+String(23+j).padStart(2,'0'),due:i===0?'2026-10-'+String(28+j).padStart(2,'0'):'2026-11-'+String(2+j).padStart(2,'0'),estimate:16,remaining:done?0:12,type:'work',peerId:'',description:'',createdAt:'2026-10-22',completedAt:done?'2026-10-27':''});
 tasks.push({id:'discuss-anna',projectId:'1',title:'Обсудить задачи с Анной',status:'В работе',assigneeId:'lead',createdBy:'lead',start:'2026-10-30',due:'2026-10-30',estimate:1,remaining:1,type:'chat',peerId:'anna',description:'Обсудить карточку клиента и договориться о следующем шаге.',createdAt:'2026-10-30'});
 tasks.push({id:'send-document',projectId:'1',title:'Отправить техническое задание заказчику',status:'В очереди',assigneeId:'sales',createdBy:'lead',start:'2026-10-30',due:'2026-10-31',estimate:1,remaining:1,type:'document',peerId:'',description:'Выбрать актуальную версию из материалов проекта.',createdAt:'2026-10-30'});
 for(const t of old.tasks||[])tasks.push({id:'legacy-'+t.id,projectId:clients.find(c=>c.id===String(t.client))?.project||'1',title:t.text,status:t.done?'Готово':'В очереди',assigneeId:clients.find(c=>c.id===String(t.client))?.ownerId||'sales',createdBy:'sales',start:'2026-10-30',due:'2026-10-31',estimate:1,remaining:t.done?0:1,type:'work',peerId:'',description:'',createdAt:'2026-10-30'});
 const materials=projects.flatMap(p=>[{id:uid(),projectId:p.id,name:'Техническое задание.txt',mime:'text/plain',text:'Демонстрационный документ проекта «'+p.title+'».\nЦель: автоматизация процесса.\nЭтапы: проектирование, разработка, проверка, передача.',createdBy:p.leaderId,createdAt:'2026-10-30'},{id:uid(),projectId:p.id,name:'Критерии приёмки.txt',mime:'text/plain',text:'Проверить основной сценарий, права пользователей и сохранение данных.\nДемонстрационный материал.',createdBy:p.leaderId,createdAt:'2026-10-30'}]);
 return {schema:2,users,pipelines:[pipeline,outbound],projects,clients,tasks,materials,messages:[],outbox:[]};
}
function project(s,id){return s.projects.find(p=>p.id===String(id))}
function canProject(s,u,id){const p=project(s,id);return !!p&&has(s,u,'projects.view')&&(has(s,u,'projects.all')||(u.role==='leader'?p.leaderId===u.id:p.members.includes(u.id)))}
function canAssign(s,u,id){return canProject(s,u,id)&&has(s,u,'tasks.assign')}
function canManage(s,u,id){return canProject(s,u,id)&&has(s,u,'projects.manage')}
function visibleProjects(s,u){return s.projects.filter(p=>canProject(s,u,p.id))}
function onProbation(u){return !!(u&&u.role!=='admin'&&u.probation===true)}
function visibleClients(s,u){if(onProbation(u))return s.clients.filter(c=>c.ownerId===u.id);if(has(s,u,'clients.all'))return s.clients;return s.clients.filter(c=>has(s,u,'clients.own')&&c.ownerId===u.id||has(s,u,'clients.project')&&c.project&&canProject(s,u,c.project))}
function visibleTasks(s,u){return has(s,u,'tasks.view')?s.tasks.filter(t=>canProject(s,u,t.projectId)&&(has(s,u,'tasks.all')||t.assigneeId===u.id)):[]}
function canTask(s,u,t){return has(s,u,'tasks.edit')&&canProject(s,u,t.projectId)&&(canManage(s,u,t.projectId)||canAssign(s,u,t.projectId)||t.assigneeId===u.id)}
function canClient(s,u,c){return visibleClients(s,u).some(x=>x.id===c.id)}
function stage(s,c){return s.pipelines.find(p=>p.id===c.pipelineId)?.stages.find(t=>t.id===c.stageId)}
function risk(tasks,day=today()){
 const active=tasks.filter(t=>t.status!=='Готово');
 const overdue=active.filter(t=>t.due&&t.due<day);
 const critical=active.filter(t=>{const days=Math.round((Date.parse(t.due)-Date.parse(day))/86400000);return Number.isFinite(days)&&days>=0&&days<=3&&t.remaining>=8});
 return {active,overdue,critical,done:tasks.filter(t=>t.status==='Готово'),queued:tasks.filter(t=>t.status==='В очереди'),working:tasks.filter(t=>t.status==='В работе')};
}
function progress(s,u,id){const ts=visibleTasks(s,u).filter(t=>t.projectId===id);return ts.length?Math.round(ts.filter(t=>t.status==='Готово').length/ts.length*100):0}
function addTask(s,u,input){
 if(!has(s,u,'tasks.create')||!canProject(s,u,input.projectId))throw Error('Нет доступа к проекту');
 if(!input.title?.trim()||!input.due)throw Error('Заполните название и срок');
 if(input.start&&input.start>input.due)throw Error('Начало не может быть позже срока');
 if(!Number.isFinite(+input.remaining)||+input.remaining<0||!Number.isFinite(+input.estimate)||+input.estimate<0)throw Error('Объём работы должен быть неотрицательным числом');
 if(input.assigneeId&&!canAssign(s,u,input.projectId))throw Error('Назначать исполнителя могут только админ и руководитель проекта');
 const p=project(s,input.projectId);if(input.assigneeId&&!p.members.includes(input.assigneeId)&&input.assigneeId!=='admin')throw Error('Исполнитель должен участвовать в проекте');
 if(input.type==='chat'&&!p.members.includes(input.peerId))throw Error('Выберите участника проекта для обсуждения');
 const t={...input,id:uid(),title:input.title.trim(),assigneeId:input.assigneeId||'',status:'В очереди',createdBy:u.id,createdAt:today(),estimate:+input.estimate,remaining:+input.remaining};s.tasks.push(t);return t;
}
function updateTask(s,u,id,patch){const t=s.tasks.find(t=>t.id===id);if(!t||!canTask(s,u,t))throw Error('Нет доступа к задаче');
 if('assigneeId' in patch&&patch.assigneeId!==t.assigneeId){if(!canAssign(s,u,t.projectId))throw Error('Назначать исполнителя могут только админ и руководитель проекта');if(patch.assigneeId&&!project(s,t.projectId).members.includes(patch.assigneeId)&&patch.assigneeId!=='admin')throw Error('Исполнитель должен участвовать в проекте')}
 if(patch.projectId&&patch.projectId!==t.projectId)throw Error('Проект существующей задачи менять нельзя');
 const manager=canManage(s,u,t.projectId);if(!manager&&Object.keys(patch).some(k=>!['status','remaining',...(canAssign(s,u,t.projectId)?['assigneeId']:[])].includes(k)))throw Error('Можно изменить только состояние своей работы');
 if(patch.status&&!statuses.includes(patch.status))throw Error('Неизвестный статус');
 if('remaining' in patch&&(!Number.isFinite(+patch.remaining)||+patch.remaining<0))throw Error('Проверьте оставшийся объём');
 const next={...t,...patch};if(next.type==='chat'&&!project(s,t.projectId).members.includes(next.peerId))throw Error('Выберите участника проекта для обсуждения');if(!next.title?.trim())throw Error('Введите название задачи');if(next.start&&next.start>next.due)throw Error('Начало не может быть позже срока');
 Object.assign(t,patch);if(t.status==='Готово'){t.remaining=0;t.completedAt=today()}else if(patch.status){t.completedAt=''}return t;
}
function moveClient(s,u,id,pipelineId,stageId){const c=s.clients.find(c=>c.id===id),pipe=s.pipelines.find(p=>p.id===pipelineId);if(!c||!has(s,u,'clients.edit')||!canClient(s,u,c))throw Error('Нет доступа к клиенту');if(!pipe?.stages.some(t=>t.id===stageId))throw Error('Этап не найден');c.inLeadBase=false;c.pipelineId=pipelineId;c.stageId=stageId;c.stage=stage(s,c).name;c.stageHistory??=[];c.stageHistory.push({at:today(),stageId});}
function addStage(s,u,pipeId,name,kind='open'){if(!has(s,u,'pipelines.manage'))throw Error('Этапы настраивает админ или руководитель');if(!name?.trim())throw Error('Введите название этапа');const p=s.pipelines.find(p=>p.id===pipeId);if(!p)throw Error('Воронка не найдена');if(p.stages.some(t=>t.name.toLowerCase()===name.trim().toLowerCase()))throw Error('Такой этап уже существует');const t={id:uid(),name:name.trim(),kind};p.stages.push(t);return t}
function report(s,u,filter={}){const ps=visibleProjects(s,u);let ts=visibleTasks(s,u),cs=visibleClients(s,u).filter(c=>!c.inLeadBase);if(filter.project){ts=ts.filter(t=>t.projectId===filter.project);cs=cs.filter(c=>c.project===filter.project)}if(filter.from)cs=cs.filter(c=>c.createdAt>=filter.from);if(filter.to)cs=cs.filter(c=>c.createdAt<=filter.to);const won=cs.filter(c=>stage(s,c)?.kind==='won'),lost=cs.filter(c=>stage(s,c)?.kind==='lost');return {projects:ps.filter(p=>!filter.project||p.id===filter.project),tasks:ts,clients:cs,won,lost,conversion:cs.length?won.length/cs.length*100:0,total:cs.reduce((a,c)=>a+(+c.amount||0),0),wonTotal:won.reduce((a,c)=>a+(+c.amount||0),0),risk:risk(ts,filter.today),finance:has(s,u,'finance.view'),sales:has(s,u,'sales.analytics')}}
// Руководитель: админ, руководитель проекта или начальник разработки. Проджект: проджект-менеджер, админ или начальник разработки.
const leaderRoles=['admin','leader','dev_head'];
const managerRoles=['pm','admin','dev_head'];
const teamRoleHint='Нет сотрудников с нужной ролью — добавьте их в разделе «Команда и роли»';
const teamFallbackHint=teamRoleHint+'. Сейчас можно выбрать админа или начальника разработки.';
const activeUser=user=>user&&user.active!==false;
function userLabel(user){return (user?.name||'Не назначен')+' · '+(roles[user?.role]||'роль не указана')}
function projectLeaderChoices(users){return (users||[]).filter(user=>activeUser(user)&&leaderRoles.includes(user.role))}
function projectManagerChoices(users){return (users||[]).filter(user=>activeUser(user)&&managerRoles.includes(user.role))}
function projectMemberChoices(users){return (users||[]).filter(user=>user&&user.role!=='admin')}
function projectTeamHint(people,kind){const list=people||[];if(kind==='members')return list.length?'':teamRoleHint;const dedicated=kind==='leader'?'leader':'pm';if(!list.length)return teamRoleHint;if(!list.some(user=>user.role===dedicated))return teamFallbackHint;return ''}
function normalizeProjectTeam(users,actor,project,previous){
 const list=users||[];
 const explicitLeader=String(project?.leaderId||'').trim();
 const leaderId=explicitLeader||previous?.leaderId||actor?.id||'';
 const leader=list.find(user=>user&&user.id===leaderId);
 if(!leader)throw Error('Руководитель проекта не найден');
 const leaderChanged=!previous||leaderId!==previous.leaderId;
 if(leaderChanged&&leaderId!==actor?.id&&!leaderRoles.includes(leader.role))throw Error('Руководителем может быть админ, руководитель проекта или начальник разработки');
 const explicitPm=String(project?.pmId||'').trim();
 let pmId='';
 if(explicitPm){
  const pm=list.find(user=>user&&user.id===explicitPm);
  if(!pm)throw Error('Проджект-менеджер не найден');
  const pmChanged=!previous||explicitPm!==(previous.pmId||'');
  if(pmChanged&&!managerRoles.includes(pm.role))throw Error('Проджект-менеджером может быть проджект-менеджер, админ или начальник разработки');
  pmId=explicitPm;
 }
 const members=[];
 for(const id of [...(project?.members||[]),leaderId,pmId]){if(id&&!members.includes(id))members.push(id)}
 if(members.some(id=>!list.some(user=>user&&user.id===id)))throw Error('Участник проекта не найден');
 return {leaderId,pmId,members};
}
const api={has,roles,statuses,uid,today,migrate,project,canProject,canAssign,canManage,canTask,canClient,visibleProjects,visibleTasks,visibleClients,onProbation,stage,risk,progress,addTask,updateTask,moveClient,addStage,report,userLabel,leaderRoles,managerRoles,projectLeaderChoices,projectManagerChoices,projectMemberChoices,projectTeamHint,normalizeProjectTeam,teamRoleHint};if(typeof module!=='undefined')module.exports=api;root.CRMModel=api;
})(globalThis);
