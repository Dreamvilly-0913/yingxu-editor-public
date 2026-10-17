/* Independent SDR display-RGB grading. These controls are not a claim about a proprietary algorithm.
   Scalar defaults are exact identities; CPU and WebGL share the same bounded piecewise formulas. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EditorAdvancedColor = api;
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const CHANNELS = Object.freeze(['master', 'red', 'green', 'blue']);
  const BANDS = Object.freeze(['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'magenta']);
  const CENTERS = Object.freeze([0, 1 / 12, 1 / 6, 1 / 3, 1 / 2, 2 / 3, 3 / 4, 5 / 6]);
  const SCALARS = Object.freeze(['exposureEV', 'temperature', 'tint', 'highlights', 'shadows', 'whites', 'blacks']);
  const MAX_CURVE_POINTS = 16;
  const clamp = x => Math.max(0, Math.min(1, x));
  const fract = x => x - Math.floor(x);
  function object(v, label) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(label + '必须是普通对象');
    const prototype = Object.getPrototypeOf(v);
    // Other JS realms have their own Object.prototype; accept ordinary JSON-shaped objects.
    if (prototype !== null && Object.getPrototypeOf(prototype) !== null) throw new Error(label + '必须是普通对象');
  }
  function keys(v, allowed, label) { for (const key of Object.keys(v)) if (!allowed.includes(key)) throw new Error(label + '包含未知字段：' + key); }
  function bounded(v, lo, hi, label) { if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw new Error(label + '必须是 ' + lo + ' 至 ' + hi + ' 的有限数值'); }
  function validate(input) {
    if (input === undefined || input === null) { if (input === null) throw new Error('高级调色必须是对象'); return true; }
    object(input, '高级调色'); keys(input, SCALARS.concat(['curves', 'hsl', 'professional']), '高级调色');
    for (const key of SCALARS) if (input[key] !== undefined) bounded(input[key], key === 'exposureEV' ? -4 : -1, key === 'exposureEV' ? 4 : 1, key);
    if (input.curves !== undefined) {
      object(input.curves, '调色曲线'); keys(input.curves, CHANNELS, '调色曲线');
      for (const channel of CHANNELS) {
        const points = input.curves[channel]; if (points === undefined) continue;
        if (!Array.isArray(points) || points.length < 2 || points.length > MAX_CURVE_POINTS) throw new Error('每条调色曲线需要 2 至 16 个点');
        for (let i = 0; i < points.length; i++) {
          if (!Array.isArray(points[i]) || points[i].length !== 2) throw new Error('调色曲线点必须是 [x,y]');
          bounded(points[i][0], 0, 1, '曲线横坐标'); bounded(points[i][1], 0, 1, '曲线纵坐标');
          if (i && points[i][0] - points[i - 1][0] < 1e-5) throw new Error('调色曲线横坐标必须严格递增，间隔至少 0.00001');
        }
        if (points[0][0] !== 0 || points[points.length - 1][0] !== 1) throw new Error('调色曲线横坐标必须从 0 开始、在 1 结束');
      }
    }
    if (input.hsl !== undefined) {
      object(input.hsl, 'HSL'); keys(input.hsl, BANDS, 'HSL');
      for (const band of BANDS) if (input.hsl[band] !== undefined) {
        object(input.hsl[band], band + ' HSL'); keys(input.hsl[band], ['hue', 'saturation', 'luminance'], band + ' HSL');
        for (const key of ['hue', 'saturation', 'luminance']) if (input.hsl[band][key] !== undefined) bounded(input.hsl[band][key], -1, 1, band + ' ' + key);
      }
    }
    if (input.professional !== undefined) validateProfessional(input.professional);
    return true;
  }
  function defaults() {
    const value = Object.fromEntries(SCALARS.map(key => [key, 0]));
    value.curves = Object.fromEntries(CHANNELS.map(key => [key, [[0, 0], [1, 1]]]));
    value.hsl = Object.fromEntries(BANDS.map(key => [key, { hue: 0, saturation: 0, luminance: 0 }]));
    return value;
  }
  function normalize(input) {
    validate(input); const value = defaults(); if (!input) return value;
    for (const key of SCALARS) if (input[key] !== undefined) value[key] = input[key];
    for (const key of CHANNELS) if (input.curves && input.curves[key] !== undefined) value.curves[key] = input.curves[key].map(p => p.slice());
    for (const key of BANDS) if (input.hsl && input.hsl[key] !== undefined) Object.assign(value.hsl[key], input.hsl[key]);
    if (input.professional !== undefined) value.professional = normalizeProfessional(input.professional);
    return value;
  }
  function normalizedIdentity(value) {
    return professionalIdentity(value.professional) && SCALARS.every(k => value[k] === 0) && CHANNELS.every(k => value.curves[k].every(p => p[0] === p[1])) && BANDS.every(k => Object.values(value.hsl[k]).every(x => x === 0));
  }
  function isIdentity(input) { return normalizedIdentity(normalize(input)); }
  function curve(x, points) {
    x = clamp(x);
    for (let i = 1; i < points.length; i++) if (x <= points[i][0]) {
      const a = points[i - 1], b = points[i]; return a[1] + (b[1] - a[1]) * ((x - a[0]) / (b[0] - a[0]));
    }
    return points[points.length - 1][1];
  }
  function decode(x) { return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }
  function encode(x) { return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055; }
  function rgbToHsl(rgb) {
    const hi = Math.max(...rgb), lo = Math.min(...rgb), d = hi - lo, l = (hi + lo) / 2;
    if (d < 1e-10) return [0, 0, l];
    const s = d / Math.max(1e-10, 1 - Math.abs(2 * l - 1));
    let h = hi === rgb[0] ? (rgb[1] - rgb[2]) / d + (rgb[1] < rgb[2] ? 6 : 0) : hi === rgb[1] ? (rgb[2] - rgb[0]) / d + 2 : (rgb[0] - rgb[1]) / d + 4;
    return [h / 6, s, l];
  }
  function hslToRgb(h, s, l) {
    const c = (1 - Math.abs(2 * l - 1)) * s, m = l - c / 2;
    return [0, 2 / 3, 1 / 3].map(offset => m + c * clamp(Math.abs(fract(h + offset) * 6 - 3) - 1));
  }
  function createProcessor(input) {
    const a = normalize(input);
    if (normalizedIdentity(a)) return rgb => rgb.slice();
    const whiteBalance = a.exposureEV !== 0 || a.temperature !== 0 || a.tint !== 0;
    const gains = [Math.pow(2, a.exposureEV + .35 * a.temperature + .1 * a.tint), Math.pow(2, a.exposureEV - .2 * a.tint), Math.pow(2, a.exposureEV - .35 * a.temperature + .1 * a.tint)];
    const tonal = a.highlights !== 0 || a.shadows !== 0 || a.whites !== 0 || a.blacks !== 0;
    const curved = CHANNELS.some(k => a.curves[k].some(p => p[0] !== p[1]));
    const professional = createProfessionalProcessor(a.professional);
    const hue = BANDS.some(k => Object.values(a.hsl[k]).some(x => x !== 0));
    return function (rgb) {
      let out = rgb.slice();
      if (whiteBalance) out = out.map((x, k) => encode(clamp(decode(clamp(x)) * gains[k])));
      if (tonal) {
        const l = out[0] * .2126 + out[1] * .7152 + out[2] * .0722, dark = 1 - l;
        const delta = .35 * (a.shadows * dark * dark + a.highlights * l * l) + .25 * (a.blacks * Math.pow(dark, 6) + a.whites * Math.pow(l, 6));
        out = out.map(x => clamp(x + delta));
      }
      if (curved) out = out.map((x, i) => curve(curve(x, a.curves.master), a.curves[CHANNELS[i + 1]]));
      if (hue) {
        const hsl = rgbToHsl(out), gate = Math.min(1, hsl[1] * 8), delta = [0, 0, 0];
        for (let i = 0; i < BANDS.length; i++) {
          const distance = Math.min(Math.abs(hsl[0] - CENTERS[i]), 1 - Math.abs(hsl[0] - CENTERS[i]));
          let w = clamp(1 - distance * 6); w = w * w * (3 - 2 * w);
          const band = a.hsl[BANDS[i]]; delta[0] += w * band.hue; delta[1] += w * band.saturation; delta[2] += w * band.luminance;
        }
        if (delta.some(x => x !== 0)) out = hslToRgb(fract(hsl[0] + delta[0] * gate / 12), clamp(hsl[1] * (1 + delta[1] * gate)), clamp(hsl[2] + .25 * delta[2] * gate));
      }
      return professional(out.map(clamp));
    };
  }
  function adjustRgb(rgb, input) { return createProcessor(input)(rgb); }

  // Versioned, independent professional SDR controls. Legacy controls run first.
  const PROFESSIONAL_CHANNELS = Object.freeze(['master','red','green','blue','luma']);
  const WHEELS = Object.freeze(['lift','gamma','gain','offset']);
  const BALANCES = Object.freeze(['shadows','midtones','highlights']);
  const clone = value => JSON.parse(JSON.stringify(value));
  function vector(value, lo, hi, label) {
    if (!Array.isArray(value) || value.length !== 3) throw new Error(label+'必须是 RGB 三元组');
    value.forEach(v=>bounded(v,lo,hi,label));
  }
  function interval(value,label) {
    if (!Array.isArray(value) || value.length!==2) throw new Error(label+'需要两个端点');
    value.forEach(v=>bounded(v,0,1,label)); if(value[0]>=value[1])throw new Error(label+'下限必须小于上限');
  }
  function validateBezier(points) {
    if(!Array.isArray(points)||points.length<2||points.length>16)throw new Error('Bezier 曲线需要 2 至 16 个锚点');
    points.forEach((p,i)=>{object(p,'Bezier 点');keys(p,['x','y','in','out'],'Bezier 点');bounded(p.x,0,1,'Bezier x');bounded(p.y,0,1,'Bezier y');
      if(i&&p.x-points[i-1].x<.00001)throw new Error('Bezier 锚点横坐标必须严格递增');
      for(const name of ['in','out'])if(p[name]!==undefined){if(!Array.isArray(p[name])||p[name].length!==2)throw new Error('Bezier 控制柄必须是 [x,y]');p[name].forEach(v=>bounded(v,0,1,'Bezier 控制柄'));}
    });
    if(points[0].x!==0||points.at(-1).x!==1)throw new Error('Bezier 曲线必须从 0 到 1');
    for(let i=1;i<points.length;i++){const a=points[i-1],b=points[i],x1=a.out?a.out[0]:a.x+(b.x-a.x)/3,x2=b.in?b.in[0]:b.x-(b.x-a.x)/3;
      if(x1<a.x||x1>x2||x2>b.x)throw new Error('Bezier 控制柄横坐标必须在相邻锚点之间且不可交叉');}
    return true;
  }
  function validateLut(lut) {
    object(lut,'LUT');keys(lut,['dimension','size','data','domainMin','domainMax','intensity','title'],'LUT');
    if(![1,3].includes(lut.dimension))throw new Error('LUT 维度必须为 1 或 3');
    const limit=lut.dimension===1?4096:65;
    if(!Number.isInteger(lut.size)||lut.size<2||lut.size>limit)throw new Error('LUT 尺寸超出支持范围');
    const count=3*Math.pow(lut.size,lut.dimension);
    if(!Array.isArray(lut.data)||lut.data.length!==count)throw new Error('LUT 数据条数与尺寸不一致');
    lut.data.forEach(v=>bounded(v,-16,16,'LUT 输出值'));
    vector(lut.domainMin, -16,16,'LUT 输入下限');vector(lut.domainMax,-16,16,'LUT 输入上限');
    for(let k=0;k<3;k++)if(lut.domainMax[k]<=lut.domainMin[k])throw new Error('LUT 输入范围必须递增');
    if(lut.intensity!==undefined)bounded(lut.intensity,0,1,'LUT 强度');
    if(lut.title!==undefined&&(typeof lut.title!=='string'||lut.title.length>256))throw new Error('LUT 标题过长');
    return true;
  }
  function professionalDefaults() {
    return {bezier:Object.fromEntries(PROFESSIONAL_CHANNELS.map(k=>[k,[{x:0,y:0},{x:1,y:1}]])),
      wheels:Object.fromEntries(WHEELS.map(k=>[k,[0,0,0]])),
      balance:{shadows:[0,0,0],midtones:[0,0,0],highlights:[0,0,0],shadowRange:[0,.4],highlightRange:[.6,1]},
      hsl6:{hue:0,saturation:0,luminance:0,hueRange:[0,1],saturationRange:[0,1],luminanceRange:[0,1],softness:.1}};
  }
  function validateProfessional(p) {
    object(p,'专业调色');keys(p,['bezier','wheels','balance','hsl6','lut'],'专业调色');
    if(p.bezier!==undefined){object(p.bezier,'Bezier 曲线');keys(p.bezier,PROFESSIONAL_CHANNELS,'Bezier 曲线');for(const v of Object.values(p.bezier))validateBezier(v);}
    if(p.wheels!==undefined){object(p.wheels,'色轮');keys(p.wheels,WHEELS,'色轮');for(const v of Object.values(p.wheels))vector(v,-1,1,'色轮');}
    if(p.balance!==undefined){object(p.balance,'分区色彩');keys(p.balance,BALANCES.concat(['shadowRange','highlightRange']),'分区色彩');
      for(const key of BALANCES)if(p.balance[key]!==undefined)vector(p.balance[key],-1,1,'分区色彩');
      for(const key of ['shadowRange','highlightRange'])if(p.balance[key]!==undefined)interval(p.balance[key],'分区范围');
      const shadow=p.balance.shadowRange||[0,.4],highlight=p.balance.highlightRange||[.6,1];if(shadow[1]>highlight[0])throw new Error('阴影与高光分区不能交叉');}
    if(p.hsl6!==undefined){object(p.hsl6,'六维 HSL');keys(p.hsl6,['hue','saturation','luminance','hueRange','saturationRange','luminanceRange','softness'],'六维 HSL');
      for(const key of ['hue','saturation','luminance'])if(p.hsl6[key]!==undefined)bounded(p.hsl6[key],-1,1,'HSL 调整');
      for(const key of ['hueRange','saturationRange','luminanceRange'])if(p.hsl6[key]!==undefined)interval(p.hsl6[key],'HSL 选区');
      if(p.hsl6.softness!==undefined)bounded(p.hsl6.softness,0,.5,'HSL 柔化');}
    if(p.lut!==undefined)validateLut(p.lut); return true;
  }
  function normalizeProfessional(input) {
    if(input===undefined)return professionalDefaults();validateProfessional(input);const p=professionalDefaults();
    for(const key of ['bezier','wheels','balance','hsl6'])if(input[key])Object.assign(p[key],clone(input[key]));
    if(input.lut)p.lut=clone(input.lut);return p;
  }
  function bezierAt(x,points) {
    x=clamp(x);let i=1;while(i<points.length-1&&x>points[i].x)i++;
    const a=points[i-1],b=points[i],dx=(b.x-a.x)/3,dy=(b.y-a.y)/3,c=a.out||[a.x+dx,a.y+dy],d=b.in||[b.x-dx,b.y-dy];
    const at=(p0,p1,p2,p3,t)=>{const u=1-t;return u*u*u*p0+3*u*u*t*p1+3*u*t*t*p2+t*t*t*p3;};
    let lo=0,hi=1;for(let j=0;j<25;j++){const t=(lo+hi)/2;if(at(a.x,c[0],d[0],b.x,t)<x)lo=t;else hi=t;}
    return clamp(at(a.y,c[1],d[1],b.y,(lo+hi)/2));
  }
  function bezierIdentity(points) {
    return points.every(p=>p.x===p.y&&(!p.in||p.in[0]===p.in[1])&&(!p.out||p.out[0]===p.out[1]));
  }
  function professionalIdentity(input) {
    if(!input)return true;const p=normalizeProfessional(input);
    return PROFESSIONAL_CHANNELS.every(k=>bezierIdentity(p.bezier[k]))&&WHEELS.every(k=>p.wheels[k].every(v=>v===0))&&BALANCES.every(k=>p.balance[k].every(v=>v===0))&&['hue','saturation','luminance'].every(k=>p.hsl6[k]===0)&&(!p.lut||p.lut.intensity===0);
  }
  function lutProcessor(lut) {
    if(!lut||lut.intensity===0)return rgb=>rgb;
    const n=lut.size-1,amount=lut.intensity===undefined?1:lut.intensity,data=lut.data;
    return rgb=>{
      const pos=rgb.map((v,i)=>clamp((v-lut.domainMin[i])/(lut.domainMax[i]-lut.domainMin[i]))*n),base=pos.map(Math.floor),frac=pos.map((v,i)=>v-base[i]);let out=[0,0,0];
      if(lut.dimension===1){out=pos.map((v,k)=>{const i=base[k],j=Math.min(n,i+1);return data[i*3+k]*(1-frac[k])+data[j*3+k]*frac[k];});}
      else for(let b=0;b<=1;b++)for(let g=0;g<=1;g++)for(let r=0;r<=1;r++){
        const index=(Math.min(n,base[2]+b)*lut.size*lut.size+Math.min(n,base[1]+g)*lut.size+Math.min(n,base[0]+r))*3,
          weight=(r?frac[0]:1-frac[0])*(g?frac[1]:1-frac[1])*(b?frac[2]:1-frac[2]);
        for(let k=0;k<3;k++)out[k]+=data[index+k]*weight;
      }
      return out.map((v,i)=>clamp(rgb[i]+(v-rgb[i])*amount));
    };
  }
  function createProfessionalProcessor(input) {
    if(professionalIdentity(input))return rgb=>rgb;
    const p=normalizeProfessional(input),w=p.wheels,balance=p.balance,h=p.hsl6,lut=lutProcessor(p.lut);
    const wheels=WHEELS.some(k=>w[k].some(v=>v!==0)),split=BALANCES.some(k=>balance[k].some(v=>v!==0)),hsl=['hue','saturation','luminance'].some(k=>h[k]!==0);
    const tables=Object.fromEntries(PROFESSIONAL_CHANNELS.map(k=>{if(bezierIdentity(p.bezier[k]))return[k,null];return[k,Float64Array.from({length:4097},(_,i)=>bezierAt(i/4096,p.bezier[k]))];}));
    const mapped=(v,k)=>{const table=tables[k];if(!table)return v;const x=clamp(v)*4096,i=Math.floor(x);return table[i]+(table[Math.min(4096,i+1)]-table[i])*(x-i);};
    const smooth=(a,b,v)=>{const t=clamp((v-a)/(b-a));return t*t*(3-2*t);};
    const gate=(v,range,softness,wrap=false)=>{if(range[0]===0&&range[1]===1)return 1;const score=x=>softness? smooth(range[0]-softness,range[0],x)*(1-smooth(range[1],range[1]+softness,x)):(x>=range[0]&&x<=range[1]?1:0);return wrap?Math.max(score(v),score(v-1),score(v+1)):score(v);};
    return rgb=>{
      let out=rgb.slice();
      if(wheels)out=out.map((x,k)=>{x=clamp(x+w.lift[k]*.25*(1-x)+w.offset[k]*.25);x=Math.pow(x,Math.pow(2,-w.gamma[k]));return clamp(x*Math.pow(2,w.gain[k]));});
      if(split){const y=out[0]*.2126+out[1]*.7152+out[2]*.0722,s=1-smooth(...balance.shadowRange,y),hi=smooth(...balance.highlightRange,y),m=Math.max(0,1-s-hi);out=out.map((v,k)=>clamp(v+.25*(balance.shadows[k]*s+balance.midtones[k]*m+balance.highlights[k]*hi)));}
      out=out.map((v,k)=>mapped(mapped(v,'master'),PROFESSIONAL_CHANNELS[k+1]));
      if(tables.luma){const y=out[0]*.2126+out[1]*.7152+out[2]*.0722,delta=mapped(y,'luma')-y;out=out.map(v=>clamp(v+delta));}
      if(hsl){const [hue,sat,lum]=rgbToHsl(out),weight=gate(hue,h.hueRange,h.softness,true)*gate(sat,h.saturationRange,h.softness)*gate(lum,h.luminanceRange,h.softness)*Math.min(1,sat*8);if(weight>0)out=hslToRgb(fract(hue+h.hue*weight/2),clamp(sat*(1+h.saturation*weight)),clamp(lum+h.luminance*weight*.5));}
      return lut(out);
    };
  }
  function parseCube(text,options={}) {
    if(typeof text!=='string'||text.length>24*1024*1024)throw new Error('LUT 文件必须为不超过 24 MiB 的文本');
    let dimension,size,title=String(options.title||'').slice(0,256),domainMin=[0,0,0],domainMax=[1,1,1],data=[];
    for(const raw of text.replace(/^\uFEFF/,'').split(/\r?\n/)){
      const titleLine=raw.trim().startsWith('TITLE ');const line=titleLine?raw.trim().replace(/("\s*)#.*/, '$1').trim():raw.replace(/#.*/,'').trim();if(!line)continue;const tokens=line.split(/\s+/),key=tokens[0];
      if(key==='TITLE'){const match=line.match(/^TITLE\s+"(.*)"$/);if(!match)throw new Error('LUT TITLE 格式无效');title=match[1].slice(0,256);continue;}
      if(key==='LUT_3D_SIZE'||key==='LUT_1D_SIZE'){if(dimension!==undefined)throw new Error('不支持组合式 1D + 3D LUT，请分别导入');dimension=key==='LUT_3D_SIZE'?3:1;size=Number(tokens[1]);if(tokens.length!==2||!Number.isInteger(size)||size<2||size>(dimension===3?65:4096))throw new Error('LUT 尺寸超出范围');continue;}
      if(key==='DOMAIN_MIN'||key==='DOMAIN_MAX'){if(tokens.length!==4)throw new Error('LUT 输入范围格式无效');const v=tokens.slice(1).map(Number);if(key==='DOMAIN_MIN')domainMin=v;else domainMax=v;continue;}
      if(tokens.length!==3||tokens.some(t=>t===''||!Number.isFinite(Number(t))))throw new Error('LUT 包含不支持的指令或无效数据：'+key.slice(0,40));
      if(dimension===undefined)throw new Error('LUT 必须先声明尺寸');data.push(...tokens.map(Number));if(data.length>3*Math.pow(size,dimension))throw new Error('LUT 数据行过多');
    }
    if(dimension===undefined)throw new Error('未找到 LUT_3D_SIZE 或 LUT_1D_SIZE');
    const result={dimension,size,data,domainMin,domainMax,intensity:1,title};validateLut(result);return result;
  }

  const glslSource = `
  uniform float advancedEnabled; uniform vec3 advancedGains; uniform vec4 advancedTone;
  uniform vec2 advancedMaster[16]; uniform vec2 advancedRed[16]; uniform vec2 advancedGreen[16]; uniform vec2 advancedBlue[16];
  uniform ivec4 advancedCurveCounts; uniform vec3 advancedHsl[8]; uniform vec3 advancedStages;
  float gradeDecode(float x){return x<=.04045?x/12.92:pow((x+.055)/1.055,2.4);}
  float gradeEncode(float x){return x<=.0031308?x*12.92:1.055*pow(x,1./2.4)-.055;}
  ` + CHANNELS.map((name, channel) => {
    const title = name[0].toUpperCase() + name.slice(1), component = ['x', 'y', 'z', 'w'][channel];
    return `float grade${title}(float x){x=clamp(x,0.,1.);for(int i=1;i<16;i++){if(i<advancedCurveCounts.${component} && x<=advanced${title}[i].x){vec2 a=advanced${title}[i-1],b=advanced${title}[i];return mix(a.y,b.y,(x-a.x)/(b.x-a.x));}}return advanced${title}[15].y;}`;
  }).join('\n') + `
  vec3 gradeHsl(vec3 c){float hi=max(c.r,max(c.g,c.b)),lo=min(c.r,min(c.g,c.b)),d=hi-lo,l=(hi+lo)*.5;
    if(d<.0000000001)return vec3(0.,0.,l);float s=d/max(.0000000001,1.-abs(2.*l-1.));float h;
    if(hi==c.r)h=(c.g-c.b)/d+(c.g<c.b?6.:0.);else if(hi==c.g)h=(c.b-c.r)/d+2.;else h=(c.r-c.g)/d+4.;return vec3(h/6.,s,l);}
  vec3 gradeRgb(vec3 hsl){float c=(1.-abs(2.*hsl.z-1.))*hsl.y,m=hsl.z-c*.5;
    return vec3(m)+c*clamp(abs(fract(vec3(hsl.x)+vec3(0.,2./3.,1./3.))*6.-3.)-1.,0.,1.);}
  vec3 advancedRgb(vec3 rgb){
    if(advancedEnabled<.5)return rgb;
    if(advancedStages.x>.5){vec3 linear=vec3(gradeDecode(rgb.r),gradeDecode(rgb.g),gradeDecode(rgb.b));linear=clamp(linear*advancedGains,0.,1.);rgb=vec3(gradeEncode(linear.r),gradeEncode(linear.g),gradeEncode(linear.b));}
    if(advancedStages.y>.5){float l=dot(rgb,vec3(.2126,.7152,.0722)),dark=1.-l;
      float delta=.35*(advancedTone.y*dark*dark+advancedTone.x*l*l)+.25*(advancedTone.w*pow(dark,6.)+advancedTone.z*pow(l,6.));rgb=clamp(rgb+vec3(delta),0.,1.);}
    if(advancedStages.z>.5)rgb=vec3(gradeRed(gradeMaster(rgb.r)),gradeGreen(gradeMaster(rgb.g)),gradeBlue(gradeMaster(rgb.b)));
    vec3 hsl=gradeHsl(rgb),delta=vec3(0.);float gate=min(1.,hsl.y*8.);
    ` + CENTERS.map((center, i) => `{float d=abs(hsl.x-${center.toFixed(12)});float w=clamp(1.-min(d,1.-d)*6.,0.,1.);w=w*w*(3.-2.*w);delta+=advancedHsl[${i}]*w;}`).join('\n') + `
    if(any(notEqual(delta,vec3(0.))))rgb=gradeRgb(vec3(fract(hsl.x+delta.x*gate/12.),clamp(hsl.y*(1.+delta.y*gate),0.,1.),clamp(hsl.z+.25*delta.z*gate,0.,1.)));
    return clamp(rgb,0.,1.);
  }`;

  const professionalGlslSource = `
    uniform sampler2D professionalLut;uniform vec3 professionalLutGeometry;uniform float professionalEnabled;
    vec3 professionalCorner(vec3 p){float n=professionalLutGeometry.x,tiles=professionalLutGeometry.y;
      p=min(p,vec3(n-1.));vec2 pixel=vec2(mod(p.b,tiles)*n+p.r+.5,floor(p.b/tiles)*n+p.g+.5);
      return texture2D(professionalLut,pixel/vec2(n*tiles,n*professionalLutGeometry.z)).rgb;}
    vec3 professionalRgb(vec3 rgb){if(professionalEnabled<.5)return rgb;vec3 p=clamp(rgb,0.,1.)*(professionalLutGeometry.x-1.),base=floor(p),f=p-base,c0=professionalCorner(base),c1=professionalCorner(base+vec3(1.)),a,b;
      if(f.r>=f.g){if(f.g>=f.b){a=professionalCorner(base+vec3(1.,0.,0.));b=professionalCorner(base+vec3(1.,1.,0.));return c0+f.r*(a-c0)+f.g*(b-a)+f.b*(c1-b);}
        if(f.r>=f.b){a=professionalCorner(base+vec3(1.,0.,0.));b=professionalCorner(base+vec3(1.,0.,1.));return c0+f.r*(a-c0)+f.b*(b-a)+f.g*(c1-b);}
        a=professionalCorner(base+vec3(0.,0.,1.));b=professionalCorner(base+vec3(1.,0.,1.));return c0+f.b*(a-c0)+f.r*(b-a)+f.g*(c1-b);}
      if(f.b>=f.g){a=professionalCorner(base+vec3(0.,0.,1.));b=professionalCorner(base+vec3(0.,1.,1.));return c0+f.b*(a-c0)+f.g*(b-a)+f.r*(c1-b);}
      if(f.b>=f.r){a=professionalCorner(base+vec3(0.,1.,0.));b=professionalCorner(base+vec3(0.,1.,1.));return c0+f.g*(a-c0)+f.b*(b-a)+f.r*(c1-b);}
      a=professionalCorner(base+vec3(0.,1.,0.));b=professionalCorner(base+vec3(1.,1.,0.));return c0+f.g*(a-c0)+f.r*(b-a)+f.b*(c1-b);}

  `;
  const professionalPrograms=new WeakMap(),professionalInputs=new WeakMap();
  function setProfessionalUniforms(gl,program,input) {
    let state=professionalPrograms.get(program);
    if(!state){state={texture:gl.createTexture(),signature:null,enabled:gl.getUniformLocation(program,'professionalEnabled'),sampler:gl.getUniformLocation(program,'professionalLut'),geometry:gl.getUniformLocation(program,'professionalLutGeometry')};professionalPrograms.set(program,state);}
    const source=input&&input.professional;
    if(!source){gl.uniform1f(state.enabled,0);return;}
    let record=professionalInputs.get(source);
    if(!record){record={identity:professionalIdentity(source)};if(!record.identity)record.signature=JSON.stringify(source);professionalInputs.set(source,record);}
    if(record.identity){gl.uniform1f(state.enabled,0);return;}
    gl.uniform1f(state.enabled,1);gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,state.texture);
    const n=65,tiles=8,rows=Math.ceil(n/tiles);
    if(state.signature!==record.signature){
      const processor=createProfessionalProcessor(source),data=new Uint8Array(n*tiles*n*rows*4);
      for(let b=0;b<n;b++)for(let g=0;g<n;g++)for(let r=0;r<n;r++){
        const rgb=processor([r/(n-1),g/(n-1),b/(n-1)]),at=((Math.floor(b/tiles)*n+g)*(tiles*n)+(b%tiles)*n+r)*4;
        for(let k=0;k<3;k++)data[at+k]=Math.round(clamp(rgb[k])*255);data[at+3]=255;
      }
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,tiles*n,rows*n,0,gl.RGBA,gl.UNSIGNED_BYTE,data);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      state.signature=record.signature;
    }
    gl.uniform1i(state.sampler,1);gl.uniform3f(state.geometry,n,tiles,rows);gl.activeTexture(gl.TEXTURE0);
  }

  const locations = new WeakMap();
  function setUniforms(gl, program, input) {
    // Professional LUTs may embed 65³ data; legacy uniforms never need to clone/validate that data on each frame.
    const legacy=input&&input.professional?Object.fromEntries(Object.entries(input).filter(([key])=>key!=='professional')):input;
    const a = normalize(legacy); let uniforms = locations.get(program);
    if (!uniforms) { uniforms = {}; for (const name of ['advancedEnabled', 'advancedGains', 'advancedTone', 'advancedCurveCounts', 'advancedStages', 'advancedMaster[0]', 'advancedRed[0]', 'advancedGreen[0]', 'advancedBlue[0]', 'advancedHsl[0]']) uniforms[name] = gl.getUniformLocation(program, name); locations.set(program, uniforms); }
    gl.uniform1f(uniforms.advancedEnabled, normalizedIdentity(a) ? 0 : 1);
    gl.uniform3f(uniforms.advancedGains, Math.pow(2, a.exposureEV + .35 * a.temperature + .1 * a.tint), Math.pow(2, a.exposureEV - .2 * a.tint), Math.pow(2, a.exposureEV - .35 * a.temperature + .1 * a.tint));
    gl.uniform4f(uniforms.advancedTone, a.highlights, a.shadows, a.whites, a.blacks);
    gl.uniform3f(uniforms.advancedStages, a.exposureEV || a.temperature || a.tint ? 1 : 0, a.highlights || a.shadows || a.whites || a.blacks ? 1 : 0, CHANNELS.some(k => a.curves[k].some(p => p[0] !== p[1])) ? 1 : 0);
    gl.uniform4iv(uniforms.advancedCurveCounts, new Int32Array(CHANNELS.map(k => a.curves[k].length)));
    for (const name of CHANNELS) {
      const points = a.curves[name], packed = []; for (let i = 0; i < 16; i++) packed.push(...points[Math.min(i, points.length - 1)]);
      gl.uniform2fv(uniforms['advanced' + name[0].toUpperCase() + name.slice(1) + '[0]'], new Float32Array(packed));
    }
    gl.uniform3fv(uniforms['advancedHsl[0]'], new Float32Array(BANDS.flatMap(k => [a.hsl[k].hue, a.hsl[k].saturation, a.hsl[k].luminance])));
  }
  return Object.freeze({ defaults, normalize, validate, isIdentity, adjustRgb, createProcessor, glslSource, setUniforms, channels: CHANNELS, bands: BANDS, centers: CENTERS, maxCurvePoints: MAX_CURVE_POINTS, professionalGlslSource, setProfessionalUniforms, professionalDefaults, normalizeProfessional, validateProfessional, professionalIdentity, createProfessionalProcessor, bezierAt, parseCube, validateLut, professionalChannels: PROFESSIONAL_CHANNELS, version: 'independent-sdr-grade-v2' });
});
