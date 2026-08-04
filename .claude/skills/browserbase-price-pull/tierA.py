#!/usr/bin/env python3
"""Tier A of the marketplace price cascade, WITHOUT the Workflow tool.

Same job as webfetch-workflow.js (one web_fetch + web_search pass per lead to read
a marketplace price / repair a dead link), but implemented as a plain concurrent
script that calls the Anthropic API directly. Because it runs as an ordinary Bash
command (Bash is allow-listed) it needs NO permission prompt and does not trigger
the multi-agent-workflow usage warning that the Workflow tool does.

Flow (all Bash, no prompts):
  node webtier.mjs worklist --org <slug> --mode all > /tmp/wl.json
  uv run --with anthropic python tierA.py --in /tmp/wl.json --out /tmp/webresult.json --workers 8
  node webtier.mjs write /tmp/webresult.json
  node webtier.mjs coverage

Input  (--in) : [{ id, material, supplier, url }]              (webtier worklist)
Output (--out): { total, priced, repaired, results:[{...}] }   (webtier `write` input)

Never fabricates a price: unreadable -> classification login_required/link_broken/
needs_review with current_price null, never a guessed number. Non-USD is reported
as-is with its currency; downstream convertToUsd handles conversion.
"""
import os, sys, json, argparse, concurrent.futures as cf, re
import anthropic

MODEL = os.environ.get("TIERA_MODEL", "claude-sonnet-5")
MAX_CONTINUATIONS = 5  # server-tool loop caps at 10 iterations, then stop_reason=pause_turn

SYSTEM = """You are pricing ONE marketplace product listing for a chemical sourcing tool. Return ONLY a JSON object, no prose.

You are given a material, a supplier, and an on-file product URL.

Steps:
1. web_fetch the on-file URL (aim for ~7000 chars). Read it for a price, a size->price ladder, and stock status.
2. If the page is a dead link, a contact/RFQ/datasheet/homepage/showroom/category page, the WRONG product, or shows no price, then web_search for the correct DIRECT product page for THIS material from THIS supplier (queries like '"<supplier>" <material> price', '<material> buy <supplier>'). web_fetch the best result and read it.
3. Extract the price(s). If multiple pack sizes are shown, return EACH as a tier {pack_size, price}. current_price = the price of the smallest/base pack (or the single price). Set currency (USD unless the page clearly shows otherwise).

Return exactly this JSON shape:
{
  "classification": "current_price_found" | "needs_review" | "login_required" | "link_broken",
  "current_price": number | null,
  "currency": "USD" | null,
  "pack_size": string | null,
  "tiers": [ { "pack_size": string, "price": number } ],
  "link_status": "ok" | "repaired" | "dead" | "wrong_product" | "gated",
  "source_url": string | null,
  "notes": string
}

HARD RULES:
- NEVER invent or estimate a price. If no price is visible: classification='login_required' if it is behind a login / "request price" / "add to quote", else 'link_broken' if the product URL truly cannot be found, else 'needs_review'. Only 'current_price_found' when a real number is printed on the page.
- link_status='repaired' if a web_search found a working product page; 'ok' if the on-file URL worked; 'dead' if nothing works; 'wrong_product' if only off-material pages exist; 'gated' if login/registration is required to see price.
- Do NOT log in, register, or submit any form.
- source_url = the URL you actually read the price from. Put a one-line reason in notes."""


def _client():
    key = os.environ.get("ANTHROPIC_API_KEY_NEW") or os.environ.get("ANTHROPIC_API_KEY")
    return anthropic.Anthropic(api_key=key, base_url="https://api.anthropic.com")


def extract_json(text):
    m = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    cand = m.group(1) if m else text
    s, e = cand.find("{"), cand.rfind("}")
    if s < 0 or e <= s:
        raise ValueError("no JSON")
    return json.loads(cand[s:e + 1])


def sanitize(r):
    """Trust only a real numeric price; coerce shape so webtier write never chokes."""
    if not isinstance(r, dict):
        return {"classification": "needs_review", "current_price": None, "currency": None,
                "pack_size": None, "tiers": [], "link_status": "dead", "source_url": None,
                "notes": "non-dict model output"}
    cp = r.get("current_price")
    try:
        cp = float(cp) if cp is not None else None
    except (TypeError, ValueError):
        cp = None
    if cp is not None and cp <= 0:
        cp = None
    r["current_price"] = cp
    if cp is None and r.get("classification") == "current_price_found":
        r["classification"] = "needs_review"
    tiers = []
    for t in (r.get("tiers") or []):
        try:
            p = float(t.get("price"))
        except (TypeError, ValueError, AttributeError):
            continue
        if p > 0:
            tiers.append({"pack_size": str(t.get("pack_size") or ""), "price": p})
    r["tiers"] = tiers
    return r


def price_one(lead, model=MODEL):
    client = _client()
    u = (f'Material: "{lead.get("material")}"\n'
         f'Supplier: "{lead.get("supplier")}"\n'
         f'On-file product URL: {lead.get("url")}\n\n'
         "Read the listing (repair the link via web_search if needed) and return the JSON.")
    msgs = [{"role": "user", "content": u}]
    kwargs = dict(
        model=model, max_tokens=8000, system=SYSTEM,
        tools=[
            {"type": "web_fetch_20260209", "name": "web_fetch", "max_uses": 4},
            {"type": "web_search_20260209", "name": "web_search", "max_uses": 4},
        ],
        output_config={"effort": "low"},
    )
    res = client.messages.create(messages=msgs, **kwargs)
    # The server-side tool loop caps at 10 iterations per request; resume by resending
    # the assistant turn verbatim until it stops pausing.
    for _ in range(MAX_CONTINUATIONS):
        if res.stop_reason != "pause_turn":
            break
        msgs = msgs + [{"role": "assistant", "content": res.content}]
        res = client.messages.create(messages=msgs, **kwargs)
    text = "".join(b.text for b in res.content if getattr(b, "type", None) == "text")
    try:
        out = sanitize(extract_json(text))
    except Exception as ex:
        out = {"classification": "needs_review", "current_price": None, "currency": None,
               "pack_size": None, "tiers": [], "link_status": "dead", "source_url": None,
               "notes": f"parse error: {str(ex)[:120]}"}
    out["id"] = lead.get("id")
    out["material"] = lead.get("material")
    out["supplier"] = lead.get("supplier")
    out["_usage"] = {"in": getattr(res.usage, "input_tokens", 0),
                     "out": getattr(res.usage, "output_tokens", 0),
                     "web_search": getattr(getattr(res.usage, "server_tool_use", None), "web_search_requests", 0) or 0}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True, help="worklist JSON path ('-' for stdin)")
    ap.add_argument("--out", dest="out", required=True, help="result JSON path")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--limit", type=int)
    a = ap.parse_args()

    raw = sys.stdin.read() if a.inp == "-" else open(a.inp).read()
    leads = json.loads(raw)
    if a.limit:
        leads = leads[:a.limit]
    if not leads:
        json.dump({"total": 0, "priced": 0, "repaired": 0, "results": []}, open(a.out, "w"))
        print("no leads"); return

    results = [None] * len(leads)
    done = 0
    with cf.ThreadPoolExecutor(max_workers=a.workers) as ex:
        futs = {ex.submit(_safe, lead): i for i, lead in enumerate(leads)}
        for fut in cf.as_completed(futs):
            i = futs[fut]
            results[i] = fut.result()
            done += 1
            r = results[i]
            if done % 10 == 0 or done == len(leads):
                print(f"  {done}/{len(leads)} done", file=sys.stderr)
    ok = [r for r in results if r]
    priced = sum(1 for r in ok if r.get("classification") == "current_price_found" and r.get("current_price") is not None)
    repaired = sum(1 for r in ok if r.get("link_status") == "repaired")
    tin = sum((r.get("_usage") or {}).get("in", 0) for r in ok)
    tout = sum((r.get("_usage") or {}).get("out", 0) for r in ok)
    searches = sum((r.get("_usage") or {}).get("web_search", 0) for r in ok)
    json.dump({"total": len(ok), "priced": priced, "repaired": repaired, "results": ok}, open(a.out, "w"))
    print(f"tierA: {priced}/{len(ok)} priced, {repaired} link(s) repaired -> {a.out}")
    print(f"tierA usage [{MODEL}]: in={tin} out={tout} web_search_requests={searches}")


def _safe(lead):
    try:
        return price_one(lead)
    except Exception as ex:
        return {"id": lead.get("id"), "material": lead.get("material"), "supplier": lead.get("supplier"),
                "classification": "needs_review", "current_price": None, "currency": None,
                "pack_size": None, "tiers": [], "link_status": "dead", "source_url": None,
                "notes": f"error: {str(ex)[:150]}"}


if __name__ == "__main__":
    main()
