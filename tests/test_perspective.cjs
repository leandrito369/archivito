"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {valid, estimateSize, homography, project, rectify} = require("../app/perspective.js");

const rectangle = [{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}];

test("válido: cuatro puntos convexos; rechaza cruces, repetidos y áreas nulas", () => {
  assert.equal(valid(rectangle), true);
  assert.equal(valid([{x:.1,y:.1},{x:.9,y:.2},{x:.8,y:.9},{x:.2,y:.85}]),true);
  assert.equal(valid([{x:0,y:0},{x:1,y:1},{x:1,y:0},{x:0,y:1}]),false);
  assert.equal(valid([{x:0,y:0},{x:.5,y:0},{x:1,y:0},{x:0,y:1}]),false);
  assert.equal(valid([{x:0,y:0},{x:0,y:0},{x:1,y:1},{x:0,y:1}]),false);
});

test("la homografía asigna exactamente las cuatro esquinas", () => {
  const from = [{x:0,y:0},{x:99,y:0},{x:99,y:199},{x:0,y:199}];
  const to = [{x:20,y:30},{x:180,y:10},{x:165,y:280},{x:10,y:210}];
  const h = homography(from,to);
  for(let i=0;i<4;i++){
    const p=project(h,from[i].x,from[i].y);
    assert.ok(Math.abs(p.x-to[i].x)<1e-7, "x "+i);
    assert.ok(Math.abs(p.y-to[i].y)<1e-7, "y "+i);
  }
});

test("un recorte completo de una foto no altera el centro de un original sintético", () => {
  const w=100,h=120;
  const data=new Uint8ClampedArray(w*h*4);
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){
    const i=(y*w+x)*4; data[i]=Math.floor(x/2);
    data[i+1]=Math.floor(y/2);data[i+2]=170;data[i+3]=255;
  }
  const actual=rectify({width:w,height:h,data},rectangle,1600);
  assert.equal(actual.width,w);assert.equal(actual.height,h);
  const index=((Math.floor(h/2)*w)+Math.floor(w/2))*4;
  assert.ok(Math.abs(actual.data[index] - data[index])<=1);
  assert.ok(Math.abs(actual.data[index+1] - data[index+1])<=1);
  assert.equal(actual.data[index+2],170);
  assert.equal(actual.data[index+3],255);
});

test("límite de resolución en derivados, conservando relación de aspecto", () => {
  const s=estimateSize(rectangle,6000,4000,1600);
  assert.equal(s.width,1600);assert.equal(s.height,1067);
  const s2=estimateSize(rectangle,350,500,1600);
  assert.deepEqual(s2,{width:350,height:500});
});

test("la función rechaza cuadriláteros degenerados", () => {
  assert.throws(()=>rectify({width:10,height:10,data:new Uint8ClampedArray(400)},
    [{x:0,y:0},{x:1,y:1},{x:1,y:0},{x:0,y:1}]));
});
