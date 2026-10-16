// Bambu Lab PLA catalog. Hex codes are Bambu's published display values; three multi-color spools are approximated.
export const LINES = [
  ['basic','PLA Basic','Basic',19.99,'basic'],
  ['gradient','PLA Basic Gradient','Gradient',24.99,'gradient'],
  ['matte','PLA Matte','Matte',19.99,'matte'],
  ['sparkle','PLA Sparkle','Sparkle',24.99,'sparkle'],
  ['silk','PLA Silk+','Silk+',22.99,'silk'],
  ['silkmulti','PLA Silk Multi-Color','Silk Multi',24.99,'dual'],
  ['metal','PLA Metal','Metal',24.99,'metal'],
  ['galaxy','PLA Galaxy','Galaxy',24.99,'galaxy'],
  ['marble','PLA Marble','Marble',24.99,'marble'],
  ['wood','PLA Wood','Wood',24.99,'wood'],
  ['glow','PLA Glow','Glow',24.99,'glow'],
  ['translucent','PLA Translucent','Translucent',22.99,'translucent'],
  ['tough','PLA Tough+','Tough+',22.99,'basic'],
  ['cf','PLA-CF','PLA-CF',29.99,'cf']
].map(a => ({key:a[0], name:a[1], short:a[2], price:a[3], finish:a[4]}));
export const LINE = {}; LINES.forEach(l => LINE[l.key] = l);
export const COLORS = {
  basic: [['Jade White','#FFFFFF'],['Beige','#F7E6DE'],['Light Gray','#D1D3D5'],['Silver','#A6A9AA'],['Gray','#8E9089'],
    ['Magenta','#EC008C'],['Pink','#F55A74'],['Hot Pink','#F5547C'],['Orange','#FF6A13'],['Pumpkin Orange','#FF9016'],
    ['Gold','#E4BD68'],['Sunflower Yellow','#FEC600'],['Yellow','#F4EE2A'],['Bright Green','#BECF00'],['Bambu Green','#00AE42'],
    ['Mistletoe Green','#3F8E43'],['Bronze','#847D48'],['Cocoa Brown','#6F5034'],['Brown','#9D432C'],['Maroon Red','#9D2235'],
    ['Red','#C12E1F'],['Turquoise','#00B1B7'],['Cyan','#0086D6'],['Blue','#0A2989'],['Cobalt Blue','#0056B8'],
    ['Purple','#5E43B7'],['Indigo Purple','#482960'],['Blue Grey','#5B6579'],['Dark Gray','#545454'],['Black','#000000']],
  gradient: [['Solar Breeze','#E94B3C','#FFFFFF'],['Ocean to Meadow','#307FE2','#54FF9B'],['Dusk Glare','#ED9558','#CE4406'],
    ['Arctic Whisper','#9CDBD9','#FFFFFF'],['Cotton Candy Cloud','#E7C1D5','#8EC9E9'],['Blueberry Bubblegum','#6FCAEF','#8573DD'],
    ['Mint Lime','#B6FF43','#4EC939'],['Pink Citrus','#F78F77','#E4505A']],
  matte: [['Ivory White','#FFFFFF'],['Bone White','#CBC6B8'],['Desert Tan','#E8DBB7'],['Latte Brown','#D3B7A7'],['Caramel','#AE835B'],
    ['Terracotta','#B15533'],['Dark Brown','#7D6556'],['Dark Chocolate','#4D3324'],['Lilac Purple','#AE96D4'],['Sakura Pink','#E8AFCF'],
    ['Mandarin Orange','#F99963'],['Lemon Yellow','#F7D959'],['Plum','#950051'],['Scarlet Red','#DE4343'],['Dark Red','#BB3D43'],
    ['Dark Green','#68724D'],['Grass Green','#61C680'],['Apple Green','#C2E189'],['Ice Blue','#A3D8E1'],['Sky Blue','#56B7E6'],
    ['Marine Blue','#0078BF'],['Dark Blue','#042F56'],['Ash Gray','#9B9EA0'],['Nardo Gray','#757575'],['Charcoal','#000000']],
  sparkle: [['Classic Gold','#CEA629'],['Slate Gray','#8E9089'],['Crimson Red','#792B36'],['Royal Purple','#483D8B'],['Alpine Green','#3F5443'],['Onyx Black','#2D2B28']],
  silk: [['Gold','#F4A925'],['Silver','#C8C8C8'],['Titan Gray','#5F6367'],['Blue','#008BDA'],['Purple','#8671CB'],['Candy Red','#D02727'],
    ['Candy Green','#018814'],['Rose Gold','#BA9594'],['Baby Blue','#A8C6EE'],['Pink','#F7ADA6'],['Mint','#96DCB9'],['Champagne','#F3CFB2'],['White','#FFFFFF']],
  silkmulti: [['Velvet Eclipse','#000000','#A34342'],['Midnight Blaze','#0047BB','#7D1B49'],['Neon City','#0047BB','#BB22A3'],
    ['Gilded Rose','#FF9425','#FCA2BF'],['Blue Hawaii','#60A4E8','#4CE4A0'],['Phantom Blue','#00629B','#000000'],
    ['Aurora Purple','#7F3696','#006EC9',{finish:'gradient'}],
    ['Dawn Radiance','#F7A8C4','#8ED1F5',{finish:'gradient',hex3:'#FFE08A',approx:true}],
    ['South Beach','#5FD3C4','#F49AC1',{finish:'gradient',approx:true}],
    ['Mystic Magenta','#2E8B57','#8B2E8B',{finish:'gradient',approx:true}]],
  metal: [['Iron Gray Metallic','#43403D'],['Cobalt Blue Metallic','#39699E'],['Oxide Green Metallic','#1D7C6A'],['Copper Brown Metallic','#AA6443'],['Iridium Gold Metallic','#B39B84']],
  galaxy: [['Purple','#594177'],['Green','#3B665E'],['Nebulae','#424379'],['Brown','#684A43']],
  marble: [['White Marble','#F7F3F0'],['Red Granite','#AD4E38']],
  wood: [['Black Walnut','#4F3F24'],['Rosewood','#4C241C'],['Clay Brown','#995F11'],['Classic Birch','#918669'],['White Oak','#D6CCA3'],['Ochre Yellow','#C98935']],
  glow: [['Glow Green','#A1FFAC'],['Glow Yellow','#F8FF80'],['Glow Pink','#F17B8F'],['Glow Blue','#7AC0E9'],['Glow Orange','#FF9D5B']],
  translucent: [['Teal','#009FA1'],['Light Jade','#96D8AF'],['Blue','#0047BB'],['Mellow Yellow','#F5DBAB'],['Purple','#8344B0'],
    ['Cherry Pink','#F5B6CD'],['Orange','#F74E02'],['Ice Blue','#B8CDE9'],['Red','#B50011'],['Lavender','#B8ACD6']],
  tough: [['White','#FFFFFF'],['Black','#000000'],['Yellow','#F4D53F']],
  cf: [['Burgundy Red','#951E23'],['Iris Purple','#69398E'],['Matcha Green','#5C9748'],['Jeans Blue','#6E88BC'],['Royal Blue','#2842AD'],['Lava Gray','#4D5054'],['Black','#000000']]
};
export const CATALOG = []; export const CAT = {};
LINES.forEach(line => {
  (COLORS[line.key] || []).forEach(e => {
    const o = Object.assign({key: line.key + '|' + e[0], line: line.key, lineName: line.name, color: e[0], hex: e[1], hex2: e[2] || null, hex3: null, finish: line.finish, approx: false}, e[3] || {});
    CATALOG.push(o); CAT[o.key] = o;
  });
});
