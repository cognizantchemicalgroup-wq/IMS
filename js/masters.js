// Master data pages (Vendors & Customers = parties, Items & Packaging) with add/edit,
// downloadable template (Excel / CSV), bulk import with preview, row + column errors,
// duplicate handling (skip or update) and an import report.
import {
  db, reportError, initPage, pageHeader, esc, toast, openModal, badge, busy, formValues, can,
  listCollection, logActivity, loadXLSX, exportExcel, downloadBlob, isoDate, GSTIN_PATTERN, STATE_CODES, ITEM_CATEGORIES, UNITS, PARTY_TYPES
} from "./core.js";
import { collection, doc, runTransaction, writeBatch, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const PARTY_FIELDS = [
  { key: "name", label: "Party Name", required: true, span: 2, aliases: ["name", "customer name", "supplier name", "vendor name", "company name", "display name"], example: "Pyramid Technoplast Limited", help: "Legal / trade name" },
  { key: "partyType", label: "Party Type", required: true, options: ["", ...PARTY_TYPES], aliases: ["type", "customer / supplier", "customer or supplier"], example: "Supplier", help: "Customer, Supplier or Both" },
  { key: "code", label: "Code", aliases: ["party code", "customer code", "vendor code"], example: "V001", help: "Optional short code" },
  { key: "gstin", label: "GSTIN", upper: true, aliases: ["gst", "gst no", "gst number", "gstin no"], example: "27AACCP5074E3ZF", help: "15 characters. State code & PAN are filled from it" },
  { key: "pan", label: "PAN", upper: true, aliases: ["pan no", "pan number"], example: "AACCP5074E", help: "Filled from GSTIN if blank" },
  { key: "contactPerson", label: "Contact Person", aliases: ["contact", "contact name", "attention"], example: "Mr. Sharma" },
  { key: "phone", label: "Phone", aliases: ["mobile", "mobile no", "phone no", "contact no", "telephone"], example: "9800000000" },
  { key: "email", label: "Email", type: "email", aliases: ["email id", "e-mail", "mail"], example: "sales@example.com", help: "Several emails: separate with comma" },
  { key: "address1", label: "Address Line 1", span: 2, aliases: ["address", "address 1", "billing address"], example: "GAT NO. 420/1, KHANIVALI" },
  { key: "address2", label: "Address Line 2", span: 2, aliases: ["address 2"], example: "Khanivali" },
  { key: "city", label: "City", aliases: ["town"], example: "Palghar" },
  { key: "pincode", label: "PIN Code", aliases: ["pin", "pincode", "postal code", "zip"], example: "401204", help: "6 digits (India)" },
  { key: "state", label: "State", example: "Maharashtra", help: "Filled from GSTIN if blank" },
  { key: "stateCode", label: "State Code", aliases: ["gst state code"], example: "27", help: "2 digits, e.g. 27 Maharashtra, 24 Gujarat. Filled from GSTIN if blank" },
  { key: "country", label: "Country", default: "India", example: "India" },
  { key: "paymentTermsDays", label: "Payment Terms (days)", type: "number", aliases: ["payment terms", "credit days", "credit period"], example: "30", help: "Number of days, e.g. 30 (\"Net 30\" also accepted)" },
  { key: "bankName", label: "Bank Name", example: "" },
  { key: "bankAccount", label: "Bank A/c No.", aliases: ["bank account", "account no", "bank account no"], example: "" },
  { key: "bankIfsc", label: "IFSC", upper: true, aliases: ["ifsc code"], example: "" },
  { key: "notes", label: "Notes", span: 3, aliases: ["remarks"], example: "" }
];

const ITEM_FIELDS = [
  { key: "name", label: "Item Name", required: true, span: 2, aliases: ["name", "item"], example: "M S Drum" },
  { key: "code", label: "Item Code", aliases: ["code"], example: "PKG-MSD" },
  { key: "category", label: "Category", required: true, options: ITEM_CATEGORIES, example: "Packaging", help: ITEM_CATEGORIES.join(", ") },
  { key: "hsn", label: "HSN / SAC", aliases: ["hsn", "hsn code", "sac"], example: "73101090" },
  { key: "unit", label: "Unit", required: true, options: UNITS, example: "NOS", help: UNITS.join(", ") },
  { key: "gstRate", label: "GST %", type: "number", default: "18", aliases: ["gst", "gst rate", "tax rate"], example: "18" },
  { key: "capacity", label: "Pack Capacity", type: "number", help: "Packaging only: e.g. 200 for a 200 L drum", example: "200" },
  { key: "capacityUnit", label: "Capacity Unit", options: ["", "KG", "LTR"], help: "Packaging only: KG or LTR", example: "LTR" },
  { key: "reorderLevel", label: "Reorder Level", type: "number", help: "Warn when total stock falls below", example: "50" },
  { key: "description", label: "Description (printed on PO/Quotation)", span: 3, aliases: ["description"], example: "MS drum 200 L, open top" }
];

export const MASTER_CONFIG = {
  parties: { title: "Vendors & Customers", singular: "Party", eyebrow: "Masters", nav: "parties", fields: PARTY_FIELDS, collection: "parties" },
  items: { title: "Items & Packaging", singular: "Item", eyebrow: "Inventory", nav: "items", fields: ITEM_FIELDS, collection: "items" }
};

/* ---------------- value cleaning ---------------- */
const norm = (text) => String(text ?? "").toLowerCase().replace(/\((required|optional)\)|\*/g, "").replace(/[^a-z0-9]/g, "");
/** Same company written differently ("Pvt. Ltd." / "Private Limited") is treated as the same name. */
export const nameKey = (name) => String(name || "").toLowerCase().replace(/\bprivate\b/g, "pvt").replace(/\blimited\b/g, "ltd").replace(/[^a-z0-9]/g, "");

export function partyTypeOf(value) {
  const v = String(value || "").trim().toLowerCase();
  if (!v) return "";
  const customer = /customer|buyer|client|sale/.test(v);
  const supplier = /supplier|vendor|seller|purchase/.test(v);
  if (v === "both" || (customer && supplier)) return "Both";
  if (customer) return "Customer";
  if (supplier) return "Supplier";
  return null; // invalid
}
const mergeTypes = (a, b) => (!a ? b : !b || a === b ? a : "Both");

function numberOf(value) {
  if (value === "" || value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  const text = String(value).trim().toLowerCase();
  if (!text) return null;
  if (/due on receipt|immediate|advance/.test(text)) return 0;
  const m = text.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : Number.NaN;
}

function normalizeRecord(fields, raw) {
  const rec = {};
  fields.forEach((f) => {
    let v = raw[f.key];
    if (f.type === "number") { rec[f.key] = numberOf(v); return; }
    v = String(v ?? "").replace(/\s*[\r\n]+\s*/g, ", ").trim();
    if (f.upper) v = v.toUpperCase().replace(/\s+/g, "");
    if (f.key === "name") v = v.replace(/\s+/g, " ");
    rec[f.key] = v;
  });
  if (fields === PARTY_FIELDS) {
    const type = partyTypeOf(rec.partyType);
    rec.partyType = type === null ? `!${rec.partyType}` : type; // "!" marks an invalid value for validation
    if (/^\d$/.test(rec.stateCode)) rec.stateCode = `0${rec.stateCode}`; // Excel drops the leading 0 of 07, 09…
    if (/^\d{6}\.0+$/.test(rec.pincode)) rec.pincode = rec.pincode.split(".")[0];
    if (GSTIN_PATTERN.test(rec.gstin)) {
      if (!rec.stateCode) rec.stateCode = rec.gstin.slice(0, 2);
      if (!rec.pan) rec.pan = rec.gstin.slice(2, 12);
    }
    if (!rec.state && STATE_CODES[rec.stateCode]) rec.state = STATE_CODES[rec.stateCode];
    if (!rec.country) rec.country = "India";
  } else {
    const cat = ITEM_CATEGORIES.find((c) => c.toLowerCase() === String(rec.category).toLowerCase());
    if (cat) rec.category = cat;
    rec.unit = String(rec.unit || "").toUpperCase();
    if (rec.capacityUnit) rec.capacityUnit = rec.capacityUnit.toUpperCase();
  }
  return rec;
}

/** Returns [{ key, problem }] — one entry per bad column. */
function validateRecord(fields, rec) {
  const errors = [];
  const add = (key, problem) => errors.push({ key, problem });
  fields.filter((f) => f.required).forEach((f) => { if (rec[f.key] === "" || rec[f.key] === null) add(f.key, "is required"); });
  if (fields === PARTY_FIELDS) {
    if (String(rec.partyType).startsWith("!")) add("partyType", `"${rec.partyType.slice(1)}" is not valid — use Customer, Supplier or Both`);
    if (rec.gstin && !GSTIN_PATTERN.test(rec.gstin)) add("gstin", `"${rec.gstin}" is not a valid 15-character GSTIN`);
    if (rec.gstin && GSTIN_PATTERN.test(rec.gstin) && rec.stateCode && rec.stateCode !== rec.gstin.slice(0, 2)) add("stateCode", `${rec.stateCode} does not match the GSTIN state code ${rec.gstin.slice(0, 2)}`);
    if (rec.stateCode && !STATE_CODES[rec.stateCode]) add("stateCode", `"${rec.stateCode}" is not a GST state code`);
    if (rec.pan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(rec.pan)) add("pan", `"${rec.pan}" is not a valid PAN`);
    if (rec.email && rec.email.split(/[,;]\s*/).some((e) => e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))) add("email", `"${rec.email}" is not a valid email`);
    if (rec.pincode && (rec.country || "India").toLowerCase() === "india" && !/^\d{6}$/.test(rec.pincode)) add("pincode", `"${rec.pincode}" must be 6 digits`);
  } else {
    if (rec.category && !ITEM_CATEGORIES.includes(rec.category)) add("category", `must be one of: ${ITEM_CATEGORIES.join(", ")}`);
    if (rec.unit && !UNITS.includes(rec.unit)) add("unit", `"${rec.unit}" — use one of: ${UNITS.join(", ")}`);
  }
  fields.filter((f) => f.type === "number").forEach((f) => {
    if (rec[f.key] !== null && (!Number.isFinite(rec[f.key]) || rec[f.key] < 0)) add(f.key, "must be a number (0 or more)");
  });
  return errors;
}

/** Map one row of a Zoho Books Vendors/Contacts export onto our party fields. */
function fromZoho(row) {
  const g = (k) => String(row[k] ?? "").replace(/\s*[\r\n]+\s*/g, ", ").replace(/\s{2,}/g, " ").trim();
  const place = g("Place of Contact(With State Code)");
  const zohoType = g("Contact Type").toLowerCase();
  return {
    mapped: {
      name: g("Display Name") || g("Company Name") || g("Contact Name"),
      // Zoho "Vendors" exports have vendor bank columns and no Contact Type; "Contacts" exports say customer/vendor.
      partyType: zohoType ? (zohoType.includes("vendor") ? "Supplier" : "Customer") : ("Vendor Bank Name" in row || "Beneficiary Name" in row ? "Supplier" : "Customer"),
      gstin: g("GST Identification Number (GSTIN)"),
      contactPerson: [g("First Name"), g("Last Name")].filter(Boolean).join(" ") || g("Billing Attention"),
      phone: g("MobilePhone") || g("Phone") || g("Billing Phone"),
      email: g("EmailID"),
      address1: g("Billing Address"), address2: g("Billing Street2"), city: g("Billing City"), pincode: g("Billing Code"),
      state: g("Billing State"), stateCode: /^\d{2}-/.test(place) ? place.slice(0, 2) : "", country: g("Billing Country"),
      paymentTermsDays: g("Payment Terms"),
      bankName: g("Vendor Bank Name"), bankAccount: g("Vendor Bank Account Number"), bankIfsc: g("Vendor Bank Code"),
      notes: g("Notes")
    },
    active: g("Status").toLowerCase() !== "inactive",
    hasStatus: Boolean(g("Status")),
    zohoId: g("Contact ID")
  };
}
const ZOHO_COLUMNS = { name: "Display Name", partyType: "Contact Type", gstin: "GST Identification Number (GSTIN)", contactPerson: "First Name", phone: "MobilePhone", email: "EmailID", address1: "Billing Address", address2: "Billing Street2", city: "Billing City", pincode: "Billing Code", state: "Billing State", stateCode: "Place of Contact(With State Code)", country: "Billing Country", paymentTermsDays: "Payment Terms", bankIfsc: "Vendor Bank Code" };

/** Find an existing record for an imported row: GSTIN first, then the same name (only if that record has no different GSTIN). */
function findExisting(records, rec, zohoId, isParty) {
  if (zohoId) { const z = records.find((x) => x.zohoId === zohoId); if (z) return z; }
  if (isParty && rec.gstin) {
    const g = records.find((x) => x.gstin === rec.gstin);
    if (g) return g;
    return records.find((x) => !x.gstin && nameKey(x.name) === nameKey(rec.name)) || null;
  }
  return records.find((x) => nameKey(x.name) === nameKey(rec.name)) || null;
}

export async function startMasterPage(type) {
  const cfg = MASTER_CONFIG[type];
  const isParty = type === "parties";
  const page = await initPage(cfg.nav);
  if (!page) return;
  const editable = can("masters");
  let records = [];
  const labelOf = (key) => cfg.fields.find((f) => f.key === key)?.label || key;

  page.innerHTML = `${pageHeader(cfg.eyebrow, cfg.title, isParty ? "One list for customers and suppliers — the same company can be used on POs, quotations, sales orders and proforma invoices." : `${cfg.title} master used across POs, quotations, sales orders and stock.`,
    `${editable ? `<button class="btn" id="templateBtn"><i class="fa-solid fa-file-arrow-down"></i> Import template</button>
     <button class="btn" id="importBtn"><i class="fa-solid fa-file-excel"></i> Import Excel / CSV</button>` : ""}
     <button class="btn" id="exportBtn"><i class="fa-solid fa-download"></i> Export</button>
     ${editable ? `<button class="btn primary" id="addBtn"><i class="fa-solid fa-plus"></i> New ${cfg.singular}</button>` : ""}`)}
    <div class="card">
      <div class="card-head"><div class="toolbar"><input class="input search" id="search" placeholder="Search ${cfg.title.toLowerCase()}…" />
        ${type === "items" ? `<select class="input" id="catFilter"><option value="">All categories</option>${ITEM_CATEGORIES.map((c) => `<option>${c}</option>`).join("")}</select>` : `<select class="input" id="typeFilter"><option value="">All party types</option>${PARTY_TYPES.map((t) => `<option>${t}</option>`).join("")}<option value="-">Type not set</option></select>`}
        <label class="small muted"><input type="checkbox" id="showInactive" /> Show inactive</label></div><span class="muted small" id="count"></span></div>
      <div class="table-wrap"><table class="table"><thead>${type === "items"
        ? "<tr><th>Item</th><th>Code</th><th>Category</th><th>HSN</th><th>Unit</th><th class='num'>GST %</th><th class='num'>Capacity</th><th>Status</th><th></th></tr>"
        : "<tr><th>Name</th><th>Type</th><th>GSTIN</th><th>City / State</th><th>Contact</th><th>Phone</th><th>Email</th><th>Status</th><th></th></tr>"}</thead><tbody id="rows"></tbody></table></div>
    </div>`;

  const rowsEl = page.querySelector("#rows");
  const render = () => {
    const term = page.querySelector("#search").value.trim().toLowerCase();
    const cat = page.querySelector("#catFilter")?.value || "";
    const ptype = page.querySelector("#typeFilter")?.value || "";
    const showInactive = page.querySelector("#showInactive").checked;
    const list = records.filter((r) => (showInactive || r.active !== false)
      && (!cat || r.category === cat)
      && (!ptype || (ptype === "-" ? !r.partyType : r.partyType === ptype || (ptype !== "Both" && r.partyType === "Both")))
      && (!term || Object.values(r).some((v) => typeof v === "string" && v.toLowerCase().includes(term))));
    page.querySelector("#count").textContent = `${list.length} of ${records.length}`;
    if (!list.length) { rowsEl.innerHTML = `<tr><td class="empty" colspan="9">No ${cfg.title.toLowerCase()} here.${editable ? " Add one or import from Excel." : ""}</td></tr>`; return; }
    rowsEl.innerHTML = list.map((r) => {
      const status = badge(r.active === false ? "INACTIVE" : "ACTIVE");
      const actions = editable ? `<div class="actions"><button class="btn sm" data-edit="${esc(r.id)}">Edit</button></div>` : "";
      return type === "items"
        ? `<tr><td class="strong">${esc(r.name)}<div class="small muted">${esc(r.description || "")}</div></td><td>${esc(r.code || "—")}</td><td>${esc(r.category || "—")}</td><td class="mono">${esc(r.hsn || "—")}</td><td>${esc(r.unit || "—")}</td><td class="num">${esc(r.gstRate ?? "—")}</td><td class="num">${r.capacity ? `${esc(r.capacity)} ${esc(r.capacityUnit || "")}` : "—"}</td><td>${status}</td><td>${actions}</td></tr>`
        : `<tr><td class="strong">${esc(r.name)}${r.code ? `<div class="small muted">${esc(r.code)}</div>` : ""}</td><td>${r.partyType ? badge(r.partyType.toUpperCase()) : '<span class="muted">—</span>'}</td><td class="mono">${esc(r.gstin || "—")}</td><td>${esc([r.city, r.state].filter(Boolean).join(", ") || "—")}</td><td>${esc(r.contactPerson || "—")}</td><td>${esc(r.phone || "—")}</td><td>${esc(r.email || "—")}</td><td>${status}</td><td>${actions}</td></tr>`;
    }).join("");
    rowsEl.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => openEditor(records.find((r) => r.id === b.dataset.edit))));
  };

  const load = async () => {
    records = (await listCollection(cfg.collection)).sort((a, b) => a.name.localeCompare(b.name));
    render();
  };

  function fieldHtml(f, value) {
    const v = value ?? f.default ?? "";
    const label = `<span>${esc(f.label)}${f.required ? ' <b class="req">*</b>' : ""}</span>`;
    const control = f.options
      ? `<select name="${f.key}">${f.options.map((o) => `<option value="${esc(o)}" ${String(o) === String(v) ? "selected" : ""}>${esc(o || (f.required ? "Select…" : "—"))}</option>`).join("")}</select>`
      : f.span === 3 && f.key !== "notes" ? `<textarea name="${f.key}">${esc(v)}</textarea>`
        : `<input name="${f.key}" type="${f.type === "number" ? "number" : f.type === "email" ? "text" : "text"}" ${f.type === "number" ? 'step="any"' : ""} value="${esc(v)}" />`;
    return `<label class="field ${f.span === 2 ? "span-2" : f.span === 3 ? "span-all" : ""}">${label}${control}${f.help ? `<small class="help">${esc(f.help)}</small>` : ""}</label>`;
  }

  function openEditor(record = null) {
    const modal = openModal({
      title: record ? `Edit ${cfg.singular}` : `New ${cfg.singular}`,
      size: "wide",
      body: `<form id="masterForm" class="form-grid">${cfg.fields.map((f) => fieldHtml(f, record?.[f.key])).join("")}
        ${record ? `<label class="field"><span>Status</span><select name="active"><option value="true" ${record.active !== false ? "selected" : ""}>Active</option><option value="false" ${record.active === false ? "selected" : ""}>Inactive</option></select></label>` : ""}</form>`,
      footer: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="saveMaster">Save ${cfg.singular}</button>`
    });
    const form = modal.el.querySelector("#masterForm");
    form.gstin?.addEventListener("change", () => {
      const g = form.gstin.value.trim().toUpperCase();
      form.gstin.value = g;
      if (GSTIN_PATTERN.test(g)) {
        if (!form.stateCode.value) form.stateCode.value = g.slice(0, 2);
        if (!form.pan.value) form.pan.value = g.slice(2, 12);
        if (!form.state.value) form.state.value = STATE_CODES[g.slice(0, 2)] || "";
      }
    });
    modal.el.querySelector("#saveMaster").addEventListener("click", async (event) => {
      const values = formValues(form);
      const rec = normalizeRecord(cfg.fields, values);
      const errors = validateRecord(cfg.fields, rec);
      if (errors.length) { toast(errors.map((e) => `${labelOf(e.key)} ${e.problem}`).join(". "), "error"); return; }
      const dup = records.find((r) => r.id !== record?.id && (isParty && rec.gstin ? r.gstin === rec.gstin : nameKey(r.name) === nameKey(rec.name) && (!isParty || !r.gstin || !rec.gstin)));
      if (dup) { toast(`A ${cfg.singular.toLowerCase()} with the same ${isParty && rec.gstin ? "GSTIN" : "name"} already exists: ${dup.name}`, "error"); return; }
      if (record) rec.active = values.active === "true";
      const done = busy(event.currentTarget);
      try {
        await runTransaction(db, async (tx) => {
          const ref = record ? doc(db, cfg.collection, record.id) : doc(collection(db, cfg.collection));
          tx.set(ref, { ...rec, ...(record ? {} : { active: true, createdAt: serverTimestamp() }), updatedAt: serverTimestamp() }, { merge: true });
          logActivity(tx, { module: cfg.title, action: record ? "UPDATE" : "CREATE", refId: ref.id, refNo: rec.name, summary: `${record ? "Updated" : "Created"} ${cfg.singular.toLowerCase()} ${rec.name}${rec.partyType ? ` (${rec.partyType})` : ""}` });
        });
        toast(`${cfg.singular} saved.`, "ok");
        modal.close();
        await load();
      } catch (error) { reportError(error); } finally { done(); }
    });
  }

  /* ---------------- Template ---------------- */
  const headerOf = (f) => `${f.label} (${f.required ? "Required" : "Optional"})`;
  function openTemplate() {
    const modal = openModal({
      title: `${cfg.title} — import template`,
      size: "wide",
      body: `<p style="margin-top:0">Download the template, put one ${isParty ? "party" : "item"} per row under the header and import it with <b>Import Excel / CSV</b>. Keep the header row as it is.
        ${isParty ? "A company that is both a customer and a supplier is entered <b>once</b> with Party Type <b>Both</b>." : ""}</p>
        <div class="table-wrap" style="max-height:46vh"><table class="table"><thead><tr><th>Column</th><th>Required?</th><th>What to enter</th><th>Example</th></tr></thead><tbody>
        ${cfg.fields.map((f) => `<tr><td class="strong nowrap">${esc(f.label)}</td><td>${f.required ? '<span class="badge red">Required</span>' : '<span class="badge gray">Optional</span>'}</td><td class="small">${esc(f.help || "")}</td><td class="small mono">${esc(f.example || "")}</td></tr>`).join("")}
        </tbody></table></div>
        <p class="small muted">Existing ${isParty ? "parties are matched by GSTIN (or by name when there is no GSTIN)" : "items are matched by name"}; at import you choose whether to skip or update them. Zoho Books Vendors / Contacts exports can also be imported as they are.</p>`,
      footer: `<button class="btn" data-close>Close</button><button class="btn" id="tplCsv"><i class="fa-solid fa-file-csv"></i> CSV template</button><button class="btn primary" id="tplXlsx"><i class="fa-solid fa-file-excel"></i> Excel template</button>`
    });
    modal.el.querySelector("#tplXlsx").addEventListener("click", downloadTemplateXlsx);
    modal.el.querySelector("#tplCsv").addEventListener("click", () => {
      const csv = `${cfg.fields.map((f) => `"${headerOf(f)}"`).join(",")}\r\n`;
      downloadBlob(new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" }), `CCPL_${type}_import_template.csv`);
    });
  }

  async function downloadTemplateXlsx() {
    const XLSX = await loadXLSX();
    const header = cfg.fields.map(headerOf);
    const ws = XLSX.utils.aoa_to_sheet([header]);
    ws["!cols"] = header.map((h) => ({ wch: Math.max(14, h.length + 2) }));
    const guide = XLSX.utils.aoa_to_sheet([
      ["Column", "Required / Optional", "What to enter", "Example"],
      ...cfg.fields.map((f) => [f.label, f.required ? "Required" : "Optional", f.help || "", f.example || ""]),
      [],
      ["How to import"],
      [`1. Fill the "${cfg.title.slice(0, 31)}" sheet: one row per ${isParty ? "party" : "item"}; keep the header row.`],
      ["2. In the ERP click Import Excel / CSV and choose this file. A preview shows every error by row and column before anything is saved."],
      ["3. Choose whether existing records are skipped or updated, then import. A report shows how many were added, updated, skipped and failed."],
      isParty ? ["Party Type: Customer, Supplier or Both. The same company is never entered twice — use Both."] : [`Category: ${ITEM_CATEGORIES.join(", ")}. Unit: ${UNITS.join(", ")}.`]
    ]);
    guide["!cols"] = [{ wch: 26 }, { wch: 20 }, { wch: 60 }, { wch: 28 }];
    const example = XLSX.utils.aoa_to_sheet([header, ...(isParty ? [
      cfg.fields.map((f) => f.example || (f.key === "country" ? "India" : "")),
      cfg.fields.map((f) => ({ name: "Deepak Fertilisers Ltd", partyType: "Customer", gstin: "27AAACD1234E1ZX", city: "Taloja", country: "India", paymentTermsDays: "45" })[f.key] || ""),
      cfg.fields.map((f) => ({ name: "Gujarat Acids Pvt Ltd", partyType: "Both", gstin: "24AABCG1234H1Z5", city: "Vapi", country: "India", paymentTermsDays: "30" })[f.key] || "")
    ] : [cfg.fields.map((f) => f.example || "")])]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, cfg.title.slice(0, 31));
    XLSX.utils.book_append_sheet(wb, guide, "Instructions");
    XLSX.utils.book_append_sheet(wb, example, "Example (not imported)");
    XLSX.writeFile(wb, `CCPL_${type}_import_template.xlsx`);
  }

  /* ---------------- Import ---------------- */
  function pickFile() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".xlsx,.xls,.csv";
    input.style.display = "none";
    document.body.append(input); // some browsers only fire "change" for inputs in the page
    input.addEventListener("change", async () => {
      const file = input.files[0];
      input.remove();
      if (!file) return;
      try { await previewImport(file); } catch (error) { reportError(new Error(`Could not read ${file.name}: ${error.message}`)); }
    });
    input.click();
  }

  async function previewImport(file) {
    const XLSX = await loadXLSX();
    const isCsv = /\.csv$/i.test(file.name);
    const wb = isCsv ? XLSX.read(await file.text(), { type: "string", raw: true }) : XLSX.read(await file.arrayBuffer());
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const raw = XLSX.utils.sheet_to_json(sheet, { defval: "" }); // raw values: long numbers (bank a/c, phone) stay exact
    if (!raw.length) { toast("The file has no data rows under the header.", "error"); return; }
    const headers = Object.keys(raw[0]);
    const zoho = isParty && headers.some((h) => h === "Display Name" || h === "Contact ID");
    // header → field key (accepts our template headers, plain labels, "Name *", keys and common aliases)
    const lookup = new Map();
    cfg.fields.forEach((f) => [f.label, f.key, ...(f.aliases || [])].forEach((a) => { if (!lookup.has(norm(a))) lookup.set(norm(a), f.key); }));
    const colName = {};
    if (zoho) Object.assign(colName, ZOHO_COLUMNS);
    else headers.forEach((h) => { const key = lookup.get(norm(h)); if (key && !colName[key]) colName[key] = h; });
    if (!zoho && !colName.name) { toast(`Could not find the "${cfg.fields[0].label}" column. Use the import template (header row must be the first row).`, "error"); return; }
    const missingRequired = zoho ? [] : cfg.fields.filter((f) => f.required && !colName[f.key]).map((f) => f.label);

    const parsed = raw.map((row, index) => {
      let mapped = {}; let active = true; let zohoId = ""; let hasStatus = false;
      if (zoho) ({ mapped, active, zohoId, hasStatus } = fromZoho(row));
      else Object.entries(colName).forEach(([key, h]) => { mapped[key] = row[h]; });
      const rec = normalizeRecord(cfg.fields, mapped);
      return { line: index + 2, rec, active, hasStatus, zohoId, errors: validateRecord(cfg.fields, rec), merged: [] };
    }).filter((r) => cfg.fields.some((f) => r.rec[f.key] !== "" && r.rec[f.key] !== null && !(f.key === "country" && r.rec[f.key] === "India")));
    if (!parsed.length) { toast("No rows found in the file.", "error"); return; }

    // The same party twice in the file (same GSTIN, or same name without GSTIN) becomes one record:
    // the most complete row is kept and its blanks are filled from the others; Customer + Supplier → Both.
    const filled = (rec) => Object.values(rec).filter((v) => v !== "" && v !== null).length;
    const groups = new Map();
    const rows = [];
    parsed.forEach((p) => {
      const k = p.errors.length || !p.rec.name ? `line:${p.line}` : isParty && p.rec.gstin ? `gst:${p.rec.gstin}` : `name:${nameKey(p.rec.name)}`;
      const prev = groups.get(k);
      if (!prev) { groups.set(k, p); rows.push(p); return; }
      const [base, other] = filled(p.rec) > filled(prev.rec) ? [p.rec, prev.rec] : [prev.rec, p.rec];
      Object.keys(base).forEach((f) => { if ((base[f] === "" || base[f] === null) && other[f] !== "" && other[f] !== null) base[f] = other[f]; });
      if (isParty) base.partyType = mergeTypes(prev.rec.partyType, p.rec.partyType);
      prev.rec = base;
      prev.active = prev.active || p.active;
      prev.zohoId ||= p.zohoId;
      prev.merged.push(p.line);
    });
    rows.forEach((r) => { r.existing = r.errors.length ? null : findExisting(records, r.rec, r.zohoId, isParty); });
    const valid = rows.filter((r) => !r.errors.length);
    const invalid = rows.filter((r) => r.errors.length);
    const mergedCount = rows.reduce((n, r) => n + r.merged.length, 0);
    const errorList = invalid.flatMap((r) => r.errors.map((e) => ({ row: r.line, column: colName[e.key] || labelOf(e.key), name: r.rec.name, problem: `${labelOf(e.key)} ${e.problem}` })));

    const modal = openModal({
      title: `Import ${cfg.title} — preview`,
      size: "full",
      body: `${zoho ? '<div class="notice" style="margin-bottom:10px">Zoho Books export detected — columns are mapped automatically.</div>' : ""}
        ${missingRequired.length ? `<div class="notice warn" style="margin-bottom:10px">Column${missingRequired.length > 1 ? "s" : ""} not found in the file: <b>${esc(missingRequired.join(", "))}</b> (required). Every row will need it — use the import template.</div>` : ""}
        <div class="grid cols-4" style="margin-bottom:12px">
          <div class="card kpi"><div class="label">Rows read</div><div class="value">${parsed.length}</div><div class="hint">${mergedCount ? `${mergedCount} duplicate row${mergedCount === 1 ? "" : "s"} merged (same ${isParty ? "GSTIN / name" : "name"})` : "no duplicates inside the file"}</div></div>
          <div class="card kpi"><div class="label">New</div><div class="value" style="color:var(--success)">${valid.filter((r) => !r.existing).length}</div><div class="hint">will be added</div></div>
          <div class="card kpi"><div class="label">Already in the ERP</div><div class="value">${valid.filter((r) => r.existing).length}</div><div class="hint">skip or update — choose below</div></div>
          <div class="card kpi"><div class="label">With errors</div><div class="value" style="color:${invalid.length ? "var(--danger)" : "var(--success)"}">${invalid.length}</div><div class="hint">${invalid.length ? "will not be imported" : "none"}</div></div>
        </div>
        ${errorList.length ? `<div class="section-title" style="margin-top:0">Errors — fix these in the file and import again</div>
          <div class="table-wrap" style="max-height:26vh"><table class="table" id="errorTable"><thead><tr><th>Row</th><th>Column</th><th>Name</th><th>Problem</th></tr></thead><tbody>
          ${errorList.map((e) => `<tr><td class="num">${e.row}</td><td class="nowrap strong">${esc(e.column)}</td><td>${esc(e.name || "—")}</td><td style="color:var(--danger)">${esc(e.problem)}</td></tr>`).join("")}
          </tbody></table></div>` : ""}
        <div class="section-title">Rows</div>
        <div class="table-wrap" style="max-height:34vh"><table class="table"><thead><tr><th>Row</th><th>Name</th>${isParty ? "<th>Type</th><th>GSTIN</th>" : "<th>Category</th><th>Unit</th>"}<th>Action</th><th>Notes</th></tr></thead><tbody id="previewRows"></tbody></table></div>
        ${valid.some((r) => r.existing) ? `<div class="field" style="margin-top:12px"><span>Records that already exist in the ERP</span>
          <label class="small"><input type="radio" name="dupMode" value="skip" checked /> <b>Skip</b> — keep the existing record unchanged</label>
          <label class="small"><input type="radio" name="dupMode" value="update" /> <b>Update</b> — fill in / replace with the file's values (the name is kept; blank cells never erase existing data${isParty ? "; Customer + Supplier becomes Both" : ""})</label></div>` : ""}`,
      footer: `<button class="btn" data-close>Cancel</button>${errorList.length ? '<button class="btn" id="errorReport"><i class="fa-solid fa-download"></i> Download error list</button>' : ""}<button class="btn primary" id="confirmImport" ${valid.length ? "" : "disabled"}>Import</button>`
    });
    const mode = () => modal.el.querySelector("input[name=dupMode]:checked")?.value || "skip";
    const renderRows = () => {
      modal.el.querySelector("#previewRows").innerHTML = rows.map((r) => {
        const action = r.errors.length ? '<span class="badge red">ERROR</span>' : r.existing ? (mode() === "update" ? '<span class="badge blue">UPDATE</span>' : '<span class="badge gray">SKIP</span>') : '<span class="badge green">NEW</span>';
        const notes = [
          r.errors.length ? `<span style="color:var(--danger)">${esc(r.errors.map((e) => `${colName[e.key] || labelOf(e.key)}: ${e.problem}`).join("; "))}</span>` : "",
          r.existing ? `<span class="muted">Already exists: ${esc(r.existing.name)}${isParty && r.existing.partyType ? ` (${esc(r.existing.partyType)})` : ""}</span>` : "",
          r.merged.length ? `<span class="muted">Duplicate rows ${r.merged.join(", ")} merged into this row</span>` : "",
          r.active ? "" : '<span class="badge gray">Inactive</span>'
        ].filter(Boolean).join(" · ");
        return `<tr><td class="num">${r.line}</td><td>${esc(r.rec.name)}</td>${isParty ? `<td>${esc(String(r.rec.partyType).replace(/^!/, ""))}</td><td class="mono">${esc(r.rec.gstin)}</td>` : `<td>${esc(r.rec.category)}</td><td>${esc(r.rec.unit)}</td>`}<td>${action}</td><td class="small">${notes}</td></tr>`;
      }).join("");
      const updates = mode() === "update" ? valid.filter((r) => r.existing).length : 0;
      const adds = valid.filter((r) => !r.existing).length;
      modal.el.querySelector("#confirmImport").textContent = `Import ${adds} new${updates ? ` + update ${updates}` : ""}`;
      modal.el.querySelector("#confirmImport").disabled = !valid.length;
    };
    modal.el.querySelectorAll("input[name=dupMode]").forEach((el) => el.addEventListener("change", renderRows));
    renderRows();
    modal.el.querySelector("#errorReport")?.addEventListener("click", () => exportExcel(errorList.map((e) => ({ Row: e.row, Column: e.column, Name: e.name, Problem: e.problem })), `CCPL_${type}_import_errors_${isoDate()}.xlsx`, "Errors"));

    modal.el.querySelector("#confirmImport").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      const update = mode() === "update";
      const plan = valid.filter((r) => !r.existing || update);
      const skipped = valid.length - plan.length;
      const writeOf = ({ rec, existing, active, hasStatus, zohoId }) => {
        const ref = existing ? doc(db, cfg.collection, existing.id) : doc(collection(db, cfg.collection));
        // Never erase existing data with blank cells; merge Customer/Supplier into Both.
        const data = Object.fromEntries(Object.entries(rec).filter(([, v]) => v !== "" && v !== null));
        if (existing) delete data.name; // the record keeps its name; matching was by GSTIN / name
        if (isParty && existing) data.partyType = mergeTypes(existing.partyType, rec.partyType);
        const extra = existing ? { ...(hasStatus ? { active } : {}) } : { active, createdAt: serverTimestamp() };
        return { ref, data: { ...data, ...extra, ...(zohoId ? { zohoId } : {}), updatedAt: serverTimestamp() } };
      };
      const done = busy(button, "Importing…");
      const failed = [];
      let added = 0; let updated = 0;
      try {
        // Small batches: each write is checked by the security rules, which limit document reads per request.
        const CHUNK = 15;
        for (let i = 0; i < plan.length; i += CHUNK) {
          button.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Importing ${Math.min(i + CHUNK, plan.length)} / ${plan.length}…`;
          const chunk = plan.slice(i, i + CHUNK);
          try {
            const batch = writeBatch(db);
            chunk.forEach((r) => { const w = writeOf(r); batch.set(w.ref, w.data, { merge: true }); });
            await batch.commit();
            chunk.forEach((r) => { if (r.existing) updated += 1; else added += 1; });
          } catch {
            // Find the row(s) that failed and keep the rest.
            for (const r of chunk) {
              try {
                const batch = writeBatch(db);
                const w = writeOf(r); batch.set(w.ref, w.data, { merge: true });
                await batch.commit();
                if (r.existing) updated += 1; else added += 1;
              } catch (error) { failed.push({ row: r.line, column: "—", name: r.rec.name, problem: error.code === "permission-denied" ? "Not allowed to save (permission)" : error.message }); }
            }
          }
        }
        const failedTotal = invalid.length + failed.length;
        const batch = writeBatch(db);
        logActivity(batch, { module: cfg.title, action: "IMPORT", refNo: file.name, summary: `Imported ${file.name}: ${added} added, ${updated} updated, ${skipped} skipped (already existed), ${failedTotal} failed` });
        await batch.commit();
        modal.close();
        await load();
        const allFailed = [...errorList, ...failed];
        const report = openModal({
          title: "Import report",
          body: `<div class="grid cols-4" id="importReport">
              <div class="card kpi"><div class="label">Added</div><div class="value" style="color:var(--success)" data-count="added">${added}</div></div>
              <div class="card kpi"><div class="label">Updated</div><div class="value" data-count="updated">${updated}</div></div>
              <div class="card kpi"><div class="label">Skipped</div><div class="value" data-count="skipped">${skipped}</div><div class="hint">already existed</div></div>
              <div class="card kpi"><div class="label">Failed</div><div class="value" style="color:${failedTotal ? "var(--danger)" : "var(--success)"}" data-count="failed">${failedTotal}</div><div class="hint">${failedTotal ? "see list" : "none"}</div></div>
            </div>
            ${allFailed.length ? `<div class="table-wrap" style="max-height:40vh;margin-top:12px"><table class="table"><thead><tr><th>Row</th><th>Column</th><th>Name</th><th>Problem</th></tr></thead><tbody>${allFailed.map((e) => `<tr><td class="num">${e.row}</td><td>${esc(e.column)}</td><td>${esc(e.name || "—")}</td><td style="color:var(--danger)">${esc(e.problem)}</td></tr>`).join("")}</tbody></table></div>` : ""}`,
          footer: `${allFailed.length ? '<button class="btn" id="dlFailed"><i class="fa-solid fa-download"></i> Download failed rows</button>' : ""}<button class="btn primary" data-close>Done</button>`
        });
        report.el.querySelector("#dlFailed")?.addEventListener("click", () => exportExcel(allFailed.map((e) => ({ Row: e.row, Column: e.column, Name: e.name, Problem: e.problem })), `CCPL_${type}_import_failed_${isoDate()}.xlsx`, "Failed"));
      } catch (error) { reportError(error); } finally { done(); }
    });
  }

  page.querySelector("#search").addEventListener("input", render);
  page.querySelector("#catFilter")?.addEventListener("change", render);
  page.querySelector("#typeFilter")?.addEventListener("change", render);
  page.querySelector("#showInactive").addEventListener("change", render);
  page.querySelector("#addBtn")?.addEventListener("click", () => openEditor());
  page.querySelector("#templateBtn")?.addEventListener("click", openTemplate);
  page.querySelector("#importBtn")?.addEventListener("click", pickFile);
  page.querySelector("#exportBtn").addEventListener("click", () => {
    if (!records.length) { toast("Nothing to export."); return; }
    exportExcel(records.map((r) => Object.fromEntries([...cfg.fields.map((f) => [f.label, r[f.key] ?? ""]), ["Status", r.active === false ? "Inactive" : "Active"]])), `CCPL_${type}.xlsx`, cfg.title);
  });
  await load();
  document.body.dataset.loaded = "1";
}
