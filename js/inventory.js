import {
  db, reportError, state, initPage, pageHeader, esc, toast, openModal, listCollection, qty, fmtDateTime, isoDate, round, busy, formValues, can,
  activeWarehouses, warehouseByCode, warehouseOptions, exportExcel, ITEM_CATEGORIES, reserveNumber, commitNumber, readStock, applyMovements, logActivity
} from "./core.js";
import { collection, doc, getDocs, query, runTransaction, serverTimestamp, where } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { uploadFiles } from "./uploads.js";

const page = await initPage("inventory");
if (page) start();

async function start() {
  let stock = []; let items = [];
  const whs = activeWarehouses();
  page.innerHTML = `${pageHeader("Inventory", "Stock", "Live stock of materials and packaging in every warehouse.",
    `<button class="btn" id="exportBtn"><i class="fa-solid fa-download"></i> Export</button>${can("close") ? '<button class="btn primary" id="openingBtn"><i class="fa-solid fa-box-archive"></i> Add Existing / Opening Stock</button>' : ""}`)}
    <div class="grid cols-4" id="whCards" style="margin-bottom:16px"></div>
    <div class="card">
      <div class="card-head"><div class="toolbar"><input class="input search" id="search" placeholder="Search item…" />
        <select class="input" id="cat"><option value="">All categories</option>${ITEM_CATEGORIES.map((c) => `<option>${c}</option>`).join("")}</select>
        <label class="small muted"><input type="checkbox" id="zero" /> Show zero stock</label></div><span class="small muted" id="count"></span></div>
      <div class="table-wrap"><table class="table"><thead><tr><th>Item</th><th>Category</th><th>Unit</th>${whs.map((w) => `<th class="num">${esc(w.name)}</th>`).join("")}<th class="num">Total</th><th></th></tr></thead><tbody id="rows"></tbody></table></div>
    </div>`;

  const matrix = () => {
    const byItem = new Map();
    items.forEach((i) => byItem.set(i.id, { item: i, per: {}, total: 0 }));
    stock.forEach((s) => {
      if (!byItem.has(s.itemId)) byItem.set(s.itemId, { item: { id: s.itemId, name: s.itemName, unit: s.unit, category: s.category }, per: {}, total: 0 });
      const row = byItem.get(s.itemId);
      row.per[s.warehouse] = (row.per[s.warehouse] || 0) + Number(s.qty || 0);
      row.total += Number(s.qty || 0);
    });
    return [...byItem.values()].sort((a, b) => a.item.name.localeCompare(b.item.name));
  };

  function render() {
    const m = matrix();
    page.querySelector("#whCards").innerHTML = whs.map((w) => {
      const rows = stock.filter((s) => s.warehouse === w.code && s.qty > 0);
      const pkg = rows.filter((s) => s.category === "Packaging");
      return `<div class="card kpi"><div class="label"><i class="fa-solid fa-warehouse"></i>${esc(w.name)}</div><div class="value">${rows.length - pkg.length}</div><div class="hint">materials in stock · ${pkg.length} packaging types</div></div>`;
    }).join("");
    const term = page.querySelector("#search").value.trim().toLowerCase();
    const cat = page.querySelector("#cat").value;
    const zero = page.querySelector("#zero").checked;
    const list = m.filter((r) => (zero || r.total > 0) && (!cat || r.item.category === cat) && (!term || r.item.name.toLowerCase().includes(term)));
    page.querySelector("#count").textContent = `${list.length} items`;
    const rows = page.querySelector("#rows");
    if (!list.length) { rows.innerHTML = `<tr><td class="empty" colspan="${whs.length + 5}">No stock yet. Stock is created by GRN, transfers and adjustments.</td></tr>`; return; }
    rows.innerHTML = list.map((r) => {
      const low = r.item.reorderLevel && r.total < r.item.reorderLevel;
      return `<tr><td class="strong">${esc(r.item.name)}${low ? ' <span class="badge red">Below reorder</span>' : ""}</td><td>${esc(r.item.category || "—")}</td><td>${esc(r.item.unit)}</td>
        ${whs.map((w) => `<td class="num">${r.per[w.code] ? qty(r.per[w.code]) : '<span class="muted">—</span>'}</td>`).join("")}
        <td class="num strong">${qty(r.total)}</td><td><button class="btn sm" data-ledger="${esc(r.item.id)}">Ledger</button></td></tr>`;
    }).join("");
  }

  async function load() {
    [stock, items] = await Promise.all([listCollection("inventory"), listCollection("items")]);
    render();
  }

  async function openLedger(itemId) {
    const item = items.find((i) => i.id === itemId) || { name: stock.find((s) => s.itemId === itemId)?.itemName, unit: "" };
    const snap = await getDocs(query(collection(db, "stockLedger"), where("itemId", "==", itemId)));
    const rows = snap.docs.map((d) => d.data()).sort((a, b) => (b.at?.seconds || 0) - (a.at?.seconds || 0) || (b.at?.nanoseconds || 0) - (a.at?.nanoseconds || 0));
    const modal = openModal({
      title: `Stock ledger · ${item.name}`,
      size: "full",
      body: `<div class="toolbar" style="margin-bottom:12px"><select class="input" id="lw"><option value="">All warehouses</option>${whs.map((w) => `<option value="${esc(w.code)}">${esc(w.name)}</option>`).join("")}</select></div>
        <div class="table-wrap"><table class="table"><thead><tr><th>Date & time</th><th>Warehouse</th><th>Type</th><th>Reference</th><th class="num">In</th><th class="num">Out</th><th class="num">Balance</th><th>Note</th><th>By</th></tr></thead><tbody id="lrows"></tbody></table></div>`,
      footer: '<button class="btn" data-close>Close</button><button class="btn" id="lexp"><i class="fa-solid fa-download"></i> Export</button>'
    });
    const draw = () => {
      const w = modal.el.querySelector("#lw").value;
      const list = rows.filter((r) => !w || r.warehouse === w);
      modal.el.querySelector("#lrows").innerHTML = list.map((r) => `<tr><td class="nowrap">${fmtDateTime(r.at)}</td><td>${esc(warehouseByCode(r.warehouse).name)}</td><td>${esc(r.refType)}</td><td class="nowrap">${esc(r.refNo)}</td><td class="num" style="color:var(--success)">${r.qtyIn ? qty(r.qtyIn) : ""}</td><td class="num" style="color:var(--danger)">${r.qtyOut ? qty(r.qtyOut) : ""}</td><td class="num strong">${qty(r.balance)}</td><td class="small">${esc(r.note)}</td><td class="small">${esc(r.userName)}</td></tr>`).join("") || '<tr><td class="empty" colspan="9">No movements.</td></tr>';
      return list;
    };
    modal.el.querySelector("#lw").addEventListener("change", draw);
    modal.el.querySelector("#lexp").addEventListener("click", () => {
      const list = draw();
      if (!list.length) return;
      exportExcel(list.map((r) => ({ "Date & Time": fmtDateTime(r.at), Warehouse: warehouseByCode(r.warehouse).name, Item: r.itemName, Type: r.refType, Reference: r.refNo, In: r.qtyIn, Out: r.qtyOut, Balance: r.balance, Unit: r.unit, Note: r.note, By: r.userName })), `Ledger_${item.name}_${isoDate()}.xlsx`, "Ledger");
    });
    draw();
  }

  page.addEventListener("click", (e) => { const l = e.target.closest("[data-ledger]"); if (l) openLedger(l.dataset.ledger); });
  ["#search", "#cat", "#zero"].forEach((s) => page.querySelector(s).addEventListener(s === "#search" ? "input" : "change", render));
  page.querySelector("#exportBtn").addEventListener("click", () => {
    const m = matrix().filter((r) => r.total > 0);
    if (!m.length) { toast("Nothing to export."); return; }
    exportExcel(m.map((r) => ({ Item: r.item.name, Category: r.item.category, Unit: r.item.unit, ...Object.fromEntries(whs.map((w) => [w.name, r.per[w.code] || 0])), Total: r.total })), `CCPL_Stock_${isoDate()}.xlsx`, "Stock");
  });
  page.querySelector("#openingBtn")?.addEventListener("click", openOpeningStock);

  // Direct stock that did not come through a PO / GRN (old stock, bulk stock found, migration).
  // Saved as its own entry type with reason, date and user; corrections are reversals, never silent edits.
  function openOpeningStock() {
    const modal = openModal({
      title: "Add Existing / Opening Stock",
      size: "wide",
      body: `<div class="notice info" style="margin-bottom:14px"><i class="fa-solid fa-circle-info"></i><div>Use this only for stock that did <b>not</b> come through a PO / GRN — e.g. stock already lying in the warehouse when the ERP started. It is recorded separately and appears under Exceptions → Stock manually adjusted. To correct it later, an admin reverses it from Write-off / Adjust (history is kept).</div></div>
        <form id="osForm" class="form-grid" novalidate>
          <label class="field"><span>Warehouse <b class="req">*</b></span><select name="warehouse">${warehouseOptions()}</select></label>
          <label class="field span-2"><span>Item <b class="req">*</b></span><select name="itemId"><option value="">Select…</option>${items.filter((i) => i.active !== false).map((i) => `<option value="${esc(i.id)}">${esc(i.name)} (${esc(i.unit)})</option>`).join("")}</select></label>
          <label class="field"><span>Quantity <b class="req">*</b></span><input type="number" step="any" min="0" name="qty" /></label>
          <label class="field"><span>Stock as on date</span><input type="date" name="date" value="${isoDate()}" /></label>
          <label class="field span-3"><span>Reason / source <b class="req">*</b></span><input name="reason" placeholder="e.g. Opening stock physically counted on 01-10-2026" /></label>
          <label class="field span-2"><span>Reference (count sheet no. etc.)</span><input name="reference" /></label>
          <label class="field span-2"><span>Supporting document</span><input type="file" name="file" accept=".pdf,.jpg,.jpeg,.png,.xls,.xlsx" /></label>
        </form>`,
      footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="saveOs"><i class="fa-solid fa-check"></i> Add to stock</button>'
    });
    const f = modal.el.querySelector("#osForm");
    modal.el.querySelector("#saveOs").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      const v = formValues(f);
      const item = items.find((i) => i.id === v.itemId);
      const q = Number(v.qty);
      if (!v.warehouse || !item) { toast("Select the warehouse and item.", "error"); return; }
      if (!Number.isFinite(q) || q <= 0) { toast("Enter a quantity greater than 0.", "error"); return; }
      if (!v.reason) { toast("Enter the reason / source of this stock.", "error"); return; }
      const done = busy(button);
      try {
        const ref = doc(collection(db, "adjustments"));
        const docs = await uploadFiles(`adjustments/${ref.id}`, { attachment: f.file.files[0] });
        const no = await runTransaction(db, async (tx) => {
          const stockMap = await readStock(tx, [{ warehouse: v.warehouse, itemId: item.id }]);
          const number = await reserveNumber(tx, "OS", { date: v.date || isoDate() });
          commitNumber(tx, number, ref.id);
          const it = { id: item.id, name: item.name, unit: item.unit, category: item.category };
          applyMovements(tx, stockMap, [{ warehouse: v.warehouse, item: it, qty: q, note: `Opening / existing stock: ${v.reason}` }], { type: "OPENING STOCK", id: ref.id, no: number.number });
          tx.set(ref, { adjNo: number.number, kind: "OPENING", date: v.date, warehouse: v.warehouse, type: "Opening / existing stock", item: it, qty: round(q), reason: v.reason, reference: v.reference, docs, status: "POSTED", createdAt: serverTimestamp(), createdBy: { uid: state.user.uid, name: state.profile.name || state.user.email } });
          logActivity(tx, { module: "Stock Adjustment", action: "OPENING STOCK", refId: ref.id, refNo: number.number, summary: `${number.number} opening / existing stock +${qty(q)} ${item.unit} ${item.name} at ${warehouseByCode(v.warehouse).name} (as on ${v.date}). ${v.reason}` });
          return number.number;
        });
        toast(`${no} added to stock.`, "ok");
        modal.close();
        await load();
      } catch (error) { reportError(error); } finally { done(); }
    });
  }

  await load();
  document.body.dataset.loaded = "1";
}
