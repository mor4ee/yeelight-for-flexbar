// Optional artwork build: supply sharp to Node; not needed to build the plugin.
const sharp = require('sharp');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const dir = __dirname;
const icons = Object.values(JSON.parse(readFileSync(join(dir,'../Icon_Pack/color/Yeelight Color Icon Pack.iconpack'))).data);
const type = (x,y,s,t,color='#f3f6f4',weight=400,spacing=0) =>
  `<text x="${x}" y="${y}" fill="${color}" font-family="Segoe UI, sans-serif" font-size="${s}" font-weight="${weight}" letter-spacing="${spacing}">${t}</text>`;
const box = (x,y,w,h,color)=>`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="22" fill="${color}" stroke="#30383e"/>`;
async function main(){
  const bg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="640">
  <rect width="1280" height="640" fill="#07090c"/>
  ${box(18,18,812,454,'#10151a')}${box(844,18,418,186,'#142c26')}${box(844,218,418,254,'#1b1927')}${box(18,486,1244,136,'#15191e')}
  ${type(52,65,18,'FLEXBAR   /   COMMUNITY PLUGIN','#85eaca',650,3)}
  ${type(48,150,83,'Yeelight for Flexbar','#ffffff',700,-3)}
  ${type(52,193,26,'Touch controls for your lights.','#ccd5d9')}
  ${type(872,61,16,'01   /   CONNECTION','#8fe3c6',650,2)}
  ${type(870,118,46,'Local control','#f3fff8',700,-1)}
  ${type(873,158,23,'No cloud account required.','#c6e4d7')}
  ${type(872,260,16,'02   /   ICON PACKS','#cdb3fc',650,2)}
  ${type(870,302,33,'Pick your fixture.','#faf7ff',700,-1)}
  ${type(52,534,16,'03   /   BUILD YOUR STRIP','#87deca',650,2)}
  ${type(50,585,36,'Five independent controls','#ffffff',650,-1)}
  ${type(556,540,24,'On/Off    ·    Brightness    ·    Color temperature','#e6eded',550)}
  ${type(556,581,24,'Hue    ·    Saturation','#e6eded',550)}
  </svg>`);
  // The bezel, controls and their spacing are a single real FlexDesigner capture.
  const stage=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="784" height="250">
  <defs><linearGradient id="surface" x2="1" y2="1" gradientUnits="objectBoundingBox"><stop stop-color="#102c30"/><stop offset=".5" stop-color="#111721"/><stop offset="1" stop-color="#332039"/></linearGradient></defs>
  <rect width="784" height="250" rx="15" fill="url(#surface)"/>
  ${type(24,38,14,'FLEXDESIGNER   /   LAYOUT PREVIEW','#b3c6c9',650,2)}
  ${type(24,224,17,'On/Off    ·    Brightness    ·    Color temperature    ·    Hue    ·    Saturation','#ccd5d9',500)}
  </svg>`);
  const strip=await sharp(join(dir,'flexdesigner-strip.png'))
    .composite([{input:Buffer.from('<svg width="1341" height="68"><rect x="0" y="0" width="1341" height="68" rx="15" fill="white"/></svg>'),blend:'dest-in'}]).png().toBuffer();
  const tilted=await sharp(await sharp(strip).resize(750).png().toBuffer()).rotate(-4,{background:'#00000000'}).png().toBuffer();
  const layers=[{input:await sharp(stage).composite([{input:tilted,left:16,top:78}]).png().toBuffer(),left:32,top:208}];
  for(const [i,n] of ['E27 Bulb (On - Pale Yellow)','Staria Desk Lamp (On - Blue)','LED Strip Coil (On - Green)'].entries()){
    const uri=icons.find(e=>e.name===n).src;
    layers.push({input:await sharp(Buffer.from(uri.split(',')[1],'base64')).resize(133,133).png().toBuffer(),left:850+134*i,top:318});
  }
  await sharp(bg).composite(layers).png().toFile(join(dir,'repository-cover.png'));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
