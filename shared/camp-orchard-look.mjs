export function orchardWeather(world) {
  const day=world.dayInSeason??1;
  const bloom=world.season==='春' ? day<=3?'bud':day<=9?'full':day<=12?'late':null : null;
  return {bloom,storm:world.disasterToday==='storm',frost:world.disasterToday==='coldsnap',drought:world.drought===true};
}

export function orchardAppearance(tree,weather) {
  const mature=tree.mature!==false;
  const health=tree.healthGrade??2;
  const damage=tree.stormDamage??0;
  const bloom=mature && health>0 && !weather.frost ? weather.bloom : null;
  const flowers=bloom==='full'?health===2?9:5:bloom==='bud'?4:bloom==='late'?3:0;
  return {damage,health,bloom,flowers,parched:weather.drought||health===0,
    bent:weather.storm || damage>0,frost:weather.frost};
}
