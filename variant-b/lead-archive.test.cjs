const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),M=require('./model.js'),L=require('./leads-model.js');
function fixture(){const box={window:{}};vm.runInNewContext(fs.readFileSync(__dirname+'/seed.js','utf8'),box);return L.upgrade(M.migrate(JSON.parse(JSON.stringify(box.window.BASE_SEED))))}
const stamp=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+10:00$/;

test('A file stays in its group with progress until every contact is in the funnel, then it is archived',()=>{
 const s=fixture(),rop=s.users[0],h=['Имя','Телефон','Комментарий'];
 const rows=[['Первый','79998880011','Ждут КП'],['Второй','79998880012','Ждут КП']];
 const batch=L.groupedCommit(s,rop,h,rows,L.mapping(h),{name:'Файл ноября',file:'nov.xlsx',fileDate:'2026-11-17',pipelineId:'outbound',kind:'cold'},{2:'proposal',3:'proposal'})[0];
 const clients=s.clients.filter(c=>c.batchId===batch.id);
 assert.equal(clients.length,2);
 clients[0].ownerId='sales';clients[1].ownerId='sales2';
 const partial=L.promoteBatch(s,s.users.find(u=>u.id==='sales'),batch.id,'outbound','out-2');
 assert.equal(partial.length,1);
 assert.equal(batch.archived,undefined);
 assert.match(batch.lastFunnelAt,stamp);
 assert.equal(batch.funnelSent,1);
 assert.equal(batch.funnelTotal,2);
 assert.equal(L.batchProgress(s,batch.id).left,1);
 assert.equal(clients.every(c=>c.sourceComment==='Ждут КП'),true);
 const rest=L.promoteBatch(s,rop,batch.id,'outbound','out-2');
 assert.equal(rest.length,1);
 assert.equal(batch.archived,true);
 assert.equal(batch.archivedAt,batch.lastFunnelAt);
 assert.match(batch.lastFunnelAt,stamp);
 assert.equal(L.batchProgress(s,batch.id).left,0);
 assert.equal(clients.every(c=>c.inLeadBase===false&&c.sourceComment==='Ждут КП'),true);
 assert.throws(()=>L.archiveBatch(s,s.users.find(u=>u.role==='developer'),batch.id));
 const returned=L.restoreBatch(s,rop,batch.id);
 assert.equal(returned.archived,false);
 assert.match(returned.restoredAt,stamp);
 assert.match(returned.lastFunnelAt,stamp);
 assert.throws(()=>L.restoreBatch(s,rop,batch.id));
 const again=L.archiveBatch(s,rop,batch.id);
 assert.equal(again.archived,true);
 assert.equal(again.lastFunnelAt,batch.lastFunnelAt);
});

test('Manual archive is refused while part of the file is still in the lead base',()=>{
 const s=fixture(),rop=s.users[0];
 const batch=L.commit(s,rop,['Имя','Телефон'],[['Один','79997770001'],['Два','79997770002']],['name','phone'],{name:'Часть',pipelineId:'outbound',destination:'base'});
 const first=s.clients.filter(c=>c.batchId===batch.id)[0];
 L.promote(s,rop,[first.id],'outbound','out-2');
 assert.throws(()=>L.archiveBatch(s,rop,batch.id),/все её контакты/);
 assert.equal(batch.archived,undefined);
 assert.equal(L.batchProgress(s,batch.id).sent,1);
});
