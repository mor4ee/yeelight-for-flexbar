// Layout-only composition of existing release icons; optional sharp dependency.
const sharp = require('sharp');
const fs = require('node:fs');
const path = require('node:path');
const pack = (folder, name) => Object.values(JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'Icon_Pack', folder, 'Yeelight '+name+' Icon Pack.iconpack'))).data);
const vector = pack('full', 'Vector'), color = pack('color', 'Color');
const pieces = [], layers = [];
const box = (x,y,w,h,fill,stroke='#34404b',r=24) => pieces.push(
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}"/>`);
const text = (x,y,size,value,fill='#f4f7fa',weight=400,spacing=0) => pieces.push(
  `<text x="${x}" y="${y}" font-family="Segoe UI, sans-serif" font-size="${size}" font-weight="${weight}" letter-spacing="${spacing}" fill="${fill}">${value}</text>`);
async function icon(items, name, x, y, size) {
  const item=items.find(i=>i.name===name);
  if(!item) throw Error('Missing icon: '+name);
  layers.push({input:await sharp(Buffer.from(item.src.split(',')[1],'base64'),{density:180})
    .resize(size,size,{fit:'contain',background:'#00000000'}).png().toBuffer(),left:x,top:y});
}
async function main() {
  box(0,0,1280,740,'#0d1117','none',0);
  box(16,16,1248,118,'#121d24');
  text(44,52,16,'YEELIGHT  /  ICON COLLECTION','#8ee5cd',700,2);
  text(43,104,43,'Your lights. Your look.','#fff',700,-1);
  text(848,69,23,'Two optional packs for Flexbar','#c8d6dd');
  text(848,103,20,'Real artwork from the downloadable packs','#9cabb8');
  box(16,150,470,574,'#19232e');
  box(502,150,762,574,'#211c2c','#40354c');
  text(44,192,16,'01  /  VECTOR ICON PACK','#a8cbed',700,1.7);
  text(42,249,47,'On meets Off.','#fff',700,-1.4);
  text(44,286,24,'30 icons · 15 matching pairs','#c4d4e3');
  box(40,316,422,163,'#203d35','#31584c',18);
  box(40,493,422,163,'#252b35','#3a414b',18);
  text(59,348,16,'ON','#a2e6cb',700,2);
  text(59,525,16,'OFF','#b5c1cd',700,2);
  const vnames=['E27','Staria Pro Desk Lamp','LED Strip Reel','Triangular Light Panels'];
  for(const [j,state] of ['On','Off'].entries())
    for(const [i,n] of vnames.entries()) await icon(vector,`${n} (${state})`,59+i*99,365+j*177,88);
  text(44,696,20,'White artwork. Transparent backgrounds.','#bac9d7');
  text(530,192,16,'02  /  COLOR ICON PACK','#d9baf5',700,1.7);
  text(528,249,47,'Pick your glow.','#fff',700,-1.4);
  text(530,286,24,'84 icons · 14 fixtures · 6 looks per fixture','#d5c8e0');
  box(526,316,714,151,'#292237','#47394f',18);
  const states=['Off','On - Pale Yellow','On - Red','On - Blue','On - Green','On - Multicolor'];
  const labels=['OFF','WARM','RED','BLUE','GREEN','MULTICOLOR'];
  for(const [i,s] of states.entries()) {
    await icon(color,`E27 Bulb (${s})`,537+i*117,328,105);
    text(589+i*117,448,13,labels[i],'#d8cce5',650);
  }
  // Center the six labels without relying on font-specific width estimates.
  for(let i=pieces.length-1;i>=0;i--) {
    if(pieces[i].includes('y="448"')) pieces[i]=pieces[i].replace('<text ','<text text-anchor="middle" ');
  }
  const samples=[['Triangular Light Panels','Multicolor'],['Staria Desk Lamp','Blue'],
    ['LED Strip Coil','Green'],['Linear Pendant','Multicolor'],['Three-Shade Chandelier','Pale Yellow']];
  for(const [i,[n,s]] of samples.entries()) await icon(color,`${n} (On - ${s})`,529+i*142,490,137);
  text(530,662,22,'Bulbs, lamps, panels, pendants and more.','#ece1f2',550);
  text(530,696,20,'Four solid glow colors + Multicolor + Off.','#cbbcd5');
  const svg=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="740">${pieces.join('')}</svg>`);
  await sharp(svg).composite(layers).png().toFile(path.join(__dirname,'icon-packs-preview.png'));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
