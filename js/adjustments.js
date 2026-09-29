// Stock write-off / adjustment: damaged, destroyed, leakage, expired, count corrections.
// Admin can delete (reverse) an adjustment if it was entered by mistake.
import {
  db, reportError, state, initPage, pageHeader, esc, toast, openModal, confirmDialog, badge, busy, formValues, can, isAdmin,
  listCollection, logActivity, qty, fmtDate, fmtDateTime, isoDate, round, reserveNumber, commitNumber,
  warehouseByCode, warehouseOptions, readStock, applyMovements, exportExcel, stockId
} from "./core.js";
import { collection, doc, runTransaction, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { uploadFiles, docLinks } from "./uploads.js";

const TYPES = [
  ["Damaged", -1], ["Destroyed", -1], ["Leakage / Spillage", -1], ["Expired", -1], ["QC Rejected", -1], ["Sample / Consumed", -1],
  ["Physical count — shortage", -1], ["Physical count — excess", 1]
];

const page = await initPage("adjustments");
if (page) start();

async function start() {
  let adjustments = []; let items = []; let stock = [];
  const canPost = can("close");

  page.innerHTML = `${pageHeader("Inventory", "Write-off / Adjust", "Record damaged, destroyed or lost material and physical count corrections.",
    `<button class="btn" id="exportBtn"><i class="fa-solid fa-download"></i> Export</button>${canPost ? '<button class="btn primary" id="newAdj"><i class="fa-solid fa-plus"></i> New Write-off / Adjustment</button>' : ""}`)}
    ${canPost ? "" : '<div class="notice info" style="margin-bottom:14px"><i class="fa-solid fa-circle-info"></i><div>Write-offs can only be posted by a manager or admin.</div></div>'}
    <div class="card"><div class="table-wrap"><table class="table"><thead><tr><th>No.</th><th>Date</th><th>Warehouse</th><th>Type</th><th>Item</th><th class="num">Qty</th><th>Reason</th><th>Photo / Doc</th><th>By</th><th>Status</th><th></th></tr></thead><tbody id="rows"></tbody></table></div></div>`;

  function render() {
    const rows = page.querySelector("#rows");
    if (!adjustments.length) { rows.innerHTML = '<tr><td class="empty" colspan="11">No adjustments recorded.</td></tr>'; return; }
    rows.innerHTML = adjustments.map((a) => `<tr>
      <td class="strong nowrap">${esc(a.adjNo)}</td><td class="nowrap">${fmtDate(a.date)}</td><td>${esc(warehouseByCode(a.warehouse).name)}</td><td>${esc(a.type)}</td>
      <td>${esc(a.item.name)}</td><td class="num strong" style="color:${a.qty < 0 ? "var(--danger)" : "var(--success)"}">${a.qty > 0 ? "+" : ""}${qty(a.qty)} ${esc(a.item.unit)}</td>
      <td>${esc(a.reason)}</td><td class="small">${docLinks(a.docs)}</td><td class="small">${esc(a.createdBy?.name)}<div class="muted">${fmtDateTime(a.createdAt)}</div></td><td>${badge(a.status)}</td>
      <td>${isAdmin() && a.status === "POSTED" ? `<button class="btn sm danger" data-del="${esc(a.id)}">Delete</button>` : ""}</td></tr>`).join("");
  }
  async function load() {
    [adjustments, items, stock] = await Promise.all([listCollection("adjustments", "createdAt", "desc"), listCollection("items"), listCollection("inventory")]);
    render();
  }
  const available = (wh, itemId) => Number(stock.find((s) => s.id === stockId(wh, itemId))?.qty || 0);

  page.addEventListener("click", (e) => { const d = e.target.closest("[data-del]"); if (d) removeAdjustment(adjustments.find((a) => a.id === d.dataset.del)); });
  page.querySelector("#exportBtn").addEventListener("click", () => {
    if (!adjustments.length) { toast("Nothing to export."); return; }
    exportExcel(adjustments.map((a) => ({ No: a.adjNo, Date: fmtDate(a.date), Warehouse: warehouseByCode(a.warehouse).name, Type: a.type, Item: a.item.name, Qty: a.qty, Unit: a.item.unit, Reason: a.reason, Status: a.status, By: a.createdBy?.name, At: fmtDateTime(a.createdAt) })), `CCPL_Stock_Adjustments_${isoDate()}.xlsx`, "Adjustments");
  });
  page.querySelector("#newAdj")?.addEventListener("click", openNew);

  function openNew() {
    const modal = openModal({
      title: "New Write-off / Adjustment",
      size: "wide",
      body: `<form id="aForm" class="form-grid" novalidate>
        <label class="field"><span>Warehouse <b class="req">*</b></span><select name="warehouse">${warehouseOptions()}</select></label>
        <label class="field"><span>Date</span><input type="date" name="date" value="${isoDate()}" /></label>
        <label class="field span-2"><span>Type <b class="req">*</b></span><select name="type">${TYPES.map(([t]) => `<option>${t}</option>`).join("")}</select></label>
        <label class="field span-2"><span>Item <b class="req">*</b></span><select name="itemId"><option value="">Select warehouse first</option></select></label>
        <label class="field"><span>Quantity <b class="req">*</b></span><input type="number" step="any" min="0" name="qty" /></label>
        <label class="field"><span>Available</span><input readonly name="avail" /></label>
        <label class="field span-3"><span>Reason / details <b class="req">*</b></span><input name="reason" placeholder="e.g. 2 drums punctured while unloading at Taloja" /></label>
        <label class="field"><span>Photo / document</span><input type="file" name="file" accept=".pdf,.jpg,.jpeg,.png" /></label>
      </form>`,
      footer: `<button class="btn" data-close>Cancel</button><button class="btn danger" id="saveA"><i class="fa-solid fa-check"></i> Post adjustment</button>`
    });
    const f = modal.el.querySelector("#aForm");
    const refreshItems = () => {
      const wh = f.warehouse.value;
      const excess = TYPES.find(([t]) => t === f.type.value)[1] > 0;
      const list = items.filter((i) => i.active !== false && (excess || (wh && available(wh, i.id) > 0)));
      f.itemId.innerHTML = `<option value="">${wh ? "Select item…" : "Select warehouse first"}</option>${wh ? list.map((i) => `<option value="${esc(i.id)}">${esc(i.name)} (${esc(i.category)})</option>`).join("") : ""}`;
      f.avail.value = "";
    };
    f.warehouse.addEventListener("change", refreshItems);
    f.type.addEventListener("change", refreshItems);
    f.itemId.addEventListener("change", () => { const it = items.find((i) => i.id === f.itemId.value); f.avail.value = it ? `${qty(available(f.warehouse.value, it.id))} ${it.unit}` : ""; });
    refreshItems();
    modal.el.querySelector("#saveA").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      const v = formValues(f);
      const sign = TYPES.find(([t]) => t === v.type)[1];
      const q = Number(v.qty);
      const item = items.find((i) => i.id === v.itemId);
      if (!v.warehouse || !item) { toast("Select the warehouse and item.", "error"); return; }
      if (!Number.isFinite(q) || q <= 0) { toast("Enter a quantity greater than 0.", "error"); return; }
      if (!v.reason) { toast("Enter the reason.", "error"); return; }
      if (!(await confirmDialog(`${sign < 0 ? "Remove" : "Add"} ${qty(q)} ${item.unit} of ${item.name} ${sign < 0 ? "from" : "to"} ${warehouseByCode(v.warehouse).name} stock (${v.type})?`, { okText: "Post", danger: sign < 0 }))) return;
      const done = busy(button);
      try {
        const ref = doc(collection(db, "adjustments"));
        const docs = await uploadFiles(`adjustments/${ref.id}`, { attachment: f.file.files[0] });
        const adjNo = await runTransaction(db, async (tx) => {
          const stockMap = await readStock(tx, [{ warehouse: v.warehouse, itemId: item.id }]);
          const number = await reserveNumber(tx, "ADJ", { date: v.date });
          commitNumber(tx, number);
          const it = { id: item.id, name: item.name, unit: item.unit, category: item.category };
          applyMovements(tx, stockMap, [{ warehouse: v.warehouse, item: it, qty: sign * q, note: `${v.type}: ${v.reason}` }], { type: "ADJUSTMENT", id: ref.id, no: number.number });
          tx.set(ref, { adjNo: number.number, date: v.date, warehouse: v.warehouse, type: v.type, item: it, qty: round(sign * q), reason: v.reason, docs, status: "POSTED", createdAt: serverTimestamp(), createdBy: { uid: state.user.uid, name: state.profile.name || state.user.email } });
          logActivity(tx, { module: "Stock Adjustment", action: sign < 0 ? "WRITE-OFF" : "ADJUST IN", refId: ref.id, refNo: number.number, summary: `${number.number} ${v.type}: ${sign < 0 ? "−" : "+"}${qty(q)} ${item.unit} ${item.name} at ${warehouseByCode(v.warehouse).name}. ${v.reason}` });
          return number.number;
        });
        toast(`${adjNo} posted.`, "ok");
        modal.close();
        await load();
      } catch (error) { reportError(error); } finally { done(); }
    });
  }

  async function removeAdjustment(a) {
    const reason = await confirmDialog(`Delete ${a.adjNo}? The stock effect (${a.qty > 0 ? "+" : ""}${qty(a.qty)} ${a.item.unit} ${a.item.name}) will be reversed. The record stays in the activity log.`, { title: "Delete adjustment", danger: true, okText: "Delete & reverse", input: { label: "Reason", required: true } });
    if (!reason) return;
    try {
      await runTransaction(db, async (tx) => {
        const ref = doc(db, "adjustments", a.id);
        const cur = (await tx.get(ref)).data();
        if (cur.status !== "POSTED") throw new Error("Already reversed.");
        const stockMap = await readStock(tx, [{ warehouse: cur.warehouse, itemId: cur.item.id }]);
        applyMovements(tx, stockMap, [{ warehouse: cur.warehouse, item: cur.item, qty: -cur.qty, note: `Reversal of ${cur.adjNo}: ${reason}` }], { type: "ADJUSTMENT REVERSAL", id: a.id, no: cur.adjNo });
        tx.update(ref, { status: "REVERSED", reverseReason: reason, reversedAt: serverTimestamp(), reversedBy: { uid: state.user.uid, name: state.profile.name || state.user.email } });
        logActivity(tx, { module: "Stock Adjustment", action: "DELETE", refId: a.id, refNo: cur.adjNo, summary: `Deleted/reversed ${cur.adjNo} (${cur.type} ${qty(cur.qty)} ${cur.item.unit} ${cur.item.name}). Reason: ${reason}` });
      });
      toast(`${a.adjNo} reversed.`, "ok");
      await load();
    } catch (error) { reportError(error); }
  }

  await load();
  document.body.dataset.loaded = "1";
}
