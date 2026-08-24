import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  try {
    const key = String(process.env.OPENAI_API_KEY || "");
    if (!key) return NextResponse.json({ ok:false, error:"OPENAI_API_KEY fehlt" }, { status:500 });
    const r = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
      cache: "no-store",
    });
    const text = await r.text();
    return NextResponse.json({ ok:r.ok, status:r.status, body:text.slice(0,500) }, { status:r.ok?200:500 });
  } catch (e:any) {
    return NextResponse.json({ ok:false, error:e?.message || String(e), cause:e?.cause?.message || null }, { status:500 });
  }
}
