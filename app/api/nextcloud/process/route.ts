import { NextResponse } from "next/server";
import OpenAI from "openai";

export const runtime = "nodejs";
export const maxDuration = 300;

type WhisperWord = { word: string; start: number; end: number };
type NcConfig = { baseUrl: string; username: string; appPassword: string; folderPath: string };
type FolderItem = { name: string; isCollection: boolean; size: number; modified: string };

function getConfig(): NcConfig {
  const baseUrl = String(process.env.NEXTCLOUD_URL || "").replace(/\/+$/, "");
  const username = String(process.env.NEXTCLOUD_USERNAME || "");
  const appPassword = String(process.env.NEXTCLOUD_APP_PASSWORD || "");
  const rawPath = String(process.env.NEXTCLOUD_LRC_PATH || "/LRC-Agent");
  const folderPath = `/${rawPath.split("/").filter(Boolean).map(encodeURIComponent).join("/")}`;
  if (!baseUrl || !username || !appPassword) throw new Error("Nextcloud-Konfiguration ist unvollständig.");
  return { baseUrl, username, appPassword, folderPath };
}

function authHeader(c: NcConfig) {
  return `Basic ${Buffer.from(`${c.username}:${c.appPassword}`, "utf8").toString("base64")}`;
}

function davUrl(c: NcConfig, relative = "") {
  const user = encodeURIComponent(c.username);
  const suffix = relative ? `/${relative.split("/").filter(Boolean).map(encodeURIComponent).join("/")}` : "";
  return `${c.baseUrl}/remote.php/dav/files/${user}${c.folderPath}${suffix}`;
}

function decodeHrefName(href: string) {
  try { return decodeURIComponent(href).replace(/\/$/, "").split("/").pop() || ""; }
  catch { return href.replace(/\/$/, "").split("/").pop() || ""; }
}

async function listFolder(c: NcConfig, relativeFolder = ""): Promise<FolderItem[]> {
  const r = await fetch(davUrl(c, relativeFolder), {
    method: "PROPFIND",
    headers: { Authorization: authHeader(c), Depth: "1", "Content-Type": "application/xml; charset=utf-8" },
    body: `<?xml version="1.0" encoding="utf-8" ?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>`,
    cache: "no-store",
  });
  if (!r.ok && r.status !== 207) throw new Error(`Nextcloud-Zugriff fehlgeschlagen (${r.status} ${r.statusText}).`);
  const xml = await r.text();
  const responses = xml.match(/<(?:d:)?response\b[\s\S]*?<\/(?:d:)?response>/gi) || [];
  const folderName = decodeURIComponent((relativeFolder || c.folderPath).split("/").filter(Boolean).pop() || "");
  return responses.map((block) => {
    const href = block.match(/<(?:d:)?href>([\s\S]*?)<\/(?:d:)?href>/i)?.[1] || "";
    const isCollection = /<(?:d:)?collection\s*\/?\s*>/i.test(block);
    const size = Number(block.match(/<(?:d:)?getcontentlength>(\d+)<\/(?:d:)?getcontentlength>/i)?.[1] || 0);
    const modified = block.match(/<(?:d:)?getlastmodified>([\s\S]*?)<\/(?:d:)?getlastmodified>/i)?.[1] || "";
    return { name: decodeHrefName(href), isCollection, size, modified };
  }).filter(x => x.name && x.name !== folderName);
}

async function download(c: NcConfig, relativePath: string) {
  const r = await fetch(davUrl(c, relativePath), { headers: { Authorization: authHeader(c) }, cache: "no-store" });
  if (!r.ok) throw new Error(`Datei ${relativePath} konnte nicht aus Nextcloud geladen werden (${r.status}).`);
  return Buffer.from(await r.arrayBuffer());
}

async function uploadText(c: NcConfig, relativePath: string, text: string) {
  const r = await fetch(davUrl(c, relativePath), {
    method: "PUT",
    headers: { Authorization: authHeader(c), "Content-Type": "text/plain; charset=utf-8" },
    body: Buffer.from(text, "utf8"),
  });
  if (!r.ok && r.status !== 201 && r.status !== 204) {
    throw new Error(`Ergebnis ${relativePath} konnte nicht in Nextcloud gespeichert werden (${r.status}).`);
  }
}

async function moveFile(c: NcConfig, from: string, to: string) {
  const r = await fetch(davUrl(c, from), {
    method: "MOVE",
    headers: { Authorization: authHeader(c), Destination: davUrl(c, to), Overwrite: "T" },
  });
  if (!r.ok && r.status !== 201 && r.status !== 204) {
    throw new Error(`Datei ${from} konnte nicht nach ${to} verschoben werden (${r.status}).`);
  }
}

function decodeLyricsBuffer(buf: Buffer) {
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes).replace(/^\uFEFF/, "").trim();
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes).replace(/^\uFEFF/, "").trim();
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "").trim();
  } catch {
    return new TextDecoder("windows-1252").decode(bytes).replace(/^\uFEFF/, "").trim();
  }
}

function norm(s:string) {
  return s.toLocaleLowerCase("de-DE").normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/ß/g,"ss").replace(/[^\p{L}\p{N}]+/gu,"").trim();
}
function similarity(a:string,b:string) {
  a=norm(a); b=norm(b); if(!a||!b)return 0; if(a===b)return 1;
  const m=a.length,n=b.length; const dp=Array.from({length:m+1},()=>Array(n+1).fill(0));
  for(let i=0;i<=m;i++)dp[i][0]=i; for(let j=0;j<=n;j++)dp[0][j]=j;
  for(let i=1;i<=m;i++)for(let j=1;j<=n;j++)dp[i][j]=Math.min(dp[i-1][j]+1,dp[i][j-1]+1,dp[i-1][j-1]+(a[i-1]===b[j-1]?0:1));
  return 1-dp[m][n]/Math.max(m,n);
}
function tokenizeLyrics(lines:string[]) {
  const out:{lineIndex:number;raw:string;token:string}[]=[];
  lines.forEach((line,lineIndex)=>{ const words=line.match(/[\p{L}\p{N}]+/gu)||[]; words.forEach(raw=>out.push({lineIndex,raw,token:norm(raw)})); });
  return out;
}
function alignTokens(target:{lineIndex:number;raw:string;token:string}[], heard:WhisperWord[]) {
  const A=target,B=heard.map(w=>({...w,token:norm(w.word)})); const n=A.length,m=B.length,gapTarget=.72,gapHeard=.48;
  const dp=Array.from({length:n+1},()=>new Float64Array(m+1)); const bt=Array.from({length:n+1},()=>new Int8Array(m+1));
  for(let i=1;i<=n;i++){dp[i][0]=dp[i-1][0]+gapTarget;bt[i][0]=1;} for(let j=1;j<=m;j++){dp[0][j]=dp[0][j-1]+gapHeard;bt[0][j]=2;}
  for(let i=1;i<=n;i++)for(let j=1;j<=m;j++){ const sim=similarity(A[i-1].token,B[j-1].token),sub=dp[i-1][j-1]+(1-sim),del=dp[i-1][j]+gapTarget,ins=dp[i][j-1]+gapHeard; if(sub<=del&&sub<=ins){dp[i][j]=sub;bt[i][j]=0;} else if(del<=ins){dp[i][j]=del;bt[i][j]=1;} else {dp[i][j]=ins;bt[i][j]=2;} }
  const matches:Array<{targetIndex:number;heardIndex:number;score:number}>=[]; let i=n,j=m;
  while(i>0||j>0){const b=bt[i][j]; if(i>0&&j>0&&b===0){const score=similarity(A[i-1].token,B[j-1].token); if(score>=.42)matches.push({targetIndex:i-1,heardIndex:j-1,score}); i--;j--;} else if(i>0&&(j===0||b===1))i--; else j--;}
  matches.reverse(); return {matches};
}
function stampLRC(t:number){t=Math.max(0,t);const mm=Math.floor(t/60),ss=t-mm*60;return `[${String(mm).padStart(2,"0")}:${ss.toFixed(2).padStart(5,"0")}]`;}
function stampSRT(t:number){t=Math.max(0,t);const h=Math.floor(t/3600);t-=h*3600;const m=Math.floor(t/60);t-=m*60;const s=Math.floor(t),ms=Math.round((t-s)*1000);return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")},${String(ms).padStart(3,"0")}`;}

function mimeFor(name:string) {
  const ext=name.toLowerCase().split(".").pop();
  if(ext==="wav")return "audio/wav"; if(ext==="mp3")return "audio/mpeg"; if(ext==="m4a")return "audio/mp4"; if(ext==="flac")return "audio/flac"; if(ext==="ogg")return "audio/ogg";
  return "application/octet-stream";
}

function splitPcmWav(buf: Buffer, maxDataBytes = 18 * 1024 * 1024): Array<{buffer:Buffer; offsetSeconds:number}> {
  if (buf.length < 44 || buf.toString("ascii",0,4)!=="RIFF" || buf.toString("ascii",8,12)!=="WAVE") return [{buffer:buf,offsetSeconds:0}];
  let pos=12, fmtStart=-1, fmtSize=0, dataStart=-1, dataSize=0;
  while(pos+8<=buf.length){ const id=buf.toString("ascii",pos,pos+4); const size=buf.readUInt32LE(pos+4); const body=pos+8; if(id==="fmt "){fmtStart=body;fmtSize=size;} if(id==="data"){dataStart=body;dataSize=Math.min(size,buf.length-body);break;} pos=body+size+(size%2); }
  if(fmtStart<0||dataStart<0||fmtSize<16)return [{buffer:buf,offsetSeconds:0}];
  const audioFormat=buf.readUInt16LE(fmtStart), channels=buf.readUInt16LE(fmtStart+2), sampleRate=buf.readUInt32LE(fmtStart+4), byteRate=buf.readUInt32LE(fmtStart+8), blockAlign=buf.readUInt16LE(fmtStart+12);
  if(audioFormat!==1||!channels||!sampleRate||!byteRate||!blockAlign)return [{buffer:buf,offsetSeconds:0}];
  const chunkDataBytes=Math.max(blockAlign,Math.floor(maxDataBytes/blockAlign)*blockAlign); const out:Array<{buffer:Buffer;offsetSeconds:number}>=[];
  for(let start=0;start<dataSize;start+=chunkDataBytes){ const len=Math.min(chunkDataBytes,dataSize-start); const paddedLen=len+(len%2); const header=Buffer.alloc(44); header.write("RIFF",0,"ascii"); header.writeUInt32LE(36+len,4); header.write("WAVE",8,"ascii"); header.write("fmt ",12,"ascii"); header.writeUInt32LE(16,16); header.writeUInt16LE(audioFormat,20); header.writeUInt16LE(channels,22); header.writeUInt32LE(sampleRate,24); header.writeUInt32LE(byteRate,28); header.writeUInt16LE(blockAlign,32); header.writeUInt16LE(buf.readUInt16LE(fmtStart+14),34); header.write("data",36,"ascii"); header.writeUInt32LE(len,40); const payload=buf.subarray(dataStart+start,dataStart+start+len); const piece=paddedLen===len?Buffer.concat([header,payload]):Buffer.concat([header,payload,Buffer.alloc(1)]); out.push({buffer:piece,offsetSeconds:start/byteRate}); }
  return out;
}

async function transcribe(openai:OpenAI, audioName:string, audio:Buffer) {
  const maxDirect=24*1024*1024;
  let parts:Array<{buffer:Buffer;offsetSeconds:number}>=[{buffer:audio,offsetSeconds:0}];
  if(audio.length>maxDirect){
    if(audioName.toLowerCase().endsWith(".wav")) parts=splitPcmWav(audio);
    else throw new Error("Die Audiodatei ist größer als 24 MB. Bitte als WAV oder komprimierter (MP3/M4A) bereitstellen.");
  }
  const words:WhisperWord[]=[]; const texts:string[]=[];
  for(let i=0;i<parts.length;i++){
    const p=parts[i];
    const bytes = new Uint8Array(p.buffer.buffer, p.buffer.byteOffset, p.buffer.byteLength);
    const file=new File([bytes], parts.length===1?audioName:`chunk-${i+1}.wav`, {type:mimeFor(audioName)});
    const tr:any=await openai.audio.transcriptions.create({file,model:"whisper-1",response_format:"verbose_json",timestamp_granularities:["word","segment"],language:"de",prompt:"Dies ist ein deutschsprachiger experimenteller Gesang. Bitte auch gedehnte, ungewöhnlich artikulierte Wörter möglichst wörtlich erfassen."} as any);
    texts.push(String(tr.text||""));
    for(const w of tr.words||[]){ const start=Number(w.start),end=Number(w.end); if(String(w.word||"")&&Number.isFinite(start)&&Number.isFinite(end))words.push({word:String(w.word),start:start+p.offsetSeconds,end:end+p.offsetSeconds}); }
  }
  return {words,text:texts.join(" ").trim(),chunks:parts.length};
}

async function processFiles(audioName?:string, lyricsName?:string, sourceFolder="in") {
  if(sourceFolder!=="in" && sourceFolder!=="done") throw new Error("Ungültiger Quellordner.");
  const c=getConfig();
  const files=(await listFolder(c,sourceFolder)).filter(x=>!x.isCollection);
  const audioExt=/\.(wav|mp3|m4a|flac|ogg|webm)$/i; const textExt=/\.(txt|lyrics)$/i;
  const audioItem=audioName?files.find(x=>x.name===audioName):files.filter(x=>audioExt.test(x.name)).sort((a,b)=>Date.parse(b.modified||"")-Date.parse(a.modified||""))[0];
  if(!audioItem)throw new Error(`Im Nextcloud-Ordner /LRC-Agent/${sourceFolder} wurde keine Audiodatei gefunden.`);
  const base=audioItem.name.replace(/\.[^.]+$/,""), cleanBase=base.replace(/^Stlle\b/i,"Stille");
  const lyricsItem=lyricsName?files.find(x=>x.name===lyricsName):files.find(x=>x.name.toLowerCase()===`${base.toLowerCase()}.txt`)||files.find(x=>x.name.toLowerCase()===`${cleanBase.toLowerCase()}.txt`)||files.filter(x=>textExt.test(x.name)).sort((a,b)=>Date.parse(b.modified||"")-Date.parse(a.modified||""))[0];
  if(!lyricsItem)throw new Error(`Keine Lyrics-Datei in /LRC-Agent/${sourceFolder} gefunden.`);

  const [audioBuf,lyricsBuf]=await Promise.all([download(c,`${sourceFolder}/${audioItem.name}`),download(c,`${sourceFolder}/${lyricsItem.name}`)]);
  const lyrics=decodeLyricsBuffer(lyricsBuf);
  if(!lyrics)throw new Error("Die Lyrics-Datei ist leer.");
  const key=String(process.env.OPENAI_API_KEY||""); if(!key)throw new Error("OPENAI_API_KEY fehlt."); const openai=new OpenAI({apiKey:key});
  const tr=await transcribe(openai,audioItem.name,audioBuf); const heard=tr.words; if(!heard.length)throw new Error("Keine Wort-Zeitmarken erhalten.");
  const lines=lyrics.split(/\r?\n/).map(x=>x.trim()).filter(Boolean),target=tokenizeLyrics(lines),{matches}=alignTokens(target,heard),targetToMatch=new Map<number,{heardIndex:number;score:number}>(); matches.forEach(x=>targetToMatch.set(x.targetIndex,{heardIndex:x.heardIndex,score:x.score}));
  const lineInfo=lines.map((line,lineIndex)=>{const idxs=target.map((x,i)=>x.lineIndex===lineIndex?i:-1).filter(i=>i>=0);const ms=idxs.map(i=>({i,m:targetToMatch.get(i)})).filter(x=>x.m) as Array<{i:number;m:{heardIndex:number;score:number}}>; if(ms.length){const first=ms[0].m,last=ms[ms.length-1].m;return{line,start:heard[first.heardIndex].start,end:heard[last.heardIndex].end,score:ms.reduce((a,x)=>a+x.m.score,0)/ms.length};} return{line,start:NaN,end:NaN,score:0};});
  for(let k=0;k<lineInfo.length;k++){if(Number.isFinite(lineInfo[k].start))continue;let p=k-1,nx=k+1;while(p>=0&&!Number.isFinite(lineInfo[p].start))p--;while(nx<lineInfo.length&&!Number.isFinite(lineInfo[nx].start))nx++;if(p>=0&&nx<lineInfo.length){const span=nx-p,frac=(k-p)/span;lineInfo[k].start=lineInfo[p].start+(lineInfo[nx].start-lineInfo[p].start)*frac;lineInfo[k].end=lineInfo[k].start+1.2;}else if(p>=0){lineInfo[k].start=lineInfo[p].end+.25;lineInfo[k].end=lineInfo[k].start+1.2;}else if(nx<lineInfo.length){lineInfo[k].start=Math.max(0,lineInfo[nx].start-(nx-k)*1.4);lineInfo[k].end=lineInfo[k].start+1.1;}else{lineInfo[k].start=k*1.5;lineInfo[k].end=lineInfo[k].start+1.2;}}
  for(let k=1;k<lineInfo.length;k++)if(lineInfo[k].start<=lineInfo[k-1].start)lineInfo[k].start=lineInfo[k-1].start+.12;
  const title=/^Stlle\b/i.test(base)?base.replace(/^Stlle\b/i,"Stille"):base;
  const lrc=[`[ti:${title}]`,`[by:LRC-Agent]`,"",...lineInfo.map(x=>`${stampLRC(x.start)}${x.line}`)].join("\n");
  const srt=lineInfo.map((x,i)=>{const next=lineInfo[i+1]?.start,end=Number.isFinite(next)?Math.max(x.start+.45,next-.06):Math.max(x.start+1.5,x.end);return `${i+1}\n${stampSRT(x.start)} --> ${stampSRT(end)}\n${x.line}`;}).join("\n\n");
  const outBase=title;
  await Promise.all([
    uploadText(c,`out/${outBase}.lrc`,lrc),
    uploadText(c,`out/${outBase}.srt`,srt),
    uploadText(c,`out/${outBase}.transcript.txt`,tr.text)
  ]);
  if(sourceFolder==="in") {
    await Promise.all([
      moveFile(c,`in/${audioItem.name}`,`done/${audioItem.name}`),
      moveFile(c,`in/${lyricsItem.name}`,`done/${lyricsItem.name}`)
    ]);
  }
  const lowConfidenceLines=lineInfo.filter(x=>x.score<.58).map(x=>({line:x.line,score:x.score}));
  return {ok:true,audio:audioItem.name,lyrics:lyricsItem.name,title,lrcFile:`out/${outBase}.lrc`,srtFile:`out/${outBase}.srt`,transcriptFile:`out/${outBase}.transcript.txt`,chunks:tr.chunks,sourceFolder,lowConfidenceLines};
}

export async function GET(req:Request){try{const u=new URL(req.url);return NextResponse.json(await processFiles(u.searchParams.get("audio")||undefined,u.searchParams.get("lyrics")||undefined,u.searchParams.get("folder")||"in"));}catch(e:any){return NextResponse.json({ok:false,error:e?.message||"Unbekannter Fehler."},{status:500});}}
export async function POST(req:Request){try{let body:any={};try{body=await req.json();}catch{}return NextResponse.json(await processFiles(body.audioName,body.lyricsName,body.folder||"in"));}catch(e:any){return NextResponse.json({ok:false,error:e?.message||"Unbekannter Fehler."},{status:500});}}
