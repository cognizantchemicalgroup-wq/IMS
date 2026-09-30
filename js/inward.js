// Inward workflow — Kanta is the final truth:
//   PO → Invoice / Gate entry (invoice qty) → GRN (qty physically received) → Kanta (confirmed qty)
//      → stock inward = Kanta qty → payable qty = Kanta qty
// One invoice can carry several PO items; every stage is tracked item-wise against the PO lines,
// and a PO can receive any number of invoices until every line is complete.
import {
  db, reportError, state, initPage, pageHeader, esc, toast, openModal, confirmDialog, badge, busy, formValues, can, isAdmin,
  listCollection, logActivity, qty, money, fmtDate, fmtDateTime, isoDate, round, reserveNumber, commitNumber,
  warehouseByCode, warehouseOptions, deriveOrderStatus, readStock, applyMovements, exportExcel, OPEN_PO_STATUSES, normalizeReceipt
} from "./core.js";
import { collection, doc, runTransaction, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { uploadFiles, docLinks } from "./uploads.js";

const page = await initPage("inward");
if (page) start();

const RECEIVED_AS = ["Tanker", "Drums", "IBC", "Carboys", "Bags", "Bottles / Boxes", "Loose", "Other"];
const n = (v) => Number(v) || 0;
const by = () => ({ uid: state.user.uid, name: state.profile.name || state.user.email });

/** Apply per-line deltas to a PO's lines and return { lines, status }. */
function applyPoDeltas(poData, deltas) {
  const lines = poData.lines.map((l) => {
    const d = deltas[l.lineId];
    if (!d) return l;
    const next = { ...l };
    Object.entries(d).forEach(([k, v]) => { next[k] = round(Math.max(0, n(l[k]) + v)); });
    if (d.varianceQty !== undefined) next.varianceQty = round(n(l.varianceQty) + d.varianceQty); // may be negative
    return next;
  });
  const reopened = ["COMPLETED"].includes(poData.status) ? { ...poData, status: "OPEN" } : poData;
  return { lines, status: deriveOrderStatus({ ...reopened, lines }, "receivedQty", state.company.poTolerancePct) };
}

async function start() {
  let receipts = []; let pos = []; let parties = []; let items = [];
  let tab = location.hash === "#kanta" ? "KANTA PENDING" : "GRN PENDING";
  const canOperate = can("operations");

  page.innerHTML = `${pageHeader("Purchase", "Inward · GRN · Kanta", "Invoice → GRN → Kanta. Stock is added only after Kanta, and the Kanta quantity is what is payable.",
    `<button class="btn" id="exportBtn"><i class="fa-solid fa-download"></i> Export</button>${canOperate ? '<button class="btn primary" id="newEntry"><i class="fa-solid fa-file-invoice"></i> New Invoice / Receipt</button>' : ""}`)}
    <div class="tabs" id="tabs"></div>
    <div class="card">
      <div class="card-head"><div class="toolbar"><input class="input search" id="search" placeholder="Search receipt, GRN, PO, invoice, vendor, item, vehicle…" />
      <select class="input" id="whFilter"><option value="">All warehouses</option>${warehouseOptions("", { includeBlank: false })}</select>
      <input class="input" type="date" id="fromDate" title="From date" /><input class="input" type="date" id="toDate" title="To date" /></div><span class="small muted" id="count"></span></div>
      <div class="table-wrap"><table class="table"><thead><tr><th>Receipt</th><th>Date & Time</th><th>PO No.</th><th>Vendor</th><th>Items · Invoice / GRN / Kanta</th><th>Warehouse</th><th>Invoice</th><th>Docs</th><th>Stage</th><th></th></tr></thead><tbody id="rows"></tbody></table></div>
    </div>`;

  const TABS = [["GRN PENDING", "GRN pending"], ["KANTA PENDING", "Awaiting Kanta"], ["COMPLETED", "Inwarded"], ["ALL", "All"]];
  const itemsText = (r) => r.lines.map((l) => l.name).join(" ");

  function filtered() {
    const term = page.querySelector("#search").value.trim().toLowerCase();
    const wh = page.querySelector("#whFilter").value;
    const from = page.querySelector("#fromDate").value;
    const to = page.querySelector("#toDate").value;
    return receipts.filter((r) => (tab === "ALL" || r.stage === tab) && (!wh || r.warehouse === wh)
      && (!from || isoDate(r.createdAt) >= from) && (!to || isoDate(r.createdAt) <= to)
      && (!term || [r.geNo, r.poNo, r.invoiceNo, r.vendor?.name, itemsText(r), r.vehicleNo, r.grn?.grnNo].some((v) => String(v || "").toLowerCase().includes(term))));
  }

  const lineSummary = (r) => r.lines.map((l) => {
    const v = l.kantaQty !== undefined && l.grnQty !== undefined ? round(l.kantaQty - l.grnQty) : null;
    return `<div class="nowrap"><b>${esc(l.name)}</b> <span class="muted">${qty(l.invoiceQty)}</span> / ${l.grnQty !== undefined ? qty(l.grnQty) : "—"} / <b>${l.kantaQty !== undefined ? qty(l.kantaQty) : "—"}</b> ${esc(l.unit)}${v ? ` <span class="badge ${v < 0 ? "red" : "green"}">${v > 0 ? "+" : ""}${qty(v)}</span>` : ""}</div>`;
  }).join("");

  function render() {
    page.querySelector("#tabs").innerHTML = TABS.map(([k, l]) => `<button class="tab ${k === tab ? "active" : ""}" data-tab="${k}">${l}<span class="count">${receipts.filter((r) => k === "ALL" || r.stage === k).length}</span></button>`).join("");
    const list = filtered();
    page.querySelector("#count").textContent = `${list.length} receipt${list.length === 1 ? "" : "s"}`;
    const rows = page.querySelector("#rows");
    if (!list.length) { rows.innerHTML = '<tr><td class="empty" colspan="10">Nothing here.</td></tr>'; return; }
    rows.innerHTML = list.map((r) => {
      let action = "";
      if (canOperate && r.stage === "GRN PENDING") action = `<button class="btn sm primary" data-grn="${esc(r.id)}">GRN</button>`;
      if (canOperate && r.stage === "KANTA PENDING") action = `<button class="btn sm primary" data-kanta="${esc(r.id)}">Kanta</button>`;
      return `<tr>
        <td class="strong nowrap"><a href="#" data-view="${esc(r.id)}">${esc(r.geNo)}</a>${r.grn ? `<div class="small muted">${esc(r.grn.grnNo)}</div>` : ""}</td>
        <td class="nowrap">${fmtDateTime(r.createdAt)}</td>
        <td class="nowrap">${r.poId ? `<a href="purchase-orders.html?open=${esc(r.poId)}">${esc(r.poNo)}</a>` : '<span class="muted">Without PO</span>'}</td>
        <td>${esc(r.vendor?.name)}</td>
        <td class="small">${lineSummary(r)}</td>
        <td>${esc(warehouseByCode(r.warehouse).name)}</td>
        <td>${esc(r.invoiceNo)}<div class="small muted">${fmtDate(r.invoiceDate)}</div></td>
        <td class="small">${docLinks(r.docs)}</td>
        <td>${badge(r.stage === "COMPLETED" ? "INWARDED" : r.stage)}</td>
        <td><div class="actions">${action}</div></td>
      </tr>`;
    }).join("");
  }

  async function load() {
    [receipts, pos, parties, items] = await Promise.all([
      listCollection("receipts", "createdAt", "desc"),
      listCollection("purchaseOrders", "createdAt", "desc"),
      listCollection("parties"),
      listCollection("items")
    ]);
    receipts = receipts.map(normalizeReceipt);
    render();
  }

  page.addEventListener("click", (event) => {
    const t = event.target.closest("[data-tab]");
    if (t) { tab = t.dataset.tab; render(); return; }
    const find = (id) => receipts.find((r) => r.id === id);
    const g = event.target.closest("[data-grn]"); if (g) { openGrn(find(g.dataset.grn)); return; }
    const k = event.target.closest("[data-kanta]"); if (k) { openKanta(find(k.dataset.kanta)); return; }
    const v = event.target.closest("[data-view]"); if (v) { event.preventDefault(); openView(find(v.dataset.view)); }
  });
  ["#search", "#whFilter", "#fromDate", "#toDate"].forEach((s) => page.querySelector(s).addEventListener(s === "#search" ? "input" : "change", render));
  page.querySelector("#newEntry")?.addEventListener("click", openReceiptForm);
  page.querySelector("#exportBtn").addEventListener("click", () => {
    const rows = filtered().flatMap((r) => r.lines.map((l) => ({
      Receipt: r.geNo, "Date & Time": fmtDateTime(r.createdAt), "PO No": r.poNo || "Without PO", Vendor: r.vendor?.name, "Invoice No": r.invoiceNo, "Invoice Date": fmtDate(r.invoiceDate),
      Item: l.name, Unit: l.unit, Warehouse: warehouseByCode(r.warehouse).name, "Invoice Qty": l.invoiceQty, "GRN No": r.grn?.grnNo || "", "GRN Qty": l.grnQty ?? "",
      "Kanta Qty": l.kantaQty ?? "", "Short(-)/Excess(+) vs GRN": l.kantaQty !== undefined ? round(l.kantaQty - l.grnQty) : "", "Invoice vs Kanta": l.kantaQty !== undefined ? round(l.kantaQty - l.invoiceQty) : "",
      "Inward / Payable Qty": l.kantaQty ?? "", Rate: l.rate || "", "Payable Value (before GST)": l.kantaQty !== undefined && l.rate ? round(l.kantaQty * l.rate, 2) : "",
      Stage: r.stage === "COMPLETED" ? "INWARDED" : r.stage, "Vehicle No": r.vehicleNo, "Entered By": r.createdBy?.name || "", "GRN By": r.grn?.by?.name || "", "GRN At": r.grn ? fmtDateTime(r.grn.at) : "",
      "Kanta By": r.kanta?.by?.name || "", "Kanta At": r.kanta ? fmtDateTime(r.kanta.at) : ""
    })));
    if (!rows.length) { toast("Nothing to export."); return; }
    exportExcel(rows, `CCPL_Inward_${isoDate()}.xlsx`, "Inward");
  });

  /* ---------------- 1. Invoice / receipt entry ---------------- */
  function openReceiptForm() {
    const openPos = pos.filter((p) => OPEN_PO_STATUSES.includes(p.status));
    let freeLines = [{ itemId: "", invoiceQty: "" }];
    const modal = openModal({
      title: "New Invoice / Receipt (material arrived)",
      size: "full",
      body: `<form id="geForm" novalidate><div class="form-grid">
        <label class="field"><span>Receive Against <b class="req">*</b></span><select name="mode"><option value="PO">Purchase Order</option><option value="NOPO">Without PO</option></select></label>
        <label class="field span-2" data-po><span>Purchase Order <b class="req">*</b></span><select name="poId"><option value="">Select open PO…</option>${openPos.map((p) => `<option value="${esc(p.id)}">${esc(p.poNo)} · ${esc(p.vendor?.name)}</option>`).join("")}</select></label>
        <label class="field span-2" data-nopo hidden><span>Vendor / Party <b class="req">*</b></span><select name="vendorId"><option value="">Select…</option>${parties.filter((v) => v.active !== false).map((v) => `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join("")}</select></label>
        <label class="field"><span>Receiving Warehouse <b class="req">*</b></span><select name="warehouse">${warehouseOptions()}</select></label>
        <label class="field"><span>Invoice / Challan No. <b class="req">*</b></span><input name="invoiceNo" /></label>
        <label class="field"><span>Invoice Date</span><input type="date" name="invoiceDate" value="${isoDate()}" /></label>
        <label class="field"><span>Vehicle No.</span><input name="vehicleNo" placeholder="MH46AB1234" /></label>
        <label class="field"><span>Received As</span><select name="receivedAs">${RECEIVED_AS.map((r) => `<option>${r}</option>`).join("")}</select></label>
        <label class="field"><span>No. of Containers</span><input type="number" min="0" step="1" name="containers" /></label>
        <label class="field"><span>Transporter</span><input name="transporter" /></label>
        <label class="field"><span>LR No.</span><input name="lrNo" /></label>
        <label class="field"><span>Supplier Batch / Lot No.</span><input name="supplierLot" /></label>
      </div>
      <div class="section-title">Items on this invoice</div>
      <div id="itemArea"><p class="muted">Select the PO to list its items.</p></div>
      <div class="form-grid" style="margin-top:14px">
        <label class="field span-2"><span>Remarks</span><input name="remarks" /></label>
        <label class="field"><span>Invoice copy</span><input type="file" name="invoiceFile" accept=".pdf,.jpg,.jpeg,.png" /></label>
        <label class="field"><span>Supplier COA</span><input type="file" name="coaFile" accept=".pdf,.jpg,.jpeg,.png" /></label>
        <label class="field span-2"><span>Other documents (E-way bill, LR…)</span><input type="file" name="otherFiles" multiple accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,.xls,.xlsx" /></label>
      </div></form>`,
      footer: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="saveGe"><i class="fa-solid fa-check"></i> Save Invoice / Receipt</button>`
    });
    const form = modal.el.querySelector("#geForm");
    const area = modal.el.querySelector("#itemArea");
    const selectedPo = () => pos.find((p) => p.id === form.poId.value);

    const renderPoLines = () => {
      const po = selectedPo();
      if (!po) { area.innerHTML = '<p class="muted">Select the PO to list its items.</p>'; return; }
      form.warehouse.value = po.warehouse;
      area.innerHTML = `<div class="table-wrap"><table class="table"><thead><tr><th>Item</th><th class="num">PO Qty</th><th class="num">Inwarded</th><th class="num">In process (awaiting GRN/Kanta)</th><th class="num">Pending</th><th class="num" style="width:160px">Qty on this invoice</th></tr></thead><tbody>
        ${po.lines.map((l) => {
          const pending = Math.max(0, round(n(l.qty) - n(l.receivedQty)));
          return `<tr><td class="strong">${esc(l.name)}</td><td class="num">${qty(l.qty)} ${esc(l.unit)}</td><td class="num">${qty(l.receivedQty || 0)}</td><td class="num">${qty(openInvoiced(l))}</td><td class="num strong">${qty(pending)}</td>
            <td><input type="number" step="any" min="0" class="num" data-line="${esc(l.lineId)}" placeholder="0" /></td></tr>`;
        }).join("")}</tbody></table></div><p class="small muted">Enter the quantity for each item on this invoice; leave blank for items not on it.</p>`;
    };
    // invoiced on receipts that have not yet been through Kanta
    const openInvoiced = (l) => receipts.filter((r) => r.poId === form.poId.value && ["GRN PENDING", "KANTA PENDING"].includes(r.stage))
      .reduce((s, r) => s + r.lines.filter((x) => x.poLineId === l.lineId).reduce((a, x) => a + n(x.invoiceQty), 0), 0);

    const renderFreeLines = () => {
      area.innerHTML = `<table class="table"><thead><tr><th>Item</th><th class="num" style="width:160px">Invoice Qty</th><th>Unit</th><th></th></tr></thead><tbody>
        ${freeLines.map((l, i) => { const it = items.find((x) => x.id === l.itemId); return `<tr data-i="${i}"><td><select data-f="itemId"><option value="">Select…</option>${items.filter((x) => x.active !== false).map((x) => `<option value="${esc(x.id)}" ${x.id === l.itemId ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select></td><td><input type="number" step="any" min="0" class="num" data-f="invoiceQty" value="${esc(l.invoiceQty)}" /></td><td>${esc(it?.unit || "—")}</td><td>${freeLines.length > 1 ? '<button type="button" class="icon-btn" data-rm><i class="fa-solid fa-trash"></i></button>' : ""}</td></tr>`; }).join("")}
        </tbody></table><button type="button" class="btn sm" id="addFree" style="margin-top:8px"><i class="fa-solid fa-plus"></i> Add item</button>`;
      area.querySelector("#addFree").addEventListener("click", () => { freeLines.push({ itemId: "", invoiceQty: "" }); renderFreeLines(); });
    };
    area.addEventListener("input", (e) => { const tr = e.target.closest("tr[data-i]"); if (tr && e.target.dataset.f === "invoiceQty") freeLines[Number(tr.dataset.i)].invoiceQty = e.target.value; });
    area.addEventListener("change", (e) => { const tr = e.target.closest("tr[data-i]"); if (tr && e.target.dataset.f === "itemId") { freeLines[Number(tr.dataset.i)].itemId = e.target.value; renderFreeLines(); } });
    area.addEventListener("click", (e) => { if (e.target.closest("[data-rm]")) { freeLines.splice(Number(e.target.closest("tr").dataset.i), 1); renderFreeLines(); } });

    const showMode = () => {
      const isPo = form.mode.value === "PO";
      form.querySelectorAll("[data-po]").forEach((el) => { el.hidden = !isPo; });
      form.querySelectorAll("[data-nopo]").forEach((el) => { el.hidden = isPo; });
      if (isPo) renderPoLines(); else renderFreeLines();
    };
    form.mode.addEventListener("change", showMode);
    form.poId.addEventListener("change", renderPoLines);
    showMode();

    modal.el.querySelector("#saveGe").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      const v = formValues(form);
      const againstPo = v.mode === "PO";
      const po = selectedPo();
      let lines;
      try {
        if (againstPo && !po) throw new Error("Select the purchase order.");
        if (!againstPo && !v.vendorId) throw new Error("Select the vendor.");
        if (!v.warehouse) throw new Error("Select the receiving warehouse.");
        if (!v.invoiceNo) throw new Error("Enter the invoice / challan number.");
        if (againstPo) {
          lines = [...area.querySelectorAll("[data-line]")].map((inp) => ({ l: po.lines.find((x) => x.lineId === inp.dataset.line), q: Number(inp.value) }))
            .filter(({ q }) => Number.isFinite(q) && q > 0)
            .map(({ l, q }) => ({ poLineId: l.lineId, itemId: l.itemId, name: l.name, unit: l.unit, category: l.category || "", hsn: l.hsn || "", rate: n(l.rate), invoiceQty: round(q) }));
        } else {
          lines = freeLines.filter((l) => l.itemId && Number(l.invoiceQty) > 0).map((l) => { const it = items.find((x) => x.id === l.itemId); return { poLineId: "", itemId: it.id, name: it.name, unit: it.unit, category: it.category || "", hsn: it.hsn || "", rate: 0, invoiceQty: round(Number(l.invoiceQty)) }; });
          if (new Set(lines.map((l) => l.itemId)).size !== lines.length) throw new Error("Each item can appear only once per invoice.");
        }
        if (!lines.length) throw new Error("Enter the invoice quantity for at least one item.");
        const vendorId = againstPo ? po.vendorId : v.vendorId;
        const dup = receipts.find((r) => r.stage !== "CANCELLED" && String(r.invoiceNo).toLowerCase() === v.invoiceNo.toLowerCase() && r.vendor?.id === vendorId);
        if (dup) throw new Error(`Invoice ${v.invoiceNo} from this vendor is already entered (${dup.geNo}).`);
      } catch (error) { toast(error.message, "error"); return; }
      if (againstPo) {
        const over = lines.filter((l) => { const pl = po.lines.find((x) => x.lineId === l.poLineId); return l.invoiceQty > round(n(pl.qty) - n(pl.receivedQty) - openInvoiced(pl)) + 0.0005; });
        if (over.length && !(await confirmDialog(`${over.map((l) => l.name).join(", ")}: invoice quantity is more than what is still pending on this PO. Accept the excess?`, { okText: "Accept excess" }))) return;
      }
      const vendor = againstPo ? po.vendor : parties.find((x) => x.id === v.vendorId);
      const ref = doc(collection(db, "receipts"));
      const done = busy(button);
      try {
        const docs = await uploadFiles(`receipts/${ref.id}`, { invoice: form.invoiceFile.files[0], coa: form.coaFile.files[0], other: [...form.otherFiles.files] });
        const geNo = await runTransaction(db, async (tx) => {
          let poRef = null; let poData = null;
          if (againstPo) {
            poRef = doc(db, "purchaseOrders", po.id);
            poData = (await tx.get(poRef)).data();
            if (!OPEN_PO_STATUSES.includes(poData.status)) throw new Error(`PO ${poData.poNo} is ${poData.status}; no more material can be received against it.`);
          }
          const number = await reserveNumber(tx, "GE", { date: isoDate() });
          commitNumber(tx, number, ref.id);
          tx.set(ref, {
            geNo: number.number, stage: "GRN PENDING",
            poId: againstPo ? po.id : "", poNo: againstPo ? poData.poNo : "",
            vendor: { id: vendor.id, name: vendor.name, gstin: vendor.gstin || "" },
            warehouse: v.warehouse, invoiceNo: v.invoiceNo, invoiceDate: v.invoiceDate, lines,
            receivedAs: v.receivedAs, containers: v.containers ? Number(v.containers) : null, vehicleNo: v.vehicleNo.toUpperCase(), transporter: v.transporter,
            lrNo: v.lrNo, supplierLot: v.supplierLot, remarks: v.remarks, docs,
            createdAt: serverTimestamp(), createdBy: by()
          });
          const summary = lines.map((l) => `${l.name} ${qty(l.invoiceQty)} ${l.unit}`).join(", ");
          if (againstPo) {
            const upd = applyPoDeltas(poData, Object.fromEntries(lines.map((l) => [l.poLineId, { invoicedQty: l.invoiceQty }])));
            tx.update(poRef, { ...upd, updatedAt: serverTimestamp() });
            logActivity(tx, { module: "Purchase Orders", action: "INVOICE", refId: po.id, refNo: poData.poNo, summary: `Invoice ${v.invoiceNo} received (${number.number}): ${summary} → ${upd.status}` });
          }
          logActivity(tx, { module: "Inward", action: "INVOICE / RECEIPT", refId: ref.id, refNo: number.number, summary: `${number.number} · ${vendor.name} · invoice ${v.invoiceNo} · ${summary}${againstPo ? ` · against ${poData.poNo}` : " · without PO"}${v.vehicleNo ? ` · vehicle ${v.vehicleNo.toUpperCase()}` : ""}` });
          return number.number;
        });
        toast(`${geNo} saved. Next: GRN.`, "ok");
        modal.close();
        tab = "GRN PENDING";
        await load();
      } catch (error) { reportError(error); } finally { done(); }
    });
  }

  /* ---------------- 2. GRN (what physically arrived) ---------------- */
  function openGrn(r) {
    const modal = openModal({
      title: `GRN · ${r.geNo}`,
      size: "wide",
      body: `${summaryGrid(r)}
        <div class="section-title">Goods received (count / visual check)</div>
        <form id="gForm"><table class="table"><thead><tr><th>Item</th><th class="num">Invoice Qty</th><th class="num" style="width:170px">GRN Qty (received)</th><th>Unit</th></tr></thead><tbody>
          ${r.lines.map((l, i) => `<tr><td class="strong">${esc(l.name)}</td><td class="num">${qty(l.invoiceQty)}</td><td><input type="number" step="any" min="0" class="num" name="g${i}" value="${esc(l.invoiceQty)}" /></td><td>${esc(l.unit)}</td></tr>`).join("")}
        </tbody></table>
        <div class="form-grid" style="margin-top:14px">
          <label class="field"><span>QC Status</span><select name="qc"><option>Approved</option><option>Approved with deviation</option><option>Pending QC</option><option>Rejected — return to vendor</option></select></label>
          <label class="field"><span>Our Batch No.</span><input name="batchNo" /></label>
          <label class="field span-2"><span>Remark</span><input name="remark" /></label>
        </div></form>
        <p class="small muted">Stock is <b>not</b> added yet. Kanta will confirm the final quantity.</p>`,
      footer: `<button class="btn" data-close>Cancel</button>${isAdmin() ? '<button class="btn danger" id="delRec">Delete entry</button>' : ""}<button class="btn primary" id="saveG"><i class="fa-solid fa-clipboard-check"></i> Save GRN</button>`
    });
    const f = modal.el.querySelector("#gForm");
    modal.el.querySelector("#delRec")?.addEventListener("click", () => deleteReceipt(r, modal));
    modal.el.querySelector("#saveG").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      const v = formValues(f);
      let grnQtys;
      try {
        grnQtys = r.lines.map((l, i) => { const g = Number(f[`g${i}`].value); if (f[`g${i}`].value === "" || !Number.isFinite(g) || g < 0) throw new Error(`${l.name}: enter the GRN quantity.`); return round(g); });
      } catch (error) { toast(error.message, "error"); return; }
      const done = busy(button);
      try {
        const grnNo = await runTransaction(db, async (tx) => {
          const ref = doc(db, "receipts", r.id);
          const cur = normalizeReceipt({ id: r.id, ...(await tx.get(ref)).data() });
          if (cur.stage !== "GRN PENDING") throw new Error("GRN has already been recorded for this receipt.");
          let poRef = null; let poData = null;
          if (cur.poId) { poRef = doc(db, "purchaseOrders", cur.poId); poData = (await tx.get(poRef)).data(); }
          const number = await reserveNumber(tx, "GRN", { date: isoDate() });
          commitNumber(tx, number, r.id);
          const lines = cur.lines.map((l, i) => ({ ...l, grnQty: grnQtys[i] }));
          tx.update(ref, { stage: "KANTA PENDING", lines, grn: { grnNo: number.number, qc: v.qc, batchNo: v.batchNo, remark: v.remark, at: serverTimestamp(), by: by() } });
          const summary = lines.map((l) => `${l.name} ${qty(l.grnQty)}${l.grnQty !== l.invoiceQty ? ` (invoice ${qty(l.invoiceQty)})` : ""} ${l.unit}`).join(", ");
          if (poRef) {
            const upd = applyPoDeltas(poData, Object.fromEntries(lines.filter((l) => l.poLineId).map((l) => [l.poLineId, { grnQty: l.grnQty, pendingKantaQty: l.grnQty }])));
            tx.update(poRef, { ...upd, updatedAt: serverTimestamp() });
            logActivity(tx, { module: "Purchase Orders", action: "GRN", refId: cur.poId, refNo: cur.poNo, summary: `${number.number} for ${cur.geNo}: ${summary} → ${upd.status}` });
          }
          logActivity(tx, { module: "Inward", action: "GRN", refId: r.id, refNo: number.number, summary: `${number.number} (${cur.geNo}): received ${summary}. QC: ${v.qc}. Awaiting Kanta.` });
          return number.number;
        });
        toast(`${grnNo} saved. Next: Kanta.`, "ok");
        modal.close();
        tab = "KANTA PENDING";
        await load();
      } catch (error) { reportError(error); } finally { done(); }
    });
  }

  /* ---------------- 3. Kanta (final quantity → stock inward) ---------------- */
  function openKanta(r) {
    const single = r.lines.length === 1 ? r.lines[0] : null;
    const modal = openModal({
      title: `Kanta · ${r.geNo} · ${r.grn?.grnNo || ""}`,
      size: "wide",
      body: `${summaryGrid(r)}
        <div class="section-title">Weighbridge</div>
        <form id="kForm"><div class="form-grid">
          <label class="field"><span>Gross Weight</span><input type="number" step="any" name="gross" /></label>
          <label class="field"><span>Tare Weight</span><input type="number" step="any" name="tare" /></label>
          <label class="field"><span>Net Weight</span><input type="number" step="any" name="net" readonly /></label>
          <label class="field"><span>Weight Unit</span><select name="weightUnit"><option>KG</option><option>MT</option></select></label>
        </div>
        <div class="section-title">Confirmed quantity (this is what goes into stock and is payable)</div>
        <table class="table"><thead><tr><th>Item</th><th class="num">Invoice</th><th class="num">GRN</th><th class="num" style="width:170px">Kanta Qty</th><th class="num">Short / Excess</th><th>Unit</th></tr></thead><tbody>
          ${r.lines.map((l, i) => `<tr data-i="${i}"><td class="strong">${esc(l.name)}</td><td class="num">${qty(l.invoiceQty)}</td><td class="num">${qty(l.grnQty)}</td><td><input type="number" step="any" min="0" class="num" name="k${i}" value="${esc(l.grnQty)}" /></td><td class="num" data-var>0</td><td>${esc(l.unit)}</td></tr>`).join("")}
        </tbody></table>
        <div class="form-grid" style="margin-top:14px">
          <label class="field span-2"><span>Kanta slip</span><input type="file" name="slip" accept=".pdf,.jpg,.jpeg,.png" /></label>
          <label class="field span-2"><span>Remark</span><input name="remark" /></label>
        </div></form>
        <p class="small muted">Stock goes to <b>${esc(warehouseByCode(r.warehouse).name)}</b>.</p>`,
      footer: `<button class="btn" data-close>Cancel</button>${isAdmin() ? '<button class="btn danger" id="delRec">Delete entry</button>' : ""}<button class="btn primary" id="saveK"><i class="fa-solid fa-scale-balanced"></i> Confirm Kanta &amp; add to stock</button>`
    });
    const f = modal.el.querySelector("#kForm");
    const recalc = () => {
      if (f.gross.value && f.tare.value) {
        f.net.value = round(Number(f.gross.value) - Number(f.tare.value));
        // single weighed item: fill the Kanta qty from the net weight in the item's unit
        if (single && ["KG", "MT"].includes(single.unit) && document.activeElement !== f.k0) {
          const netKg = f.weightUnit.value === "MT" ? Number(f.net.value) * 1000 : Number(f.net.value);
          f.k0.value = round(single.unit === "MT" ? netKg / 1000 : netKg);
        }
      }
      r.lines.forEach((l, i) => {
        const k = Number(f[`k${i}`].value);
        const cell = f.querySelector(`tr[data-i="${i}"] [data-var]`);
        const d = f[`k${i}`].value === "" ? 0 : round(k - l.grnQty);
        cell.textContent = d === 0 ? "0" : `${d > 0 ? "+" : ""}${qty(d)}`;
        cell.style.color = d < 0 ? "var(--danger)" : d > 0 ? "var(--success)" : "";
      });
    };
    f.addEventListener("input", recalc);
    f.weightUnit.addEventListener("change", recalc);
    modal.el.querySelector("#delRec")?.addEventListener("click", () => deleteReceipt(r, modal));
    modal.el.querySelector("#saveK").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      const v = formValues(f);
      let kantaQtys;
      try {
        kantaQtys = r.lines.map((l, i) => { const k = Number(f[`k${i}`].value); if (f[`k${i}`].value === "" || !Number.isFinite(k) || k < 0) throw new Error(`${l.name}: enter the Kanta quantity.`); return round(k); });
      } catch (error) { toast(error.message, "error"); return; }
      const done = busy(button);
      try {
        const slip = await uploadFiles(`receipts/${r.id}`, { kantaSlip: f.slip.files[0] });
        await runTransaction(db, async (tx) => {
          const ref = doc(db, "receipts", r.id);
          const cur = normalizeReceipt({ id: r.id, ...(await tx.get(ref)).data() });
          if (cur.stage !== "KANTA PENDING") throw new Error("Kanta has already been recorded for this receipt.");
          let poRef = null; let poData = null;
          if (cur.poId) { poRef = doc(db, "purchaseOrders", cur.poId); poData = (await tx.get(poRef)).data(); }
          const stock = await readStock(tx, cur.lines.map((l) => ({ warehouse: cur.warehouse, itemId: l.itemId })));
          const lines = cur.lines.map((l, i) => ({ ...l, kantaQty: kantaQtys[i], varianceQty: round(kantaQtys[i] - l.grnQty), payableQty: kantaQtys[i] }));
          const movements = lines.filter((l) => l.kantaQty > 0).map((l) => ({ warehouse: cur.warehouse, item: { id: l.itemId, name: l.name, unit: l.unit, category: items.find((x) => x.id === l.itemId)?.category || l.category }, qty: l.kantaQty, note: `Kanta inward ${cur.grn.grnNo} · ${cur.poNo || "no PO"} · invoice ${cur.invoiceNo}` }));
          if (movements.length) applyMovements(tx, stock, movements, { type: "INWARD (KANTA)", id: r.id, no: cur.grn.grnNo });
          const payableValue = round(lines.reduce((s, l) => s + l.kantaQty * n(l.rate), 0), 2);
          tx.update(ref, {
            stage: "COMPLETED", lines, payableValue, docs: { ...(cur.docs || {}), ...slip },
            kanta: { grossWeight: v.gross === "" ? null : Number(v.gross), tareWeight: v.tare === "" ? null : Number(v.tare), netWeight: v.net === "" ? null : Number(v.net), weightUnit: v.weightUnit, remark: v.remark, at: serverTimestamp(), by: by() }
          });
          const summary = lines.map((l) => `${l.name} ${qty(l.kantaQty)} ${l.unit}${l.varianceQty ? ` (${l.varianceQty > 0 ? "EXCESS +" : "SHORT "}${qty(l.varianceQty)} vs GRN)` : ""}`).join(", ");
          if (poRef) {
            const upd = applyPoDeltas(poData, Object.fromEntries(lines.filter((l) => l.poLineId).map((l) => [l.poLineId, { receivedQty: l.kantaQty, pendingKantaQty: -l.grnQty, varianceQty: l.varianceQty }])));
            tx.update(poRef, { ...upd, updatedAt: serverTimestamp() });
            logActivity(tx, { module: "Purchase Orders", action: "KANTA / INWARD", refId: cur.poId, refNo: cur.poNo, summary: `Kanta for ${cur.grn.grnNo}: ${summary} → ${upd.status}` });
          }
          logActivity(tx, { module: "Inward", action: "KANTA / INWARD", refId: r.id, refNo: cur.grn.grnNo, summary: `Kanta ${cur.geNo}/${cur.grn.grnNo}: inwarded ${summary} into ${warehouseByCode(cur.warehouse).name}. Payable ₹${money(payableValue)} (before GST)` });
        });
        toast("Kanta confirmed — stock updated.", "ok");
        modal.close();
        tab = "COMPLETED";
        await load();
      } catch (error) { reportError(error); } finally { done(); }
    });
    recalc();
  }

  /* ---------------- Delete / reverse (admin) ---------------- */
  async function deleteReceipt(r, parentModal) {
    const reason = await confirmDialog(`Delete ${r.geNo}? The PO quantities will be reversed. The record is kept as CANCELLED.`, { title: "Delete receipt", danger: true, okText: "Delete", input: { label: "Reason", required: true } });
    if (!reason) return;
    try {
      await runTransaction(db, async (tx) => {
        const ref = doc(db, "receipts", r.id);
        const cur = normalizeReceipt({ id: r.id, ...(await tx.get(ref)).data() });
        if (!["GRN PENDING", "KANTA PENDING"].includes(cur.stage)) throw new Error("Only receipts not yet through Kanta can be deleted. Use Reverse instead.");
        if (cur.poId) {
          const poRef = doc(db, "purchaseOrders", cur.poId);
          const poData = (await tx.get(poRef)).data();
          const grnDone = cur.stage === "KANTA PENDING";
          const upd = applyPoDeltas(poData, Object.fromEntries(cur.lines.filter((l) => l.poLineId).map((l) => [l.poLineId, { invoicedQty: -l.invoiceQty, ...(grnDone ? { grnQty: -l.grnQty, pendingKantaQty: -l.grnQty } : {}) }])));
          tx.update(poRef, { ...upd, updatedAt: serverTimestamp() });
          logActivity(tx, { module: "Purchase Orders", action: "RECEIPT DELETED", refId: cur.poId, refNo: cur.poNo, summary: `${cur.geNo} deleted. Reason: ${reason}` });
        }
        tx.update(ref, { stage: "CANCELLED", cancelReason: reason, cancelledAt: serverTimestamp(), cancelledBy: by() });
        logActivity(tx, { module: "Inward", action: "DELETE", refId: r.id, refNo: cur.geNo, summary: `Deleted ${cur.geNo} (invoice ${cur.invoiceNo}). Reason: ${reason}` });
      });
      toast(`${r.geNo} deleted.`, "ok");
      parentModal?.close();
      await load();
    } catch (error) { reportError(error); }
  }

  async function reverseInward(r, parentModal) {
    const reason = await confirmDialog(`Reverse ${r.geNo}? The Kanta quantities will be removed from ${warehouseByCode(r.warehouse).name} stock and the PO reopened for them.`, { title: "Reverse inward", danger: true, okText: "Reverse", input: { label: "Reason", required: true } });
    if (!reason) return;
    try {
      await runTransaction(db, async (tx) => {
        const ref = doc(db, "receipts", r.id);
        const cur = normalizeReceipt({ id: r.id, ...(await tx.get(ref)).data() });
        if (cur.stage !== "COMPLETED") throw new Error("Only inwarded receipts can be reversed.");
        let poRef = null; let poData = null;
        if (cur.poId) { poRef = doc(db, "purchaseOrders", cur.poId); poData = (await tx.get(poRef)).data(); }
        const stock = await readStock(tx, cur.lines.map((l) => ({ warehouse: cur.warehouse, itemId: l.itemId })));
        const movements = cur.lines.filter((l) => l.kantaQty > 0).map((l) => ({ warehouse: cur.warehouse, item: { id: l.itemId, name: l.name, unit: l.unit, category: l.category }, qty: -l.kantaQty, note: `Reversal of ${cur.geNo}: ${reason}` }));
        if (movements.length) applyMovements(tx, stock, movements, { type: "INWARD REVERSAL", id: r.id, no: cur.grn?.grnNo || cur.geNo });
        if (poRef) {
          const upd = applyPoDeltas(poData, Object.fromEntries(cur.lines.filter((l) => l.poLineId).map((l) => [l.poLineId, { invoicedQty: -l.invoiceQty, grnQty: -l.grnQty, receivedQty: -l.kantaQty, varianceQty: -(l.kantaQty - l.grnQty) }])));
          tx.update(poRef, { ...upd, updatedAt: serverTimestamp() });
          logActivity(tx, { module: "Purchase Orders", action: "INWARD REVERSED", refId: cur.poId, refNo: cur.poNo, summary: `${cur.geNo} reversed. Reason: ${reason}` });
        }
        tx.update(ref, { stage: "CANCELLED", cancelReason: `Inward reversed: ${reason}`, cancelledAt: serverTimestamp(), cancelledBy: by() });
        logActivity(tx, { module: "Inward", action: "INWARD REVERSED", refId: r.id, refNo: cur.geNo, summary: `Reversed ${cur.geNo}: ${cur.lines.map((l) => `−${qty(l.kantaQty)} ${l.unit} ${l.name}`).join(", ")}. Reason: ${reason}` });
      });
      toast("Inward reversed.", "ok");
      parentModal?.close();
      await load();
    } catch (error) { reportError(error); }
  }

  function summaryGrid(r) {
    return `<div class="detail-grid">
      <div><span>Receipt</span><b>${esc(r.geNo)}</b></div><div><span>PO</span><b>${esc(r.poNo || "Without PO")}</b></div>
      <div><span>Vendor</span><b>${esc(r.vendor?.name)}</b></div><div><span>Warehouse</span><b>${esc(warehouseByCode(r.warehouse).name)}</b></div>
      <div><span>Invoice</span><b>${esc(r.invoiceNo)} · ${fmtDate(r.invoiceDate)}</b></div><div><span>Vehicle</span><b>${esc(r.vehicleNo || "—")}</b></div>
      <div><span>Received As</span><b>${esc(r.receivedAs || "—")}${r.containers ? ` · ${qty(r.containers)}` : ""}</b></div><div><span>Entered</span><b>${fmtDateTime(r.createdAt)} · ${esc(r.createdBy?.name)}</b></div>
      ${r.grn ? `<div><span>GRN</span><b>${esc(r.grn.grnNo)} · ${fmtDateTime(r.grn.at)} · ${esc(r.grn.by?.name)}</b></div>` : ""}
      <div><span>Documents</span><b class="small">${docLinks(r.docs)}</b></div>
    </div>`;
  }

  function openView(r) {
    const modal = openModal({
      title: `${r.geNo}${r.grn ? ` · ${r.grn.grnNo}` : ""}`,
      size: "wide",
      body: `${badge(r.stage === "COMPLETED" ? "INWARDED" : r.stage)}<div style="height:12px"></div>${summaryGrid(r)}
        <div class="section-title">Items</div>
        <table class="table"><thead><tr><th>Item</th><th class="num">Invoice</th><th class="num">GRN</th><th class="num">Kanta</th><th class="num">Short/Excess</th><th class="num">Inward / Payable</th><th class="num">Payable ₹</th></tr></thead><tbody>
        ${r.lines.map((l) => { const vq = l.kantaQty !== undefined ? round(l.kantaQty - l.grnQty) : null; return `<tr><td class="strong">${esc(l.name)}</td><td class="num">${qty(l.invoiceQty)} ${esc(l.unit)}</td><td class="num">${l.grnQty !== undefined ? qty(l.grnQty) : "—"}</td><td class="num">${l.kantaQty !== undefined ? qty(l.kantaQty) : "—"}</td><td class="num" style="color:${vq < 0 ? "var(--danger)" : vq > 0 ? "var(--success)" : "inherit"}">${vq === null ? "—" : `${vq > 0 ? "+" : ""}${qty(vq)}`}</td><td class="num strong">${l.kantaQty !== undefined ? qty(l.kantaQty) : "—"}</td><td class="num">${l.kantaQty !== undefined && l.rate ? money(l.kantaQty * l.rate) : "—"}</td></tr>`; }).join("")}
        </tbody></table>
        ${r.kanta ? `<div class="section-title">Kanta</div><div class="detail-grid"><div><span>Gross / Tare / Net</span><b>${qty(r.kanta.grossWeight ?? 0)} / ${qty(r.kanta.tareWeight ?? 0)} / ${qty(r.kanta.netWeight ?? 0)} ${esc(r.kanta.weightUnit || "")}</b></div><div><span>By</span><b>${esc(r.kanta.by?.name)} · ${fmtDateTime(r.kanta.at)}</b></div><div><span>Remark</span><b>${esc(r.kanta.remark || "—")}</b></div></div>` : ""}
        ${r.grn ? `<div class="section-title">GRN</div><div class="detail-grid"><div><span>GRN No.</span><b>${esc(r.grn.grnNo)}</b></div><div><span>QC</span><b>${esc(r.grn.qc || "—")}</b></div><div><span>Batch</span><b>${esc(r.grn.batchNo || "—")}</b></div><div><span>Remark</span><b>${esc(r.grn.remark || "—")}</b></div></div>` : ""}
        ${r.stage === "CANCELLED" ? `<div class="notice error" style="margin-top:14px">Cancelled by ${esc(r.cancelledBy?.name)} on ${fmtDateTime(r.cancelledAt)} — ${esc(r.cancelReason)}</div>` : ""}`,
      footer: `<button class="btn" data-close>Close</button>${isAdmin() && ["GRN PENDING", "KANTA PENDING"].includes(r.stage) ? '<button class="btn danger" id="delRec">Delete entry</button>' : ""}${isAdmin() && r.stage === "COMPLETED" ? '<button class="btn danger" id="revRec">Reverse inward</button>' : ""}`
    });
    modal.el.querySelector("#delRec")?.addEventListener("click", () => deleteReceipt(r, modal));
    modal.el.querySelector("#revRec")?.addEventListener("click", () => reverseInward(r, modal));
  }

  await load();
  document.body.dataset.loaded = "1";
}

