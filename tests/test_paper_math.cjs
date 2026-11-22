"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const p=require("../app/paper-math.js");
test("las dimensiones del papel respetan proporciones con límites",()=>{
 assert.equal(p.dimensions(300,400).width,1.8);
 assert.equal(p.dimensions(400,300).height,2.4);
 assert.equal(p.dimensions(500,500).ratio,1);
 assert.throws(()=>p.dimensions(0,300));
});
test("curvatura cero genera papel plano; bordes se elevan al aumentarla",()=>{
 const w=1.8,h=2.4;
 for(const x of [-w/2,0,w/2])assert.equal(p.shape(x,0,w,h,0),0);
 assert.equal(p.shape(0,0,w,h,.5),0);
 assert.ok(p.shape(w/2,0,w,h,.5)>.07);
 assert.ok(p.shape(-w/2,0,w,h,.5)>.07);
 assert.ok(Math.abs(p.shape(w/2,0,w,h,.5)-p.shape(-w/2,0,w,h,.5))<1e-8);
});
test("frente y dorso tienen mallas independientes y grosor constante",()=>{
 const w=1.9,h=2.4,curve=.5;
 const front=p.surfaceGeometry(w,h,curve,"front",4,4);
 const back=p.surfaceGeometry(w,h,curve,"back",4,4);
 assert.equal(front.length,75);assert.equal(back.length,75);
 for(let row=0;row<=4;row++)for(let col=0;col<=4;col++){
  const i=(row*5+col)*3,x=front[i],y=front[i+1];
  const opposite=(row*5+(4-col))*3;
  const backWorldZ=-back[opposite+2];
  assert.ok(Math.abs(front[i+2]-backWorldZ-p.THICKNESS)<1e-6,
   "grosor perdido "+x+","+y);
 }
});
test("los cantos enlazan todas las aristas y tienen índices válidos",()=>{
 const edge=p.edgeGeometry(1.8,2.4,.4,10);
 assert.equal(edge.positions.length,4*(10+1)*2*3);
 assert.equal(edge.indices.length,4*10*6);
 assert.ok([...edge.indices].every(i=>i<edge.positions.length/3));
});
test("rechaza malla con resolución o cara inválidas",()=>{
 assert.throws(()=>p.surfaceGeometry(2,3,0,"invalid"));
 assert.throws(()=>p.surfaceGeometry(2,3,0,"front",1,16));
});
