(function(root){
// Черновик формы живёт только в браузере. Пароль сюда не попадает.
function draftKey(userId, form){
  return 'activprofi-draft:'+String(userId||'')+':'+String(form||'');
}
function isSecret(name){
  return /password|passwd|secret|token/i.test(String(name||''));
}
function scrubDraft(values){
  const out={};
  if(!values||typeof values!=='object')return out;
  for(const [key,value] of Object.entries(values)){
    if(!key||isSecret(key)||String(key).startsWith('staff'))continue;
    if(Array.isArray(value))out[key]=value.map(item=>String(item??'')).filter(Boolean);
    else if(value!=null)out[key]=String(value);
  }
  return out;
}
function draftIsEmpty(values){
  return !Object.values(values||{}).some(value=>Array.isArray(value)?value.length>0:String(value).trim()!=='');
}
function rememberDraft(storage, userId, form, values){
  const clean=scrubDraft(values);
  const key=draftKey(userId, form);
  if(!storage||draftIsEmpty(clean)){
    if(storage)storage.removeItem(key);
    return null;
  }
  const record={form, values:clean, at:new Date().toISOString()};
  storage.setItem(key, JSON.stringify(record));
  return record;
}
function readDraft(storage, userId, form){
  if(!storage)return null;
  let data;
  try{data=JSON.parse(storage.getItem(draftKey(userId, form))||'')}catch{return null}
  if(!data||typeof data.values!=='object'||Array.isArray(data.values))return null;
  data.values=scrubDraft(data.values);
  if(draftIsEmpty(data.values))return null;
  return data;
}
function forgetDraft(storage, userId, form){
  if(storage)storage.removeItem(draftKey(userId, form));
}
const api={draftKey,isSecret,scrubDraft,draftIsEmpty,rememberDraft,readDraft,forgetDraft};
if(typeof module!=='undefined')module.exports=api;
root.CRMDraft=api;
})(globalThis);
