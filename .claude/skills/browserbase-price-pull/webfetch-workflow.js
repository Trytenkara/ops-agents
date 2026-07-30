// TIER A of the marketplace-pull cascade: the cheap web layer that FRONTS
// Browserbase (Ben-style). One subagent per lead, each using mcp__web__web_fetch
// (+ mcp__web__web_search to repair dead/wrong/gated URLs), returning a strict
// price schema. This is the highest-yield, cheapest first pass — it prices SSR
// storefronts and, crucially, REPAIRS broken links (Contact-Us forms, PDFs,
// homepages, dead marketplaces) that Browserbase can't recover.
//
// Run it with the Workflow tool, passing the lead worklist as `args`:
//   node webtier.mjs worklist --org california-chemicals [--mode residue|all]  → prints the JSON worklist
//   Workflow({ scriptPath: ".../webfetch-workflow.js", args: <that JSON array> })
//   node webtier.mjs write <workflow-result.json>                              → writes results via writePull
//
// args: [{ id, material, supplier, url }]
// returns: { total, priced, repaired, results: [{ id, material, supplier, ...schema }] }
export const meta = {
  name: 'marketplace-webfetch-enrich',
  description: 'Tier A (web_fetch + web_search) marketplace price enrichment — the cheap web layer that fronts Browserbase; schema JSON out',
  phases: [{ title: 'Enrich', detail: 'one subagent per lead: web_fetch the URL, web_search to repair dead/wrong links, extract price ladder' }],
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    classification: { type: 'string', enum: ['current_price_found', 'needs_review', 'login_required', 'link_broken'] },
    current_price: { type: ['number', 'null'] },
    currency: { type: ['string', 'null'] },
    pack_size: { type: ['string', 'null'] },
    tiers: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { pack_size: { type: 'string' }, price: { type: 'number' } }, required: ['pack_size', 'price'] } },
    link_status: { type: 'string', enum: ['ok', 'repaired', 'dead', 'wrong_product', 'gated'] },
    source_url: { type: ['string', 'null'] },
    notes: { type: 'string' },
  },
  required: ['classification', 'tiers', 'link_status', 'source_url'],
}

const leads = Array.isArray(args) ? args : []
if (!leads.length) return { total: 0, priced: 0, repaired: 0, results: [] }

phase('Enrich')

const results = await pipeline(
  leads,
  (lead) =>
    agent(
      `You are pricing ONE marketplace listing for a chemical sourcing tool. Return ONLY the required JSON.\n\n` +
        `Material: "${lead.material}"\nSupplier: "${lead.supplier}"\nOn-file product URL: ${lead.url}\n\n` +
        `Load and use the tools mcp__web__web_fetch and mcp__web__web_search (find their schemas with the tool search first).\n\n` +
        `Steps:\n` +
        `1. web_fetch the on-file URL (maxChars ~7000). Read for a price / size-price ladder / stock.\n` +
        `2. If the page is a dead link, a contact/RFQ/datasheet/homepage/showroom page, the WRONG product, or shows no price, then web_search for the correct DIRECT product page for this material from this supplier (queries like '"${lead.supplier}" ${lead.material} price', '${lead.material} buy ${lead.supplier}'). web_fetch the best result and read it. link_status='repaired' if a search found a working product page, 'dead' if nothing works, 'wrong_product' if only off-material pages exist.\n` +
        `3. Extract the price(s). If multiple pack sizes are shown, return EACH as a tier {pack_size, price}. current_price = the price of the smallest/base pack (or the single price). Set currency (USD unless clearly otherwise).\n` +
        `HARD RULES: NEVER invent or estimate a price. If no price is visible: classification='login_required' if behind a login/"request price", else 'link_broken' if the URL/product truly cannot be found, else 'needs_review'. Only 'current_price_found' when a real number is on the page. Do NOT log in, register, or submit any form.\n` +
        `source_url = the URL you actually read the price from. One-line reason in notes.`,
      { label: `web:${(lead.supplier || '').slice(0, 24)}`, phase: 'Enrich', schema: SCHEMA, agentType: 'general-purpose' },
    ).then((r) => (r ? { ...r, id: lead.id, material: lead.material, supplier: lead.supplier } : null)),
)

const ok = results.filter(Boolean)
const priced = ok.filter((r) => r.classification === 'current_price_found' && r.current_price != null)
const repaired = ok.filter((r) => r.link_status === 'repaired')
log(`web-fetch tier: ${priced.length}/${ok.length} priced, ${repaired.length} link(s) repaired`)
return { total: ok.length, priced: priced.length, repaired: repaired.length, results: ok }
