"use client";

import { useState } from "react";

type Result = {
  lrc: string;
  srt: string;
  transcript: string;
  lowConfidenceLines: Array<{line:string; score:number}>;
};

export default function Home() {
  const [audio, setAudio] = useState<File | null>(null);
  const [lyrics, setLyrics] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");

  async function run() {
    if (!audio || !lyrics.trim()) {
      setError("Bitte Audiodatei und Lyrics angeben.");
      return;
    }
    setBusy(true); setError(""); setResult(null);
    try {
      const fd = new FormData();
      fd.append("audio", audio);
      fd.append("lyrics", lyrics);
      if (apiKey.trim()) fd.append("apiKey", apiKey.trim());
      const r = await fetch("/api/align", { method:"POST", body:fd });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Fehler bei der Synchronisation.");
      setResult(data);
    } catch (e:any) {
      setError(e.message || String(e));
    } finally { setBusy(false); }
  }

  function download(name:string, text:string) {
    const blob = new Blob([text], {type:"text/plain;charset=utf-8"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href=url; a.download=name; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main style={{maxWidth:900,margin:"0 auto",padding:"36px 20px"}}>
      <h1 style={{fontSize:34,marginBottom:8}}>Song + Lyrics → LRC</h1>
      <p style={{opacity:.75,lineHeight:1.5}}>Fertigen Song hochladen, vorhandene Lyrics einfügen, synchronisieren, LRC/SRT herunterladen. Es werden keine neuen Lyrics erfunden.</p>
      <section style={{display:"grid",gap:16,marginTop:28}}>
        <label><div style={{marginBottom:7}}>1. Song</div><input type="file" accept="audio/*" onChange={e=>setAudio(e.target.files?.[0] || null)} /></label>
        <label><div style={{marginBottom:7}}>2. Vorhandene Lyrics</div><textarea value={lyrics} onChange={e=>setLyrics(e.target.value)} rows={18} placeholder="Bereinigte Lyrics hier einfügen." style={{width:"100%",boxSizing:"border-box",padding:12,borderRadius:8,border:"1px solid #555",background:"#1b1b1b",color:"#eee"}} /></label>
        <label><div style={{marginBottom:7}}>3. OpenAI API-Key</div><input type="password" value={apiKey} onChange={e=>setApiKey(e.target.value)} placeholder="leer lassen, wenn OPENAI_API_KEY auf Vercel gesetzt ist" style={{width:"100%",boxSizing:"border-box",padding:11,borderRadius:8,border:"1px solid #555",background:"#1b1b1b",color:"#eee"}} /><div style={{fontSize:12,opacity:.65,marginTop:6}}>Der im Formular eingegebene Key wird nur für diese Anfrage verwendet und nicht gespeichert.</div></label>
        <button onClick={run} disabled={busy} style={{padding:"13px 18px",fontSize:17,borderRadius:8,border:0,cursor:"pointer",fontWeight:700}}>{busy ? "Synchronisiere …" : "Synchronisieren"}</button>
        {error && <div style={{background:"#3a1616",padding:12,borderRadius:8}}>{error}</div>}
      </section>
      {result && <section style={{marginTop:32}}><h2>Ergebnis</h2><div style={{display:"flex",gap:10,flexWrap:"wrap"}}><button onClick={()=>download("lyrics-aligned.lrc", result.lrc)}>LRC herunterladen</button><button onClick={()=>download("lyrics-aligned.srt", result.srt)}>SRT herunterladen</button></div>{result.lowConfidenceLines.length > 0 && <div style={{marginTop:22,padding:14,border:"1px solid #705f25",borderRadius:8}}><strong>Bitte kurz kontrollieren:</strong><p style={{opacity:.75}}>Diese Zeilen wurden nur schwach im erkannten Gesang wiedergefunden.</p><ul>{result.lowConfidenceLines.map((x,i)=><li key={i}>{x.line} <span style={{opacity:.6}}>({Math.round(x.score*100)}%)</span></li>)}</ul></div>}<h3 style={{marginTop:24}}>LRC-Vorschau</h3><pre style={{whiteSpace:"pre-wrap",background:"#181818",padding:14,borderRadius:8,maxHeight:460,overflow:"auto"}}>{result.lrc}</pre></section>}
    </main>
  );
}
