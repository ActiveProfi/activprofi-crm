(function(root){
const M=root.CRMModel||(typeof require==='function'?require('./model.js'):null);
// Доска отдела разработки. Идентификаторы стабильные: старые проекты не теряют этап.
const stages=[
 {id:'dev-start',name:'Начало проекта'},
 {id:'dev-r1',name:'1 релиз'},
 {id:'dev-r2',name:'2 релиз'},
 {id:'dev-r3',name:'3 релиз'},
 {id:'dev-rework',name:'Доработка'},
 {id:'dev-rollout',name:'Внедрение'},
 {id:'dev-training',name:'Обучение'},
 {id:'dev-support',name:'Техподдержка'},
];
const stageById=id=>stages.find(stage=>stage.id===id);
function upgrade(state){
 state.projects||=[];
 for(const project of state.projects){
  if(stageById(project.devStage))continue;
  project.devStage='dev-start';
  project.devHistory=Array.isArray(project.devHistory)?project.devHistory:[];
  project.devHistory.push({stageId:'dev-start',by:'',reason:'Проект на доске разработки'});
 }
 return state;
}
function canMove(state,user,projectId){return M.canManage(state,user,projectId)}
function moveProject(state,user,projectId,stageId){
 const project=M.project(state,projectId);
 if(!project||!M.canProject(state,user,projectId))throw Error('Нет доступа к проекту');
 if(!canMove(state,user,projectId))throw Error('Нет доступа: этап меняют админ, проджект-менеджер, начальник разработки или руководитель этого проекта');
 const stage=stageById(stageId);
 if(!stage)throw Error('Этап разработки не найден');
 if(project.devStage===stage.id)return project;
 project.devStage=stage.id;
 project.status=stage.name;
 project.devHistory=Array.isArray(project.devHistory)?project.devHistory:[];
 project.devHistory.push({at:new Date().toISOString(),stageId:stage.id,by:user.id});
 return project;
}
// Выигранная сделка продолжается как проект на доске разработки, а не заканчивается.
function ensureFromWon(state,client,actorId){
 const sale=M.stage(state,client);
 if(sale?.kind!=='won')return null;
 let project=state.projects.find(item=>item.id&&item.id===client.project);
 if(project){
  if(!stageById(project.devStage)){
   project.devStage='dev-start';
   project.status=stages[0].name;
   project.devHistory=Array.isArray(project.devHistory)?project.devHistory:[];
   project.devHistory.push({at:new Date().toISOString(),stageId:'dev-start',by:actorId||'',reason:'Сделка выиграна'});
  }
  project.sourceClientId=project.sourceClientId||client.id;
  if(client.ownerId&&!(project.members||[]).includes(client.ownerId))project.members=[...(project.members||[]),client.ownerId];
  return project;
 }
 const titleBase=String(client.company||client.name||'Новый заказчик').trim()||'Новый заказчик';
 project={
  id:M.uid(),
  title:titleBase.startsWith('Проект')?titleBase:'Проект: '+titleBase,
  client:String(client.company||client.name||'Заказчик').trim()||'Заказчик',
  description:'Сделка выиграна и передана в разработку.',
  type:'crm',
  status:stages[0].name,
  devStage:'dev-start',
  devHistory:[{at:new Date().toISOString(),stageId:'dev-start',by:actorId||'',reason:'Сделка выиграна'}],
  leaderId:'',
  pmId:'',
  members:[...new Set([client.ownerId].filter(Boolean))],
  start:M.today(),
  due:'',
  budget:Number(client.amount)||0,
  next:'Назначить команду и первые задачи',
  recipients:[],
  board:{notes:[],links:[],comments:[]},
  mockup:{name:'',data:''},
  sourceClientId:client.id,
 };
 state.projects.push(project);
 client.project=project.id;
 client.notes=Array.isArray(client.notes)?client.notes:[];
 if(!client.notes.some(note=>String(note).includes('передана в разработку')))client.notes.unshift('Сделка передана в разработку: '+project.title);
 return project;
}
const api={stages,stageById,upgrade,canMove,moveProject,ensureFromWon};
if(typeof module!=='undefined')module.exports=api;
root.DeliveryModel=api;
})(globalThis);
