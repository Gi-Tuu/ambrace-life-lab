import { campHash } from '../shared/camp-terrain.mjs';

const shirts=['#687E55','#6F8790','#A36E52','#776885','#A28A50','#547F77','#935F60','#56718C'];
const hair=['#423832','#634A36','#2F3030','#78513E','#503D34'];
const skin=['#EDC787','#D6A371','#F2CDA0','#C38F65','#DCAD7F'];
const founders={
  a1:['#4184A0','crop'], a2:['#B77B45','part'], a3:['#6D934F','tie'], p1:['#AB5236','crop'],
};
export function residentLook({id,who,stage,sex,color,hair:hairColor}={}) {
  const key=id??who??'resident';
  const pick=(options,salt)=>options[Math.floor(campHash(759,key+':'+salt)*options.length)];
  const founder=founders[key];
  const style=founder?.[1]??pick(['crop','part','bun','tie'],'hairstyle');
  const coat=pick(['jacket','vest','wrap'],'clothes');
  const tone=pick(['#F1C88F','#D5BC86','#9DBAAB','#E0A78C'],'trim');
  const shirt=color??founder?.[0]??pick(shirts,'shirt');
  const face=founder?'#EDC787':pick(skin,'skin');
  return {
    shirt, face, trim:tone, naturalHair:hairColor??pick(hair,'hair'),
    hair:stage==='elder'?pick(['#C6C0B0','#B3AEA0','#D0C9B6'],'grey'):hairColor??pick(hair,'hair'),
    style, coat, feminine:sex==='F',
  };
}
