/* Archivito — matemáticas puras para una hoja ligeramente curvada.
   No requiere Three.js: tests ejecutables con Node. */
(function(root) {
  "use strict";
  const THICKNESS=0.025;
  const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));
  function shape(x,y,width,height,curvature=0.28) {
    if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0)
      throw Error("Dimensiones de papel inválidas.");
    const bend=clamp(curvature,0,1);
    const u=clamp(x/(width/2),-1,1), v=clamp(y/(height/2),-1,1);
    // Centro relativamente plano; márgenes levantados y onda longitudinal tenue.
    return bend*(0.15*u*u + 0.014*Math.sin(Math.PI*v)*Math.sin(Math.PI*u));
  }
  function dimensions(imageWidth,imageHeight) {
    if(!Number.isFinite(imageWidth)||!Number.isFinite(imageHeight)||
       imageWidth<=0||imageHeight<=0) throw Error("Tamaño de fotografía inválido.");
    const ratio=clamp(imageWidth/imageHeight,.38,2.5);
    return {width:2.4*ratio,height:2.4,ratio};
  }
  function surfaceGeometry(width,height,curvature,side="front",nx=32,ny=32) {
    if(!["front","back"].includes(side)||nx<2||ny<2||nx>128||ny>128)
      throw Error("Superficie inválida.");
    const positions=new Float32Array((nx+1)*(ny+1)*3);
    let i=0;
    for(let row=0;row<=ny;row++) for(let col=0;col<=nx;col++) {
      const x=(col/nx-.5)*width, y=(.5-row/ny)*height;
      positions[i++]=x;
      positions[i++]=y;
      // La superficie de atrás gira 180° en Y al crear la malla.
      positions[i++]=side==="front"
         ? shape(x,y,width,height,curvature)+THICKNESS/2
         : THICKNESS/2-shape(-x,y,width,height,curvature);
    }
    return positions;
  }
  function edgeGeometry(width,height,curvature,steps=32) {
    const vertices=[],indices=[];
    const edges=[
      t=>({x:(t-.5)*width,y:height/2}),
      t=>({x:width/2,y:(.5-t)*height}),
      t=>({x:(.5-t)*width,y:-height/2}),
      t=>({x:-width/2,y:(t-.5)*height})
    ];
    for(const edge of edges){
      const base=vertices.length/3;
      for(let i=0;i<=steps;i++){
        const {x,y}=edge(i/steps),z=shape(x,y,width,height,curvature);
        vertices.push(x,y,z+THICKNESS/2,x,y,z-THICKNESS/2);
      }
      for(let i=0;i<steps;i++){
        const v=base+i*2;
        indices.push(v,v+1,v+2,v+1,v+3,v+2);
      }
    }
    return {positions:new Float32Array(vertices),indices:Uint16Array.from(indices)};
  }
  const api={THICKNESS,shape,dimensions,surfaceGeometry,edgeGeometry};
  root.ArchivitoPaperMath=api;
  if(typeof module!=="undefined"&&module.exports)module.exports=api;
})(typeof globalThis==="object"?globalThis:this);
