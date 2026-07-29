// Proof that each proxied session gets a fresh residential exit IP (the ban
// workaround). Opens N sessions, prints each exit IP, and reports how many were
// distinct.  node check-rotation.mjs [count]
import { openSession, US_GEOS } from "./src/session.mjs";

const count = Number(process.argv[2] ?? 3);

async function exitIp(geolocation) {
  const s = await openSession({ geolocation });
  try {
    await s.page.goto("https://api.ipify.org?format=json", { timeout: 45000, waitUntil: "domcontentloaded" });
    const txt = await s.page.evaluate(() => document.body.innerText);
    return { ip: JSON.parse(txt).ip, view: s.viewUrl };
  } finally {
    await s.browser.close().catch(() => {});
  }
}

const runs = [];
for (let i = 0; i < count; i++) {
  const geo = US_GEOS[i % US_GEOS.length];
  const label = geo ? `${geo.city}` : "auto-US";
  const r = await exitIp(geo).catch((e) => ({ error: String(e?.message ?? e) }));
  console.log(`session ${i + 1} (${label}): ${r.ip ?? "ERROR " + r.error}`);
  runs.push(r);
}
const ips = new Set(runs.map((r) => r.ip).filter(Boolean));
console.log(`\ndistinct exit IPs: ${ips.size}/${runs.filter((r) => r.ip).length} successful`);
