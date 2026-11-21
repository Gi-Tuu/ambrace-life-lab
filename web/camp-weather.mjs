import { hash2 } from '../shared/camp-terrain.mjs';

const unit = (v) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : (v ? 1 : 0)));

// 雨滴/雪花条数：端点与旧的硬切一致（暴雨 86、雨 48、雪 44、无 0）。
// 传连续量时按强度取整，所以跨日那一刻是 0→1→2… 而不是 0→48。
export function weatherDrops(view) {
  const storm = unit(view?.storm), rain = unit(view?.rain), snow = unit(view?.snow);
  return {
    storm: Math.round(86 * storm),
    rain: Math.round(48 * Math.max(0, rain - storm)),
    snow: Math.round(44 * Math.max(0, snow - storm)),
  };
}

// 三条独立的粒子层（雪 / 雨 / 暴风雨），各自按强度缩放条数与透明度。
// 端点公式原样保留：雪 speed 24、雨 speed 265、暴雨 speed 420 + 1.4 倍斜度。
export function paintWeather(g, view, time, ratio) {
  const storm = unit(view?.storm), rain = unit(view?.rain), snow = unit(view?.snow);
  const drops = weatherDrops({ storm, rain, snow });
  if (!drops.storm && !drops.rain && !drops.snow) return;
  const { width, height } = g.canvas;
  g.save();
  g.lineCap = 'round';
  g.lineWidth = Math.max(1, ratio);
  const layer = (count, { stroke = null, fill = null, amount, speed, alpha, slope = 1, fillSnow = false }) => {
    if (!count) return;
    g.strokeStyle = fill ?? stroke; g.fillStyle = fill ?? stroke;
    for (let i = 0; i < count; i += 1) {
      const seed = i + Math.floor(time * .35) * 131;
      const r1 = hash2(seed, 1, 7), r2 = hash2(seed, 2, 7), r3 = hash2(seed, 3, 7);
      const x = ((i * 271.3 + r1 * 431 + time * (fillSnow ? 9 : speed > 300 ? 160 : 65)) * ratio) % (width + 40) - 20;
      const y = ((i * 163.7 + r2 * 379 + time * speed) * ratio) % (height + 40) - 20;
      if (fillSnow) {
        g.globalAlpha = alpha(r3) * amount;
        g.fillRect(Math.round(x), Math.round(y), ratio * (i % 3 === 0 ? 2 : 1), ratio);
        continue;
      }
      const len = (5 + r2 * 10) * ratio, drop = (2 + r3 * 5) * ratio * slope;
      g.globalAlpha = alpha(r3) * amount;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + drop, y + len); g.stroke();
    }
  };
  layer(drops.snow, { fill: '#DDE4DE', amount: Math.max(0, snow - storm), speed: 24, fillSnow: true, alpha: (r3) => .30 + r3 * .25 });
  layer(drops.rain, { stroke: '#A3BEC1', amount: Math.max(0, rain - storm), speed: 265, slope: 1, alpha: (r3) => .09 + r3 * .11 });
  layer(drops.storm, { stroke: '#A3BEC1', amount: storm, speed: 420, slope: 1.4, alpha: (r3) => .22 + r3 * .16 });
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

export function stormEffects({active,time,focus,bounds,surface,intensity=1}) {
  if (!active || !focus || time===0) return [];
  // 强度 0..1：暴雨淡入/淡出时水花与落叶的生成率随强度走，而不是一次铺满视野。
  const strength=Math.max(0,Math.min(1,Number.isFinite(intensity)?intensity:(intensity?1:0)));
  if (strength<=0) return [];
  const boxes=[], spacing=2.4, range=11;
  const [focusX,focusZ]=focus;
  for (let col=Math.floor((focusX-range)/spacing);col<=Math.floor((focusX+range)/spacing);col++) {
    for (let row=Math.floor((focusZ-range)/spacing);row<=Math.floor((focusZ+range)/spacing);row++) {
      const x=(col+.16+.68*hash2(col,row,75))*spacing, z=(row+.16+.68*hash2(col,row,76))*spacing;
      const inBounds=(px,pz)=>px>bounds.west && px<bounds.east && pz>bounds.north && pz<bounds.south;
      if (!inBounds(x,z) || Math.hypot(x-focusX,z-focusZ)>range) continue;
      const age=fract(time*1.55+hash2(col,row,77));
      if (age<.54*strength) {
        const ground=surface(x,z);
        if (ground) rainImpact(boxes,x,z,ground.y,age/Math.max(.001,.54*strength),ground.water);
      }
      if (hash2(col,row,78)<.68*strength) continue;
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
