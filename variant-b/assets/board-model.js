(function(root){
const lists=['notes','assets','objects'];
function anchor(n,side){const w=n.w||210,h=n.h||145;return {x:n.x+(side==='left'?0:side==='right'?w:w/2),y:n.y+(side==='top'?0:side==='bottom'?h:h/2)}}
function connection(b,l){const a=b.notes.find(n=>n.id===l.from),c=b.notes.find(n=>n.id===l.to);if(!a||(!c&&!l.end))return null;return {start:anchor(a,l.fromSide||'right'),end:c?anchor(c,l.toSide||'left'):l.end}}
function bounds(o){if(o.kind==='pen'){const xs=o.points.map(p=>p[0]),ys=o.points.map(p=>p[1]);return {x:o.x+Math.min(...xs),y:o.y+Math.min(...ys),w:Math.max(...xs)-Math.min(...xs),h:Math.max(...ys)-Math.min(...ys)}}if(['arrow','line'].includes(o.kind))return {x:Math.min(o.x,o.x+o.dx),y:Math.min(o.y,o.y+o.dy),w:Math.abs(o.dx),h:Math.abs(o.dy)};return {x:o.x,y:o.y,w:o.width||o.w||210,h:o.h||(o.image?(o.width||480)/o.ratio+60:145)}}
function items(b){return lists.flatMap(k=>(b[k]||[]).map(o=>({list:k,o})))}
function remove(b,ids){for(const k of lists)b[k]=(b[k]||[]).filter(o=>!ids.includes(o.id)||o.locked);const existing=new Set(items(b).map(x=>x.o.id));b.links=(b.links||[]).filter(l=>existing.has(l.from)&&(l.to?existing.has(l.to):!!l.end))}
function move(b,ids,dx,dy){for(const {o} of items(b))if(ids.includes(o.id)&&!o.locked){o.x=Math.max(0,o.x+dx);o.y=Math.max(0,o.y+dy)}}
function duplicate(b,ids,uid){const map=new Map(),groups=new Map();for(const {list,o} of items(b))if(ids.includes(o.id)){const copy=structuredClone(o);copy.id=uid();copy.x+=30;copy.y+=30;copy.locked=false;if(copy.group){if(!groups.has(copy.group))groups.set(copy.group,uid());copy.group=groups.get(copy.group)}if(copy.annotations)for(const n of copy.annotations)n.id=uid();if(list==='assets')copy.fileId=o.fileId||o.id;(b[list]??=[]).push(copy);map.set(o.id,copy.id)}for(const l of [...b.links||[]])if(map.has(l.from)&&map.has(l.to))b.links.push({...l,id:uid(),from:map.get(l.from),to:map.get(l.to)});return [...map.values()]}
function history(){return {past:[],future:[],current:null}}
function record(h,b){const value=JSON.stringify(b);if(h.current===null){h.current=value;return}if(value===h.current)return;h.past.push(h.current);if(h.past.length>60)h.past.shift();h.current=value;h.future=[]}
function travel(h,back){const from=back?h.past:h.future,to=back?h.future:h.past;if(!from.length)return null;to.push(h.current);h.current=from.pop();return JSON.parse(h.current)}
const api={items,remove,move,duplicate,history,record,travel,bounds,anchor,connection};if(typeof module!=='undefined')module.exports=api;root.BoardModel=api;
})(globalThis);
