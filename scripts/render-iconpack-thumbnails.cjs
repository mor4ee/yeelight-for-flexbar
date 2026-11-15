// Optional artwork tool: supply sharp to Node. No network or host required.
const sharp = require('sharp');
const fs = require('node:fs/promises');
const path = require('node:path');

async function render(folder, label) {
  const file = path.join(__dirname, '..', 'Icon_Pack', folder, 'Yeelight ' + label + ' Icon Pack.iconpack');
  const pack = JSON.parse(await fs.readFile(file, 'utf8'));
  const icons = Object.values(pack.data).slice(0, 18);
  const width = 3000, height = 152, gap = 15;
  const cell = (width - gap * (icons.length - 1)) / icons.length;
  const layers = await Promise.all(icons.map(async ({src}, index) => {
    const bytes = Buffer.from(src.split(',')[1], 'base64');
    const {data, info} = await sharp(bytes, {density: 144})
      .resize(Math.round(cell), height, {fit: 'inside'}).png().toBuffer({resolveWithObject: true});
    return {input: data, left: Math.round(index * (cell + gap) + (cell-info.width)/2),
      top: Math.round((height-info.height)/2)};
  }));
  const png = await sharp({create: {width, height, channels: 4, background: '#00000000'}})
    .composite(layers).png().toBuffer();
  pack.thumbnail = 'data:image/png;base64,' + png.toString('base64');
  await fs.writeFile(file, JSON.stringify(pack, null, 2) + '\n');
}
Promise.all([render('color', 'Color'), render('full', 'Vector')]).catch(e => {console.error(e);process.exitCode = 1;});
