// Shared runtime for every ERP page: auth guard, layout shell, formatting,
// document numbering, stock movements and the activity (audit) log.
import { auth, db, USING_EMULATOR } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection, doc, getDoc, getDocs, query, orderBy, serverTimestamp, Timestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export { db, auth };

/* ------------------------------------------------------------------ */
/* Defaults (used until an admin saves Settings)                       */
/* ------------------------------------------------------------------ */
export const DEFAULT_COMPANY = {
  name: "Cognizant Chemical Pvt. Ltd.",
  addressLines: ["Office No. 120 DISMA Complex,", "Plot No 246, Kalamboli Panvel,", "Raigad Maharashtra 410218 India"],
  state: "Maharashtra",
  stateCode: "27",
  gstin: "27AAGCC5829E1ZN",
  pan: "AAGCC5829E",
  email: "admin@cognizantchemical.com",
  phone: "9619662255",
  website: "",
  bankName: "",
  bankAccount: "",
  bankIfsc: "",
  bankBranch: "",
  poTerms: [
    "Please quote our Purchase Order number on all invoices, delivery challans and correspondence.",
    "Material must conform to the agreed specification; a Certificate of Analysis (COA) must accompany every consignment.",
    "Quantity will be accepted as per our weighbridge (kanta) / physical count at the delivery location.",
    "Material found short, damaged or not as per specification is liable to be rejected and returned at the supplier's cost.",
    "Payment will be released as per the payment terms stated above from the date of receipt of material and a correct GST invoice.",
    "Subject to Raigad jurisdiction."
  ].join("\n"),
  quoteTerms: [
    "Prices are ex-works unless stated otherwise.",
    "GST extra as applicable.",
    "Delivery: as per mutually agreed schedule after receipt of confirmed order.",
    "Subject to Raigad jurisdiction."
  ].join("\n"),
  soTerms: "Subject to Raigad jurisdiction.",
  poTolerancePct: 0.5
};

export const DEFAULT_WAREHOUSES = [
  { code: "PG-106", name: "PG 106", docCode: "PG", addressLines: ["PLOT NO. E-106, NEAR CHAWANE VILLAGE,", "MIDC, ADDITIONAL PATALGANGA INDUSTRIAL AREA", "PATALGANGA,", "RAIGAD Maharashtra 410220 India"], destination: "PATALGANGA", active: true },
  { code: "PG-153", name: "PG-153", docCode: "PG", addressLines: ["PLOT NO. E-153, NEAR CHAWANE VILLAGE,", "MIDC, ADDITIONAL PATALGANGA INDUSTRIAL AREA", "PATALGANGA,", "RAIGAD Maharashtra 410220 India"], destination: "PATALGANGA", active: true },
  { code: "BREEZE", name: "Breeze", docCode: "BR", addressLines: [], destination: "", active: true },
  { code: "TALOJA", name: "Taloja Unit", docCode: "TL", addressLines: [], destination: "TALOJA", active: true }
];

export const ITEM_CATEGORIES = ["Raw Material", "Finished Goods", "Packaging", "Trading", "Consumable"];
export const UNITS = ["KG", "MT", "LTR", "KL", "NOS", "DRUM", "CARBOY", "BAG", "BOX", "SET"];

export const NUMBER_FORMATS = {
  PO: "CCPL/{SITE}/{SEQ}/{FY}",
  QT: "CCPL/QT/{SEQ}/{FY}",
  SO: "CCPL/SO/{SEQ}/{FY}",
  GE: "GE/{SEQ}/{FY}",
  GRN: "GRN/{SEQ}/{FY}",
  DC: "CCPL/DC/{SEQ}/{FY}",
  ST: "ST/{SEQ}/{FY}",
  ADJ: "ADJ/{SEQ}/{FY}"
};

/* ------------------------------------------------------------------ */
/* Roles                                                               */
/* ------------------------------------------------------------------ */
// admin    – everything, including settings, users, deletes and reversals
// manager  – create/approve POs, quotations, SOs, close orders + all operations
// operator – inward, kanta, GRN, outward, transfers (no commercial documents)
// viewer   – read only
const PERMISSIONS = {
  admin: ["*"],
  manager: ["commercial", "operations", "masters", "close"],
  operator: ["operations", "masters"],
  viewer: []
};
export function can(permission) {
  const role = state.profile?.role || "viewer";
  const perms = PERMISSIONS[role] || [];
  return perms.includes("*") || perms.includes(permission);
}
export const isAdmin = () => state.profile?.role === "admin";

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */
export function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}
export const round = (value, dp = 3) => Math.round((Number(value) || 0) * 10 ** dp) / 10 ** dp;
export function qty(value, dp = 3) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString("en-IN", { maximumFractionDigits: dp }) : "—";
}
export function money(value, symbol = false) {
  const n = Number(value) || 0;
  const text = n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return symbol ? `₹${text}` : text;
}
export function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value.toDate === "function") return value.toDate();
  if (typeof value === "object" && Number.isFinite(value.seconds)) return new Date(value.seconds * 1000);
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
const pad = (n) => String(n).padStart(2, "0");
export function fmtDate(value) {
  const d = toDate(value);
  return d ? `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}` : "—";
}
export function fmtDateTime(value) {
  const d = toDate(value);
  return d ? `${fmtDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : "—";
}
export function isoDate(value = new Date()) {
  const d = toDate(value) || new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + Number(days || 0));
  return isoDate(d);
}
/** Indian financial year label, e.g. 2026-09-23 -> "26-27". */
export function financialYear(value = new Date()) {
  const d = typeof value === "string" ? new Date(`${value}T00:00:00`) : toDate(value);
  const start = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${String(start).slice(-2)}-${String(start + 1).slice(-2)}`;
}

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
function twoDigits(n) { return n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ""}`; }
function threeDigits(n) {
  const h = Math.floor(n / 100); const r = n % 100;
  return [h ? `${ONES[h]} Hundred` : "", r ? twoDigits(r) : ""].filter(Boolean).join(" ");
}
/** Indian-system amount in words: 427160 -> "Indian Rupee Four Lakh Twenty Seven Thousand One Hundred Sixty Only" */
export function amountInWords(amount) {
  const value = Math.round((Number(amount) || 0) * 100);
  let rupees = Math.floor(value / 100);
  const paise = value % 100;
  if (rupees === 0 && paise === 0) return "Indian Rupee Zero Only";
  const parts = [];
  const crore = Math.floor(rupees / 10000000); rupees %= 10000000;
  const lakh = Math.floor(rupees / 100000); rupees %= 100000;
  const thousand = Math.floor(rupees / 1000); rupees %= 1000;
  if (crore) parts.push(`${crore > 99 ? threeDigits(crore) : twoDigits(crore)} Crore`);
  if (lakh) parts.push(`${twoDigits(lakh)} Lakh`);
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`);
  if (rupees) parts.push(threeDigits(rupees));
  let words = `Indian Rupee ${parts.join(" ")}`.trim();
  if (paise) words += ` and ${twoDigits(paise)} Paise`;
  return `${words} Only`;
}

/* ------------------------------------------------------------------ */
/* GST                                                                 */
/* ------------------------------------------------------------------ */
export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const STATE_CODES = {
  "01": "Jammu and Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh", "05": "Uttarakhand", "06": "Haryana", "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim", "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur", "15": "Mizoram", "16": "Tripura", "17": "Meghalaya", "18": "Assam", "19": "West Bengal", "20": "Jharkhand", "21": "Odisha", "22": "Chhattisgarh", "23": "Madhya Pradesh", "24": "Gujarat", "26": "Dadra and Nagar Haveli and Daman and Diu", "27": "Maharashtra", "29": "Karnataka", "30": "Goa", "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry", "35": "Andaman and Nicobar Islands", "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh", "97": "Other Territory"
};

/**
 * Compute line amounts and GST split.
 * intraState -> CGST + SGST (half each); otherwise IGST.
 */
export function computeTotals(lines, intraState) {
  const taxGroups = new Map();
  let subTotal = 0;
  const computed = lines.map((line) => {
    const amount = round((Number(line.qty) || 0) * (Number(line.rate) || 0), 2);
    subTotal += amount;
    const rate = Number(line.gstRate) || 0;
    if (rate > 0) taxGroups.set(rate, (taxGroups.get(rate) || 0) + amount);
    return { ...line, amount };
  });
  const taxes = [];
  [...taxGroups.entries()].sort((a, b) => a[0] - b[0]).forEach(([rate, base]) => {
    if (intraState) {
      const half = round((base * rate) / 200, 2);
      taxes.push({ label: `CGST${rate / 2} (${rate / 2}%)`, amount: half, kind: "CGST", rate: rate / 2 });
      taxes.push({ label: `SGST${rate / 2} (${rate / 2}%)`, amount: half, kind: "SGST", rate: rate / 2 });
    } else {
      taxes.push({ label: `IGST${rate} (${rate}%)`, amount: round((base * rate) / 100, 2), kind: "IGST", rate });
    }
  });
  subTotal = round(subTotal, 2);
  const taxTotal = round(taxes.reduce((sum, t) => sum + t.amount, 0), 2);
  const exact = subTotal + taxTotal;
  const total = Math.round(exact);
  return { lines: computed, subTotal, taxes, taxTotal, roundOff: round(total - exact, 2), total };
}

/* ------------------------------------------------------------------ */
/* UI helpers                                                          */
/* ------------------------------------------------------------------ */
export function toast(message, type = "") {
  let host = document.querySelector(".toasts");
  if (!host) { host = document.createElement("div"); host.className = "toasts"; document.body.append(host); }
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  host.append(el);
  setTimeout(() => el.remove(), type === "error" ? 7000 : 3800);
}

/** Opens a modal. Returns { el, body, close }. */
export function openModal({ title, body = "", footer = "", size = "", onClose } = {}) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `<div class="modal ${size}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="modal-head"><h3>${esc(title)}</h3><button class="icon-btn" data-close aria-label="Close"><i class="fa-solid fa-xmark fa-lg"></i></button></div>
    <div class="modal-body">${body}</div>
    ${footer ? `<div class="modal-foot">${footer}</div>` : ""}
  </div>`;
  document.body.append(backdrop);
  document.body.style.overflow = "hidden";
  const close = () => {
    backdrop.remove();
    if (!document.querySelector(".modal-backdrop")) document.body.style.overflow = "";
    document.removeEventListener("keydown", onKey);
    onClose?.();
  };
  const onKey = (event) => { if (event.key === "Escape" && backdrop === [...document.querySelectorAll(".modal-backdrop")].pop()) close(); };
  document.addEventListener("keydown", onKey);
  backdrop.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", close));
  return { el: backdrop, body: backdrop.querySelector(".modal-body"), foot: backdrop.querySelector(".modal-foot"), close };
}

/** Show an error to the user; log to console only when it is not a plain business-rule message. */
export function reportError(error) {
  if (error?.code || !(error instanceof Error) || error.constructor !== Error) console.error(error);
  const text = error?.code === "permission-denied" ? "You do not have permission to do this." : error?.message || String(error);
  toast(text, "error");
}

export function confirmDialog(message, { title = "Please confirm", okText = "Confirm", danger = false, input = null } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const modal = openModal({
      title,
      body: `<p style="margin:0 0 12px">${esc(message)}</p>${input ? `<label class="field"><span>${esc(input.label)}${input.required ? ' <b class="req">*</b>' : ""}</span><textarea id="confirmInput" placeholder="${esc(input.placeholder || "")}"></textarea></label>` : ""}`,
      footer: `<button class="btn" data-close>Cancel</button><button class="btn ${danger ? "danger" : "primary"}" id="confirmOk">${esc(okText)}</button>`,
      onClose: () => { if (!settled) resolve(null); }
    });
    modal.el.querySelector("#confirmOk").addEventListener("click", () => {
      const text = modal.el.querySelector("#confirmInput")?.value.trim() ?? "";
      if (input?.required && !text) { toast(`${input.label} is required.`, "error"); return; }
      settled = true; modal.close(); resolve(input ? text : true);
    });
  });
}

export function badge(status) {
  const map = {
    DRAFT: "gray", OPEN: "blue", "PARTIALLY RECEIVED": "amber", COMPLETED: "green", "SHORT CLOSED": "gold", CANCELLED: "red",
    SENT: "blue", ACCEPTED: "green", REJECTED: "red", CONVERTED: "indigo", EXPIRED: "gray",
    "PARTIALLY DISPATCHED": "amber", "KANTA PENDING": "amber", "GRN PENDING": "blue", "IN TRANSIT": "amber", RECEIVED: "green",
    POSTED: "green", REVERSED: "red", ACTIVE: "green", INACTIVE: "gray"
  };
  return `<span class="badge ${map[status] || "gray"}">${esc(status)}</span>`;
}

export function progressBar(done, total) {
  const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
  return `<div class="progress ${pct >= 100 ? "done" : ""}"><i style="width:${pct.toFixed(1)}%"></i></div>`;
}

export function busy(button, text = "Saving…") {
  const original = button.innerHTML;
  button.disabled = true;
  button.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${esc(text)}`;
  return () => { button.disabled = false; button.innerHTML = original; };
}

export function formValues(form) {
  const data = {};
  new FormData(form).forEach((value, key) => { data[key] = typeof value === "string" ? value.trim() : value; });
  return data;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

const scriptCache = new Map();
export function loadScript(src) {
  if (!scriptCache.has(src)) {
    scriptCache.set(src, new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src; s.onload = resolve; s.onerror = () => reject(new Error(`Could not load ${src}`));
      document.head.append(s);
    }));
  }
  return scriptCache.get(src);
}

export async function loadXLSX() {
  await loadScript("https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js");
  return window.XLSX;
}

/** Export an array of plain objects to .xlsx */
export async function exportExcel(rows, filename, sheetName = "Sheet1") {
  const XLSX = await loadXLSX();
  const ws = XLSX.utils.json_to_sheet(rows);
  const keys = Object.keys(rows[0] || {});
  ws["!cols"] = keys.map((k) => ({ wch: Math.min(48, Math.max(k.length, ...rows.map((r) => String(r[k] ?? "").length)) + 2) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
  XLSX.writeFile(wb, filename);
}

/* ------------------------------------------------------------------ */
/* Data loading                                                        */
/* ------------------------------------------------------------------ */
export const state = { user: null, profile: null, company: { ...DEFAULT_COMPANY }, warehouses: [...DEFAULT_WAREHOUSES] };

export async function listCollection(name, orderField = null, direction = "asc") {
  const ref = orderField ? query(collection(db, name), orderBy(orderField, direction)) : collection(db, name);
  const snap = await getDocs(ref);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function loadSettings() {
  const [companySnap, warehouseSnap] = await Promise.all([
    getDoc(doc(db, "settings", "company")),
    getDocs(collection(db, "warehouses"))
  ]);
  if (companySnap.exists()) state.company = { ...DEFAULT_COMPANY, ...companySnap.data() };
  if (!warehouseSnap.empty) {
    state.warehouses = warehouseSnap.docs.map((d) => ({ ...d.data(), code: d.id }))
      .sort((a, b) => (a.sort ?? 99) - (b.sort ?? 99) || a.name.localeCompare(b.name));
  }
  return state;
}
export const activeWarehouses = () => state.warehouses.filter((w) => w.active !== false);
export const warehouseByCode = (code) => state.warehouses.find((w) => w.code === code) || { code, name: code, addressLines: [] };
export const warehouseOptions = (selected = "", { includeBlank = true } = {}) =>
  `${includeBlank ? '<option value="">Select warehouse</option>' : ""}${activeWarehouses().map((w) => `<option value="${esc(w.code)}" ${w.code === selected ? "selected" : ""}>${esc(w.name)}</option>`).join("")}`;

/* ------------------------------------------------------------------ */
/* Document numbering (must be used inside a transaction)              */
/* ------------------------------------------------------------------ */
/** Read phase: returns a reservation to pass to commitNumber() after all other reads. */
export async function reserveNumber(tx, type, { date = isoDate(), site = "" } = {}) {
  const fy = financialYear(date);
  const ref = doc(db, "counters", `${type}_${fy}`);
  const snap = await tx.get(ref);
  const next = snap.exists() ? Number(snap.data().next) || 1 : 1;
  const format = state.company.numberFormats?.[type] || NUMBER_FORMATS[type];
  const number = format.replace("{SEQ}", String(next).padStart(type === "PO" ? 3 : 4, "0")).replace("{FY}", fy).replace("{SITE}", site || "HO");
  return { ref, next, number, fy, type };
}
export function commitNumber(tx, reservation) {
  tx.set(reservation.ref, { next: reservation.next + 1, type: reservation.type, fy: reservation.fy, updatedAt: serverTimestamp() }, { merge: true });
}

/* ------------------------------------------------------------------ */
/* Stock engine (inside transactions)                                   */
/* ------------------------------------------------------------------ */
export const stockId = (warehouse, itemId) => `${warehouse}__${itemId}`;

/** Read phase: fetch stock balances for all (warehouse,item) pairs. */
export async function readStock(tx, pairs) {
  const unique = [...new Map(pairs.map((p) => [stockId(p.warehouse, p.itemId), p])).values()];
  const snaps = await Promise.all(unique.map((p) => tx.get(doc(db, "inventory", stockId(p.warehouse, p.itemId)))));
  const map = new Map();
  snaps.forEach((snap) => map.set(snap.id, snap.exists() ? snap.data() : null));
  return map;
}

/**
 * Write phase: apply signed quantity movements, write balances + ledger rows.
 * movement: { warehouse, item: {id,name,unit,category}, qty (+in / -out), note }
 * ref: { type, id, no }
 */
export function applyMovements(tx, stockMap, movements, ref) {
  const balances = new Map();
  movements.forEach((m) => {
    const id = stockId(m.warehouse, m.item.id);
    const current = balances.has(id) ? balances.get(id) : Number(stockMap.get(id)?.qty || 0);
    const next = round(current + Number(m.qty), 3);
    if (next < -0.0005) {
      throw new Error(`Insufficient stock of ${m.item.name} at ${warehouseByCode(m.warehouse).name}. Available ${qty(current)} ${m.item.unit}, required ${qty(Math.abs(m.qty))} ${m.item.unit}.`);
    }
    balances.set(id, Math.max(0, next));
    const ledgerRef = doc(collection(db, "stockLedger"));
    tx.set(ledgerRef, {
      at: serverTimestamp(),
      warehouse: m.warehouse,
      itemId: m.item.id,
      itemName: m.item.name,
      unit: m.item.unit,
      category: m.item.category || "",
      qtyIn: m.qty > 0 ? round(m.qty) : 0,
      qtyOut: m.qty < 0 ? round(-m.qty) : 0,
      balance: Math.max(0, next),
      refType: ref.type,
      refId: ref.id,
      refNo: ref.no || "",
      note: m.note || "",
      uid: state.user?.uid || "",
      userName: state.profile?.name || state.user?.email || ""
    });
  });
  balances.forEach((balance, id) => {
    const m = movements.find((mv) => stockId(mv.warehouse, mv.item.id) === id);
    tx.set(doc(db, "inventory", id), {
      warehouse: m.warehouse,
      itemId: m.item.id,
      itemName: m.item.name,
      unit: m.item.unit,
      category: m.item.category || "",
      qty: balance,
      updatedAt: serverTimestamp()
    }, { merge: true });
  });
}

/* ------------------------------------------------------------------ */
/* Activity log                                                        */
/* ------------------------------------------------------------------ */
/** Adds an audit row inside a transaction/batch (preferred) so it can never be lost or faked. */
export function logActivity(writer, { module, action, refNo = "", refId = "", summary = "", details = null }) {
  const data = {
    at: serverTimestamp(),
    clientAt: Timestamp.now(),
    uid: state.user.uid,
    email: state.user.email,
    userName: state.profile?.name || state.user.email,
    module, action, refNo, refId, summary
  };
  if (details) data.details = details;
  writer.set(doc(collection(db, "activity")), data);
}

/* ------------------------------------------------------------------ */
/* Shell                                                               */
/* ------------------------------------------------------------------ */
const NAV = [
  { group: "Overview", items: [["dashboard", "dashboard.html", "fa-gauge-high", "Dashboard"]] },
  { group: "Purchase", items: [
    ["po", "purchase-orders.html", "fa-file-invoice", "Purchase Orders"],
    ["inward", "inward.html", "fa-truck-ramp-box", "Inward · Kanta · GRN"],
    ["parties", "parties.html", "fa-address-book", "Vendors & Customers"]
  ] },
  { group: "Sales", items: [
    ["quotations", "quotations.html", "fa-file-signature", "Quotations"],
    ["so", "sales-orders.html", "fa-file-contract", "Sales Orders"],
    ["outward", "outward.html", "fa-truck-fast", "Outward / Dispatch"]
  ] },
  { group: "Inventory", items: [
    ["inventory", "inventory.html", "fa-boxes-stacked", "Stock"],
    ["transfers", "transfers.html", "fa-right-left", "Stock Transfer"],
    ["adjustments", "adjustments.html", "fa-trash-can-arrow-up", "Write-off / Adjust"],
    ["items", "items.html", "fa-flask", "Items & Packaging"]
  ] },
  { group: "Admin", items: [
    ["activity", "activity.html", "fa-clock-rotate-left", "Activity Log"],
    ["settings", "settings.html", "fa-gear", "Settings & Users"]
  ] }
];

function renderShell(pageKey) {
  const initials = (state.profile?.name || state.user.email).split(/\s+/).map((p) => p[0]).join("").slice(0, 2).toUpperCase();
  document.body.innerHTML = `
    <header class="topbar">
      <div class="brand">
        <button class="menu-toggle" id="menuToggle" aria-label="Open menu"><i class="fa-solid fa-bars"></i></button>
        <img src="logo.png" alt="CCPL" />
        <div><div class="name">Cognizant Chemical</div><div class="sub">Enterprise Resource Planning</div></div>
      </div>
      <div class="userchip">
        ${USING_EMULATOR ? '<span class="env-badge">TEST MODE (emulator)</span>' : ""}
        <div class="who"><b>${esc(state.profile?.name || state.user.email)}</b><span>${esc(state.profile?.role || "")}</span></div>
        <div class="avatar" title="${esc(state.user.email)}">${esc(initials)}</div>
        <button class="btn sm" id="logoutBtn" title="Sign out"><i class="fa-solid fa-right-from-bracket"></i><span class="hide-sm">Sign out</span></button>
      </div>
    </header>
    <nav class="sidebar" id="sidebar">
      ${NAV.map((g) => `<div class="nav-group"><div class="nav-group-title">${g.group}</div>
        ${g.items.map(([key, href, icon, label]) => `<a class="nav-link ${key === pageKey ? "active" : ""}" href="${href}"><i class="fa-solid ${icon}"></i><span>${label}</span></a>`).join("")}
      </div>`).join("")}
    </nav>
    <div class="overlay" id="overlay"></div>
    <main class="main"><div class="content" id="page"></div></main>`;
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("overlay");
  const toggle = (open) => { sidebar.classList.toggle("open", open); overlay.classList.toggle("show", open); };
  document.getElementById("menuToggle").addEventListener("click", () => toggle(!sidebar.classList.contains("open")));
  overlay.addEventListener("click", () => toggle(false));
  document.getElementById("logoutBtn").addEventListener("click", logout);
  return document.getElementById("page");
}

export async function logout() {
  await signOut(auth);
  window.location.replace("index.html");
}

// Sign out after a period of inactivity on shared office PCs.
const IDLE_LIMIT_MS = 60 * 60 * 1000;
function startIdleTimer() {
  let timer;
  const reset = () => { clearTimeout(timer); timer = setTimeout(() => { toast("Signed out after 60 minutes of inactivity."); logout(); }, IDLE_LIMIT_MS); };
  ["click", "keydown", "mousemove", "touchstart", "scroll"].forEach((e) => window.addEventListener(e, reset, { passive: true }));
  reset();
}

/**
 * Every protected page calls this first. Resolves once the user is verified
 * as an active ERP user; otherwise redirects to the login page.
 */
export function initPage(pageKey, { permission = null } = {}) {
  document.body.innerHTML = '<div class="boot"><div><i class="fa-solid fa-spinner fa-spin"></i> Loading CCPL ERP…</div></div>';
  return new Promise((resolve) => {
    const stop = onAuthStateChanged(auth, async (user) => {
      stop();
      if (!user) { window.location.replace("index.html"); return; }
      try {
        const profileSnap = await getDoc(doc(db, "users", user.uid));
        if (!profileSnap.exists() || profileSnap.data().active !== true) {
          await signOut(auth);
          window.location.replace("index.html?denied=1");
          return;
        }
        state.user = user;
        state.profile = profileSnap.data();
        await loadSettings();
        const page = renderShell(pageKey);
        startIdleTimer();
        if (permission && !can(permission)) {
          page.innerHTML = `<div class="notice error"><i class="fa-solid fa-lock"></i><div>Your role (<b>${esc(state.profile.role)}</b>) does not have access to this page. Please contact an administrator.</div></div>`;
          return;
        }
        resolve(page);
      } catch (error) {
        console.error(error);
        document.body.innerHTML = `<div class="boot"><div class="notice error">Could not load the ERP: ${esc(error.message)}</div></div>`;
      }
    });
  });
}

export function pageHeader(eyebrow, title, subtitle = "", actions = "") {
  return `<div class="page-head"><div><div class="eyebrow">${esc(eyebrow)}</div><h1>${esc(title)}</h1>${subtitle ? `<p>${esc(subtitle)}</p>` : ""}</div><div class="page-actions">${actions}</div></div>`;
}

/* ------------------------------------------------------------------ */
/* Order status (PO & SO)                                              */
/* ------------------------------------------------------------------ */
/**
 * Derives the status of an order from its lines.
 * doneKey: "receivedQty" for POs, "dispatchedQty" for SOs.
 * A line is complete when done >= ordered × (1 − tolerance%).
 */
export function deriveOrderStatus(order, doneKey, tolerancePct = 0) {
  if (["CANCELLED", "SHORT CLOSED", "DRAFT"].includes(order.status)) return order.status;
  const lines = order.lines || [];
  const factor = 1 - (Number(tolerancePct) || 0) / 100;
  const complete = lines.length > 0 && lines.every((l) => (Number(l[doneKey]) || 0) + 0.0005 >= (Number(l.qty) || 0) * factor);
  if (complete) return "COMPLETED";
  const started = lines.some((l) => (Number(l[doneKey]) || 0) > 0 || (Number(l.invoicedQty) || 0) > 0);
  if (!started) return "OPEN";
  return doneKey === "receivedQty" ? "PARTIALLY RECEIVED" : "PARTIALLY DISPATCHED";
}
