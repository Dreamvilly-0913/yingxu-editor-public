/* Independent brightness/contrast/saturation and advanced SDR grading preview. Formula provenance is recorded in docs;
   one shared GPU context is used regardless of timeline clip count. */
(function(){'use strict';
let surface,gl,program,texture,locations;
const Advanced=window.EditorAdvancedColor,Visual=window.EditorVisualEffects;
if(!Advanced)throw new Error('高级调色模块未加载');
const vertex='attribute vec2 position;varying vec2 uv;void main(){uv=position*.5+.5;gl_Position=vec4(position,0.,1.);}';
const fragment=`precision highp float;
varying vec2 uv;uniform sampler2D source;uniform vec3 controls;
${Advanced.glslSource}
${Advanced.professionalGlslSource}
${Visual?Visual.keyGlslSource:""}
float light(float x,float b){
 if(b>0.){float p=1.+5.*b;float edge=pow(.001,1./p);return x>1.-edge?x+edge:1.-pow(1.-x,p);}
 float p=1./(1.-2.5*b);return x>1.?x-pow(-.01*b,p):1.-pow(1.-x*(1.+.01*b),p);
}
float contrastValue(float x,float k){
 float pivot=.435;if(k<=1.)return k*(x-pivot)+pivot;
 if(x<pivot){float edge=pivot*pow(.001/pivot,1./k);return x<edge?x-edge:pivot*pow(x/pivot,k);}
 float edge=1.-(1.-pivot)*pow(.001/(1.-pivot),1./k);
 return x>edge?x+1.-edge:1.-(1.-pivot)*pow((1.-x)/(1.-pivot),k);
}
void main(){
 vec4 original=texture2D(source,uv);${Visual?"original=visualKey(original,uv);":""}float b=controls.x<=0.?controls.x:controls.x<=.7?.3*controls.x:.6333*controls.x-.2333;
 float c=controls.y<=0.?1.+.4*controls.y:1.+1.1*controls.y+pow(controls.y,5.27);
 vec3 rgb=vec3(light(original.r,b),light(original.g,b),light(original.b,b));
 rgb=vec3(contrastValue(rgb.r,c),contrastValue(rgb.g,c),contrastValue(rgb.b,c));
 float luma=dot(rgb,vec3(.208540,.702086,.089374));float saturation=1.+controls.z;
 gl_FragColor=vec4(professionalRgb(advancedRgb(clamp(vec3(luma)*(1.-saturation)+rgb*saturation,0.,1.))),original.a);
}`;
function prepare(){
 if(gl)return;
 surface=document.createElement('canvas');gl=surface.getContext('webgl',{alpha:true,premultipliedAlpha:false,antialias:false,preserveDrawingBuffer:true});
 if(!gl)throw new Error('当前显卡无法创建调色预览，请检查图形驱动。');
 function compile(type,text){const s=gl.createShader(type);gl.shaderSource(s,text);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error('调色预览编译失败：'+gl.getShaderInfoLog(s));return s;}
 program=gl.createProgram();gl.attachShader(program,compile(gl.VERTEX_SHADER,vertex));gl.attachShader(program,compile(gl.FRAGMENT_SHADER,fragment));gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error('无法初始化调色预览');gl.useProgram(program);
 const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
 const attribute=gl.getAttribLocation(program,'position');gl.enableVertexAttribArray(attribute);gl.vertexAttribPointer(attribute,2,gl.FLOAT,false,0,0);
 texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texture);for(const p of [gl.TEXTURE_WRAP_S,gl.TEXTURE_WRAP_T])gl.texParameteri(gl.TEXTURE_2D,p,gl.CLAMP_TO_EDGE);for(const p of [gl.TEXTURE_MIN_FILTER,gl.TEXTURE_MAG_FILTER])gl.texParameteri(gl.TEXTURE_2D,p,gl.LINEAR);
 gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);locations={controls:gl.getUniformLocation(program,'controls')};
}
function render(media,destination,color,advancedColor,visualEffects){
 prepare();if(gl.isContextLost())throw new Error('调色预览图形上下文已丢失，请重新打开工程。');
 const width=media.videoWidth||media.naturalWidth||media.width,height=media.videoHeight||media.naturalHeight||media.height;if(!width||!height)return false;
 const ratio=Math.min(1,1280/width,1280/height),w=Math.max(1,Math.round(width*ratio)),h=Math.max(1,Math.round(height*ratio));
 if(surface.width!==w||surface.height!==h){surface.width=w;surface.height=h;}
 gl.viewport(0,0,w,h);gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,texture);gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,media);
 gl.uniform3f(locations.controls,color.brightness||0,color.contrast||0,color.saturation||0);Advanced.setUniforms(gl,program,advancedColor);Advanced.setProfessionalUniforms(gl,program,advancedColor);if(Visual)Visual.setKeyUniforms(gl,program,visualEffects,width,height);gl.drawArrays(gl.TRIANGLES,0,6);
 if(destination.width!==w||destination.height!==h){destination.width=w;destination.height=h;}
 const context=destination.getContext('2d');context.clearRect(0,0,w,h);context.drawImage(surface,0,0);return true;
}
window.EditorColorPreview=Object.freeze({render});
})();
