// Inward workflow: Gate Entry (invoice qty) → Kanta (actual qty, shortage) → GRN (accepted qty into stock).
// Every stage updates the linked PO line so the PO always shows exactly how much has arrived.
import {
  db, reportError, state, initPage, pageHeader, esc, toast, openModal, confirmDialog, badge, busy, formValues, can, isAdmin,
  listCollection, logActivity, qty, fmtDate, fmtDateTime, isoDate, round, reserveNumber, commitNumber,
  warehouseByCode, warehouseOptions, deriveOrderStatus, readStock, applyMovements, exportExcel
} from "./core.js";
import { collection, doc, runTransaction, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { uploadFiles, docLinks } from "./uploads.js";

const page = await initPage("inward");
if (page) start();

const RECEIVED_AS = ["Tanker", "Drums", "IBC", "Carboys", "Bags", "Bottles / Boxes", "Loose", "Other"];

async function start() {
  let receipts = [];
  let pos = [];
  let vendors = [];
  let items = [];
  let tab = location.hash === "#kanta" ? "KANTA PENDING" : location.hash === "#grn" ? "GRN PENDING" : "KANTA PENDING";
  const canOperate = can("operations");

  page.innerHTML = `${pageHeader("Purchase", "Inward · Kanta · GRN", "Gate entry against PO → weighbridge / count → GRN into stock.",
    `<button class="btn" id="exportBtn"><i class="fa-solid fa-download"></i> Export</button>${canOperate ? '<button class="btn primary" id="newEntry"><i class="fa-solid fa-truck-ramp-box"></i> New Gate Entry</button>' : ""}`)}
    <div class="tabs" id="tabs"></div>
    <div class="card">
      <div class="card-head"><div class="toolbar"><input class="input search" id="search" placeholder="Search gate entry, PO, invoice, vendor, item, vehicle…" />
      <select class="input" id="whFilter"><option value="">All warehouses</option>${warehouseOptions("", { includeBlank: false })}</select>
      <input class="input" type="date" id="fromDate" title="From date" /><input class="input" type="date" id="toDate" title="To date" /></div><span class="small muted" id="count"></span></div>
      <div class="table-wrap"><table class="table"><thead id="head"></thead><tbody id="rows"></tbody></table></div>
    </div>`;

  const TABS = [["KANTA PENDING", "Kanta pending"], ["GRN PENDING", "GRN pending"], ["COMPLETED", "Completed (GRN done)"], ["ALL", "All transactions"]];

  function filtered() {
    const term = page.querySelector("#search").value.trim().toLowerCase();
    const wh = page.querySelector("#whFilter").value;
    const from = page.querySelector("#fromDate").value;
    const to = page.querySelector("#toDate").value;
    return receipts.filter((r) => (tab === "ALL" || r.stage === tab) && (!wh || r.warehouse === wh)
      && (!from || isoDate(r.createdAt) >= from) && (!to || isoDate(r.createdAt) <= to)
      && (!term || [r.geNo, r.poNo, r.invoiceNo, r.vendor?.name, r.item?.name, r.vehicleNo, r.grn?.grnNo].some((v) => String(v || "").toLowerCase().includes(term))));
  }

  function render() {
    page.querySelector("#tabs").innerHTML = TABS.map(([k, l]) => `<button class="tab ${k === tab ? "active" : ""}" data-tab="${k}">${l}<span class="count">${receipts.filter((r) => k === "ALL" || r.stage === k).length}</span></button>`).join("");
    page.querySelector("#head").innerHTML = `<tr><th>Gate Entry</th><th>Date & Time</th><th>PO No.</th><th>Vendor</th><th>Item</th><th>Warehouse</th><th>Invoice</th><th class="num">Invoice Qty</th><th class="num">Kanta Qty</th><th class="num">Shortage</th><th class="num">Accepted</th><th>Docs</th><th>Stage</th><th></th></tr>`;
    const list = filtered();
    page.querySelector("#count").textContent = `${list.length} entr${list.length === 1 ? "y" : "ies"}`;
    const rows = page.querySelector("#rows");
    if (!list.length) { rows.innerHTML = '<tr><td class="empty" colspan="14">Nothing here.</td></tr>'; return; }
    rows.innerHTML = list.map((r) => {
      const short = Number(r.shortageQty || 0);
      let action = "";
      if (canOperate && r.stage === "KANTA PENDING") action = `<button class="btn sm primary" data-kanta="${esc(r.id)}">Kanta</button>`;
      if (canOperate && r.stage === "GRN PENDING") action = `<button class="btn sm primary" data-grn="${esc(r.id)}">Finalize GRN</button>`;
      return `<tr>
        <td class="strong nowrap"><a href="#" data-view="${esc(r.id)}">${esc(r.geNo)}</a></td>
        <td class="nowrap">${fmtDateTime(r.createdAt)}</td>
        <td class="nowrap">${r.poId ? `<a href="purchase-orders.html?open=${esc(r.poId)}">${esc(r.poNo)}</a>` : '<span class="muted">Without PO</span>'}</td>
        <td>${esc(r.vendor?.name)}</td>
        <td>${esc(r.item?.name)}</td>
        <td>${esc(warehouseByCode(r.warehouse).name)}</td>
        <td>${esc(r.invoiceNo)}<div class="small muted">${fmtDate(r.invoiceDate)}</div></td>
        <td class="num">${qty(r.invoiceQty)} ${esc(r.item?.unit)}</td>
        <td class="num">${r.kanta ? qty(r.kanta.receivedQty) : "—"}</td>
        <td class="num" style="color:${short > 0 ? "var(--danger)" : short < 0 ? "var(--success)" : "inherit"}">${r.kanta ? `${short > 0 ? "−" : short < 0 ? "+" : ""}${qty(Math.abs(short))}` : "—"}</td>
        <td class="num strong">${r.grn ? qty(r.grn.acceptedQty) : "—"}</td>
        <td class="small">${docLinks(r.docs)}</td>
        <td>${badge(r.stage)}</td>
        <td><div class="actions">${action}</div></td>
      </tr>`;
    }).join("");
  }

  async function load() {
    [receipts, pos, vendors, items] = await Promise.all([
      listCollection("receipts", "createdAt", "desc"),
      listCollection("purchaseOrders", "createdAt", "desc"),
      listCollection("vendors"),
      listCollection("items")
    ]);
    render();
  }

  page.addEventListener("click", (event) => {
    const t = event.target.closest("[data-tab]");
    if (t) { tab = t.dataset.tab; render(); return; }
    const find = (id) => receipts.find((r) => r.id === id);
    const k = event.target.closest("[data-kanta]"); if (k) { openKanta(find(k.dataset.kanta)); return; }
    const g = event.target.closest("[data-grn]"); if (g) { openGrn(find(g.dataset.grn)); return; }
    const v = event.target.closest("[data-view]"); if (v) { event.preventDefault(); openView(find(v.dataset.view)); }
  });
  ["#search", "#whFilter", "#fromDate", "#toDate"].forEach((s) => page.querySelector(s).addEventListener(s === "#search" ? "input" : "change", render));
  page.querySelector("#newEntry")?.addEventListener("click", openGateEntry);
  page.querySelector("#exportBtn").addEventListener("click", () => {
    const rows = filtered().map((r) => ({
      "Gate Entry": r.geNo, "Date & Time": fmtDateTime(r.createdAt), "PO No": r.poNo || "Without PO", Vendor: r.vendor?.name, Item: r.item?.name, Unit: r.item?.unit,
      Warehouse: warehouseByCode(r.warehouse).name, "Invoice No": r.invoiceNo, "Invoice Date": fmtDate(r.invoiceDate), "Vehicle No": r.vehicleNo, "Received As": r.receivedAs,
      "Invoice Qty": r.invoiceQty, "Gross Wt": r.kanta?.grossWeight ?? "", "Tare Wt": r.kanta?.tareWeight ?? "", "Kanta Qty": r.kanta?.receivedQty ?? "", Shortage: r.kanta ? r.shortageQty : "",
      "Accepted Qty": r.grn?.acceptedQty ?? "", "Rejected Qty": r.grn?.rejectedQty ?? "", "GRN No": r.grn?.grnNo || "", "GRN Date": r.grn ? fmtDateTime(r.grn.at) : "", Stage: r.stage,
      "Entered By": r.createdBy?.name || "", "Kanta By": r.kanta?.by?.name || "", "GRN By": r.grn?.by?.name || ""
    }));
    if (!rows.length) { toast("Nothing to export."); return; }
    exportExcel(rows, `CCPL_Inward_${isoDate()}.xlsx`, "Inward");
  });

  /* ---------------- Gate entry ---------------- */
  function openGateEntry() {
    const openPos = pos.filter((p) => ["OPEN", "PARTIALLY RECEIVED"].includes(p.status));
    const modal = openModal({
      title: "New Gate Entry (material inward)",
      size: "wide",
      body: `<form id="geForm" class="form-grid" novalidate>
        <label class="field"><span>Receive Against <b class="req">*</b></span><select name="mode"><option value="PO">Purchase Order</option><option value="NOPO">Without PO</option></select></label>
        <label class="field span-2" data-po><span>Purchase Order <b class="req">*</b></span><select name="poId"><option value="">Select open PO…</option>${openPos.map((p) => `<option value="${esc(p.id)}">${esc(p.poNo)} · ${esc(p.vendor?.name)}</option>`).join("")}</select></label>
        <label class="field" data-po><span>PO Item <b class="req">*</b></span><select name="lineId"><option value="">Select PO first</option></select></label>
        <div class="span-all" data-po id="poLineInfo"></div>
        <label class="field span-2" data-nopo hidden><span>Vendor / Party <b class="req">*</b></span><select name="vendorId"><option value="">Select…</option>${vendors.filter((v) => v.active !== false).map((v) => `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join("")}</select></label>
        <label class="field span-2" data-nopo hidden><span>Item <b class="req">*</b></span><select name="itemId"><option value="">Select…</option>${items.filter((i) => i.active !== false).map((i) => `<option value="${esc(i.id)}">${esc(i.name)} (${esc(i.unit)})</option>`).join("")}</select></label>
        <label class="field"><span>Receiving Warehouse <b class="req">*</b></span><select name="warehouse">${warehouseOptions()}</select></label>
        <label class="field"><span>Invoice / Challan No. <b class="req">*</b></span><input name="invoiceNo" /></label>
        <label class="field"><span>Invoice Date</span><input type="date" name="invoiceDate" value="${isoDate()}" /></label>
        <label class="field"><span>Invoice Qty <b class="req">*</b> <em id="unitHint" class="muted"></em></span><input type="number" step="any" min="0" name="invoiceQty" /></label>
        <label class="field"><span>Received As</span><select name="receivedAs">${RECEIVED_AS.map((r) => `<option>${r}</option>`).join("")}</select></label>
        <label class="field"><span>No. of Containers</span><input type="number" min="0" step="1" name="containers" placeholder="e.g. 80 drums" /></label>
        <label class="field"><span>Vehicle No.</span><input name="vehicleNo" placeholder="MH46AB1234" /></label>
        <label class="field"><span>Transporter</span><input name="transporter" /></label>
        <label class="field"><span>LR No.</span><input name="lrNo" /></label>
        <label class="field"><span>Supplier Batch / Lot No.</span><input name="supplierLot" /></label>
        <label class="field span-2"><span>Remarks</span><input name="remarks" /></label>
        <label class="field"><span>Invoice copy</span><input type="file" name="invoiceFile" accept=".pdf,.jpg,.jpeg,.png" /></label>
        <label class="field"><span>Supplier COA</span><input type="file" name="coaFile" accept=".pdf,.jpg,.jpeg,.png" /></label>
        <label class="field span-2"><span>Other documents (E-way bill, LR…)</span><input type="file" name="otherFiles" multiple accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,.xls,.xlsx" /></label>
      </form>`,
      footer: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="saveGe"><i class="fa-solid fa-check"></i> Save Gate Entry</button>`
    });
    const form = modal.el.querySelector("#geForm");
    const selectedPo = () => pos.find((p) => p.id === form.poId.value);
    const selectedLine = () => selectedPo()?.lines.find((l) => l.lineId === form.lineId.value);
    const showMode = () => {
      const po = form.mode.value === "PO";
      form.querySelectorAll("[data-po]").forEach((el) => { el.hidden = !po; });
      form.querySelectorAll("[data-nopo]").forEach((el) => { el.hidden = po; });
    };
    const showLine = () => {
      const po = selectedPo();
      const l = selectedLine();
      const info = form.querySelector("#poLineInfo");
      if (!po || !l) { info.innerHTML = ""; return; }
      const pending = Math.max(0, round(l.qty - (l.receivedQty || 0)));
      const inProcess = Math.max(0, round((l.invoicedQty || 0) - (l.receivedQty || 0) - (l.rejectedQty || 0) - (l.shortQty || 0)));
      info.innerHTML = `<div class="notice info"><i class="fa-solid fa-circle-info"></i><div><b>${esc(l.name)}</b> — Ordered ${qty(l.qty)} ${esc(l.unit)} · Received ${qty(l.receivedQty || 0)} · In process (awaiting kanta/GRN) ${qty(inProcess)} · <b>Pending ${qty(pending)} ${esc(l.unit)}</b></div></div>`;
      form.querySelector("#unitHint").textContent = `(${l.unit})`;
    };
    form.mode.addEventListener("change", showMode);
    form.poId.addEventListener("change", () => {
      const po = selectedPo();
      form.lineId.innerHTML = po ? po.lines.map((l) => `<option value="${esc(l.lineId)}">${esc(l.name)} · pending ${qty(Math.max(0, l.qty - (l.receivedQty || 0)))} ${esc(l.unit)}</option>`).join("") : '<option value="">Select PO first</option>';
      if (po) form.warehouse.value = po.warehouse;
      showLine();
    });
    form.lineId.addEventListener("change", showLine);
    form.itemId.addEventListener("change", () => { const it = items.find((i) => i.id === form.itemId.value); form.querySelector("#unitHint").textContent = it ? `(${it.unit})` : ""; });
    showMode();

    modal.el.querySelector("#saveGe").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      const v = formValues(form);
      const againstPo = v.mode === "PO";
      const po = selectedPo();
      const line = selectedLine();
      const invoiceQty = Number(v.invoiceQty);
      try {
        if (againstPo && (!po || !line)) throw new Error("Select the PO and the PO item.");
        if (!againstPo && (!v.vendorId || !v.itemId)) throw new Error("Select the vendor and item.");
        if (!v.warehouse) throw new Error("Select the receiving warehouse.");
        if (!v.invoiceNo) throw new Error("Enter the invoice / challan number.");
        if (!Number.isFinite(invoiceQty) || invoiceQty <= 0) throw new Error("Invoice quantity must be greater than 0.");
        const dup = receipts.find((r) => r.stage !== "CANCELLED" && r.invoiceNo.toLowerCase() === v.invoiceNo.toLowerCase() && (r.vendor?.id === (againstPo ? po.vendorId : v.vendorId)) && (!line || r.poLineId === line.lineId));
        if (dup) throw new Error(`Invoice ${v.invoiceNo} from this vendor is already entered (${dup.geNo}).`);
      } catch (error) { toast(error.message, "error"); return; }
      if (againstPo) {
        const pending = round(line.qty - (line.invoicedQty || 0));
        if (invoiceQty > pending + 0.0005) {
          const ok = await confirmDialog(`Invoice qty ${qty(invoiceQty)} ${line.unit} is more than the balance not yet invoiced on this PO (${qty(Math.max(0, pending))} ${line.unit}). Accept the excess?`, { okText: "Accept excess" });
          if (!ok) return;
        }
      }
      const vendor = againstPo ? po.vendor : vendors.find((x) => x.id === v.vendorId);
      const item = againstPo ? items.find((i) => i.id === line.itemId) || { id: line.itemId, name: line.name, unit: line.unit, category: line.category } : items.find((i) => i.id === v.itemId);
      const ref = doc(collection(db, "receipts"));
      const done = busy(button);
      try {
        const docs = await uploadFiles(`receipts/${ref.id}`, { invoice: form.invoiceFile.files[0], coa: form.coaFile.files[0], other: [...form.otherFiles.files] });
        const geNo = await runTransaction(db, async (tx) => {
          let poRef = null; let poData = null;
          if (againstPo) {
            poRef = doc(db, "purchaseOrders", po.id);
            const snap = await tx.get(poRef);
            poData = snap.data();
            if (!["OPEN", "PARTIALLY RECEIVED"].includes(poData.status)) throw new Error(`PO ${poData.poNo} is ${poData.status}; no more inward can be accepted.`);
          }
          const number = await reserveNumber(tx, "GE", { date: isoDate() });
          commitNumber(tx, number);
          tx.set(ref, {
            geNo: number.number, stage: "KANTA PENDING",
            poId: againstPo ? po.id : "", poNo: againstPo ? poData.poNo : "", poLineId: againstPo ? line.lineId : "",
            vendor: { id: vendor.id, name: vendor.name, gstin: vendor.gstin || "" },
            item: { id: item.id, name: item.name, unit: item.unit, category: item.category || "", hsn: item.hsn || "" },
            warehouse: v.warehouse, invoiceNo: v.invoiceNo, invoiceDate: v.invoiceDate, invoiceQty: round(invoiceQty),
            receivedAs: v.receivedAs, containers: v.containers ? Number(v.containers) : null, vehicleNo: v.vehicleNo.toUpperCase(), transporter: v.transporter,
            lrNo: v.lrNo, supplierLot: v.supplierLot, remarks: v.remarks, docs,
            createdAt: serverTimestamp(), createdBy: { uid: state.user.uid, name: state.profile.name || state.user.email }
          });
          if (againstPo) {
            const lines = poData.lines.map((l) => (l.lineId === line.lineId ? { ...l, invoicedQty: round((l.invoicedQty || 0) + invoiceQty) } : l));
            tx.update(poRef, { lines, status: deriveOrderStatus({ ...poData, lines }, "receivedQty", state.company.poTolerancePct), updatedAt: serverTimestamp() });
            logActivity(tx, { module: "Purchase Orders", action: "INWARD", refId: po.id, refNo: poData.poNo, summary: `Gate entry ${number.number}: invoice ${v.invoiceNo} for ${qty(invoiceQty)} ${item.unit} ${item.name} at ${warehouseByCode(v.warehouse).name}` });
          }
          logActivity(tx, { module: "Inward", action: "GATE ENTRY", refId: ref.id, refNo: number.number, summary: `Gate entry ${number.number} · ${vendor.name} · ${item.name} · invoice ${v.invoiceNo} · ${qty(invoiceQty)} ${item.unit}${againstPo ? ` · against ${poData.poNo}` : " · without PO"}${v.vehicleNo ? ` · vehicle ${v.vehicleNo.toUpperCase()}` : ""}` });
          return number.number;
        });
        toast(`Gate entry ${geNo} saved. Next: Kanta.`, "ok");
        modal.close();
        tab = "KANTA PENDING";
        await load();
      } catch (error) { reportError(error); } finally { done(); }
    });
  }

  /* ---------------- Kanta ---------------- */
  function openKanta(r) {
    const modal = openModal({
      title: `Kanta · ${r.geNo}`,
      size: "wide",
      body: `${summaryGrid(r)}
        <div class="section-title">Weighbridge / physical count</div>
        <form id="kForm" class="form-grid" novalidate>
          <label class="field"><span>Gross Weight</span><input type="number" step="any" name="gross" /></label>
          <label class="field"><span>Tare Weight</span><input type="number" step="any" name="tare" /></label>
          <label class="field"><span>Net Weight</span><input type="number" step="any" name="net" readonly /></label>
          <label class="field"><span>Weight Unit</span><select name="weightUnit"><option>KG</option><option>MT</option></select></label>
          <label class="field"><span>Actual Received Qty (${esc(r.item.unit)}) <b class="req">*</b></span><input type="number" step="any" min="0" name="receivedQty" /></label>
          <label class="field"><span>Invoice Qty</span><input readonly value="${esc(qty(r.invoiceQty))} ${esc(r.item.unit)}" /></label>
          <label class="field span-2"><span>Difference</span><input readonly name="diff" /></label>
          <label class="field span-2"><span>Kanta slip</span><input type="file" name="slip" accept=".pdf,.jpg,.jpeg,.png" /></label>
          <label class="field span-2"><span>Remarks</span><input name="remark" /></label>
        </form>`,
      footer: `<button class="btn" data-close>Cancel</button>${isAdmin() ? '<button class="btn danger" id="delRec">Delete entry</button>' : ""}<button class="btn primary" id="saveK"><i class="fa-solid fa-scale-balanced"></i> Save Kanta</button>`
    });
    const f = modal.el.querySelector("#kForm");
    const recalc = () => {
      const g = Number(f.gross.value); const t = Number(f.tare.value);
      if (f.gross.value && f.tare.value) f.net.value = round(g - t);
      const rec = Number(f.receivedQty.value);
      if (f.receivedQty.value === "") { f.diff.value = ""; return; }
      const d = round(r.invoiceQty - rec);
      f.diff.value = d === 0 ? "No difference" : `${d > 0 ? "Shortage" : "Excess"} ${qty(Math.abs(d))} ${r.item.unit} (${round((Math.abs(d) / r.invoiceQty) * 100, 2)}%)`;
      f.diff.style.color = d > 0 ? "var(--danger)" : d < 0 ? "var(--success)" : "";
    };
    f.addEventListener("input", recalc);
    modal.el.querySelector("#delRec")?.addEventListener("click", () => deleteReceipt(r, modal));
    modal.el.querySelector("#saveK").addEventListener("click", async (event) => {
      const v = formValues(f);
      const received = Number(v.receivedQty);
      if (v.receivedQty === "" || !Number.isFinite(received) || received < 0) { toast("Enter the actual received quantity.", "error"); return; }
      const done = busy(event.currentTarget);
      try {
        const slip = await uploadFiles(`receipts/${r.id}`, { kantaSlip: f.slip.files[0] });
        await runTransaction(db, async (tx) => {
          const ref = doc(db, "receipts", r.id);
          const cur = (await tx.get(ref)).data();
          if (cur.stage !== "KANTA PENDING") throw new Error("Kanta has already been recorded for this entry.");
          let poRef = null; let poData = null;
          if (cur.poId) { poRef = doc(db, "purchaseOrders", cur.poId); poData = (await tx.get(poRef)).data(); }
          const shortage = round(cur.invoiceQty - received);
          tx.update(ref, {
            stage: "GRN PENDING",
            shortageQty: shortage,
            kanta: { grossWeight: v.gross === "" ? null : Number(v.gross), tareWeight: v.tare === "" ? null : Number(v.tare), netWeight: v.net === "" ? null : Number(v.net), weightUnit: v.weightUnit, receivedQty: round(received), remark: v.remark, at: serverTimestamp(), by: { uid: state.user.uid, name: state.profile.name || state.user.email } },
            docs: { ...(cur.docs || {}), ...slip }
          });
          if (poRef && shortage > 0) {
            const lines = poData.lines.map((l) => (l.lineId === cur.poLineId ? { ...l, shortQty: round((l.shortQty || 0) + shortage) } : l));
            tx.update(poRef, { lines, updatedAt: serverTimestamp() });
          }
          const msg = `Kanta for ${cur.geNo}: invoice ${qty(cur.invoiceQty)} ${cur.item.unit}, actual ${qty(received)} ${cur.item.unit}${shortage > 0 ? `, SHORT ${qty(shortage)}` : shortage < 0 ? `, EXCESS ${qty(-shortage)}` : ", no difference"}`;
          logActivity(tx, { module: "Inward", action: "KANTA", refId: r.id, refNo: cur.geNo, summary: msg });
          if (poRef) logActivity(tx, { module: "Purchase Orders", action: "KANTA", refId: cur.poId, refNo: cur.poNo, summary: msg });
        });
        toast("Kanta saved. Next: GRN.", "ok");
        modal.close();
        tab = "GRN PENDING";
        await load();
      } catch (error) { reportError(error); } finally { done(); }
    });
  }

  /* ---------------- GRN ---------------- */
  function openGrn(r) {
    const modal = openModal({
      title: `Finalize GRN · ${r.geNo}`,
      size: "wide",
      body: `${summaryGrid(r)}
        <div class="section-title">Quality & acceptance</div>
        <form id="gForm" class="form-grid" novalidate>
          <label class="field"><span>Kanta Qty</span><input readonly value="${esc(qty(r.kanta.receivedQty))} ${esc(r.item.unit)}" /></label>
          <label class="field"><span>Accepted Qty (${esc(r.item.unit)}) <b class="req">*</b></span><input type="number" step="any" min="0" name="accepted" value="${esc(r.kanta.receivedQty)}" /></label>
          <label class="field"><span>Rejected Qty</span><input readonly name="rejected" value="0" /></label>
          <label class="field"><span>Stock goes to</span><input readonly value="${esc(warehouseByCode(r.warehouse).name)}" /></label>
          <label class="field"><span>Our Batch No.</span><input name="batchNo" /></label>
          <label class="field"><span>QC Status</span><select name="qc"><option>Approved</option><option>Approved with deviation</option><option>Pending QC</option></select></label>
          <label class="field span-2"><span>Remark</span><input name="remark" /></label>
        </form>`,
      footer: `<button class="btn" data-close>Cancel</button>${isAdmin() ? '<button class="btn danger" id="delRec">Delete entry</button>' : ""}<button class="btn primary" id="saveG"><i class="fa-solid fa-file-circle-check"></i> Finalize GRN & add to stock</button>`
    });
    const f = modal.el.querySelector("#gForm");
    f.accepted.addEventListener("input", () => { f.rejected.value = round(Math.max(0, r.kanta.receivedQty - (Number(f.accepted.value) || 0))); });
    modal.el.querySelector("#delRec")?.addEventListener("click", () => deleteReceipt(r, modal));
    modal.el.querySelector("#saveG").addEventListener("click", async (event) => {
      const v = formValues(f);
      const accepted = Number(v.accepted);
      if (!Number.isFinite(accepted) || accepted < 0) { toast("Enter a valid accepted quantity.", "error"); return; }
      if (accepted > r.kanta.receivedQty + 0.0005) { toast("Accepted quantity cannot be more than the kanta quantity.", "error"); return; }
      const rejected = round(r.kanta.receivedQty - accepted);
      const done = busy(event.currentTarget);
      try {
        const grnNo = await runTransaction(db, async (tx) => {
          const ref = doc(db, "receipts", r.id);
          const cur = (await tx.get(ref)).data();
          if (cur.stage !== "GRN PENDING") throw new Error("GRN is already finalized for this entry.");
          let poRef = null; let poData = null;
          if (cur.poId) { poRef = doc(db, "purchaseOrders", cur.poId); poData = (await tx.get(poRef)).data(); }
          const itemMeta = items.find((i) => i.id === cur.item.id);
          const stockItem = { ...cur.item, category: itemMeta?.category || cur.item.category || "" };
          const stock = await readStock(tx, [{ warehouse: cur.warehouse, itemId: cur.item.id }]);
          const number = await reserveNumber(tx, "GRN", { date: isoDate() });
          commitNumber(tx, number);
          if (accepted > 0) applyMovements(tx, stock, [{ warehouse: cur.warehouse, item: stockItem, qty: accepted, note: `GRN against ${cur.poNo || "no PO"} · invoice ${cur.invoiceNo}` }], { type: "GRN", id: r.id, no: number.number });
          tx.update(ref, { stage: "COMPLETED", grn: { grnNo: number.number, acceptedQty: round(accepted), rejectedQty: rejected, batchNo: v.batchNo, qc: v.qc, remark: v.remark, at: serverTimestamp(), by: { uid: state.user.uid, name: state.profile.name || state.user.email } } });
          if (poRef) {
            const lines = poData.lines.map((l) => (l.lineId === cur.poLineId ? { ...l, receivedQty: round((l.receivedQty || 0) + accepted), rejectedQty: round((l.rejectedQty || 0) + rejected) } : l));
            const status = deriveOrderStatus({ ...poData, lines }, "receivedQty", state.company.poTolerancePct);
            tx.update(poRef, { lines, status, updatedAt: serverTimestamp() });
            const line = lines.find((l) => l.lineId === cur.poLineId);
            logActivity(tx, { module: "Purchase Orders", action: "GRN", refId: cur.poId, refNo: cur.poNo, summary: `${number.number}: accepted ${qty(accepted)} ${cur.item.unit} ${cur.item.name}${rejected ? `, rejected ${qty(rejected)}` : ""}. PO now ${qty(line.receivedQty)} / ${qty(line.qty)} received → ${status}` });
          }
          logActivity(tx, { module: "Inward", action: "GRN", refId: r.id, refNo: number.number, summary: `${number.number} for ${cur.geNo}: +${qty(accepted)} ${cur.item.unit} ${cur.item.name} into ${warehouseByCode(cur.warehouse).name}${rejected ? `, rejected ${qty(rejected)}` : ""}` });
          return number.number;
        });
        toast(`${grnNo} finalized — stock updated.`, "ok");
        modal.close();
        tab = "COMPLETED";
        await load();
      } catch (error) { reportError(error); } finally { done(); }
    });
  }

  /* ---------------- Delete / reverse (admin) ---------------- */
  async function deleteReceipt(r, parentModal) {
    const reason = await confirmDialog(`Delete gate entry ${r.geNo}? The PO quantities will be reversed.`, { title: "Delete inward entry", danger: true, okText: "Delete", input: { label: "Reason", required: true } });
    if (!reason) return;
    try {
      await runTransaction(db, async (tx) => {
        const ref = doc(db, "receipts", r.id);
        const cur = (await tx.get(ref)).data();
        if (!["KANTA PENDING", "GRN PENDING"].includes(cur.stage)) throw new Error("Only entries that are not yet GRN-finalized can be deleted. Use Reverse GRN instead.");
        if (cur.poId) {
          const poRef = doc(db, "purchaseOrders", cur.poId);
          const poData = (await tx.get(poRef)).data();
          const short = cur.stage === "GRN PENDING" && cur.shortageQty > 0 ? cur.shortageQty : 0;
          const lines = poData.lines.map((l) => (l.lineId === cur.poLineId ? { ...l, invoicedQty: round(Math.max(0, (l.invoicedQty || 0) - cur.invoiceQty)), shortQty: round(Math.max(0, (l.shortQty || 0) - short)) } : l));
          tx.update(poRef, { lines, status: deriveOrderStatus({ ...poData, lines }, "receivedQty", state.company.poTolerancePct), updatedAt: serverTimestamp() });
          logActivity(tx, { module: "Purchase Orders", action: "INWARD DELETED", refId: cur.poId, refNo: cur.poNo, summary: `Gate entry ${cur.geNo} deleted. Reason: ${reason}` });
        }
        tx.update(ref, { stage: "CANCELLED", cancelReason: reason, cancelledAt: serverTimestamp(), cancelledBy: { uid: state.user.uid, name: state.profile.name || state.user.email } });
        logActivity(tx, { module: "Inward", action: "DELETE", refId: r.id, refNo: cur.geNo, summary: `Deleted gate entry ${cur.geNo} (${cur.item.name}, invoice ${cur.invoiceNo}). Reason: ${reason}` });
      });
      toast(`${r.geNo} deleted.`, "ok");
      parentModal?.close();
      await load();
    } catch (error) { reportError(error); }
  }

  async function reverseGrn(r, parentModal) {
    const reason = await confirmDialog(`Reverse ${r.grn.grnNo}? ${qty(r.grn.acceptedQty)} ${r.item.unit} of ${r.item.name} will be removed from ${warehouseByCode(r.warehouse).name} stock and the PO will be reopened for that quantity.`, { title: "Reverse GRN", danger: true, okText: "Reverse GRN", input: { label: "Reason", required: true } });
    if (!reason) return;
    try {
      await runTransaction(db, async (tx) => {
        const ref = doc(db, "receipts", r.id);
        const cur = (await tx.get(ref)).data();
        if (cur.stage !== "COMPLETED") throw new Error("Only completed GRNs can be reversed.");
        let poRef = null; let poData = null;
        if (cur.poId) { poRef = doc(db, "purchaseOrders", cur.poId); poData = (await tx.get(poRef)).data(); }
        const stock = await readStock(tx, [{ warehouse: cur.warehouse, itemId: cur.item.id }]);
        if (cur.grn.acceptedQty > 0) applyMovements(tx, stock, [{ warehouse: cur.warehouse, item: cur.item, qty: -cur.grn.acceptedQty, note: `Reversal of ${cur.grn.grnNo}: ${reason}` }], { type: "GRN REVERSAL", id: r.id, no: cur.grn.grnNo });
        if (poRef) {
          const lines = poData.lines.map((l) => (l.lineId === cur.poLineId ? {
            ...l,
            invoicedQty: round(Math.max(0, (l.invoicedQty || 0) - cur.invoiceQty)),
            receivedQty: round(Math.max(0, (l.receivedQty || 0) - cur.grn.acceptedQty)),
            rejectedQty: round(Math.max(0, (l.rejectedQty || 0) - (cur.grn.rejectedQty || 0))),
            shortQty: round(Math.max(0, (l.shortQty || 0) - Math.max(0, cur.shortageQty || 0)))
          } : l));
          const base = ["COMPLETED", "PARTIALLY RECEIVED"].includes(poData.status) ? { ...poData, status: "OPEN" } : poData;
          tx.update(poRef, { lines, status: deriveOrderStatus({ ...base, lines }, "receivedQty", state.company.poTolerancePct), updatedAt: serverTimestamp() });
          logActivity(tx, { module: "Purchase Orders", action: "GRN REVERSED", refId: cur.poId, refNo: cur.poNo, summary: `${cur.grn.grnNo} reversed. Reason: ${reason}` });
        }
        tx.update(ref, { stage: "CANCELLED", cancelReason: `GRN reversed: ${reason}`, cancelledAt: serverTimestamp(), cancelledBy: { uid: state.user.uid, name: state.profile.name || state.user.email } });
        logActivity(tx, { module: "Inward", action: "GRN REVERSED", refId: r.id, refNo: cur.grn.grnNo, summary: `Reversed ${cur.grn.grnNo} (${cur.geNo}): −${qty(cur.grn.acceptedQty)} ${cur.item.unit} ${cur.item.name}. Reason: ${reason}` });
      });
      toast("GRN reversed.", "ok");
      parentModal?.close();
      await load();
    } catch (error) { reportError(error); }
  }

  function summaryGrid(r) {
    return `<div class="detail-grid">
      <div><span>Gate Entry</span><b>${esc(r.geNo)}</b></div><div><span>PO</span><b>${esc(r.poNo || "Without PO")}</b></div>
      <div><span>Vendor</span><b>${esc(r.vendor?.name)}</b></div><div><span>Item</span><b>${esc(r.item?.name)}</b></div>
      <div><span>Warehouse</span><b>${esc(warehouseByCode(r.warehouse).name)}</b></div><div><span>Invoice</span><b>${esc(r.invoiceNo)} · ${fmtDate(r.invoiceDate)}</b></div>
      <div><span>Invoice Qty</span><b>${qty(r.invoiceQty)} ${esc(r.item?.unit)}</b></div><div><span>Vehicle</span><b>${esc(r.vehicleNo || "—")}</b></div>
      <div><span>Received As</span><b>${esc(r.receivedAs || "—")}${r.containers ? ` · ${qty(r.containers)}` : ""}</b></div><div><span>Entered</span><b>${fmtDateTime(r.createdAt)} · ${esc(r.createdBy?.name)}</b></div>
      <div><span>Documents</span><b class="small">${docLinks(r.docs)}</b></div>
    </div>`;
  }

  function openView(r) {
    const modal = openModal({
      title: `${r.geNo} ${r.grn ? `· ${r.grn.grnNo}` : ""}`,
      size: "wide",
      body: `${badge(r.stage)}<div style="height:12px"></div>${summaryGrid(r)}
        ${r.kanta ? `<div class="section-title">Kanta</div><div class="detail-grid"><div><span>Gross / Tare / Net</span><b>${qty(r.kanta.grossWeight ?? 0)} / ${qty(r.kanta.tareWeight ?? 0)} / ${qty(r.kanta.netWeight ?? 0)} ${esc(r.kanta.weightUnit || "")}</b></div><div><span>Actual Qty</span><b>${qty(r.kanta.receivedQty)} ${esc(r.item.unit)}</b></div><div><span>Shortage</span><b style="color:${r.shortageQty > 0 ? "var(--danger)" : "inherit"}">${qty(r.shortageQty)} ${esc(r.item.unit)}</b></div><div><span>By</span><b>${esc(r.kanta.by?.name)} · ${fmtDateTime(r.kanta.at)}</b></div><div><span>Remark</span><b>${esc(r.kanta.remark || "—")}</b></div></div>` : ""}
        ${r.grn ? `<div class="section-title">GRN</div><div class="detail-grid"><div><span>GRN No.</span><b>${esc(r.grn.grnNo)}</b></div><div><span>Accepted</span><b>${qty(r.grn.acceptedQty)} ${esc(r.item.unit)}</b></div><div><span>Rejected</span><b>${qty(r.grn.rejectedQty)}</b></div><div><span>Batch</span><b>${esc(r.grn.batchNo || "—")}</b></div><div><span>QC</span><b>${esc(r.grn.qc || "—")}</b></div><div><span>By</span><b>${esc(r.grn.by?.name)} · ${fmtDateTime(r.grn.at)}</b></div><div><span>Remark</span><b>${esc(r.grn.remark || "—")}</b></div></div>` : ""}
        ${r.stage === "CANCELLED" ? `<div class="notice error" style="margin-top:14px">Cancelled by ${esc(r.cancelledBy?.name)} on ${fmtDateTime(r.cancelledAt)} — ${esc(r.cancelReason)}</div>` : ""}`,
      footer: `<button class="btn" data-close>Close</button>${isAdmin() && ["KANTA PENDING", "GRN PENDING"].includes(r.stage) ? '<button class="btn danger" id="delRec">Delete entry</button>' : ""}${isAdmin() && r.stage === "COMPLETED" ? '<button class="btn danger" id="revGrn">Reverse GRN</button>' : ""}`
    });
    modal.el.querySelector("#delRec")?.addEventListener("click", () => deleteReceipt(r, modal));
    modal.el.querySelector("#revGrn")?.addEventListener("click", () => reverseGrn(r, modal));
  }

  await load();
}
