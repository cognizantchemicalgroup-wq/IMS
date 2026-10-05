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
async function routeCdn(ctx) {
  await ctx.route(/^https:\/\/www\.gstatic\.com\/firebasejs\/10\.12\.2\/(.+)$/, (route) => route.fulfill({ path: path.join(NM, "firebase", route.request().url().split("/").pop()), contentType: "text/javascript" }));
  await ctx.route(/pdfmake\/0\.2\.10\/(pdfmake\.min\.js|vfs_fonts\.js)$/, (route) => route.fulfill({ path: path.join(NM, "pdfmake", "build", route.request().url().split("/").pop()), contentType: "text/javascript" }));
  await ctx.route(/xlsx\/0\.18\.5\/xlsx\.full\.min\.js$/, (route) => route.fulfill({ path: path.join(NM, "xlsx", "dist", "xlsx.full.min.js"), contentType: "text/javascript" }));
  await ctx.route(/fonts\.googleapis\.com|fonts\.gstatic\.com|font-awesome/, (route) => route.fulfill({ body: "", contentType: "text/css" }));
}
await routeCdn(context);

const page = await context.newPage();
const consoleErrors = [];
// "Could not reach Cloud Firestore backend" is the SDK reporting a momentary emulator reconnect (it retries by itself).
page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|Could not reach Cloud Firestore backend/.test(m.text())) consoleErrors.push(m.text()); });
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
  const cls = await t.getAttribute("class");
  const actual = cls.includes("error") ? "error" : cls.includes("ok") ? "ok" : "info";
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

async function fillPo(pg, { vendor, warehouse, lines, series = "PH", date, poType }) {
  const m = pg.locator(".modal-backdrop").last();
  await m.locator("select[name=series]").selectOption(series);
  if (poType) await m.locator("select[name=poType]").selectOption(poType);
  if (date) await m.locator("input[name=date]").fill(date);
  await selectContaining(m.locator("select[name=vendorId]"), vendor);
  await m.locator("select[name=warehouse]").selectOption(warehouse);
  for (let i = 0; i < lines.length; i += 1) {
    if (i > 0) await m.locator("[data-add]").click();
    const row = m.locator(".line-table tbody tr").nth(i);
    await selectContaining(row.locator("select[data-f=itemId]"), lines[i].item);
    await row.locator("input[data-f=qty]").fill(String(lines[i].qty));
    await row.locator("input[data-f=rate]").fill(String(lines[i].rate));
  }
  return m;
}
async function createPo(vendor, warehouse, lines, { series = "PH", date, poType } = {}) {
  await goto("purchase-orders.html");
  await page.click("#newPo");
  const m = await fillPo(page, { vendor, warehouse, lines, series, date, poType });
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
async function receiptEntry({ poNo, invoiceNo, qtys, warehouse, transport = "PARTY", amount = "", rejectReason = "", confirm = false }) {
  await goto("inward.html");
  await page.click("#newEntry");
  const m = modal();
  const poDoc = await one("purchaseOrders", "poNo", poNo);
  await m.locator("select[name=vendorId]").selectOption(poDoc.vendorId);
  if (warehouse) await m.locator("select[name=warehouse]").selectOption(warehouse);
  await m.locator("input[name=invoiceNo]").fill(invoiceNo);
  for (const [name, q] of Object.entries(qtys)) await m.locator(`#itemArea tr[data-po-no="${poNo}"]`, { hasText: name }).locator("input[data-line]").fill(String(q));
  await m.locator("input[name=vehicleNo]").fill("MH46AB1234");
  await m.locator("select[name=transportMode]").selectOption(transport);
  if (amount !== "") await m.locator("input[name=transportAmount]").fill(String(amount));
  if (rejectReason) {
    await m.locator("select[name=entryStatus]").selectOption("REJECTED");
    await m.locator("input[name=rejectReason]").fill(rejectReason);
  }
  await m.locator("#saveGe").click();
  if (confirm) await page.locator(".modal-backdrop").last().locator("#confirmOk").click();
  await expectToast(rejectReason ? "info" : "ok");
  const s = await adb.collection("receipts").where("invoiceNo", "==", invoiceNo).get();
  const docs = s.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis());
  return docs[0];
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
  for (const [name, q] of Object.entries(qtys)) await m.locator("tr", { hasText: name }).locator('input[name^="k"]').fill(String(q));
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
/** PDF text via python3 + pymupdf when available (optional check). */
function pdfText(file) {
  try { return execFileSync("python3", ["-c", "import sys,fitz;print(''.join(p.get_text() for p in fitz.open(sys.argv[1])))", file], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; }
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
  await addMaster("parties.html", { name: "Pyramid Technoplast Limited", gstin: "27AACCP5074E3ZF", address1: "GAT NO. 420/1, 420/2, 420/3, KHANIVALI", address2: "Khanivali", city: "Palghar", pincode: "401204", paymentTerms: "30" }, { partyType: "Supplier" });
  const vendor = await one("parties", "name", "Pyramid Technoplast Limited");
  check(vendor?.stateCode === "27" && vendor?.pan === "AACCP5074E" && vendor?.state === "Maharashtra" && vendor.partyType === "Supplier", "vendor GSTIN auto-fills state code, state and PAN; party type Supplier");
  check(vendor.paymentTerms === "30 Days" && vendor.paymentTermsDays === 30, "payment terms typed as a number become \"30 Days\"");
  await addMaster("parties.html", { name: "Shree Solvents LLP", gstin: "27AAACS7777B1Z3", city: "Turbhe", paymentTerms: "Advance" }, { partyType: "Supplier" });
  await addMaster("parties.html", { name: "Kalyan Polymers", city: "Kalyan", paymentTerms: "Against delivery" }, { partyType: "Both" });
  check((await one("parties", "name", "Shree Solvents LLP"))?.paymentTerms === "Advance" && (await one("parties", "name", "Kalyan Polymers"))?.paymentTerms === "Against delivery", "payment terms accept text (Advance, Against delivery)");
  await addMaster("parties.html", { name: "Gujarat Acids Pvt Ltd", gstin: "24AABCG1234H1Z5", city: "Vapi", paymentTerms: "45 Days" }, { partyType: "Supplier" });
  await addMaster("parties.html", { name: "Deepak Fertilisers Ltd", gstin: "27AAACD1234E1ZX", city: "Taloja" }, { partyType: "Customer" });
  await addMaster("items.html", { name: "Apple", hsn: "08081000", gstRate: 18 }, { category: "Raw Material", unit: "KG" });
  await addMaster("items.html", { name: "Methanol", hsn: "29051100", gstRate: 18 }, { category: "Raw Material", unit: "KG" });
  await addMaster("items.html", { name: "IPA", hsn: "29051220", gstRate: 18 }, { category: "Raw Material", unit: "KG" });
  await addMaster("items.html", { name: "Hydrochloric Acid 33%", hsn: "28061000", gstRate: 18 }, { category: "Finished Goods", unit: "KG" });
  // Duplicate protection
  await goto("parties.html"); await page.click("#addBtn");
  await modal().locator("[name=name]").fill("Another name"); await modal().locator("[name=gstin]").fill("27AACCP5074E3ZF");
  await modal().locator("[name=partyType]").selectOption("Customer");
  await modal().locator("#saveMaster").click();
  check((await expectToast("error")).includes("already exists"), "duplicate party GSTIN is blocked (same company is one record)");
  await closeAllModals();

  /* ---- 2a. Bulk import: template, preview, row/column errors, duplicates, skip/update, report ---- */
  console.log("\n2a. Party bulk import");
  const XLSX = (await import(path.join(NM, "xlsx", "xlsx.mjs"))).default ?? await import(path.join(NM, "xlsx", "xlsx.mjs"));
  XLSX.set_fs?.(await import("node:fs"));
  await goto("parties.html");
  await page.click("#templateBtn");
  check((await modal().textContent()).includes("Required") && (await modal().textContent()).includes("Optional"), "template guide lists every column as Required / Optional");
  const [tpl] = await Promise.all([page.waitForEvent("download"), modal().locator("#tplXlsx").click()]);
  const tplFile = path.join(OUT, tpl.suggestedFilename());
  await tpl.saveAs(tplFile);
  const [tplCsv] = await Promise.all([page.waitForEvent("download"), modal().locator("#tplCsv").click()]);
  await tplCsv.saveAs(path.join(OUT, tplCsv.suggestedFilename()));
  await closeAllModals();
  const tplWb = XLSX.readFile(tplFile);
  const header = XLSX.utils.sheet_to_json(tplWb.Sheets[tplWb.SheetNames[0]], { header: 1 })[0];
  check(header[0] === "Party Name (Required)" && header[1] === "Party Type (Required)" && header.includes("GSTIN (Optional)") && tplWb.SheetNames.includes("Instructions"), `Excel template header: ${header.slice(0, 4).join(" | ")}…`);
  check((await readFile(path.join(OUT, tplCsv.suggestedFilename()), "utf8")).includes('"Party Name (Required)","Party Type (Required)"'), "CSV template downloaded with the same columns");
  // Sample file arranged in the template format
  const col = (h) => header.indexOf(h);
  const rowOf = (values) => { const r = header.map(() => ""); Object.entries(values).forEach(([h, v]) => { r[col(h)] = v; }); return r; };
  const sampleRows = [
    { "Party Name (Required)": "Bulk Customer One", "Party Type (Required)": "Customer", "GSTIN (Optional)": "27AAACB1111A1Z1", "City (Optional)": "Pune", "Payment Terms (Optional)": 30 },
    { "Party Name (Required)": "Bulk Supplier Two", "Party Type (Required)": "Vendor", "City (Optional)": "Mumbai", "Payment Terms (Optional)": "Net 15", "Bank A/c No. (Optional)": 484105000428 },
    { "Party Name (Required)": "Broken Party", "Party Type (Required)": "Customer", "GSTIN (Optional)": "NOT-A-GSTIN" },
    { "Party Name (Required)": "", "Party Type (Required)": "Supplier", "City (Optional)": "Nowhere" },
    { "Party Name (Required)": "Wrong Type Co", "Party Type (Required)": "Distributor" },
    { "Party Name (Required)": "Delhi Traders", "Party Type (Required)": "Both", "GSTIN (Optional)": "07AAACD5555F1Z2", "State Code (Optional)": 7 },
    { "Party Name (Required)": "Pyramid Technoplast Ltd.", "Party Type (Required)": "Customer", "GSTIN (Optional)": "27AACCP5074E3ZF", "Phone (Optional)": 9811111111 },
    { "Party Name (Required)": "Bulk Customer One", "Party Type (Required)": "Supplier", "GSTIN (Optional)": "27AAACB1111A1Z1", "Email (Optional)": "accounts@bulk1.test" },
    { "Party Name (Required)": "Mismatch State", "Party Type (Required)": "Customer", "GSTIN (Optional)": "27AAACM1234A1Z5", "State Code (Optional)": "24" }
  ];
  const sampleWb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(sampleWb, XLSX.utils.aoa_to_sheet([header, ...sampleRows.map(rowOf)]), "Vendors & Customers");
  const sampleFile = path.join(OUT, "sample-party-import.xlsx");
  XLSX.writeFile(sampleWb, sampleFile);
  const importParties = async (file) => {
    await goto("parties.html");
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click("#importBtn")]);
    await chooser.setFiles(file);
    await modal().locator("#confirmImport").waitFor();
    return modal().textContent();
  };
  let preview = await importParties(sampleFile);
  const errText = await modal().locator("#errorTable").textContent();
  check(/4GSTIN \(Optional\)Broken PartyGSTIN "NOT-A-GSTIN" is not a valid/.test(errText) && /5Party Name \(Required\)/.test(errText) && /6Party Type \(Required\)Wrong Type Co/.test(errText) && /10State Code \(Optional\)Mismatch State/.test(errText),
    "preview lists each error by row and column (row 4 GSTIN, row 5 name, row 6 type, row 10 state code)");
  check(preview.includes("1 duplicate row merged") && /New\s*3/.test(preview) && /Already in the ERP\s*1/.test(preview) && /With errors\s*4/.test(preview), "preview: 3 new, 1 already existing, 4 with errors, 1 duplicate in the file merged");
  await page.screenshot({ path: path.join(OUT, "10-party-import-preview.png"), fullPage: true });
  await modal().locator("input[name=dupMode][value=update]").check();
  await modal().locator("#confirmImport").click();
  await page.locator("#importReport").waitFor();
  const reportOf = async () => Object.fromEntries(await Promise.all(["added", "updated", "skipped", "failed"].map(async (k) => [k, Number(await page.locator(`#importReport [data-count=${k}]`).textContent())])));
  let report = await reportOf();
  check(report.added === 3 && report.updated === 1 && report.skipped === 0 && report.failed === 4, `import report: ${JSON.stringify(report)}`);
  await closeAllModals();
  const bulk1 = await one("parties", "name", "Bulk Customer One");
  const delhi = await one("parties", "name", "Delhi Traders");
  const pyramid = await one("parties", "gstin", "27AACCP5074E3ZF");
  const bulk2 = await one("parties", "name", "Bulk Supplier Two");
  check(bulk1?.partyType === "Both" && bulk1.email === "accounts@bulk1.test", "same party as Customer and Supplier in the file → one record, type Both");
  check(delhi?.stateCode === "07" && delhi.state === "Delhi", "State Code 7 (Excel dropped the 0) is read as 07 Delhi");
  check(pyramid.partyType === "Both" && pyramid.phone === "9811111111" && pyramid.address1.startsWith("GAT NO") && pyramid.name === "Pyramid Technoplast Limited", "existing supplier updated: becomes Both, phone added, blank cells did not erase its address");
  check(bulk2?.partyType === "Supplier" && bulk2.paymentTerms === "Net 15" && bulk2.paymentTermsDays === 15 && bulk2.bankAccount === "484105000428", "\"Vendor\" → Supplier, \"Net 15\" → 15 days, long bank a/c number kept exact");
  check(!(await one("parties", "name", "Broken Party")) && !(await one("parties", "name", "Wrong Type Co")), "rows with errors are not imported");
  preview = await importParties(sampleFile);
  await modal().locator("#confirmImport").click();
  await page.locator("#importReport").waitFor();
  report = await reportOf();
  check(report.added === 0 && report.updated === 0 && report.skipped === 4 && report.failed === 4, `same file again with "Skip": ${JSON.stringify(report)} — no duplicates created`);
  await closeAllModals();
  // CSV in the template format (text cells keep leading zeros)
  const csvFile = path.join(OUT, "sample-party-import.csv");
  await writeFile(csvFile, `${header.map((h) => `"${h}"`).join(",")}\r\n${rowOf({ "Party Name (Required)": "CSV Chemicals LLP", "Party Type (Required)": "customer", "State Code (Optional)": "09", "PIN Code (Optional)": "201301", "Email (Optional)": "a@csv.test, b@csv.test" }).map((v) => `"${v}"`).join(",")}\r\n`);
  await importParties(csvFile);
  await modal().locator("#confirmImport").click();
  await page.locator("#importReport").waitFor();
  const csvParty = await one("parties", "name", "CSV Chemicals LLP");
  check(csvParty?.partyType === "Customer" && csvParty.stateCode === "09" && csvParty.state === "Uttar Pradesh", "CSV import works (type, state code 09 → Uttar Pradesh, two emails)");
  await closeAllModals();
  // Zoho Books export (same headers as the real Vendors export): duplicates by GSTIN merge, Inactive carried over
  const zoho = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(zoho, XLSX.utils.json_to_sheet([
    { "Contact ID": "Z1", "Display Name": "SAMPLE  CHEM PVT LTD", "Company Name": "SAMPLE CHEM PVT LTD", "EmailID": "", "MobilePhone": "", "Status": "Active", "Payment Terms": "60", "GST Identification Number (GSTIN)": "27AACCS1234C1ZV", "Billing Address": "GALA NO 9, UNIQUE INDL ESTATE", "Billing Street2": "OPP. TALKIES\r\nMULUND WEST", "Billing City": "MUMBAI", "Billing State": "Maharashtra", "Billing Code": "400080", "Vendor Bank Name": "" },
    { "Contact ID": "Z2", "Display Name": "Sample Chem-Pvt.Ltd.", "EmailID": "accounts@sample.test", "MobilePhone": "9800011111", "Status": "Active", "Payment Terms": "", "GST Identification Number (GSTIN)": "27AACCS1234C1ZV" },
    { "Contact ID": "Z3", "Display Name": "Old Supplier", "Status": "Inactive", "Payment Terms": "30", "GST Identification Number (GSTIN)": "" },
    { "Contact ID": "Z4", "Display Name": "Typo Traders", "Status": "Active", "GST Identification Number (GSTIN)": "27ALPPJ2647C222" }
  ]), "Vendors");
  const zohoFile = path.join(OUT, "zoho-vendors.xlsx");
  XLSX.writeFile(zoho, zohoFile);
  const zPreview = await importParties(zohoFile);
  check(zPreview.includes("Zoho Books export detected") && /New\s*2/.test(zPreview) && /With errors\s*1/.test(zPreview) && zPreview.includes("1 duplicate row merged") && zPreview.includes("GST Identification Number (GSTIN)"), "Zoho export recognised: duplicate GSTIN merged, bad GSTIN flagged by its Zoho column");
  await modal().locator("#confirmImport").click();
  await page.locator("#importReport").waitFor();
  await closeAllModals();
  const sample = await one("parties", "gstin", "27AACCS1234C1ZV");
  check(sample?.name === "SAMPLE CHEM PVT LTD" && sample.email === "accounts@sample.test" && sample.phone === "9800011111" && sample.paymentTerms === "60 Days" && sample.paymentTermsDays === 60 && sample.address2 === "OPP. TALKIES, MULUND WEST" && sample.partyType === "Supplier", "merged party keeps the most complete details from both rows (Zoho vendor → Supplier)");
  check((await one("parties", "name", "Old Supplier"))?.active === false, "Inactive status from Zoho carried over");

  /* ================= 3. Numbering: PH series and Monthly series ================= */
  console.log("\n3. PO series: PH (CCPL/PH/055/26-27) and Monthly (CCPL/OCT 26/01)");
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
  await setNumbering("POPH", "CCPL/PH/{SEQ}/{FY}", 55);

  /* ================= 4. PO for 10 KG apples: invoice → GRN → Kanta ================= */
  console.log("\n4. Apple PO: 5 + 5, Kanta 4.8 on the second");
  const applePo = await createPo("Pyramid", "PG-106", [{ item: "Apple", qty: 10, rate: 100 }]);
  check(applePo.poNo === "CCPL/PH/055/26-27", `PH series starts at the configured number: ${applePo.poNo}`);
  check((await readFile(applePo.pdf)).subarray(0, 5).toString() === "%PDF-", "PO PDF downloaded");
  let po = await one("purchaseOrders", "poNo", applePo.poNo);
  check(near(po.totals.subTotal, 1000) && near(po.totals.total, 1180) && po.totals.taxes.map((t) => t.kind).join() === "CGST,SGST", "PO totals: 1000 + CGST 90 + SGST 90 = 1180");

  const r1 = await receiptEntry({ poNo: applePo.poNo, invoiceNo: "INV-A1", qtys: { Apple: 5 }, transport: "SELF", amount: 4500 });
  check(r1.transportMode === "SELF" && r1.transportAmount === 4500 && r1.createdBy?.name === "Test Admin" && r1.createdAt, "inward records Self / CCPL Transport ₹4,500 with created by / date-time");
  po = await one("purchaseOrders", "poNo", applePo.poNo);
  check(near(po.totals.total, 1180), "transport amount is not added to the PO total");
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
  await modal().locator("select[name=vendorId]").selectOption(po.vendorId);
  await modal().locator("input[name=invoiceNo]").fill("INV-A2");
  await modal().locator(`#itemArea tr[data-po-no="${applePo.poNo}"]`, { hasText: "Apple" }).locator("input[data-line]").fill("1");
  await modal().locator("select[name=transportMode]").selectOption("PARTY");
  await modal().locator("#saveGe").click();
  check((await expectToast("error")).includes("already entered"), "same invoice cannot be entered twice");
  await closeAllModals();
  // PO detail + close
  await page.goto(`${BASE}/purchase-orders.html?open=${po.id}`);
  await modal().locator("#closePo").waitFor();
  const detailText = await modal().textContent();
  check(detailText.includes("INV-A1") && detailText.includes("INV-A2") && detailText.includes("Kanta Qty") && detailText.includes("-0.2"), "PO detail shows PO/GRN/Kanta/Short/Inward/Pending and every invoice");
  check(!/\bnull\b|NaN|undefined/.test(detailText), "PO detail shows no null / NaN values");
  const appleRow = await modal().locator('#poLines tr[data-line="Apple"] td').allTextContents();
  check(appleRow[1].startsWith("10") && appleRow[3] === "10" && appleRow[4] === "9.8" && appleRow[5] === "-0.2" && appleRow[6] === "0" && appleRow[7] === "9.8" && appleRow[9] === "0" && appleRow[10] === "0.2", `Apple row: PO 10 · GRN 10 · Kanta 9.8 · Short -0.2 · Rejected 0 · Accepted 9.8 · Pending 0.2 (${appleRow.slice(1, 11).join(" | ")})`);
  check(detailText.includes("Transport cost (internal, not on PO)₹4,500.00") && detailText.includes("Self / CCPL Transport"), "PO detail shows the transport cost internally");
  await modal().locator("#pdfPo").click();
  await page.locator("#pdfDownload:not([disabled])").waitFor({ timeout: 30000 });
  const [poAgain] = await Promise.all([page.waitForEvent("download"), page.click("#pdfDownload")]);
  const poAgainFile = path.join(OUT, `after-inward-${poAgain.suggestedFilename()}`);
  await poAgain.saveAs(poAgainFile);
  await page.keyboard.press("Escape");
  const poPdfText = pdfText(poAgainFile);
  check(poPdfText === null || (!poPdfText.includes("4,500") && !poPdfText.includes("Self / CCPL") && poPdfText.includes("1,180.00")), `PO PDF after inward has no transport amount and the same total${poPdfText === null ? " (text check skipped: python3 + pymupdf not installed)" : ""}`);
  await page.screenshot({ path: path.join(OUT, "02-po-detail-partial.png") });
  await modal().locator("#closePo").click();
  await page.locator("#confirmInput").fill("Vendor cannot supply the balance 0.2 KG");
  await page.click("#confirmOk");
  await expectToast();
  po = await one("purchaseOrders", "poNo", applePo.poNo);
  check(po.status === "CLOSED WITH BALANCE" && po.closeReason.includes("balance") && near(lineOf(po, "Apple").closedBalanceQty, 0.2) && po.closedBy?.name === "Test Admin" && po.closedAt, "PO closed with balance: 0.2 KG closed without receipt, reason / user / time recorded");
  await goto("inward.html"); await page.click("#newEntry");
  check(!(await modal().locator("select[name=vendorId]").textContent()).includes("Pyramid"), "closed PO no longer offered for inward");
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
  check(po.poNo === "CCPL/PH/057/26-27" && near(po.totals.total, 427160), `drum PO ${po.poNo} total Rs.427,160 (matches your sample PO)`);
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
  await setNumbering("POPH", "CCPL/PH/{SEQ}/{FY}", 56);
  const dupTest = await createPo("Pyramid", "PG-106", [{ item: "Apple", qty: 1, rate: 1 }]);
  check(dupTest.poNo === "CCPL/PH/059/26-27", `counter set back to 056 by mistake → system skips used numbers and issues ${dupTest.poNo}`);

  /* ================= 6b-2. Monthly series, month change, edit keeps number, simultaneous POs ================= */
  console.log("\n6b-2. Monthly PO series");
  const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const now = new Date();
  const monthLabel = (d) => `${MON[d.getMonth()]} ${String(d.getFullYear()).slice(-2)}`;
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const m1 = await createPo("Deepak", "PG-153", [{ item: "IPA", qty: 100, rate: 95 }], { series: "MONTHLY" });
  const m2 = await createPo("Gujarat Acids", "PG-153", [{ item: "IPA", qty: 50, rate: 95 }], { series: "MONTHLY" });
  check(m1.poNo === `CCPL/${monthLabel(now)}/01` && m2.poNo === `CCPL/${monthLabel(now)}/02`, `Monthly series: ${m1.poNo}, ${m2.poNo}`);
  const m3 = await createPo("Deepak", "PG-153", [{ item: "IPA", qty: 10, rate: 95 }], { series: "MONTHLY", date: iso(nextMonth) });
  check(m3.poNo === `CCPL/${monthLabel(nextMonth)}/01`, `PO dated next month restarts at 01: ${m3.poNo}`);
  const ph = await createPo("Pyramid", "PG-106", [{ item: "IPA", qty: 5, rate: 90 }]);
  check(ph.poNo === "CCPL/PH/060/26-27", `PH series has its own counter (monthly POs did not use PH numbers): ${ph.poNo}`);
  // Editing keeps the number and the series
  let mPo = await one("purchaseOrders", "poNo", m1.poNo);
  await page.goto(`${BASE}/purchase-orders.html?open=${mPo.id}`);
  await modal().locator("#editPo").click();
  let em = modal();
  check((await em.locator("input[readonly]").first().inputValue()).includes(m1.poNo) && await em.locator("select[name=series]").count() === 0, "edit form shows the fixed number; series cannot be changed");
  await em.locator("input[data-f=qty]").first().fill("120");
  await em.locator("input[name=date]").fill(iso(nextMonth));
  await em.locator("#savePo").click();
  await expectToast();
  mPo = (await adb.collection("purchaseOrders").doc(mPo.id).get()).data();
  check(mPo.poNo === m1.poNo && mPo.series === "MONTHLY" && mPo.lines[0].qty === 120, "edited PO (qty and date changed) keeps its number");
  // Two users create POs at the same moment
  const context2 = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 900 } });
  await routeCdn(context2);
  const page2 = await context2.newPage();
  await page2.goto(`${BASE}/index.html?emulator=1`);
  await page2.fill("input[name=email]", "manager@test.ccpl");
  await page2.fill("input[name=password]", "Manager#12345");
  await page2.click("#loginBtn");
  await page2.waitForURL(/dashboard\.html/, { timeout: 20000 });
  await page2.goto(`${BASE}/purchase-orders.html`); await page2.waitForSelector('body[data-loaded="1"]');
  await goto("purchase-orders.html");
  await page.click("#newPo"); await page2.click("#newPo");
  const fa = await fillPo(page, { vendor: "Pyramid", warehouse: "PG-106", lines: [{ item: "Apple", qty: 2, rate: 10 }] });
  const fb = await fillPo(page2, { vendor: "Deepak", warehouse: "PG-106", lines: [{ item: "Apple", qty: 3, rate: 10 }] });
  await page.waitForFunction(() => document.querySelector("[data-nextno]")?.textContent.includes("CCPL/PH/"), null, { timeout: 10000 }).catch(() => {});
  await page.screenshot({ path: path.join(OUT, "12-po-series.png") });
  await Promise.all([fa.locator("#savePo").click(), fb.locator("#savePo").click()]);
  const [ta, tb] = await Promise.all([page.locator(".toast.ok").first().textContent({ timeout: 20000 }), page2.locator(".toast.ok").first().textContent({ timeout: 20000 })]);
  const sim = [ta, tb].map((t) => t.replace(" saved.", "")).sort();
  check(sim[0] === "CCPL/PH/061/26-27" && sim[1] === "CCPL/PH/062/26-27", `two POs saved at the same moment get different numbers: ${sim.join(", ")}`);
  await context2.close();
  await page.evaluate(() => document.querySelectorAll(".toast").forEach((x) => x.remove()));
  await closeAllModals();
  const allNos = (await adb.collection("purchaseOrders").get()).docs.map((d) => d.data().poNo);
  check(new Set(allNos).size === allNos.length, `no duplicate PO numbers across ${allNos.length} POs`);

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

  /* ================= 6d. Vehicle rejected + payment hold ================= */
  console.log("\n6d. Vehicle rejected inward / payment hold");
  const rjPo = await createPo("Gujarat Acids", "PG-153", [{ item: "Methanol", qty: 20000, rate: 30 }]);
  const stockBefore = await stockOf("PG-153", "Methanol");
  const rj1 = await receiptEntry({ poNo: rjPo.poNo, invoiceNo: "GA-INV-1", qtys: { Methanol: 10000 }, transport: "PARTY", rejectReason: "UV absorbance at 250 nm failed" });
  po = await one("purchaseOrders", "poNo", rjPo.poNo);
  check(rj1.stage === "REJECTED" && rj1.rejection.reason.includes("UV") && rj1.rejection.by.name === "Test Admin" && rj1.rejection.at && rj1.paymentHold.active === true, "vehicle recorded as Vehicle Rejected with reason, user and time; payment hold on");
  check(po.status === "OPEN" && lineOf(po, "Methanol").invoicedQty === 0 && (await stockOf("PG-153", "Methanol")) === stockBefore, "rejected inward: zero received on the PO, PO stays OPEN, no stock added");
  // The same invoice can come back on a new vehicle (old entry stays on hold)
  const rj2 = await receiptEntry({ poNo: rjPo.poNo, invoiceNo: "GA-INV-1", qtys: { Methanol: 10000 }, transport: "SELF", amount: 12000, confirm: true });
  await grnStep(rj2);
  await kantaStep(rj2, { Methanol: 9990 });
  // A third vehicle is rejected at the Kanta stage (after GRN)
  const rj3 = await receiptEntry({ poNo: rjPo.poNo, invoiceNo: "GA-INV-2", qtys: { Methanol: 5000 } });
  await grnStep(rj3);
  po = await one("purchaseOrders", "poNo", rjPo.poNo);
  check(po.status === "AWAITING KANTA" && lineOf(po, "Methanol").pendingKantaQty === 5000, "GRN done for the third vehicle → AWAITING KANTA");
  await goto("inward.html#kanta"); await page.click('[data-tab="KANTA PENDING"]');
  await page.locator(`[data-kanta="${rj3.id}"]`).click();
  await modal().locator("#rejRec").click();
  await page.locator("#confirmInput").fill("Moisture above limit — sent back");
  await page.click("#confirmOk");
  await expectToast("info");
  po = await one("purchaseOrders", "poNo", rjPo.poNo);
  const methLine = lineOf(po, "Methanol");
  check(po.status === "PARTIALLY INWARDED" && methLine.pendingKantaQty === 0 && methLine.grnQty === 10000 && methLine.receivedQty === 9990 && round(methLine.qty - methLine.receivedQty) === 10010, "rejected at Kanta: GRN reversed, only the accepted 9,990 counts, 10,010 KG still pending");
  check(methLine.rejectedQty === 15000, `PO keeps the rejected quantity separately: ${methLine.rejectedQty} (10,000 at gate + 5,000 at Kanta)`);
  check((await stockOf("PG-153", "Methanol")) === stockBefore + 9990, "stock: only the accepted vehicle (9,990 KG) added");
  const held = await adb.collection("receipts").doc(rj3.id).get().then((d) => d.data());
  const accepted = await adb.collection("receipts").doc(rj2.id).get().then((d) => d.data());
  check(held.stage === "REJECTED" && held.paymentHold.active && accepted.stage === "COMPLETED" && !accepted.paymentHold, "hold applies only to the rejected receipts, not to the accepted receipt on the same PO");
  // Reject after Kanta (stock reversed) — manager/admin only
  const rj4 = await receiptEntry({ poNo: rjPo.poNo, invoiceNo: "GA-INV-3", qtys: { Methanol: 2000 } });
  await grnStep(rj4); await kantaStep(rj4);
  check((await stockOf("PG-153", "Methanol")) === stockBefore + 11990, "fourth vehicle inwarded (+2,000)");
  await goto("inward.html"); await page.click('[data-tab="COMPLETED"]');
  await page.locator(`[data-view="${rj4.id}"]`).first().click();
  await modal().locator("#rejRec").click();
  await page.locator("#confirmInput").fill("Lab test failed after unloading — returned");
  await page.click("#confirmOk");
  await expectToast("info");
  po = await one("purchaseOrders", "poNo", rjPo.poNo);
  check((await stockOf("PG-153", "Methanol")) === stockBefore + 9990 && lineOf(po, "Methanol").receivedQty === 9990, "rejected after Kanta: 2,000 KG taken back out of stock and off the PO");
  check(lineOf(po, "Methanol").rejectedQty === 17000, "rejected total on the PO now 17,000 (incl. 2,000 rejected after Kanta)");
  // Inward history & accounts view
  await goto("inward.html"); await page.click('[data-tab="HOLD"]');
  const holdText = await page.textContent("#rows");
  check(holdText.includes("Payment Hold — Rejected Inward") && holdText.includes("GA-INV-1") && holdText.includes("GA-INV-2") && holdText.includes("VEHICLE REJECTED"), "Payment hold tab shows the rejected receipts with Payment Hold — Rejected Inward");
  await page.click('[data-tab="ALL"]');
  const allText = await page.textContent("#rows");
  check(allText.includes("Self / CCPL Transport") && allText.includes("₹12,000.00") && allText.includes("Party Transport") && allText.includes("Payable as per Kanta"), "inward history shows transport arrangement, amount and accounts status");
  await page.screenshot({ path: path.join(OUT, "11-inward-rejected-hold.png"), fullPage: true });
  await page.goto(`${BASE}/purchase-orders.html?open=${po.id}`);
  await modal().locator("#pdfPo").waitFor();
  const rjDetail = await modal().textContent();
  check(rjDetail.includes("Payment Hold — Rejected Inward") && rjDetail.includes("GA-INV-1") && rjDetail.includes("₹12,000.00"), "PO detail shows the rejected receipts on hold and transport cost");
  await closeAllModals();
  // Edit transport later (bill arrives afterwards)
  await goto("inward.html"); await page.click('[data-tab="COMPLETED"]');
  await page.locator(`[data-view="${rj2.id}"]`).first().click();
  await modal().locator("#trRec").click();
  await modal().locator("input[name=transportAmount]").fill("12500");
  await modal().locator("input[name=transporter]").fill("Shree Roadlines");
  await modal().locator("#saveT").click();
  await expectToast();
  const rj2b = await adb.collection("receipts").doc(rj2.id).get().then((d) => d.data());
  check(rj2b.transportAmount === 12500 && rj2b.transporter === "Shree Roadlines" && rj2b.transportUpdatedBy?.name === "Test Admin", "transport amount corrected later; who changed it is recorded");
  // Resolve hold (manager)
  await logout();
  await login("manager@test.ccpl", "Manager#12345");
  await page.waitForURL(/dashboard\.html/);
  await goto("inward.html"); await page.click('[data-tab="HOLD"]');
  await page.locator(`[data-view="${rj1.id}"]`).first().click();
  await modal().locator("#resolveHold").click();
  await page.locator("#confirmInput").fill("Vehicle returned; vendor will not bill this invoice");
  await page.click("#confirmOk");
  await expectToast();
  const rj1b = await adb.collection("receipts").doc(rj1.id).get().then((d) => d.data());
  check(rj1b.stage === "REJECTED" && rj1b.paymentHold.active === false && rj1b.paymentHold.resolvedBy.name === "Test Manager" && rj1b.paymentHold.resolution.includes("returned"), "manager resolves the payment hold with a note; receipt stays rejected with zero quantity");
  await logout();
  await login("admin@test.ccpl", "Admin#12345");
  await page.waitForURL(/dashboard\.html/);

  /* ================= 6e. One supplier bill across two POs + Close with Balance (190 kg example) ================= */
  console.log("\n6e. One bill → two POs (100 + 90 kg), close the second with 10 kg balance, reopen");
  await addMaster("items.html", { name: "Toluene", hsn: "29023000", gstRate: 18 }, { category: "Raw Material", unit: "KG" });
  await addMaster("items.html", { name: "Acetone", hsn: "29141100", gstRate: 18 }, { category: "Raw Material", unit: "KG" });
  const tA = await createPo("Shree Solvents", "PG-153", [{ item: "Toluene", qty: 100, rate: 80 }]);
  const tB = await createPo("Shree Solvents", "PG-153", [{ item: "Toluene", qty: 100, rate: 80 }]);
  check((await one("purchaseOrders", "poNo", tA.poNo)).paymentTerms === "Advance", "PO takes the party's text payment terms (Advance)");
  const tolBefore = await stockOf("PG-153", "Toluene");
  await goto("inward.html"); await page.click("#newEntry");
  m = modal();
  const shree = await one("parties", "name", "Shree Solvents LLP");
  await m.locator("select[name=vendorId]").selectOption(shree.id);
  check(await m.locator(`#itemArea tr[data-po-no="${tA.poNo}"]`).count() === 1 && await m.locator(`#itemArea tr[data-po-no="${tB.poNo}"]`).count() === 1, "inward form lists both open POs of the supplier");
  await m.locator('[data-total]').first().fill("190");
  const allocA = await m.locator(`#itemArea tr[data-po-no="${tA.poNo}"] input[data-line]`).inputValue();
  const allocB = await m.locator(`#itemArea tr[data-po-no="${tB.poNo}"] input[data-line]`).inputValue();
  check(allocA === "100" && allocB === "90", `total 190 kg on the bill auto-allocated oldest PO first: ${allocA} + ${allocB}`);
  await m.locator("input[name=invoiceNo]").fill("SS-INV-190");
  await m.locator("select[name=transportMode]").selectOption("PARTY");
  await page.screenshot({ path: path.join(OUT, "15-one-bill-two-pos.png") });
  await m.locator("#saveGe").click();
  await expectToast();
  const bill = await one("receipts", "invoiceNo", "SS-INV-190");
  check(bill.lines.length === 2 && bill.poIds.length === 2 && bill.lines.map((l) => `${l.poNo}:${l.invoiceQty}`).join() === `${tA.poNo}:100,${tB.poNo}:90`, "one receipt, two lines, each linked to its own PO");
  await grnStep(bill);
  await kantaStep(bill);
  let pA = await one("purchaseOrders", "poNo", tA.poNo);
  let pB = await one("purchaseOrders", "poNo", tB.poNo);
  check(pA.status === "COMPLETED" && pA.lines[0].receivedQty === 100 && pB.status === "PARTIALLY INWARDED" && pB.lines[0].receivedQty === 90, "PO 1: 100/100 COMPLETED · PO 2: 90/100 PARTIALLY INWARDED");
  check((await stockOf("PG-153", "Toluene")) === tolBefore + 190, "stock: only the actual 190 kg added");
  await page.goto(`${BASE}/purchase-orders.html?open=${pB.id}`);
  await modal().locator("#closePo").waitFor();
  check((await modal().textContent()).includes(`same bill also on ${tA.poNo}`), "PO detail shows the bill is shared with the other PO");
  await modal().locator("#closePo").click();
  await page.locator("#confirmInput").fill("Supplier will not send the balance 10 kg");
  await page.click("#confirmOk");
  await expectToast();
  pB = await one("purchaseOrders", "poNo", tB.poNo);
  check(pB.status === "CLOSED WITH BALANCE" && pB.lines[0].qty === 100 && pB.lines[0].receivedQty === 90 && pB.lines[0].closedBalanceQty === 10 && pB.closedBy.name === "Test Admin" && pB.closeReason.includes("10 kg") && pB.closeHistory?.[0]?.balances?.[0]?.qty === 10,
    "PO 2 Closed with Balance: ordered 100 · received 90 · closed balance 10 · reason, user, time and history saved");
  await page.goto(`${BASE}/purchase-orders.html?open=${pB.id}`);
  await modal().locator("#reopenPo").waitFor();
  const closedRow = await modal().locator('#poLines tr[data-line="Toluene"] td').allTextContents();
  check(closedRow[9] === "10" && closedRow[10] === "0" && (await modal().textContent()).includes("Closed with Balance"), `closed balance 10 shown separately, pending 0 (${closedRow.slice(1, 11).join(" | ")})`);
  await page.screenshot({ path: path.join(OUT, "16-po-closed-with-balance.png") });
  await closeAllModals();
  await goto("inward.html"); await page.click("#newEntry");
  check(!(await modal().locator("select[name=vendorId]").textContent()).includes("Shree Solvents"), "closed PO (and completed PO) accept no further inward");
  await closeAllModals();
  check((await stockOf("PG-153", "Toluene")) === tolBefore + 190, "closing did not change stock");
  await page.goto(`${BASE}/purchase-orders.html?open=${pB.id}`);
  await modal().locator("#reopenPo").click();
  await page.locator("#confirmInput").fill("Supplier can send the balance after all");
  await page.click("#confirmOk");
  await expectToast();
  pB = await one("purchaseOrders", "poNo", tB.poNo);
  check(pB.status === "PARTIALLY INWARDED" && pB.lines[0].closedBalanceQty === 0 && pB.closeHistory.length === 2 && (await stockOf("PG-153", "Toluene")) === tolBefore + 190, "reopen: 10 kg pending again, stock unchanged, close + reopen kept in history");
  await goto("inward.html"); await page.click("#newEntry");
  check((await modal().locator("select[name=vendorId]").textContent()).includes("Shree Solvents"), "reopened PO accepts inward again");
  await closeAllModals();

  /* ================= 6f. Partial rejection at Kanta ================= */
  console.log("\n6f. Partial rejection");
  const acPo = await createPo("Kalyan Polymers", "PG-153", [{ item: "Acetone", qty: 1000, rate: 70 }]);
  check((await one("purchaseOrders", "poNo", acPo.poNo)).paymentTerms === "Against delivery", "PO terms \"Against delivery\" from a Both-type party");
  const acBefore = await stockOf("PG-153", "Acetone");
  const ac1 = await receiptEntry({ poNo: acPo.poNo, invoiceNo: "KP-77", qtys: { Acetone: 1000 } });
  await grnStep(ac1);
  await goto("inward.html#kanta"); await page.click('[data-tab="KANTA PENDING"]');
  await page.locator(`[data-kanta="${ac1.id}"]`).click();
  m = modal();
  await m.locator("input[name=k0]").fill("995");
  await m.locator("input[name=rj0]").fill("45");
  await m.locator("#saveK").click();
  check((await expectToast("error")).includes("reason"), "rejected quantity needs a reason");
  await m.locator("input[name=rejectReason]").fill("9 drums failed moisture test");
  await page.screenshot({ path: path.join(OUT, "17-kanta-partial-rejection.png") });
  await m.locator("#saveK").click();
  await expectToast();
  const ac1b = await adb.collection("receipts").doc(ac1.id).get().then((d) => d.data());
  const acLine = ac1b.lines[0];
  check(acLine.kantaQty === 995 && acLine.rejectedQty === 45 && acLine.acceptedQty === 950 && acLine.varianceQty === -5 && acLine.payableQty === 950 && ac1b.payableValue === 66500, "receipt: Kanta 995 · short -5 · rejected 45 · accepted 950 · payable ₹66,500");
  check(ac1b.paymentHold?.active === true && ac1b.paymentHold.scope === "PARTIAL" && ac1b.partialRejection.reason.includes("moisture"), "payment hold on the rejected portion, with reason");
  check((await stockOf("PG-153", "Acetone")) === acBefore + 950, "stock: only the accepted 950 kg added");
  const acP = await one("purchaseOrders", "poNo", acPo.poNo);
  check(acP.lines[0].receivedQty === 950 && acP.lines[0].rejectedQty === 45 && acP.status === "PARTIALLY INWARDED", "PO: accepted 950, rejected 45, 50 still pending");
  await goto("inward.html"); await page.click('[data-tab="HOLD"]');
  check((await page.textContent("#rows")).includes("Pay accepted qty only · Payment Hold — Rejected Inward on rejected qty"), "inward list shows payment hold against the rejected quantity only");

  /* ================= 6g. Service PO ================= */
  console.log("\n6g. Service PO (transportation)");
  const svc = await createPo("Gujarat Acids", "PG-106", [{ item: "Transportation Charges", qty: 12, rate: 3500 }], { poType: "SERVICE" });
  let sPo = await one("purchaseOrders", "poNo", svc.poNo);
  check(sPo.poType === "SERVICE" && sPo.status === "OPEN" && near(sPo.totals.total, 44100), `Service PO ${svc.poNo}: 12 trips × 3,500 + GST 5% = ₹44,100`);
  const svcPdf = pdfText(svc.pdf);
  check(svcPdf === null || svcPdf.replace(/\s+/g, " ").includes("SERVICE PURCHASE ORDER"), "PDF titled Service Purchase Order");
  await goto("inward.html"); await page.click("#newEntry");
  await modal().locator("select[name=vendorId]").selectOption(sPo.vendorId).catch(() => {});
  check(await modal().locator(`#itemArea tr[data-po-no="${svc.poNo}"]`).count() === 0, "Service PO is never offered for material inward / GRN");
  await closeAllModals();
  await page.goto(`${BASE}/purchase-orders.html?open=${sPo.id}`);
  await modal().locator("#serviceDone").click();
  const sm = modal();
  await sm.locator("input[name=billNo]").fill("GA-TR-0045");
  await sm.locator("input[name=billAmount]").fill("44100");
  await sm.locator("input[name=note]").fill("12 trips completed, confirmed by stores");
  await sm.locator("#saveSvc").click();
  await expectToast();
  sPo = await one("purchaseOrders", "poNo", svc.poNo);
  check(sPo.status === "SERVICE COMPLETED" && sPo.serviceCompletion.billNo === "GA-TR-0045" && sPo.serviceCompletion.by.name === "Test Admin", "service marked completed with the bill → PO closed (no inward needed)");

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
  check(await m.locator("input[name=refNo]").inputValue() === "GA/PO/77" && await m.locator("input[name=paymentTerms]").inputValue() === "45 Days"
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

  /* ================= 10c. SO ⇄ PI document type, all parties ================= */
  console.log("\n10c. Sales Order / Proforma Invoice document type; suppliers usable for sales");
  await goto("sales-orders.html"); await page.click("#newDoc");
  m = modal();
  const soParties = await m.locator("select[name=customerId]").textContent();
  check(soParties.includes("Bulk Supplier Two") && soParties.includes("Pyramid Technoplast Limited") && soParties.includes("Deepak Fertilisers Ltd"), "SO party list includes suppliers as well as customers");
  check((await m.locator("select[name=docType]").textContent()).includes("Proforma Invoice (PI)"), "SO form has a Document Type dropdown (SO / PI)");
  await selectContaining(m.locator("select[name=customerId]"), "Pyramid Technoplast");
  await m.locator("input[name=customerPoNo]").fill("PTL/PO/991");
  await m.locator("select[name=warehouse]").selectOption("PG-106");
  await selectContaining(m.locator("select[data-f=itemId]").first(), "IPA");
  await m.locator("input[data-f=qty]").first().fill("40");
  await m.locator("input[data-f=rate]").first().fill("110");
  await page.screenshot({ path: path.join(OUT, "14-so-doc-type.png") });
  await m.locator("select[name=docType]").selectOption("PI");
  await page.waitForURL(/proforma\.html/);
  m = modal();
  await m.locator("#savePi").waitFor();
  check(await m.locator("select[name=customerId] option:checked").textContent().then((t) => t.includes("Pyramid")) && await m.locator("input[name=refNo]").inputValue() === "PTL/PO/991"
    && await m.locator("input[data-f=qty]").first().inputValue() === "40" && (await m.locator("input[name=dispatchFrom]").inputValue()).includes("PATALGANGA"), "switching to PI keeps party, reference, items and dispatch-from");
  await m.locator("#savePi").click();
  await expectToast();
  const supplierPi = await one("proformaInvoices", "refNo", "PTL/PO/991");
  check(supplierPi?.customer.name === "Pyramid Technoplast Limited" && near(supplierPi.totals.total, 5192), `PI ${supplierPi?.piNo} raised to a party that is also our supplier (₹5,192)`);
  await goto("proforma.html"); await page.click("#newDoc");
  m = modal();
  await selectContaining(m.locator("select[name=customerId]"), "Bulk Supplier Two");
  await m.locator("input[name=refNo]").fill("BS2/77");
  await selectContaining(m.locator("select[data-f=itemId]").first(), "Apple");
  await m.locator("input[data-f=qty]").first().fill("3");
  await m.locator("input[data-f=rate]").first().fill("100");
  await m.locator("select[name=docType]").selectOption("SO");
  await page.waitForURL(/sales-orders\.html/);
  m = modal();
  await m.locator("#saveS").waitFor();
  check(await m.locator("input[name=customerPoNo]").inputValue() === "BS2/77" && await m.locator("input[data-f=qty]").first().inputValue() === "3", "switching PI → SO keeps party, reference and items");
  await m.locator("#saveS").click();
  await expectToast();
  check((await one("salesOrders", "customerPoNo", "BS2/77"))?.customer.name === "Bulk Supplier Two", "SO saved for a supplier-type party (no duplicate party needed)");

  /* ================= 10d. Warehouses: create, rename, details ================= */
  console.log("\n10d. Warehouses");
  const talojaStock = await stockOf("TALOJA", "Hydrochloric Acid 33%");
  await logout();
  await login("manager@test.ccpl", "Manager#12345");
  await page.waitForURL(/dashboard\.html/);
  await goto("warehouses.html");
  await page.click("#addWh");
  m = modal();
  await m.locator("input[name=name]").fill("Kharghar Godown");
  await m.locator("input[name=code]").fill("KHG");
  await m.locator("textarea[name=addressLines]").fill("Plot 12, Sector 7\nKharghar, Navi Mumbai 410210");
  await m.locator("input[name=contactPerson]").fill("Mr. Patil");
  await m.locator("input[name=phone]").fill("98200 11111");
  await m.locator("input[name=note]").fill("Gate closes at 8 pm");
  await m.locator("#saveWh").click();
  await expectToast();
  await page.locator('[data-edit="TALOJA"]').click();
  m = modal();
  await m.locator("input[name=name]").fill("Taloja Warehouse");
  await m.locator("input[name=contactPerson]").fill("Mr. Shinde");
  await m.locator("#saveWh").click();
  await expectToast();
  const tal = (await adb.collection("warehouses").doc("TALOJA").get()).data();
  check((await adb.collection("warehouses").doc("KHG").get()).data()?.contactPerson === "Mr. Patil" && tal.name === "Taloja Warehouse", "manager created Kharghar Godown and renamed Taloja Unit → Taloja Warehouse");
  check((await stockOf("TALOJA", "Hydrochloric Acid 33%")) === talojaStock && talojaStock > 0, "renamed warehouse keeps its stock");
  await page.locator('[data-view="KHG"]').click();
  const whView = await modal().textContent();
  check(whView.includes("Kharghar, Navi Mumbai") && whView.includes("Mr. Patil") && whView.includes("98200 11111") && whView.includes("Gate closes at 8 pm"), "View details shows address, contact person, phone and note");
  await page.screenshot({ path: path.join(OUT, "13-warehouse-details.png") });
  await closeAllModals();
  await goto("inventory.html");
  check((await page.textContent("#page")).includes("Taloja Warehouse"), "stock page shows the new name");
  await goto("transfers.html"); await page.click('[data-tab="ALL"]').catch(() => {});
  check((await page.textContent("#page")).includes("Taloja Warehouse"), "earlier transfer history shows the renamed warehouse");
  const renameLog = await one("activity", "action", "RENAME");
  check(renameLog?.summary.includes("Taloja Unit → Taloja Warehouse"), "rename recorded in the activity log");
  await logout();
  await login("admin@test.ccpl", "Admin#12345");
  await page.waitForURL(/dashboard\.html/);

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
  check(exText.includes("Invoice qty not matching payable") && exText.includes("Stock manually adjusted") && exText.includes("Opening / existing stock"), "Exceptions lists invoice≠payable and manual stock entries");
  check(exText.includes("Payment Hold — Rejected Inward") && exText.includes("GA-INV-2") && !exText.includes("Vehicle returned; vendor will not bill"), "Exceptions lists receipts on payment hold (resolved holds drop off)");
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
  await goto("warehouses.html");
  check(await page.locator("#addWh").count() === 0 && await page.locator("[data-edit]").count() === 0 && await page.locator("[data-view]").count() > 0, "operator can view warehouse details but cannot create or rename");
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
    const someOpen = await fs.getDocs(fs.query(fs.collection(db, "purchaseOrders"), fs.where("status", "==", "PARTIALLY INWARDED"), fs.limit(1)));
    await tryIt("closePoWithBalance", () => fs.updateDoc(someOpen.docs[0].ref, { status: "CLOSED WITH BALANCE" }));
    await tryIt("createWarehouse", () => fs.setDoc(fs.doc(db, "warehouses", "HACK"), { name: "Hack" }));
    const held = await fs.getDocs(fs.query(fs.collection(db, "receipts"), fs.where("invoiceNo", "==", "GA-INV-2")));
    await tryIt("liftPaymentHold", () => fs.updateDoc(held.docs[0].ref, { "paymentHold.active": false }));
    await tryIt("unrejectReceipt", () => fs.updateDoc(held.docs[0].ref, { stage: "GRN PENDING" }));
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
