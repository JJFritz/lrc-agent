import { NextResponse } from "next/server";
export const runtime="nodejs";
export const maxDuration=300;

function cfg(){
  const base=String(process.env.NEXTCLOUD_URL||"").replace(/\/+$/,"");
  const user=String(process.env.NEXTCLOUD_USERNAME||"");
  const pass=String(process.env.NEXTCLOUD_APP_PASSWORD||"");
  const root=String(process.env.NEXTCLOUD_LRC_PATH||"/LRC-Agent");
  if(!base||!user||!pass) throw new Error("Nextcloud config missing");
  return {base,user,pass,root};
}
function auth(user:string,pass:string){return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`}
function url(c:ReturnType<typeof cfg>,rel:string){
  const path=[...c.root.split("/").filter(Boolean),...rel.split("/").filter(Boolean)].map(encodeURIComponent).join("/");
  return `${c.base}/remote.php/dav/files/${encodeURIComponent(c.user)}/${path}`;
}
function nameFromHref(h:string){try{return decodeURIComponent(h).replace(/\/$/,"").split("/").pop()||""}catch{return h.replace(/\/$/,"").split("/").pop()||""}}
async function listIn(c:ReturnType<typeof cfg>){
  const r=await fetch(url(c,"in"),{method:"PROPFIND",headers:{Authorization:auth(c.user,c.pass),Depth:"1","Content-Type":"application/xml"},body:'<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',cache:"no-store"});
  if(!r.ok&&r.status!==207) throw new Error(`PROPFIND ${r.status}`);
  const x=await r.text();
  return (x.match(/<(?:d:)?response\b[\s\S]*?<\/(?:d:)?response>/gi)||[]).map(b=>nameFromHref(b.match(/<(?:d:)?href>([\s\S]*?)<\/(?:d:)?href>/i)?.[1]||"")).filter(Boolean);
}
async function dl(c:ReturnType<typeof cfg>,name:string){const r=await fetch(url(c,`in/${name}`),{headers:{Authorization:auth(c.user,c.pass)},cache:"no-store"}); if(!r.ok) throw new Error(`GET ${r.status}`); return Buffer.from(await r.arrayBuffer())}
function splitWav(buf:Buffer,max=8*1024*1024){
  let pos=12,fmt=-1,data=-1,size=0; while(pos+8<=buf.length){const id=buf.toString("ascii",pos,pos+4),n=buf.readUInt32LE(pos+4),body=pos+8;if(id==="fmt ")fmt=body;if(id==="data"){data=body;size=Math.min(n,buf.length-body);break}pos=body+n+(n%2)}
  if(fmt<0||data<0) throw new Error("Invalid WAV"); const format=buf.readUInt16LE(fmt),ch=buf.readUInt16LE(fmt+2),sr=buf.readUInt32LE(fmt+4),br=buf.readUInt32LE(fmt+8),ba=buf.readUInt16LE(fmt+12),bits=buf.readUInt16LE(fmt+14); if(format!==1) throw new Error(`WAV format ${format}`);
  const n=Math.floor(max/ba)*ba, out:{b:Buffer;off:number}[]=[]; for(let s=0;s<size;s+=n){const len=Math.min(n,size-s),h=Buffer.alloc(44);h.write("RIFF",0);h.writeUInt32LE(36+len,4);h.write("WAVE",8);h.write("fmt ",12);h.writeUInt32LE(16,16);h.writeUInt16LE(format,20);h.writeUInt16LE(ch,22);h.writeUInt32LE(sr,24);h.writeUInt32LE(br,28);h.writeUInt16LE(ba,32);h.writeUInt16LE(bits,34);h.write("data",36);h.writeUInt32LE(len,40);out.push({b:Buffer.concat([h,buf.subarray(data+s,data+s+len)]),off:s/br})} return out;
}
export async function GET(){
  try{
    const c=cfg(), names=await listIn(c), audio=names.find(n=>/\.wav$/i.test(n)); if(!audio) throw new Error(`No wav in ${JSON.stringify(names)}`); const buf=await dl(c,audio),parts=splitWav(buf); const p=parts[0];
    const fd=new FormData(); fd.append("model","whisper-1"); fd.append("response_format","verbose_json"); fd.append("timestamp_granularities[]","word"); fd.append("language","de"); fd.append("file",new Blob([new Uint8Array(p.b)],{type:"audio/wav"}),"chunk-1.wav");
    const r=await fetch("https://api.openai.com/v1/audio/transcriptions",{method:"POST",headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`},body:fd}); const text=await r.text(); return NextResponse.json({ok:r.ok,status:r.status,audio,size:buf.length,chunks:parts.length,firstChunk:p.b.length,body:text.slice(0,1200)},{status:r.ok?200:500});
  }catch(e:any){return NextResponse.json({ok:false,error:e?.message||String(e),cause:e?.cause?.message||null},{status:500})}
}
