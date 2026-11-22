/* Archivito 0.3B.1 — visor Three.js opcional y 100% local.
   No lee ni escribe IndexedDB: los Blobs se entregan desde visor-3d.js.
   Three.js se carga desde node_modules, nunca desde CDN. */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

export function createThreeViewer(stage, {onFailure=()=>{}}={}) {
  const math=globalThis.ArchivitoPaperMath;
  if(!math) throw Error("Falta el módulo de geometría local.");
  const renderer=new THREE.WebGLRenderer({antialias:true,alpha:true,powerPreference:"low-power"});
  renderer.setClearColor(0x000000,0);
  renderer.outputColorSpace=THREE.SRGBColorSpace;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2));
  renderer.domElement.className="webgl-canvas";
  renderer.domElement.setAttribute("aria-label","Visor de carta tridimensional interactiva");
  stage.append(renderer.domElement);

  const scene=new THREE.Scene();
  const camera=new THREE.PerspectiveCamera(37,1,.08,100);
  const controls=new OrbitControls(camera,renderer.domElement);
  controls.enableDamping=true;
  controls.dampingFactor=.075;
  controls.enablePan=false;
  controls.minDistance=1.2;
  controls.maxDistance=15;
  controls.target.set(0,0,0);
  const ambient=new THREE.AmbientLight(0xffffff,2.0);
  scene.add(ambient);
  const lamp=new THREE.DirectionalLight(0xffebce,2.6);
  lamp.position.set(-2,3,5);scene.add(lamp);
  const fill=new THREE.DirectionalLight(0xcbd8ed,1.35);
  fill.position.set(2,-2,-4);scene.add(fill);

  let paper=null,textures=[],pageRevision=0,disposed=false;
  let side="front",curvature=.28,currentDimensions={width:1.75,height:2.4};
  let defaultDistance=4;
  function resize() {
    if(disposed)return;
    const w=Math.max(1,stage.clientWidth),h=Math.max(1,stage.clientHeight);
    renderer.setSize(w,h,false);
    camera.aspect=w/h;camera.updateProjectionMatrix();
  }
  function fitDistance() {
    const fov=THREE.MathUtils.degToRad(camera.fov);
    const vertical=currentDimensions.height/(2*Math.tan(fov/2));
    const horizontal=currentDimensions.width/(2*Math.tan(fov/2)*Math.max(.2,camera.aspect));
    return Math.max(3.5,Math.max(vertical,horizontal)*1.23);
  }
  function reset() {
    defaultDistance=fitDistance();
    camera.position.set(0,0,defaultDistance);
    camera.up.set(0,1,0);
    controls.target.set(0,0,0);
    if(paper)paper.rotation.y=side==="back"?Math.PI:0;
    controls.update();
  }
  const observer=new ResizeObserver(()=>{resize();});
  observer.observe(stage);
  function disposePaper() {
    if(!paper)return;
    scene.remove(paper);
    paper.traverse(obj=>{
      if(obj.isMesh){
        obj.geometry?.dispose();
        if(Array.isArray(obj.material))obj.material.forEach(m=>m.dispose());
        else obj.material?.dispose();
      }
    });
    textures.forEach(t=>t.dispose());textures=[];
    paper=null;
  }
  async function textureFor(blob,placeholder) {
    const canvas=document.createElement("canvas"),ctx=canvas.getContext("2d");
    if(blob instanceof Blob) {
      const bitmap=await createImageBitmap(blob);
      try {
        const s=Math.min(1,2048/Math.max(bitmap.width,bitmap.height));
        canvas.width=Math.max(2,Math.round(bitmap.width*s));
        canvas.height=Math.max(2,Math.round(bitmap.height*s));
        ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
      } finally{bitmap.close();}
    }else{
      canvas.width=800;canvas.height=1100;
      ctx.fillStyle="#edddc0";ctx.fillRect(0,0,800,1100);
      ctx.fillStyle="#7b6750";ctx.textAlign="center";ctx.font="italic 28px Georgia";
      ctx.fillText(placeholder,400,550);
    }
    const tex=new THREE.CanvasTexture(canvas);
    tex.colorSpace=THREE.SRGBColorSpace;
    tex.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());
    return tex;
  }
  function surface(sideName,w,h) {
    const geo=new THREE.PlaneGeometry(w,h,32,32);
    const data=math.surfaceGeometry(w,h,curvature,sideName,32,32);
    geo.attributes.position.array.set(data);
    geo.attributes.position.needsUpdate=true;
    geo.computeVertexNormals();
    return geo;
  }
  function edges(w,h) {
    const data=math.edgeGeometry(w,h,curvature,32);
    const geo=new THREE.BufferGeometry();
    geo.setAttribute("position",new THREE.BufferAttribute(data.positions,3));
    geo.setIndex(new THREE.BufferAttribute(data.indices,1));
    geo.computeVertexNormals();
    return geo;
  }
  function rebuildGeometry() {
    if(!paper)return;
    const front=paper.getObjectByName("front");
    const back=paper.getObjectByName("back");
    const edge=paper.getObjectByName("edge");
    front.geometry.dispose();back.geometry.dispose();edge.geometry.dispose();
    front.geometry=surface("front",currentDimensions.width,currentDimensions.height);
    back.geometry=surface("back",currentDimensions.width,currentDimensions.height);
    edge.geometry=edges(currentDimensions.width,currentDimensions.height);
  }
  async function setPage({front,back,width=3,height=4,curve=.28}) {
    if(disposed)return;
    const revision=++pageRevision;
    const nextDims=math.dimensions(width,height);
    let frontTexture,backTexture;
    try {
      [frontTexture,backTexture]=await Promise.all([
        textureFor(front,"Sin fotografía del frente"),
        textureFor(back,"Reverso no fotografiado")
      ]);
      if(disposed||revision!==pageRevision) {
        frontTexture.dispose();backTexture.dispose();return;
      }
      disposePaper();
      currentDimensions=nextDims;
      curvature=THREE.MathUtils.clamp(curve,0,1);
      textures=[frontTexture,backTexture];
      paper=new THREE.Group();
      const frontMaterial=new THREE.MeshStandardMaterial({
        map:frontTexture,side:THREE.FrontSide,roughness:1,metalness:0
      });
      const backMaterial=new THREE.MeshStandardMaterial({
        map:backTexture,side:THREE.FrontSide,roughness:1,metalness:0
      });
      const frontMesh=new THREE.Mesh(surface("front",nextDims.width,nextDims.height),frontMaterial);
      frontMesh.name="front";paper.add(frontMesh);
      const backMesh=new THREE.Mesh(surface("back",nextDims.width,nextDims.height),backMaterial);
      backMesh.rotation.y=Math.PI;backMesh.name="back";paper.add(backMesh);
      const edgeMaterial=new THREE.MeshStandardMaterial({
        color:0xc5ac8b,side:THREE.DoubleSide,roughness:1,metalness:0
      });
      const edgeMesh=new THREE.Mesh(edges(nextDims.width,nextDims.height),edgeMaterial);
      edgeMesh.name="edge";paper.add(edgeMesh);
      paper.rotation.y=side==="back"?Math.PI:0;
      scene.add(paper);
      reset();
    }catch(error) {
      frontTexture?.dispose();backTexture?.dispose();
      onFailure(error);
      throw error;
    }
  }
  function showSide(next) {
    side=next==="back"?"back":"front";
    if(paper)paper.rotation.y=side==="back"?Math.PI:0;
  }
  function setCurvature(value) {
    curvature=THREE.MathUtils.clamp(Number(value),0,1);
    rebuildGeometry();
  }
  function zoom(scale) {
    const distance=camera.position.length();
    const targetDistance=THREE.MathUtils.clamp(distance*scale,controls.minDistance,controls.maxDistance);
    camera.position.multiplyScalar(targetDistance/Math.max(.01,distance));
    controls.update();
  }
  function dispose() {
    if(disposed)return;
    disposed=true;++pageRevision;
    renderer.setAnimationLoop(null);
    observer.disconnect();controls.dispose();
    disposePaper();renderer.dispose();
    renderer.domElement.remove();
  }
  renderer.domElement.addEventListener("webglcontextlost",event=>{
    event.preventDefault();onFailure(Error("Se perdió el contexto WebGL."));dispose();
  },{once:true});
  resize();reset();
  renderer.setAnimationLoop(()=>{if(disposed)return;controls.update();renderer.render(scene,camera);});
  return {setPage,showSide,setCurvature,zoom,reset,dispose};
}
