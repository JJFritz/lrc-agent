import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 300;

type NcConfig = {
  baseUrl: string;
  username: string;
  appPassword: string;
  folderPath: string;
};

function getConfig(): NcConfig {
  const baseUrl = String(process.env.NEXTCLOUD_URL || "").replace(/\/+$/, "");
  const username = String(process.env.NEXTCLOUD_USERNAME || "");
  const appPassword = String(process.env.NEXTCLOUD_APP_PASSWORD || "");
  const rawPath = String(process.env.NEXTCLOUD_LRC_PATH || "/LRC-Agent");
  const folderPath = `/${rawPath.split("/").filter(Boolean).map(encodeURIComponent).join("/")}`;

  if (!baseUrl || !username || !appPassword) {
    throw new Error("Nextcloud-Konfiguration ist unvollständig.");
  }
  return { baseUrl, username, appPassword, folderPath };
}

function authHeader(c: NcConfig) {
  return `Basic ${Buffer.from(`${c.username}:${c.appPassword}`, "utf8").toString("base64")}`;
}

function davUrl(c: NcConfig, relative = "") {
  const user = encodeURIComponent(c.username);
  const suffix = relative
    ? `/${relative.split("/").filter(Boolean).map(encodeURIComponent).join("/")}`
    : "";
  return `${c.baseUrl}/remote.php/dav/files/${user}${c.folderPath}${suffix}`;
}

function decodeHrefName(href: string) {
  try {
    const decoded = decodeURIComponent(href);
    return decoded.replace(/\/$/, "").split("/").pop() || "";
  } catch {
    return href.replace(/\/$/, "").split("/").pop() || "";
  }
}

async function listFolder(c: NcConfig) {
  const r = await fetch(davUrl(c), {
    method: "PROPFIND",
    headers: {
      Authorization: authHeader(c),
      Depth: "1",
      "Content-Type": "application/xml; charset=utf-8",
    },
    body: `<?xml version="1.0" encoding="utf-8" ?>
      <d:propfind xmlns:d="DAV:">
        <d:prop>
          <d:resourcetype />
          <d:getcontentlength />
          <d:getlastmodified />
        </d:prop>
      </d:propfind>`,
    cache: "no-store",
  });

  if (!r.ok && r.status !== 207) {
    throw new Error(`Nextcloud-Zugriff fehlgeschlagen (${r.status} ${r.statusText}).`);
  }

  const xml = await r.text();
  const responses = xml.match(/<(?:d:)?response\b[\s\S]*?<\/(?:d:)?response>/gi) || [];
  const items = responses.map((block) => {
    const href = block.match(/<(?:d:)?href>([\s\S]*?)<\/(?:d:)?href>/i)?.[1] || "";
    const isCollection = /<(?:d:)?collection\s*\/?\s*>/i.test(block);
    const size = Number(block.match(/<(?:d:)?getcontentlength>(\d+)<\/(?:d:)?getcontentlength>/i)?.[1] || 0);
    const modified = block.match(/<(?:d:)?getlastmodified>([\s\S]*?)<\/(?:d:)?getlastmodified>/i)?.[1] || "";
    return { name: decodeHrefName(href), href, isCollection, size, modified };
  });

  const folderName = decodeURIComponent(c.folderPath.split("/").filter(Boolean).pop() || "");
  return items.filter((x) => x.name && x.name !== folderName);
}

export async function GET() {
  try {
    const c = getConfig();
    const items = await listFolder(c);
    return NextResponse.json({
      ok: true,
      folder: decodeURIComponent(c.folderPath),
      files: items.filter((x) => !x.isCollection).map(({ name, size, modified }) => ({ name, size, modified })),
      folders: items.filter((x) => x.isCollection).map(({ name, modified }) => ({ name, modified })),
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "Unbekannter Fehler." }, { status: 500 });
  }
}
