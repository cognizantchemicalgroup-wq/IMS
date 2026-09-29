// Outward / dispatch: deducts product stock AND the packaging used (drums, carboys, bottles…)
// from the dispatching warehouse, and updates the linked Sales Order.
import {
  db, reportError, state, initPage, pageHeader, esc, toast, openModal, confirmDialog, badge, busy, formValues, can, isAdmin,
  listCollection, logActivity, qty, fmtDate, fmtDateTime, isoDate, round, reserveNumber, commitNumber,
  warehouseByCode, warehouseOptions, deriveOrderStatus, readStock, applyMovements, exportExcel, stockId
} from "./core.js";
import { challanSpec, showDocument, safeFileName } from "./pdf.js";
import { collection, doc, runTransaction, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const page = await initPage("outward");
if (page) start();

async function start() {
  let outwards = []; let sos = []; let customers = []; let items = []; let stock = [];
  const canOperate = can("operations");

  page.innerHTML = `${pageHeader("Sales", "Outward / Dispatch", "Dispatch material from a warehouse — product and packaging stock are both deducted.",
    `<button class="btn" id="exportBtn"><i class="fa-solid fa-download"></i> Export</button>${canOperate ? '<button class="btn primary" id="newOut"><i class="fa-solid fa-truck-fast"></i> New Dispatch</button>' : ""}`)}
    <div class="card">
      <div class="card-head"><div class="toolbar"><input class="input search" id="search" placeholder="Search challan, customer, SO, invoice, vehicle…" />
        <select class="input" id="whFilter"><option value="">All warehouses</option>${warehouseOptions("", { includeBlank: false })}</select>
        <input class="input" type="date" id="fromDate" /><input class="input" type="date" id="toDate" /></div><span class="small muted" id="count"></span></div>
      <div class="table-wrap"><table class="table"><thead><tr><th>Challan No.</th><th>Date</th><th>Customer</th><th>SO No.</th><th>From</th><th>Products</th><th>Packaging used</th><th>Invoice</th><th>Vehicle</th><th>Status</th><th></th></tr></thead><tbody id="rows"></tbody></table></div>
    </div>`;

  const filtered = () => {
    const term = page.querySelector("#search").value.trim().toLowerCase();
    const wh = page.querySelector("#whFilter").value;
    const from = page.querySelector("#fromDate").value; const to = page.querySelector("#toDate").value;
    return outwards.filter((o) => (!wh || o.warehouse === wh) && (!from || o.date >= from) && (!to || o.date <= to)
      && (!term || [o.dcNo, o.customer?.name, o.soNo, o.invoiceNo, o.vehicleNo, ...o.lines.map((l) => l.name)].some((v) => String(v || "").toLowerCase().includes(term))));
  };

  function render() {
    const list = filtered();
    page.querySelector("#count").textContent = `${list.length} dispatch${list.length === 1 ? "" : "es"}`;
    const rows = page.querySelector("#rows");
    if (!list.length) { rows.innerHTML = '<tr><td class="empty" colspan="11">No dispatches yet.</td></tr>'; return; }
    rows.innerHTML = list.map((o) => `<tr>
      <td class="strong nowrap">${esc(o.dcNo)}</td><td class="nowrap">${fmtDate(o.date)}</td><td>${esc(o.customer?.name)}</td><td class="nowrap">${esc(o.soNo || "—")}</td>
      <td>${esc(warehouseByCode(o.warehouse).name)}</td>
      <td>${o.lines.map((l) => `${esc(l.name)} <b>${qty(l.qty)} ${esc(l.unit)}</b>`).join("<br>")}</td>
      <td class="small">${(o.packaging || []).map((p) => `${esc(p.name)} × ${qty(p.qty)}`).join("<br>") || '<span class="muted">Bulk</span>'}</td>
      <td>${esc(o.invoiceNo || "—")}</td><td>${esc(o.vehicleNo || "—")}</td><td>${badge(o.status)}</td>
      <td><div class="actions"><button class="btn sm" data-dc="${esc(o.id)}" title="Delivery challan PDF"><i class="fa-solid fa-file-pdf"></i></button>${isAdmin() && o.status === "POSTED" ? `<button class="btn sm danger" data-cancel="${esc(o.id)}">Cancel</button>` : ""}</div></td>
    </tr>`).join("");
  }

  async function load() {
    [outwards, sos, customers, items, stock] = await Promise.all([
      listCollection("outwards", "createdAt", "desc"), listCollection("salesOrders", "createdAt", "desc"),
      listCollection("customers"), listCollection("items"), listCollection("inventory")
    ]);
    render();
  }

  const available = (wh, itemId) => Number(stock.find((s) => s.id === stockId(wh, itemId))?.qty || 0);
  const packagingItems = () => items.filter((i) => i.category === "Packaging" && i.active !== false);
  const productItems = () => items.filter((i) => i.category !== "Packaging" && i.active !== false);

  page.addEventListener("click", (event) => {
    const dc = event.target.closest("[data-dc]");
    if (dc) { const o = outwards.find((x) => x.id === dc.dataset.dc); showDocument(challanSpec(o), `${safeFileName(o.dcNo)}.pdf`); return; }
    const c = event.target.closest("[data-cancel]");
    if (c) cancelOutward(outwards.find((x) => x.id === c.dataset.cancel));
  });
  ["#search", "#whFilter", "#fromDate", "#toDate"].forEach((s) => page.querySelector(s).addEventListener(s === "#search" ? "input" : "change", render));
  page.querySelector("#newOut")?.addEventListener("click", openForm);
  page.querySelector("#exportBtn").addEventListener("click", () => {
    const rows = filtered().flatMap((o) => o.lines.map((l) => ({
      "Challan No": o.dcNo, Date: fmtDate(o.date), Customer: o.customer?.name, "SO No": o.soNo || "", From: warehouseByCode(o.warehouse).name,
      Product: l.name, Qty: l.qty, Unit: l.unit, "Packed In": l.packing?.itemName || "Bulk", Containers: l.packing?.count || "", Batch: l.batchNo || "",
      "Invoice No": o.invoiceNo, Vehicle: o.vehicleNo, Transporter: o.transporter, "LR No": o.lrNo, Status: o.status, "Entered By": o.createdBy?.name, "Entered At": fmtDateTime(o.createdAt)
    })));
    if (!rows.length) { toast("Nothing to export."); return; }
    exportExcel(rows, `CCPL_Outward_${isoDate()}.xlsx`, "Outward");
  });

  /* ---------------- Form ---------------- */
  function openForm() {
    const openSos = sos.filter((s) => ["OPEN", "PARTIALLY DISPATCHED"].includes(s.status));
    let lines = [];
    let extras = [];
    const modal = openModal({
      title: "New Dispatch (Outward)",
      size: "full",
      body: `<form id="oForm" novalidate>
        <div class="form-grid">
          <label class="field"><span>Dispatch Against</span><select name="mode"><option value="SO">Sales Order</option><option value="DIRECT">Direct (no SO)</option></select></label>
          <label class="field span-2" data-so><span>Sales Order <b class="req">*</b></span><select name="soId"><option value="">Select open SO…</option>${openSos.map((s) => `<option value="${esc(s.id)}">${esc(s.soNo)} · ${esc(s.customer?.name)}</option>`).join("")}</select></label>
          <label class="field span-2" data-direct hidden><span>Customer <b class="req">*</b></span><select name="customerId"><option value="">Select…</option>${customers.filter((c) => c.active !== false).map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("")}</select></label>
          <label class="field"><span>Dispatch From <b class="req">*</b></span><select name="warehouse">${warehouseOptions()}</select></label>
          <label class="field"><span>Date <b class="req">*</b></span><input type="date" name="date" value="${isoDate()}" /></label>
          <label class="field"><span>Tax Invoice No.</span><input name="invoiceNo" /></label>
          <label class="field"><span>Vehicle No.</span><input name="vehicleNo" /></label>
          <label class="field"><span>Transporter</span><input name="transporter" /></label>
          <label class="field"><span>LR No.</span><input name="lrNo" /></label>
          <label class="field"><span>E-way Bill No.</span><input name="ewayBill" /></label>
          <label class="field span-2"><span>Remarks</span><input name="remarks" /></label>
        </div>
        <div class="section-title">Products</div>
        <div class="table-wrap"><table class="table"><thead><tr><th style="min-width:200px">Product</th><th class="num">Qty</th><th>Unit</th><th class="num">In stock</th><th style="min-width:170px">Packed In</th><th class="num">Qty per container</th><th class="num">Containers</th><th>Batch</th><th></th></tr></thead><tbody id="lineRows"></tbody></table></div>
        <button type="button" class="btn sm" id="addLine" style="margin-top:8px"><i class="fa-solid fa-plus"></i> Add product</button>
        <div class="section-title">Other packaging material used</div>
        <div class="table-wrap"><table class="table"><thead><tr><th style="min-width:200px">Packaging item</th><th class="num">Qty</th><th></th></tr></thead><tbody id="extraRows"></tbody></table></div>
        <button type="button" class="btn sm" id="addExtra" style="margin-top:8px"><i class="fa-solid fa-plus"></i> Add packaging (caps, labels, pallets…)</button>
        <div class="section-title">Stock that will be deducted</div>
        <div id="deduction"></div>
      </form>`,
      footer: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="saveOut"><i class="fa-solid fa-truck-fast"></i> Post Dispatch</button>`
    });
    const form = modal.el.querySelector("#oForm");
    const so = () => sos.find((s) => s.id === form.soId.value);
    const blankLine = () => ({ itemId: "", qty: "", packItemId: "", packSize: "", containers: "", batchNo: "", soLineId: "" });

    function renderLines() {
      const wh = form.warehouse.value;
      modal.el.querySelector("#lineRows").innerHTML = lines.map((l, i) => {
        const it = items.find((x) => x.id === l.itemId);
        const soLine = so()?.lines.find((x) => x.lineId === l.soLineId);
        return `<tr data-i="${i}">
          <td>${soLine ? `<b>${esc(soLine.name)}</b><div class="small muted">SO pending ${qty(Math.max(0, soLine.qty - (soLine.dispatchedQty || 0)))} ${esc(soLine.unit)}</div>` : `<select data-f="itemId"><option value="">Select…</option>${productItems().map((x) => `<option value="${esc(x.id)}" ${x.id === l.itemId ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select>`}</td>
          <td><input data-f="qty" type="number" step="any" min="0" value="${esc(l.qty)}" class="num" /></td>
          <td>${esc(it?.unit || soLine?.unit || "—")}</td>
          <td class="num ${wh && it && available(wh, it.id) < Number(l.qty || 0) ? "strong" : ""}" style="color:${wh && it && available(wh, it.id) < Number(l.qty || 0) ? "var(--danger)" : "inherit"}">${wh && it ? qty(available(wh, it.id)) : "—"}</td>
          <td><select data-f="packItemId"><option value="">Bulk / tanker (no packaging)</option>${packagingItems().map((p) => `<option value="${esc(p.id)}" ${p.id === l.packItemId ? "selected" : ""}>${esc(p.name)}${p.capacity ? ` (${qty(p.capacity)} ${esc(p.capacityUnit || "")})` : ""}</option>`).join("")}</select></td>
          <td><input data-f="packSize" type="number" step="any" min="0" value="${esc(l.packSize)}" class="num" ${l.packItemId ? "" : "disabled"} /></td>
          <td><input data-f="containers" type="number" step="1" min="0" value="${esc(l.containers)}" class="num" ${l.packItemId ? "" : "disabled"} /></td>
          <td><input data-f="batchNo" value="${esc(l.batchNo)}" /></td>
          <td>${lines.length > 1 ? '<button type="button" class="icon-btn" data-rm><i class="fa-solid fa-trash"></i></button>' : ""}</td>
        </tr>`;
      }).join("");
      modal.el.querySelector("#extraRows").innerHTML = extras.map((e, i) => `<tr data-x="${i}">
        <td><select data-xf="itemId"><option value="">Select…</option>${packagingItems().map((p) => `<option value="${esc(p.id)}" ${p.id === e.itemId ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></td>
        <td><input data-xf="qty" type="number" step="any" min="0" value="${esc(e.qty)}" class="num" /></td>
        <td><button type="button" class="icon-btn" data-xrm><i class="fa-solid fa-trash"></i></button></td></tr>`).join("") || '<tr><td colspan="3" class="muted small">None</td></tr>';
      renderDeduction();
    }

    function movementsPreview() {
      const wh = form.warehouse.value;
      const map = new Map();
      const add = (itemId, q) => { if (!itemId || !(q > 0)) return; map.set(itemId, round((map.get(itemId) || 0) + q)); };
      lines.forEach((l) => { add(l.itemId, Number(l.qty)); if (l.packItemId) add(l.packItemId, Number(l.containers)); });
      extras.forEach((e) => add(e.itemId, Number(e.qty)));
      return [...map.entries()].map(([itemId, q]) => ({ item: items.find((x) => x.id === itemId), qty: q, available: wh ? available(wh, itemId) : 0 }));
    }

    function renderDeduction() {
      const wh = form.warehouse.value;
      const rows = movementsPreview();
      modal.el.querySelector("#deduction").innerHTML = !wh ? '<p class="muted">Select the dispatch warehouse.</p>' : rows.length ? `<table class="table"><thead><tr><th>Item</th><th>Type</th><th class="num">Deduct</th><th class="num">Available at ${esc(warehouseByCode(wh).name)}</th><th class="num">Balance after</th></tr></thead><tbody>
        ${rows.map((r) => `<tr><td class="strong">${esc(r.item?.name)}</td><td>${esc(r.item?.category)}</td><td class="num">${qty(r.qty)} ${esc(r.item?.unit)}</td><td class="num">${qty(r.available)}</td><td class="num strong" style="color:${r.available - r.qty < 0 ? "var(--danger)" : "var(--success)"}">${qty(round(r.available - r.qty))}</td></tr>`).join("")}</tbody></table>` : '<p class="muted">Add products.</p>';
    }

    function loadFromSo() {
      const s = so();
      if (!s) { lines = [blankLine()]; renderLines(); return; }
      if (s.warehouse) form.warehouse.value = s.warehouse;
      lines = s.lines.filter((l) => l.qty - (l.dispatchedQty || 0) > 0.0005).map((l) => {
        return { ...blankLine(), soLineId: l.lineId, itemId: l.itemId, qty: round(l.qty - (l.dispatchedQty || 0)) };
      });
      renderLines();
    }

    const tbody = modal.el.querySelector("#lineRows");
    tbody.addEventListener("change", (e) => {
      const tr = e.target.closest("tr"); const f = e.target.dataset.f; if (!tr || !f || e.target.tagName !== "SELECT") return;
      const l = lines[Number(tr.dataset.i)];
      l[f] = e.target.value;
      if (f === "packItemId") {
        const p = items.find((x) => x.id === l.packItemId);
        l.packSize = p?.capacity || "";
        l.containers = p && Number(l.packSize) > 0 ? Math.ceil(Number(l.qty || 0) / Number(l.packSize)) : "";
      }
      renderLines();
    });
    // Text inputs update in place (re-rendering while an input is blurring breaks the DOM).
    tbody.addEventListener("input", (e) => {
      const tr = e.target.closest("tr"); const f = e.target.dataset.f; if (!tr || !f || e.target.tagName !== "INPUT") return;
      const l = lines[Number(tr.dataset.i)];
      l[f] = e.target.value;
      if (["qty", "packSize"].includes(f) && l.packItemId && Number(l.packSize) > 0) {
        l.containers = Math.ceil(Number(l.qty || 0) / Number(l.packSize));
        tr.querySelector('[data-f="containers"]').value = l.containers;
      }
      renderDeduction();
    });
    tbody.addEventListener("click", (e) => { if (e.target.closest("[data-rm]")) { lines.splice(Number(e.target.closest("tr").dataset.i), 1); renderLines(); } });
    const extraBody = modal.el.querySelector("#extraRows");
    const setExtra = (e) => { const tr = e.target.closest("tr"); if (!tr?.dataset.x || !e.target.dataset.xf) return; extras[Number(tr.dataset.x)][e.target.dataset.xf] = e.target.value; renderDeduction(); };
    extraBody.addEventListener("change", setExtra);
    extraBody.addEventListener("input", setExtra);
    extraBody.addEventListener("click", (e) => { if (e.target.closest("[data-xrm]")) { extras.splice(Number(e.target.closest("tr").dataset.x), 1); renderLines(); } });
    modal.el.querySelector("#addLine").addEventListener("click", () => { lines.push(blankLine()); renderLines(); });
    modal.el.querySelector("#addExtra").addEventListener("click", () => { extras.push({ itemId: "", qty: "" }); renderLines(); });
    form.mode.addEventListener("change", () => {
      const isSo = form.mode.value === "SO";
      form.querySelectorAll("[data-so]").forEach((el) => { el.hidden = !isSo; });
      form.querySelectorAll("[data-direct]").forEach((el) => { el.hidden = isSo; });
      if (!isSo) form.soId.value = "";
      loadFromSo();
    });
    form.soId.addEventListener("change", loadFromSo);
    form.warehouse.addEventListener("change", renderLines);
    loadFromSo();

    modal.el.querySelector("#saveOut").addEventListener("click", async (event) => {
      const v = formValues(form);
      const s = so();
      let clean; let packaging;
      try {
        if (v.mode === "SO" && !s) throw new Error("Select the sales order.");
        if (v.mode === "DIRECT" && !v.customerId) throw new Error("Select the customer.");
        if (!v.warehouse) throw new Error("Select the dispatch warehouse.");
        clean = lines.filter((l) => l.itemId && Number(l.qty) > 0).map((l) => {
          const it = items.find((x) => x.id === l.itemId);
          const pack = items.find((x) => x.id === l.packItemId);
          const count = Number(l.containers);
          if (pack && (!Number.isInteger(count) || count <= 0)) throw new Error(`${it.name}: enter the number of ${pack.name} used.`);
          return { itemId: it.id, name: it.name, unit: it.unit, category: it.category, hsn: it.hsn || "", qty: round(Number(l.qty)), batchNo: l.batchNo, soLineId: l.soLineId || "",
            packing: pack ? { itemId: pack.id, itemName: pack.name, size: Number(l.packSize) || null, count } : null };
        });
        if (!clean.length) throw new Error("Enter at least one product quantity.");
        const packMap = new Map();
        clean.forEach((l) => { if (l.packing) packMap.set(l.packing.itemId, (packMap.get(l.packing.itemId) || 0) + l.packing.count); });
        extras.filter((e) => e.itemId && Number(e.qty) > 0).forEach((e) => packMap.set(e.itemId, (packMap.get(e.itemId) || 0) + Number(e.qty)));
        packaging = [...packMap.entries()].map(([id, q]) => { const p = items.find((x) => x.id === id); return { itemId: id, name: p.name, unit: p.unit, qty: round(q) }; });
        if (s) {
          clean.forEach((l) => {
            const sl = s.lines.find((x) => x.lineId === l.soLineId);
            if (sl && l.qty > round(sl.qty - (sl.dispatchedQty || 0)) + 0.0005) throw new Error(`${l.name}: dispatch qty is more than the SO balance (${qty(sl.qty - (sl.dispatchedQty || 0))} ${sl.unit}).`);
          });
        }
      } catch (error) { toast(error.message, "error"); return; }
      const customer = s ? s.customer : customers.find((c) => c.id === v.customerId);
      const wh = warehouseByCode(v.warehouse);
      const done = busy(event.currentTarget, "Posting…");
      try {
        const ref = doc(collection(db, "outwards"));
        const dcNo = await runTransaction(db, async (tx) => {
          let soRef = null; let soData = null;
          if (s) {
            soRef = doc(db, "salesOrders", s.id);
            soData = (await tx.get(soRef)).data();
            if (!["OPEN", "PARTIALLY DISPATCHED"].includes(soData.status)) throw new Error(`Sales order is ${soData.status}.`);
          }
          const movements = [
            ...clean.map((l) => ({ warehouse: wh.code, item: { id: l.itemId, name: l.name, unit: l.unit, category: l.category }, qty: -l.qty, note: `Dispatch to ${customer.name}` })),
            ...packaging.map((p) => ({ warehouse: wh.code, item: { id: p.itemId, name: p.name, unit: p.unit, category: "Packaging" }, qty: -p.qty, note: `Packaging for dispatch to ${customer.name}` }))
          ];
          const stockMap = await readStock(tx, movements.map((m) => ({ warehouse: m.warehouse, itemId: m.item.id })));
          const number = await reserveNumber(tx, "DC", { date: v.date });
          commitNumber(tx, number);
          applyMovements(tx, stockMap, movements, { type: "OUTWARD", id: ref.id, no: number.number });
          tx.set(ref, {
            dcNo: number.number, date: v.date, status: "POSTED", soId: s?.id || "", soNo: s?.soNo || "",
            customer: { id: customer.id, name: customer.name, gstin: customer.gstin || "", address1: customer.address1 || "", address2: customer.address2 || "", city: customer.city || "", pincode: customer.pincode || "", state: customer.state || "", country: customer.country || "India" },
            warehouse: wh.code, warehouseName: wh.name, warehouseAddress: wh.addressLines || [],
            invoiceNo: v.invoiceNo, vehicleNo: v.vehicleNo.toUpperCase(), transporter: v.transporter, lrNo: v.lrNo, ewayBill: v.ewayBill, remarks: v.remarks,
            lines: clean, packaging, createdAt: serverTimestamp(), createdBy: { uid: state.user.uid, name: state.profile.name || state.user.email }
          });
          if (soRef) {
            const soLines = soData.lines.map((l) => { const d = clean.filter((c) => c.soLineId === l.lineId).reduce((a, c) => a + c.qty, 0); return d ? { ...l, dispatchedQty: round((l.dispatchedQty || 0) + d) } : l; });
            const status = deriveOrderStatus({ ...soData, lines: soLines }, "dispatchedQty");
            tx.update(soRef, { lines: soLines, status, updatedAt: serverTimestamp() });
            logActivity(tx, { module: "Sales Orders", action: "DISPATCH", refId: s.id, refNo: soData.soNo, summary: `${number.number}: dispatched ${clean.map((l) => `${qty(l.qty)} ${l.unit} ${l.name}`).join(", ")} → ${status}` });
          }
          logActivity(tx, { module: "Outward", action: "DISPATCH", refId: ref.id, refNo: number.number, summary: `${number.number} to ${customer.name} from ${wh.name}: ${clean.map((l) => `${qty(l.qty)} ${l.unit} ${l.name}`).join(", ")}${packaging.length ? ` · packaging ${packaging.map((p) => `${qty(p.qty)} ${p.name}`).join(", ")}` : ""}` });
          return number.number;
        });
        toast(`${dcNo} posted — stock deducted.`, "ok");
        modal.close();
        await load();
        const fresh = outwards.find((o) => o.dcNo === dcNo);
        if (fresh) showDocument(challanSpec(fresh), `${safeFileName(dcNo)}.pdf`);
      } catch (error) { reportError(error); } finally { done(); }
    });
  }

  async function cancelOutward(o) {
    const reason = await confirmDialog(`Cancel ${o.dcNo}? All product and packaging stock will be added back to ${warehouseByCode(o.warehouse).name}${o.soNo ? ` and ${o.soNo} will be updated` : ""}.`, { title: "Cancel dispatch", danger: true, okText: "Cancel dispatch", input: { label: "Reason", required: true } });
    if (!reason) return;
    try {
      await runTransaction(db, async (tx) => {
        const ref = doc(db, "outwards", o.id);
        const cur = (await tx.get(ref)).data();
        if (cur.status !== "POSTED") throw new Error("Already cancelled.");
        let soRef = null; let soData = null;
        if (cur.soId) { soRef = doc(db, "salesOrders", cur.soId); soData = (await tx.get(soRef)).data(); }
        const movements = [
          ...cur.lines.map((l) => ({ warehouse: cur.warehouse, item: { id: l.itemId, name: l.name, unit: l.unit, category: l.category }, qty: l.qty, note: `Cancelled ${cur.dcNo}` })),
          ...(cur.packaging || []).map((p) => ({ warehouse: cur.warehouse, item: { id: p.itemId, name: p.name, unit: p.unit, category: "Packaging" }, qty: p.qty, note: `Cancelled ${cur.dcNo}` }))
        ];
        const stockMap = await readStock(tx, movements.map((m) => ({ warehouse: m.warehouse, itemId: m.item.id })));
        applyMovements(tx, stockMap, movements, { type: "OUTWARD CANCEL", id: o.id, no: cur.dcNo });
        tx.update(ref, { status: "CANCELLED", cancelReason: reason, cancelledAt: serverTimestamp(), cancelledBy: { uid: state.user.uid, name: state.profile.name || state.user.email } });
        if (soRef) {
          const soLines = soData.lines.map((l) => { const d = cur.lines.filter((c) => c.soLineId === l.lineId).reduce((a, c) => a + c.qty, 0); return d ? { ...l, dispatchedQty: round(Math.max(0, (l.dispatchedQty || 0) - d)) } : l; });
          const base = soData.status === "COMPLETED" ? { ...soData, status: "OPEN" } : soData;
          tx.update(soRef, { lines: soLines, status: deriveOrderStatus({ ...base, lines: soLines }, "dispatchedQty"), updatedAt: serverTimestamp() });
          logActivity(tx, { module: "Sales Orders", action: "DISPATCH CANCELLED", refId: cur.soId, refNo: cur.soNo, summary: `${cur.dcNo} cancelled. Reason: ${reason}` });
        }
        logActivity(tx, { module: "Outward", action: "CANCEL", refId: o.id, refNo: cur.dcNo, summary: `Cancelled ${cur.dcNo}; stock returned to ${warehouseByCode(cur.warehouse).name}. Reason: ${reason}` });
      });
      toast(`${o.dcNo} cancelled.`, "ok");
      await load();
    } catch (error) { reportError(error); }
  }

  await load();
}
