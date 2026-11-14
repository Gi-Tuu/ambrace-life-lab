const SEASON_DAYLIGHT=[[.14,.75],[.12,.83],[.14,.75],[.18,.64]];
const clamp=(v,min=0,max=1)=>Math.min(max,Math.max(min,v));
const smooth=(a,b,value)=>{
  const t=clamp((value-a)/(b-a));
  return t*t*(3-2*t);
};
const blend=(a,b,t)=>a.map((v,i)=>v+(b[i]-v)*t);

export function solarLight(t,dayTicks,season,{storm=false,overcast=false,indoor=false}={}) {
  const [rise,set]=SEASON_DAYLIGHT[season]??SEASON_DAYLIGHT[0];
  const day=((t%dayTicks)+dayTicks)%dayTicks/dayTicks;
  const daylight=smooth(rise-.085,rise+.075,day)*(1-smooth(set-.075,set+.085,day));
  const dawn=smooth(rise-.083,rise,day)*(1-smooth(rise,rise+.095,day));
  const dusk=smooth(set-.098,set,day)*(1-smooth(set,set+.08,day));
  const weather=storm?.63:overcast?.79:1;
  const sky=blend([.46,.53,.72],[1,1,.98],daylight);
  const warm=blend(blend(sky,[1,.78,.66],dawn*.7),[1,.69,.48],dusk*.79);
  const light=warm.map(v=>v*weather);
  const azimuth=clamp((day-rise)/(set-rise))*Math.PI;
  const elevation=Math.sin(azimuth);
  const altitude=.085+elevation*.94;
  const heading=[Math.cos(azimuth),.34+.18*elevation];
  const bearing=Math.hypot(...heading);
  const sunVector=[heading[0]*Math.cos(altitude)/bearing,Math.sin(altitude),heading[1]*Math.cos(altitude)/bearing];
  const direct=indoor?0:Math.max(daylight*.55,Math.max(dawn,dusk)*.72)*weather;
  return {
    sunVector,direct,
    phase:dawn>.36?'日出':dusk>.36?'日落':daylight>.6?'白昼':'夜晚',
    light:indoor?blend(light,[.68,.66,.61],.42):light,
    direction:[Math.cos(azimuth),Math.sin(azimuth)*.35],
    strength:indoor?0:Math.max(dawn,dusk)*weather*.28,
    dawn,dusk,glow:clamp(1-daylight+(dusk+dawn)*.13),
  };
}
