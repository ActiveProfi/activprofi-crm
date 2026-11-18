const test=require('node:test'),assert=require('node:assert/strict'),D=require('./draft.js');
function memory(){const box=new Map();return {getItem:key=>box.has(key)?box.get(key):null,setItem:(key,value)=>box.set(key,String(value)),removeItem:key=>box.delete(key)}}
test('Draft keeps project fields and drops passwords',()=>{
  const storage=memory();
  const saved=D.rememberDraft(storage,'admin','project:new',{title:'Рассылка',client:'Тест',description:'Напоминания',members:['dev-1'],password:'secret-pass',staffPassword:'secret-pass',staffName:'Анна'});
  assert.equal(saved.values.password,undefined);
  assert.equal(saved.values.staffPassword,undefined);
  assert.equal(saved.values.staffName,undefined);
  assert.equal(saved.values.title,'Рассылка');
  assert.deepEqual(saved.values.members,['dev-1']);
  const read=D.readDraft(storage,'admin','project:new');
  assert.equal(read.values.client,'Тест');
  assert.equal(D.readDraft(storage,'other','project:new'),null);
  assert.equal(D.readDraft(storage,'admin','project:other'),null);
});
test('Empty draft is removed and a real duplicate login is not stored as a secret',()=>{
  const storage=memory();
  assert.equal(D.rememberDraft(storage,'admin','client:new',{name:'  ',phone:'',password:'x'}),null);
  assert.equal(D.readDraft(storage,'admin','client:new'),null);
  D.rememberDraft(storage,'admin','client:new',{name:'Марина',phone:'+79990001122'});
  D.forgetDraft(storage,'admin','client:new');
  assert.equal(D.readDraft(storage,'admin','client:new'),null);
  assert.equal(D.draftIsEmpty({members:[]}),true);
  assert.equal(D.draftIsEmpty({title:'А'}),false);
});
test('Broken draft text does not throw',()=>{
  const storage={getItem:()=>'{',setItem(){},removeItem(){}};
  assert.equal(D.readDraft(storage,'admin','task:new'),null);
});
