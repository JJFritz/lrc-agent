import { NextResponse } from "next/server";

export const runtime = "nodejs";

function getConfig() {
  const baseUrl = String(process.env.NEXTCLOUD_URL || "").replace(/\/+$/, "");
  const username = String(process.env.NEXTCLOUD_USERNAME || "");
  const appPassword = String(process.env.NEXTCLOUD_APP_PASSWORD || "");
  const rawPath = String(process.env.NEXTCLOUD_LRC_PATH || "/LRC-Agent");
  const folderPath = `/${rawPath.split("/").filter(Boolean).map(encodeURIComponent).join("/")}`;
  if (!baseUrl || !username || !appPassword) throw new Error("Nextcloud-Konfiguration ist unvollständig.");
  return { baseUrl, username, appPassword, folderPath };
}

function davUrl(c: ReturnType<typeof getConfig>, relative: string) {
  const user = encodeURIComponent(c.username);
  const suffix = `/${relative.split("/").filter(Boolean).map(encodeURIComponent).join("/")}`;
  return `${c.baseUrl}/remote.php/dav/files/${user}${c.folderPath}${suffix}`;
}

export async function GET(req: Request) {
  try {
    const u = new URL(req.url);
    const file = u.searchParams.get("file") || "";
    if (!/^(out|done)\/[\w\W]+\.(lrc|srt|txt|lyrics)$/i.test(file)) {
      return NextResponse.json({ ok:false, error:"Ungültiger Dateipfad." }, { status:400 });
    }
    const c = getConfig();
    const r = await fetch(davUrl(c, file), {
      headers: { Authorization: `Basic ${Buffer.from(`${c.username}:${c.appPassword}`, "utf8").toString("base64")}` },
      cache: "no-store",
    });
    if (!r.ok) throw new Error(`Datei konnte nicht gelesen werden (${r.status}).`);
    const text = await r.text();
    return new NextResponse(text, { status:200, headers:{ "Content-Type":"text/plain; charset=utf-8", "Cache-Control":"no-store" } });
  } catch (e:any) {
    return NextResponse.json({ ok:false, error:e?.message || "Unbekannter Fehler." }, { status:500 });
  }
}
