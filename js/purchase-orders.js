import {
  db, reportError, state, initPage, pageHeader, esc, toast, openModal, confirmDialog, badge, busy, formValues, can,
  listCollection, logActivity, money, qty, fmtDate, fmtDateTime, isoDate, addDays, round, computeTotals,
  warehouseByCode, warehouseOptions, deriveOrderStatus, progressBar, exportExcel, STATE_CODES,
  OPEN_PO_STATUSES, normalizeReceipt, PO_SERIES, cleanPoNo, poNumberKey, poNoProblem, PO_NO_DUPLICATE_MSG, PO_NO_NONE_MSG, PO_NO_MAX, accountsBadge, isOnHold, receiptStageLabel,
  TRANSPORT_MODES, HOLD_TEXT, CLOSED_PO_STATUSES, poLineQty, fmtDiff, diffColor, acceptedOf, isServicePo, isServiceItem,
  partyTerms, termsDatalist
} from "./core.js";
import { createLineEditor } from "./line-editor.js";
import { poSpec, showDocument, safeFileName } from "./pdf.js";
import { arrayUnion, collection, doc, getDoc, runTransaction, serverTimestamp, query, where, getDocs, orderBy, limit } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const n = (v) => Number(v) || 0;

/* ---------- Status graphics ---------- */
const pct = (part, whole) => (whole > 0 ? Math.max(0, Math.min(100, (part / whole) * 100)) : 0);
/** Stacked bar for one PO line: accepted · in QC · awaiting Kanta · invoiced (awaiting GRN) · closed balance · (grey = still pending). */
function segBar(q, big = false) {
  const base = Math.max(q.ordered, q.accepted + q.qcPending + q.awaitingKanta + q.awaitingGrn + q.closedBalance) || 1;
  const seg = (cls, v, title) => (v > 0 ? `<i class="${cls}" style="width:${pct(v, base).toFixed(2)}%" title="${title} ${qty(v)}"></i>` : "");
  return `<div class="segbar${big ? " lg" : ""}">${seg("seg-acc", q.accepted, "Accepted (in stock)")}${seg("seg-qc", q.qcPending, "In QC quarantine")}${seg("seg-kanta", q.awaitingKanta, "Awaiting Kanta")}${seg("seg-grn", q.awaitingGrn, "Invoiced, awaiting GRN")}${seg("seg-closed", q.closedBalance, "Closed balance")}</div>`;
}
const LEGEND = '<div class="legend"><span><i class="seg-acc"></i>Accepted (in stock)</span><span><i class="seg-qc"></i>In QC quarantine</span><span><i class="seg-kanta"></i>Awaiting Kanta</span><span><i class="seg-grn"></i>Invoiced, awaiting GRN</span><span><i class="seg-closed"></i>Closed balance</span><span><i style="background:#ecebf3"></i>Still pending</span></div>';

/** Big-picture view of a goods PO: stage flow + quantity tiles + one stacked bar per item. */
function poVisual(po, qs) {
  const units = [...new Set(po.lines.map((l) => l.unit))];
  const one = units.length === 1 ? units[0] : "";
  const sum = (k) => round(qs.reduce((s, q) => s + q[k], 0));
  const capped = (k) => qs.reduce((s, q) => s + Math.min(q[k], q.ordered), 0);
  const ordered = sum("ordered");
  const fig = (k) => (one ? `${qty(sum(k))} ${one}` : `${Math.round(pct(capped(k), ordered))}%`);
  const done = (k) => capped(k) + 0.0005 >= ordered;
  const closed = CLOSED_PO_STATUSES.includes(po.status);
  const finished = po.status === "COMPLETED" || closed;
  const step = (title, value, sub, cls, fill) => `<div class="flow-step ${cls}"><div class="t">${title}</div><div class="n">${value}</div><div class="s">${sub}</div><div class="bar"><i style="width:${fill.toFixed(1)}%"></i></div></div>`;
  const stateOf = (k, waiting) => (done(k) ? "done" : waiting > 0 ? "active" : sum(k) > 0 ? "active" : "idle");
  const inProcess = sum("awaitingGrn") + sum("awaitingKanta") + sum("qcPending");
  const steps = [
    step("Ordered", one ? `${qty(ordered)} ${one}` : `${po.lines.length} items`, fmtDate(po.date), "done", 100),
    step("Invoiced", fig("invoiced"), sum("awaitingGrn") ? `${qty(sum("awaitingGrn"))} awaiting GRN` : "gate entry", stateOf("invoiced", 0), pct(capped("invoiced"), ordered)),
    step("GRN", fig("grn"), "counted at gate", stateOf("grn", 0), pct(capped("grn"), ordered)),
    step("Kanta", fig("kanta"), sum("awaitingKanta") ? `${qty(sum("awaitingKanta"))} awaiting` : sum("shortExcess") ? `short/excess ${fmtDiff(sum("shortExcess"))}` : "weighed", stateOf("kanta", sum("awaitingKanta")), pct(capped("kanta"), ordered)),
    step("QC", sum("qcPending") ? `${qty(sum("qcPending"))}${one ? ` ${one}` : ""}` : "Clear", sum("qcPending") ? "in quarantine" : "nothing held", sum("qcPending") ? "warn" : capped("accepted") > 0 ? "done" : "idle", sum("qcPending") ? 50 : capped("accepted") > 0 ? 100 : 0),
    step("In stock", fig("accepted"), `${Math.round(pct(capped("accepted"), ordered))}% of order`, done("accepted") ? "done" : capped("accepted") > 0 ? "active" : "idle", pct(capped("accepted"), ordered)),
    step(closed ? "Closed" : finished ? "Completed" : "Pending", closed ? `${one ? `${qty(sum("closedBalance"))} ${one}` : "with balance"}` : finished ? "✓" : one ? `${qty(sum("pending"))} ${one}` : `${Math.round(100 - pct(capped("accepted"), ordered))}%`, closed ? "closed balance — not received" : finished ? fmtDateTime(po.updatedAt) : "still to come", closed ? "closed" : finished ? "done" : "active", finished ? 100 : pct(capped("accepted"), ordered))
  ].join("");
  const tiles = one ? `<div class="tiles">
      <div class="tile"><div class="t">Ordered</div><div class="n">${qty(ordered)}</div></div>
      <div class="tile green"><div class="t">Accepted in stock</div><div class="n">${qty(sum("accepted"))}</div></div>
      <div class="tile indigo"><div class="t">In process</div><div class="n">${qty(inProcess)}</div></div>
      <div class="tile red"><div class="t">Rejected</div><div class="n">${qty(sum("rejected"))}</div></div>
      <div class="tile amber"><div class="t">Pending</div><div class="n">${qty(sum("pending"))}</div></div>
      <div class="tile gold"><div class="t">Closed balance</div><div class="n">${qty(sum("closedBalance"))}</div></div></div>` : "";
  const items = po.lines.map((l, i) => {
    const q = qs[i];
    return `<div class="item-flow"><div class="nm">${esc(l.name)}<div class="small muted">${qty(q.ordered)} ${esc(l.unit)} ordered</div></div>${segBar(q, true)}
      <div class="fig">Accepted <b>${qty(q.accepted)}</b> · QC <b>${qty(q.qcPending)}</b> · Kanta pending <b>${qty(q.awaitingKanta)}</b> · Awaiting GRN <b>${qty(q.awaitingGrn)}</b> · Pending <b>${qty(q.pending)}</b>${q.closedBalance ? ` · Closed balance <b>${qty(q.closedBalance)}</b>` : ""}${q.rejected ? ` · <span style="color:var(--danger)">Rejected <b>${qty(q.rejected)}</b></span>` : ""} ${esc(l.unit)}</div></div>`;
  }).join("");
  return `<div class="section-title">PO status at a glance</div><div class="flow" id="poFlow">${steps}</div>${tiles}${items}${LEGEND}`;
}

const page = await initPage("po");
if (page) start();

async function start() {
  let pos = [];
  let vendors = [];
  let items = [];
  let tab = "ACTIVE";
  const canEdit = can("commercial");

  page.innerHTML = `${pageHeader("Purchase", "Purchase Orders", "Goods POs are tracked until every unit has arrived; Service POs (transport and other services) are closed on bill / service confirmation.",
    `<button class="btn" id="exportBtn"><i class="fa-solid fa-download"></i> Export</button>${canEdit ? '<button class="btn primary" id="newPo"><i class="fa-solid fa-plus"></i> New Purchase Order</button>' : ""}`)}
    <div class="tabs" id="tabs"></div>
    <div class="card">
      <div class="card-head"><div class="toolbar"><input class="input search" id="search" placeholder="Search PO no, vendor, item…" />
        <select class="input" id="whFilter"><option value="">All delivery locations</option>${warehouseOptions("", { includeBlank: false })}</select>
        <select class="input" id="typeFilter"><option value="">Goods & Service</option><option value="GOODS">Goods POs</option><option value="SERVICE">Service POs</option></select>
        <select class="input" id="seriesFilter" hidden><option value="">All PO series</option>${Object.entries(PO_SERIES).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join("")}</select></div><span class="small muted" id="count"></span></div>
      <div class="table-wrap"><table class="table"><thead><tr><th>PO No.</th><th>Date</th><th>Vendor</th><th>Deliver To</th><th>Items</th><th class="num">Value (₹)</th><th>Received</th><th>Status</th><th></th></tr></thead><tbody id="rows"></tbody></table></div>
    </div>`;

  const TABS = [["ACTIVE", "All open"], ["OPEN", "Open"], ["PARTIALLY RECEIVED", "Partially received"], ["AWAITING KANTA", "Awaiting Kanta"], ["PARTIALLY INWARDED", "Partially inwarded"], ["COMPLETED", "Completed"], ["CLOSED", "Closed with balance"], ["CANCELLED", "Cancelled"], ["ALL", "All"]];
  const inTab = (po, t) => t === "ALL" || (t === "ACTIVE" ? OPEN_PO_STATUSES.includes(po.status) : t === "CLOSED" ? CLOSED_PO_STATUSES.includes(po.status) : t === "COMPLETED" ? ["COMPLETED", "SERVICE COMPLETED"].includes(po.status) : po.status === t);

  function lineProgress(po) {
    const ordered = po.lines.reduce((s, l) => s + (Number(l.qty) || 0), 0);
    const received = po.lines.reduce((s, l) => s + Math.min(Number(l.receivedQty) || 0, Number(l.qty) || 0), 0);
    return { ordered, received };
  }

  function render() {
    page.querySelector("#tabs").innerHTML = TABS.map(([k, label]) => `<button class="tab ${k === tab ? "active" : ""}" data-tab="${k}">${label}<span class="count">${pos.filter((p) => inTab(p, k)).length}</span></button>`).join("");
    const term = page.querySelector("#search").value.trim().toLowerCase();
    const wh = page.querySelector("#whFilter").value;
    const series = page.querySelector("#seriesFilter").value;
    const type = page.querySelector("#typeFilter").value;
    const list = pos.filter((p) => inTab(p, tab) && (!wh || p.warehouse === wh) && (!series || p.series === series) && (!type || (type === "SERVICE") === isServicePo(p))
      && (!term || [p.poNo, p.vendor?.name, p.refNo, ...p.lines.map((l) => l.name)].some((v) => String(v || "").toLowerCase().includes(term))));
    page.querySelector("#count").textContent = `${list.length} purchase order${list.length === 1 ? "" : "s"}`;
    const rows = page.querySelector("#rows");
    if (!list.length) { rows.innerHTML = '<tr><td class="empty" colspan="9">No purchase orders here.</td></tr>'; return; }
    rows.innerHTML = list.map((p) => {
      const { ordered, received } = lineProgress(p);
      const single = p.lines.length === 1 ? p.lines[0] : null;
      return `<tr>
        <td class="strong nowrap"><a href="#" data-view="${esc(p.id)}">${esc(p.poNo)}</a>${p.series ? `<div class="small muted">${esc(PO_SERIES[p.series]?.label || p.series)}</div>` : ""}${isServicePo(p) ? ' <span class="badge indigo">SERVICE</span>' : ""}</td>
        <td class="nowrap">${fmtDate(p.date)}</td>
        <td>${esc(p.vendor?.name)}</td>
        <td>${esc(warehouseByCode(p.warehouse).name)}</td>
        <td>${single ? `${esc(single.name)}<div class="small muted">${qty(single.qty)} ${esc(single.unit)}</div>` : `${p.lines.length} items`}</td>
        <td class="num">${money(p.totals?.total)}</td>
        <td>${isServicePo(p) ? `<span class="small muted">${p.status === "SERVICE COMPLETED" ? `Bill ${esc(p.serviceCompletion?.billNo || "")}` : "Service — no inward"}</span>` : `${single ? segBar(poLineQty(single, p.status)) : progressBar(received, ordered)}<div class="progress-label">${single ? `${qty(single.receivedQty || 0)} / ${qty(single.qty)} ${esc(single.unit)}` : `${Math.round((received / (ordered || 1)) * 100)}%`}</div>`}</td>
        <td>${badge(p.status)}</td>
        <td><div class="actions"><button class="btn sm" data-pdf="${esc(p.id)}" title="PDF"><i class="fa-solid fa-file-pdf"></i></button><button class="btn sm" data-view="${esc(p.id)}">Open</button></div></td>
      </tr>`;
    }).join("");
  }

  async function load() {
    [pos, vendors, items] = await Promise.all([
      listCollection("purchaseOrders", "createdAt", "desc"),
      listCollection("parties"),
      listCollection("items")
    ]);
    page.querySelector("#seriesFilter").hidden = !pos.some((p) => p.series);
    render();
  }

  page.addEventListener("click", (event) => {
    const t = event.target.closest("[data-tab]");
    if (t) { tab = t.dataset.tab; render(); return; }
    const v = event.target.closest("[data-view]");
    if (v) { event.preventDefault(); openDetail(pos.find((p) => p.id === v.dataset.view)); return; }
    const pdf = event.target.closest("[data-pdf]");
    if (pdf) { const po = pos.find((p) => p.id === pdf.dataset.pdf); showDocument(poSpec(po), `${safeFileName(po.poNo)}.pdf`); }
  });
  page.querySelector("#search").addEventListener("input", render);
  page.querySelector("#whFilter").addEventListener("change", render);
  page.querySelector("#seriesFilter").addEventListener("change", render);
  page.querySelector("#typeFilter").addEventListener("change", render);
  page.querySelector("#newPo")?.addEventListener("click", () => openEditor());
  page.querySelector("#exportBtn").addEventListener("click", () => {
    const rows = pos.flatMap((p) => p.lines.map((l) => {
      const q = poLineQty(l, p.status);
      return {
        "PO No": p.poNo, Type: isServicePo(p) ? "Service" : "Goods", Series: PO_SERIES[p.series]?.label || "", Date: fmtDate(p.date), Vendor: p.vendor?.name, "Vendor GSTIN": p.vendor?.gstin || "", "Deliver To": warehouseByCode(p.warehouse).name,
        "Payment Terms": p.paymentTerms || "", Item: l.name, HSN: l.hsn, Unit: l.unit, "Ordered Qty": q.ordered, Rate: l.rate, "GST %": l.gstRate, "Line Amount": round(q.ordered * n(l.rate), 2),
        "Invoiced Qty": q.invoiced, "GRN Qty": q.grn, "Kanta Qty": q.kanta, "Short(-)/Excess(+)": q.shortExcess, "Rejected Qty": q.rejected, "Accepted (Inward) Qty": q.accepted, "Awaiting Kanta": q.awaitingKanta,
        "Closed Balance (not received)": q.closedBalance, "Pending Qty": q.pending, "Payable Value (before GST)": round(q.accepted * n(l.rate), 2), "PO Total": p.totals?.total, Status: p.status,
        "Closed By": p.closedBy?.name || "", "Close Reason": p.closeReason || "", "Service Bill": p.serviceCompletion?.billNo || ""
      };
    }));
    if (!rows.length) { toast("Nothing to export."); return; }
    exportExcel(rows, `CCPL_Purchase_Orders_${isoDate()}.xlsx`, "Purchase Orders");
  });

  /* ---------------- Editor ---------------- */
  function openEditor(existing = null, { duplicate = false } = {}) {
    if (!vendors.filter((v) => v.active !== false).length) { toast("Add the vendor first (Purchase → Vendors & Customers).", "error"); return; }
    if (!items.filter((i) => i.active !== false).length) { toast("Add items first (Inventory → Items & Packaging).", "error"); return; }
    const po = existing || {};
    const editing = existing && !duplicate;
    const firstWh = po.warehouse || state.warehouses[0]?.code;
    const modal = openModal({
      title: editing ? `Edit ${po.poNo}` : "New Purchase Order",
      size: "full",
      body: `<form id="poForm" novalidate>
        <div class="form-grid">
          <label class="field span-2"><span>PO Number <b class="req">*</b></span>
            <div style="display:flex;gap:8px"><input name="poNo" maxlength="${PO_NO_MAX}" autocomplete="off" spellcheck="false" value="${esc(editing ? po.poNo : "")}" placeholder="Type the full PO number, e.g. CCPL/PH/001/26-27" style="flex:1" />
            ${editing ? "" : '<button class="btn" type="button" id="useLastPo" disabled title="Copies only the last PO number into this field so you can edit it. Nothing else is copied."><i class="fa-solid fa-clock-rotate-left"></i> Use last PO no.</button>'}</div>
            <small class="help" data-lastpo>${editing ? "You can change the number; it must stay unique." : "Checking the last saved PO number…"}</small>
            <small class="help" data-pocheck role="alert" style="color:var(--danger)"></small></label>
          ${editing ? `<label class="field"><span>PO Type</span><input readonly value="${isServicePo(po) ? "Service PO" : "Goods PO"}" /></label>`
            : `<label class="field"><span>PO Type <b class="req">*</b></span><select name="poType"><option value="GOODS" ${isServicePo(po) ? "" : "selected"}>Goods PO (material inward, GRN, Kanta)</option><option value="SERVICE" ${isServicePo(po) ? "selected" : ""}>Service PO (transport / other services — no inward)</option></select></label>`}
          <label class="field span-2"><span>Vendor <b class="req">*</b></span><select name="vendorId" required><option value="">Select vendor…</option>${vendors.filter((v) => v.active !== false || v.id === po.vendor?.id).sort((a, b) => a.name.localeCompare(b.name)).map((v) => `<option value="${esc(v.id)}" ${v.id === po.vendor?.id ? "selected" : ""}>${esc(v.name)}${v.gstin ? ` · ${esc(v.gstin)}` : ""}</option>`).join("")}</select></label>
          <label class="field"><span>PO Date <b class="req">*</b></span><input type="date" name="date" value="${esc(editing ? po.date : isoDate())}" required /></label>
          <label class="field"><span>Deliver To <b class="req">*</b></span><select name="warehouse" required>${warehouseOptions(firstWh, { includeBlank: false })}</select></label>
          <label class="field"><span>Payment Terms</span><input name="paymentTerms" list="poTerms" value="${esc(po.paymentTerms || "30 Days")}" placeholder="e.g. 30 Days, Advance, Against delivery" />${termsDatalist("poTerms")}</label>
          <label class="field"><span>Ref#</span><input name="refNo" value="${esc(editing ? po.refNo || "" : "")}" placeholder="Defaults to PO number" /></label>
          <label class="field"><span>Place Of Supply</span><input name="placeOfSupply" value="${esc(po.placeOfSupply || `${state.company.state} (${state.company.stateCode})`)}" /></label>
          <label class="field"><span>Dispatch Through</span><input name="dispatchThrough" value="${esc(po.dispatchThrough || "PARTY TRANSPORT")}" /></label>
          <label class="field"><span>Destination</span><input name="destination" value="${esc(po.destination || warehouseByCode(firstWh).destination || "")}" /></label>
          <label class="field"><span>Terms of Delivery</span><input name="deliveryTerms" value="${esc(po.deliveryTerms || "BY ROAD")}" /></label>
          <label class="field"><span>Expected Delivery</span><input type="date" name="expectedDate" value="${esc(po.expectedDate || addDays(isoDate(), 7))}" /></label>
          <label class="field"><span>Tax Type</span><input name="taxType" readonly value="" /></label>
        </div>
        <div class="section-title">Items</div>
        <div id="lines"></div>
        <div class="section-title">Notes & Terms</div>
        <div class="form-grid">
          <label class="field span-2"><span>Notes (printed on PO)</span><textarea name="notes" rows="4">${esc(po.notes || "")}</textarea></label>
          <label class="field span-2"><span>Terms & Conditions (one per line)</span><textarea name="terms" rows="6">${esc(po.terms ?? state.company.poTerms)}</textarea></label>
        </div>
      </form>`,
      footer: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="savePo"><i class="fa-solid fa-floppy-disk"></i> ${editing ? "Save changes" : "Create PO"}</button>`
    });
    const form = modal.el.querySelector("#poForm");
    const vendorOf = () => vendors.find((v) => v.id === form.vendorId.value);
    const intra = () => { const v = vendorOf(); return !v || !v.stateCode || String(v.stateCode) === String(state.company.stateCode); };
    const setTaxType = () => {
      const v = vendorOf();
      form.taxType.value = intra() ? "CGST + SGST (intra-state)" : `IGST (inter-state · ${STATE_CODES[v.stateCode] || v.stateCode})`;
      editor.refresh();
    };
    const serviceType = () => (form.poType ? form.poType.value === "SERVICE" : isServicePo(po));
    let editor;
    const makeEditor = (lines) => {
      editor = createLineEditor(modal.el.querySelector("#lines"), {
        items, lines, isIntraState: intra,
        itemFilter: (i) => (serviceType() ? isServiceItem(i) : !isServiceItem(i))
      });
    };
    makeEditor((po.lines || []).map((l) => (duplicate ? { ...l, lineId: undefined } : l)));
    form.poType?.addEventListener("change", () => {
      makeEditor([]);
      if (serviceType() && !items.some((i) => isServiceItem(i) && i.active !== false)) toast("Add service items first (Items & Packaging → category Service, e.g. Transportation Charges).", "error");
    });
    form.vendorId.addEventListener("change", () => {
      const terms = partyTerms(vendorOf());
      if (terms) form.paymentTerms.value = terms;
      setTaxType();
    });
    form.warehouse.addEventListener("change", () => { form.destination.value = warehouseByCode(form.warehouse.value).destination || form.destination.value; });
    // PO number: manual entry; the last saved PO number (most recently CREATED, not the highest) is offered only as an editable reference.
    const lastHint = form.querySelector("[data-lastpo]");
    const checkHint = form.querySelector("[data-pocheck]");
    const ownKey = editing ? poNumberKey(po.poNo) : "";
    if (!editing) {
      getDocs(query(collection(db, "purchaseOrders"), orderBy("createdAt", "desc"), limit(1))).then((snap) => {
        const last = snap.docs[0]?.data();
        const btn = modal.el.querySelector("#useLastPo");
        if (!last?.poNo) { lastHint.textContent = PO_NO_NONE_MSG; return; }
        lastHint.innerHTML = `Last saved PO: <b>${esc(last.poNo)}</b> (created ${esc(fmtDateTime(last.createdAt))}${last.createdBy?.name ? ` by ${esc(last.createdBy.name)}` : ""}). Use it as a reference and edit any part — prefix, series, FY or sequence.`;
        btn.disabled = false;
        btn.addEventListener("click", () => { form.poNo.value = last.poNo; form.poNo.focus(); form.poNo.setSelectionRange(last.poNo.length, last.poNo.length); checkPoNo(); });
      }).catch(() => { lastHint.textContent = "Could not load the last PO number. Enter the PO number."; });
    }
    let checkSeq = 0;
    const checkPoNo = async () => {
      const seq = ++checkSeq;
      const value = form.poNo.value;
      if (!cleanPoNo(value)) { checkHint.textContent = ""; return; }
      const problem = poNoProblem(value);
      if (problem) { checkHint.textContent = problem; return; }
      if (poNumberKey(value) === ownKey) { checkHint.textContent = ""; return; }
      try {
        const taken = (await getDoc(doc(db, "poNumbers", poNumberKey(value)))).exists();
        if (seq === checkSeq) checkHint.textContent = taken ? PO_NO_DUPLICATE_MSG : "";
      } catch { if (seq === checkSeq) checkHint.textContent = ""; }
    };
    let checkTimer;
    form.poNo.addEventListener("input", () => { clearTimeout(checkTimer); checkHint.textContent = ""; checkTimer = setTimeout(checkPoNo, 350); });
    form.poNo.addEventListener("blur", checkPoNo);
    setTaxType();

    modal.el.querySelector("#savePo").addEventListener("click", async (event) => {
      const values = formValues(form);
      const vendor = vendorOf();
      let lines;
      try {
        const poProblem = poNoProblem(values.poNo);
        if (poProblem) throw new Error(poProblem);
        if (!vendor) throw new Error("Select a vendor.");
        if (!values.date) throw new Error("Select the PO date.");
        if (!values.warehouse) throw new Error("Select the delivery location.");
        lines = editor.value();
      } catch (error) { toast(error.message, "error"); return; }
      const totals = computeTotals(lines, intra());
      const wh = warehouseByCode(values.warehouse);
      const data = {
        date: values.date,
        vendor: { id: vendor.id, name: vendor.name, gstin: vendor.gstin || "", pan: vendor.pan || "", stateCode: vendor.stateCode || "", address1: vendor.address1 || "", address2: vendor.address2 || "", city: vendor.city || "", pincode: vendor.pincode || "", state: vendor.state || "", country: vendor.country || "India", phone: vendor.phone || "", email: vendor.email || "", contactPerson: vendor.contactPerson || "" },
        vendorId: vendor.id,
        warehouse: wh.code,
        deliverTo: { code: wh.code, name: wh.name, addressLines: wh.addressLines || [] },
        paymentTerms: values.paymentTerms, placeOfSupply: values.placeOfSupply, dispatchThrough: values.dispatchThrough,
        destination: values.destination, deliveryTerms: values.deliveryTerms, expectedDate: values.expectedDate || "",
        notes: values.notes, terms: values.terms, intraState: intra(),
        lines: lines.map((l) => ({ ...l, invoicedQty: 0, grnQty: 0, pendingKantaQty: 0, receivedQty: 0, varianceQty: 0, rejectedQty: 0, closedBalanceQty: 0 })),
        totals,
        itemIds: [...new Set(lines.map((l) => l.itemId))],
        updatedAt: serverTimestamp()
      };
      const poNo = cleanPoNo(values.poNo);
      const key = poNumberKey(poNo);
      const by = { uid: state.user.uid, name: state.profile.name || state.user.email };
      const done = busy(event.currentTarget);
      try {
        // The registry document /poNumbers/{key} is read and created inside the transaction; firestore.rules also refuse a
        // second registration of the same key, so simultaneous saves of one number cannot both succeed.
        const saved = await runTransaction(db, async (tx) => {
          const keyRef = doc(db, "poNumbers", key);
          if (editing) {
            const ref = doc(db, "purchaseOrders", po.id);
            const snap = await tx.get(ref);
            const cur = snap.data();
            if (cur.status !== "OPEN" || cur.lines.some((l) => (l.invoicedQty || 0) > 0)) throw new Error("This PO already has material inward against it and can no longer be edited. Close it with balance and raise a new PO instead.");
            const oldKey = cur.poNoKey || poNumberKey(cur.poNo);
            const renumber = key !== oldKey;
            if (renumber && (await tx.get(keyRef)).exists()) throw new Error(PO_NO_DUPLICATE_MSG);
            const oldKeyRef = doc(db, "poNumbers", oldKey);
            const oldReg = renumber && cur.poNoKey ? await tx.get(oldKeyRef) : null;
            data.poNo = renumber ? poNo : cur.poNo; // same number (any case / spacing) → kept exactly as saved
            data.poNoKey = renumber ? key : cur.poNoKey || null;
            if (!data.poNoKey) delete data.poNoKey;
            data.refNo = values.refNo && values.refNo !== cur.poNo ? values.refNo : data.poNo;
            // keep rejected-vehicle history of unchanged lines
            data.lines = data.lines.map((l) => ({ ...l, rejectedQty: n(cur.lines.find((x) => x.lineId === l.lineId)?.rejectedQty) }));
            if (renumber) {
              tx.set(keyRef, { number: poNo, poId: ref.id, at: serverTimestamp(), by });
              // The old number is released only when this PO owned it (it was never used by another PO).
              if (oldReg?.exists() && oldReg.data().poId === ref.id) tx.delete(oldKeyRef);
            }
            tx.update(ref, data);
            logActivity(tx, { module: "Purchase Orders", action: "UPDATE", refId: ref.id, refNo: data.poNo, summary: `Edited PO ${data.poNo}${renumber ? ` (PO number changed from ${cur.poNo})` : ""} · ${vendor.name} · ₹${money(totals.total)}` });
            return { id: ref.id, poNo: data.poNo };
          }
          const ref = doc(collection(db, "purchaseOrders"));
          if ((await tx.get(keyRef)).exists()) throw new Error(PO_NO_DUPLICATE_MSG);
          tx.set(keyRef, { number: poNo, poId: ref.id, at: serverTimestamp(), by });
          tx.set(ref, { ...data, poType: values.poType === "SERVICE" ? "SERVICE" : "GOODS", poNo, poNoKey: key, refNo: values.refNo || poNo, status: "OPEN", createdAt: serverTimestamp(), createdBy: by });
          logActivity(tx, { module: "Purchase Orders", action: "CREATE", refId: ref.id, refNo: poNo, summary: `Created ${values.poType === "SERVICE" ? "Service PO" : "PO"} ${poNo} · ${vendor.name} · ${lines.map((l) => `${l.name} ${qty(l.qty)} ${l.unit}`).join(", ")} · ₹${money(totals.total)}` });
          return { id: ref.id, poNo };
        });
        toast(`${saved.poNo} saved.`, "ok");
        modal.close();
        await load();
        const fresh = pos.find((p) => p.id === saved.id);
        if (fresh && !editing) showDocument(poSpec(fresh), `${safeFileName(fresh.poNo)}.pdf`);
      } catch (error) {
        // A rules rejection of the registry write means another user saved the same number a moment earlier.
        const taken = error.message === PO_NO_DUPLICATE_MSG
          || (["permission-denied", "already-exists", "aborted"].includes(error.code) && await getDoc(doc(db, "poNumbers", key)).then((d) => d.exists() && (!editing || d.data().poId !== po.id), () => false));
        if (taken) {
          checkHint.textContent = PO_NO_DUPLICATE_MSG;
          toast(PO_NO_DUPLICATE_MSG, "error");
          form.poNo.focus();
        } else reportError(error);
      } finally { done(); }
    });
  }

  /* ---------------- Detail ---------------- */
  async function openDetail(po) {
    if (!po) return;
    const [byList, byLegacy, logSnap] = await Promise.all([
      getDocs(query(collection(db, "receipts"), where("poIds", "array-contains", po.id))),
      getDocs(query(collection(db, "receipts"), where("poId", "==", po.id))),
      getDocs(query(collection(db, "activity"), where("refId", "==", po.id)))
    ]);
    const receiptMap = new Map([...byList.docs, ...byLegacy.docs].map((d) => [d.id, normalizeReceipt({ id: d.id, ...d.data() })]));
    const receipts = [...receiptMap.values()].sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
    const mineOf = (r) => r.lines.filter((l) => l.poId === po.id);
    const log = logSnap.docs.map((d) => d.data()).sort((a, b) => (b.at?.seconds || 0) - (a.at?.seconds || 0));
    const inProcess = receipts.filter((r) => ["KANTA PENDING", "GRN PENDING", "QC PENDING"].includes(r.stage));
    const onHold = receipts.filter(isOnHold);
    const service = isServicePo(po);
    const transportTotal = round(receipts.filter((r) => r.stage !== "CANCELLED").reduce((s, r) => s + n(r.transportAmount), 0), 2);
    const open = OPEN_PO_STATUSES.includes(po.status);
    const editable = canEdit && po.status === "OPEN" && !po.lines.some((l) => (l.invoicedQty || 0) > 0);
    const closable = can("close") && open && !service && !editable;
    const serviceDone = can("close") && open && service;
    const reopenable = can("close") && [...CLOSED_PO_STATUSES, "SERVICE COMPLETED"].includes(po.status);
    const qs = po.lines.map((l) => poLineQty(l, po.status));
    const totalOf = (k) => round(qs.reduce((s, q) => s + q[k], 0));
    const closedNote = CLOSED_PO_STATUSES.includes(po.status)
      ? `<div class="notice warn" style="margin-bottom:14px"><i class="fa-solid fa-circle-info"></i><div><b>Closed with Balance</b> by <b>${esc(po.closedBy?.name)}</b> on ${fmtDateTime(po.closedAt)} — ${esc(po.closeReason)}.
         Balance closed without receipt: ${po.lines.map((l, i) => `${esc(l.name)} ${qty(qs[i].closedBalance)} ${esc(l.unit)}`).join(", ")}. It is kept in history and is not pending. ${reopenable ? "Reopen to make it pending again." : ""}</div></div>` : "";
    const modal = openModal({
      title: `${po.poNo}${service ? " · Service PO" : ""}`,
      size: "full",
      body: `<div style="display:flex;gap:10px;align-items:center;margin-bottom:14px;flex-wrap:wrap">${badge(po.status)}${service ? badge("SERVICE") : ""}<span class="muted">${esc(po.vendor?.name)} · ${service ? "Service at" : "Deliver to"} ${esc(warehouseByCode(po.warehouse).name)} · ₹${money(po.totals?.total)}</span></div>
        ${closedNote}
        ${po.status === "CANCELLED" ? `<div class="notice error" style="margin-bottom:14px"><i class="fa-solid fa-ban"></i><div>Cancelled by <b>${esc(po.closedBy?.name)}</b> on ${fmtDateTime(po.closedAt)} — ${esc(po.closeReason)}</div></div>` : ""}
        ${po.status === "SERVICE COMPLETED" ? `<div class="notice ok" style="margin-bottom:14px"><i class="fa-solid fa-circle-check"></i><div><b>Service completed</b> — confirmed by ${esc(po.serviceCompletion?.by?.name)} on ${fmtDateTime(po.serviceCompletion?.at)}. Bill ${esc(po.serviceCompletion?.billNo)} dated ${fmtDate(po.serviceCompletion?.billDate)}${po.serviceCompletion?.billAmount !== null && po.serviceCompletion?.billAmount !== undefined ? ` · ₹${money(po.serviceCompletion.billAmount)}` : ""}${po.serviceCompletion?.note ? ` — ${esc(po.serviceCompletion.note)}` : ""}</div></div>` : ""}
        <div class="detail-grid" style="margin-bottom:18px">
          <div><span>PO Date</span><b>${fmtDate(po.date)}</b></div><div><span>Payment Terms</span><b>${esc(po.paymentTerms || "—")}</b></div>
          <div><span>Expected ${service ? "Completion" : "Delivery"}</span><b>${fmtDate(po.expectedDate)}</b></div><div><span>Created By</span><b>${esc(po.createdBy?.name || "—")}</b></div>
          <div><span>Vendor GSTIN</span><b>${esc(po.vendor?.gstin || "—")}</b></div><div><span>Tax</span><b>${po.intraState ? "CGST + SGST" : "IGST"}</b></div>
          <div><span>${po.series ? "PO Series · Type" : "PO Type"}</span><b>${po.series ? `${esc(PO_SERIES[po.series]?.label || po.series)} · ` : ""}${service ? "Service" : "Goods"}</b></div>${service ? "" : `<div><span>Transport cost (internal, not on PO)</span><b>₹${money(transportTotal)}</b></div>`}
        </div>
        ${onHold.length ? `<div class="notice error" style="margin-bottom:14px"><i class="fa-solid fa-hand"></i><div><b>${HOLD_TEXT}</b> — ${onHold.map((r) => `${esc(r.geNo)} (invoice ${esc(r.invoiceNo)}${r.stage === "COMPLETED" ? ", rejected quantity only" : ""})`).join(", ")}. Rejected quantity is not counted as received; the PO quantity stays pending. Other receipts on this PO are not affected.</div></div>` : ""}
        ${service ? `<div class="section-title">Services ordered</div>
        <div class="table-wrap"><table class="table"><thead><tr><th>Service</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead><tbody>
          ${po.lines.map((l) => `<tr><td class="strong">${esc(l.name)}<div class="small muted">${esc(l.description || "")}</div></td><td class="num">${qty(n(l.qty))} ${esc(l.unit)}</td><td class="num">${money(l.rate)}</td><td class="num">${money(n(l.qty) * n(l.rate))}</td></tr>`).join("")}
        </tbody></table></div><p class="small muted">A Service PO needs no inward, GRN or Kanta. When the bill / service confirmation is received, mark the service completed to close the PO.</p>`
        : `${poVisual(po, qs)}<div class="section-title">Item-wise tracking (Kanta is final; only accepted quantity counts)</div>
        <div class="table-wrap"><table class="table" id="poLines"><thead><tr><th>Item</th><th class="num">PO Qty</th><th class="num">Invoiced</th><th class="num">GRN Qty</th><th class="num">Kanta Qty</th><th class="num">Short / Excess</th><th class="num">Rejected</th><th class="num">Accepted (Inward)</th><th class="num">Awaiting Kanta</th><th class="num">In QC</th><th class="num">Closed Balance</th><th class="num">Pending</th><th class="num">Payable ₹</th><th>Progress</th></tr></thead><tbody>
          ${po.lines.map((l, i) => {
            const q = qs[i];
            return `<tr data-line="${esc(l.name)}"><td class="strong">${esc(l.name)}</td><td class="num">${qty(q.ordered)} ${esc(l.unit)}</td><td class="num">${qty(q.invoiced)}</td><td class="num">${qty(q.grn)}</td><td class="num">${qty(q.kanta)}</td>
              <td class="num strong" style="color:${diffColor(q.shortExcess)}">${fmtDiff(q.shortExcess)}</td><td class="num" style="color:${q.rejected ? "var(--danger)" : "inherit"}">${qty(q.rejected)}</td><td class="num strong">${qty(q.accepted)}</td><td class="num">${qty(q.awaitingKanta)}</td><td class="num">${qty(q.qcPending)}</td>
              <td class="num" style="color:${q.closedBalance ? "#8a6a22" : "inherit"}">${qty(q.closedBalance)}</td><td class="num strong">${qty(q.pending)}</td><td class="num">${money(q.accepted * n(l.rate))}</td><td>${segBar(q)}</td></tr>`;
          }).join("")}
          ${po.lines.length > 1 ? `<tr class="strong"><td>Total</td><td class="num">${qty(totalOf("ordered"))}</td><td class="num">${qty(totalOf("invoiced"))}</td><td class="num">${qty(totalOf("grn"))}</td><td class="num">${qty(totalOf("kanta"))}</td><td class="num">${fmtDiff(totalOf("shortExcess"))}</td><td class="num">${qty(totalOf("rejected"))}</td><td class="num">${qty(totalOf("accepted"))}</td><td class="num">${qty(totalOf("awaitingKanta"))}</td><td class="num">${qty(totalOf("qcPending"))}</td><td class="num">${qty(totalOf("closedBalance"))}</td><td class="num">${qty(totalOf("pending"))}</td><td></td><td></td></tr>` : ""}
        </tbody></table></div>
        <div class="section-title">Invoices / receipts (${receipts.length})</div>
        ${receipts.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Receipt</th><th>Date</th><th>Invoice</th><th>Item</th><th class="num">Invoice</th><th class="num">GRN</th><th class="num">Kanta</th><th class="num">Short/Excess</th><th class="num">Rejected</th><th class="num">Accepted</th><th>GRN No.</th><th>Transport (internal)</th><th>Stage</th><th>Accounts</th></tr></thead><tbody>
          ${receipts.flatMap((r) => { const mine = mineOf(r); return mine.map((l, i) => {
            const weighed = l.kantaQty !== undefined;
            const v = weighed ? round(n(l.kantaQty) - n(l.grnQty)) : null;
            const others = [...new Set(r.lines.filter((x) => x.poId && x.poId !== po.id).map((x) => x.poNo))];
            return `<tr>${i === 0 ? `<td class="strong nowrap" rowspan="${mine.length}">${esc(r.geNo)}${others.length ? `<div class="small muted">same bill also on ${esc(others.join(", "))}</div>` : ""}</td><td class="nowrap" rowspan="${mine.length}">${fmtDateTime(r.createdAt)}</td><td rowspan="${mine.length}">${esc(r.invoiceNo)}</td>` : ""}
              <td>${esc(l.name)}</td><td class="num">${qty(n(l.invoiceQty))}</td><td class="num">${l.grnQty !== undefined ? qty(n(l.grnQty)) : "—"}</td><td class="num">${weighed ? qty(n(l.kantaQty)) : "—"}</td>
              <td class="num" style="color:${diffColor(v)}">${v === null ? "—" : fmtDiff(v)}</td><td class="num">${qty(n(l.rejectedQty))}</td><td class="num strong">${r.stage === "COMPLETED" ? qty(acceptedOf(l)) : r.stage === "REJECTED" ? "0" : "—"}</td>
              ${i === 0 ? `<td class="nowrap" rowspan="${mine.length}">${esc(r.grn?.grnNo || "—")}</td><td class="small" rowspan="${mine.length}">${r.transportMode ? `${esc(TRANSPORT_MODES[r.transportMode])}${r.transportAmount !== null && r.transportAmount !== undefined ? `<div>₹${money(r.transportAmount)}</div>` : ""}` : "—"}</td><td rowspan="${mine.length}">${badge(receiptStageLabel(r))}${r.rejection || r.partialRejection ? `<div class="small muted">${esc((r.rejection || r.partialRejection).reason)}</div>` : ""}</td><td rowspan="${mine.length}">${accountsBadge(r)}</td>` : ""}</tr>`;
          }); }).join("")}
        </tbody></table></div>` : '<p class="muted">No material has arrived against this PO yet.</p>'}`}
        <div class="section-title">History</div>
        <ul class="timeline">${log.map((a) => `<li><time>${fmtDateTime(a.at)}</time><div><b>${esc(a.userName)}</b> · ${esc(a.summary)}</div></li>`).join("") || '<li class="muted">No history.</li>'}</ul>`,
      footer: `<button class="btn" data-close>Close</button>
        ${canEdit ? '<button class="btn" id="dupPo"><i class="fa-regular fa-copy"></i> Duplicate</button>' : ""}
        ${editable ? '<button class="btn" id="editPo"><i class="fa-solid fa-pen"></i> Edit</button>' : ""}
        ${editable ? '<button class="btn danger" id="cancelPo"><i class="fa-solid fa-ban"></i> Cancel PO</button>' : ""}
        ${closable ? '<button class="btn gold" id="closePo"><i class="fa-solid fa-flag-checkered"></i> Close PO with Balance</button>' : ""}
        ${serviceDone ? '<button class="btn gold" id="serviceDone"><i class="fa-solid fa-circle-check"></i> Mark service completed &amp; close</button>' : ""}
        ${reopenable ? '<button class="btn" id="reopenPo"><i class="fa-solid fa-rotate-left"></i> Reopen</button>' : ""}
        <button class="btn primary" id="pdfPo"><i class="fa-solid fa-file-pdf"></i> View / Download PDF</button>`
    });
    const $ = (s) => modal.el.querySelector(s);
    const who = () => ({ uid: state.user.uid, name: state.profile.name || state.user.email });
    $("#pdfPo").addEventListener("click", () => showDocument(poSpec(po), `${safeFileName(po.poNo)}.pdf`));
    $("#editPo")?.addEventListener("click", () => { modal.close(); openEditor(po); });
    $("#dupPo")?.addEventListener("click", () => { modal.close(); openEditor(po, { duplicate: true }); });
    $("#cancelPo")?.addEventListener("click", async (e) => {
      const button = e.currentTarget;
      const reason = await confirmDialog(`Cancel ${po.poNo}? The vendor should be informed separately.`, { title: "Cancel purchase order", okText: "Cancel PO", danger: true, input: { label: "Reason", required: true } });
      if (!reason) return;
      const done = busy(button);
      try {
        await runTransaction(db, async (tx) => {
          const ref = doc(db, "purchaseOrders", po.id);
          const cur = (await tx.get(ref)).data();
          if (cur.status !== "OPEN" || cur.lines.some((l) => n(l.invoicedQty) > 0)) throw new Error("Only an untouched open PO can be cancelled. Close it with balance instead.");
          tx.update(ref, { status: "CANCELLED", closeReason: reason, closedAt: serverTimestamp(), closedBy: who(), updatedAt: serverTimestamp() });
          logActivity(tx, { module: "Purchase Orders", action: "CANCEL", refId: po.id, refNo: po.poNo, summary: `Cancelled PO ${po.poNo}. Reason: ${reason}` });
        });
        toast(`${po.poNo} cancelled.`, "ok");
        modal.close();
        await load();
      } catch (error) { reportError(error); } finally { done(); }
    });
    // Passive close: the remaining quantity will not be supplied; it is kept as a closed balance, not as pending.
    $("#closePo")?.addEventListener("click", async (e) => {
      const button = e.currentTarget;
      if (inProcess.length) { toast(`${inProcess.length} inward entr${inProcess.length === 1 ? "y is" : "ies are"} still pending GRN / Kanta / QC for this PO. Complete or delete them first.`, "error"); return; }
      const balance = po.lines.map((l, i) => `${l.name}: ${qty(qs[i].pending)} ${l.unit}`).join(", ");
      const reason = await confirmDialog(`Close ${po.poNo} with balance? Remaining quantity (${balance}) will be marked as closed without receipt — kept in history, removed from pending — and no more inward will be accepted unless the PO is reopened.`,
        { title: "Close PO with Balance", okText: "Close PO", input: { label: "Reason", required: true, placeholder: "e.g. Vendor cannot supply the balance / requirement changed" } });
      if (!reason) return;
      const done = busy(button);
      try {
        await runTransaction(db, async (tx) => {
          const ref = doc(db, "purchaseOrders", po.id);
          const cur = (await tx.get(ref)).data();
          if (!OPEN_PO_STATUSES.includes(cur.status)) throw new Error(`PO is already ${cur.status}.`);
          if (cur.lines.some((l) => n(l.pendingKantaQty) > 0.0005 || n(l.qcPendingQty) > 0.0005 || n(l.invoicedQty) - n(l.grnQty) > 0.0005)) throw new Error("Material is still in process (GRN / Kanta / QC pending) on this PO.");
          const lines = cur.lines.map((l) => ({ ...l, closedBalanceQty: Math.max(0, round(n(l.qty) - n(l.receivedQty))) }));
          const closure = { type: "CLOSE", reason, at: new Date().toISOString(), by: who(), balances: lines.map((l) => ({ lineId: l.lineId, name: l.name, unit: l.unit, qty: l.closedBalanceQty })) };
          tx.update(ref, { status: "CLOSED WITH BALANCE", lines, closeReason: reason, closedAt: serverTimestamp(), closedBy: who(), closeHistory: arrayUnion(closure), updatedAt: serverTimestamp() });
          logActivity(tx, { module: "Purchase Orders", action: "CLOSED WITH BALANCE", refId: po.id, refNo: po.poNo, summary: `Closed PO ${po.poNo} with balance: ${lines.map((l) => `${l.name} ${qty(l.closedBalanceQty)} ${l.unit} not received`).join(", ")}. Reason: ${reason}` });
        });
        toast(`${po.poNo} closed with balance.`, "ok");
        modal.close();
        await load();
      } catch (error) { reportError(error); } finally { done(); }
    });
    $("#serviceDone")?.addEventListener("click", () => {
      const m = openModal({
        title: `Service completed · ${po.poNo}`,
        body: `<form id="sForm" class="form-grid" style="grid-template-columns:1fr 1fr" novalidate>
          <label class="field"><span>Supplier bill / service confirmation no. <b class="req">*</b></span><input name="billNo" /></label>
          <label class="field"><span>Bill date</span><input type="date" name="billDate" value="${isoDate()}" /></label>
          <label class="field"><span>Bill amount (₹, optional)</span><input type="number" min="0" step="any" name="billAmount" /></label>
          <label class="field"><span>PO value</span><input readonly value="₹${money(po.totals?.total)}" /></label>
          <label class="field span-2"><span>Confirmation note</span><input name="note" placeholder="e.g. 12 trips done, confirmed by stores" /></label>
          <p class="small muted span-2" style="margin:0">The PO is closed as SERVICE COMPLETED. Book the bill in Tally as usual.</p></form>`,
        footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="saveSvc">Mark completed &amp; close</button>'
      });
      m.el.querySelector("#saveSvc").addEventListener("click", async (ev) => {
        const button = ev.currentTarget;
        const v = formValues(m.el.querySelector("#sForm"));
        if (!v.billNo) { toast("Enter the bill / confirmation number.", "error"); return; }
        if (v.billAmount !== "" && !(Number(v.billAmount) >= 0)) { toast("Bill amount must be 0 or more.", "error"); return; }
        const done = busy(button);
        try {
          await runTransaction(db, async (tx) => {
            const ref = doc(db, "purchaseOrders", po.id);
            const cur = (await tx.get(ref)).data();
            if (!OPEN_PO_STATUSES.includes(cur.status)) throw new Error(`PO is already ${cur.status}.`);
            const completion = { billNo: v.billNo, billDate: v.billDate, billAmount: v.billAmount === "" ? null : round(Number(v.billAmount), 2), note: v.note, at: serverTimestamp(), by: who() };
            tx.update(ref, { status: "SERVICE COMPLETED", serviceCompletion: completion, closedAt: serverTimestamp(), closedBy: who(), updatedAt: serverTimestamp() });
            logActivity(tx, { module: "Purchase Orders", action: "SERVICE COMPLETED", refId: po.id, refNo: po.poNo, summary: `Service PO ${po.poNo} completed and closed · bill ${v.billNo} (${fmtDate(v.billDate)})${completion.billAmount !== null ? ` ₹${money(completion.billAmount)}` : ""}${v.note ? ` · ${v.note}` : ""}` });
          });
          toast(`${po.poNo} marked service completed.`, "ok");
          m.close(); modal.close();
          await load();
        } catch (error) { reportError(error); } finally { done(); }
      });
    });
    $("#reopenPo")?.addEventListener("click", async (e) => {
      const button = e.currentTarget;
      const reason = await confirmDialog(`Reopen ${po.poNo}? ${service ? "The service will be open again." : "The closed balance becomes pending again (stock does not change) and inward is allowed again."}`, { title: "Reopen PO", okText: "Reopen", input: { label: "Reason", required: true } });
      if (!reason) return;
      const done = busy(button);
      try {
        await runTransaction(db, async (tx) => {
          const ref = doc(db, "purchaseOrders", po.id);
          const cur = (await tx.get(ref)).data();
          if (![...CLOSED_PO_STATUSES, "SERVICE COMPLETED"].includes(cur.status)) throw new Error(`PO is ${cur.status}.`);
          const lines = cur.lines.map((l) => ({ ...l, closedBalanceQty: 0 }));
          const status = isServicePo(cur) ? "OPEN" : deriveOrderStatus({ ...cur, lines, status: "OPEN" }, "receivedQty", state.company.poTolerancePct);
          const restored = cur.lines.map((l) => `${l.name} ${qty(Math.max(0, round(n(l.qty) - n(l.receivedQty))))} ${l.unit}`).join(", ");
          tx.update(ref, { status, lines, closeReason: "", reopenedAt: serverTimestamp(), reopenedBy: who(), closeHistory: arrayUnion({ type: "REOPEN", reason, at: new Date().toISOString(), by: who(), from: cur.status }), updatedAt: serverTimestamp() });
          logActivity(tx, { module: "Purchase Orders", action: "REOPEN", refId: po.id, refNo: po.poNo, summary: `Reopened PO ${po.poNo} (was ${cur.status})${isServicePo(cur) ? "" : `; pending again: ${restored}`}. Reason: ${reason}` });
        });
        toast(`${po.poNo} reopened.`, "ok");
        modal.close();
        await load();
      } catch (error) { reportError(error); } finally { done(); }
    });
  }

  await load();
  document.body.dataset.loaded = "1";
  const openId = new URLSearchParams(location.search).get("open");
  if (openId) openDetail(pos.find((p) => p.id === openId));
}
