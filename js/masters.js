// Generic master-data page (Vendors, Customers, Items) with add/edit,
// Excel template download, Excel bulk import (with preview) and export.
import {
  db, reportError, initPage, pageHeader, esc, toast, openModal, badge, busy, formValues, can,
  listCollection, logActivity, loadXLSX, exportExcel, GSTIN_PATTERN, STATE_CODES, ITEM_CATEGORIES, UNITS
} from "./core.js";
import { collection, doc, runTransaction, writeBatch, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const PARTY_FIELDS = [
  { key: "name", label: "Name", required: true, span: 2 },
  { key: "code", label: "Code", help: "Optional short code" },
  { key: "gstin", label: "GSTIN", help: "State code & PAN are filled from GSTIN", upper: true },
  { key: "pan", label: "PAN", upper: true },
  { key: "contactPerson", label: "Contact Person" },
  { key: "phone", label: "Phone" },
  { key: "email", label: "Email", type: "email" },
  { key: "address1", label: "Address Line 1", span: 2 },
  { key: "address2", label: "Address Line 2", span: 2 },
  { key: "city", label: "City" },
  { key: "pincode", label: "PIN Code" },
  { key: "state", label: "State" },
  { key: "stateCode", label: "State Code", help: "e.g. 27 for Maharashtra" },
  { key: "country", label: "Country", default: "India" },
  { key: "paymentTermsDays", label: "Payment Terms (days)", type: "number" },
  { key: "bankName", label: "Bank Name" },
  { key: "bankAccount", label: "Bank A/c No." },
  { key: "bankIfsc", label: "IFSC", upper: true },
  { key: "notes", label: "Notes", span: 3 }
];

const ITEM_FIELDS = [
  { key: "name", label: "Item Name", required: true, span: 2 },
  { key: "code", label: "Item Code" },
  { key: "category", label: "Category", required: true, options: ITEM_CATEGORIES },
  { key: "hsn", label: "HSN / SAC" },
  { key: "unit", label: "Unit", required: true, options: UNITS },
  { key: "gstRate", label: "GST %", type: "number", default: "18" },
  { key: "capacity", label: "Pack Capacity", type: "number", help: "Packaging only: e.g. 200 for a 200 L drum" },
  { key: "capacityUnit", label: "Capacity Unit", options: ["", "KG", "LTR"], help: "Packaging only" },
  { key: "reorderLevel", label: "Reorder Level", type: "number", help: "Warn when total stock falls below" },
  { key: "description", label: "Description (printed on PO/Quotation)", span: 3 }
];

export const MASTER_CONFIG = {
  parties: { title: "Vendors & Customers", singular: "Party", eyebrow: "Masters", nav: "parties", fields: PARTY_FIELDS, collection: "parties" },
  items: { title: "Items & Packaging", singular: "Item", eyebrow: "Inventory", nav: "items", fields: ITEM_FIELDS, collection: "items" }
};

function normalizeRecord(fields, raw) {
  const rec = {};
  fields.forEach((f) => {
    let v = raw[f.key] ?? raw[f.label] ?? "";
    v = String(v).trim();
    if (f.upper) v = v.toUpperCase();
    if (f.key === "name") v = v.replace(/\s+/g, " ");
    if (f.type === "number") v = v === "" ? null : Number(v);
    rec[f.key] = v;
  });
  if (rec.gstin) {
    if (!rec.stateCode) rec.stateCode = rec.gstin.slice(0, 2);
    if (!rec.pan) rec.pan = rec.gstin.slice(2, 12);
    if (!rec.state && STATE_CODES[rec.stateCode]) rec.state = STATE_CODES[rec.stateCode];
  }
  if (!rec.country && fields === PARTY_FIELDS) rec.country = "India";
  return rec;
}

function validateRecord(fields, rec) {
  const errors = [];
  fields.filter((f) => f.required).forEach((f) => { if (rec[f.key] === "" || rec[f.key] === null) errors.push(`${f.label} is required`); });
  if (rec.gstin && !GSTIN_PATTERN.test(rec.gstin)) errors.push("GSTIN format is invalid");
  if (rec.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(rec.email)) errors.push("Email is invalid");
  if ("category" in rec && rec.category && !ITEM_CATEGORIES.includes(rec.category)) errors.push(`Category must be one of: ${ITEM_CATEGORIES.join(", ")}`);
  fields.filter((f) => f.type === "number").forEach((f) => { if (rec[f.key] !== null && !Number.isFinite(rec[f.key])) errors.push(`${f.label} must be a number`); });
  return errors;
}

/** Map one row of a Zoho Books Vendors/Contacts export onto our party fields. */
function fromZoho(row) {
  const g = (k) => String(row[k] ?? "").replace(/\s*[\r\n]+\s*/g, ", ").replace(/\s{2,}/g, " ").trim();
  const place = g("Place of Contact(With State Code)");
  return {
    mapped: {
      name: g("Display Name") || g("Company Name") || g("Contact Name"),
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
    zohoId: g("Contact ID")
  };
}

const keyOf = (rec) => (rec.gstin ? `gst:${rec.gstin}` : `name:${rec.name.toLowerCase().replace(/\s+/g, " ")}`);

export async function startMasterPage(type) {
  const cfg = MASTER_CONFIG[type];
  const page = await initPage(cfg.nav);
  if (!page) return;
  const editable = can("masters");
  let records = [];

  page.innerHTML = `${pageHeader(cfg.eyebrow, cfg.title, `${cfg.title} master used across POs, quotations, sales orders and stock.`,
    `${editable ? `<button class="btn" id="templateBtn"><i class="fa-solid fa-file-arrow-down"></i> Excel template</button>
     <button class="btn" id="importBtn"><i class="fa-solid fa-file-excel"></i> Import Excel</button>` : ""}
     <button class="btn" id="exportBtn"><i class="fa-solid fa-download"></i> Export</button>
     ${editable ? `<button class="btn primary" id="addBtn"><i class="fa-solid fa-plus"></i> New ${cfg.singular}</button>` : ""}`)}
    <div class="card">
      <div class="card-head"><div class="toolbar"><input class="input search" id="search" placeholder="Search ${cfg.title.toLowerCase()}…" />
        ${type === "items" ? `<select class="input" id="catFilter"><option value="">All categories</option>${ITEM_CATEGORIES.map((c) => `<option>${c}</option>`).join("")}</select>` : ""}
        <label class="small muted"><input type="checkbox" id="showInactive" /> Show inactive</label></div><span class="muted small" id="count"></span></div>
      <div class="table-wrap"><table class="table"><thead>${type === "items"
        ? "<tr><th>Item</th><th>Code</th><th>Category</th><th>HSN</th><th>Unit</th><th class='num'>GST %</th><th class='num'>Capacity</th><th>Status</th><th></th></tr>"
        : "<tr><th>Name</th><th>GSTIN</th><th>City / State</th><th>Contact</th><th>Phone</th><th>Email</th><th>Status</th><th></th></tr>"}</thead><tbody id="rows"></tbody></table></div>
    </div>`;

  const rowsEl = page.querySelector("#rows");
  const render = () => {
    const term = page.querySelector("#search").value.trim().toLowerCase();
    const cat = page.querySelector("#catFilter")?.value || "";
    const showInactive = page.querySelector("#showInactive").checked;
    const list = records.filter((r) => (showInactive || r.active !== false)
      && (!cat || r.category === cat)
      && (!term || Object.values(r).some((v) => typeof v === "string" && v.toLowerCase().includes(term))));
    page.querySelector("#count").textContent = `${list.length} of ${records.length}`;
    if (!list.length) { rowsEl.innerHTML = `<tr><td class="empty" colspan="9">No ${cfg.title.toLowerCase()} yet.${editable ? " Add one or import from Excel." : ""}</td></tr>`; return; }
    rowsEl.innerHTML = list.map((r) => {
      const status = badge(r.active === false ? "INACTIVE" : "ACTIVE");
      const actions = editable ? `<div class="actions"><button class="btn sm" data-edit="${esc(r.id)}">Edit</button></div>` : "";
      return type === "items"
        ? `<tr><td class="strong">${esc(r.name)}<div class="small muted">${esc(r.description || "")}</div></td><td>${esc(r.code || "—")}</td><td>${esc(r.category || "—")}</td><td class="mono">${esc(r.hsn || "—")}</td><td>${esc(r.unit || "—")}</td><td class="num">${esc(r.gstRate ?? "—")}</td><td class="num">${r.capacity ? `${esc(r.capacity)} ${esc(r.capacityUnit || "")}` : "—"}</td><td>${status}</td><td>${actions}</td></tr>`
        : `<tr><td class="strong">${esc(r.name)}${r.code ? `<div class="small muted">${esc(r.code)}</div>` : ""}</td><td class="mono">${esc(r.gstin || "—")}</td><td>${esc([r.city, r.state].filter(Boolean).join(", ") || "—")}</td><td>${esc(r.contactPerson || "—")}</td><td>${esc(r.phone || "—")}</td><td>${esc(r.email || "—")}</td><td>${status}</td><td>${actions}</td></tr>`;
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
      ? `<select name="${f.key}">${f.options.map((o) => `<option value="${esc(o)}" ${String(o) === String(v) ? "selected" : ""}>${esc(o || "—")}</option>`).join("")}</select>`
      : f.span === 3 && f.key !== "notes" ? `<textarea name="${f.key}">${esc(v)}</textarea>`
        : `<input name="${f.key}" type="${f.type === "number" ? "number" : f.type || "text"}" ${f.type === "number" ? 'step="any"' : ""} value="${esc(v)}" />`;
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
      if (errors.length) { toast(errors.join(". "), "error"); return; }
      const dup = records.find((r) => r.id !== record?.id && keyOf(r) === keyOf(rec));
      if (dup) { toast(`A ${cfg.singular.toLowerCase()} with the same ${rec.gstin ? "GSTIN" : "name"} already exists: ${dup.name}`, "error"); return; }
      if (record) rec.active = values.active === "true";
      const done = busy(event.currentTarget);
      try {
        await runTransaction(db, async (tx) => {
          const ref = record ? doc(db, cfg.collection, record.id) : doc(collection(db, cfg.collection));
          tx.set(ref, { ...rec, ...(record ? {} : { active: true, createdAt: serverTimestamp() }), updatedAt: serverTimestamp() }, { merge: true });
          logActivity(tx, { module: cfg.title, action: record ? "UPDATE" : "CREATE", refId: ref.id, refNo: rec.name, summary: `${record ? "Updated" : "Created"} ${cfg.singular.toLowerCase()} ${rec.name}` });
        });
        toast(`${cfg.singular} saved.`, "ok");
        modal.close();
        await load();
      } catch (error) { reportError(error); } finally { done(); }
    });
  }

  async function downloadTemplate() {
    const XLSX = await loadXLSX();
    const header = cfg.fields.map((f) => f.label + (f.required ? " *" : ""));
    const example = type === "items"
      ? ["M S Drum", "PKG-MSD", "Packaging", "73101090", "NOS", 18, 200, "LTR", 50, "MS drum 200 L, open top"]
      : ["Pyramid Technoplast Limited", "V001", "27AACCP5074E3ZF", "", "Mr. Sharma", "9800000000", "sales@example.com", "GAT NO. 420/1, 420/2, 420/3, KHANIVALI", "Khanivali", "Palghar", "401204", "Maharashtra", "27", "India", 30, "", "", "", ""];
    const ws = XLSX.utils.aoa_to_sheet([header, example]);
    ws["!cols"] = header.map((h) => ({ wch: Math.max(14, h.length + 4) }));
    const help = XLSX.utils.aoa_to_sheet([["How to fill this template"], ["• Keep the header row exactly as is. Columns marked * are mandatory."], ["• Delete the example row before importing."], ["• Existing records are matched by GSTIN (or by name when GSTIN is blank) and updated; new rows are added."], type === "items" ? [`• Category must be one of: ${ITEM_CATEGORIES.join(", ")}`] : ["• State Code and PAN are auto-filled from GSTIN when left blank."], type === "items" ? [`• Unit examples: ${UNITS.join(", ")}`] : [""]]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, cfg.title.slice(0, 31));
    XLSX.utils.book_append_sheet(wb, help, "Instructions");
    XLSX.writeFile(wb, `CCPL_${type}_import_template.xlsx`);
  }

  function importExcel() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".xlsx,.xls,.csv";
    input.addEventListener("change", async () => {
      const file = input.files[0];
      if (!file) return;
      const XLSX = await loadXLSX();
      const wb = XLSX.read(await file.arrayBuffer());
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const raw = XLSX.utils.sheet_to_json(sheet, { defval: "" });
      const labelToKey = Object.fromEntries(cfg.fields.flatMap((f) => [[f.label.toLowerCase(), f.key], [`${f.label} *`.toLowerCase(), f.key], [f.key.toLowerCase(), f.key]]));
      const zoho = type !== "items" && raw.length > 0 && ("Display Name" in raw[0] || "Contact ID" in raw[0]);
      const parsed = raw.map((row, index) => {
        let mapped = {};
        let active = true;
        let zohoId = "";
        if (zoho) {
          ({ mapped, active, zohoId } = fromZoho(row));
        } else {
          Object.entries(row).forEach(([k, v]) => { const key = labelToKey[String(k).trim().toLowerCase()]; if (key) mapped[key] = v; });
        }
        const rec = normalizeRecord(cfg.fields, mapped);
        return { line: index + 2, rec, active, zohoId, errors: validateRecord(cfg.fields, rec), merged: [] };
      }).filter((r) => Object.values(r.rec).some((v) => v !== "" && v !== null && v !== "India"));

      // The same party entered twice (same GSTIN, or same name without GSTIN) becomes one record,
      // keeping the most complete row and filling its blanks from the others.
      const filled = (rec) => Object.values(rec).filter((v) => v !== "" && v !== null).length;
      const groups = new Map();
      const rows = [];
      parsed.forEach((p) => {
        const k = p.errors.length || !p.rec.name ? `line:${p.line}` : keyOf(p.rec);
        const prev = groups.get(k);
        if (!prev) { groups.set(k, p); rows.push(p); return; }
        const [base, other] = filled(p.rec) > filled(prev.rec) ? [p.rec, prev.rec] : [prev.rec, p.rec];
        Object.keys(base).forEach((f) => { if ((base[f] === "" || base[f] === null) && other[f] !== "" && other[f] !== null) base[f] = other[f]; });
        prev.rec = base;
        prev.active = prev.active || p.active;
        prev.zohoId ||= p.zohoId;
        prev.merged.push(p.line);
      });
      if (!rows.length) { toast("No rows found in the file.", "error"); return; }
      const byKey = new Map(records.map((r) => [keyOf(r), r]));
      rows.forEach((r) => { r.existing = (r.zohoId && records.find((x) => x.zohoId === r.zohoId)) || byKey.get(keyOf(r.rec)); });
      const valid = rows.filter((r) => !r.errors.length);
      const mergedCount = rows.reduce((n, r) => n + r.merged.length, 0);
      const modal = openModal({
        title: `Import ${cfg.title} — preview`,
        size: "wide",
        body: `<div class="notice ${rows.length === valid.length ? "ok" : "warn"}" style="margin-bottom:12px">${zoho ? "Zoho Books export detected. " : ""}${valid.length} of ${rows.length} rows are valid (${valid.filter((r) => !r.existing).length} new, ${valid.filter((r) => r.existing).length} updates).${mergedCount ? ` ${mergedCount} duplicate row${mergedCount === 1 ? " was" : "s were"} merged (same GSTIN).` : ""} ${rows.length - valid.length ? "Rows with errors will be skipped — fix them in Excel and import again." : ""}</div>
          <div class="table-wrap" style="max-height:50vh"><table class="table"><thead><tr><th>Row</th><th>Name</th><th>${type === "items" ? "Category" : "GSTIN"}</th><th>Action</th><th>Notes</th></tr></thead><tbody>
          ${rows.map((r) => `<tr><td>${r.line}</td><td>${esc(r.rec.name)}</td><td>${esc(type === "items" ? r.rec.category : r.rec.gstin)}</td><td>${r.errors.length ? badge("REJECTED") : r.existing ? '<span class="badge blue">UPDATE</span>' : '<span class="badge green">NEW</span>'}</td><td class="small">${r.errors.length ? `<span style="color:var(--danger)">${esc(r.errors.join("; "))}</span>` : ""}${r.merged.length ? `<span class="muted">Merged with row ${r.merged.join(", ")}</span>` : ""}${r.active ? "" : ' <span class="badge gray">Inactive</span>'}</td></tr>`).join("")}
          </tbody></table></div>`,
        footer: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="confirmImport" ${valid.length ? "" : "disabled"}>Import ${valid.length} rows</button>`
      });
      modal.el.querySelector("#confirmImport").addEventListener("click", async (event) => {
        const done = busy(event.currentTarget, "Importing…");
        try {
          for (let i = 0; i < valid.length; i += 400) {
            const batch = writeBatch(db);
            valid.slice(i, i + 400).forEach(({ rec, existing, active, zohoId }) => {
              const ref = existing ? doc(db, cfg.collection, existing.id) : doc(collection(db, cfg.collection));
              batch.set(ref, { ...rec, active, ...(zohoId ? { zohoId } : {}), ...(existing ? {} : { createdAt: serverTimestamp() }), updatedAt: serverTimestamp() }, { merge: true });
            });
            if (i === 0) logActivity(batch, { module: cfg.title, action: "IMPORT", refNo: file.name, summary: `Imported ${valid.length} ${cfg.title.toLowerCase()} from ${file.name}` });
            await batch.commit();
          }
          toast(`${valid.length} ${cfg.title.toLowerCase()} imported.`, "ok");
          modal.close();
          await load();
        } catch (error) { reportError(error); } finally { done(); }
      });
    });
    input.click();
  }

  page.querySelector("#search").addEventListener("input", render);
  page.querySelector("#catFilter")?.addEventListener("change", render);
  page.querySelector("#showInactive").addEventListener("change", render);
  page.querySelector("#addBtn")?.addEventListener("click", () => openEditor());
  page.querySelector("#templateBtn")?.addEventListener("click", downloadTemplate);
  page.querySelector("#importBtn")?.addEventListener("click", importExcel);
  page.querySelector("#exportBtn").addEventListener("click", () => {
    if (!records.length) { toast("Nothing to export."); return; }
    exportExcel(records.map((r) => Object.fromEntries([...cfg.fields.map((f) => [f.label, r[f.key] ?? ""]), ["Status", r.active === false ? "Inactive" : "Active"]])), `CCPL_${type}.xlsx`, cfg.title);
  });
  await load();
  document.body.dataset.loaded = "1";
}
