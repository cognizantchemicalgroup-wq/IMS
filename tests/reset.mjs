// Browser test of the go-live reset when Firebase Storage is unavailable (quota exceeded on the free plan).
// Run: CHROMIUM_PATH=... npx firebase emulators:exec --project demo-ccpl "node tests/reset.mjs"
import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NM = path.join(ROOT, "node_modules");
const PORT = 5501; const BASE = `http://localhost:${PORT}`;
process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= "127.0.0.1:9099";
initializeApp({ projectId: "demo-ccpl" });
const adb = getFirestore();
const SUPER = "rupesh.mudliar@cognizantchemical.com";
const u = await getAuth().createUser({ email: SUPER, password: "Rupesh#12345" });
await adb.doc(`users/${u.uid}`).set({ email: SUPER, role: "admin", active: true, name: "Rupesh" });
await adb.doc("settings/company").set({ name: "CCPL" });
await adb.doc("warehouses/PG-106").set({ name: "PG-106" });
for (let i = 1; i <= 5; i++) await adb.doc(`items/I${i}`).set({ name: `Item ${i}`, code: `C${i}`, unit: "kg" });
for (let i = 1; i <= 24; i++) await adb.doc(`purchaseOrders/P${i}`).set({ poNo: `PO/${i}`, status: "OPEN", lines: [] });
for (let i = 1; i <= 27; i++) await adb.doc(`receipts/R${i}`).set({ stage: "COMPLETED", lines: [] });
for (const c of ["outwards", "adjustments", "quotations", "salesOrders", "proformaInvoices", "inventory", "stockLedger", "activity", "parties", "docNumbers"]) await adb.doc(`${c}/X1`).set({ x: 1, name: "x" });
await adb.doc("counters/GRN_26-27").set({ next: 28, type: "GRN", fy: "26-27" });

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };
const server = http.createServer(async (req, res) => {
  const file = path.join(ROOT, decodeURIComponent(new URL(req.url, BASE).pathname));
  if (!file.startsWith(ROOT) || !existsSync(file) || file.endsWith(".php")) { res.writeHead(500, { "Content-Type": "text/html" }); res.end("no php"); return; }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" }); res.end(await readFile(file));
}).listen(PORT);
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 412, height: 900 } });
await ctx.route(/^https:\/\/www\.gstatic\.com\/firebasejs\/10\.12\.2\/(.+)$/, (r) => r.fulfill({ path: path.join(NM, "firebase", r.request().url().split("/").pop()), contentType: "text/javascript" }));
await ctx.route(/fonts\.googleapis\.com|fonts\.gstatic\.com|font-awesome/, (r) => r.fulfill({ body: "", contentType: "text/css" }));
// Storage behaves like the live bucket: quota exceeded
await ctx.route(/127\.0\.0\.1:9199\//, (r) => r.fulfill({ status: 402, contentType: "application/json", body: JSON.stringify({ error: { code: 402, message: "Quota for bucket exceeded" } }) }));
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("pageerror", e.message));
await page.goto(`${BASE}/index.html?emulator=1`);
await page.fill("input[name=email]", SUPER); await page.fill("input[name=password]", "Rupesh#12345"); await page.click("#loginBtn");
await page.waitForURL(/dashboard/);
await page.goto(`${BASE}/data-admin.html`); await page.waitForSelector('body[data-loaded="1"]');
await page.fill("#setPwForm input[name=pw]", "resetpw123"); await page.fill("#setPwForm input[name=pw2]", "resetpw123");
await page.click("#setPwForm button[type=submit]"); await page.waitForSelector("#changePw");
// Download backup alone works with storage down
const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#backupBtn")]);
await page.waitForFunction(() => /Backup complete|Backup failed/.test(document.querySelector("#runTitle")?.textContent || ""), null, { timeout: 30000 });
console.log("manual backup:", (await page.textContent("#runTitle")).trim(), "| file:", dl.suggestedFilename());
await page.click("#resetBtn");
const m = page.locator(".modal-backdrop").last();
await m.locator("input[name=approve]").waitFor();
console.log("storage notice shown:", await m.locator("input[name=skipFiles]").count() === 1);
await m.locator("input[name=approve]").check();
await m.locator("input[name=confirmWord]").fill("reset");
await m.locator("input[name=pw]").fill("resetpw123");
await m.locator("#rsGo").click();
console.log("blocked without skip tick:", (await page.locator(".toast").last().textContent()).trim());
await m.locator("input[name=skipFiles]").check();
const [dl2] = await Promise.all([page.waitForEvent("download"), m.locator("#rsGo").click()]);
await page.waitForFunction(() => /complete|Stopped/.test(document.querySelector("#runTitle")?.textContent || ""), null, { timeout: 120000 });
console.log("reset:", (await page.textContent("#runTitle")).trim(), "| backup file:", dl2.suggestedFilename());
console.log((await page.locator("#runLog").innerText()).split("\n").map((l) => "   " + l).join("\n"));
const counts = {};
for (const c of ["purchaseOrders", "receipts", "outwards", "adjustments", "quotations", "salesOrders", "proformaInvoices", "inventory", "stockLedger", "parties", "docNumbers", "poNumbers", "items", "warehouses", "users"]) counts[c] = (await adb.collection(c).get()).size;
console.log("after:", JSON.stringify(counts), "| paused:", (await adb.doc("settings/maintenance").get()).data()?.paused, "| GRN next:", (await adb.doc("counters/GRN_26-27").get()).data().next);
const ok = counts.items === 5 && counts.purchaseOrders === 0 && counts.receipts === 0 && counts.parties === 0 && counts.inventory === 0 && counts.users === 1 && counts.warehouses === 1;
console.log(ok ? "RESET TEST PASSED" : "RESET TEST FAILED");
await browser.close(); server.close(); process.exit(ok ? 0 : 1);
