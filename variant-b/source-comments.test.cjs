const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),M=require('./model.js'),L=require('./leads-model.js');
function fixture(){const box={window:{}};vm.runInNewContext(fs.readFileSync(__dirname+'/seed.js','utf8'),box);return L.upgrade(M.migrate(JSON.parse(JSON.stringify(box.window.BASE_SEED))))}
const opts={name:'База с комментариями',file:'comments.csv',fileDate:'2026-11-17',pipelineId:'outbound',destination:'base',kind:'cold',headerRow:1};

test('Comment-like headers are recognised even when the title is not an exact alias',()=>{
 assert.equal(L.isCommentHeader('Комментарий менеджера'),true);
 assert.equal(L.isCommentHeader('Примечания'),true);
 assert.equal(L.isCommentHeader('Заметки'),true);
 assert.equal(L.isCommentHeader('Итог звонка'),true);
 assert.equal(L.isCommentHeader('Notes'),true);
 assert.equal(L.isCommentHeader('Город'),false);
 assert.equal(L.isCommentHeader('Ссылка на аудиозапись разговора'),false);
 const headers=['Имя','Телефон','Комментарий менеджера','Примечания','Город'];
 const rows=[['Анна Пример','79990001122','Ждёт коммерческое предложение','Уточнить бюджет','Москва']];
 const map=L.mapping(headers,rows);
 assert.equal(map[2],'notes');
 assert.equal(map[3],'');
 assert.equal(map[4],'');
 const row=L.preview(fixture(),headers,rows,map,opts)[0];
 assert.equal(row.status,'ready');
 assert.equal(row.data.sourceComment,'Ждёт коммерческое предложение\nУточнить бюджет');
 assert.ok(row.data.notes.includes('Ждёт коммерческое предложение'));
 assert.ok(row.data.notes.includes('Примечания: Уточнить бюджет'));
 assert.ok(row.data.notes.includes('Город: Москва'));
 assert.equal(row.data.sourceComment.includes('Москва'),false);
});

test('Unmapped comment columns are still stored on the contact and survive a funnel transfer',()=>{
 const s=fixture(),u=s.users[0];
 const headers=['Имя','Телефон','Комментарий менеджера','Примечания','Город'];
 const rows=[['Анна Пример','79990001122','Ждёт коммерческое предложение','Уточнить бюджет','Москва']];
 // Как если бы колонки комментариев не сопоставили вручную с полем «Комментарий».
 const map=['name','phone','','',''];
 const batch=L.commit(s,u,headers,rows,map,opts);
 const client=s.clients.find(c=>c.batchId===batch.id);
 assert.equal(client.sourceComment,'Ждёт коммерческое предложение\nУточнить бюджет');
 assert.equal(client.inLeadBase,true);
 const beforeNotes=client.notes[0];
 const loaded=L.promoteBatch(s,u,batch.id,'outbound','out-2');
 assert.equal(loaded.length,1);
 assert.equal(client.inLeadBase,false);
 assert.equal(client.stageId,'out-2');
 assert.equal(client.sourceComment,'Ждёт коммерческое предложение\nУточнить бюджет');
 assert.ok(client.notes.join('\n').includes('Ждёт коммерческое предложение'));
 assert.ok(client.notes.join('\n').includes('Уточнить бюджет'));
 assert.equal(client.notes[0],beforeNotes);
 assert.equal(M.stage(s,client).name,'Первый контакт');
});

test('Older imported contacts without a dedicated comment field recover it from notes',()=>{
 const s=fixture();
 s.clients.push({id:'old-lead',name:'Старый лид',phone:'79990003344',batchId:'old-batch',inLeadBase:true,notes:['Перезвонить директору','Город: Омск'],pipelineId:'outbound',stageId:'',stageHistory:[]});
 s.leadBatches.push({id:'old-batch',name:'Старая база',pipelineId:'outbound'});
 L.upgrade(s);
 const client=s.clients.find(c=>c.id==='old-lead');
 assert.equal(client.sourceComment,'Перезвонить директору');
 assert.equal(s.clients.find(c=>c.id==='1').sourceComment||'', '');
});

test('Excel cell text keeps rich text, formula results and link captions; trailing columns are not cut off',()=>{
 assert.equal(L.excelValue({richText:[{text:'Ждут '},{text:'КП'}]}),'Ждут КП');
 assert.equal(L.excelValue({formula:'A1',result:'перезвонить'}),'перезвонить');
 assert.equal(L.excelValue({hyperlink:'https://example.test/card',text:'комментарий ссылкой'}),'комментарий ссылкой');
 assert.equal(L.excelValue({text:{richText:[{text:'заметка в подписи'}]}}),'заметка в подписи');
 assert.equal(L.excelValue(new Date('2026-11-17T00:00:00.000Z')),'2026-11-17');
 assert.equal(L.excelNote({texts:[{text:'из примечания ячейки'}]}),'из примечания ячейки');
 const sheet={rowCount:1,columnCount:1,actualRowCount:2,actualColumnCount:1,eachRow(opts,fn){fn({number:2,cellCount:1,eachCell(flag,cb){cb({col:4})}})}};
 assert.deepEqual(L.sheetBounds(sheet),{rows:2,cols:4});
 const merged=L.withCellNotes(['Имя','Телефон'],[['Анна','79990001122']],['Ждёт звонка']);
 assert.deepEqual(merged.headers,['Имя','Телефон','Комментарий ячейки']);
 assert.equal(merged.rows[0][2],'Ждёт звонка');
 assert.equal(L.sourceCommentFrom(merged.headers,merged.rows[0],['name','phone','']),'Ждёт звонка');
 assert.deepEqual(L.withCellNotes(['Имя'],[['Анна']],['']).headers,['Имя']);
});
