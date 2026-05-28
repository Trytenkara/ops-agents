"""Build complete supplier dataset and push to Google Sheet."""
import json, os, requests

cfg = json.load(open("/workspace/sourcing/sheet.json"))
PROXY = os.environ["PROXY_BASE_URL"].rstrip("/")
TOKEN = os.environ["PROXY_TOKEN"]
HEADERS = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}
SSID = cfg["spreadsheet_id"]
AID = cfg["account_id"]

# Columns: Material | Trade | INCI/Botanical | Supplier | Website | Country/Region | Pack Sizes | Price | Distributor/Manufacturer | Listing URL | Contact | Notes | Confidence
SUPP = []

def add(material, trade, inci, supplier, website, region, pack, price, role, listing, contact, notes, conf):
    SUPP.append([material, trade, inci, supplier, website, region, pack, price, role, listing, contact, notes, conf])

# 1. Acetyl-L-Carnitine
m="Acetyl-L-Carnitine"; t=""; i="ALCAR HCl"
add(m,t,i,"Lonza (Carnipure)","lonza.com","Switzerland/Global","Bulk drums","Quote","Manufacturer (premium benchmark)","https://www.lonza.com/capsules-health-ingredients/nutraceutical-solutions/ingredients/carnipure","sales rep","Industry-leading L-carnitine maker; ALCAR variant","strong")
add(m,t,i,"Vivion","vivion.com","USA","Bulk (drums)","Quote","Distributor","https://vivion.com/bulk-l-carnitine-supplier/","website RFQ","Wholesale distributor, MOQs apply","strong")
add(m,t,i,"American International Foods (AIFI)","americaninternationalfoods.com","USA","Bulk","Quote","Distributor","https://www.americaninternationalfoods.com/ingredient-categories/amino-acids/l-carnitine/","website RFQ","2500+ ingredient portfolio","strong")
add(m,t,i,"AgEx Pharma","agexpharma.com","India / USA (NY,NJ,CA)","Bulk; 30,000 kg/mo cap","Quote","Manufacturer (cGMP)","https://www.agexpharma.com/acetyl-l-carnitine-hcl.html","website","US east+west coast stocking","strong")
add(m,t,i,"Independent Chemical","independentchemical.com","USA","Bulk, LTL","Quote","Distributor","https://independentchemical.com/chemical-distributor/acetyl-l-carnitine-hcl-supplier-2083.aspx","website","","strong")
add(m,t,i,"PureBulk","purebulk.com","USA","Pack sizes online","Listed online (per pack-size)","Distributor","https://purebulk.com/products/alcar-acetyl-l-carnitine-bulk","website","Site lists prices per pack size","strong")
add(m,t,i,"BulkSupplements.com","wholesale.bulksupplements.com","USA","100g–25kg drums","Listed online","Distributor/Mfr","https://www.bulksupplements.com/products/acetyl-l-carnitine-hcl","website","cGMP, 3rd-party tested","strong")
add(m,t,i,"SRS Nutrition Express","srs-nutritionexpress.com","China/Global","OEM/Bulk","Quote","Manufacturer/OEM","https://www.srs-nutritionexpress.com/n-acetyl-l-carnitine/","website","B2B/OEM wholesale","medium")
add(m,t,i,"Herb Store USA","herbstoreusa.com","USA","Bulk powder","Listed (from $11.95)","Distributor","https://herbstoreusa.com/cognitive--brain--acetyl-l-carnitine.html","website","","medium")
add(m,t,i,"Gynger / Alkano Chemicals","gyngeringredients.com","Global","Bulk","Quote","Manufacturer/Distributor","https://gyngeringredients.com/ingredient/402/Acetyl-L-Carnitine-Hcl","website","25+ yr ingredient supplier","medium")

# 2. Affron
m="Affron"; t="Affron"; i="Crocus sativus L. extract (Lepticrosalides ≥3.5%)"
add(m,t,i,"Pharmactive Biotech Products (Mfr)","pharmactive.eu","Spain (HQ)/Global","B2B ingredient","Quote (direct)","Manufacturer (patent holder)","https://pharmactive.eu/ingredient/affron_r-improves-your-mood/","info@pharmactive.eu","Single source — vertically integrated; brand owner","strong")
add(m,t,i,"Pharmactive Biotech USA","usa.pharmactive.eu","USA office","B2B","Quote","Manufacturer (N.A. office)","https://usa.pharmactive.eu/product/saffron-extract/","USA office form","North America office","strong")
add(m,t,i,"Knowde (Pharmactive storefront)","knowde.com","Global B2B platform","Sample / B2B","Quote","Authorized marketplace","https://www.knowde.com/stores/pharmactive-biotech-products/brands/pharmactive-biotech-products-affron","Knowde","Official storefront","strong")
add(m,t,i,"Hyundai Bioland","hyundaibioland.co.kr","South Korea","B2B (APAC)","Quote","Authorized regional partner","","Cheongju-si","K-beauty/functional foods partner; MFDS-approved","medium")
add(m,t,i,"Solaray (finished-good licensee — for ref)","solaray.com","USA","Finished product","Retail","Brand partner (not B2B raw)","https://solaray.com/products/affron-saffron-extract","retail","Reference — formulator using Affron","lead")

# 3. Alpha GPC
m="Alpha GPC"; t=""; i="L-alpha-glycerylphosphorylcholine"
add(m,t,i,"BulkSupplements.com Wholesale","wholesale.bulksupplements.com","USA","25kg drum (units)","Some online; otherwise quote","Distributor","https://wholesale.bulksupplements.com/products/alpha-gpc-l-alpha-glycerylphosphorylcholine","website","cGMP, third-party tested","strong")
add(m,t,i,"Green Jeeva","greenjeeva.com","USA","99% bulk","Quote","Distributor","https://www.greenjeeva.com/product/alpha-gpc-powder-99","website RFQ","USP <232>, Prop 65 compliant","strong")
add(m,t,i,"Jeeva Organic","jeevaorganic.com","USA/Global","Bulk","Quote","Distributor","https://jeevaorganic.com/products/bulk-alpha-gpc-powder-supplier","website","","strong")
add(m,t,i,"Nutri Avenue (GPCKey)","nutriavenue.com","USA","50%/90%","Quote","Distributor (brand: GPCKey)","https://www.nutriavenue.com/alpha-gpc-2/","website","ISO certified, 3rd-party tested","strong")
add(m,t,i,"LonierHerb (Shaanxi)","ingredients-lonier.com","China","25kg drum, MOQ 1kg","Quote","Manufacturer","https://www.ingredients-lonier.com/hot-sales/alpha-gpc-powder.html","website","50%/99%, GMP","strong")
add(m,t,i,"Organic Herb Inc (via Ingredients Online)","ingredientsonline.com","USA marketplace","Bulk 50%","Quote","Manufacturer + marketplace","https://www.ingredientsonline.com/phytochemicals/l-alpha-glycerylphosphorylcholine-50/","Ingredients Online","COAs, technical specs","strong")
add(m,t,i,"Hansen Supplements","hansensupplements.com","Scandinavia/EU","99%+","Listed","Distributor","https://www.hansensupplements.com/products/alpha-gpc","website","","medium")
add(m,t,i,"Xi'an Eco Biotech","xianecobiotech.com","China","Bulk","Quote","Manufacturer","https://www.accio.com/supplier/alpha-gpc-manufacturer","sales","GMP, ISO, HACCP","medium")
add(m,t,i,"Vitaspring Nutrition","vitaspring.com","China","Bulk","Quote","Manufacturer","https://www.accio.com/supplier/alpha-gpc-manufacturer","sales","100% OTD, 5.0 review, 43% reorder","medium")
add(m,t,i,"Global Sources (Dalian Handom, Wuxi Cima, PNP Biotech)","globalsources.com","China marketplace","Bulk","Quote","Marketplace","https://www.globalsources.com/manufacturers/alpha-gpc.html","Global Sources","Multiple manufacturers","medium")

# 4. AstraGin
m="AstraGin"; t="AstraGin"; i="Astragalus membranaceus + Panax notoginseng (proprietary)"
add(m,t,i,"NuLiv Science USA (Manufacturer)","nulivscience.com","USA/Taiwan","B2B ingredient","Quote (direct)","Manufacturer (patent holder)","https://nulivscience.com/ingredients/astragin/","website B2B","Patent holder; GRAS; Informed Ingredient; Kosher","strong")
add(m,t,i,"Nutrition Formulators Inc (NFI)","nutritionformulators.com","Miramar, FL USA","B2B","Quote","Exclusive sports nutrition supplier","https://www.nutraceuticalsworld.com/issues/2010-09/view_industry-news/nuliv-science-taps-nfi-to-supply-astragin","NFI sales","Exclusive sports nutrition channel","strong")
add(m,t,i,"Ingredients Online","ingredientsonline.com","USA marketplace","1kg box","Listed","Authorized marketplace","https://www.ingredientsonline.com/astragin-proprietary-blend-1kg-box-by-nuliv-science.html","Ingredients Online","Vetted partner of NuLiv","strong")
add(m,t,i,"Knowde (NuLiv storefront)","knowde.com","Global B2B","B2B","Quote","Authorized marketplace","https://www.knowde.com/stores/nuliv-science-usa/products/astragin","Knowde","Official storefront","strong")
add(m,t,i,"UL Prospector","ulprospector.com","Global B2B database","B2B","Quote","Listing","https://www.ulprospector.com/en/na/Food/Detail/6698/224468/AstraGin","UL Prospector","Ingredient DB listing","medium")
add(m,t,i,"Ingredients Network","ingredientsnetwork.com","Global B2B","B2B","Quote","Listing","https://www.ingredientsnetwork.com/astragin-prod1271901.html","website","","medium")

# 5. Betaine
m="Betaine"; t=""; i="Trimethylglycine (TMG)"
add(m,t,i,"WHYZ","whyz.com","USA (US warehouse)","Bulk; free sample 1-3 day","COA included; quote","Distributor","https://whyz.com/bulk/amino-acids/betaine-anhydrous/","bulk@whyz.com","Free eval samples, 2-3yr shelf life","strong")
add(m,t,i,"Nutri Avenue","nutriavenue.com","USA","Wholesale powder","Quote","Distributor","https://www.nutriavenue.com/ingredients/betaine-anhydrous/","website","ISO, 98% pharma grade","strong")
add(m,t,i,"PureBulk","purebulk.com","Missoula, MT, USA","Food-grade no fillers","Listed online","Distributor","https://purebulk.com/products/betaine-anhydrous-tmg","website","Food-grade, no anti-caking","strong")
add(m,t,i,"BulkSupplements.com","bulksupplements.com","USA","100g/250g/500g/1kg/5kg/25kg","Listed online","Distributor","https://www.bulksupplements.com/products/betaine-anhydrous-trimethylglycine-tmg-powder","website","25kg drum option for B2B","strong")
add(m,t,i,"Prescribed For Life","prescribedforlife.com","Dripping Springs, TX","340g–25kg","Listed online","Distributor","https://www.amazon.com/Betaine-Anhydrous-TMG-Trimethylglycine-Homocysteine/dp/B0844NF2L3","website","GMP USA packaging","strong")
add(m,t,i,"Biogenic Foods","biogenicfoods.com","USA","100% pure bulk pack","Quote","Distributor","https://biogenicfoods.com/trimethyl-glycine-tmg-betaine-anhydrous-100-pure-crystalline-powder-bulk-pack/","website","Crystalline powder","medium")
add(m,t,i,"American Chemical Suppliers Directory","americanchemicalsuppliers.com","USA","Variable","Quote","Directory","https://www.americanchemicalsuppliers.com/list/search?search=betaine","via directory","Discover additional US distributors","medium")
add(m,t,i,"Alibaba (multiple)","alibaba.com","China/Global","Variable","Quote","Marketplace","https://www.alibaba.com/showroom/betaine-anhydrous-trimethylglycine.html","via marketplace","Many food/feed grade options","medium")
add(m,t,i,"AB Sugar / DuPont (Danisco) — historical bulk producers","ab-sugar.com","EU/USA","Industrial bulk (beet origin)","Quote","Manufacturer","https://www.ab-sugar.com/","sales","Bulk betaine derived from sugar beet","lead")

# 6. Caffeine
m="Caffeine"; t=""; i="Caffeine anhydrous USP (CAS 58-08-2)"
add(m,t,i,"Silver Fern Chemical","silverfernchemical.com","USA","Bulk specialty","Quote","Distributor","https://www.silverfernchemical.com/chemical-supplier-58-08-2/caffeine-anhydrous-distributor-401.aspx","website","20+ yrs N.A. distribution","strong")
add(m,t,i,"Spectrum Chemical","spectrumchemical.com","USA","USP/NF/EP/BP/JP/FCC","Listed/Quote","Distributor","https://www.spectrumchemical.com/caffeine-anhydrous-usp-c4036","website","FDA-registered, cGMP, ICH Q7","strong")
add(m,t,i,"Carolina Chemical","carolinachemical.com","USA","USP/FCC ≥99%","Listed/Quote","Distributor","https://carolinachemical.com/product/caffeine-powder-anhydrous-pure/","website","BP/EP/USP/FCC compliant","strong")
add(m,t,i,"Ingredi (ADM/Shandong Xinhua)","ingredi.com","USA","44 lb / 20 kg cartons","Listed online","Distributor","https://ingredi.com/caffeine-anhydrous-44-lb-carton/","website","Shandong Xinhua Pharma-packed","strong")
add(m,t,i,"NutriVita Shop","nutrivitashop.com","USA","USP grade","Listed online","Distributor","https://www.nutrivitashop.com/caffeine-anhydrous-usp-100-pure-25kg-55lbs/","website","US pharma grade","strong")
add(m,t,i,"The Bulk Cart","thebulkcart.com","California, USA","Bulk powder","Quote","Distributor","https://www.thebulkcart.com/extracts/caffeine-anhydrous-powder/","website","100K sqft USDA-cert facility","strong")
add(m,t,i,"Nutri Avenue","nutriavenue.com","USA","Bulk","Quote","Distributor","https://www.nutriavenue.com/ingredients/caffeine-anhydrous-bulk-powder/","website","ISO certified, 3rd-party tested","strong")
add(m,t,i,"Independent Chemical","independentchemical.com","USA","Bulk, LTL","Quote","Distributor","https://independentchemical.com/chemical-distributor/caffeine-supplier-2149.aspx","website","","strong")
add(m,t,i,"Cowin Industry","cowinindustry.com","China","USP/EP/FCC ≥99%","Quote","Manufacturer/exporter","https://www.cowinindustry.com/caffeine-anhydrous-5765335.html","FOB China","Distributors, exporters welcome","medium")
add(m,t,i,"Shandong Xinhua Pharma","xinhuapharm.com","China","Bulk (44 lb cartons)","Quote","Manufacturer","https://www.xinhuapharm.com/","sales","One of world's largest caffeine producers","strong")

# 7. Capsimax
m="Capsimax"; t="Capsimax"; i="Capsicum annuum extract (2% capsaicinoids)"
add(m,t,i,"OmniActive Health Technologies (Mfr)","omniactives.com","India/USA (Short Hills NJ)","B2B","Quote","Manufacturer (patent holder)","https://omniactives.com/product/capsimax/","Short Hills NJ office","Patent holder; OmniBead encap","strong")
add(m,t,i,"OmniActive India HQ","indiamart.com/omniactivehealthtechnologiesltd","Mumbai, India","B2B (APAC)","Quote","Manufacturer","https://www.indiamart.com/omniactivehealthtechnologiesltd/","listing form","APAC sourcing","strong")
add(m,t,i,"Branded-Ingredients listing","branded-ingredients.com","Global","B2B","Quote","Listing","https://www.branded-ingredients.com/brands/capsimax/","website","Reference listing","medium")
add(m,t,i,"capsimax.com (B2C portal)","capsimax.com","USA","B2C / brand education","-","Consumer portal","https://www.capsimax.com/","-","Use to verify authorized buyers","lead")

# 8. Di-Caffeine Malate (Infinergy)
m="Di-Caffeine Malate"; t="Infinergy"; i="Di-Caffeine Malate (~75% caffeine, 25% malic acid)"
add(m,t,i,"Creative Compounds (Mfr)","creativecompounds.com","USA","B2B","Quote (direct)","Manufacturer (trademark holder)","https://www.creativecompounds.com/exclusive.php","sales","Trademark holder; Malate Series","strong")
add(m,t,i,"Knowde (Creative Compounds storefront)","knowde.com","Global B2B","Per kg","Quote — MOQ/lead time","Authorized marketplace","https://www.knowde.com/stores/creative-compounds/products/infinergy-di-caffeine-malate","Knowde","Sample & RFQ","strong")
add(m,t,i,"NXT Ingredients","nxtingredients.com","USA","B2B","Quote","Specialty distributor","https://nxtingredients.com/specialty-ingredient/infinergy-by-creative-compounds/","website","","strong")
add(m,t,i,"NutraCap USA","nutracapusa.com","USA","Contract mfg / finished","Quote","Contract manufacturer (formulates with Infinergy)","https://www.nutracapusa.com/di-caffeine-malate/","website","Private-label using Infinergy","medium")

# 9. Dihydroberberine (GlucoVantage)
m="Dihydroberberine"; t="GlucoVantage"; i="Dihydroberberine (from Berberis aristata)"
add(m,t,i,"NNB Nutrition (Mfr)","nnbnutrition.com","USA/Global","B2B","Quote (direct)","Manufacturer (brand owner)","https://www.nnbnutrition.com/ingredients/gluco-vantage/","info@nnbnutrition.com","First commercial DHB brand","strong")
add(m,t,i,"Knowde (NNB storefront)","knowde.com","Global B2B","B2B","Quote","Authorized marketplace","https://www.knowde.com/stores/nnb-nutrition-usa/products/glucovantage","Knowde","Sample/RFQ","strong")
add(m,t,i,"NXT Ingredients","nxtingredients.com","USA","B2B","Quote","Specialty distributor","https://nxtingredients.com/specialty-ingredient/glucovantage-by-nnb-nutrition/","website","Single-source ingredient (NNB IP)","strong")

# 10. ElevATP
m="ElevATP"; t="ElevATP"; i="Ancient peat + apple polyphenol extract"
add(m,t,i,"FutureCeuticals (Mfr)","futureceuticals.com","Momence IL, USA","B2B","Quote (direct)","Manufacturer (patent holder)","https://www.futureceuticals.com/elevatp","sales / brochure form","Patent holder; GRAS; Health Canada","strong")
add(m,t,i,"Knowde (VDF/FutureCeuticals storefront)","knowde.com","Global B2B","B2B","Quote","Authorized marketplace","https://www.knowde.com/stores/vdf-futureceuticals/products/elevatp","Knowde","Sample/spec sheet","strong")
add(m,t,i,"NXT Ingredients","nxtingredients.com","USA","B2B","Quote","Specialty distributor","https://nxtingredients.com/specialty-ingredient/elevatp-by-futureceuticals/","website","","strong")
add(m,t,i,"NutraCap USA","nutracapusa.com","USA","Contract mfg / finished","Quote","Contract manufacturer","https://www.nutracapusa.com/elevatp/","website","Private-label using ElevATP","medium")

# 11. Epicatechin
m="Epicatechin"; t=""; i="Epicatechin 90-98% (cocoa/green tea derived; CAS 490-46-0)"
add(m,t,i,"Nutri Avenue (Epicatelean®)","nutriavenue.com","USA (CA & FL warehouses)","Bulk 90/95/98%","Free sample US warehouse","Distributor (brand)","https://www.nutriavenue.com/epicatelean/","website","Green tea sourced; HPLC reports","strong")
add(m,t,i,"Xi'an Sonwu Biotech","sonwuapi.com","China","≥98%, bulk","Quote","Manufacturer","https://www.sonwuapi.com/plant-extract/epicatechin-powder.html","website","ISO/GMP/HACCP/SGS; OEM","strong")
add(m,t,i,"Medikonda Nutrients","medikonda.com","USA / India origin","Cocoa extract bulk","Quote","Manufacturer/Distributor","https://www.medikonda.com/products/cocoa-extract-powder-bulk-wholesale-suppliers-in-usa","website","USDA/EU/Kosher","strong")
add(m,t,i,"REVEDA","reveda.com","USA","Bulk Cocoa Extract","Quote","Manufacturer/Distributor","https://www.reveda.com/products/buy-wholesale-bulk-cocoa-extract-powder-suppliers-online-in-usa","website","USDA/EU/Kosher cocoa","strong")
add(m,t,i,"Vivion (cocoa powder)","vivion.com","USA","50 lb min","Quote","Distributor","https://vivion.com/bulk-cocoa-powder-supplier/","website","Cocoa-based","medium")
add(m,t,i,"Made-in-China (multi-supplier)","made-in-china.com","China marketplace","Bulk","Quote","Marketplace","https://www.made-in-china.com/products-search/hot-china-products/Wholesale_Epicatechin.html","via marketplace","Green tea/cocoa-derived","medium")
add(m,t,i,"Medikonda Australia","medikonda.com.au","Australia/NZ","Bulk cocoa extract","Quote","Distributor","https://medikonda.com.au/products/cocoa-extract-powder-bulk-wholesale-suppliers-in-australia","website","ANZ supplier","medium")

# 12. GBB / Gamma-Butyrobetaine
m="GBB"; t=""; i="Gamma-Butyrobetaine HCl (CAS 2508-19-2) and GBB-EEC (CAS 51963-62-3)"
add(m,t,i,"Nutri Avenue","nutriavenue.com","USA","Bulk HCl and EEC variants","Quote","Distributor (OEM/ODM)","https://www.nutriavenue.com/ingredients/gamma-butyrobetaine-hcl/","website","ISO certified; both salt forms","strong")
add(m,t,i,"WHYZ","whyz.com","USA","Bulk EEC; free sample","Quote 1 biz day","Distributor","https://whyz.com/bulk/sports-performance/gamma-butyrobetaine-ethyl-ester-chloride/","bulk@whyz.com","COA included; 2-3yr shelf","strong")
add(m,t,i,"Bulk Stimulants","bulkstimulants.com","USA","Bulk powder","Listed","Distributor","https://www.bulkstimulants.com/GBB-Gamma-Butyrobetaine-Powder-NEW_p_47.html","website","","medium")
add(m,t,i,"NutraCap Labs","nutracapusa.com","USA","Finished/private-label","Quote","Contract manufacturer","https://www.nutracapusa.com/lean-gbb-gamma-butyrobetaine/","website","Branded as 'Lean GBB'","medium")
add(m,t,i,"CNCSBIO","cncsbio.com","China","Pharma-grade GBB-EEC","Quote","Manufacturer","https://cosmeticraw.com/product/gamma-butyrobetaine-ethyl-ester-hydrochloride/","website","COA, MSDS, HPLC/IR; 24mo shelf","medium")
add(m,t,i,"Henan Steeda Industrial","tgbotanicals.com","China","GBB-HCl bulk","Quote","Manufacturer","https://www.tgbotanicals.com/gamma-butyrobetaine-hydrochloride/","website","60-day refund guarantee","medium")
add(m,t,i,"Performance Essentials (GBBGO branded)","performance-essentials.com","USA","B2B branded GBB","Quote","Branded supplier","","sales","Branded raw material option","lead")

# 13. Huperzine A
m="Huperzine A"; t=""; i="Huperzia serrata extract 1% Huperzine A"
add(m,t,i,"Medikonda Nutrients","medikonda.com","USA / India origin","Bulk standardized","Quote","Manufacturer/Distributor","https://www.medikonda.com/products/huperzia-serrata-extract-powder-1-huperzine-a-suppliers-bulk-wholesale-distributor","website","COA, GMP/ISO/FDA","strong")
add(m,t,i,"REVEDA","reveda.com","USA / India origin","60-80 mesh, USDA","Quote","Manufacturer/Distributor","https://www.reveda.com/products/buy-wholesale-bulk-huperzia-serrata-extract-powder-1-huperzine-a-suppliers-online-in-usa","website","USDA/EU/Kosher organic","strong")
add(m,t,i,"Pincredit / PureHerbExtract","pureherbextract.com","China","1% MOQ 1kg","Quote","Manufacturer","https://www.pureherbextract.com/product/huperzine-a-powder","website","ISO22000/HACCP/FDA","strong")
add(m,t,i,"Jeeva Organic","jeevaorganic.com","USA/Global","1% HPLC","Quote","Distributor","https://jeevaorganic.com/products/bulk-huperzia-serrata-extract-powder-1-huperzine-a-hplc-supplier","website","100-200 mesh","strong")
add(m,t,i,"Vita Actives (HUPRZEN)","vitaactives.com","USA/Global","1% HPLC branded","Quote","Manufacturer/Distributor","https://vitaactives.com/huprzen-huperzia-serrata-herb-huperzine-a-1-hplc-powder-extract","website","Branded HUPRZEN","strong")
add(m,t,i,"Xi'an Bioway Organic","biowayorganicinc.com","China","1%–99%","Quote","Manufacturer","https://www.biowayorganicinc.com/organic-plant-extract/huperzia-serrata-extract.html","website","ISO22000/Halal/Non-GMO","strong")
add(m,t,i,"Nutri Avenue","nutriavenue.com","USA (5 warehouses)","Bulk","Quote","Distributor","https://www.nutriavenue.com/product/huperzia-serrata-extract/","website","FDA-registered","strong")
add(m,t,i,"Nutrivita Shop","nutrivitashop.com","USA","Wholesale 1%","Listed","Distributor","https://www.nutrivitashop.com/huperzine-a-extract-1-huperzia-serrata-extract-powder/","website","","medium")

# 14. HydroPrime
m="HydroPrime"; t="HydroPrime"; i="65% glycerol powder (NNB-developed)"
add(m,t,i,"NNB Nutrition (Mfr)","nnbnutrition.com","USA","B2B","Quote (direct)","Manufacturer (IP holder)","https://www.nnbnutrition.com/ingredients/hydro-prime/","NNBNutrition.com","65% glycerol; clump-resistant","strong")
add(m,t,i,"NXT Ingredients","nxtingredients.com","USA","B2B","Quote","Authorized specialty distributor","https://nxtingredients.com/specialty-ingredient/hydroprime-by-nnb-nutrition/","website","","strong")

# 15. L-Carnitine L-Tartrate
m="L-Carnitine L-Tartrate"; t=""; i="L-Carnitine L-Tartrate (CAS 36687-82-8)"
add(m,t,i,"Lonza (Carnipure tartrate)","lonza.com","Switzerland/Global","B2B drums","Quote","Manufacturer (gold standard)","https://www.lonza.com/capsules-health-ingredients/nutraceutical-solutions/ingredients/carnipure","sales","FSSC 22000; clinical dossier","strong")
add(m,t,i,"Medikonda Nutrients","medikonda.com","USA/India origin","Bulk","Quote","Distributor","https://www.medikonda.com/products/l-carnitine-l-tartrate-suppliers-bulk-wholesale-distributor","website","Bulk wholesale/export","strong")
add(m,t,i,"Nutri Avenue","nutriavenue.com","USA","Bulk","Quote","Distributor","https://www.nutriavenue.com/ingredients/l-carnitine-l-tartrate/","website","ISO, 3rd-party tested","strong")
add(m,t,i,"Vivion","vivion.com","USA","Bulk","Quote","Distributor","https://vivion.com/bulk-l-carnitine-supplier/","website","","strong")
add(m,t,i,"PureBulk","purebulk.com","USA","Bulk pack sizes","Listed online","Distributor","https://purebulk.com/products/l-carnitine-l-tartrate","website","Site lists pack-size pricing","strong")
add(m,t,i,"Zancheng Life Sciences","zanchenglife.com","China","Bulk","Quote","Manufacturer","https://www.zanchenglife.com/food-additives/l-carnitine-l-tartrate.html","website","Halal & Kosher","medium")
add(m,t,i,"BulkSupplements.com","bulksupplements.com","USA","Pack sizes online","Listed online","Distributor","https://www.bulksupplements.com/products/l-carnitine-l-tartrate-powder","website","cGMP, 3rd-party tested","strong")
add(m,t,i,"AgEx Pharma","agexpharma.com","India/USA","Bulk","Quote","Manufacturer","https://www.agexpharma.com/l-carnitine.html","website","cGMP; LCLT also offered","medium")

# 16. L-citrulline
m="L-citrulline"; t=""; i="L-Citrulline (fermented amino acid)"
add(m,t,i,"Kyowa Hakko USA","kyowa-usa.com","USA (US-made fermentation)","Fiber drums 50kg, COA","Quote","Manufacturer (premium fermented)","https://kyowa-usa.com/","sales","GRAS; preservative/allergen-free","strong")
add(m,t,i,"Stauber USA","stauberusa.com","USA","Wholesale bulk (Kyowa)","Quote","Authorized distributor (Kyowa)","https://www.stauberusa.com/l-citrulline/","website","Made in USA, GRAS","strong")
add(m,t,i,"Ingredients Online","ingredientsonline.com","USA marketplace","Bulk wholesale","Listed/Quote","Marketplace","https://www.ingredientsonline.com/bulk-wholesale/l-citrulline/","Ingredients Online","Multiple suppliers","strong")
add(m,t,i,"Nutri Avenue","nutriavenue.com","USA","Bulk","Quote","Distributor","https://www.nutriavenue.com/ingredients/l-citruline/","website","ISO, 3rd-party tested","strong")
add(m,t,i,"Maxmedchem","maxmedchem.com","China","25 kg bulk; pharma 98%","Quote","Manufacturer/exporter","https://www.maxmedchem.com/wholesale-l-citrulline-powder-25kg-bulk-amino-acid-supplier-for-supplement.html","website","Non-GMO fermentation; USP/EP/FCC","strong")
add(m,t,i,"Yuezhen Nutrition","yuezhen.com","Guangzhou, China","Bulk","Quote","Manufacturer","https://www.accio.com/supplier/wholesale-l-citrulline","sales","Shaanxi cluster","medium")
add(m,t,i,"Shaanxi Dennis Biotechnology","sx-dennis.com","Shaanxi, China","Bulk","Quote","Manufacturer","https://www.accio.com/supplier/wholesale-l-citrulline","sales","Major Chinese hub","medium")
add(m,t,i,"Xi'an Kangherb Bio-Tech","kangherb.com","Xi'an, China","Bulk","Quote","Manufacturer","https://www.accio.com/supplier/wholesale-l-citrulline","sales","","medium")
add(m,t,i,"Shaanxi Rainwood Biotech","sxrwbio.com","Shaanxi, China","Bulk","Quote","Manufacturer","https://www.accio.com/supplier/wholesale-l-citrulline","sales","","medium")
add(m,t,i,"Qingyang Interl-Healthcare Factory","qyihf.com","China","Bulk","Quote","Manufacturer","https://www.accio.com/supplier/wholesale-l-citrulline","sales","","medium")

# 17. L-Theanine
m="L-Theanine"; t=""; i="L-Theanine (Suntheanine branded or generic)"
add(m,t,i,"Taiyo Kagaku (Suntheanine Mfr)","taiyokagaku.com","Japan/Global","B2B branded","Quote (direct)","Manufacturer (patent holder)","https://www.taiyokagaku.com/en/products/material_19/","sales","Original Suntheanine, 98.9% L-isomer","strong")
add(m,t,i,"NutriScience Innovations","nutriscienceusa.com","Milford, CT, USA","B2B Suntheanine","Quote","Exclusive USA distributor (Suntheanine)","https://nutriscienceusa.com/product/suntheanine/","+1 203-372-8877","Suntheanine exclusive distributor","strong")
add(m,t,i,"TAIYO GmbH","taiyogmbh.com","EU (Germany)","B2B Suntheanine","Quote","Authorized distributor","https://taiyogmbh.com/en/start-en/brands/suntheanine-en/","sales","European Suntheanine partner","strong")
add(m,t,i,"Green Jeeva","greenjeeva.com","USA (China-sourced)","25kg MOQ","Quote","Distributor (generic)","https://www.greenjeeva.com/product/l-theanine","website","Lower-cost generic","medium")
add(m,t,i,"SFI Health","us.sfihealth.com","USA","B2B","Quote","Distributor","https://us.sfihealth.com/lth-ltheanine","website","","medium")
add(m,t,i,"Nutri Avenue","nutriavenue.com","USA","Bulk","Quote","Distributor","https://www.nutriavenue.com/ingredients/l-theanine/","website","ISO, 3rd-party tested","strong")
add(m,t,i,"BulkSupplements.com","bulksupplements.com","USA","Pack sizes online","Listed","Distributor","https://www.bulksupplements.com/products/l-theanine","website","cGMP","strong")
add(m,t,i,"PureBulk","purebulk.com","USA","Pack sizes online","Listed","Distributor","https://purebulk.com/products/l-theanine","website","","strong")

# 18. L-Tyrosine
m="L-Tyrosine"; t=""; i="L-Tyrosine"
add(m,t,i,"Ajinomoto Health & Nutrition","ajihealthandnutrition.com","Japan / N.A.","500-3500 kg blends","Quote","Manufacturer","https://www.ajihealthandnutrition.com/solutions/amino-acids/","website","cGMP, USP/EP/JP/DMF","strong")
add(m,t,i,"Nutri Avenue","nutriavenue.com","USA","25kg+ bulk","Quote","Distributor (OEM/ODM)","https://www.nutriavenue.com/ingredients/l-tyrosine/","website","GMP/ISO; OEM support","strong")
add(m,t,i,"Medikonda Nutrients","medikonda.com","USA","Bulk","Quote","Manufacturer/Distributor","https://www.medikonda.com/products/l-tyrosine-suppliers-bulk-wholesale-distributor","website","","strong")
add(m,t,i,"Vivion","vivion.com","USA","Bulk","Quote","Distributor","https://vivion.com/bulk-l-tyrosine-supplier/","website","","strong")
add(m,t,i,"Orbbo","orbbo.com","USA","Bulk organic","Quote","Manufacturer/Distributor","https://orbbo.com/l-tyrosine-b2b-bulk-wholesale-supplier/","website","","strong")
add(m,t,i,"PureBulk","purebulk.com","USA","Pack sizes online","Listed online","Distributor","https://purebulk.com/products/l-tyrosine-bulk","website","Pack-size pricing","strong")
add(m,t,i,"Sinoway Industrial","sinoway.com","China","Bulk API","Quote","Manufacturer","https://pharmaoffer.com/api-excipient-supplier/amino-acids/l-tyrosine","website","API-grade","medium")
add(m,t,i,"Wuxi Jinghai Amino Acid","jinghaiaa.com","China","Bulk API","Quote","Manufacturer","https://pharmaoffer.com/api-excipient-supplier/amino-acids/l-tyrosine","website","","medium")
add(m,t,i,"Amino GmbH","amino-gmbh.com","Germany","Bulk API","Quote","Manufacturer","https://pharmaoffer.com/api-excipient-supplier/amino-acids/l-tyrosine","website","EU producer","medium")
add(m,t,i,"Sekisui Medical","sekisui-medical.jp","Japan","Bulk API","Quote","Manufacturer","https://pharmaoffer.com/api-excipient-supplier/amino-acids/l-tyrosine","website","","medium")

# 19. Magnesium Glycinate
m="Magnesium Glycinate"; t=""; i="Magnesium bisglycinate / TRAACS"
add(m,t,i,"Balchem / Albion Minerals (TRAACS)","balchem.com","USA","B2B branded","Quote","Manufacturer (patent holder)","https://www.balchem.com/minerals-nutrients/","sales","150+ patents; TRAACS","strong")
add(m,t,i,"Stauber USA (Albion partner)","stauberusa.com","USA","B2B","Quote","Authorized distributor (Albion)","https://www.stauberusa.com/our-partners/albion-chelated-minerals/","website","Official Albion partner","strong")
add(m,t,i,"Green Jeeva","greenjeeva.com","USA (China-sourced)","25kg MOQ","Quote","Distributor (generic)","https://www.greenjeeva.com/product/magnesium-glycinate-powder","website","Industrial grade","strong")
add(m,t,i,"Nutri Avenue","nutriavenue.com","USA","Bulk","Quote","Distributor","https://www.nutriavenue.com/ingredients/magnesium-glycinate/","website","ISO, 3rd-party tested","strong")
add(m,t,i,"PureBulk","purebulk.com","USA","Pack sizes online","Listed online","Distributor","https://purebulk.com/products/magnesium-glycinate-chelated-buffered","website","Pack-size pricing","strong")
add(m,t,i,"BulkSupplements.com","bulksupplements.com","USA","Pack sizes online","Listed online","Distributor","https://www.bulksupplements.com/products/magnesium-bisglycinate-chelate-pure-powder","website","cGMP","strong")
add(m,t,i,"Pincredit","pureherbextract.com","China","Bulk","Quote","Manufacturer","https://www.pureherbextract.com/","website","","medium")

# 20. Nitrosigine
m="Nitrosigine"; t="Nitrosigine"; i="Inositol-Stabilized Arginine Silicate"
add(m,t,i,"Everwell Health (legacy Nutrition 21)","everwellhealth.com","Purchase, NY USA","B2B","Quote","Manufacturer (brand owner)","https://everwellhealth.com/nitrosigine/?legacy=n21","website","FDA NDI; GRAS","strong")
add(m,t,i,"Nutrition 21 LLC (legacy)","nutrition21.com","USA","B2B (legacy site)","Quote","Manufacturer (original developer)","https://nutrition21.com/","sales","Original developer of Nitrosigine","strong")
add(m,t,i,"Knowde (Everwell/Nutrition21 storefront)","knowde.com","Global B2B","B2B","Quote","Authorized marketplace","https://www.knowde.com/stores/everwell-health/products/nitrosigine","Knowde","Sample/RFQ","strong")

# 21. Potassium Citrate
m="Potassium Citrate"; t=""; i="Tripotassium citrate monohydrate (CAS 6100-05-6)"
add(m,t,i,"Cargill","cargill.com","USA/Global","Bulk citrates","Quote","Manufacturer","https://www.cargill.com/food-bev/na/citrates","sales","Food/beverage/dairy/nutrition","strong")
add(m,t,i,"ADM (via Ingredi)","ingredi.com","USA","50 lb bags USP/FCC","Listed online","Manufacturer/Distributor","https://ingredi.com/potassium-citrate-usp-fcc-50-lb-bag/","website","Kosher & Halal certified","strong")
add(m,t,i,"Vivion","vivion.com","USA","250 kg+ bulk","Quote","Distributor","https://vivion.com/bulk-potassium-citrate-supplier/","website","USP/FCC/EP","strong")
add(m,t,i,"Univar Solutions","univarsolutions.com","N.A.","Bulk","Quote","Distributor","https://www.univarsolutions.com/pot-citrate-mono-sucrl-sa-uspfccko-811129","website","USP/FCC/Kosher","strong")
add(m,t,i,"Lab Alley","laballey.com","USA","USP/FCC online","Listed online","Distributor","https://www.laballey.com/products/potassium-citrate-usp-fcc","website","US-stocked, custom quotes","strong")
add(m,t,i,"ChemCentral","chemcentral.com","USA","50 lb FCC/Food/USP","Listed online","Marketplace","https://www.chemcentral.com/potassium-citrate-monohydrate-fccfoodusp-grade-kosher-50-lb-bag-16141427.html","website","Kosher","strong")
add(m,t,i,"American Molecules","ammol.org","Texas, USA","Bulk USP NF BP","Quote","Manufacturer's rep","https://ammol.org/potassiumcitratesuppliers.html","website","FDA/cGMP/ISO/Kosher/Halal/WHO-GMP","strong")
add(m,t,i,"Anmol Chemicals","anmol.org","India / NY/TX/IL/LA reps","Bulk USP/FCC","Quote","Manufacturer","https://anmol.org/potassiumcitrateBP-IP-USP-FCC-Food.html","website","Reps in NY, Houston, Chicago, LA","strong")
add(m,t,i,"Muby Chemicals","mubychem.com","India / N.A. service","Bulk + microencapsulated","Quote","Manufacturer","https://mubychem.com/Potassium-Citrate-USP-BP-IP-FCC.htm","toll-free","Microencapsulated option","medium")
add(m,t,i,"Prescribed For Life","prescribedforlife.com","Dripping Springs TX","340g–25kg","Listed","Distributor","https://www.amazon.com/Potassium-Citrate-TriPotassium-Monohydrate-Granular/dp/B01JQC42XS","website","GMP","strong")

# 22. Salt (Sodium Chloride)
m="Salt"; t=""; i="Sodium Chloride food grade"
add(m,t,i,"Cargill","cargill.com","USA/Global","Bulk granulated/specialty","Quote","Manufacturer","https://www.cargill.com/food-beverage/na/food-salt","sales","Diamond Crystal, Brinemaker's Select","strong")
add(m,t,i,"Morton Salt","mortonsalt.com","USA","50+ grades","Quote","Manufacturer","https://www.mortonsalt.com/business-category/food-manufacturing/","sales","Industry standard","strong")
add(m,t,i,"Cope Company Salt","copecompany.com","USA","Morton/Cargill resale + own brand","Quote","Distributor","https://www.copecompany.com/food-salt-products/","website","LTL friendly","strong")
add(m,t,i,"Indiana Sugars","sugars.com","USA","25 lb – 50,000 lb (MOQ 2,450 lb)","Quote","Distributor","https://www.sugars.com/product-catalog/all-products/food-grade-salt","website","Superior General Purpose & TX-10","strong")
add(m,t,i,"TEKPAK Inc.","tekpakinc.com","USA","Bulk + Dead Sea","Quote","Distributor","https://tekpakinc.com/services/ingredients","website","Reduced-sodium blends","strong")
add(m,t,i,"BVV (Morton USP)","shopbvv.com","USA","USP fine grain","Listed online","Distributor","https://shopbvv.com/products/sodium-chloride-usp","phone disc.","Pharma-grade USP","strong")
add(m,t,i,"Univar Solutions","univarsolutions.com","N.A.","Bulk USP/FCC","Quote","Distributor","https://www.univarsolutions.com/sod-citrate-dihy-sucroal-sa-fngr-uspfcck-809152","website","Sustainable product designation","strong")
add(m,t,i,"Compass Minerals","compassminerals.com","USA","Bulk food salt","Quote","Manufacturer","https://www.compassminerals.com/products/salt/","sales","Major USA salt producer","strong")
add(m,t,i,"US Salt","ussalt.com","USA","Bulk","Quote","Manufacturer","https://www.ussalt.com/","sales","Mentioned by Cope","medium")
add(m,t,i,"Detroit Salt Co.","detroitsalt.com","USA","Bulk","Quote","Manufacturer","https://www.detroitsalt.com/","sales","","medium")

# 23. Senactiv
m="Senactiv"; t="Senactiv"; i="Panax notoginseng + Rosa roxburghii (≥30% saponins)"
add(m,t,i,"NuLiv Science USA (Mfr)","nulivscience.com","USA / Brea CA","B2B","Quote (direct)","Manufacturer (patent holder)","https://nulivscience.com/ingredients/senactiv/","website","Patent holder; Informed Sport","strong")
add(m,t,i,"Ingredients Online","ingredientsonline.com","USA marketplace","Bulk","Quote","Authorized marketplace","https://www.ingredientsonline.com/botanicals/senactivr-proprietary-blend/","Ingredients Online","Vetted partner","strong")
add(m,t,i,"Ingredients Network","ingredientsnetwork.com","Global B2B","B2B","Quote","Listing","https://www.ingredientsnetwork.com/senactiv-prod1271902.html","website","","medium")
add(m,t,i,"NXT Ingredients","nxtingredients.com","USA","B2B","Quote","Specialty distributor","https://nxtingredients.com/specialty-ingredient/senactiv-by-nuliv-science/","website","","strong")
add(m,t,i,"Knowde (NuLiv storefront)","knowde.com","Global B2B","B2B","Quote","Authorized marketplace","https://www.knowde.com/stores/nuliv-science-usa","Knowde","Sample/RFQ","strong")

# 24. Sodium Citrate
m="Sodium Citrate"; t=""; i="Trisodium Citrate (CAS 68-04-2 / 6132-04-3)"
add(m,t,i,"Hawkins, Inc.","hawkinsinc.com","USA","Bulk + custom blending","Quote","Manufacturer/Distributor","https://www.hawkinsinc.com/groups/food-ingredients/sodium-citrate/","sales","GRAS, 85+ yr USA mfr","strong")
add(m,t,i,"Brenntag","brenntag.com","USA/Global","Bulk","Quote","Distributor","https://www.brenntag.com/en-us/products/sodium-citrate.html","website","Major B2B distributor","strong")
add(m,t,i,"Connection Chemical LP","connectionchemical.com","USA","Nationwide stocking","Quote","Distributor","https://www.connectionchemical.com/trisodium-citrate/","website","Multi-industry","strong")
add(m,t,i,"CORECHEM Inc.","corecheminc.com","Eastern USA","55 lb (25 kg) bags / 50 lb","Quote","Distributor","https://corecheminc.com/product/sodium-citrate-copy/","website","Eastern US primary","strong")
add(m,t,i,"Univar Solutions","univarsolutions.com","N.A.","Bulk USP/FCC Kosher","Quote","Distributor","https://www.univarsolutions.com/sod-citrate-dihy-sucroal-sa-fngr-uspfcck-809152","website","Sustainable product","strong")
add(m,t,i,"ChemCentral","chemcentral.com","USA","50 lb FCC/Food/USP","Listed online","Marketplace","https://www.chemcentral.com/sodium-citrate-dihydrate-fccfoodusp-grade-kosher-50-lb-bag-16142458.html","website","Kosher","strong")
add(m,t,i,"Anmol Chemicals","anmol.org","India / NY/TX/IL reps","Bulk USP/FCC","Quote","Manufacturer","https://www.anmol.org/sodiumcitrateBP-IP-USP-FCC-Food.html","website","Anhydrous + dihydrate","strong")
add(m,t,i,"Cargill","cargill.com","USA/Global","Bulk citrates","Quote","Manufacturer","https://www.cargill.com/food-bev/na/citrates","sales","Sodium & potassium citrate","strong")
add(m,t,i,"Thomasnet (multi-supplier directory)","thomasnet.com","USA","Variable 1–55 lb","Quote","Directory","https://www.thomasnet.com/suppliers/usa/sodium-citrate-76121805","via directory","Discover more US suppliers","medium")
add(m,t,i,"American Chemical Suppliers Directory","americanchemicalsuppliers.com","USA","Variable","Quote","Directory","https://www.americanchemicalsuppliers.com/list/search?search=sodium+citrate","directory","Discover more US suppliers","medium")

# 25. Taurine
m="Taurine"; t=""; i="Taurine USP (CAS 107-35-7)"
add(m,t,i,"Green Jeeva","greenjeeva.com","USA (China-sourced)","25 kg MOQ","Quote","Distributor","https://www.greenjeeva.com/product/taurine-powder","website","COA, MSDS, TDS","strong")
add(m,t,i,"Wego Chemical Group","wegochem.com","Global","JP15 / USP","Quote","Distributor","https://www.wegochem.com/supplier-distributor/taurine/2760/107-35-7","website","Pharma + food + animal","strong")
add(m,t,i,"Anmol Chemicals","anmol.org","India / NY/TX/IL/LA reps","USP/JP/BP/EP/FCC","Quote","Manufacturer","https://anmol.org/taurineUSP.html","website","FDA-approved facility; WC available","strong")
add(m,t,i,"Muby Chemicals","mubychem.com","India / N.A.","USP/Food + pet-grade granular","Quote","Manufacturer","https://mubychem.com/taurine.html","toll-free","Anti-caking option for pet food","strong")
add(m,t,i,"American Molecules (ammol.org)","ammol.org","Texas, USA","Bulk USP NF","Quote","Manufacturer's rep","https://ammol.org/taurinesuppliers.html","website","FDA/cGMP/ISO certs","strong")
add(m,t,i,"NutriVita Shop","nutrivitashop.com","USA","USP grade pack sizes","Listed online","Distributor","https://www.nutrivitashop.com/l-taurine-amino-acid-100-pure-powder-usp-grade-muscle-energy/","website","Pack-size pricing","strong")
add(m,t,i,"Nutri Avenue","nutriavenue.com","USA","Bulk","Quote","Distributor","https://www.nutriavenue.com/ingredients/taurine/","website","ISO, 3rd-party tested","strong")
add(m,t,i,"BulkSupplements.com","bulksupplements.com","USA","Pack sizes online","Listed online","Distributor","https://www.bulksupplements.com/products/taurine-powder","website","cGMP","strong")
add(m,t,i,"PureBulk","purebulk.com","USA","Pack sizes online","Listed online","Distributor","https://purebulk.com/products/taurine","website","","strong")
add(m,t,i,"Qianjiang Yongan Pharmaceutical","qjyongan.com","China","Bulk","Quote","Manufacturer","https://www.thomasnet.com/suppliers/usa/taurine-97008669","sales","Major world taurine producer","medium")

# 26. Zembrin
m="Zembrin"; t="Zembrin"; i="Sceletium tortuosum extract (multi-patented)"
add(m,t,i,"HG&H Pharmaceuticals (Mfr, S. Africa)","hghpharma.com","Bryanston, South Africa","B2B","Quote (direct)","Manufacturer (patent holder)","https://www.hghpharma.com/","sales","Original developer; San-Council endorsed","strong")
add(m,t,i,"PLT Health Solutions","plthealth.com","Morristown NJ, USA","B2B","Quote","Exclusive USA distributor","https://www.plthealth.com/product-catalog/zembrin","sales","Exclusive USA distributor","strong")
add(m,t,i,"Knowde (PLT Health storefront)","knowde.com","Global B2B","B2B","Quote","Authorized marketplace","https://www.knowde.com/stores/plt-health-solutions/products/zembrin","Knowde","Sample/RFQ","strong")
add(m,t,i,"Nektium Pharma (EU GMP contract mfr)","nektium.com","Spain (EU)","B2B GMP","Quote","Contract manufacturer for HG&H","https://nektium.com/","sales","Produces Zembrin to EU GMP","medium")

# --- write rows ---
def put(rng, values):
    u = f"{PROXY}/{AID}/sheets.googleapis.com/v4/spreadsheets/{SSID}/values/{rng}?valueInputOption=RAW"
    rr = requests.put(u, headers=HEADERS, json={"values": values}, timeout=60)
    rr.raise_for_status()
    return rr.json()

# Clear and write Suppliers tab (rows after header)
clear_url = f"{PROXY}/{AID}/sheets.googleapis.com/v4/spreadsheets/{SSID}/values/Suppliers!A2:M10000:clear"
requests.post(clear_url, headers=HEADERS, json={}, timeout=30)

print(f"Writing {len(SUPP)} supplier rows...")
res = put("Suppliers!A2", SUPP)
print("SUPPLIERS_WRITTEN:", res.get("updatedRange"))

# Update Materials tab counts
mats = json.load(open("/workspace/sourcing/materials.json"))
counts = {}
for row in SUPP:
    counts[row[0]] = counts.get(row[0], 0) + 1
mat_rows = []
for m in mats:
    n = counts.get(m["name"], 0)
    status = "done" if n >= 10 else ("partial-strong" if n >= 5 else "partial")
    mat_rows.append([m["name"], m.get("trade_name") or "", m.get("inci") or "", ",".join(m["search_by"]) if m["search_by"] else "", m["vol_lb"], n, status])
put("Materials!A2", mat_rows)
print("MATERIALS_UPDATED")

with open("/workspace/sourcing/suppliers_final.json", "w") as f:
    json.dump([{"row": r} for r in SUPP], f, indent=2)
print("DONE; total rows:", len(SUPP))
