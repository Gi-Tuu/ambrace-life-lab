import { actorBoxes, boxVertices } from './camp-3d-render.mjs';

const size=32;
const cache=new Map();
const portraitFaces=[
  {corners:[1,2,6,5],light:.73}, // Right side
  {corners:[3,7,6,2],light:1},   // Front
  {corners:[0,3,2,1],light:1.12},// Top
];
const shade=(color,light)=>'#'+[1,3,5].map(i=>
  Math.min(255,Math.round(parseInt(color.slice(i,i+2),16)*light)).toString(16).padStart(2,'0')).join('');

export function residentPortraitFaces(agent) {
  const {id,stage,sex,injury,dead}=agent;
  const injured=dead?null:injury;
  const center=({infant:.53,child:.74,elder:1.02})[stage]??1.11;
  const lowered=stage==='infant'?0:injured==='critical'?.13:injured?.055:0;
  const scale=stage==='infant'?55:stage==='child'?51:44;
  const view=([x,y,z])=>[Math.round(size/2+(x*.98-z*.22)*scale),
    Math.round(size/2-((y-center+lowered)*.96-z*.19-x*.043)*scale)];
  const boxes=actorBoxes({who:id,portrait:true,stage,sex,injury:injured,
    x:0,y:0,z:0,direction:'down',look:agent.look},0);
  const visible=[];
  for (const box of boxes) {
    if (box.h===0) continue;
    const vertices=boxVertices(box);
    for (const {corners,light} of portraitFaces) {
      const points=corners.map(i=>vertices[i]);
      const depth=points.reduce((sum,[x,y,z])=>sum+x*.22+y*.19+z*.96,0)/4;
      visible.push({points:points.map(view),color:shade(box.color,light*(dead?.65:1)),depth});
    }
  }
  return visible.sort((a,b)=>a.depth-b.depth);
}

export function residentPortrait(agent,look) {
  if (!agent) return '';
  const key=JSON.stringify([agent.id,agent.stage,agent.sex,agent.injury,agent.dead]);
  if (cache.has(key)) return cache.get(key);
  const canvas=document.createElement('canvas');
  canvas.width=size;canvas.height=size;
  const ctx=canvas.getContext('2d');
  if (!ctx) return '';
  ctx.fillStyle='#26362E';
  ctx.fillRect(0,0,size,size);
  for (const {points,color} of residentPortraitFaces({...agent,look})) {
    ctx.fillStyle=color;
    ctx.beginPath();
    ctx.moveTo(...points[0]);
    for (const point of points.slice(1)) ctx.lineTo(...point);
    ctx.closePath();ctx.fill();
  }
  const portrait=canvas.toDataURL('image/png');
  if (cache.size>=160) cache.delete(cache.keys().next().value);
  cache.set(key,portrait);
  return portrait;
}
