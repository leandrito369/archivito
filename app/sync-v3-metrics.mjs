// Local-only instrumentation. Fixed phase labels, numbers only, no identifiers.
const phases=new Set(["auth","snapshot","sample","prepare","wire","begin","block","commit","header","download","reconstruct","apply","queue","total","attest","manifest","catalog","lookup"]);
export function createV3Metrics(onUpdate=()=>{}){
 const rows=new Map();
 function record(phase,ms,bytes=0){
  if(!phases.has(phase)||!Number.isFinite(ms)||ms<0||!Number.isSafeInteger(bytes)||bytes<0)return;
  const r=rows.get(phase)||{phase,count:0,ms:0,bytes:0};
  r.count++;r.ms+=ms;r.bytes+=bytes;rows.set(phase,r);
  try{onUpdate(snapshot());}catch{}
 }
 function snapshot(){return Array.from(rows.values(),r=>({...r,ms:Math.round(r.ms)}));}
 async function measure(phase,work,bytes=0){
  const start=performance.now();try{return await work();}finally{record(phase,performance.now()-start,bytes);}
 }
 return {record,snapshot,measure};
}
