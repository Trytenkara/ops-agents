"""Push the materials list onto the Materials tab."""
import json, os, requests

cfg = json.load(open("/workspace/sourcing/sheet.json"))
mats = json.load(open("/workspace/sourcing/materials.json"))
PROXY = os.environ["PROXY_BASE_URL"].rstrip("/")
TOKEN = os.environ["PROXY_TOKEN"]
HEADERS = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}

rows = []
for m in mats:
    rows.append([
        m["name"],
        m.get("trade_name") or "",
        m.get("inci") or "",
        ",".join(m["search_by"]) if m["search_by"] else "",
        m["vol_lb"],
        0,
        "pending",
    ])

u = f"{PROXY}/{cfg['account_id']}/sheets.googleapis.com/v4/spreadsheets/{cfg['spreadsheet_id']}/values/Materials!A2?valueInputOption=RAW"
r = requests.put(u, headers=HEADERS, json={"values": rows}, timeout=30)
r.raise_for_status()
print("OK", r.json().get("updatedRange"))
