---
title: Ben handoff — reference artifacts
---

# Ben handoff

These are reference artifacts from Ben's SuperAgent workspaces, dropped into
Tackle Box so the agents that cover the same surface area have ground truth to
compare against. **None of this code runs in Tackle Box** — it's reference
material for tuning agents 02 and 05.

## marketplace-rate-checks/

Output of Ben's manual marketplace-rate-check passes against Tenkara quotes.
Format: one Markdown report per run, columns = quotes checked, changes
detected, needs review, unchanged, with per-quote before/after pricing and the
quote UUID.

**Related agent**: Agent 02 (Quote Revalidation). Use as a comparison set when
tuning the weekly revalidation draft — same surface, different cadence.

## scout-sourcing/

Python scripts + JSON state from Ben's Material Sourcing Scout workspace.
`build_v2.py` etc. populate a "Suppliers v2" Google Sheet tab with 19 columns
(Material / Trade / INCI / Grade / Supplier / Site Type M-MS-N / Listing URL /
Country / Role / Pack Sizes / Sales Email / Phone / HQ / Background /
Grades Offered / Certifications / MOQ / Confidence / Notes).
`materials_v2.json` is the 26-material seed list (sports-nutrition stack).

**Related agent**: Agent 05 (Marketplace Validation). Ben's site-type
classification (M = marketplace listing, MS = marketplace + supplier site,
N = supplier-direct) is a richer drift signal than our current
`catalog_drift='no_longer_listed'` flag. Worth considering as a feature when
Agent 05 graduates from training wheels.
