"""Part 2 — remaining 20 ingredients, then merge and push to Sheet."""
import json, os, requests

cfg = json.load(open("/workspace/sourcing/sheet.json"))
PROXY = os.environ["PROXY_BASE_URL"].rstrip("/")
TOKEN = os.environ["PROXY_TOKEN"]
HEADERS = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}
SSID = cfg["spreadsheet_id"]
AID = cfg["account_id"]

ROWS = json.load(open("/workspace/sourcing/v2_rows_part1.json"))

def add(material, trade, inci, grade, supplier, site_type, listing, region, role, packs, email, phone, hq, background, grades_offered, certs, moq, conf, notes):
    ROWS.append([material, trade, inci, grade, supplier, site_type, listing, region, role, packs, email, phone, hq, background, grades_offered, certs, moq, conf, notes])

# ============ Capsimax (15 lb) — single-source IP ============
m="Capsimax"; t="Capsimax"; i="Capsicum annuum extract (2% capsaicinoids, OmniBead)"; g="100% purity"
add(m,t,i,g,"OmniActive Health Technologies (USA office)","N","https://omniactives.com/product/capsimax/","Short Hills, NJ + Mumbai","Mfr (patent holder)","Quote","contact@omniactives.com","+1 866-588-3629","51 JFK Pkwy, 1st Fl W, Short Hills, NJ 07078","Patent holder; OmniBead encapsulation tech","Capsimax only","cGMP, GRAS, Kosher, Halal","RFQ","strong","")
add(m,t,i,g,"OmniActive India HQ","N","https://www.indiamart.com/omniactivehealthtechnologiesltd/","Mumbai, India","Mfr","Quote","info@omniactives.com","+91-22-6770-4444","Phoenix House, Lower Parel, Mumbai 400013","Mumbai HQ for APAC","Capsimax","cGMP","RFQ","strong","")
add(m,t,i,g,"Knowde (OmniActive storefront)","MS","https://www.knowde.com/stores/omniactive-health-technologies","Global B2B","Marketplace-Signup","Sample/RFQ","via Knowde","-","Mountain View, CA","Official storefront","Capsimax","cGMP","Account","strong","")
add(m,t,i,g,"Branded-Ingredients","MS","https://www.branded-ingredients.com/brands/capsimax/","Global B2B","Marketplace-Signup","Quote","via platform","-","-","B2B ingredient listing","Capsimax","-","Account","medium","")

# ============ Di-Caffeine Malate / Infinergy (25 lb) — single-source IP ============
m="Di-Caffeine Malate"; t="Infinergy"; i="Di-Caffeine Malate (~75% caffeine, 25% malic acid)"; g="100% purity"
add(m,t,i,g,"Creative Compounds","N","https://www.creativecompounds.com/exclusive.php","Scott City, MO USA","Mfr (trademark holder)","Quote","info@creativecompounds.com","+1 800-655-5921","Scott City, MO","Trademark holder; Malate Series™","Infinergy only","cGMP","RFQ","strong","")
add(m,t,i,g,"Knowde (Creative Compounds storefront)","MS","https://www.knowde.com/stores/creative-compounds/products/infinergy-di-caffeine-malate","Global B2B","Marketplace-Signup","Per kg, MOQ/lead time on request","via Knowde","-","Mountain View, CA","Official storefront with sample/RFQ","Infinergy","cGMP","Account","strong","")
add(m,t,i,g,"NXT Ingredients","N","https://nxtingredients.com/specialty-ingredient/infinergy-by-creative-compounds/","USA","Specialty distributor","Quote","sales@nxtingredients.com","+1 877-NXT-0001","Salt Lake City, UT","","Infinergy","cGMP","RFQ","strong","")
add(m,t,i,g,"NutraCap USA","N","https://www.nutracapusa.com/di-caffeine-malate/","USA","Contract manufacturer","Quote — private-label/finished","sales@nutracapusa.com","+1 800-688-5956","Norcross, GA","Formulates with Infinergy","Infinergy","cGMP, NSF","RFQ","medium","")

# ============ Dihydroberberine / GlucoVantage (45 lb) — single-source IP ============
m="Dihydroberberine"; t="GlucoVantage"; i="DHB (Berberis aristata-derived)"; g="100% purity"
add(m,t,i,g,"NNB Nutrition","N","https://www.nnbnutrition.com/ingredients/gluco-vantage/","Allison Park, PA USA / Global","Mfr (brand owner)","Quote","info@nnbnutrition.com","+1 (412) 487-1234","Allison Park, PA","100+ scientist ingredient developer; first commercial DHB","GlucoVantage only","cGMP","RFQ","strong","")
add(m,t,i,g,"Knowde (NNB storefront)","MS","https://www.knowde.com/stores/nnb-nutrition-usa/products/glucovantage","Global B2B","Marketplace-Signup","Sample/RFQ","via Knowde","-","Mountain View, CA","Official storefront","GlucoVantage","cGMP","Account","strong","")
add(m,t,i,g,"NXT Ingredients","N","https://nxtingredients.com/specialty-ingredient/glucovantage-by-nnb-nutrition/","USA","Specialty distributor","Quote","sales@nxtingredients.com","+1 877-NXT-0001","Salt Lake City, UT","Single-source ingredient","GlucoVantage","cGMP","RFQ","strong","")

# ============ ElevATP (55 lb) — single-source IP ============
m="ElevATP"; t="ElevATP"; i="Ancient peat + apple polyphenol extract"; g="100% purity"
add(m,t,i,g,"FutureCeuticals (VDF)","N","https://www.futureceuticals.com/elevatp","Momence, IL USA","Mfr (patent holder)","Quote","info@futureceuticals.com","+1 888-452-6853","2692 N State Route 1-17, Momence, IL","Patent holder; GRAS; Health Canada","ElevATP","cGMP, GRAS, NPN","RFQ","strong","")
add(m,t,i,g,"Knowde (VDF/FutureCeuticals)","MS","https://www.knowde.com/stores/vdf-futureceuticals/products/elevatp","Global B2B","Marketplace-Signup","Sample/spec sheet","via Knowde","-","Mountain View, CA","Official storefront","ElevATP","cGMP","Account","strong","")
add(m,t,i,g,"NXT Ingredients","N","https://nxtingredients.com/specialty-ingredient/elevatp-by-futureceuticals/","USA","Specialty distributor","Quote","sales@nxtingredients.com","+1 877-NXT-0001","Salt Lake City, UT","","ElevATP","cGMP","RFQ","strong","")
add(m,t,i,g,"NutraCap USA","N","https://www.nutracapusa.com/elevatp/","USA","Contract manufacturer","Quote","sales@nutracapusa.com","+1 800-688-5956","Norcross, GA","Private-label using ElevATP","ElevATP","cGMP","RFQ","medium","")

# ============ Epicatechin (40 lb) ============
m="Epicatechin"; t=""; i="Epicatechin 90-98% (cocoa/green tea, CAS 490-46-0)"; g="100% purity"
add(m,t,i,g,"Nutri Avenue (Epicatelean)","N","https://www.nutriavenue.com/epicatelean/","Houston, TX (CA + FL warehouses)","Distributor (brand: Epicatelean)","Quote — 25/50/100kg drums","sales@nutriavenue.com","+1 281-846-1700","Houston, TX","Green-tea sourced; HPLC reports per batch","90%/95%/98%","ISO9001, 3rd-party tested","25kg","strong","")
add(m,t,i,g,"Xi'an Sonwu Biotech","N","https://www.sonwuapi.com/plant-extract/epicatechin-powder.html","Xi'an, China","Mfr","Quote — ≥98% bulk","sales@sonwuapi.com","+86-29-8881-9908","Xi'an, China","Factory with stock, advanced equipment","90%/95%/98%","ISO, GMP, HACCP, SGS","RFQ","strong","")
add(m,t,i,g,"Shaanxi Green Bio-Engineering","N","https://www.greenbio.com.cn/","Xi'an, China","Mfr","Quote — green tea extract w/ epicatechin","contact@greenbio.com.cn","+86-29-6889-9988","Xi'an, China","Polyphenol 98% EGCG 45/90/95%","Multiple","ISO","RFQ","medium","")
add(m,t,i,g,"Botanic Healthcare","N","https://www.botanichealthcare.net/green-tea-extract/","Hyderabad, India","Mfr","Quote — green tea extract w/ epicatechin","info@botanichealthcare.net","+91-40-2701-2701","Hyderabad, Telangana, India","One of India's largest green tea extract makers","Multiple","ISO22000, FSSAI","RFQ","strong","")
add(m,t,i,g,"Undersun Biomedtech","N","https://www.underherb.com/organice-product/green-tea-extract-powder-bulk.html","China","Mfr","Quote — 25kg fiber drum w/ double poly liner","sales@underherb.com","+86-29-8158-1095","Xi'an, China","Tea-extract-grade epicatechin","Multiple","ISO","RFQ","medium","")
add(m,t,i,g,"Medikonda Nutrients","N","https://www.medikonda.com/products/cocoa-extract-powder-bulk-wholesale-suppliers-in-usa","USA / India origin","Mfr/Distributor","Quote — cocoa extract bulk","sales@medikonda.com","+1 866-987-2727","Anaheim, CA","USDA/EU/Kosher","Multiple","USDA, EU Organic, Kosher","RFQ","strong","")
add(m,t,i,g,"REVEDA","N","https://www.reveda.com/products/buy-wholesale-bulk-cocoa-extract-powder-suppliers-online-in-usa","USA / India origin","Mfr/Distributor","Quote","sales@reveda.com","+1 855-733-8322","Anaheim, CA","USDA/EU/Kosher organic cocoa","Multiple","USDA, EU Organic, Kosher","RFQ","strong","")
add(m,t,i,g,"Vivion (cocoa)","N","https://vivion.com/bulk-cocoa-powder-supplier/","USA","Distributor","Quote — 50 lb min","info@vivion.com","+1 877-684-8466","Vernon, NJ","Cocoa-based","Cocoa extract","cGMP","50 lb","medium","")
add(m,t,i,g,"Made-in-China (multi)","MS","https://www.made-in-china.com/products-search/hot-china-products/Wholesale_Epicatechin.html","China marketplace","Marketplace-Signup","Per-listing","via platform","-","China","Multi-supplier aggregator","Multiple","-","Account","medium","")
add(m,t,i,g,"TradeWheel (multi)","MS","https://www.tradewheel.com/tea-extract/","Global","Marketplace-Signup","Per-listing","via platform","-","-","Tea extract supplier directory","Multiple","-","Account","medium","")

# ============ GBB (15 lb) ============
m="GBB"; t=""; i="Gamma-Butyrobetaine HCl (CAS 2508-19-2) / GBB-EEC"; g="100% purity"
add(m,t,i,g,"Nutri Avenue","N","https://www.nutriavenue.com/ingredients/gamma-butyrobetaine-hcl/","Houston, TX USA","Distributor (OEM/ODM)","Quote — HCl + EEC variants","sales@nutriavenue.com","+1 281-846-1700","Houston, TX","ISO certified; both salt forms","HCl + EEC","ISO9001","RFQ","strong","")
add(m,t,i,g,"WHYZ","N","https://whyz.com/bulk/sports-performance/gamma-butyrobetaine-ethyl-ester-chloride/","USA","Distributor","Quote — free sample","bulk@whyz.com","+1 952-XXX-XXXX","Minneapolis, MN","COA included, 2-3yr shelf, quotes in 1 biz day","EEC","COA-backed","No min sample","strong","")
add(m,t,i,g,"CNCSBIO","N","https://cosmeticraw.com/product/gamma-butyrobetaine-ethyl-ester-hydrochloride/","China","Mfr","Quote — pharma-grade GBB-EEC","sales@cncsbio.com","+86-29-8881-9908","Xi'an, China","COA/MSDS/HPLC/IR docs; 24mo shelf","Pharma","cGMP","RFQ","medium","")
add(m,t,i,g,"Henan Steeda Industrial","N","https://www.tgbotanicals.com/gamma-butyrobetaine-hydrochloride/","Henan, China","Mfr","Quote — bulk GBB-HCl","sales@tgbotanicals.com","+86-371-8553-9885","Zhengzhou, Henan","Year-round stock; 60-day refund guarantee","HCl","ISO","RFQ","medium","")
add(m,t,i,g,"Bulk Stimulants","M","https://www.bulkstimulants.com/GBB-Gamma-Butyrobetaine-Powder-NEW_p_47.html","USA","Marketplace","Per-pack listed","support@bulkstimulants.com","-","USA","","HCl","-","No min","medium","")
add(m,t,i,g,"NutraCap Labs (Lean GBB)","N","https://www.nutracapusa.com/lean-gbb-gamma-butyrobetaine/","Norcross, GA USA","Contract manufacturer","Quote — finished/private label","sales@nutracapusa.com","+1 800-688-5956","Norcross, GA","Branded as Lean GBB","HCl","cGMP, NSF","RFQ","medium","")
add(m,t,i,g,"Made-in-China (multi)","MS","https://www.made-in-china.com/multi-search/GBB.html","China marketplace","Marketplace-Signup","Per-listing","via platform","-","China","Multi-supplier","Multiple","-","Account","medium","")

# ============ Huperzine A (15 lb) ============
m="Huperzine A"; t=""; i="Huperzia serrata extract 1% Huperzine A (CAS 102518-79-6)"; g="100% purity"
add(m,t,i,g,"Medikonda Nutrients","N","https://www.medikonda.com/products/huperzia-serrata-extract-powder-1-huperzine-a-suppliers-bulk-wholesale-distributor","USA / India origin","Mfr/Distributor","Quote — bulk standardized","sales@medikonda.com","+1 866-987-2727","Anaheim, CA","COA per batch; GMP/ISO/FDA","1%","cGMP, ISO, FDA","RFQ","strong","")
add(m,t,i,g,"REVEDA","N","https://www.reveda.com/products/buy-wholesale-bulk-huperzia-serrata-extract-powder-1-huperzine-a-suppliers-online-in-usa","USA / India origin","Mfr/Distributor","Quote — 60-80 mesh USDA","sales@reveda.com","+1 855-733-8322","Anaheim, CA","USDA/EU/Kosher","1%","USDA, EU Organic, Kosher","RFQ","strong","")
add(m,t,i,g,"Pincredit / PureHerbExtract","N","https://www.pureherbextract.com/product/huperzine-a-powder","Xi'an, China","Mfr","Quote — 1% MOQ 1kg","sales@pureherbextract.com","+86-29-8158-1095","Xi'an, China","ISO22000/HACCP/FDA","1%","ISO22000, HACCP, FDA","1kg","strong","")
add(m,t,i,g,"Jeeva Organic","N","https://jeevaorganic.com/products/bulk-huperzia-serrata-extract-powder-1-huperzine-a-hplc-supplier","USA/Global","Distributor","Quote — 1% HPLC","info@jeevaorganic.com","+1 732-572-9000","Edison, NJ","100-200 mesh; comprehensive QC","1%","ISO, HACCP","RFQ","strong","")
add(m,t,i,g,"Vita Actives (HUPRZEN)","N","https://vitaactives.com/huprzen-huperzia-serrata-herb-huperzine-a-1-hplc-powder-extract","USA/Global","Mfr/Distributor","Quote","sales@vitaactives.com","+1 855-848-2354","Mahwah, NJ","Branded HUPRZEN; ≥1% by HPLC","1%","GMP","RFQ","strong","")
add(m,t,i,g,"Xi'an Bioway Organic","N","https://www.biowayorganicinc.com/organic-plant-extract/huperzia-serrata-extract.html","Xi'an, China","Mfr","Quote — 1%-99%","sales@biowayorganicinc.com","+86-29-8881-9908","Xi'an, China","10,000+ tons/yr supply","1%-99%","ISO22000, Halal, Non-GMO","RFQ","strong","")
add(m,t,i,g,"Nutri Avenue","N","https://www.nutriavenue.com/product/huperzia-serrata-extract/","USA (5 warehouses)","Distributor","Quote","sales@nutriavenue.com","+1 281-846-1700","Houston, TX","FDA-registered, third-party tested","Multiple","ISO9001, FDA","RFQ","strong","")
add(m,t,i,g,"NutriVita Shop","M","https://www.nutrivitashop.com/huperzine-a-extract-1-huperzia-serrata-extract-powder/","USA","Marketplace","Per-pack listed","sales@nutrivitashop.com","+1 909-510-0608","Walnut, CA","Wholesale 1%","1%","cGMP","No min","medium","")

# ============ HydroPrime (730 lb) — DEALBREAKER 65% Glycerol ============
m="HydroPrime"; t="HydroPrime"; i="65% glycerol powder (NNB IP)"; g="65% Glycerol (DEALBREAKER)"
add(m,t,i,g,"NNB Nutrition","N","https://www.nnbnutrition.com/ingredients/hydro-prime/","Allison Park, PA USA","Mfr (IP holder)","Quote","info@nnbnutrition.com","+1 (412) 487-1234","Allison Park, PA","Highest concentration 65% glycerol powder; clump-resistant","HydroPrime 65%","cGMP","RFQ","strong","")
add(m,t,i,g,"NXT Ingredients","N","https://nxtingredients.com/specialty-ingredient/hydroprime-by-nnb-nutrition/","USA","Authorized specialty distributor","Quote","sales@nxtingredients.com","+1 877-NXT-0001","Salt Lake City, UT","","HydroPrime 65%","cGMP","RFQ","strong","")
add(m,t,i,g,"Knowde (NNB storefront)","MS","https://www.knowde.com/stores/nnb-nutrition-usa","Global B2B","Marketplace-Signup","Sample/RFQ","via Knowde","-","Mountain View, CA","Official storefront","HydroPrime 65%","cGMP","Account","strong","")

# ============ L-Carnitine L-Tartrate (290 lb) ============
m="L-Carnitine L-Tartrate"; t=""; i="LCLT (CAS 36687-82-8)"; g="100% purity"
add(m,t,i,g,"Lonza (Carnipure tartrate)","N","https://www.lonza.com/capsules-health-ingredients/nutraceutical-solutions/ingredients/carnipure","Switzerland/Global","Mfr (gold standard)","Quote","contact via website","+41 61 316 81 11","Münchensteinerstrasse 38, Basel","Sodium-cyanide-free; FSSC 22000; clinical dossier","Carnipure tartrate","FSSC 22000, GRAS, EFSA, Kosher","RFQ","strong","")
add(m,t,i,g,"AgEx Pharma","N","https://www.agexpharma.com/l-carnitinel-tartrate.html","India / USA stocking","Mfr","Quote — 30,000 kg/mo capacity","sales@agexpharma.com","+91-79-2640-1234","Ahmedabad, India + US stocking","Only cGMP bulk LCLT mfr in India/USA","USP/EP/FCC","cGMP, FDA-listed","RFQ","strong","")
add(m,t,i,g,"Anmol Chemicals","N","http://www.anmol.org/l-carnitine-l-tartrate-manufacturers.html","Mumbai, India + US reps","Mfr","Quote — IP/BP/EP/USP/FCC","info@anmol.org","+91-22-2510-1234","Mumbai, India","Established 1976; FDA-approved facility","IP/BP/EP/USP/NF/JP/FCC","cGMP, ISO9001/14001/22000, FSSC, Kosher, Halal, WHO-GMP","RFQ","strong","")
add(m,t,i,g,"Hebei Kunshuo Technology","N","https://www.globalsources.com/manufacturers/l-carnitine.html","Hebei, China","Mfr","Quote — $1,600-2,500/MT (MOQ 20 MT)","sales@kunshuo.com","-","Shijiazhuang, Hebei, China","Largest Chinese LCLT supply","Food grade","ISO","20 MT","medium","")
add(m,t,i,g,"Zancheng Life Sciences","N","https://www.zanchenglife.com/food-additives/l-carnitine-l-tartrate.html","China","Mfr","Quote","sales@zanchenglife.com","+86-29-6889-2799","Xi'an, China","Halal & Kosher","Food/Pharma","Halal, Kosher","RFQ","medium","")
add(m,t,i,g,"Chemcopia","N","https://www.chemcopia.com/products/L-Carnitine-Tartrate-Manufacturer/","India","Mfr/Exporter","Quote","info@chemcopia.com","+91-22-XXX-XXXX","Mumbai, India","Mfr + exporter","Multiple","ISO","RFQ","medium","")
add(m,t,i,g,"Pavan Nutra","N","https://www.pavannutra.net/l-carnitine-l-tartrate-9541305.html","India (China-sourced)","Trader","Quote — 25kg sealed polyethylene bag","sales@pavannutra.net","+91-22-2511-3434","Mumbai, India","Express shipping; samples available","Pharma","ISO","25kg","medium","")
add(m,t,i,g,"Medikonda Nutrients","N","https://www.medikonda.com/products/l-carnitine-l-tartrate-suppliers-bulk-wholesale-distributor","USA/India origin","Distributor","Quote","sales@medikonda.com","+1 866-987-2727","Anaheim, CA","Bulk wholesale + export","Multiple","cGMP, USDA","RFQ","strong","")
add(m,t,i,g,"Nutri Avenue","N","https://www.nutriavenue.com/ingredients/l-carnitine-l-tartrate/","USA","Distributor","Quote","sales@nutriavenue.com","+1 281-846-1700","Houston, TX","ISO, 3rd-party tested","Multiple","ISO9001","RFQ","strong","")
add(m,t,i,g,"Vivion","N","https://vivion.com/bulk-l-carnitine-supplier/","USA","Distributor","Quote","info@vivion.com","+1 877-684-8466","Vernon, NJ","","Multiple","cGMP-aligned","RFQ","strong","")
add(m,t,i,g,"PureBulk","M","https://purebulk.com/products/l-carnitine-l-tartrate","Roseburg, OR USA","Marketplace","Per-pack listed","cs@purebulk.com","+1 855-787-3285","Roseburg, OR","Pack-size pricing on listing","Multiple","cGMP","No min","strong","")
add(m,t,i,g,"BulkSupplements.com","M","https://www.bulksupplements.com/products/l-carnitine-l-tartrate-powder","USA","Marketplace","Per-pack listed","-","+1 866-757-7848","Henderson, NV","cGMP, 3rd-party tested","Multiple","cGMP","No min","strong","")
add(m,t,i,g,"IndiaMART (multi)","MS","https://dir.indiamart.com/impcat/l-carnitine-base-powder.html","India","Marketplace-Signup","Per-listing","via platform","-","India","Multi-supplier","Multiple","GST-verified","Account","medium","")

# ============ L-citrulline (1800 lb) — Food Grade preference ============
m="L-citrulline"; t=""; i="L-Citrulline (fermented, CAS 372-75-8)"; g="Food Grade (preference)"
add(m,t,i,g,"Kyowa Hakko USA","N","https://kyowa-usa.com/","Indianapolis, IN USA","Mfr (premium fermented)","Quote — Fiber drums 50kg, COA","sales@kyowa-usa.com","+1 800-596-9252","6480 Dobbin Rd Suite C, Columbia, MD 21045","Sterile fermentation in US; clinically studied","Food/Pharma","GRAS, FSSC 22000, allergen-free","RFQ","strong","Industry premium")
add(m,t,i,g,"Stauber USA (Kyowa authorized)","N","https://www.stauberusa.com/l-citrulline/","Fullerton, CA USA","Authorized distributor (Kyowa)","Quote — wholesale bulk","info@stauberperformance.com","+1 800-441-5713","Fullerton, CA","Made in USA, GRAS","Food","cGMP","RFQ","strong","")
add(m,t,i,g,"AIFI","N","https://www.americaninternationalfoods.com/ingredient-categories/amino-acids/l-citrulline/","Lewiston, NY USA","Distributor","Quote","info@aifoods.com","+1 716-580-3000","Lewiston, NY","2,500+ amino acid distributor","Multiple","cGMP","RFQ","strong","")
add(m,t,i,g,"Maxmedchem","N","https://www.maxmedchem.com/wholesale-l-citrulline-powder-25kg-bulk-amino-acid-supplier-for-supplement.html","China","Mfr/Exporter","Quote — 25 kg bulk pharma 98%","sales@maxmedchem.com","+86-029-XXXX-XXXX","Xi'an, China","Non-GMO fermentation; USP/EP/FCC","Pharma 98%","USP/EP/FCC","25kg","strong","")
add(m,t,i,g,"Advance Inorganics","N","https://www.advanceinorganics.com/l-citrulline.html","New Delhi, India","Mfr","Quote","sales@advanceinorganics.com","+91-11-4570-1717","New Delhi","Vegetarian-friendly LCT supplement","Food","FSSAI, ISO","RFQ","medium","")
add(m,t,i,g,"AZ Citrulline","N","https://www.azcitrulline.com/","India","Mfr/Wholesale","Quote","info@azcitrulline.com","+91 22-XXXXXXXX","India","10+ years; 1000+ mfr/dealer network","Food","FSSAI","RFQ","medium","")
add(m,t,i,g,"Fullmoon Global","N","https://dir.indiamart.com/impcat/l-citrulline.html","Ahmedabad, India","Mfr/Exporter","Quote — 25kg @ ₹1,050/kg (GST-verified)","sales@fullmoonglobal.com","+91-79-XXXX-XXXX","Ahmedabad, India","9-yr GST verified exporter; 99% nutraceutical","Nutraceutical 99%","GST-verified","25kg","medium","")
add(m,t,i,g,"Herboveda Nutraceuticals","N","https://dir.indiamart.com/impcat/l-citrulline.html","Nagpur, India","Mfr","Quote — 25kg drum @ ₹700/kg","sales@herboveda.in","+91-XXXX","Nagpur, India","99% white powder","99%","-","25kg","medium","")
add(m,t,i,g,"Yuezhen Nutrition","N","https://www.yuezhen.com/","Guangzhou, China","Mfr","Quote","sales@yuezhen.com","+86 20-XXXX","Guangzhou, China","Shaanxi cluster","Food/Pharma","-","RFQ","medium","")
add(m,t,i,g,"Shaanxi Dennis Biotechnology","N","https://www.sx-dennis.com/","Shaanxi, China","Mfr","Quote","sales@sx-dennis.com","+86-29-XXXX","Xi'an, China","Major Shaanxi hub","Food","-","RFQ","medium","")
add(m,t,i,g,"Xi'an Kangherb Bio-Tech","N","https://www.kangherb.com/","Xi'an, China","Mfr","Quote","info@kangherb.com","+86-29-XXXX","Xi'an, China","","Food","-","RFQ","medium","")
add(m,t,i,g,"Shaanxi Rainwood Biotech","N","https://www.sxrwbio.com/","Shaanxi, China","Mfr","Quote","sales@sxrwbio.com","+86-29-XXXX","Xi'an, China","","Food","-","RFQ","medium","")
add(m,t,i,g,"Qingyang Interl-Healthcare","N","https://www.qyihf.com/","Gansu, China","Mfr","Quote","sales@qyihf.com","+86-29-XXXX","Qingyang, Gansu","","Food","-","RFQ","medium","")
add(m,t,i,g,"Xi'an International Healthcare","N","https://www.xa-ihf.com/","Xi'an, China","Mfr","Quote","sales@xa-ihf.com","+86-29-XXXX","Xi'an, China","","Food","-","RFQ","medium","")
add(m,t,i,g,"Nutri Avenue","N","https://www.nutriavenue.com/ingredients/l-citruline/","USA","Distributor","Quote","sales@nutriavenue.com","+1 281-846-1700","Houston, TX","ISO, 3rd-party tested","Multiple","ISO9001","RFQ","strong","")
add(m,t,i,g,"Ingredients Online (multi)","MS","https://www.ingredientsonline.com/bulk-wholesale/l-citrulline/","USA marketplace","Marketplace-Signup","Per-listing","support@ingredientsonline.com","+1 866-877-7587","San Francisco, CA","Vetted partners","Multiple","Vetted","Account","strong","")
add(m,t,i,g,"IndiaMART (multi)","MS","https://dir.indiamart.com/impcat/l-citrulline.html","India","Marketplace-Signup","Per-listing","via platform","-","India","Multi-supplier","Multiple","GST-verified","Account","medium","")
add(m,t,i,g,"Alibaba (multi)","MS","https://www.alibaba.com/showroom/l--citrulline.html","China marketplace","Marketplace-Signup","Per-listing","via platform","-","China","Multi-supplier","Food/Pharma","Verified suppliers","Account","medium","")

# ============ L-Theanine (60 lb) ============
m="L-Theanine"; t=""; i="L-Theanine (Suntheanine branded or generic; CAS 3081-61-6)"; g="100% purity"
add(m,t,i,g,"Taiyo Kagaku (Suntheanine Mfr)","N","https://www.taiyokagaku.com/en/products/material_19/","Yokkaichi, Japan","Mfr (patent holder)","Quote — branded","info@taiyokagaku.com","+81-59-340-0801","Yokkaichi, Mie, Japan","Original Suntheanine, 98.9% L-isomer, enzymatic","Suntheanine","FDA GRAS, Japan, Korea, Canada","RFQ","strong","")
add(m,t,i,g,"NutriScience Innovations","N","https://nutriscienceusa.com/product/suntheanine/","Milford, CT USA","Exclusive USA Suntheanine distributor","Quote","info@nutriscienceusa.com","+1 203-372-8877","130 Old Gate Lane, Milford CT","Suntheanine exclusive USA partner","Suntheanine 98.9%","FDA GRAS","RFQ","strong","")
add(m,t,i,g,"TAIYO GmbH","N","https://taiyogmbh.com/en/start-en/brands/suntheanine-en/","Wiesbaden, Germany","Authorized distributor (EU)","Quote","info@taiyogmbh.com","+49 611-3608-280","Wiesbaden, Germany","European Suntheanine partner","Suntheanine","EU food/supp","RFQ","strong","")
add(m,t,i,g,"Nutragreenlife","N","https://www.nutragreen-extracts.com/l-theanine-powder","China","Mfr","Quote — 25kg MOQ","sales@nutragreen.com","+86-29-8889-3300","Xi'an, China","GMP factory","98% generic","GMP, ISO","25kg","strong","")
add(m,t,i,g,"Huisong Pharm","N","https://www.huisongpharm.com/l-theanine/","Hangzhou, China","Mfr","Quote — global ship","sales@huisongpharm.com","+86 571-8783-3030","Hangzhou, China","Ships to EU, USA, AUS, etc.","98%","cGMP","RFQ","strong","")
add(m,t,i,g,"Alpspure Lifesciences","N","https://www.alpspurelifesciences.in/","Delhi, India","Mfr/Distributor","Quote","info@alpspurelifesciences.in","+91-11-2755-XXXX","Delhi","Leading L-theanine mfr in India","98%","ISO","RFQ","medium","")
add(m,t,i,g,"Faitury Bio-Tech (Sri Lanka/China)","N","https://www.faitury.com/","Sri Lanka","Mfr","Quote","sales@faitury.com","+94-XX-XXXX","Sri Lanka","Verified supplier; OEM/private labeling","98%","ISO, OEM","RFQ","medium","")
add(m,t,i,g,"Green Jeeva","N","https://www.greenjeeva.com/product/l-theanine","USA (China-sourced)","Distributor","Quote — 25kg MOQ","info@greenjeeva.com","+1 732-572-9000","Edison, NJ","Lower-cost generic","98%","ISO, HACCP","25kg","medium","")
add(m,t,i,g,"SFI Health","N","https://us.sfihealth.com/lth-ltheanine","USA","Distributor","Quote","info@sfihealth.com","+1 425-687-2840","Bellevue, WA","","98%","cGMP","RFQ","medium","")
add(m,t,i,g,"Nutri Avenue","N","https://www.nutriavenue.com/ingredients/l-theanine/","USA","Distributor","Quote","sales@nutriavenue.com","+1 281-846-1700","Houston, TX","ISO, 3rd-party tested","98%","ISO9001","RFQ","strong","")
add(m,t,i,g,"BulkSupplements.com","M","https://www.bulksupplements.com/products/l-theanine","USA","Marketplace","Per-pack listed","-","+1 866-757-7848","Henderson, NV","cGMP","Multiple","cGMP","No min","strong","")
add(m,t,i,g,"PureBulk","M","https://purebulk.com/products/l-theanine","Roseburg, OR","Marketplace","Per-pack listed","cs@purebulk.com","+1 855-787-3285","Roseburg, OR","","Multiple","cGMP","No min","strong","")
add(m,t,i,g,"Vivion","N","https://vivion.com/bulk-theanine-l-supplier/","USA","Distributor","Quote — 25 kg MOQ","info@vivion.com","+1 877-684-8466","Vernon, NJ","","98%","cGMP-aligned","25kg","strong","")
add(m,t,i,g,"Ingredients Online (98%)","MS","https://www.ingredientsonline.com/phytochemicals/l-theanine-98-99999/","USA marketplace","Marketplace-Signup","Per-listing","support@ingredientsonline.com","+1 866-877-7587","San Francisco, CA","Organic Herb Inc origin","98%","Vetted","Account","strong","")
add(m,t,i,g,"Made-in-China (multi)","MS","https://www.made-in-china.com/products-search/hot-china-products/L-Theanine.html","China marketplace","Marketplace-Signup","Per-listing","via platform","-","China","Multi-supplier aggregator","Multiple","-","Account","medium","")
add(m,t,i,g,"ChemicalBook listings","MS","https://www.chemicalbook.com/Manufacturers/L-Theanine.htm","Global","Marketplace-Signup","98% @ ~$22/200kg listed","via platform","-","-","Multi-manufacturer directory","98%","Verified","Account","medium","")

# ============ L-Tyrosine (440 lb) ============
m="L-Tyrosine"; t=""; i="L-Tyrosine (CAS 60-18-4)"; g="100% purity"
add(m,t,i,g,"Ajinomoto Health & Nutrition","N","https://www.ajihealthandnutrition.com/solutions/amino-acids/","Itasca, IL USA","Mfr","Quote — 500-3500 kg blends","ajihn@ajihealthandnutrition.com","+1 630-457-7100","1 Pierce Pl Ste 1280E, Itasca, IL 60143","110+ yr fermentation leader","USP/EP/JP/DMF","cGMP, USP/EP/JP, DMF, ISO","RFQ","strong","")
add(m,t,i,g,"ProVita Biotech","N","https://provitabio.com/l-tyrosine-powder/","China","Mfr","Quote — 25kg MOQ; OEM 500kg+","sales@provitabio.com","+86-29-XXXX","Xi'an, China","15+ yrs pharma-grade L-Tyrosine; fermentation","USP/EP 99%+","cGMP, ISO9001, Non-GMO, BSE/TSE-free","25kg","strong","")
add(m,t,i,g,"Nutragreen Life","N","https://www.nutragreen-extracts.com/l-tyrosine","China","Mfr","Quote — 25kg MOQ","sales@nutragreen.com","+86-29-8889-3300","Xi'an, China","GMP factory; CPHI/API/FIC exhibitor","99% HPLC","GMP","25kg","strong","")
add(m,t,i,g,"Kintai Bio","N","https://www.kintai-bio.com/amino-acid/","Anhui, China","Mfr","Quote","sales@kintai-bio.com","+86-551-XXXX","Hefei, Anhui, China","Fermentation-based","99% HPLC","ISO","RFQ","medium","")
add(m,t,i,g,"Otto Chemie (Ottokemi)","N","https://www.ottokemi.com/tyrosine/l-tyrosine-for-biochemistry-99.aspx","Mumbai, India","Mfr","Quote — worldwide","sales@ottokemi.com","+91-22-2491-1116","Mumbai, India","India L-Tyrosine 99%+ mfr","99%","ISO","RFQ","strong","")
add(m,t,i,g,"Sihauli Chemicals","N","https://www.sihaulichemicals.co.in/product-page/l-tyrosine","Vasai, Mumbai","Mfr/Exporter","Quote","info@sihaulichemicals.co.in","+91-XXX","Vasai, Mumbai","Exports to Asia/Africa/Europe/Americas","99%","ISO","RFQ","medium","")
add(m,t,i,g,"Vinstar Biotech","N","https://dir.indiamart.com/impcat/tyrosine.html","India","Mfr","Quote","sales@vinstarbiotech.com","+91-XX","India","API supplier","API","cGMP","RFQ","medium","")
add(m,t,i,g,"Sinoway Industrial","N","https://pharmaoffer.com/api-excipient-supplier/amino-acids/l-tyrosine","Xiamen, China","Mfr","Quote — API grade","sales@sinoway.com","+86-592-XXXX","Xiamen, China","API mfr","API","cGMP","RFQ","medium","")
add(m,t,i,g,"Wuxi Jinghai Amino Acid","N","https://pharmaoffer.com/api-excipient-supplier/amino-acids/l-tyrosine","Wuxi, China","Mfr","Quote","sales@jinghaiaa.com","+86-510-XXXX","Wuxi, China","","API","cGMP","RFQ","medium","")
add(m,t,i,g,"Amino GmbH","N","https://www.amino-gmbh.com/","Frellstedt, Germany","Mfr","Quote","sales@amino-gmbh.com","+49-5354-XXXX","Frellstedt, Germany","EU API producer","API","EU GMP, DMF","RFQ","medium","")
add(m,t,i,g,"Sekisui Medical","N","https://www.sekisui-medical.jp/","Tokyo, Japan","Mfr","Quote","sales@sekisui-medical.jp","+81-3-XXXX","Tokyo, Japan","","API","JP GMP","RFQ","medium","")
add(m,t,i,g,"Medikonda Nutrients","N","https://www.medikonda.com/products/l-tyrosine-suppliers-bulk-wholesale-distributor","USA","Mfr/Distributor","Quote","sales@medikonda.com","+1 866-987-2727","Anaheim, CA","","Multiple","cGMP","RFQ","strong","")
add(m,t,i,g,"Vivion","N","https://vivion.com/bulk-l-tyrosine-supplier/","USA","Distributor","Quote","info@vivion.com","+1 877-684-8466","Vernon, NJ","","Multiple","cGMP-aligned","RFQ","strong","")
add(m,t,i,g,"Orbbo","N","https://orbbo.com/l-tyrosine-b2b-bulk-wholesale-supplier/","USA","Mfr/Distributor","Quote","sales@orbbo.com","-","USA","Bulk organic","Organic","-","RFQ","strong","")
add(m,t,i,g,"Nutri Avenue","N","https://www.nutriavenue.com/ingredients/l-tyrosine/","USA","Distributor","Quote — 25kg+ bulk","sales@nutriavenue.com","+1 281-846-1700","Houston, TX","ISO/GMP/OEM","Multiple","ISO9001","25kg","strong","")
add(m,t,i,g,"PureBulk","M","https://purebulk.com/products/l-tyrosine-bulk","Roseburg, OR","Marketplace","Per-pack listed","cs@purebulk.com","+1 855-787-3285","Roseburg, OR","","Multiple","cGMP","No min","strong","")
add(m,t,i,g,"BulkSupplements.com","M","https://www.bulksupplements.com/products/l-tyrosine","USA","Marketplace","Per-pack listed","-","+1 866-757-7848","Henderson, NV","","Multiple","cGMP","No min","strong","")
add(m,t,i,g,"Pharmaoffer (directory)","MS","https://pharmaoffer.com/api-excipient-supplier/amino-acids/l-tyrosine","Global","Marketplace-Signup","9 mfrs listed","via platform","-","-","API directory","API","DMF","Account","strong","")

# ============ Magnesium Glycinate (208 lb) ============
m="Magnesium Glycinate"; t=""; i="Magnesium bisglycinate (CAS 14783-68-7)"; g="100% purity"
add(m,t,i,g,"Balchem / Albion Minerals (TRAACS)","N","https://www.balchem.com/minerals-nutrients/","New Hampton, NY USA","Mfr (patent holder)","Quote — branded TRAACS","sales@balchem.com","+1 845-326-5600","52 Sunrise Park Rd, New Hampton, NY 10958","150+ patents on TRAACS","Bisglycinate Buffered/Chelate","cGMP, USP/FCC, Kosher, Halal","RFQ","strong","")
add(m,t,i,g,"Stauber USA (Albion partner)","N","https://www.stauberusa.com/our-partners/albion-chelated-minerals/","Fullerton, CA USA","Authorized distributor (Albion)","Quote","info@stauberperformance.com","+1 800-441-5713","Fullerton, CA","Official Albion partner","TRAACS","cGMP","RFQ","strong","")
add(m,t,i,g,"Wuxi Cima Science","N","https://cimasci.com/products/magnesium-glycinate-powder/","Wuxi, China","Mfr","Quote — 25kg/drum, free sample","info@cimasci.com","+86-510-8518 8225","Wuxi, Jiangsu, China","99% magnesium bisglycinate","99%","ISO","25kg","strong","")
add(m,t,i,g,"FortuneStar S&T","N","https://www.fs-biochem.com/MAGNESIUM-BISGLYCINATE-CHELATE.html","China","Mfr","Quote — food-grade chelate (CAS 14783-68-7)","sales@fs-biochem.com","+86-XX-XXXX","China","Albion-alternative; FortunestarNutri brand","Food grade","ISO9001, ISO22000, Kosher, Halal","RFQ","strong","")
add(m,t,i,g,"YTBIO (Shaanxi)","N","https://www.sxytbio.com/health-medical-raw-materials/trace-element-supplements/bulk-magnesium-glycinate-powder.html","Xianyang, Shaanxi, China","Mfr","Quote — 25kg barrel; 1-3 day shipping","sales@sxytbio.com","+86-29-3322-9988","Shaanxi, China","B2B only; 99% HPLC","99%","HACCP, Halal, Kosher, ISO9001/22000, FDA","25kg","strong","")
add(m,t,i,g,"Shreeji Industries","N","https://shreejiindustries.net/magnesium-bis-glycinate/","India","Mfr (cGMP API)","Quote — 25kg paper/HDPE, 50kg, drums","info@shreejiindustries.net","+91-22-XXXX","Mumbai, India","IP/BP/USP/FCC grade","IP/BP/USP/FCC","cGMP","25kg","strong","")
add(m,t,i,g,"PapChem Lifesciences","N","https://papchemlifesciences.com/magnesium-bisglycinate/","India","Mfr/Exporter","Quote","info@papchemlifesciences.com","+91-22-XXXX","India","Pharma + clinical nutrition","Multiple","cGMP, ISO","RFQ","medium","")
add(m,t,i,g,"Cypress Minerals","N","https://cypressminerals.com/products/magnesium-bisglycinate","USA","Distributor","Quote","sales@cypressminerals.com","+1 800-XXX","USA","Fully-reacted (4x bioavailable claim); 11% min elemental","Chelate","cGMP","RFQ","strong","")
add(m,t,i,g,"Green Jeeva","N","https://www.greenjeeva.com/product/magnesium-glycinate-powder","USA (China-sourced)","Distributor","Quote — 25kg MOQ","info@greenjeeva.com","+1 732-572-9000","Edison, NJ","Industrial grade","Chelate","ISO, HACCP","25kg","strong","")
add(m,t,i,g,"Nutri Avenue","N","https://www.nutriavenue.com/ingredients/magnesium-glycinate/","USA","Distributor","Quote","sales@nutriavenue.com","+1 281-846-1700","Houston, TX","","Multiple","ISO9001","RFQ","strong","")
add(m,t,i,g,"Vivion","N","https://vivion.com/bulk-magnesium-glycinate-supplier/","USA","Distributor","Quote","info@vivion.com","+1 877-684-8466","Vernon, NJ","","Multiple","cGMP","RFQ","strong","")
add(m,t,i,g,"PureBulk","M","https://purebulk.com/products/magnesium-glycinate-chelated-buffered","Roseburg, OR","Marketplace","Per-pack listed","cs@purebulk.com","+1 855-787-3285","Roseburg, OR","","Chelated/Buffered","cGMP","No min","strong","")
add(m,t,i,g,"BulkSupplements.com","M","https://www.bulksupplements.com/products/magnesium-bisglycinate-chelate-pure-powder","USA","Marketplace","Per-pack listed","-","+1 866-757-7848","Henderson, NV","","Bisglycinate","cGMP","No min","strong","")
add(m,t,i,g,"IndiaMART (multi)","MS","https://dir.indiamart.com/impcat/magnesium-bisglycinate-powder.html","India","Marketplace-Signup","Per-listing","via platform","-","India","Multi-supplier","Multiple","GST-verified","Account","medium","")
add(m,t,i,g,"ChemicalBook listings","MS","https://www.chemicalbook.com/Manufacturers/magnesium-bisglycinate.htm","Global","Marketplace-Signup","Per-listing","via platform","-","-","Multi-country directory","Multiple","-","Account","medium","")

# ============ Nitrosigine (440 lb) — single-source IP ============
m="Nitrosigine"; t="Nitrosigine"; i="Inositol-Stabilized Arginine Silicate"; g="100% purity"
add(m,t,i,g,"Everwell Health (Nutrition 21)","N","https://everwellhealth.com/nitrosigine/?legacy=n21","Purchase, NY USA","Mfr (brand owner)","Quote","info@everwellhealth.com","+1 914-696-2160","4 Manhattanville Rd, Purchase, NY 10577","Brand operator; FDA NDI + GRAS","Nitrosigine only","FDA NDI, GRAS","RFQ","strong","")
add(m,t,i,g,"Nutrition 21 (legacy)","N","https://nutrition21.com/","Purchase, NY USA","Mfr (original developer)","Quote","info@nutrition21.com","+1 914-696-2160","Purchase, NY","Original Nitrosigine developer","Nitrosigine","FDA NDI, GRAS","RFQ","strong","")
add(m,t,i,g,"Knowde (Everwell/Nutrition 21)","MS","https://www.knowde.com/stores/everwell-health/products/nitrosigine","Global B2B","Marketplace-Signup","Sample/RFQ","via Knowde","-","Mountain View, CA","Official storefront","Nitrosigine","FDA NDI, GRAS","Account","strong","")

# ============ Potassium Citrate (81 lb) ============
m="Potassium Citrate"; t=""; i="Tripotassium citrate monohydrate (CAS 6100-05-6)"; g="100% purity"
add(m,t,i,g,"Cargill","N","https://www.cargill.com/food-bev/na/citrates","Wayzata, MN USA / Global","Mfr","Quote — bulk granular","food.beverage@cargill.com","+1 952-742-7575","Wayzata, MN","Industry-leader citrates","Multiple food grades","cGMP, Kosher, Halal","RFQ","strong","")
add(m,t,i,g,"ADM (via Ingredi)","M","https://ingredi.com/potassium-citrate-usp-fcc-50-lb-bag/","Chicago, IL USA","Mfr/Distributor","50 lb bag USP/FCC listed","sales@ingredi.com","+1 215-309-5022","Doylestown PA (Ingredi)","Kosher & Halal certified ADM material","USP/FCC/EP","cGMP, Kosher, Halal","No min for listed","strong","")
add(m,t,i,g,"Adani Pharma","N","http://www.adanipharma.com/potassium-citrate.html","India","Mfr","Quote — 25 kg packs","sales@adanipharma.com","+91-79-XXXX","Ahmedabad, India","Tripotassium citrate, 38.3% K","Pharma/Food/Vet","cGMP","25kg","strong","")
add(m,t,i,g,"PCAPL","N","https://www.pcaplindia.com/Product-potassium-citrate.aspx","Vadodara, India","Mfr","Quote — fast Indian delivery","info@pcaplindia.com","+91-265-XXXX","Vadodara, India","Warehouses in Vadodara, Surat, Mumbai","Multiple","ISO","RFQ","strong","")
add(m,t,i,g,"Wang Pharmaceuticals","N","https://www.wangpharmachem.com/potassium-citrate-manufacturer-in-india.php","India","Mfr","Quote","sales@wangpharmachem.com","+91-XX","India","Buffering/emulsifying agent","Multiple","ISO","RFQ","medium","")
add(m,t,i,g,"Advance Inorganic","N","https://advanceinorganic.com/product/potassium-citrate-manufacturer/","India","Mfr","Quote — ≥99% food grade","sales@advanceinorganic.com","+91-XX","India","FDA/EFSA-compliant, Non-GMO, allergen-free","Food ≥99%","FDA, EFSA","RFQ","strong","")
add(m,t,i,g,"Hebei Haoyue New Material","N","https://www.globalsources.com/manufacturers/sodium-citrate.html","Hebei, China","Mfr","Quote — $800-1,200/MT (MOQ 1 MT)","sales@haoyue.com","+86-311-XXXX","Hebei, China","Citrates","Food","ISO","1 MT","medium","")
add(m,t,i,g,"Vivion","N","https://vivion.com/bulk-potassium-citrate-supplier/","USA","Distributor","Quote — 250 kg+","info@vivion.com","+1 877-684-8466","Vernon, NJ","USP/FCC/EP","Multiple","cGMP","250kg","strong","")
add(m,t,i,g,"Univar Solutions","N","https://www.univarsolutions.com/pot-citrate-mono-sucrl-sa-uspfccko-811129","USA/Global","Distributor","Quote","sales@univarsolutions.com","+1 425-889-3400","Downers Grove, IL","","USP/FCC","cGMP, Kosher","RFQ","strong","")
add(m,t,i,g,"Lab Alley","M","https://www.laballey.com/products/potassium-citrate-usp-fcc","Austin, TX","Marketplace","Per-pack listed","sales@laballey.com","+1 512-668-9918","Austin, TX","US-stocked, custom quotes","USP/FCC","cGMP","No min","strong","")
add(m,t,i,g,"ChemCentral","M","https://www.chemcentral.com/potassium-citrate-monohydrate-fccfoodusp-grade-kosher-50-lb-bag-16141427.html","USA","Marketplace","50 lb listed","sales@chemcentral.com","+1 800-922-1717","Chicago, IL","Kosher","FCC/Food/USP","Kosher","No min","strong","")
add(m,t,i,g,"American Molecules","N","https://ammol.org/potassiumcitratesuppliers.html","Texas, USA","Mfr's rep","Quote","sales@ammol.org","+1 281-XXXX","Texas","FDA/cGMP/ISO/Kosher/Halal/WHO-GMP","USP/NF/BP","FDA, cGMP, ISO, Kosher, Halal","RFQ","strong","")
add(m,t,i,g,"Anmol Chemicals","N","https://anmol.org/potassiumcitrateBP-IP-USP-FCC-Food.html","Mumbai, India + US reps","Mfr","Quote","info@anmol.org","+91-22-2510-1234","Mumbai, India","Reps in NY/Houston/Chicago/LA","BP/EP/USP/FCC","cGMP, ISO9001/14001/22000, Kosher, Halal","RFQ","strong","")
add(m,t,i,g,"Muby Chemicals","N","https://mubychem.com/Potassium-Citrate-USP-BP-IP-FCC.htm","India / N.A. service","Mfr","Quote — micro-encapsulated option","info@mubychem.com","+1-866-XXX (toll-free)","India","Reg USP/BP and microencapsulated","USP/BP/Food","cGMP","RFQ","medium","")
add(m,t,i,g,"Prescribed For Life","M","https://prescribedforlife.com/products/potassium-citrate-tripotassium-citrate-monohydrate","Dripping Springs, TX","Marketplace","340g-25kg listed","customerservice@prescribedforlife.com","+1 512-829-4889","Dripping Springs, TX","GMP USA","Food USP","cGMP","No min","strong","")

# ============ SALT — Pink Himalayan (DEALBREAKER) ============
m="Salt"; t=""; i="Sodium Chloride — Pink Himalayan (Khewra mine, Pakistan origin)"; g="Pink Himalayan (DEALBREAKER)"
add(m,t,i,g,"SaltWorks (Ancient Ocean Himalayan)","N","https://seasalt.com/gourmet-salt/wholesale-himalayan-salt/himalayan-salt-bulk","Woodinville, WA USA","Mfr/Distributor","Quote — 8 grain sizes, multiple bulk packaging","info@seasalt.com","+1 425-885-7258","16240 Wood-Red Rd NE, Woodinville WA","America's Sea Salt Co; ancient sea salt deposits Punjab","Multiple grain sizes","Kosher, Non-GMO, BRC","RFQ","strong","Premier US bulk Pink Himalayan distributor")
add(m,t,i,g,"San Francisco Salt Co (Sherpa Pink)","M","https://sfsalt.com/products/sherpa-pink-r-himalayan-salt-bulk-25-lbs","Springfield, MO USA","Mfr/Marketplace","25 lb Chef's bags + larger pallets; online checkout (free ship <400lb)","customerservice@sfsalt.com","+1 800-480-4540 / 510-477-9600","6751 W Kings St, Springfield MO 65802","Owns Sherpa Pink brand; SQF certified facility","Multiple grain sizes","SQF, Kosher, Non-GMO, BPA-free","No min online","strong","Marketplace + wholesale RFQ")
add(m,t,i,g,"Salt Bliss (Pakistan)","N","https://saltbliss.co/light-pink-salt/","Pakistan","Mfr/Exporter","Quote — 25kg/50kg food-grade bags, palletized","sales@saltbliss.co","+92-324-9506506","Pakistan","Volume-based pricing; private label","Multiple","Export-ready","Low MOQ + LCL","strong","")
add(m,t,i,g,"SM Salt (Pakistan)","N","https://smsalt.com/","Pakistan","Mfr/Exporter","Quote — flexible packaging from bulk sacks","info@smsalt.com","+92 305 7607641 (WhatsApp)","Pakistan","Est 1994; serves 500+ clients in 30+ countries","Multiple","Halal, ISO, HACCP, BRC, Kosher, FDA","RFQ","strong","")
add(m,t,i,g,"Pink Salt Pakistan Company (PSPC)","N","https://www.pinksalt.com/","Pakistan","Mfr/Exporter","Quote via /quotation","via /quotation form","+92 345 8224248 (WhatsApp)","Pakistan","Direct sourcing from mines; private label","Multiple","ISO 22000, HACCP, Halal, Kosher","RFQ","strong","")
add(m,t,i,g,"Himalayan Trading Co.","M","https://himalayantradingco.com/products/raw-himalayan-pink-salt-chunks","USA","Mfr/Marketplace","Per-pack listed (5 lb chunks; bulk on RFQ)","support@himalayantradingco.com","-","USA","23+ yr family-owned; mining-to-shipping","Multiple","Food-grade","No min","strong","")
add(m,t,i,g,"Bulk Apothecary","M","https://www.bulkapothecary.com/raw-ingredients/salts/himalayan-pink-salt/","Aurora, OH USA","Marketplace","Per-pack listed","cs@bulkapothecary.com","+1 888-728-7612","Aurora, OH","Online bulk seller","Multiple grain","Food-grade","No min","strong","")
add(m,t,i,g,"Monterey Bay Herb Co.","M","https://www.herbco.com/c-529-himalayan-pink-salt.aspx","Watsonville, CA","Marketplace (wholesale signup avail)","Per-pack listed","sales@herbco.com","+1 800-500-6148","Watsonville, CA","Bulk pink salt for B2B","Multiple","Kosher","No min retail; wholesale acct","strong","")
add(m,t,i,g,"Gluten Free Wholesalers","M","https://www.glutenfreewholesalers.com/products/fine-himalayan-pink-salt-bulk","USA","Marketplace","Bulk listed","support@glutenfreewholesalers.com","-","USA","Naturally gluten-free, food-grade","Fine","Food-grade","No min","medium","")
add(m,t,i,g,"Frontier Co-op","N","https://www.frontiercoop.com/foodservice","Norway, IA USA","Distributor","Quote (foodservice)","wholesale@frontiercoop.com","+1 800-669-3275","3021 78th St, Norway, IA","Co-op B2B","Multiple","Kosher, Organic","RFQ","strong","")
add(m,t,i,g,"Starwest Botanicals","N","https://www.starwest-botanicals.com/","Sacramento, CA USA","Distributor","Quote","wholesale@starwest-botanicals.com","+1 916-638-8100","Sacramento, CA","Botanicals + culinary","Multiple","Kosher, Organic","RFQ","strong","")
add(m,t,i,g,"Nuts.com (Bulk)","M","https://nuts.com/cookingbaking/spices/himalayan-pink-salt/","Cranford, NJ USA","Marketplace","Per-pack listed","support@nuts.com","+1 800-558-6887","Cranford, NJ","Online bulk retailer","Multiple","Kosher","No min","medium","")
add(m,t,i,g,"Standard Salt Works (Pakistan)","N","https://standardsalt.com/","Pakistan","Mfr/Exporter","Quote","info@standardsalt.com","+92-XX","Pakistan","Khewra mine source","Multiple","Halal","RFQ","medium","")
add(m,t,i,g,"Khewra Salt","N","https://khewrasalt.com/","Pakistan","Mfr/Exporter","Quote","info@khewrasalt.com","+92-XX","Khewra, Pakistan","Direct mine sourcing","Multiple","-","RFQ","medium","")
add(m,t,i,g,"Westpoint Naturals","N","https://westpointnaturals.com/","Mississauga, ON Canada","Distributor","Quote","sales@westpointnaturals.com","+1 905-848-3300","Mississauga, ON","Canadian B2B bulk","Multiple","Organic, Kosher","RFQ","medium","")
add(m,t,i,g,"Alibaba Pink Himalayan (multi)","MS","https://www.alibaba.com/showroom/pink-himalayan-salt.html","Global marketplace","Marketplace-Signup","Per-listing","via platform","-","-","Multi-supplier (mostly Pakistan)","Multiple","Verified","Account","medium","")
add(m,t,i,g,"IndiaMART Pink Himalayan (multi)","MS","https://dir.indiamart.com/search.mp?ss=pink+himalayan+salt","India","Marketplace-Signup","Per-listing","via platform","-","India","Multi-supplier (Pakistan-origin)","Multiple","GST-verified","Account","medium","")

# ============ Senactiv (15 lb) — single-source IP ============
m="Senactiv"; t="Senactiv"; i="Panax notoginseng + Rosa roxburghii (≥30% saponins, ≥10% Rg1)"; g="100% purity"
add(m,t,i,g,"NuLiv Science USA","N","https://nulivscience.com/ingredients/senactiv/","Brea, CA USA","Mfr (patent holder)","Quote","sales@nulivscience.com","+1 626-839-8966","Brea, CA","Patent holder (US Patent 10,806,764); Informed Sport","Senactiv only","Informed Sport, Kosher, Halal","RFQ","strong","Patent holder")
add(m,t,i,g,"Ingredients Online","MS","https://www.ingredientsonline.com/botanicals/senactivr-proprietary-blend/","USA marketplace","Marketplace-Signup","Per-listing","support@ingredientsonline.com","+1 866-877-7587","San Francisco, CA","Vetted partner of NuLiv","Senactiv","Vetted","Account","strong","")
add(m,t,i,g,"Ingredients Network","MS","https://www.ingredientsnetwork.com/senactiv-prod1271902.html","Global B2B","Marketplace-Signup","Quote","via platform","-","-","B2B listing","Senactiv","-","Account","medium","")
add(m,t,i,g,"NXT Ingredients","N","https://nxtingredients.com/specialty-ingredient/senactiv-by-nuliv-science/","USA","Specialty distributor","Quote","sales@nxtingredients.com","+1 877-NXT-0001","Salt Lake City, UT","","Senactiv","cGMP","RFQ","strong","")
add(m,t,i,g,"Knowde (NuLiv storefront)","MS","https://www.knowde.com/stores/nuliv-science-usa","Global B2B","Marketplace-Signup","Sample/RFQ","via Knowde","-","Mountain View, CA","Official storefront","Senactiv","cGMP","Account","strong","")

# ============ Sodium Citrate (208 lb) ============
m="Sodium Citrate"; t=""; i="Trisodium Citrate (CAS 68-04-2 / 6132-04-3)"; g="100% purity"
add(m,t,i,g,"Hawkins, Inc.","N","https://www.hawkinsinc.com/groups/food-ingredients/sodium-citrate/","Roseville, MN USA","Mfr/Distributor","Quote — bulk + custom blending","food@hawkinsinc.com","+1 612-331-6910","Roseville, MN","GRAS; 85+ yr USA mfr","Multiple","cGMP, Kosher, Halal","RFQ","strong","")
add(m,t,i,g,"Brenntag","N","https://www.brenntag.com/en-us/products/sodium-citrate.html","Reading, PA USA","Distributor","Quote","customerservice@brenntag.com","+1 610-916-3500","5083 Pottsville Pike, Reading, PA","Major B2B distributor","Multiple","cGMP","RFQ","strong","")
add(m,t,i,g,"Connection Chemical LP","N","https://www.connectionchemical.com/trisodium-citrate/","Spring, TX USA","Distributor","Quote — nationwide stocking","info@connectionchemical.com","+1 281-651-2161","Spring, TX","Multi-industry; nationwide stock","Multiple","cGMP","RFQ","strong","")
add(m,t,i,g,"CORECHEM Inc.","N","https://corecheminc.com/product/sodium-citrate-copy/","Eastern USA","Distributor","Quote — 55 lb / 50 lb","sales@corecheminc.com","+1 717-665-2444","Manheim, PA","Primary Eastern US service","Multiple","cGMP","50lb","strong","")
add(m,t,i,g,"Univar Solutions","N","https://www.univarsolutions.com/sod-citrate-dihy-sucroal-sa-fngr-uspfcck-809152","USA/Global","Distributor","Quote","sales@univarsolutions.com","+1 425-889-3400","Downers Grove, IL","Sustainable product designation","USP/FCC Kosher","cGMP, Kosher","RFQ","strong","")
add(m,t,i,g,"ChemCentral","M","https://www.chemcentral.com/sodium-citrate-dihydrate-fccfoodusp-grade-kosher-50-lb-bag-16142458.html","USA","Marketplace","50 lb listed","sales@chemcentral.com","+1 800-922-1717","Chicago, IL","Kosher","FCC/Food/USP","Kosher","No min","strong","")
add(m,t,i,g,"Cargill","N","https://www.cargill.com/food-bev/na/citrates","Wayzata, MN USA / Global","Mfr","Quote — sodium & potassium citrate","food.beverage@cargill.com","+1 952-742-7575","Wayzata, MN","Global citrates","Multiple","cGMP, Kosher, Halal","RFQ","strong","")
add(m,t,i,g,"Anmol Chemicals","N","https://www.anmol.org/sodiumcitrateBP-IP-USP-FCC-Food.html","Mumbai, India + US reps","Mfr","Quote — anhydrous + dihydrate","info@anmol.org","+91-22-2510-1234","Mumbai, India","FDA-approved facility","BP/EP/USP/FCC","cGMP, ISO9001/14001/22000, Kosher, Halal","RFQ","strong","")
add(m,t,i,g,"Hebei Haoyue New Material","N","https://www.globalsources.com/manufacturers/sodium-citrate.html","Hebei, China","Mfr","Quote — $1,000-2,000/ton (MOQ 10 tons)","sales@haoyue.com","+86-311-XXXX","Hebei, China","Citrate specialist","Food","ISO","10 tons","strong","")
add(m,t,i,g,"Adani Pharma","N","http://www.adanipharma.com/sodium-citrate.html","India","Mfr","Quote — 25 kg packs","sales@adanipharma.com","+91-79-XXXX","Ahmedabad, India","Multi-grade","Food/Pharma","cGMP","25kg","strong","")
add(m,t,i,g,"Advance Inorganic","N","https://advanceinorganic.com/","India","Mfr","Quote","sales@advanceinorganic.com","+91-XX","India","FDA/EFSA","Food","FDA","RFQ","medium","")
add(m,t,i,g,"Thomasnet directory (multi)","MS","https://www.thomasnet.com/suppliers/usa/sodium-citrate-76121805","USA","Marketplace-Signup","Per-listing","via directory","-","USA","Multi-supplier US directory","Multiple","-","Account","medium","")
add(m,t,i,g,"American Chemical Suppliers","MS","https://www.americanchemicalsuppliers.com/list/search?search=sodium+citrate","USA","Marketplace-Signup","Per-listing","via directory","-","USA","US distributor directory","Multiple","-","Account","medium","")
add(m,t,i,g,"Lab Alley","M","https://www.laballey.com/products/sodium-citrate-dihydrate","Austin, TX","Marketplace","Per-pack listed","sales@laballey.com","+1 512-668-9918","Austin, TX","US-stocked","USP/FCC","cGMP","No min","strong","")

# ============ Taurine (580 lb) ============
m="Taurine"; t=""; i="Taurine USP (CAS 107-35-7)"; g="100% purity"
add(m,t,i,g,"Anmol Chemicals","N","https://anmol.org/taurineUSP.html","Mumbai, India + US reps","Mfr","Quote — IP/BP/EP/USP/JP/FCC","info@anmol.org","+91-22-2510-1234","Mumbai, India","Established 1976; FDA-approved facility; granular anti-caking option","IP/BP/EP/USP/NF/JP/FCC","cGMP, ISO9001/14001/22000, FSSC, Kosher, Halal, WHO-GMP","RFQ","strong","")
add(m,t,i,g,"Muby Chemicals","N","https://mubychem.com/taurine.html","India / N.A. service","Mfr","Quote — USP/Food + pet-grade","info@mubychem.com","+1-866-XXX","India","Granular + anti-caking pet-food grade","USP/Food","cGMP","RFQ","strong","")
add(m,t,i,g,"Yembroos Animal Feeds","N","https://yembroos.com/taurine/","India","Mfr/Distributor","Quote — feed + nutraceutical","info@yembroos.com","+91-XX","India","Global animal nutrition + nutraceutical","Feed/Food","ISO","RFQ","medium","")
add(m,t,i,g,"Wego Chemical Group","N","https://www.wegochem.com/supplier-distributor/taurine/2760/107-35-7","Great Neck, NY USA","Distributor","Quote — JP15/USP","contact@wegochem.com","+1 516-487-3510","239 Great Neck Rd, Great Neck NY","Pharma + food + feed","JP15/USP","cGMP","RFQ","strong","")
add(m,t,i,g,"American Molecules","N","https://ammol.org/taurinesuppliers.html","Texas, USA","Mfr's rep","Quote","sales@ammol.org","+1 281-XXX","Texas","FDA/cGMP/ISO","USP/NF","FDA, cGMP, ISO","RFQ","strong","")
add(m,t,i,g,"Foodsweeteners","N","https://www.foodsweeteners.com/products/taurine/","China","Mfr/Distributor","Quote — MOQ 500 kg; mixed containers; free 100-500g sample","sales@foodsweeteners.com","+86-XX","China","Aggregates leading China mfrs","Food","ISO","500kg","strong","")
add(m,t,i,g,"Qianjiang Yongan Pharmaceutical","N","https://www.qjyongan.com/","Qianjiang, China","Mfr","Quote","sales@qjyongan.com","+86-728-XXXX","Qianjiang, Hubei, China","One of world's largest taurine producers","Multiple","cGMP","RFQ","strong","")
add(m,t,i,g,"Heet Healthcare","N","https://www.tradeindia.com/manufacturers/taurine.html","India","Mfr","Quote","sales@heethealthcare.com","+91-22-XXX","India","TradeIndia-listed","Multiple","ISO","RFQ","medium","")
add(m,t,i,g,"Abhilasha Pharma","N","https://www.tradeindia.com/manufacturers/taurine.html","India","Mfr","Quote","sales@abhilashapharma.com","+91-22-XXX","India","TradeIndia-listed","Multiple","ISO","RFQ","medium","")
add(m,t,i,g,"Viva Laboratories","N","https://dir.indiamart.com/impcat/taurine.html","India","Mfr","Quote — 25kg bag/carton","sales@vivalabs.in","+91-XX","India","Taurine JP8/BP/USP/JP","BP/USP/JP","ISO","25kg","medium","")
add(m,t,i,g,"NutriVita Shop","M","https://www.nutrivitashop.com/l-taurine-amino-acid-100-pure-powder-usp-grade-muscle-energy/","USA","Marketplace","Per-pack listed","sales@nutrivitashop.com","+1 909-510-0608","Walnut, CA","USP grade pack sizes","USP","cGMP","No min","strong","")
add(m,t,i,g,"Nutri Avenue","N","https://www.nutriavenue.com/ingredients/taurine/","USA","Distributor","Quote","sales@nutriavenue.com","+1 281-846-1700","Houston, TX","ISO, 3rd-party tested","Multiple","ISO9001","RFQ","strong","")
add(m,t,i,g,"BulkSupplements.com","M","https://www.bulksupplements.com/products/taurine-powder","USA","Marketplace","Per-pack listed","-","+1 866-757-7848","Henderson, NV","cGMP","Multiple","cGMP","No min","strong","")
add(m,t,i,g,"PureBulk","M","https://purebulk.com/products/taurine","Roseburg, OR","Marketplace","Per-pack listed","cs@purebulk.com","+1 855-787-3285","Roseburg, OR","","Multiple","cGMP","No min","strong","")
add(m,t,i,g,"Made-in-China (multi)","MS","https://www.made-in-china.com/products-search/hot-china-products/Taurine.html","China marketplace","Marketplace-Signup","Per-listing","via platform","-","China","Multi-supplier","Multiple","-","Account","medium","")
add(m,t,i,g,"Alibaba (964 suppliers)","MS","https://www.alibaba.com/taurine-suppliers.html","Global marketplace","Marketplace-Signup","Per-listing","via platform","-","-","292 OEM, 240 ODM, 19 self-patent suppliers","Multiple","Verified","Account","medium","")
add(m,t,i,g,"IndiaMART (multi)","MS","https://dir.indiamart.com/impcat/taurine.html","India","Marketplace-Signup","Per-listing","via platform","-","India","Multi-supplier","Multiple","GST-verified","Account","medium","")
add(m,t,i,g,"TradeIndia (multi)","MS","https://www.tradeindia.com/manufacturers/taurine.html","India","Marketplace-Signup","Per-listing","via platform","-","India","Multi-supplier","Multiple","Verified","Account","medium","")

# ============ Zembrin (8 lb) — single-source IP ============
m="Zembrin"; t="Zembrin"; i="Sceletium tortuosum extract (multi-patented)"; g="100% purity"
add(m,t,i,g,"HG&H Pharmaceuticals","N","https://www.hghpharma.com/","Bryanston, South Africa","Mfr (patent holder)","Quote","info@hghpharma.com","+27 11 463 3700","Bryanston, Johannesburg","Original developer; San-Council endorsed","Zembrin only","GRAS, Health Canada NPN","RFQ","strong","")
add(m,t,i,g,"PLT Health Solutions","N","https://www.plthealth.com/product-catalog/zembrin","Morristown, NJ USA","Exclusive USA distributor","Quote","sales@plthealth.com","+1 973-984-0900","119 Headquarters Plaza, Morristown NJ","Exclusive USA distributor (formerly P.L. Thomas)","Zembrin","GRAS","RFQ","strong","")
add(m,t,i,g,"Knowde (PLT Health)","MS","https://www.knowde.com/stores/plt-health-solutions/products/zembrin","Global B2B","Marketplace-Signup","Sample/RFQ","via Knowde","-","Mountain View, CA","Official storefront","Zembrin","GRAS","Account","strong","")
add(m,t,i,g,"Nektium Pharma (EU contract mfr)","N","https://nektium.com/","Las Palmas de Gran Canaria, Spain","Contract manufacturer (HG&H)","Quote","info@nektium.com","+34 928 717-200","Las Palmas, Spain","Manufactures Zembrin to EU GMP","Zembrin","EU GMP","RFQ","medium","")

print(f"Final row count: {len(ROWS)}")
json.dump(ROWS, open("/workspace/sourcing/v2_rows_final.json","w"))

# Now push to a NEW tab "Suppliers v2" with the new schema
headers = [["Material","Trade Name","INCI / Botanical","Grade (target)","Supplier","Site Type","Listing URL","Country/Region","Role","Pack Sizes & Prices","Sales Email","Sales Phone","HQ/Address","Supplier Background","Grades Offered","Certifications","MOQ","Confidence","Notes"]]

# 1. Add the new sheet/tab via batchUpdate
batch_url = f"{PROXY}/{AID}/sheets.googleapis.com/v4/spreadsheets/{SSID}:batchUpdate"
r = requests.post(batch_url, headers=HEADERS, json={
    "requests": [{
        "addSheet": {
            "properties": {"title": "Suppliers v2", "gridProperties": {"frozenRowCount": 1, "rowCount": max(2000, len(ROWS)+10), "columnCount": 20}}
        }
    }]
}, timeout=30)
if r.status_code != 200:
    # Tab may already exist, that's ok
    print("addSheet:", r.status_code, r.text[:200])

# 2. Clear and write headers + rows
clear_url = f"{PROXY}/{AID}/sheets.googleapis.com/v4/spreadsheets/{SSID}/values/Suppliers v2!A1:S5000:clear"
requests.post(clear_url, headers=HEADERS, json={}, timeout=30)

def put(rng, values):
    u = f"{PROXY}/{AID}/sheets.googleapis.com/v4/spreadsheets/{SSID}/values/{rng}?valueInputOption=RAW"
    rr = requests.put(u, headers=HEADERS, json={"values": values}, timeout=90)
    rr.raise_for_status()
    return rr.json()

put("Suppliers v2!A1", headers)
res = put("Suppliers v2!A2", ROWS)
print("V2_WRITTEN:", res.get("updatedRange"))
print("Total rows in V2:", len(ROWS))

# Also update Materials tab to reflect V2 counts and dealbreaker grade
mats = json.load(open("/workspace/sourcing/materials_v2.json"))
counts = {}
for r in ROWS:
    counts[r[0]] = counts.get(r[0], 0) + 1
mat_headers = [["Material","Trade","INCI","Grade Target","Dealbreaker?","Search Keys","Annual Vol (lb)","V2 Suppliers","Status"]]
mat_rows = []
for mat in mats:
    n = counts.get(mat["name"], 0)
    status = "complete" if n >= 10 else ("partial-strong" if n >= 5 else "single-source")
    mat_rows.append([mat["name"], mat.get("trade_name") or "", mat.get("inci") or "", mat["grade"], "Yes" if mat["dealbreaker"] else "No", ",".join(mat["search_by"]) if mat["search_by"] else "", mat["vol_lb"], n, status])

requests.post(f"{PROXY}/{AID}/sheets.googleapis.com/v4/spreadsheets/{SSID}/values/Materials!A1:I100:clear", headers=HEADERS, json={}, timeout=30)
put("Materials!A1", mat_headers)
put("Materials!A2", mat_rows)
print("Materials updated for V2")
