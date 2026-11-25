import {test} from "node:test";
import assert from "node:assert/strict";
import {inspectAccess} from "../app/auth-access.mjs";
function fake({session=true,user="u",rows=[],fail=false,userError=false}={}){
  return {auth:{getSession:async()=>({data:{session:session?{}:null}}),getUser:async()=>({data:{user:{id:user}},error:userError?{}:null})},from(table){assert.equal(table,"archive_members");return {select(fields){assert.equal(fields,"archive_id,role");return {eq:async(field,id)=>{assert.equal(field,"user_id");assert.equal(id,user);return {data:rows,error:fail?{}:null};}};}};}};
}
test("sin sesión no se autoriza",async()=>assert.deepEqual(await inspectAccess(fake({session:false})),{state:"signed-out"}));
test("cuenta Google no miembro rechazada",async()=>assert.deepEqual(await inspectAccess(fake()),{state:"denied"}));
test("propietario y editor autorizados",async()=>{for(const role of ["owner","editor"])assert.deepEqual(await inspectAccess(fake({rows:[{archive_id:"a",role}]})),{state:"authorized",role,archiveId:"a"});});
test("membresías ambiguas y roles inesperados denegados",async()=>{for(const rows of [[{archive_id:"a",role:"admin"}],[{archive_id:"a",role:"owner"},{archive_id:"b",role:"editor"}]])assert.equal((await inspectAccess(fake({rows}))).state,"denied");});
test("error de identidad o base no autoriza",async()=>{await assert.rejects(inspectAccess(fake({userError:true})));await assert.rejects(inspectAccess(fake({fail:true})));});
