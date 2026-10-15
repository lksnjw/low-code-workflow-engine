import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { renderBrandedEmail } from "../src/delivery/branded-email.ts";

// Synthetic display fixture only: no provider, ERP, database or send client.
const body = `Please find the sales and purchase order details below.

## Sales orders
| Order | Customer | Date | Status | Total (LKR) |
| --- | --- | --- | --- | ---: |
| SO-101 | Lakeview Office Supplies | 2026-10-18 | Completed | 20,000 |
| SO-102 | Greenfield Stationery | 2026-10-19 | To Deliver | 32,000 |

## Purchase orders
| Order | Supplier | Date | Status | Total (LKR) |
| --- | --- | --- | --- | ---: |
| PO-201 | Central Paper Supplies | 2026-10-18 | Completed | 40,000 |
| PO-202 | Summit Packaging | 2026-10-19 | To Receive and Bill | 15,000 |

Coverage: two sales orders and two purchase orders are included. These are bounded results, not a full-system count.

Please review the records before taking further action.`;
const email = renderBrandedEmail("Sales and Purchase Orders — System Report", body)
  .replace("https://workflow-automation-44201.web.app/brand/agentic-email-mark.png", "/brand/agentic-email-mark.png");
const logo = await readFile(new URL("../../frontend/public/brand/agentic-email-mark.png", import.meta.url));
const server = createServer((request, response) => {
  response.setHeader("Cache-Control", "no-store");
  if (request.url === "/brand/agentic-email-mark.png") { response.writeHead(200, { "Content-Type": "image/png" }); response.end(logo); return; }
  if (request.url === "/" || request.url === "/email") { response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); response.end(email); return; }
  response.writeHead(404); response.end("Not found");
});
server.listen(5199, "127.0.0.1", () => console.log("Synthetic email preview: http://127.0.0.1:5199/email (no email is sent)"));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close());
