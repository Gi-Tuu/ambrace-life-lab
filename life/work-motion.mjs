// Presentation receipts live only as long as this world. Never restore old gestures from disk.
const streams = new WeakMap();
export function noteWorkMotion(world,actor,kind,details) {
  if (!world.gameRules && !world.independentWorld) return;
  let stream = streams.get(world);
  if (!stream) streams.set(world,stream={seq:0,rows:[]});
  stream.rows.push({seq:++stream.seq,t:world.t,actor,kind,loc:world.loc?.[actor],...details,
    room:actor==='p1' ? world.campPlayerRoom ?? null : null});
  if (stream.rows.length>48) stream.rows.shift();
}
export function workMotionView(world) {
  return (streams.get(world)?.rows ?? []).filter(row=>world.t-row.t<=2);
}
