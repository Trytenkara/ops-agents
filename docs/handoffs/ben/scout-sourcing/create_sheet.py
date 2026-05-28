"""Create the sourcing Google Sheet for Vita Organica."""
import json, os, sys, requests

ACCOUNT_ID = "6aabc0af-5c17-4754-8bb5-feab0ed3bd9e"
PROXY = os.environ["PROXY_BASE_URL"].rstrip("/")
TOKEN = os.environ["PROXY_TOKEN"]
HEADERS = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}

# 1. Create spreadsheet
create_url = f"{PROXY}/{ACCOUNT_ID}/sheets.googleapis.com/v4/spreadsheets"
body = {
    "properties": {"title": "Vita Organica – Supplier Sourcing"},
    "sheets": [
        {"properties": {"title": "Suppliers", "gridProperties": {"frozenRowCount": 1}}},
        {"properties": {"title": "Materials"}},
        {"properties": {"title": "Notes"}},
    ],
}
r = requests.post(create_url, headers=HEADERS, json=body, timeout=30)
r.raise_for_status()
ss = r.json()
ssid = ss["spreadsheetId"]
url = ss["spreadsheetUrl"]
print("SPREADSHEET_ID:", ssid)
print("URL:", url)

# 2. Write headers to Suppliers tab
supplier_headers = [[
    "Material",
    "Trade Name",
    "INCI / Botanical",
    "Supplier Name",
    "Website",
    "Country/Region",
    "Pack Sizes",
    "Price (if listed)",
    "Distributor / Manufacturer",
    "Listing URL",
    "Contact (sales)",
    "Notes",
    "Confidence (strong/medium/lead)",
]]
mat_headers = [[
    "Material",
    "Trade Name",
    "INCI / Botanical",
    "Search Keys",
    "Annual Vol (lb)",
    "Suppliers Found",
    "Status",
]]
notes_headers = [["Note"]]

def put(rng, values):
    u = f"{PROXY}/{ACCOUNT_ID}/sheets.googleapis.com/v4/spreadsheets/{ssid}/values/{rng}?valueInputOption=RAW"
    rr = requests.put(u, headers=HEADERS, json={"values": values}, timeout=30)
    rr.raise_for_status()

put("Suppliers!A1", supplier_headers)
put("Materials!A1", mat_headers)
put("Notes!A1", notes_headers)
print("HEADERS_WRITTEN")

# Save id for downstream scripts
with open("/workspace/sourcing/sheet.json", "w") as f:
    json.dump({"spreadsheet_id": ssid, "url": url, "account_id": ACCOUNT_ID}, f)
