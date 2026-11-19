import { hash2 } from '../shared/camp-terrain.mjs';

export function paintWeather(g,climate,time,ratio) {
  if (!climate.rain && !climate.snow) return;
  const {width,height}=g.canvas, snow=climate.snow && !climate.storm;
  const count=climate.storm?86:snow?44:48;
  const speed=snow?24:climate.storm?420:265;
  g.save();
  g.strokeStyle=snow?'#DDE4DE':'#A3BEC1';
  g.fillStyle=g.strokeStyle;
  g.lineWidth=Math.max(1,ratio);
  g.lineCap='round';
  for (let i=0;i<count;i+=1) {
    const seed=i+Math.floor(time*.35)*131;
    const r1=hash2(seed,1,7), r2=hash2(seed,2,7), r3=hash2(seed,3,7);
    const x=((i*271.3+r1*431+time*(snow?9:climate.storm?160:65))*ratio)%(width+40)-20;
    const y=((i*163.7+r2*379+time*speed)*ratio)%(height+40)-20;
    if (snow) {
      g.globalAlpha=.30+r3*.25;
      g.fillRect(Math.round(x),Math.round(y),ratio*(i%3===0?2:1),ratio);
      continue;
    }
    const len=(5+r2*10)*ratio;
    const dx=(2+r3*5)*ratio*(climate.storm?1.4:1);
    g.globalAlpha=(climate.storm?.22:.09)+r3*(climate.storm?.16:.11);
    g.beginPath();g.moveTo(x,y);g.lineTo(x+dx,y+len);g.stroke();
  }
  g.restore();
}

export function campClimate(w) {
  const storm=w.disasterToday==='storm', frost=w.disasterToday==='coldsnap';
  return {storm, frost, drought:Boolean(w.drought), rain:storm || w.weather==='rain',
    snow:frost || (w.season==='冬' && w.weather==='cold'),
    season:['春','夏','秋','冬'].indexOf(w.season)};
}

export function plotWeather(w, beds) {
  // Match the growth rule's water input. These bands only quantize the geometry cache.
  const stormPlot=w.disasterToday==='storm' && w.settlementEvents?.findLast(
    event=>event.kind==='storm_impact' && event.stormDay===w.day)?.plot;
  return beds.map(b=>{
    const water=(w.water??1)+.5*(b.moisture??0);
    const dryness=w.drought ? Math.max(0,Math.min(3,Math.ceil((.55-water)*5))) : 0;
    const windDamage=Boolean(stormPlot && stormPlot.id===b.id && b.growth<=stormPlot.after+.005);
    return {...b,dryness,windDamage};
  });
}

const fract=x=>x-Math.floor(x);
const SPLASH=['#9ABABC','#B3CFCC','#C9E0DC'];
const LEAF=['#788B49','#A99A59','#58744D','#947049'];

function rainImpact(boxes,x,z,y,age,water) {
  const radius=.045+age*(water?.27:.15);
  const width=.033*(1-age*.63);
  // Broken rings on water and a low crown of rebound droplets on hard ground.
  const count=water?4:3;
  for (let i=0;i<count;i++) {
    const angle=i*2*Math.PI/count+age*.6, cx=x+Math.cos(angle)*radius, cz=z+Math.sin(angle)*radius;
    const length=radius*(water?1.13:.77);
    boxes.push({x:cx-length/2,y:y+(water?.014:.045+Math.sin(age*Math.PI)*.16),
      z:cz-width/2,w:length,h:water?.009:width,d:width,color:SPLASH[i%3],
      yaw:angle+Math.PI/2,pivotX:cx,pivotZ:cz});
  }
}

export function stormEffects({active,time,focus,bounds,surface}) {
  if (!active || !focus || time===0) return [];
  const boxes=[], spacing=2.4, range=11;
  const [focusX,focusZ]=focus;
  for (let col=Math.floor((focusX-range)/spacing);col<=Math.floor((focusX+range)/spacing);col++) {
    for (let row=Math.floor((focusZ-range)/spacing);row<=Math.floor((focusZ+range)/spacing);row++) {
      const x=(col+.16+.68*hash2(col,row,75))*spacing, z=(row+.16+.68*hash2(col,row,76))*spacing;
      const inBounds=(px,pz)=>px>bounds.west && px<bounds.east && pz>bounds.north && pz<bounds.south;
      if (!inBounds(x,z) || Math.hypot(x-focusX,z-focusZ)>range) continue;
      const age=fract(time*1.55+hash2(col,row,77));
      if (age<.54) {
        const ground=surface(x,z);
        if (ground) rainImpact(boxes,x,z,ground.y,age/.54,ground.water);
      }
      if (hash2(col,row,78)<.68) continue;
      // Anchor each gust in world space. Each leaf tumbles downstream, close to the ground.
      const flight=fract(time*.73+hash2(col,row,79)), size=.08+.065*hash2(col,row,80);
      if (flight<.08 || flight>.96) continue;
      const lx=x+flight*3.1,lz=z+flight*1.1+Math.sin(flight*7+row)*.26;
      if (!inBounds(lx,lz)) continue;
      const ground=surface(lx,lz);
      if (!ground) continue;
      const ly=ground.y+.23+Math.sin(flight*Math.PI)*(.48+1.3*hash2(col,row,81));
      const pivot=[lx,ly,lz];
      boxes.push({x:lx-size*.5,y:ly,z:lz-size*.28,w:size,h:.026,d:size*.56,
        color:LEAF[Math.floor(hash2(col,row,82)*LEAF.length)],
        rot:[flight*8+col,flight*5,flight*10+row],pivot});
    }
  }
  return boxes;
}
