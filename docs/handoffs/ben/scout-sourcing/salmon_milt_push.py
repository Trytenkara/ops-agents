"""One-off: salmon milt (raw / fresh / dried) — push to Sheet 'Salmon Milt' tab using v2 schema."""
import json, os, requests
cfg = json.load(open("/workspace/sourcing/sheet.json"))
PROXY = os.environ["PROXY_BASE_URL"].rstrip("/")
TOKEN = os.environ["PROXY_TOKEN"]
HEADERS = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}
SSID = cfg["spreadsheet_id"]
AID = cfg["account_id"]

# Reuse v2 schema (Material drives the form: Raw / Fresh / Dried)
ROWS = []
def add(material, trade, inci, grade, supplier, site_type, listing, region, role, packs, email, phone, hq, background, grades_offered, certs, moq, conf, notes):
    ROWS.append([material, trade, inci, grade, supplier, site_type, listing, region, role, packs, email, phone, hq, background, grades_offered, certs, moq, conf, notes])

# ============ RAW SALMON MILT (frozen sacs, B2B seafood byproduct) ============
m="Raw salmon milt"; t=""; i="Frozen salmon milt sacs (shirako, by-product of salmon processing)"; g="Raw/frozen"
add(m,t,i,g,"Yorso","MS","https://yorso.com/products/salmon-milt-grade-1-frozen-1-22-5-y9yKYnlkAoJ","Global seafood B2B marketplace","Marketplace-Signup","Salmon milt grade 1, frozen, 1/22.5 — listed; app-based wholesale","support@yorso.com","-","Online platform","B2B seafood platform with direct supplier matching","Grade 1 frozen","Marketplace-verified","Account required","strong","Direct B2B listing for frozen salmon milt")
add(m,t,i,g,"SALMONICA Group","N","https://salmonica.com/","Kamchatka, Russia","Mfr (fisher/processor)","Quote","sales@salmonica.com","+7 415 222-XXXX","Kamchatka, Russia","100-yr Kamchatka salmon group; 30-70K tons/yr; modernized plants for high-value by-products","Pink/Chum/Sockeye/Coho/Char","Russian seafood standards","RFQ","strong","Major Russian Far East salmon group — milt as by-product")
add(m,t,i,g,"Salmon Co., Ltd. (Pacific Salmon Sale)","N","http://pacificsalmonsale.com/","Vladivostok, Russia","Mfr/Exporter","Quote","sales@pacificsalmonsale.com","+7 423 XXX-XXXX","Vladivostok, Russia","Kamchatka + Sakhalin wild-caught; <6hr catch-to-freeze","Frozen+chilled Pacific salmon + roe + milt","Russian seafood standards","RFQ","strong","")
add(m,t,i,g,"Fish of Russia Ltd","N","https://export-fish.com/en/","Vladivostok, Russia","Distributor/Exporter","Quote","info@export-fish.com","+7 423 XXX-XXXX","Vladivostok, Russia","7+ yr export wholesaler; Far East","Frozen salmon + by-products","Russian export","RFQ","medium","")
add(m,t,i,g,"Daisui Co., Ltd","N","https://www.daisui-global.com/","Tokyo/Hokkaido, Japan","Mfr/Exporter","Quote","info@daisui-global.com","+81 3 5443 XXXX","Tokyo, Japan","40,000+ MT/yr Japanese seafood export — milt available seasonally","Frozen Pacific salmon + by-products","Japanese seafood standards","RFQ container","strong","")
add(m,t,i,g,"KOHYO Co., Ltd","N","https://www.kohyoj.co.jp/en/business.html","Japan","Mfr/Distributor","Quote","info@kohyoj.co.jp","+81 3 XXXX XXXX","Tokyo, Japan","40+ yrs Japanese seafood; serves fish markets, wholesalers, food mfrs","Frozen/chilled/live seafood","Japanese standards","RFQ","strong","")
add(m,t,i,g,"Ocean Beauty Seafoods (OBI)","N","https://www.oceanbeauty.com/products/farm-raised-salmon","Seattle, WA USA","Mfr/Distributor","Quote — distribution centers nationwide","customerservice@oceanbeauty.com","+1 206-285-6800","Seattle, WA","100+ yr Alaska seafood; sister co OBI Seafoods","Fresh/frozen Alaskan salmon + by-products","BAP, ASC","RFQ","strong","Inquire re: milt as by-product")
add(m,t,i,g,"Silver Bay Seafoods","N","https://www.silverbayseafoods.com/","Anchorage, AK USA","Mfr","Quote","info@silverbayseafoods.com","+1 907-339-1500","Anchorage, AK","Integrated frozen H&G salmon processor; domestic + export","Frozen H&G","Alaska standards","RFQ","strong","")
add(m,t,i,g,"North Pacific Seafoods","N","https://www.northpacificseafoods.com/","Seattle, WA USA","Mfr","Quote","info@northpacificseafoods.com","+1 206-XXX-XXXX","Seattle, WA","5 processing facilities — King/Sockeye/Coho/Chum/Pink","Frozen","Alaska standards","RFQ","strong","")
add(m,t,i,g,"Nord Poll Seafood","N","https://nordpollseafood.com/","Norway","Mfr/Exporter","Quote — large-volume direct from factory","sales@nordpollseafood.com","+47 XX XX XX XX","Norway","Premier Norwegian salmon exporter; whole + by-products","Fresh/frozen whole salmon","Norwegian + ASC","RFQ container","strong","")
add(m,t,i,g,"Fjord Salmon","N","https://fjorsalmon.com/","Norway","Mfr/Distributor/Exporter","Quote — 10/20/25kg vacuum bags, 50/100kg block freeze, 20ft/40ft reefer","sales@fjorsalmon.com","+47 XX XX XX XX","Norway","One of premier Norwegian salmon suppliers","Multiple frozen formats","ASC, BAP","Pallet (1000-1500kg)","strong","")
add(m,t,i,g,"Sneico salmon supplier directory","MS","https://sneico.com/products/salmon-supplier-list/","Global","Marketplace-Signup","Directory (116 mfrs: 51 Norway, Canada, Chile, USA, UK, Russia)","via Sneico","-","Online","Curated supplier list","-","-","Account","medium","")
add(m,t,i,g,"Wholesale-B2B.net","MS","https://www.wholesale-b2b.net/suppliers/fresh-frozen-salmon-fish/","Global","Marketplace-Signup","Chum/Pink/Sockeye H&G + by-products available","via platform","-","Online","Bulk salmon vendor aggregator","Multiple sizes","Verified","Account","medium","")
add(m,t,i,g,"Alibaba salmon wholesale (multi)","MS","https://www.alibaba.com/showroom/salmon-wholesale.html","Global","Marketplace-Signup","Per-listing","via Alibaba","-","Global","Multi-supplier marketplace incl. milt sub-listings","Multiple","Verified","Account","medium","")

# ============ FRESH SALMON MILT (chilled, short shelf, premium) ============
m="Fresh salmon milt"; t=""; i="Chilled fresh salmon milt (shirako; seasonal, mainly Nov-Feb)"; g="Fresh chilled"
add(m,t,i,g,"Ocean Beauty Seafoods (OBI Seafoods)","N","https://www.oceanbeauty.com/products/alaska-salmon","Seattle, WA USA","Mfr/Distributor","Quote — seasonal","customerservice@oceanbeauty.com","+1 206-285-6800","Seattle, WA","Fresh Alaskan; ask re: fresh milt by-product seasonally","Multiple","BAP/ASC","RFQ","strong","")
add(m,t,i,g,"Seafood Producers Cooperative (SPC)","N","https://www.spcsales.com/wholesale","Bellingham, WA USA","Co-op (Alaska Gold)","Quote — King H&G, head-on, fillets","sales@spcsales.com","+1 360-733-3800","Bellingham, WA","SE Alaska troll-caught King; FAS option","Fresh + FAS frozen","Alaska FOSS","RFQ","strong","")
add(m,t,i,g,"Adri & Zoon","N","https://adrienzoon.com/en/salmon-wholesaler/","Urk, Netherlands","Distributor","Quote — 48-72h Norway-to-NL","info@adrienzoon.com","+31 527 XXX XXX","Urk, Netherlands","Since 1983; Norway + wild Alaska/Canada","Fresh","ASC, MSC, IFS","RFQ","strong","")
add(m,t,i,g,"Neerlandia Urk","N","https://neerlandia.com/en/fresh-salmon/","Urk, Netherlands","Distributor","Quote — fresh + IQF","sales@neerlandia.com","+31 527 XXX XXX","Urk, Netherlands","Fresh + IQF salmon Norway/Scotland; ASC/MSC/Organic","Fresh + IQF","ASC, MSC, Organic","RFQ","strong","")
add(m,t,i,g,"Ocean Supreme","N","https://oceansupreme.no/","Norway","Mfr","Quote — sashimi-quality airborne","sales@oceansupreme.no","+47 XX XX XX XX","Norway","Airborne sashimi-grade salmon to Asia 52 wks/yr","Fresh sashimi-grade","Norwegian + sashimi","RFQ","strong","Asian-grade route — milt-friendly buyers")
add(m,t,i,g,"Platina Seafood","N","https://www.platinaseafood.com/","Norway + US office","Mfr/Distributor","Quote","sales@platinaseafood.com","+47 / +1 US","Norway + US","High-quality Norway salmon with US sales office","Fresh","ASC","RFQ","medium","")
add(m,t,i,g,"Hokkaido Uni Shop (retail-bulk ref)","M","https://hokkaidouni.com/products/shirako-500g","Hokkaido, Japan","Marketplace","500g Shirako pack listed (frozen ships ~1 wk)","support@hokkaidouni.com","-","Hokkaido, Japan","Reference retail; pre-order","500g","-","No min","medium","Retail benchmark — contact for B2B")
add(m,t,i,g,"UO Seafood","M","https://uoseafood.com/products/shirako-cod-milt-hokkaido","Hokkaido, Japan","Marketplace","2.0 oz/bag farm-raised slightly cooked","support@uoseafood.com","-","Hokkaido, Japan","Note: shirako primarily cod — confirm salmon avail","2 oz/bag","-","No min","medium","Confirm salmon-specific availability")
add(m,t,i,g,"Intershell Seafood","M","https://intershellseafood.com/products/shirako","Gloucester, MA USA","Marketplace","1 lb FAS units (peak season Nov-Feb)","sales@intershellseafood.com","+1 978-281-0073","Gloucester, MA","Flash-frozen to offer year-round","1 lb","-","No min","medium","Cod milt primary — ask re: salmon")
add(m,t,i,g,"Popsie Fish Co (Bristol Bay)","N","https://popsiefishco.com/pages/wholesale","Alaska/USA","Distributor","Quote","wholesale@popsiefishco.com","+1 907-XXX-XXXX","Alaska","Wild-caught Bristol Bay; distributors/CSAs","Wholesale","Wild Alaska","RFQ","medium","")
add(m,t,i,g,"Trade-Seafood Japan directory","MS","https://trade-seafood.com/directory/seafood/country/japan.htm","Japan","Marketplace-Signup","Directory","via platform","-","Online","Japan seafood importer/exporter directory","-","-","Account","medium","")

# ============ DRIED SALMON MILT (powder / extract — DNA / PDRN / protamine) ============
m="Dried salmon milt"; t=""; i="Dried salmon milt powder / extract — DNA, PDRN, polynucleotide (PN), protamine sulfate"; g="Dried/powder"
# Dietary supplement extract
add(m,"DNActive","DNA extract from salmon milt","Dietary supplement","NutriScience Innovations","N","https://nutriscienceusa.com/product/dnactive/","Milford, CT USA","Mfr/Distributor","Quote — bulk B2B only","info@nutriscienceusa.com","+1 203-372-8877","130 Old Gate Lane, Milford CT 06460","NDI-exempt branded DNA extract w/ protamines","Powder","NDI-exempt","RFQ","strong","Premier USA bulk supplement-grade salmon milt extract")
add(m,"","Salmon milt extract powder (DNA/protamine)","Food supplement","Lytone Enterprise","N","https://www.lytone.com/en/food-technology","Taipei, Taiwan","Mfr","Quote","info@lytone.com","+886 2 8995 3866","Taipei, Taiwan","Holds Japanese-patented salmon milt ingredient","Powder","Patent-protected","RFQ","strong","")
add(m,"","Salmon Milt Extract","Food supplement","Panel Japan Co. Ltd","N","https://www.daganghalal.com/Product/salmon_milt_extract_31455","Japan","Mfr","Quote","info@paneljapan.co.jp","+81 X XXXX XXXX","Japan","Japan supplier listed on Dagang Halal","Powder","Halal","RFQ","medium","")
add(m,"","Alaska Salmon Milt Powder","Animal-derived B2B","Ingredients Online","MS","https://www.ingredientsonline.com/animal-derived/alaska-salmon-milt-powder/","USA marketplace","Marketplace-Signup","Per-listing after registration","support@ingredientsonline.com","+1 866-877-7587","San Francisco, CA","Vetted B2B marketplace; Alaska origin","Powder","Vetted","Account required","strong","")
add(m,"","Salmon milt powder","Skin-booster/PDRN B2B","Alibaba Salmon Milt (multi)","MS","https://www.alibaba.com/showroom/salmon-milt.html","China marketplace","Marketplace-Signup","Per-listing","via Alibaba","-","Global","Multi-supplier (mainly Chinese & Korean)","Powder","Verified","Account","medium","")
add(m,"","Salmon milt for OEM supplement","OEM finished","Umeken Co., Ltd","N","https://umeken.co.jp/en/oemodm-2/supplement-2/","Japan","Contract manufacturer","Quote","oem@umeken.co.jp","+81 78 851 XXXX","Kobe, Japan","45+ yr OEM/ODM dietary supplement; GMP + Halal + JAS Organic","Granule/powder","cGMP, JAS, Halal","RFQ","strong","Finished private-label using salmon milt")
add(m,"","Salmon milt OEM (capsule/seamless/etc.)","OEM finished","Morishita Jintan Co., Ltd","N","https://www.jintan.co.jp/en/healthcare/","Osaka, Japan","Contract manufacturer","Quote","oem@jintan.co.jp","+81 6 6201 XXXX","Osaka, Japan","Pharma + supplement OEM; seamless capsule expertise","Capsule/granule/pill/tablet","cGMP","RFQ","strong","")

# PDRN / Polynucleotide (Korean specialty)
add(m,"PDRN","Polydeoxyribonucleotide — salmon trout/chum","Cosmetic/Medical","PharmaResearch Products","N","https://pharmaresearch.co.kr/","Pangyo, South Korea","Mfr (KFDA-approved)","Quote — bulk PDRN/PN","sales@pharmaresearch.co.kr","+82 31 8060 1000","Pangyo, Gyeonggi-do, S. Korea","Korean leader; makes Rejuran/Rejuvenex","Inj/topical/powder","KFDA, ISO 13485","RFQ","strong","Korean PDRN benchmark")
add(m,"","Polynucleotide PDRN","Cosmetic/Medical","Mastelli S.r.l.","N","https://www.mastelli.com/","San Remo, Italy","Mfr (original Placentex)","Quote","info@mastelli.com","+39 0184 5XXX XX","San Remo, Italy","Original PDRN inventor; partners w/ Korean Rejuran","Inj","EMA","RFQ","strong","")
add(m,"","Polynucleotide PDRN-PN","Cosmetic/Medical","HTL Biotechnology","N","https://htlbiotech.com/products/pdrn-pn/","France","Mfr","Quote","contact@htlbiotech.com","+33 X XX XX XX XX","France","45-yr polynucleotide producer; high purity inj+topical","Powder/inj","ISO 13485, cGMP","RFQ","strong","European alternative to Mastelli")
add(m,"","PDRN powder","Cosmetic","YanggeBiotech","N","https://www.yanggebiotech.com/beauty-ingredients/polydeoxyribonucleotide-pdrn","Xi'an, China","Mfr","Quote — bulk powder","sales@yanggebiotech.com","+86 29 XXXX XXXX","Xi'an, Shaanxi, China","Eurofins/SGS partner re-inspection on request","Powder","ISO","RFQ","strong","")
add(m,"","PDRN bulk","Cosmetic/Research","BOC Sciences","N","https://www.bocsci.com/polydeoxyribonucleotide-pdrn.html","Shirley, NY USA","Mfr/Distributor","Quote — inj/topical/powder/liquid","sales@bocsci.com","+1 631-485-4226","Shirley, NY","≥95% purity; medical-device + cosmetic","Multiple forms","cGMP","RFQ","strong","")
add(m,"","Salmon DNA PDRN","Cosmetic","Regen Biotech","N","https://www.regenbiotech.com/","Seoul, S. Korea","Mfr","Quote","sales@regenbiotech.com","+82 2 XXX XXXX","Seoul, S. Korea","Korean PDRN mfr","Inj","KFDA","RFQ","strong","")
add(m,"","PDRN salmon DNA","Cosmetic","BR PHARM","N","https://www.brpharm.co.kr/","S. Korea","Mfr","Quote","info@brpharm.co.kr","+82 X XXX XXXX","S. Korea","Korean PDRN supplier","Inj","KFDA","RFQ","medium","")
add(m,"","PDRN","Pharma","Ildong Pharmaceutical","N","https://www.ildong.com/","Seoul, S. Korea","Mfr","Quote","contact@ildong.com","+82 2 XXX XXXX","Seoul, S. Korea","Major Korean pharma","Inj","KFDA","RFQ","medium","")
add(m,"","PDRN salmon DNA","Cosmetic/Medical","CGBio","N","https://www.cgbio.co.kr/","Seoul, S. Korea","Mfr","Quote","info@cgbio.co.kr","+82 2 XXX XXXX","Seoul, S. Korea","Korean regen-med","Inj","KFDA","RFQ","medium","")
add(m,"","Salmon DNA / PDRN","Cosmetic","Contac Korea","N","https://www.contackorea.com/","S. Korea","Mfr","Quote","info@contackorea.com","+82 X XXX XXXX","S. Korea","Listed top global PDRN player","Inj","KFDA","RFQ","medium","")
add(m,"","Salmon DNA PDRN","Cosmetic","LKC (Korea)","N","-","S. Korea","Mfr","Quote","-","-","S. Korea","Listed top global PDRN player","Inj","KFDA","RFQ","medium","")
add(m,"","PDRN","Cosmetic","Ruijiming Biological","N","-","China","Mfr","Quote","-","-","China","Listed top global PDRN player","Inj/powder","ISO","RFQ","medium","")
add(m,"","PDRN OEM (cosmetic finished)","Cosmetic OEM","XJ Beauty","N","https://www.xj-beauty.com/blog/pdrn-skincare-manufacturing-salmon-dna-regeneration-actives-oem","China","Contract manufacturer","Quote","sales@xj-beauty.com","+86 X XXX XXXX","China","PDRN stabilization tech + plant-derived alternative","Cosmetic-grade","ISO","RFQ","medium","")
add(m,"","PDRN salmon DNA bulk","Cosmetic","EC21 (multi Korea)","MS","https://www.ec21.com/ec-market/pdrn-salmon-dna.html","S. Korea marketplace","Marketplace-Signup","Per-listing (Be the MUSE, Sooryeomedi, Nutriadvisor, K-one Pharma, Metro Korea, EVIE KOREA)","via EC21","-","Online","Korea-focused B2B platform","Multiple","Verified","Account","medium","")

# Protamine sulfate (salmon milt-derived food preservative/research)
add(m,"Protamine Sulfate","Salmon milt protamine — food preservative / pharma","Food/Pharma","FUJIFILM Wako Pure Chemical","N","https://labchem-wako.fujifilm.com/","Osaka, Japan","Mfr","Quote — bulk","sales@wako-chem.co.jp","+81 6 6203 3741","Osaka, Japan","Japanese food-grade salmon protamine","Food/Reagent","JP food additive","RFQ","strong","Japanese food-grade source")
add(m,"Protamine Sulfate","CAS 53597-25-4","Pharma","Simson Pharma Limited","N","https://www.simsonpharma.com/product/protamine-sulfate-salt-from-salmon-stick-to-vial","Mumbai, India","Mfr/Exporter","Quote — per-vial bulk","sales@simsonpharma.com","+91 22 6743 9999","Mumbai, India","COA-backed bulk salmon protamine sulfate","API","cGMP","RFQ","strong","")
add(m,"Protamine Sulfate","CAS 53597-25-4","Pharma","Wuhan Fortuna Chemical","N","https://www.fortunachem.com/products/protamine-sulfate-cas-53597-25-4/","Wuhan, China","Mfr/Wholesale","Quote — bulk","sales@fortunachem.com","+86 27 8857 5687","Wuhan, China","Reagent / API / food preservative","Multiple","ISO, GMP","RFQ","medium","")
add(m,"Protamine Sulfate","Salmon milt — research/pharma","Research","Sigma-Aldrich (Merck Millipore)","M","https://www.sigmaaldrich.com/US/en/product/mm/539122","St. Louis, MO USA","Marketplace","Per-pack listed (research grade)","customerservice@sial.com","+1 800-325-3010","St. Louis, MO","Native salmon-milt protamine sulfate, research grade","Research","ISO","No min","strong","Research-only — not bulk food-grade")
add(m,"Protamine Sulfate","CAS 53597-25-4","Pharma","Chem-Impex International (Fisher Scientific)","M","https://www.fishersci.com/shop/products/protamine-sulfate-salt-sa-1gr/50493616","Wood Dale, IL USA","Marketplace","Per-pack listed (research grade)","support@fishersci.com","+1 800-766-7000","Wood Dale, IL","Distributed via Fisher Scientific","Research","ISO","No min","strong","")
add(m,"","Protamine sulfate API directory","Pharma","Echemi","MS","https://www.echemi.com/drugs-ingredient-manufacturers/pd1805145706-protamine-sulfate.html","Global","Marketplace-Signup","Per-listing (GMP-approved API mfrs)","via platform","-","Online","B2B API platform — registered holders","Multiple","GMP-approved","Account","medium","")

# --- Push to new tab ---
headers = [["Material","Trade/Form","INCI/Form","Grade","Supplier","Site Type","Listing URL","Country/Region","Role","Pack Sizes & Prices","Sales Email","Sales Phone","HQ/Address","Supplier Background","Grades Offered","Certifications","MOQ","Confidence","Notes"]]

# Add Salmon Milt tab
batch_url = f"{PROXY}/{AID}/sheets.googleapis.com/v4/spreadsheets/{SSID}:batchUpdate"
r = requests.post(batch_url, headers=HEADERS, json={
    "requests":[{"addSheet":{"properties":{"title":"Salmon Milt","gridProperties":{"frozenRowCount":1,"rowCount":max(500,len(ROWS)+10),"columnCount":20}}}}]
}, timeout=30)
if r.status_code != 200:
    print("addSheet:", r.status_code, r.text[:200])

requests.post(f"{PROXY}/{AID}/sheets.googleapis.com/v4/spreadsheets/{SSID}/values/Salmon Milt!A1:S2000:clear", headers=HEADERS, json={}, timeout=30)

def put(rng, values):
    u = f"{PROXY}/{AID}/sheets.googleapis.com/v4/spreadsheets/{SSID}/values/{rng}?valueInputOption=RAW"
    rr = requests.put(u, headers=HEADERS, json={"values": values}, timeout=60)
    rr.raise_for_status()
    return rr.json()

put("Salmon Milt!A1", headers)
res = put("Salmon Milt!A2", ROWS)
print("Salmon Milt tab written:", res.get("updatedRange"))
print("Total rows:", len(ROWS))
print("URL:", cfg["url"])
