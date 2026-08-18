import { extractQuotesFromReplyText } from "./src/lib/reply-quote-extract.ts";

const body = `Dear Sir, Thank you for your reply. The price quoted is FOB Nhavasheva, there is no change in Ex work price as our facility is near by port. I will give you the material to your shipping line over here at Nhavasheva port. Minimum Order quantity is Half or Full container. Let me know in case if you have any query. Regards Rahul Mani On Fri, 31 Jul, 2026, 20:36 CC Procurement, < ccprocurement@californiachemical.com > wrote: Hi Rahul, Thank you for the quote and technical documents — we've received the TDS and COA and are reviewing them now. Could you confirm the MOQ for the MEA 99% at $1.83/kg FOB Nhava Sheva. Also, could you provide pricing on an EXW basis, as we'd like to arrange shipping ourselves? In addition, do you have a product catalog or line card showing your other chemical offerings? We source across multiple materials and it would help us evaluate additional opportunities with your team. Looking forward to your response. California Chemicals Purchasing Team`;

const result = await extractQuotesFromReplyText(body);
console.log(JSON.stringify(result, null, 2));
