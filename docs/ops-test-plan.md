# Control Room — Ops Test Plan

A scenario-based test plan for the Control Room (ops-agents) app. Each row is a self-contained test case an ops teammate can run end-to-end.

**Live app:** https://ops.tenkara.ai

---

## How to use this file

1. Paste this whole file into Claude with the prompt at the bottom (["Generate the Notion table"](#prompt-for-claude)).
2. Claude returns a table you can paste into a Notion database.
3. Assign each test to a tester, run it, and mark **Pass / Fail / Blocked** with notes.

## Before you start (prerequisites)

- **Roles:** test with at least two accounts — an **admin/ops_lead** (full access) and an **ops_operator** (assigned to one client). Some actions (approve, promote, edit) are role-gated.
- **A real seeded client:** pick a client that has materials, leads, quotes, and at least one expiring quote (e.g. one of the live clients). Empty clients can't exercise most flows.
- **Fleet status:** the background agents may be **paused** — if so, tabs show the last collected data rather than refreshing live. Note in results whether the fleet was running during the test.
- **No writes to Tenkara:** nothing in this app writes back to Tenkara automatically. "Export → upload" steps are manual by design.

## Columns for the Notion table

`Test ID` · `Area / Tab` · `Scenario` · `Steps` · `Expected result` · `Role` · `Priority` · `Status` · `Notes`

Priority: **P1** = core path (must pass to ship) · **P2** = important · **P3** = polish/edge.

---

## Test cases

### Navigation & global

| ID | Area | Scenario | Steps | Expected | Role | Priority |
|----|------|----------|-------|----------|------|----------|
| NAV-01 | Sidebar | Client quick-list + "view all" | Open app → look at left sidebar | Up to 5 assigned clients listed; "View all" link goes to /clients searchable list | any | P2 |
| NAV-02 | Top-right icons | Operators Guide opens | Click the **book** icon top-right | Operators Guide page opens (day-in-the-life, features, agent fleet) | any | P1 |
| NAV-03 | Top-right icons | Settings opens | Click the **cog** icon top-right | Settings page opens | admin/lead | P2 |
| NAV-04 | Tabs | Active tab is highlighted | Click through each client tab | The active tab + sidebar item show the blue brand highlight | any | P3 |
| NAV-05 | Roles | Operator scoping | Log in as ops_operator assigned to one client | Only assigned client(s) visible; agent pages hidden | operator | P1 |

### Overview tab

| ID | Area | Scenario | Steps | Expected | Role | Priority |
|----|------|----------|-------|----------|------|----------|
| OV-01 | Overview | Metric cards count correctly | Open a client → Overview | 6 cards (new leads, drafts, quotes, price changes, cases, approvals) show counts; colored accent when >0, muted at 0 | any | P1 |
| OV-02 | Overview | Cards deep-link to the right tab | Click each metric card | Lands on the correct tab (leads / threads / materials / price-index / cases), not a redirect bounce | any | P1 |

### Client Profile tab

| ID | Area | Scenario | Steps | Expected | Role | Priority |
|----|------|----------|-------|----------|------|----------|
| CP-01 | Profile | Section order | Open Client Profile | Order: Client contact → rep sheet → Client summary → Documents | any | P2 |
| CP-02 | Documents | Upload a text/CSV doc | Documents box → upload a .csv or .txt | File listed; content feeds the AI summary on next generation | admin/lead/op | P2 |
| CP-03 | Documents | Upload a PDF/Excel | Upload a .pdf or .xlsx | File parsed (PDF transcribed, xlsx flattened) and folded into the summary | admin/lead/op | P2 |
| CP-04 | Documents | Pointer to PO upload | Read the Documents helper text | Clear note: spreadsheets here feed the summary; to load purchasing history into orders, use Upload a PO on Materials (link works) | any | P3 |
| CP-05 | Contact | Edit + save | Change purchasing email / priority contact → Save | Saved; persists on reload | admin/lead/op | P2 |

### Materials tab

| ID | Area | Scenario | Steps | Expected | Role | Priority |
|----|------|----------|-------|----------|------|----------|
| MAT-01 | Materials | Sourcing status per material | Open Materials | Each material shows a sourcing status chip | any | P1 |
| MAT-02 | Drill-down | Expand a material | Click a material row | Expands to show Quotes + Orders & uploads, aligned in columns | any | P1 |
| MAT-03 | Quotes | Approve a quote | Expand a material with a pending quote → click **approve** | Quote flips to Approved inline; persists on reload | admin/lead/op | P1 |
| MAT-04 | Quotes | Dismiss a quote | Click **dismiss** on a pending quote | Quote flips to Dismissed | admin/lead/op | P1 |
| MAT-05 | PO upload | Upload a PO (PDF/CSV/Excel) | Upload a PO → wait for parse | Order lines parsed and matched to materials; appear under the material | admin/lead/op | P2 |
| MAT-06 | Sourcing notes | Save notes | Edit Sourcing notes → Save | Saved; persists | admin/lead/op | P3 |
| MAT-07 | No export | Confirm no export button | Look at Materials | No CSV export (platform data) — only the Quotes upload template is relevant | any | P3 |

### Suppliers tab

| ID | Area | Scenario | Steps | Expected | Role | Priority |
|----|------|----------|-------|----------|------|----------|
| SUP-01 | Suppliers | Grouped by approval | Open Suppliers | Suppliers grouped Approved / Pending / Denied / Draft with counts | any | P1 |
| SUP-02 | Suppliers | Filter + sort | Use search, sort, and the Status filter | List filters/sorts correctly; Denied are included and filterable | any | P2 |
| SUP-03 | Suppliers | No export | Confirm | No export button (read-only Tenkara data) | any | P3 |

### Leads tab

| ID | Area | Scenario | Steps | Expected | Role | Priority |
|----|------|----------|-------|----------|------|----------|
| LD-01 | Leads | List loads with type | Open Leads | Suppliers listed with a **Type** column (Marketplace / Direct) and Source badge | any | P1 |
| LD-02 | Type filter | Marketplace filter returns results | Type filter → Marketplace | Shows marketplace leads (derived from supplier is_marketplace or scanner site_type); not empty for a client with marketplace suppliers | any | P1 |
| LD-03 | Type filter | Direct filter | Type filter → Direct | Shows direct/RFQ suppliers | any | P2 |
| LD-04 | Run log | "run ↗" opens agent log | Click **run ↗** on a lead | Opens the agent run activity log (NOT a 404) | admin/monitor | P1 |
| LD-05 | Promote/Drop | Promote a lead | Click Promote on an active lead | Lead promoted toward outreach | admin/lead/op | P2 |
| LD-06 | Promote/Drop | Drop a lead | Click Drop | Lead dropped with reason | admin/lead/op | P2 |
| LD-07 | CSV upload | Upload suppliers CSV | Use the suppliers CSV upload | Rows ingested into the outreach queue with dedup | admin/lead/op | P2 |
| LD-08 | Export | Export filtered CSV | Apply a filter → Export CSV | CSV matches the on-screen filtered rows | any | P3 |

### Live Price Index tab

| ID | Area | Scenario | Steps | Expected | Role | Priority |
|----|------|----------|-------|----------|------|----------|
| PI-01 | Subtabs | Switch Marketplace ↔ Direct | Click the two subtabs | Instant switch (no scroll); each keeps its own filter state | any | P1 |
| PI-02 | Tier ladder | Tiers grouped by material | Open Marketplace re-checks | Rows grouped by material; supplier shown in the **Supplier / source** column; cheapest per-unit first | any | P1 |
| PI-03 | Per-unit | Bulk totals normalized | Inspect a material with big pack sizes | Per-unit price shown where pack size is known; bulk totals flagged "size unknown · bulk total" (not a scary raw number) | any | P2 |
| PI-04 | Re-quote reason | Expiry reason shown | Open Direct re-quotes | Each row shows the **Expires [date]** reason | any | P2 |
| PI-05 | Approve | Approve a price refresh | Click Approve on a marketplace finding | Finding moves to Approved | admin/lead/op | P2 |
| PI-06 | Cross-link | Jump to Threads | Click "All conversations in Threads" | Lands on the All Threads tab | any | P3 |

### All Threads tab

| ID | Area | Scenario | Steps | Expected | Role | Priority |
|----|------|----------|-------|----------|------|----------|
| TH-01 | Threads | List + kind filter | Open All Threads | Drafts listed; filter by outbound / inbound works | any | P1 |
| TH-02 | Draft | Open a draft | Click "Open →" on a draft | Draft/conversation detail opens | admin/lead/op | P1 |
| TH-03 | Scope | Re-quotes excluded | Confirm | Agent-02 re-quotes do NOT appear here (they live on Price Index); description says so | any | P3 |

### Savings tab

| ID | Area | Scenario | Steps | Expected | Role | Priority |
|----|------|----------|-------|----------|------|----------|
| SV-01 | Worksheet | Table loads + filters | Savings → Worksheet | Per-material savings; search/sort/filter work | any | P1 |
| SV-02 | Report | Branded report renders | Savings → Savings report | Per-material cards; avg savings summary; client name header | any | P1 |
| SV-03 | No target price | Market-average fallback | Find a material with no client price | Still shown; labeled "No client price on file — using market average" | any | P2 |
| SV-04 | Freight | Optional landed-cost toggle | Enter freight on a material → toggle "Include freight & tariff" | Savings recompute on a landed basis; OFF by default; toggle only shows when freight data exists | admin/lead/op | P2 |
| SV-05 | Custom prompt | Reshape report | Type e.g. "top 5 cost savings" → Apply | Cards filtered/reordered; numbers unchanged (never invented) | any | P2 |
| SV-06 | PDF export | Print to PDF | Savings report → Print | PDF fills the page width (no big right margin); cards don't split mid-card | any | P1 |
| SV-07 | CSV export | Export savings CSV | Export | CSV matches the report | any | P3 |

### Cases tab

| ID | Area | Scenario | Steps | Expected | Role | Priority |
|----|------|----------|-------|----------|------|----------|
| CS-01 | Cases | Stale leads listed | Open Cases | Escalated stale leads with recommended action + days stale | any | P2 |
| CS-02 | Resolve | Resolve a case | Click Resolve | Case marked resolved; drops off the list | admin/lead/op | P2 |

### Operators Guide

| ID | Area | Scenario | Steps | Expected | Role | Priority |
|----|------|----------|-------|----------|------|----------|
| GD-01 | Guide | Three sections render | Open via book icon | Day-in-the-life, features-by-tab table, and the 14-agent fleet table all render | any | P2 |
| GD-02 | Guide | Agent attribution matches | Compare guide's agent list to the "⚙ Collected by" lines on each tab | Consistent | any | P3 |

### Exports & Tenkara templates

| ID | Area | Scenario | Steps | Expected | Role | Priority |
|----|------|----------|-------|----------|------|----------|
| EX-01 | Quotes export | Export is in template format | Approve some quotes → run the staged-quotes CSV export | CSV columns match the Tenkara quotes bulk-upload template (filled + blank columns); uploads cleanly to Tenkara | admin/lead | P1 |
| EX-02 | Roundtrip | Upload to Tenkara | Take the exported CSV → upload via Tenkara bulk upload | Imports without column-shift errors | admin/lead | P2 |

---

## Prompt for Claude

> I'm building a test tracker in Notion for our Control Room app. Below is a markdown test plan. Convert **every** test case (across all sections) into a single flat table with these columns: **Test ID, Area / Tab, Scenario, Steps, Expected result, Role, Priority, Status, Notes**. Leave **Status** and **Notes** blank for the tester to fill. Keep Steps concise (one line, arrow-separated). Sort by Priority (P1 first), then Test ID. Output as a markdown table I can paste into Notion.
>
> [paste this whole file]

## Suggested first-pass run order

Run **all P1s** first as a smoke test (NAV-02/05, OV-01/02, MAT-01/02/03/04, SUP-01, LD-01/02/04, PI-01/02, TH-01/02, SV-01/02/06, EX-01). If those pass, the core operator journey is healthy. Then sweep P2s, then P3s.
