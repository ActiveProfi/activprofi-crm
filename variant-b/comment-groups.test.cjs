const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),L=require('./leads-model.js'),M=require('./model.js');
function fixture(){const box={window:{}};vm.runInNewContext(fs.readFileSync(__dirname+'/seed.js','utf8'),box);return L.upgrade(M.migrate(JSON.parse(JSON.stringify(box.window.BASE_SEED))))}
const h=['Компания','Телефон','Результат звонка'],opts={name:'База обзвона',file:'calls.xlsx',fileDate:'2026-11-12',kind:'cold',pipelineId:'outbound',headerRow:1};
test('Comments classify known outcomes and leave ambiguous/negated statements for review',()=>{
 for(const [text,key] of [['не актуально','irrelevant'],['ж сказала неинтересно','irrelevant'],['отказали','refused'],['уже есть срм','has_crm'],['ждут КП','proposal'],['просит прислать коммерческое предложение','proposal'],['ждут звонка','callback'],['перезвонить завтра','callback'],['не нужно КП','review'],['не отказались','review'],['отказ, но перезвонить завтра','review'],['','review'],['недозвон','review']])assert.equal(L.classifyComment(text),key,text);
 assert.equal(L.importComment(['Город','Комментарий','Примечание'],['Ждут КП','отказ','проверить'],['','','']),'отказ\nпроверить');
});
test('Grouped import routes only warm outcomes, preserves source/date, permissions and deduplication',()=>{
 const s=fixture(),rows=['не актуально','отказ','уже есть срм','ждут КП','ждут звонка','непонятно'].map((comment,i)=>['Компания '+i,'7999555880'+i,comment]),map=L.mapping(h,rows);
 const choices=Object.fromEntries(rows.map((r,i)=>[i+2,L.classifyComment(r[2])]));
 const original=JSON.stringify(s);assert.throws(()=>L.groupedCommit(s,s.users.find(u=>u.role==='sales'),h,rows,map,opts,choices));assert.equal(JSON.stringify(s),original);
 assert.throws(()=>L.groupedCommit(s,s.users[0],h,rows,map,opts,{}));assert.equal(JSON.stringify(s),original);
 const groups=L.groupedCommit(s,s.users[0],h,rows,map,opts,choices);assert.equal(groups.length,6);
 const imported=s.clients.filter(c=>groups.some(b=>b.id===c.batchId));assert.equal(imported.length,6);assert.equal(imported.filter(c=>!c.inLeadBase).length,0);
 for(const b of groups){assert.equal(b.file,'calls.xlsx');assert.equal(b.fileDate,'2026-11-12');assert.ok(b.name.includes('2026-11-12'));const c=imported.find(c=>c.batchId===b.id);assert.equal(c.notes[0],rows.find(r=>r[0]===c.name)[2]);if(b.baseOnly){assert.equal(c.stageId,'');assert.equal(M.stage(s,c),undefined)}else assert.equal(M.stage(s,c).name,b.group==='proposal'?'Ждут КП':'Ждут звонка');}
 const base=groups.find(b=>b.group==='refused');L.distribute(s,s.users[0],base.id,'sales');const c=s.clients.find(c=>c.batchId===base.id);assert.ok(c.ownerId);assert.equal(c.inLeadBase,true);
 M.moveClient(s,s.users[0],c.id,'outbound','out-2');assert.equal(c.inLeadBase,false);assert.equal(M.stage(s,c).id,'out-2');
 assert.throws(()=>L.groupedCommit(s,s.users[0],h,rows,map,opts,choices));
});
test('Manual corrections override suggested group and persist across serialization',()=>{
 const s=fixture(),rows=[['Проверить','79995558899','без ответа']],map=L.mapping(h,rows);L.groupedCommit(s,s.users[0],h,rows,map,opts,{2:'callback'});
 const c=JSON.parse(JSON.stringify(s)).clients.at(-1);assert.equal(c.commentGroup,'callback');assert.equal(c.stage,'');assert.equal(c.inLeadBase,true);
});

test('Three files remain separate inside every shared result category',()=>{
 const s=fixture();
 for(let file=0;file<3;file++){
  const keys=['proposal','callback','irrelevant','has_crm','refused'];
  const rows=keys.map((k,i)=>['Компания '+file+' '+i,'7999444'+String(file*10+i).padStart(4,'0'),'Комментарий']);
  const groups=L.groupedCommit(s,s.users[0],h,rows,L.mapping(h),{...opts,name:'База '+file,file:'calls-'+file+'.xlsx',fileDate:'2026-11-'+(12+file)},Object.fromEntries(keys.map((k,i)=>[i+2,k])));
  assert.equal(groups.length,5);
 }
 for(const key of ['proposal','callback','irrelevant','has_crm','refused']){const bs=s.leadBatches.filter(b=>b.group===key);assert.equal(bs.length,3);assert.equal(new Set(bs.map(b=>b.file)).size,3);assert.equal(new Set(bs.map(b=>b.fileDate)).size,3);assert.equal(new Set(bs.map(b=>b.baseName)).size,3);assert.equal(s.clients.filter(c=>bs.some(b=>b.id===c.batchId)).length,3);}
});

test('Only explicitly selected processed leads enter funnel; ownership and source stay intact',()=>{const s=fixture(),rows=[['Один','79990001121','ждут КП'],['Два','79990001122','перезвонить']];const groups=L.groupedCommit(s,s.users[0],h,rows,L.mapping(h),opts,{2:'proposal',3:'callback'});const cs=s.clients.slice(-2);const batchId=cs[0].batchId;L.promote(s,s.users[0],[cs[0].id],'outbound','out-2');assert.equal(cs[0].inLeadBase,false);assert.equal(cs[1].inLeadBase,true);assert.equal(cs[0].batchId,batchId);assert.equal(cs[0].stageId,'out-2');assert.throws(()=>L.promote(s,s.users[0],[cs[0].id],'outbound','out-2'));});
