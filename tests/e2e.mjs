// End-to-end test of the whole ERP against the Firebase emulators.
// Run with:  npm test      (starts the emulators, runs this file, stops them)
//
// Scenario = the real business flow:
//   PO for 10 apples → invoice 5 (kanta 5) → invoice 5 (kanta 4, shortage 1) → PO shows 9/10 → short close
//   PO for drums fully received in 2 invoices → auto COMPLETED
//   Tanker of acid → GRN → transfer PG-106 → Taloja with transit loss → write-off at Taloja
//   Quotation → accepted → Sales Order → dispatch from Taloja in drums (packaging stock deducted)
//   Security: outsider / inactive / operator restrictions enforced by the rules
import http from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
import { initializeApp as adminApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "output");
const NM = process.env.NODE_MODULES_DIR || path.join(ROOT, "node_modules");
const PORT = 5500;
const BASE = `http://localhost:${PORT}`;
process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= "127.0.0.1:9099";

const USERS = [
  { name: "Test Admin", email: "admin@test.ccpl", role: "admin", password: "Admin#12345" },
  { name: "Test Manager", email: "manager@test.ccpl", role: "manager", password: "Manager#12345" },
  { name: "Test Operator", email: "operator@test.ccpl", role: "operator", password: "Operator#12345" },
  { name: "Inactive Person", email: "inactive@test.ccpl", role: "operator", password: "Inactive#12345", active: false },
  { name: "Rupesh Mudliar", email: "rupesh.mudliar@cognizantchemical.com", role: "admin", password: "Rupesh#12345" }
];

let passed = 0;
const failures = [];
function check(condition, message) {
  if (condition) { passed += 1; console.log(`  ✔ ${message}`); } else { failures.push(message); console.log(`  ✘ ${message}`); }
}
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-6;

/* ---------- seed ---------- */
await mkdir(OUT, { recursive: true });
const usersFile = path.join(OUT, "users.test.json");
await writeFile(usersFile, JSON.stringify(USERS));
execFileSync("node", [path.join(ROOT, "admin", "setup.mjs"), "--emulator", "--users", usersFile], { stdio: "inherit", env: { ...process.env, NODE_PATH: NM } });
adminApp({ projectId: "demo-ccpl" });
const adb = getFirestore();
// An "outsider" who managed to create a Firebase login but was never added to the ERP.
await getAuth().createUser({ email: "outsider@evil.test", password: "Outsider#12345" });

/* ---------- static server ---------- */
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json" };
const server = http.createServer(async (req, res) => {
  const file = path.join(ROOT, decodeURIComponent(new URL(req.url, BASE).pathname));
  if (!file.startsWith(ROOT) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
  res.end(await readFile(file));
}).listen(PORT);

/* ---------- browser (CDN libraries served from node_modules, same versions) ---------- */
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 900 } });
await context.route(/^https:\/\/www\.gstatic\.com\/firebasejs\/10\.12\.2\/(.+)$/, (route) => route.fulfill({ path: path.join(NM, "firebase", route.request().url().split("/").pop()), contentType: "text/javascript" }));
await context.route(/pdfmake\/0\.2\.10\/(pdfmake\.min\.js|vfs_fonts\.js)$/, (route) => route.fulfill({ path: path.join(NM, "pdfmake", "build", route.request().url().split("/").pop()), contentType: "text/javascript" }));
await context.route(/xlsx\/0\.18\.5\/xlsx\.full\.min\.js$/, (route) => route.fulfill({ path: path.join(NM, "xlsx", "dist", "xlsx.full.min.js"), contentType: "text/javascript" }));
await context.route(/fonts\.googleapis\.com|fonts\.gstatic\.com|font-awesome/, (route) => route.fulfill({ body: "", contentType: "text/css" }));

const page = await context.newPage();
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(e.message));

/* ---------- helpers ---------- */
const modal = () => page.locator(".modal-backdrop").last();
async function goto(file) { await page.goto(`${BASE}/${file}`); await page.waitForSelector('body[data-loaded="1"]', { timeout: 20000 }); }
async function login(email, password) {
  await page.goto(`${BASE}/index.html?emulator=1`);
  await page.fill("input[name=email]", email);
  await page.fill("input[name=password]", password);
  await page.click("#loginBtn");
}
async function logout() { await page.click("#logoutBtn"); await page.waitForURL(/index\.html/); }
async function selectContaining(locator, text) {
  const value = await locator.evaluate((sel, t) => [...sel.options].find((o) => o.textContent.includes(t))?.value, text);
  if (value === undefined) throw new Error(`Option containing "${text}" not found`);
  await locator.selectOption(value);
}
async function expectToast(kind = "ok") {
  const t = page.locator(".toast").last();
  await t.waitFor({ timeout: 20000 });
  const text = await t.textContent();
  const actual = (await t.getAttribute("class")).includes("error") ? "error" : "ok";
  await page.evaluate(() => document.querySelectorAll(".toast").forEach((x) => x.remove()));
  if (actual !== kind) throw new Error(`Expected ${kind} toast but got ${actual}: ${text}`);
  return text;
}
async function closeAllModals() { while (await page.locator(".modal-backdrop").count()) { await page.keyboard.press("Escape"); await page.waitForTimeout(50); } }
async function addMaster(file, values, selects = {}) {
  await goto(file);
  await page.click("#addBtn");
  for (const [k, v] of Object.entries(values)) await modal().locator(`[name=${k}]`).fill(String(v));
  for (const [k, v] of Object.entries(selects)) await modal().locator(`[name=${k}]`).selectOption(v);
  await modal().locator("#saveMaster").click();
  await expectToast();
}
const one = async (col, field, value) => { const s = await adb.collection(col).where(field, "==", value).get(); return s.docs[0] ? { id: s.docs[0].id, ...s.docs[0].data() } : null; };
const stockOf = async (wh, itemName) => { const s = await adb.collection("inventory").where("warehouse", "==", wh).where("itemName", "==", itemName).get(); return s.empty ? 0 : s.docs[0].data().qty; };

async function createPo(vendor, warehouse, lines) {
  await goto("purchase-orders.html");
  await page.click("#newPo");
  const m = modal();
  await selectContaining(m.locator("select[name=vendorId]"), vendor);
  await m.locator("select[name=warehouse]").selectOption(warehouse);
  for (let i = 0; i < lines.length; i += 1) {
    if (i > 0) await m.locator("[data-add]").click();
    const row = m.locator(".line-table tbody tr").nth(i);
    await selectContaining(row.locator("select[data-f=itemId]"), lines[i].item);
    await row.locator("input[data-f=qty]").fill(String(lines[i].qty));
    await row.locator("input[data-f=rate]").fill(String(lines[i].rate));
  }
  await m.locator("#savePo").click();
  const text = await expectToast();
  await page.locator("#pdfDownload:not([disabled])").waitFor({ timeout: 30000 });
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#pdfDownload")]);
  const file = path.join(OUT, download.suggestedFilename());
  await download.saveAs(file);
  await closeAllModals();
  return { poNo: text.replace(" saved.", ""), pdf: file };
}

// Invoice / receipt against a PO: qtys = { "Item name": qty }
async function receiptEntry({ poNo, invoiceNo, qtys, warehouse }) {
  await goto("inward.html");
  await page.click("#newEntry");
  const m = modal();
  await selectContaining(m.locator("select[name=poId]"), poNo);
  if (warehouse) await m.locator("select[name=warehouse]").selectOption(warehouse);
  await m.locator("input[name=invoiceNo]").fill(invoiceNo);
  for (const [name, q] of Object.entries(qtys)) await m.locator("#itemArea tr", { hasText: name }).locator("input[data-line]").fill(String(q));
  await m.locator("input[name=vehicleNo]").fill("MH46AB1234");
  await m.locator("#saveGe").click();
  await expectToast();
  return one("receipts", "invoiceNo", invoiceNo);
}
// GRN: qtys = { "Item name": grnQty } (defaults to invoice qty)
async function grnStep(receipt, qtys = {}) {
  await goto("inward.html");
  await page.click('[data-tab="GRN PENDING"]');
  await page.locator(`[data-grn="${receipt.id}"]`).click();
  const m = modal();
  for (const [name, q] of Object.entries(qtys)) await m.locator("tr", { hasText: name }).locator("input").fill(String(q));
  await m.locator("#saveG").click();
  await expectToast();
}
// Kanta: qtys = { "Item name": kantaQty } (defaults to GRN qty)
async function kantaStep(receipt, qtys = {}) {
  await goto("inward.html#kanta");
  await page.click('[data-tab="KANTA PENDING"]');
  await page.locator(`[data-kanta="${receipt.id}"]`).click();
  const m = modal();
  for (const [name, q] of Object.entries(qtys)) await m.locator("tr", { hasText: name }).locator("input").fill(String(q));
  await m.locator("#saveK").click();
  await expectToast();
}
async function receiveFully(poNo, invoices) {
  for (const [invoiceNo, qtys, kantaQtys] of invoices) {
    const r = await receiptEntry({ poNo, invoiceNo, qtys });
    await grnStep(r);
    await kantaStep(r, kantaQtys || {});
  }
}
const lineOf = (po, name) => po.lines.find((l) => l.name.startsWith(name));
const round = (v, dp = 3) => Math.round(v * 10 ** dp) / 10 ** dp;

try {
  /* ================= 1. Security / login ================= */
  console.log("\n1. Login & security");
  await login("admin@test.ccpl", "wrong-password-1");
  await page.locator("#loginMessage.notice.error").waitFor();
  check((await page.textContent("#loginMessage")).includes("Incorrect"), "wrong password is rejected");
  await login("outsider@evil.test", "Outsider#12345");
  await page.waitForTimeout(1500);
  check(page.url().includes("index.html") && (await page.textContent("#loginMessage")).includes("not authorised"), "outsider with a Firebase login but no ERP profile is refused");
  await login("inactive@test.ccpl", "Inactive#12345");
  await page.waitForTimeout(1500);
  check(page.url().includes("index.html"), "deactivated user cannot sign in");
  await page.goto(`${BASE}/purchase-orders.html`);
  await page.waitForURL(/index\.html/, { timeout: 15000 });
  check(true, "protected page redirects to login when signed out");

  await login("admin@test.ccpl", "Admin#12345");
  await page.waitForURL(/dashboard\.html/, { timeout: 20000 });
  await page.waitForSelector(".kpi");
  check(true, "admin signs in and reaches the dashboard");
  await page.screenshot({ path: path.join(OUT, "01-dashboard-empty.png") });

  /* ================= 2. Masters ================= */
  console.log("\n2. Masters (vendors & customers in one list, items)");
  await addMaster("parties.html", { name: "Pyramid Technoplast Limited", gstin: "27AACCP5074E3ZF", address1: "GAT NO. 420/1, 420/2, 420/3, KHANIVALI", address2: "Khanivali", city: "Palghar", pincode: "401204", paymentTermsDays: 30 });
  const vendor = await one("parties", "name", "Pyramid Technoplast Limited");
  check(vendor?.stateCode === "27" && vendor?.pan === "AACCP5074E" && vendor?.state === "Maharashtra", "vendor GSTIN auto-fills state code, state and PAN");
  await addMaster("parties.html", { name: "Gujarat Acids Pvt Ltd", gstin: "24AABCG1234H1Z5", city: "Vapi", paymentTermsDays: 45 });
  await addMaster("parties.html", { name: "Deepak Fertilisers Ltd", gstin: "27AAACD1234E1ZX", city: "Taloja" });
  await addMaster("items.html", { name: "Apple", hsn: "08081000", gstRate: 18 }, { category: "Raw Material", unit: "KG" });
  await addMaster("items.html", { name: "Methanol", hsn: "29051100", gstRate: 18 }, { category: "Raw Material", unit: "KG" });
  await addMaster("items.html", { name: "IPA", hsn: "29051220", gstRate: 18 }, { category: "Raw Material", unit: "KG" });
  await addMaster("items.html", { name: "Hydrochloric Acid 33%", hsn: "28061000", gstRate: 18 }, { category: "Finished Goods", unit: "KG" });
  // Duplicate protection
  await goto("parties.html"); await page.click("#addBtn");
  await modal().locator("[name=name]").fill("Another name"); await modal().locator("[name=gstin]").fill("27AACCP5074E3ZF");
  await modal().locator("#saveMaster").click();
  check((await expectToast("error")).includes("already exists"), "duplicate vendor GSTIN is blocked");
  await closeAllModals();
  // Excel template + import
  await goto("parties.html");
  const [tpl] = await Promise.all([page.waitForEvent("download"), page.click("#templateBtn")]);
  await tpl.saveAs(path.join(OUT, tpl.suggestedFilename()));
  const XLSX = (await import(path.join(NM, "xlsx", "xlsx.mjs"))).default ?? await import(path.join(NM, "xlsx", "xlsx.mjs"));
  XLSX.set_fs?.(await import("node:fs"));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ["Name *", "GSTIN", "City", "Payment Terms (days)"],
    ["Bulk Vendor One", "27AAACB1111A1Z1", "Pune", 30],
    ["Bulk Vendor Two", "", "Mumbai", 15],
    ["Broken Vendor", "NOT-A-GSTIN", "X", 10]
  ]), "Vendors");
  const importFile = path.join(OUT, "vendor-import.xlsx");
  XLSX.writeFile(wb, importFile);
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click("#importBtn")]);
  await chooser.setFiles(importFile);
  await modal().locator("#confirmImport").waitFor();
  check((await modal().textContent()).includes("2 of 3 rows are valid"), "Excel import preview flags the invalid GSTIN row");
  await modal().locator("#confirmImport").click();
  await expectToast();
  check(Boolean(await one("parties", "name", "Bulk Vendor Two")) && !(await one("parties", "name", "Broken Vendor")), "valid Excel rows imported, invalid row skipped");
  // Zoho Books export (same headers as the real Vendors export): duplicates by GSTIN merge, Inactive carried over
  const zoho = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(zoho, XLSX.utils.json_to_sheet([
    { "Contact ID": "Z1", "Display Name": "SAMPLE  CHEM PVT LTD", "Company Name": "SAMPLE CHEM PVT LTD", "EmailID": "", "MobilePhone": "", "Status": "Active", "Payment Terms": "60", "GST Identification Number (GSTIN)": "27AACCS1234C1ZV", "Billing Address": "GALA NO 9, UNIQUE INDL ESTATE", "Billing Street2": "OPP. TALKIES\r\nMULUND WEST", "Billing City": "MUMBAI", "Billing State": "Maharashtra", "Billing Code": "400080" },
    { "Contact ID": "Z2", "Display Name": "Sample Chem-Pvt.Ltd.", "EmailID": "accounts@sample.test", "MobilePhone": "9800011111", "Status": "Active", "Payment Terms": "", "GST Identification Number (GSTIN)": "27AACCS1234C1ZV" },
    { "Contact ID": "Z3", "Display Name": "Old Supplier", "Status": "Inactive", "Payment Terms": "30", "GST Identification Number (GSTIN)": "" },
    { "Contact ID": "Z4", "Display Name": "Typo Traders", "Status": "Active", "GST Identification Number (GSTIN)": "27ALPPJ2647C222" }
  ]), "Vendors");
  const zohoFile = path.join(OUT, "zoho-vendors.xlsx");
  XLSX.writeFile(zoho, zohoFile);
  const [chooser2] = await Promise.all([page.waitForEvent("filechooser"), page.click("#importBtn")]);
  await chooser2.setFiles(zohoFile);
  await modal().locator("#confirmImport").waitFor();
  const zPreview = await modal().textContent();
  check(zPreview.includes("Zoho Books export detected") && zPreview.includes("2 of 3 rows are valid") && zPreview.includes("1 duplicate row was merged"), "Zoho export recognised: duplicate GSTIN merged, bad GSTIN flagged");
  await modal().locator("#confirmImport").click();
  await expectToast();
  const sample = await one("parties", "gstin", "27AACCS1234C1ZV");
  check(sample?.name === "SAMPLE CHEM PVT LTD" && sample.email === "accounts@sample.test" && sample.phone === "9800011111" && sample.paymentTermsDays === 60 && sample.address2 === "OPP. TALKIES, MULUND WEST", "merged party keeps the most complete details from both rows");
  check((await one("parties", "name", "Old Supplier"))?.active === false, "Inactive status from Zoho carried over");

  /* ================= 3. Numbering ================= */
  console.log("\n3. Number format CCPL/PO/26-27/001");
  const setNumbering = async (type, format, next, digits = 3) => {
    await goto("settings.html");
    const row = page.locator(`#numRows tr[data-k="${type}"]`);
    await row.locator("[data-fmt]").fill(format);
    await row.locator("[data-pad]").fill(String(digits));
    await row.locator("[data-num]").fill(String(next));
    await row.locator(`[data-setnum="${type}"]`).click();
    await modal().locator("#confirmOk").click();
    await expectToast();
  };
  await setNumbering("PO", "CCPL/PO/{FY}/{SEQ}", 1);

  /* ================= 4. PO for 10 KG apples: invoice → GRN → Kanta ================= */
  console.log("\n4. Apple PO: 5 + 5, Kanta 4.8 on the second");
  const applePo = await createPo("Pyramid", "PG-106", [{ item: "Apple", qty: 10, rate: 100 }]);
  check(applePo.poNo === "CCPL/PO/26-27/001", `PO number uses the set format (${applePo.poNo})`);
  check((await readFile(applePo.pdf)).subarray(0, 5).toString() === "%PDF-", "PO PDF downloaded");
  let po = await one("purchaseOrders", "poNo", applePo.poNo);
  check(near(po.totals.subTotal, 1000) && near(po.totals.total, 1180) && po.totals.taxes.map((t) => t.kind).join() === "CGST,SGST", "PO totals: 1000 + CGST 90 + SGST 90 = 1180");

  const r1 = await receiptEntry({ poNo: applePo.poNo, invoiceNo: "INV-A1", qtys: { Apple: 5 } });
  po = await one("purchaseOrders", "poNo", applePo.poNo);
  check(po.status === "PARTIALLY RECEIVED" && lineOf(po, "Apple").invoicedQty === 5 && (await stockOf("PG-106", "Apple")) === 0, "invoice entered → PARTIALLY RECEIVED, no stock yet");
  await grnStep(r1);
  po = await one("purchaseOrders", "poNo", applePo.poNo);
  check(po.status === "AWAITING KANTA" && lineOf(po, "Apple").grnQty === 5 && (await stockOf("PG-106", "Apple")) === 0, "GRN 5 → AWAITING KANTA, still no stock (GRN is not final)");
  await kantaStep(r1);
  po = await one("purchaseOrders", "poNo", applePo.poNo);
  check(po.status === "PARTIALLY INWARDED" && lineOf(po, "Apple").receivedQty === 5 && (await stockOf("PG-106", "Apple")) === 5, "Kanta 5 → stock inward 5 → PARTIALLY INWARDED");

  const r2 = await receiptEntry({ poNo: applePo.poNo, invoiceNo: "INV-A2", qtys: { Apple: 5 } });
  await grnStep(r2);
  await kantaStep(r2, { Apple: 4.8 });
  const rec2 = await one("receipts", "invoiceNo", "INV-A2");
  check(near(rec2.lines[0].kantaQty, 4.8) && near(rec2.lines[0].varianceQty, -0.2) && near(rec2.lines[0].payableQty, 4.8), "Kanta 4.8 on GRN 5 → shortage 0.2, payable 4.8 on that transaction");
  po = await one("purchaseOrders", "poNo", applePo.poNo);
  const apple = lineOf(po, "Apple");
  check(near(apple.receivedQty, 9.8) && near(apple.varianceQty, -0.2) && apple.grnQty === 10 && po.status === "PARTIALLY INWARDED", "PO: GRN 10, Kanta/inward 9.8, short 0.2, pending 0.2");
  check(near(await stockOf("PG-106", "Apple"), 9.8), "stock at PG-106 = 9.8 KG (Kanta is final)");
  // Duplicate invoice guard
  await goto("inward.html"); await page.click("#newEntry");
  await selectContaining(modal().locator("select[name=poId]"), applePo.poNo);
  await modal().locator("input[name=invoiceNo]").fill("INV-A2");
  await modal().locator("#itemArea tr", { hasText: "Apple" }).locator("input[data-line]").fill("1");
  await modal().locator("#saveGe").click();
  check((await expectToast("error")).includes("already entered"), "same invoice cannot be entered twice");
  await closeAllModals();
  // PO detail + close
  await page.goto(`${BASE}/purchase-orders.html?open=${po.id}`);
  await modal().locator("#closePo").waitFor();
  const detailText = await modal().textContent();
  check(detailText.includes("INV-A1") && detailText.includes("INV-A2") && detailText.includes("Kanta Qty") && detailText.includes("-0.2"), "PO detail shows PO/GRN/Kanta/Short/Inward/Pending and every invoice");
  await page.screenshot({ path: path.join(OUT, "02-po-detail-partial.png") });
  await modal().locator("#closePo").click();
  await page.locator("#confirmInput").fill("Vendor cannot supply the balance 0.2 KG");
  await page.click("#confirmOk");
  await expectToast();
  po = await one("purchaseOrders", "poNo", applePo.poNo);
  check(po.status === "CLOSED" && po.closeReason.includes("balance"), "PO closed (mark complete) with reason");
  await goto("inward.html"); await page.click("#newEntry");
  check(!(await modal().locator("select[name=poId]").textContent()).includes(applePo.poNo), "closed PO no longer offered for inward");
  await closeAllModals();

  /* ================= 4b. Multi-item PO: Methanol + IPA ================= */
  console.log("\n4b. Multi-item PO tracked product-wise");
  const multiPo = await createPo("Pyramid", "PG-106", [{ item: "Methanol", qty: 20000, rate: 30 }, { item: "IPA", qty: 20, rate: 90 }]);
  const rm = await receiptEntry({ poNo: multiPo.poNo, invoiceNo: "INV-M1", qtys: { Methanol: 10000, IPA: 10 } });
  check(rm.lines.length === 2, "one invoice carries both items");
  await grnStep(rm);
  await kantaStep(rm, { Methanol: 9970, IPA: 10 });
  po = await one("purchaseOrders", "poNo", multiPo.poNo);
  const meth = lineOf(po, "Methanol"); const ipa = lineOf(po, "IPA");
  check(meth.grnQty === 10000 && meth.receivedQty === 9970 && meth.varianceQty === -30 && round(meth.qty - meth.receivedQty) === 10030, "Methanol: PO 20,000 · GRN 10,000 · Kanta 9,970 · short −30 · pending 10,030");
  check(ipa.receivedQty === 10 && round(ipa.qty - ipa.receivedQty) === 10 && po.status === "PARTIALLY INWARDED", "IPA: 10 received / 10 pending; PO PARTIALLY INWARDED");
  await page.goto(`${BASE}/purchase-orders.html?open=${po.id}`);
  await modal().locator("#pdfPo").waitFor();
  await page.screenshot({ path: path.join(OUT, "02b-po-multi-item.png") });
  await closeAllModals();
  await receiveFully(multiPo.poNo, [["INV-M2", { Methanol: 10030, IPA: 10 }]]);
  po = await one("purchaseOrders", "poNo", multiPo.poNo);
  check(po.status === "COMPLETED", "second invoice brings both items to full → COMPLETED");

  /* ================= 5. Drums PO fully received → auto COMPLETED ================= */
  console.log("\n5. Packaging PO (M S Drum) completes automatically");
  const drumPo = await createPo("Pyramid", "PG-106", [{ item: "M S Drum", qty: 200, rate: 1810 }]);
  po = await one("purchaseOrders", "poNo", drumPo.poNo);
  check(po.poNo === "CCPL/PO/26-27/003" && near(po.totals.total, 427160), `drum PO ${po.poNo} total Rs.427,160 (matches your sample PO)`);
  await receiveFully(drumPo.poNo, [["INV-D1", { "M S Drum": 100 }], ["INV-D2", { "M S Drum": 100 }]]);
  po = await one("purchaseOrders", "poNo", drumPo.poNo);
  check(po.status === "COMPLETED" && po.lines[0].receivedQty === 200, "two invoices of 100 → PO COMPLETED automatically");
  check(await stockOf("PG-106", "M S Drum") === 200, "packaging stock at PG-106 = 200 drums");

  /* ================= 6. Inter-state tanker PO (IGST) ================= */
  console.log("\n6. Inter-state PO → IGST");
  const acidPo = await createPo("Gujarat Acids", "PG-106", [{ item: "Hydrochloric", qty: 10000, rate: 12 }]);
  po = await one("purchaseOrders", "poNo", acidPo.poNo);
  check(po.totals.taxes.length === 1 && po.totals.taxes[0].kind === "IGST" && near(po.totals.taxes[0].amount, 21600), "Gujarat vendor → IGST 18% = 21,600");
  await receiveFully(acidPo.poNo, [["GJ-9001", { Hydrochloric: 10000 }, { Hydrochloric: 9980 }]]);
  check(await stockOf("PG-106", "Hydrochloric Acid 33%") === 9980, "tanker Kanta 9,980 KG added to PG-106");
  check((await one("purchaseOrders", "poNo", acidPo.poNo)).status === "COMPLETED", "9,980 of 10,000 KG is within 0.5% tolerance → tanker PO COMPLETED");

  /* ================= 6b. Duplicate-proof numbering ================= */
  console.log("\n6b. Numbering never repeats");
  await setNumbering("PO", "CCPL/PO/{FY}/{SEQ}", 2);
  const dupTest = await createPo("Pyramid", "PG-106", [{ item: "Apple", qty: 1, rate: 1 }]);
  check(dupTest.poNo === "CCPL/PO/26-27/005", `counter set back to 002 by mistake → system skips used numbers and issues ${dupTest.poNo}`);

  /* ================= 6c. Opening / existing stock ================= */
  console.log("\n6c. Add Existing / Opening Stock");
  await goto("inventory.html");
  await page.click("#openingBtn");
  let m = modal();
  await m.locator("select[name=warehouse]").selectOption("BREEZE");
  await selectContaining(m.locator("select[name=itemId]"), "Carboy");
  await m.locator("input[name=qty]").fill("50");
  await m.locator("input[name=reason]").fill("Opening stock counted on go-live day");
  await m.locator("#saveOs").click();
  await expectToast();
  const os = await one("adjustments", "kind", "OPENING");
  check(await stockOf("BREEZE", "Carboy") === 50 && os?.adjNo.startsWith("OS/") && os.reason.includes("go-live") && os.createdBy?.name === "Test Admin", "opening stock +50 Carboy at Breeze with its own OS number, reason and user");

  /* ================= 7. Transfer PG-106 → Taloja with transit loss ================= */
  console.log("\n7. Stock transfer PG → Taloja");
  await goto("transfers.html"); await page.click("#newTr");
  m = modal();
  await m.locator("select[name=from]").selectOption("PG-106");
  await m.locator("select[name=to]").selectOption("TALOJA");
  await selectContaining(m.locator("select[data-f=itemId]").first(), "Hydrochloric");
  await m.locator("input[data-f=qty]").first().fill("4000");
  await m.locator("#addL").click();
  await selectContaining(m.locator("select[data-f=itemId]").nth(1), "M S Drum");
  await m.locator("input[data-f=qty]").nth(1).fill("30");
  await m.locator("#saveT").click();
  await expectToast();
  check(await stockOf("PG-106", "Hydrochloric Acid 33%") === 5980 && await stockOf("TALOJA", "Hydrochloric Acid 33%") === 0, "dispatch: PG-106 reduced, Taloja not yet increased (in transit)");
  const tr = await one("transfers", "status", "IN TRANSIT");
  await goto("transfers.html");
  await page.locator(`[data-receive="${tr.id}"]`).click();
  m = modal();
  await m.locator("input[name=rec0]").fill("3900");
  await m.locator("input[name=why0]").fill("Leakage in transit");
  await m.locator("#saveR").click();
  await expectToast();
  check(await stockOf("TALOJA", "Hydrochloric Acid 33%") === 3900 && await stockOf("TALOJA", "M S Drum") === 30, "Taloja receives 3,900 KG + 30 drums; 100 KG transit loss recorded");

  /* ================= 8. Write-off at Taloja + delete (reverse) ================= */
  console.log("\n8. Write-off destroyed material at Taloja");
  await goto("adjustments.html"); await page.click("#newAdj");
  m = modal();
  await m.locator("select[name=warehouse]").selectOption("TALOJA");
  await m.locator("select[name=type]").selectOption("Destroyed");
  await selectContaining(m.locator("select[name=itemId]"), "M S Drum");
  await m.locator("input[name=qty]").fill("2");
  await m.locator("input[name=reason]").fill("2 drums punctured while unloading");
  await m.locator("#saveA").click();
  await page.click("#confirmOk");
  await expectToast();
  check(await stockOf("TALOJA", "M S Drum") === 28, "2 destroyed drums written off at Taloja (30 → 28)");
  const adj = await one("adjustments", "type", "Destroyed");
  await goto("adjustments.html");
  await page.locator(`[data-del="${adj.id}"]`).click();
  await page.locator("#confirmInput").fill("Entered by mistake");
  await page.click("#confirmOk");
  await expectToast();
  check(await stockOf("TALOJA", "M S Drum") === 30, "admin deletes the write-off → stock restored to 30");
  await goto("adjustments.html"); await page.click("#newAdj");
  m = modal();
  await m.locator("select[name=warehouse]").selectOption("TALOJA");
  await m.locator("select[name=type]").selectOption("Destroyed");
  await selectContaining(m.locator("select[name=itemId]"), "M S Drum");
  await m.locator("input[name=qty]").fill("2");
  await m.locator("input[name=reason]").fill("2 drums punctured while unloading");
  await m.locator("#saveA").click();
  await page.click("#confirmOk");
  await expectToast();

  /* ================= 9. Quotation → SO → dispatch with packaging ================= */
  console.log("\n9. Quotation → Sales Order → Outward");
  await goto("quotations.html"); await page.click("#newDoc");
  m = modal();
  await selectContaining(m.locator("select[name=customerId]"), "Deepak Fertilisers");
  await selectContaining(m.locator("select[data-f=itemId]").first(), "Hydrochloric");
  await m.locator("input[data-f=qty]").first().fill("2000");
  await m.locator("input[data-f=rate]").first().fill("25");
  await m.locator("#saveS").click();
  await expectToast();
  const quote = await one("quotations", "status", "DRAFT");
  check(quote.quoteNo === "CCPL/QT/26-27/001" && near(quote.totals.total, 59000), `quotation ${quote.quoteNo} = Rs.59,000`);
  await goto("quotations.html");
  await page.locator(`[data-view="${quote.id}"]`).first().click();
  await modal().locator('[data-act="ACCEPTED"]').click();
  await page.click("#confirmOk");
  await expectToast();
  await page.click('[data-tab="ACCEPTED"]');
  await page.locator(`[data-view="${quote.id}"]`).first().click();
  await modal().locator('[data-act="convert"]').click();
  await page.waitForURL(/sales-orders\.html/);
  m = modal();
  await m.locator("#saveS").waitFor();
  await m.locator("select[name=warehouse]").selectOption("TALOJA");
  await m.locator("input[name=customerPoNo]").fill("DFL/PO/5566");
  await m.locator("#saveS").click();
  await expectToast();
  const so = await one("salesOrders", "quotationId", quote.id);
  check(so && so.soNo === "CCPL/SO/26-27/001" && (await one("quotations", "quoteNo", quote.quoteNo)).status === "CONVERTED", "accepted quotation converted into SO");

  // Try to over-dispatch first (more than Taloja stock) — must be blocked
  await goto("outward.html"); await page.click("#newOut");
  m = modal();
  await m.locator("select[name=mode]").selectOption("DIRECT");
  await selectContaining(m.locator("select[name=customerId]"), "Deepak");
  await m.locator("select[name=warehouse]").selectOption("TALOJA");
  await selectContaining(m.locator("select[data-f=itemId]").first(), "Hydrochloric");
  await m.locator("input[data-f=qty]").first().fill("5000");
  await m.locator("input[data-f=qty]").first().dispatchEvent("change");
  await m.locator("#saveOut").click();
  check((await expectToast("error")).includes("Insufficient stock"), "dispatch more than available stock is blocked");
  await closeAllModals();

  await goto("outward.html"); await page.click("#newOut");
  m = modal();
  await selectContaining(m.locator("select[name=soId]"), so.soNo);
  await selectContaining(m.locator("select[data-f=packItemId]").first(), "M S Drum");
  const containers = await m.locator("input[data-f=containers]").first().inputValue();
  check(containers === "10", "2,000 KG in 200 L drums → 10 drums suggested");
  await m.locator("input[name=invoiceNo]").fill("CCPL/INV/101");
  await m.locator("input[name=vehicleNo]").fill("MH06XY9999");
  await page.screenshot({ path: path.join(OUT, "03-outward-form.png") });
  await m.locator("#saveOut").click();
  await expectToast();
  await page.locator("#pdfDownload:not([disabled])").waitFor({ timeout: 30000 });
  const [dcDl] = await Promise.all([page.waitForEvent("download"), page.click("#pdfDownload")]);
  await dcDl.saveAs(path.join(OUT, dcDl.suggestedFilename()));
  await closeAllModals();
  check(await stockOf("TALOJA", "Hydrochloric Acid 33%") === 1900 && await stockOf("TALOJA", "M S Drum") === 18, "outward from Taloja: acid 3,900 → 1,900 KG and drums 28 → 18 (packaging deducted)");
  check(await stockOf("PG-106", "Hydrochloric Acid 33%") === 5980, "PG-106 stock untouched by Taloja dispatch");
  const soAfter = await one("salesOrders", "soNo", so.soNo);
  check(soAfter.status === "COMPLETED" && soAfter.lines[0].dispatchedQty === 2000, "SO fully dispatched → COMPLETED");

  /* ================= 10. PDFs for quotation & SO ================= */
  for (const [file, id] of [["quotations.html", quote.id], ["sales-orders.html", so.id]]) {
    await goto(file); await page.click('[data-tab="ALL"]');
    await page.locator(`[data-pdf="${id}"]`).click();
    await page.locator("#pdfDownload:not([disabled])").waitFor({ timeout: 30000 });
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#pdfDownload")]);
    await dl.saveAs(path.join(OUT, dl.suggestedFilename()));
    await closeAllModals();
  }
  check(true, "quotation and sales order PDFs generated");

  /* ================= 10b. Proforma Invoice from a Sales Order ================= */
  console.log("\n10b. Proforma Invoice (IGST, from SO)");
  await goto("sales-orders.html"); await page.click("#newDoc");
  m = modal();
  await selectContaining(m.locator("select[name=customerId]"), "Gujarat Acids");
  await m.locator("input[name=customerPoNo]").fill("GA/PO/77");
  await m.locator("input[name=customerPoDate]").fill("2026-09-25");
  await m.locator("select[name=warehouse]").selectOption("PG-106");
  await selectContaining(m.locator("select[data-f=itemId]").first(), "Methanol");
  await m.locator("input[data-f=qty]").first().fill("3000");
  await m.locator("input[data-f=rate]").first().fill("62");
  await m.locator("#saveS").click();
  await expectToast();
  const gaSo = await one("salesOrders", "customerPoNo", "GA/PO/77");
  await goto("sales-orders.html");
  await page.locator(`[data-view="${gaSo.id}"]`).first().click();
  await modal().locator('[data-act="proforma"]').click();
  await page.waitForURL(/proforma\.html/);
  m = modal();
  await m.locator("#savePi").waitFor();
  check(await m.locator("input[name=refNo]").inputValue() === "GA/PO/77" && await m.locator("input[name=termsDays]").inputValue() === "45"
    && (await m.locator("input[name=dispatchFrom]").inputValue()).includes("PATALGANGA"), "PI pre-filled from SO: reference, 45-day terms, dispatch from PG-106 (Patalganga)");
  await m.locator("input[name=dispatchThrough]").fill("Tanker");
  await m.locator("input[name=destination]").fill("DAHEJ");
  await m.locator("#savePi").click();
  await expectToast();
  let pi = await one("proformaInvoices", "soId", gaSo.id);
  check(pi?.piNo === "CCPL/PI/26-27/001" && pi.status === "ISSUED" && pi.soNo === gaSo.soNo, `proforma invoice ${pi?.piNo} issued against ${gaSo.soNo}`);
  check(pi.totals.taxes.length === 1 && pi.totals.taxes[0].kind === "IGST" && near(pi.totals.taxes[0].amount, 33480) && near(pi.totals.total, 219480), "Methanol 3,000 @ 62 to Gujarat → IGST 33,480 · total Rs.219,480 (same as Troikaa PI)");
  check(pi.dueDate === new Date(Date.parse(`${pi.date}T00:00:00Z`) + 45 * 86400000).toISOString().slice(0, 10), "due date = invoice date + 45 days");
  await goto("proforma.html");
  await page.locator(`[data-pdf="${pi.id}"]`).click();
  await page.locator("#pdfDownload:not([disabled])").waitFor({ timeout: 30000 });
  const [piDl] = await Promise.all([page.waitForEvent("download"), page.click("#pdfDownload")]);
  const piPdf = path.join(OUT, piDl.suggestedFilename());
  await piDl.saveAs(piPdf);
  await closeAllModals();
  check((await readFile(piPdf)).subarray(0, 5).toString() === "%PDF-", "proforma invoice PDF downloaded");
  await page.locator(`[data-view="${pi.id}"]`).first().click();
  await modal().locator('[data-act="PAID"]').click();
  await page.locator("#confirmInput").fill("UTR ICIC123456");
  await page.click("#confirmOk");
  await expectToast();
  pi = await one("proformaInvoices", "soId", gaSo.id);
  check(pi.status === "PAID" && pi.statusNote.includes("UTR"), "PI marked paid with payment reference");

  /* ================= 11. Ledger & activity log ================= */
  console.log("\n11. Stock ledger & activity log");
  const ledger = (await adb.collection("stockLedger").get()).docs.map((d) => d.data());
  const acidTaloja = ledger.filter((l) => l.warehouse === "TALOJA" && l.itemName.startsWith("Hydrochloric")).sort((a, b) => a.at.toMillis() - b.at.toMillis());
  check(acidTaloja.map((l) => l.balance).join() === "3900,1900", "Taloja acid ledger balances 3,900 → 1,900");
  await goto("activity.html");
  await page.waitForSelector("#rows tr");
  const actText = await page.textContent("#rows");
  check(/\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}/.test(actText) && actText.includes("Test Admin") && actText.includes("INV-A2"), "activity log shows who did what, to the second");
  await page.screenshot({ path: path.join(OUT, "04-activity.png"), fullPage: false });
  await goto("inventory.html");
  await page.screenshot({ path: path.join(OUT, "05-inventory.png") });
  await goto("purchase-orders.html"); await page.click('[data-tab="ALL"]');
  await page.screenshot({ path: path.join(OUT, "06-po-list.png") });
  await goto("dashboard.html");
  await page.screenshot({ path: path.join(OUT, "07-dashboard.png") });

  // Admin adds a new ERP user from Settings; that user can then sign in.
  await goto("settings.html");
  await page.click("#addUser");
  m = modal();
  await m.locator("input[name=name]").fill("New Storekeeper");
  await m.locator("input[name=email]").fill("store@test.ccpl");
  await m.locator("select[name=role]").selectOption("operator");
  await m.locator("input[name=password]").fill("Store#123456");
  await m.locator("#createU").click();
  await expectToast();
  await page.waitForFunction(() => document.querySelector("#users")?.textContent.includes("store@test.ccpl"), null, { timeout: 10000 }).catch(() => {});
  check((await page.textContent("#users")).includes("store@test.ccpl"), "admin created a new user from Settings");
  await logout();
  await login("store@test.ccpl", "Store#123456");
  await page.waitForURL(/dashboard\.html/, { timeout: 20000 });
  check(true, "newly created user can sign in");
  await logout();

  /* ================= 11b. Exceptions & PDF wording ================= */
  console.log("\n11b. Exceptions");
  await login("admin@test.ccpl", "Admin#12345");
  await page.waitForURL(/dashboard\.html/);
  await goto("exceptions.html");
  const exText = await page.textContent("#page");
  check(exText.includes("Kanta shortage / excess") && exText.includes("Apple: GRN 5 → Kanta 4.8") && exText.includes("Methanol: GRN 10,000 → Kanta 9,970"), "Exceptions lists Kanta shortages (Apple −0.2, Methanol −30)");
  check(exText.includes("Invoice qty not matching Kanta") && exText.includes("Stock manually adjusted") && exText.includes("Opening / existing stock"), "Exceptions lists invoice≠payable and manual stock entries");
  await page.screenshot({ path: path.join(OUT, "08-exceptions.png"), fullPage: true });
  check(await page.locator('.nav-link[href="access.html"]').count() === 0, "Access Audit is hidden from other admins");
  const deniedSessions = await page.evaluate(async () => {
    const { db } = await import("./js/firebase-config.js");
    const fs = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
    try { await fs.getDocs(fs.collection(db, "sessions")); return "allowed"; } catch (e) { return e.code; }
  });
  check(deniedSessions === "permission-denied", "other admins cannot read login sessions (enforced by the database rules)");
  await logout();

  console.log("\n11c. Private Access Audit (super admin only)");
  await login("rupesh.mudliar@cognizantchemical.com", "Rupesh#12345");
  await page.waitForURL(/dashboard\.html/);
  await goto("access.html");
  let accText = await page.textContent("#page");
  const usersOk = accText.includes("Test Admin") && accText.includes("Online now") && accText.includes("Last login");
  check(usersOk, "super admin sees every user's last login / last active");
  await page.click('[data-tab="sessions"]');
  accText = await page.textContent("#page");
  check(accText.includes("Sign out") && /\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}/.test(accText), "login sessions show login, last active and logout times");
  await page.click('[data-tab="grnKanta"]');
  accText = await page.textContent("#page");
  check(accText.includes("Average GRN → Kanta") && accText.includes("Test Admin") && accText.includes("GRN/26-27/"), "GRN → Kanta timing shows who did GRN and Kanta, and how long it took");
  await page.screenshot({ path: path.join(OUT, "09-access-audit.png"), fullPage: true });
  await logout();

  /* ================= 12. Role restrictions ================= */
  console.log("\n12. Role restrictions");
  await login("operator@test.ccpl", "Operator#12345");
  await page.waitForURL(/dashboard\.html/);
  await goto("purchase-orders.html");
  check(await page.locator("#newPo").count() === 0, "operator cannot see New Purchase Order");
  const denied = await page.evaluate(async () => {
    const { db } = await import("./js/firebase-config.js");
    const fs = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
    const results = {};
    const tryIt = async (name, fn) => { try { await fn(); results[name] = "allowed"; } catch (e) { results[name] = e.code; } };
    await tryIt("createPo", () => fs.addDoc(fs.collection(db, "purchaseOrders"), { status: "OPEN", poNo: "HACK" }));
    await tryIt("createPi", () => fs.addDoc(fs.collection(db, "proformaInvoices"), { status: "ISSUED", piNo: "HACK" }));
    const act = await fs.getDocs(fs.query(fs.collection(db, "activity"), fs.limit(1)));
    await tryIt("editActivity", () => fs.updateDoc(act.docs[0].ref, { summary: "tampered" }));
    await tryIt("deleteActivity", () => fs.deleteDoc(act.docs[0].ref));
    await tryIt("negativeStock", () => fs.setDoc(fs.doc(db, "inventory", "TALOJA__x"), { qty: -5 }));
    await tryIt("makeMeAdmin", async () => { const { auth } = await import("./js/firebase-config.js"); await fs.updateDoc(fs.doc(db, "users", auth.currentUser.uid), { role: "admin" }); });
    await tryIt("readOldCollection", () => fs.getDocs(fs.collection(db, "inward")));
    return results;
  });
  check(Object.values(denied).every((v) => v === "permission-denied"), `operator write attempts denied by rules: ${JSON.stringify(denied)}`);
  await logout();
  await login("outsider@evil.test", "Outsider#12345");
  await page.waitForTimeout(1500);
  const outsiderRead = await page.evaluate(async () => {
    const { db, auth } = await import("./js/firebase-config.js");
    const { signInWithEmailAndPassword } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js");
    const fs = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
    await signInWithEmailAndPassword(auth, "outsider@evil.test", "Outsider#12345");
    try { await fs.getDocs(fs.collection(db, "purchaseOrders")); return "allowed"; } catch (e) { return e.code; }
  });
  check(outsiderRead === "permission-denied", "outsider cannot read any data even with a valid Firebase login");

  check(consoleErrors.length === 0, `no unexpected browser errors${consoleErrors.length ? `: ${consoleErrors.slice(0, 3).join(" | ")}` : ""}`);
} catch (error) {
  failures.push(`Crashed: ${error.message}`);
  console.error(error);
  await page.screenshot({ path: path.join(OUT, "failure.png") }).catch(() => {});
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
process.exit(0);
