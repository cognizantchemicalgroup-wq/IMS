// Inward workflow — Kanta is the final truth:
//   PO(s) → Invoice / Gate entry (invoice qty) → GRN (qty physically received) → Kanta (weighed qty)
//      → accepted qty goes into stock and is payable; rejected qty is kept separately (payment hold)
// One supplier bill can carry several items and be allocated across several open POs of the same party;
// every line of a receipt is linked to its own PO line, so each PO keeps exact invoiced / GRN / Kanta /
// accepted / rejected / pending quantities.
// A vehicle can be fully rejected ("Vehicle Rejected" at entry, GRN, Kanta, or after Kanta with stock reversed),
// or partly rejected at Kanta (accepted and rejected quantities recorded separately).
// QC: when the GRN says "Pending QC", Kanta puts the material in quarantine (stage QC PENDING) — nothing enters stock
// until a manager / admin releases it; if QC rejects it, it never appears in inventory at all.
import {
  db, reportError, state, initPage, pageHeader, esc, toast, openModal, confirmDialog, badge, busy, formValues, can, isAdmin,
  listCollection, logActivity, qty, money, fmtDate, fmtDateTime, isoDate, round, reserveNumber, commitNumber,
  warehouseByCode, warehouseOptions, deriveOrderStatus, readStock, applyMovements, exportExcel, OPEN_PO_STATUSES, CLOSED_PO_STATUSES, normalizeReceipt,
  TRANSPORT_MODES, accountsBadge, accountsStatus, isOnHold, isPartlyRejected, receiptStageLabel, transportText, HOLD_TEXT,
  fmtDiff, diffColor, acceptedOf, isServicePo, isServiceItem, poLineQty
} from "./core.js";
import { collection, doc, runTransaction, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { uploadFiles, docLinks } from "./uploads.js";

const page = await initPage("inward");
if (page) start();

const RECEIVED_AS = ["Tanker", "Drums", "IBC", "Carboys", "Bags", "Bottles / Boxes", "Loose", "Other"];
const n = (v) => Number(v) || 0;
const by = () => ({ uid: state.user.uid, name: state.profile.name || state.user.email });
const transportOptions = (selected = "") => `<option value="">Select…</option>${Object.entries(TRANSPORT_MODES).map(([k, l]) => `<option value="${k}" ${k === selected ? "selected" : ""}>${l}</option>`).join("")}`;
/** Transport amount from a form value: "" → null (not known yet). */
const amountOf = (value) => (value === "" || value === undefined ? null : round(Number(value), 2));
/** Quantity physically on the vehicle as best known at this stage. */
const vehicleQty = (l) => (l.kantaQty !== undefined ? n(l.kantaQty) : l.grnQty !== undefined ? n(l.grnQty) : n(l.invoiceQty));

/** Apply per-line deltas to a PO's lines and return { lines, status }. */
function applyPoDeltas(poData, deltas) {
  const closed = CLOSED_PO_STATUSES.includes(poData.status);
  const lines = poData.lines.map((l) => {
    const d = deltas[l.lineId];
    if (!d) return l;
    const next = { ...l };
    Object.entries(d).forEach(([k, v]) => { next[k] = round(Math.max(0, n(l[k]) + v)); });
    if (d.varianceQty !== undefined) next.varianceQty = round(n(l.varianceQty) + d.varianceQty); // may be negative
    if (closed) next.closedBalanceQty = Math.max(0, round(n(next.qty) - n(next.receivedQty)));
    return next;
  });
  const reopened = ["COMPLETED"].includes(poData.status) ? { ...poData, status: "OPEN" } : poData;
  return { lines, status: deriveOrderStatus({ ...reopened, lines }, "receivedQty", state.company.poTolerancePct) };
}

/** Read every PO linked to the receipt lines (transaction read phase). */
async function readPos(tx, lines) {
  const ids = [...new Set(lines.map((l) => l.poId).filter(Boolean))];
  const snaps = await Promise.all(ids.map((id) => tx.get(doc(db, "purchaseOrders", id))));
  return new Map(snaps.map((snap, i) => [ids[i], { ref: snap.ref, data: snap.data() }]));
}

/** Write phase: apply each line's delta to its own PO line and log on every PO. */
function updatePos(tx, poMap, lines, deltaOf, action, summaryOf) {
  const out = [];
  poMap.forEach(({ ref, data }, id) => {
    const mine = lines.filter((l) => l.poId === id && l.poLineId);
    const deltas = {};
    mine.forEach((l) => {
      const d = deltaOf(l);
      if (!d) return;
      const cur = deltas[l.poLineId] || {};
      Object.entries(d).forEach(([k, v]) => { cur[k] = round((cur[k] || 0) + v); });
      deltas[l.poLineId] = cur;
    });
    if (!Object.keys(deltas).length) return;
    const upd = applyPoDeltas(data, deltas);
    tx.update(ref, { ...upd, updatedAt: serverTimestamp() });
    logActivity(tx, { module: "Purchase Orders", action, refId: id, refNo: data.poNo, summary: `${summaryOf(mine, data)} → ${upd.status}` });
    out.push({ poNo: data.poNo, status: upd.status });
  });
  return out;
}

const lineText = (ls, key) => ls.map((l) => `${l.name} ${qty(n(l[key]))} ${l.unit}`).join(", ");

async function start() {
  let receipts = []; let pos = []; let parties = []; let items = [];
  let tab = location.hash === "#kanta" ? "KANTA PENDING" : "GRN PENDING";
  const canOperate = can("operations");
  const canResolve = can("close");
  const canQc = can("qc");
  // Explicit flag saved at GRN (older GRNs that only said "Pending QC" were never held — they keep the old behaviour).
  const isQuarantine = (r) => r.grn?.quarantine === true;

  page.innerHTML = `${pageHeader("Purchase", "Inward · GRN · Kanta", "Invoice → GRN → Kanta. Only the accepted Kanta quantity goes into stock and is payable. One supplier bill can be split across several POs of the same party.",
    `<button class="btn" id="exportBtn" title="Export for accounts / Tally"><i class="fa-solid fa-download"></i> Export</button>${canOperate ? '<button class="btn primary" id="newEntry"><i class="fa-solid fa-file-invoice"></i> New Invoice / Receipt</button>' : ""}`)}
    <div class="tabs" id="tabs"></div>
    <div class="card">
      <div class="card-head"><div class="toolbar"><input class="input search" id="search" placeholder="Search receipt, GRN, PO, invoice, vendor, item, vehicle, transporter…" />
      <select class="input" id="whFilter"><option value="">All warehouses</option>${warehouseOptions("", { includeBlank: false })}</select>
      <input class="input" type="date" id="fromDate" title="From date" /><input class="input" type="date" id="toDate" title="To date" /></div><span class="small muted" id="count"></span></div>
      <div class="table-wrap"><table class="table"><thead><tr><th>Receipt</th><th>Stage · Accounts</th><th></th><th>PO · Vendor</th><th>Items · Invoice / GRN / Kanta (short/excess) · rejected</th><th>Invoice · Docs</th><th>Transport</th><th>Created</th></tr></thead><tbody id="rows"></tbody></table></div>
    </div>
    <p class="small muted">Tally remains the accounting system. "${HOLD_TEXT}" is an instruction to accounts not to pay that receipt (or its rejected quantity); it does not block anything in Tally.</p>`;

  const TABS = [["GRN PENDING", "GRN pending"], ["KANTA PENDING", "Awaiting Kanta"], ["QC PENDING", "Awaiting QC (quarantine)"], ["COMPLETED", "Inwarded"], ["REJECTED", "Vehicle rejected"], ["HOLD", "Payment hold"], ["ALL", "All"]];
  const inTab = (r, t) => t === "ALL" || (t === "HOLD" ? isOnHold(r) : r.stage === t);
  const itemsText = (r) => r.lines.map((l) => l.name).join(" ");
  const poLinks = (r) => {
    const list = [...new Map(r.lines.filter((l) => l.poId).map((l) => [l.poId, l.poNo])).entries()];
    return list.length ? list.map(([id, no]) => `<a class="nowrap" href="/purchase-orders?open=${esc(id)}">${esc(no)}</a>`).join("<br>") : '<span class="muted">Without PO</span>';
  };

  function filtered() {
    const term = page.querySelector("#search").value.trim().toLowerCase();
    const wh = page.querySelector("#whFilter").value;
    const from = page.querySelector("#fromDate").value;
    const to = page.querySelector("#toDate").value;
    return receipts.filter((r) => inTab(r, tab) && (!wh || r.warehouse === wh)
      && (!from || isoDate(r.createdAt) >= from) && (!to || isoDate(r.createdAt) <= to)
      && (!term || [r.geNo, r.poNo, ...r.lines.map((l) => l.poNo), r.invoiceNo, r.vendor?.name, itemsText(r), r.vehicleNo, r.grn?.grnNo, r.transporter, r.lrNo].some((v) => String(v || "").toLowerCase().includes(term))));
  }

  const lineSummary = (r) => r.lines.map((l) => {
    const weighed = l.kantaQty !== undefined;
    const v = weighed ? round(n(l.kantaQty) - n(l.grnQty)) : null;
    return `<div class="nowrap"><b>${esc(l.name)}</b>${r.lines.some((x) => x.poId !== r.lines[0].poId) && l.poNo ? ` <span class="muted small">(${esc(l.poNo)})</span>` : ""} <span class="muted">${qty(n(l.invoiceQty))}</span> / ${l.grnQty !== undefined ? qty(n(l.grnQty)) : "—"} / <b>${weighed ? qty(n(l.kantaQty)) : "—"}</b> ${esc(l.unit)}${weighed ? ` <span class="badge ${v < 0 ? "red" : v > 0 ? "green" : "gray"}" title="Short (−) / Excess (+) vs GRN">${fmtDiff(v)}</span>` : ""}${n(l.rejectedQty) > 0 ? ` <span class="badge red">rejected ${qty(n(l.rejectedQty))}</span>` : ""}</div>`;
  }).join("");

  function render() {
    page.querySelector("#tabs").innerHTML = TABS.map(([k, l]) => `<button class="tab ${k === tab ? "active" : ""}" data-tab="${k}">${l}<span class="count">${receipts.filter((r) => inTab(r, k)).length}</span></button>`).join("");
    const list = filtered();
    page.querySelector("#count").textContent = `${list.length} receipt${list.length === 1 ? "" : "s"}`;
    const rows = page.querySelector("#rows");
    if (!list.length) { rows.innerHTML = '<tr><td class="empty" colspan="8">Nothing here.</td></tr>'; return; }
    rows.innerHTML = list.map((r) => {
      let action = "";
      if (canOperate && r.stage === "GRN PENDING") action = `<button class="btn sm primary" data-grn="${esc(r.id)}">GRN</button>`;
      if (canOperate && r.stage === "KANTA PENDING") action = `<button class="btn sm primary" data-kanta="${esc(r.id)}">Kanta</button>`;
      if (canQc && r.stage === "QC PENDING") action = `<button class="btn sm primary" data-qc="${esc(r.id)}">QC release</button>`;
      const why = r.rejection?.reason || r.partialRejection?.reason;
      return `<tr>
        <td class="strong nowrap"><a href="#" data-view="${esc(r.id)}">${esc(r.geNo)}</a>${r.grn ? `<div class="small muted">${esc(r.grn.grnNo)}</div>` : ""}<div class="small muted">${esc(warehouseByCode(r.warehouse).name)}</div></td>
        <td>${badge(receiptStageLabel(r))}<div style="margin-top:4px">${accountsBadge(r)}</div>${why ? `<div class="small muted" style="max-width:220px">${esc(why)}</div>` : ""}</td>
        <td><div class="actions">${action}</div></td>
        <td>${poLinks(r)}<div class="small">${esc(r.vendor?.name)}</div></td>
        <td class="small">${lineSummary(r)}</td>
        <td>${esc(r.invoiceNo)}<div class="small muted">${fmtDate(r.invoiceDate)}</div><div class="small">${docLinks(r.docs)}</div></td>
        <td class="small">${r.transportMode ? `${esc(TRANSPORT_MODES[r.transportMode])}${r.transportAmount !== null && r.transportAmount !== undefined ? `<div class="strong">₹${money(r.transportAmount)}</div>` : ""}` : "—"}</td>
        <td class="nowrap small">${fmtDateTime(r.createdAt)}<div class="muted">${esc(r.createdBy?.name || "")}</div></td>
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
    const q = event.target.closest("[data-qc]"); if (q) { openQc(find(q.dataset.qc)); return; }
    const v = event.target.closest("[data-view]"); if (v) { event.preventDefault(); openView(find(v.dataset.view)); }
  });
  ["#search", "#whFilter", "#fromDate", "#toDate"].forEach((s) => page.querySelector(s).addEventListener(s === "#search" ? "input" : "change", render));
  page.querySelector("#newEntry")?.addEventListener("click", openReceiptForm);
  page.querySelector("#exportBtn").addEventListener("click", () => {
    const rows = filtered().flatMap((r) => r.lines.map((l, i) => {
      const weighed = l.kantaQty !== undefined;
      const accepted = r.stage === "COMPLETED" ? acceptedOf(l) : 0;
      return {
        Receipt: r.geNo, "Date & Time": fmtDateTime(r.createdAt), "PO No": l.poNo || "Without PO", Vendor: r.vendor?.name, "Invoice No": r.invoiceNo, "Invoice Date": fmtDate(r.invoiceDate),
        Item: l.name, Unit: l.unit, Warehouse: warehouseByCode(r.warehouse).name, "Invoice Qty": n(l.invoiceQty), "GRN No": r.grn?.grnNo || "", "GRN Qty": l.grnQty !== undefined ? n(l.grnQty) : "",
        "Kanta Qty": weighed ? n(l.kantaQty) : "", "Short(-)/Excess(+) vs GRN": weighed ? round(n(l.kantaQty) - n(l.grnQty)) : "", "Rejected Qty": n(l.rejectedQty),
        "Accepted / Payable Qty": accepted, Rate: l.rate || "", "Payable Value (before GST)": round(accepted * n(l.rate), 2),
        Stage: receiptStageLabel(r), "Accounts Status": accountsStatus(r).label, "Rejection Reason": r.rejection?.reason || r.partialRejection?.reason || "",
        "Rejected By": (r.rejection || r.partialRejection)?.by?.name || "", "Rejected At": r.rejection || r.partialRejection ? fmtDateTime((r.rejection || r.partialRejection).at) : "",
        "Hold Resolution": r.paymentHold?.active === false ? r.paymentHold.resolution : "",
        "Transport Arrangement": TRANSPORT_MODES[r.transportMode] || "", "Transport Amount (per receipt)": i === 0 && r.transportAmount !== null && r.transportAmount !== undefined ? r.transportAmount : "",
        Transporter: r.transporter || "", "LR No": r.lrNo || "", "Vehicle No": r.vehicleNo, "Entered By": r.createdBy?.name || "", "GRN By": r.grn?.by?.name || "", "GRN At": r.grn ? fmtDateTime(r.grn.at) : "",
        "Kanta By": r.kanta?.by?.name || "", "Kanta At": r.kanta ? fmtDateTime(r.kanta.at) : ""
      };
    }));
    if (!rows.length) { toast("Nothing to export."); return; }
    exportExcel(rows, `CCPL_Inward_${isoDate()}.xlsx`, "Inward");
  });

  /* ---------------- 1. Invoice / receipt entry ---------------- */
  // quantity already invoiced on receipts of this PO line that have not been through Kanta yet
  const inProcessOf = (poId, lineId) => receipts.filter((r) => ["GRN PENDING", "KANTA PENDING", "QC PENDING"].includes(r.stage))
    .reduce((s, r) => s + r.lines.filter((x) => x.poId === poId && x.poLineId === lineId).reduce((a, x) => a + n(x.invoiceQty), 0), 0);

  function openReceiptForm() {
    const openPos = pos.filter((p) => OPEN_PO_STATUSES.includes(p.status) && !isServicePo(p))
      .sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.poNo).localeCompare(String(b.poNo)));
    const withPos = parties.filter((p) => openPos.some((o) => o.vendorId === p.id)).sort((a, b) => a.name.localeCompare(b.name));
    let freeLines = [{ itemId: "", invoiceQty: "" }];
    const modal = openModal({
      title: "New Invoice / Receipt (material arrived)",
      size: "full",
      body: `<form id="geForm" novalidate><div class="form-grid">
        <label class="field"><span>Receive Against <b class="req">*</b></span><select name="mode"><option value="PO">Purchase Order(s)</option><option value="NOPO">Without PO</option></select></label>
        <label class="field span-2"><span>Supplier / Party <b class="req">*</b></span><select name="vendorId"></select><small class="help" data-po>All open POs of this party are listed — one bill can be split across several POs.</small></label>
        <label class="field"><span>Receiving Warehouse <b class="req">*</b></span><select name="warehouse">${warehouseOptions()}</select></label>
        <label class="field"><span>Invoice / Challan No. <b class="req">*</b></span><input name="invoiceNo" /></label>
        <label class="field"><span>Invoice Date</span><input type="date" name="invoiceDate" value="${isoDate()}" /></label>
        <label class="field"><span>Received As</span><select name="receivedAs">${RECEIVED_AS.map((r) => `<option>${r}</option>`).join("")}</select></label>
        <label class="field"><span>No. of Containers</span><input type="number" min="0" step="1" name="containers" /></label>
        <label class="field"><span>Supplier Batch / Lot No.</span><input name="supplierLot" /></label>
      </div>
      <div class="section-title">Items on this invoice</div>
      <div id="itemArea"></div>
      <div class="section-title">Transport (internal — not printed on the PO, not added to the PO total)</div>
      <div class="form-grid">
        <label class="field"><span>Transport Arrangement <b class="req">*</b></span><select name="transportMode">${transportOptions()}</select></label>
        <label class="field"><span>Transportation Amount (₹)</span><input type="number" min="0" step="any" name="transportAmount" placeholder="Leave blank if not known yet" /></label>
        <label class="field"><span>Vehicle No.</span><input name="vehicleNo" placeholder="MH46AB1234" /></label>
        <label class="field"><span>Transporter</span><input name="transporter" /></label>
        <label class="field"><span>LR No.</span><input name="lrNo" /></label>
      </div>
      <div class="section-title">Vehicle status</div>
      <div class="form-grid">
        <label class="field"><span>Entry Status <b class="req">*</b></span><select name="entryStatus"><option value="ACCEPTED">Accepted — go to GRN</option><option value="REJECTED">Full rejection — Vehicle Rejected (not unloaded)</option></select><small class="help">A partial rejection is recorded at Kanta (accepted and rejected quantities).</small></label>
        <label class="field span-2" data-reject hidden><span>Rejection Reason <b class="req">*</b></span><input name="rejectReason" placeholder="e.g. UV absorbance failed / wrong grade / leaking drums" /></label>
      </div>
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
    const isPoMode = () => form.mode.value === "PO";
    const partyPos = () => openPos.filter((p) => p.vendorId === form.vendorId.value);
    const poRows = () => partyPos().flatMap((p) => p.lines.map((l) => {
      const { pending } = poLineQty(l, p.status);
      const inProcess = inProcessOf(p.id, l.lineId);
      return { p, l, pending, inProcess, available: Math.max(0, round(pending - inProcess)) };
    }));

    const fillParties = () => {
      const keep = form.vendorId.value;
      const list = isPoMode() ? withPos : parties.filter((v) => v.active !== false).sort((a, b) => a.name.localeCompare(b.name));
      form.vendorId.innerHTML = `<option value="">${isPoMode() ? (list.length ? "Select supplier with open POs…" : "No open goods POs") : "Select…"}</option>${list.map((v) => `<option value="${esc(v.id)}" ${v.id === keep ? "selected" : ""}>${esc(v.name)}${isPoMode() ? ` (${openPos.filter((o) => o.vendorId === v.id).length} open PO)` : ""}</option>`).join("")}`;
    };

    const renderPoLines = () => {
      const rows = poRows();
      if (!form.vendorId.value) { area.innerHTML = '<p class="muted">Select the supplier to list all its open PO items.</p>'; return; }
      if (!rows.length) { area.innerHTML = '<p class="muted">This party has no open goods PO.</p>'; return; }
      form.warehouse.value = rows[0].p.warehouse;
      const itemIds = [...new Set(rows.map((x) => x.l.itemId))];
      const multi = new Set(rows.map((x) => x.p.id)).size > 1;
      area.innerHTML = `${multi ? `<div class="notice" style="margin-bottom:10px"><i class="fa-solid fa-code-branch"></i><div><b>Split one bill across POs:</b> type the total quantity on the bill for an item and it is allocated to the oldest PO first (you can change any figure below).
          <div class="form-grid" style="margin-top:8px">${itemIds.filter((id) => rows.filter((x) => x.l.itemId === id).length > 1).map((id) => { const r0 = rows.find((x) => x.l.itemId === id); return `<label class="field"><span>Total ${esc(r0.l.name)} on this bill (${esc(r0.l.unit)})</span><input type="number" step="any" min="0" class="num" data-total="${esc(id)}" /></label>`; }).join("")}</div></div></div>` : ""}
        <div class="table-wrap"><table class="table"><thead><tr><th>PO No.</th><th>PO Date</th><th>Item</th><th class="num">PO Qty</th><th class="num">Accepted so far</th><th class="num">In process</th><th class="num">Pending</th><th class="num" style="width:150px">Qty on this bill</th></tr></thead><tbody>
        ${rows.map(({ p, l, pending, inProcess }) => `<tr data-po-no="${esc(p.poNo)}"><td class="strong nowrap">${esc(p.poNo)}</td><td class="nowrap">${fmtDate(p.date)}</td><td class="strong">${esc(l.name)}</td><td class="num">${qty(n(l.qty))} ${esc(l.unit)}</td><td class="num">${qty(n(l.receivedQty))}</td><td class="num">${qty(inProcess)}</td><td class="num strong">${qty(pending)}</td>
          <td><input type="number" step="any" min="0" class="num" data-po="${esc(p.id)}" data-line="${esc(l.lineId)}" data-item="${esc(l.itemId)}" placeholder="0" /></td></tr>`).join("")}
        </tbody></table></div><p class="small muted">Enter the quantity allocated to each PO line; leave blank for lines not on this bill.</p>`;
    };
    // total on the bill → oldest PO first; anything above all pending goes to the newest PO as excess
    area.addEventListener("input", (e) => {
      const total = e.target.dataset.total;
      if (total !== undefined) {
        let remaining = Number(e.target.value);
        const rows = poRows().filter((x) => x.l.itemId === total);
        rows.forEach((x, i) => {
          const input = area.querySelector(`[data-po="${CSS.escape(x.p.id)}"][data-line="${CSS.escape(x.l.lineId)}"]`);
          if (!(remaining > 0)) { input.value = ""; return; }
          const take = i === rows.length - 1 ? remaining : Math.min(remaining, x.available);
          input.value = take > 0 ? round(take) : "";
          remaining = round(remaining - take);
        });
        return;
      }
      const tr = e.target.closest("tr[data-i]"); if (tr && e.target.dataset.f === "invoiceQty") freeLines[Number(tr.dataset.i)].invoiceQty = e.target.value;
    });

    const renderFreeLines = () => {
      const stockItems = items.filter((x) => x.active !== false && !isServiceItem(x));
      area.innerHTML = `<table class="table"><thead><tr><th>Item</th><th class="num" style="width:160px">Invoice Qty</th><th>Unit</th><th></th></tr></thead><tbody>
        ${freeLines.map((l, i) => { const it = items.find((x) => x.id === l.itemId); return `<tr data-i="${i}"><td><select data-f="itemId"><option value="">Select…</option>${stockItems.map((x) => `<option value="${esc(x.id)}" ${x.id === l.itemId ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select></td><td><input type="number" step="any" min="0" class="num" data-f="invoiceQty" value="${esc(l.invoiceQty)}" /></td><td>${esc(it?.unit || "—")}</td><td>${freeLines.length > 1 ? '<button type="button" class="icon-btn" data-rm><i class="fa-solid fa-trash"></i></button>' : ""}</td></tr>`; }).join("")}
        </tbody></table><button type="button" class="btn sm" id="addFree" style="margin-top:8px"><i class="fa-solid fa-plus"></i> Add item</button>`;
      area.querySelector("#addFree").addEventListener("click", () => { freeLines.push({ itemId: "", invoiceQty: "" }); renderFreeLines(); });
    };
    area.addEventListener("change", (e) => { const tr = e.target.closest("tr[data-i]"); if (tr && e.target.dataset.f === "itemId") { freeLines[Number(tr.dataset.i)].itemId = e.target.value; renderFreeLines(); } });
    area.addEventListener("click", (e) => { if (e.target.closest("[data-rm]")) { freeLines.splice(Number(e.target.closest("tr").dataset.i), 1); renderFreeLines(); } });

    const showMode = () => {
      form.querySelectorAll("[data-po]").forEach((el) => { el.hidden = !isPoMode(); });
      fillParties();
      if (isPoMode()) renderPoLines(); else renderFreeLines();
    };
    form.mode.addEventListener("change", showMode);
    form.vendorId.addEventListener("change", () => { if (isPoMode()) renderPoLines(); });
    const showStatus = () => {
      const rejected = form.entryStatus.value === "REJECTED";
      form.querySelector("[data-reject]").hidden = !rejected;
      const save = modal.el.querySelector("#saveGe");
      save.classList.toggle("danger", rejected); save.classList.toggle("primary", !rejected);
      save.innerHTML = rejected ? '<i class="fa-solid fa-ban"></i> Save as Vehicle Rejected' : '<i class="fa-solid fa-check"></i> Save Invoice / Receipt';
    };
    form.entryStatus.addEventListener("change", showStatus);
    showMode();

    modal.el.querySelector("#saveGe").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      const v = formValues(form);
      const againstPo = v.mode === "PO";
      let lines;
      try {
        if (!v.vendorId) throw new Error(againstPo ? "Select the supplier." : "Select the vendor.");
        if (!v.warehouse) throw new Error("Select the receiving warehouse.");
        if (!v.invoiceNo) throw new Error("Enter the invoice / challan number.");
        if (!TRANSPORT_MODES[v.transportMode]) throw new Error("Select the transport arrangement (Self / CCPL Transport or Party Transport).");
        if (v.transportAmount !== "" && !(Number(v.transportAmount) >= 0)) throw new Error("Transportation amount must be 0 or more.");
        if (v.entryStatus === "REJECTED" && !v.rejectReason) throw new Error("Enter the rejection reason.");
        if (againstPo) {
          lines = [...area.querySelectorAll("[data-line]")].map((inp) => ({ p: pos.find((x) => x.id === inp.dataset.po), lineId: inp.dataset.line, q: Number(inp.value) }))
            .filter(({ q }) => Number.isFinite(q) && q > 0)
            .map(({ p, lineId, q }) => { const l = p.lines.find((x) => x.lineId === lineId); return { poId: p.id, poNo: p.poNo, poLineId: l.lineId, itemId: l.itemId, name: l.name, unit: l.unit, category: l.category || "", hsn: l.hsn || "", rate: n(l.rate), invoiceQty: round(q) }; });
        } else {
          lines = freeLines.filter((l) => l.itemId && Number(l.invoiceQty) > 0).map((l) => { const it = items.find((x) => x.id === l.itemId); return { poId: "", poNo: "", poLineId: "", itemId: it.id, name: it.name, unit: it.unit, category: it.category || "", hsn: it.hsn || "", rate: 0, invoiceQty: round(Number(l.invoiceQty)) }; });
          if (new Set(lines.map((l) => l.itemId)).size !== lines.length) throw new Error("Each item can appear only once per invoice.");
        }
        if (!lines.length) throw new Error("Enter the invoice quantity for at least one item.");
        const dup = receipts.find((r) => !["CANCELLED", "REJECTED"].includes(r.stage) && String(r.invoiceNo).toLowerCase() === v.invoiceNo.toLowerCase() && r.vendor?.id === v.vendorId);
        if (dup) throw new Error(`Invoice ${v.invoiceNo} from this vendor is already entered (${dup.geNo}).`);
      } catch (error) { toast(error.message, "error"); return; }
      const rejected = v.entryStatus === "REJECTED";
      const rejectedBefore = receipts.find((r) => r.stage === "REJECTED" && String(r.invoiceNo).toLowerCase() === v.invoiceNo.toLowerCase() && r.vendor?.id === v.vendorId);
      if (rejectedBefore && !(await confirmDialog(`Invoice ${v.invoiceNo} was entered before on ${rejectedBefore.geNo} and that vehicle was rejected (${HOLD_TEXT}). Record this arrival as a new entry under the same invoice? The old entry stays on hold.`, { okText: "Record new entry" }))) return;
      if (againstPo && !rejected) {
        const over = lines.filter((l) => { const p = pos.find((x) => x.id === l.poId); const pl = p.lines.find((x) => x.lineId === l.poLineId); return l.invoiceQty > round(poLineQty(pl, p.status).pending - inProcessOf(p.id, pl.lineId)) + 0.0005; });
        if (over.length && !(await confirmDialog(`${over.map((l) => `${l.name} on ${l.poNo}`).join(", ")}: quantity is more than what is still pending on that PO. Accept the excess?`, { okText: "Accept excess" }))) return;
      }
      const vendor = parties.find((x) => x.id === v.vendorId) || pos.find((x) => x.vendorId === v.vendorId)?.vendor;
      const ref = doc(collection(db, "receipts"));
      const poIds = [...new Set(lines.map((l) => l.poId).filter(Boolean))];
      const poNos = [...new Set(lines.map((l) => l.poNo).filter(Boolean))];
      const done = busy(button);
      try {
        const docs = await uploadFiles(`receipts/${ref.id}`, { invoice: form.invoiceFile.files[0], coa: form.coaFile.files[0], other: [...form.otherFiles.files] });
        const geNo = await runTransaction(db, async (tx) => {
          const poMap = await readPos(tx, lines);
          poMap.forEach(({ data }) => {
            if (!OPEN_PO_STATUSES.includes(data.status)) throw new Error(`PO ${data.poNo} is ${data.status}; no more material can be received against it.`);
            if (data.vendorId !== v.vendorId) throw new Error(`PO ${data.poNo} belongs to another party.`);
          });
          const number = await reserveNumber(tx, "GE", { date: isoDate() });
          commitNumber(tx, number, ref.id);
          const saved = rejected ? lines.map((l) => ({ ...l, rejectedQty: l.invoiceQty, acceptedQty: 0, payableQty: 0 })) : lines;
          tx.set(ref, {
            geNo: number.number, stage: rejected ? "REJECTED" : "GRN PENDING",
            transportMode: v.transportMode, transportAmount: amountOf(v.transportAmount),
            ...(rejected ? {
              rejection: { reason: v.rejectReason, at: serverTimestamp(), by: by(), stageAtRejection: "ENTRY" },
              paymentHold: { active: true, scope: "FULL", since: serverTimestamp(), by: by() }, payableValue: 0
            } : {}),
            poIds, poId: poIds[0] || "", poNo: poNos.join(", "),
            vendor: { id: vendor.id, name: vendor.name, gstin: vendor.gstin || "" },
            warehouse: v.warehouse, invoiceNo: v.invoiceNo, invoiceDate: v.invoiceDate, lines: saved,
            receivedAs: v.receivedAs, containers: v.containers ? Number(v.containers) : null, vehicleNo: v.vehicleNo.toUpperCase(), transporter: v.transporter,
            lrNo: v.lrNo, supplierLot: v.supplierLot, remarks: v.remarks, docs,
            createdAt: serverTimestamp(), createdBy: by()
          });
          const summary = lineText(lines, "invoiceQty");
          const transport = `${TRANSPORT_MODES[v.transportMode]}${v.transportAmount !== "" ? ` ₹${money(amountOf(v.transportAmount))}` : ""}`;
          if (rejected) {
            updatePos(tx, poMap, saved, (l) => ({ rejectedQty: l.invoiceQty }), "VEHICLE REJECTED",
              (mine) => `Vehicle rejected for invoice ${v.invoiceNo} (${number.number}): ${lineText(mine, "invoiceQty")}. Nothing received; PO quantity stays pending. Reason: ${v.rejectReason}`);
            logActivity(tx, { module: "Inward", action: "VEHICLE REJECTED", refId: ref.id, refNo: number.number, summary: `${number.number} · ${vendor.name} · invoice ${v.invoiceNo} · ${summary} · VEHICLE REJECTED: ${v.rejectReason} · ${HOLD_TEXT} · ${transport}` });
            return number.number;
          }
          updatePos(tx, poMap, lines, (l) => ({ invoicedQty: l.invoiceQty }), "INVOICE",
            (mine) => `Invoice ${v.invoiceNo} received (${number.number}): ${lineText(mine, "invoiceQty")}${poIds.length > 1 ? ` (bill split across ${poNos.join(", ")})` : ""}`);
          logActivity(tx, { module: "Inward", action: "INVOICE / RECEIPT", refId: ref.id, refNo: number.number, summary: `${number.number} · ${vendor.name} · invoice ${v.invoiceNo} · ${lines.map((l) => `${l.name} ${qty(l.invoiceQty)} ${l.unit}${l.poNo ? ` → ${l.poNo}` : ""}`).join(", ")}${againstPo ? "" : " · without PO"}${v.vehicleNo ? ` · vehicle ${v.vehicleNo.toUpperCase()}` : ""} · ${transport}` });
          return number.number;
        });
        toast(rejected ? `${geNo} saved as Vehicle Rejected — payment hold.` : `${geNo} saved. Next: GRN.`, rejected ? "" : "ok");
        modal.close();
        tab = rejected ? "REJECTED" : "GRN PENDING";
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
        <form id="gForm"><table class="table"><thead><tr><th>Item</th><th>PO</th><th class="num">Invoice Qty</th><th class="num" style="width:170px">GRN Qty (received)</th><th>Unit</th></tr></thead><tbody>
          ${r.lines.map((l, i) => `<tr><td class="strong">${esc(l.name)}</td><td class="small nowrap">${esc(l.poNo || "—")}</td><td class="num">${qty(n(l.invoiceQty))}</td><td><input type="number" step="any" min="0" class="num" name="g${i}" value="${esc(n(l.invoiceQty))}" /></td><td>${esc(l.unit)}</td></tr>`).join("")}
        </tbody></table>
        <div class="form-grid" style="margin-top:14px">
          <label class="field span-2"><span>QC Status</span><select name="qc"><option ${state.company.qcQuarantine ? "" : "selected"}>Approved (QC passed / not required)</option><option>Approved with deviation</option><option ${state.company.qcQuarantine ? "selected" : ""}>Pending QC — hold in quarantine until QC release</option></select><small class="help">Optional. Approved: Kanta adds the material to stock. Pending QC: after Kanta it stays in quarantine and is <b>not</b> in stock until a manager / admin releases it.${state.company.qcQuarantine ? " (QC quarantine is switched on in Settings.)" : ""}</small></label>
          <label class="field"><span>Our Batch No.</span><input name="batchNo" /></label>
          <label class="field span-2"><span>Remark</span><input name="remark" /></label>
        </div></form>
        <p class="small muted">Stock is <b>not</b> added yet. Kanta confirms the final quantity; part of it can be rejected there. If the whole vehicle is not accepted, use <b>Vehicle rejected</b>.</p>`,
      footer: `<button class="btn" data-close>Cancel</button>${isAdmin() ? '<button class="btn danger" id="delRec">Delete entry</button>' : ""}<button class="btn danger" id="rejRec"><i class="fa-solid fa-ban"></i> Vehicle rejected</button><button class="btn primary" id="saveG"><i class="fa-solid fa-clipboard-check"></i> Save GRN</button>`
    });
    const f = modal.el.querySelector("#gForm");
    modal.el.querySelector("#delRec")?.addEventListener("click", () => deleteReceipt(r, modal));
    modal.el.querySelector("#rejRec").addEventListener("click", () => rejectReceipt(r, modal));
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
          const poMap = await readPos(tx, cur.lines);
          const number = await reserveNumber(tx, "GRN", { date: isoDate() });
          commitNumber(tx, number, r.id);
          const lines = cur.lines.map((l, i) => ({ ...l, grnQty: grnQtys[i] }));
          tx.update(ref, { stage: "KANTA PENDING", lines, grn: { grnNo: number.number, qc: v.qc, quarantine: /^Pending QC/.test(v.qc), batchNo: v.batchNo, remark: v.remark, at: serverTimestamp(), by: by() } });
          const describe = (ls) => ls.map((l) => `${l.name} ${qty(l.grnQty)}${l.grnQty !== n(l.invoiceQty) ? ` (invoice ${qty(n(l.invoiceQty))})` : ""} ${l.unit}`).join(", ");
          updatePos(tx, poMap, lines, (l) => ({ grnQty: l.grnQty, pendingKantaQty: l.grnQty }), "GRN", (mine) => `${number.number} for ${cur.geNo}: ${describe(mine)}`);
          logActivity(tx, { module: "Inward", action: "GRN", refId: r.id, refNo: number.number, summary: `${number.number} (${cur.geNo}): received ${describe(lines)}. QC: ${v.qc}. Awaiting Kanta.` });
          return number.number;
        });
        toast(`${grnNo} saved. Next: Kanta.`, "ok");
        modal.close();
        tab = "KANTA PENDING";
        await load();
      } catch (error) { reportError(error); } finally { done(); }
    });
  }

  /* ---------------- 3. Kanta (final quantity → accepted into stock, rejected kept separately) ---------------- */
  function openKanta(r) {
    const single = r.lines.length === 1 ? r.lines[0] : null;
    const modal = openModal({
      title: `Kanta · ${r.geNo} · ${r.grn?.grnNo || ""}`,
      size: "full",
      body: `${summaryGrid(r)}
        <div class="section-title">Weighbridge</div>
        <form id="kForm"><div class="form-grid">
          <label class="field"><span>Gross Weight</span><input type="number" step="any" name="gross" /></label>
          <label class="field"><span>Tare Weight</span><input type="number" step="any" name="tare" /></label>
          <label class="field"><span>Net Weight</span><input type="number" step="any" name="net" readonly /></label>
          <label class="field"><span>Weight Unit</span><select name="weightUnit"><option>KG</option><option>MT</option></select></label>
        </div>
        <div class="section-title">Confirmed quantity — accepted goes into stock and is payable</div>
        <div class="table-wrap"><table class="table"><thead><tr><th>Item</th><th>PO</th><th class="num">Invoice</th><th class="num">GRN</th><th class="num" style="width:140px">Kanta Qty</th><th class="num">Short / Excess</th><th class="num" style="width:140px">Rejected Qty</th><th class="num">Accepted (stock)</th><th>Unit</th></tr></thead><tbody>
          ${r.lines.map((l, i) => `<tr data-i="${i}"><td class="strong">${esc(l.name)}</td><td class="small nowrap">${esc(l.poNo || "—")}</td><td class="num">${qty(n(l.invoiceQty))}</td><td class="num">${qty(n(l.grnQty))}</td>
            <td><input type="number" step="any" min="0" class="num" name="k${i}" value="${esc(n(l.grnQty))}" /></td><td class="num" data-var>0</td>
            <td><input type="number" step="any" min="0" class="num" name="rj${i}" value="0" /></td><td class="num strong" data-acc>${qty(n(l.grnQty))}</td><td>${esc(l.unit)}</td></tr>`).join("")}
        </tbody></table></div>
        <div class="form-grid" style="margin-top:14px">
          <label class="field span-2" data-rejreason hidden><span>Reason for the rejected quantity <b class="req">*</b></span><input name="rejectReason" placeholder="e.g. 5 drums leaking / failed moisture test" /></label>
          <label class="field span-2"><span>Kanta slip</span><input type="file" name="slip" accept=".pdf,.jpg,.jpeg,.png" /></label>
          <label class="field span-2"><span>Remark</span><input name="remark" /></label>
        </div></form>
        ${isQuarantine(r) ? `<div class="notice" style="margin-top:10px"><i class="fa-solid fa-flask"></i><div><b>QC pending:</b> after Kanta the accepted quantity goes into <b>quarantine</b> — it is not in stock and not available until QC releases it.</div></div>` : ""}
        <p class="small muted">Accepted quantity goes to <b>${esc(warehouseByCode(r.warehouse).name)}</b> and counts against the PO. Rejected quantity adds no stock, keeps the PO pending and is put on payment hold for accounts.</p>`,
      footer: `<button class="btn" data-close>Cancel</button>${isAdmin() ? '<button class="btn danger" id="delRec">Delete entry</button>' : ""}<button class="btn danger" id="rejRec"><i class="fa-solid fa-ban"></i> Full rejection (vehicle)</button><button class="btn primary" id="saveK"><i class="fa-solid fa-scale-balanced"></i> ${isQuarantine(r) ? "Confirm Kanta → QC quarantine" : "Confirm Kanta &amp; add accepted to stock"}</button>`
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
      let anyRejected = false;
      r.lines.forEach((l, i) => {
        const k = f[`k${i}`].value === "" ? n(l.grnQty) : n(f[`k${i}`].value);
        const rj = n(f[`rj${i}`].value);
        if (rj > 0) anyRejected = true;
        const d = round(k - n(l.grnQty));
        const cell = f.querySelector(`tr[data-i="${i}"] [data-var]`);
        cell.textContent = fmtDiff(d);
        cell.style.color = diffColor(d);
        f.querySelector(`tr[data-i="${i}"] [data-acc]`).textContent = qty(Math.max(0, round(k - rj)));
      });
      f.querySelector("[data-rejreason]").hidden = !anyRejected;
    };
    f.addEventListener("input", recalc);
    f.weightUnit.addEventListener("change", recalc);
    modal.el.querySelector("#delRec")?.addEventListener("click", () => deleteReceipt(r, modal));
    modal.el.querySelector("#rejRec").addEventListener("click", () => rejectReceipt(r, modal));
    modal.el.querySelector("#saveK").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      const v = formValues(f);
      let entered;
      try {
        entered = r.lines.map((l, i) => {
          const k = Number(f[`k${i}`].value); const rj = f[`rj${i}`].value === "" ? 0 : Number(f[`rj${i}`].value);
          if (f[`k${i}`].value === "" || !Number.isFinite(k) || k < 0) throw new Error(`${l.name}: enter the Kanta quantity.`);
          if (!Number.isFinite(rj) || rj < 0) throw new Error(`${l.name}: rejected quantity must be 0 or more.`);
          if (rj > k + 0.0005) throw new Error(`${l.name}: rejected quantity cannot be more than the Kanta quantity.`);
          return { kanta: round(k), rejected: round(rj) };
        });
        if (entered.some((e) => e.rejected > 0) && !v.rejectReason) throw new Error("Enter the reason for the rejected quantity.");
      } catch (error) { toast(error.message, "error"); return; }
      const partial = entered.some((e) => e.rejected > 0);
      const done = busy(button);
      try {
        const slip = await uploadFiles(`receipts/${r.id}`, { kantaSlip: f.slip.files[0] });
        await runTransaction(db, async (tx) => {
          const ref = doc(db, "receipts", r.id);
          const cur = normalizeReceipt({ id: r.id, ...(await tx.get(ref)).data() });
          if (cur.stage !== "KANTA PENDING") throw new Error("Kanta has already been recorded for this receipt.");
          const quarantine = isQuarantine(cur);
          const poMap = await readPos(tx, cur.lines);
          const stock = quarantine ? null : await readStock(tx, cur.lines.map((l) => ({ warehouse: cur.warehouse, itemId: l.itemId })));
          const lines = cur.lines.map((l, i) => {
            const accepted = round(entered[i].kanta - entered[i].rejected);
            return { ...l, kantaQty: entered[i].kanta, rejectedQty: entered[i].rejected, acceptedQty: accepted, varianceQty: round(entered[i].kanta - n(l.grnQty)), payableQty: accepted };
          });
          const movements = lines.filter((l) => l.acceptedQty > 0).map((l) => ({ warehouse: cur.warehouse, item: { id: l.itemId, name: l.name, unit: l.unit, category: items.find((x) => x.id === l.itemId)?.category || l.category }, qty: l.acceptedQty, note: `Kanta inward ${cur.grn.grnNo} · ${l.poNo || "no PO"} · invoice ${cur.invoiceNo}${l.rejectedQty ? ` (rejected ${qty(l.rejectedQty)})` : ""}` }));
          if (movements.length && !quarantine) applyMovements(tx, stock, movements, { type: "INWARD (KANTA)", id: r.id, no: cur.grn.grnNo });
          const payableValue = round(lines.reduce((s, l) => s + l.acceptedQty * n(l.rate), 0), 2);
          const rejectedValue = round(lines.reduce((s, l) => s + l.rejectedQty * n(l.rate), 0), 2);
          tx.update(ref, {
            stage: quarantine ? "QC PENDING" : "COMPLETED", lines, payableValue, docs: { ...(cur.docs || {}), ...slip },
            kanta: { grossWeight: v.gross === "" ? null : Number(v.gross), tareWeight: v.tare === "" ? null : Number(v.tare), netWeight: v.net === "" ? null : Number(v.net), weightUnit: v.weightUnit, remark: v.remark, at: serverTimestamp(), by: by() },
            ...(partial ? {
              partialRejection: { reason: v.rejectReason, at: serverTimestamp(), by: by(), rejectedValue },
              paymentHold: { active: true, scope: "PARTIAL", since: serverTimestamp(), by: by(), rejectedValue }
            } : {})
          });
          const describe = (ls) => ls.map((l) => `${l.name} Kanta ${qty(l.kantaQty)} ${l.unit}${l.varianceQty ? ` (${l.varianceQty > 0 ? "EXCESS +" : "SHORT "}${qty(l.varianceQty)} vs GRN)` : ""}${l.rejectedQty ? ` · REJECTED ${qty(l.rejectedQty)} · accepted ${qty(l.acceptedQty)}` : ""}`).join(", ");
          updatePos(tx, poMap, lines, (l) => ({ [quarantine ? "qcPendingQty" : "receivedQty"]: l.acceptedQty, rejectedQty: l.rejectedQty, pendingKantaQty: -n(l.grnQty), varianceQty: l.varianceQty }), quarantine ? "KANTA → QC QUARANTINE" : partial ? "KANTA / PARTIAL REJECTION" : "KANTA / INWARD",
            (mine) => `Kanta for ${cur.grn.grnNo}: ${describe(mine)}${quarantine ? " · held in QC quarantine (not in stock yet)" : ""}${partial ? `. Reason: ${v.rejectReason}` : ""}`);
          logActivity(tx, { module: "Inward", action: quarantine ? "KANTA → QC QUARANTINE" : partial ? "KANTA / PARTIAL REJECTION" : "KANTA / INWARD", refId: r.id, refNo: cur.grn.grnNo, summary: `Kanta ${cur.geNo}/${cur.grn.grnNo}: ${describe(lines)} ${quarantine ? "held in QC quarantine at" : "into"} ${warehouseByCode(cur.warehouse).name}. Payable ₹${money(payableValue)} (before GST)${partial ? ` · ${HOLD_TEXT} on rejected qty ₹${money(rejectedValue)} · Reason: ${v.rejectReason}` : ""}` });
        });
        const quarantined = isQuarantine(r);
        toast(quarantined ? "Kanta recorded — material is in QC quarantine; it goes into stock only after QC release." : partial ? "Kanta confirmed — accepted quantity added to stock; rejected quantity on payment hold." : "Kanta confirmed — stock updated.", "ok");
        modal.close();
        tab = quarantined ? "QC PENDING" : "COMPLETED";
        await load();
      } catch (error) { reportError(error); } finally { done(); }
    });
    recalc();
  }

  /* ---------------- 4. QC release (quarantine → stock) ---------------- */
  function openQc(r) {
    const modal = openModal({
      title: `QC release · ${r.geNo} · ${r.grn?.grnNo || ""}`,
      size: "wide",
      body: `${summaryGrid(r)}
        <div class="section-title">Quantity in quarantine</div>
        <form id="qForm" novalidate><div class="table-wrap"><table class="table"><thead><tr><th>Item</th><th>PO</th><th class="num">Kanta</th><th class="num">In quarantine</th><th class="num" style="width:150px">QC rejected</th><th class="num">Released to stock</th><th>Unit</th></tr></thead><tbody>
          ${r.lines.map((l, i) => `<tr data-i="${i}"><td class="strong">${esc(l.name)}</td><td class="small nowrap">${esc(l.poNo || "—")}</td><td class="num">${qty(n(l.kantaQty))}</td><td class="num">${qty(acceptedOf(l))}</td>
            <td><input type="number" step="any" min="0" class="num" name="qr${i}" value="0" /></td><td class="num strong" data-rel>${qty(acceptedOf(l))}</td><td>${esc(l.unit)}</td></tr>`).join("")}
        </tbody></table></div>
        <div class="form-grid" style="margin-top:14px">
          <label class="field span-2"><span>Test report / COA reference</span><input name="reportRef" placeholder="e.g. RM2610003 UV & M/C" /></label>
          <label class="field span-2"><span>Remarks / results</span><input name="remarks" placeholder="e.g. UV absorbance OK, moisture 0.02%" /></label>
          <label class="field span-2" data-why hidden><span>Reason for the QC rejected quantity <b class="req">*</b></span><input name="rejectReason" /></label>
        </div></form>
        <p class="small muted">Released quantity goes into <b>${esc(warehouseByCode(r.warehouse).name)}</b> RM stock and counts against the PO. QC rejected quantity never enters stock and is put on payment hold.</p>`,
      footer: '<button class="btn" data-close>Cancel</button><button class="btn danger" id="qcRejectAll"><i class="fa-solid fa-ban"></i> QC failed — reject all</button><button class="btn primary" id="qcRelease"><i class="fa-solid fa-flask-vial"></i> Release to stock</button>'
    });
    const f = modal.el.querySelector("#qForm");
    const recalc = () => {
      let any = false;
      r.lines.forEach((l, i) => {
        const rj = n(f[`qr${i}`].value); if (rj > 0) any = true;
        f.querySelector(`tr[data-i="${i}"] [data-rel]`).textContent = qty(Math.max(0, round(acceptedOf(l) - rj)));
      });
      f.querySelector("[data-why]").hidden = !any;
    };
    f.addEventListener("input", recalc);
    modal.el.querySelector("#qcRejectAll").addEventListener("click", () => rejectReceipt(r, modal));
    modal.el.querySelector("#qcRelease").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      const v = formValues(f);
      let qcRejected;
      try {
        qcRejected = r.lines.map((l, i) => {
          const rj = f[`qr${i}`].value === "" ? 0 : Number(f[`qr${i}`].value);
          if (!Number.isFinite(rj) || rj < 0) throw new Error(`${l.name}: QC rejected quantity must be 0 or more.`);
          if (rj > acceptedOf(l) + 0.0005) throw new Error(`${l.name}: QC rejected quantity is more than the quantity in quarantine.`);
          return round(rj);
        });
        if (qcRejected.some((x) => x > 0) && !v.rejectReason) throw new Error("Enter the reason for the QC rejected quantity.");
        if (r.lines.every((l, i) => round(acceptedOf(l) - qcRejected[i]) <= 0)) throw new Error("Everything is rejected — use “QC failed — reject all”.");
      } catch (error) { toast(error.message, "error"); return; }
      const done = busy(button);
      try {
        await runTransaction(db, async (tx) => {
          const ref = doc(db, "receipts", r.id);
          const cur = normalizeReceipt({ id: r.id, ...(await tx.get(ref)).data() });
          if (cur.stage !== "QC PENDING") throw new Error("This receipt is not in QC quarantine any more.");
          const poMap = await readPos(tx, cur.lines);
          const stock = await readStock(tx, cur.lines.map((l) => ({ warehouse: cur.warehouse, itemId: l.itemId })));
          const before = cur.lines.map((l) => acceptedOf(l));
          const lines = cur.lines.map((l, i) => {
            const released = round(before[i] - qcRejected[i]);
            return { ...l, qcRejectedQty: qcRejected[i], rejectedQty: round(n(l.rejectedQty) + qcRejected[i]), acceptedQty: released, payableQty: released };
          });
          const movements = lines.filter((l) => l.acceptedQty > 0).map((l) => ({ warehouse: cur.warehouse, item: { id: l.itemId, name: l.name, unit: l.unit, category: items.find((x) => x.id === l.itemId)?.category || l.category }, qty: l.acceptedQty, note: `QC released ${cur.grn.grnNo} · ${l.poNo || "no PO"} · invoice ${cur.invoiceNo}` }));
          if (movements.length) applyMovements(tx, stock, movements, { type: "INWARD (QC RELEASED)", id: r.id, no: cur.grn.grnNo });
          const rejectedValue = round(lines.reduce((s, l) => s + n(l.rejectedQty) * n(l.rate), 0), 2);
          const result = qcRejected.some((x) => x > 0) ? "Released with partial rejection" : "Released";
          tx.update(ref, {
            stage: "COMPLETED", lines, payableValue: round(lines.reduce((s, l) => s + l.acceptedQty * n(l.rate), 0), 2),
            qc: { result, reportRef: v.reportRef, remarks: v.remarks, rejectReason: v.rejectReason || "", at: serverTimestamp(), by: by() },
            ...(qcRejected.some((x) => x > 0) ? {
              partialRejection: { reason: [cur.partialRejection?.reason, `QC: ${v.rejectReason}`].filter(Boolean).join(" · "), at: serverTimestamp(), by: by(), rejectedValue },
              paymentHold: { ...(cur.paymentHold || {}), active: true, scope: "PARTIAL", since: cur.paymentHold?.since || serverTimestamp(), by: cur.paymentHold?.by || by(), rejectedValue }
            } : {})
          });
          const describe = (ls) => ls.map((l) => `${l.name} released ${qty(l.acceptedQty)} ${l.unit}${l.qcRejectedQty ? ` · QC rejected ${qty(l.qcRejectedQty)}` : ""}`).join(", ");
          updatePos(tx, poMap, lines, (l) => ({ qcPendingQty: -(n(l.acceptedQty) + n(l.qcRejectedQty)), receivedQty: l.acceptedQty, rejectedQty: n(l.qcRejectedQty) }), "QC RELEASED",
            (mine) => `QC released ${cur.grn.grnNo}: ${mine.map((l) => `${l.name} ${qty(l.acceptedQty)} ${l.unit}${l.qcRejectedQty ? ` (QC rejected ${qty(l.qcRejectedQty)})` : ""}`).join(", ")}`);
          logActivity(tx, { module: "Inward", action: "QC RELEASED", refId: r.id, refNo: cur.grn.grnNo, summary: `QC ${result.toLowerCase()} for ${cur.geNo}/${cur.grn.grnNo}: ${describe(lines)} into ${warehouseByCode(cur.warehouse).name} stock${v.reportRef ? ` · report ${v.reportRef}` : ""}${v.rejectReason ? ` · Reason: ${v.rejectReason}` : ""}` });
        });
        toast("QC released — material added to stock.", "ok");
        modal.close();
        tab = "COMPLETED";
        await load();
      } catch (error) { reportError(error); } finally { done(); }
    });
  }

  /* ---------------- Delete / reverse (admin) ---------------- */
  async function deleteReceipt(r, parentModal) {
    const reason = await confirmDialog(`Delete ${r.geNo}? The PO quantities will be reversed. The record is kept as CANCELLED.`, { title: "Delete receipt", danger: true, okText: "Delete", input: { label: "Reason", required: true } });
    if (!reason) return;
    try {
      await runTransaction(db, async (tx) => {
        const ref = doc(db, "receipts", r.id);
        const cur = normalizeReceipt({ id: r.id, ...(await tx.get(ref)).data() });
        if (!["GRN PENDING", "KANTA PENDING", "QC PENDING"].includes(cur.stage)) throw new Error("Only receipts not yet in stock can be deleted. Use Reverse instead.");
        const poMap = await readPos(tx, cur.lines);
        const grnDone = cur.stage === "KANTA PENDING";
        const inQc = cur.stage === "QC PENDING";
        updatePos(tx, poMap, cur.lines, (l) => ({
          invoicedQty: -n(l.invoiceQty),
          ...(grnDone ? { grnQty: -n(l.grnQty), pendingKantaQty: -n(l.grnQty) } : {}),
          ...(inQc ? { grnQty: -n(l.grnQty), qcPendingQty: -acceptedOf(l), rejectedQty: -n(l.rejectedQty), varianceQty: -(n(l.kantaQty) - n(l.grnQty)) } : {})
        }), "RECEIPT DELETED", () => `${cur.geNo} deleted. Reason: ${reason}`);
        tx.update(ref, { stage: "CANCELLED", cancelReason: reason, cancelledAt: serverTimestamp(), cancelledBy: by() });
        logActivity(tx, { module: "Inward", action: "DELETE", refId: r.id, refNo: cur.geNo, summary: `Deleted ${cur.geNo} (invoice ${cur.invoiceNo}). Reason: ${reason}` });
      });
      toast(`${r.geNo} deleted.`, "ok");
      parentModal?.close();
      await load();
    } catch (error) { reportError(error); }
  }

  async function reverseInward(r, parentModal) {
    const reason = await confirmDialog(`Reverse ${r.geNo}? The accepted quantities will be removed from ${warehouseByCode(r.warehouse).name} stock and the PO quantities reversed.`, { title: "Reverse inward", danger: true, okText: "Reverse", input: { label: "Reason", required: true } });
    if (!reason) return;
    try {
      await runTransaction(db, async (tx) => {
        const ref = doc(db, "receipts", r.id);
        const cur = normalizeReceipt({ id: r.id, ...(await tx.get(ref)).data() });
        if (cur.stage !== "COMPLETED") throw new Error("Only inwarded receipts can be reversed.");
        const poMap = await readPos(tx, cur.lines);
        const stock = await readStock(tx, cur.lines.map((l) => ({ warehouse: cur.warehouse, itemId: l.itemId })));
        const movements = cur.lines.filter((l) => acceptedOf(l) > 0).map((l) => ({ warehouse: cur.warehouse, item: { id: l.itemId, name: l.name, unit: l.unit, category: l.category }, qty: -acceptedOf(l), note: `Reversal of ${cur.geNo}: ${reason}` }));
        if (movements.length) applyMovements(tx, stock, movements, { type: "INWARD REVERSAL", id: r.id, no: cur.grn?.grnNo || cur.geNo });
        updatePos(tx, poMap, cur.lines, (l) => ({ invoicedQty: -n(l.invoiceQty), grnQty: -n(l.grnQty), receivedQty: -acceptedOf(l), rejectedQty: -n(l.rejectedQty), varianceQty: -(n(l.kantaQty) - n(l.grnQty)) }), "INWARD REVERSED", () => `${cur.geNo} reversed. Reason: ${reason}`);
        tx.update(ref, { stage: "CANCELLED", cancelReason: `Inward reversed: ${reason}`, cancelledAt: serverTimestamp(), cancelledBy: by() });
        logActivity(tx, { module: "Inward", action: "INWARD REVERSED", refId: r.id, refNo: cur.geNo, summary: `Reversed ${cur.geNo}: ${cur.lines.map((l) => `−${qty(acceptedOf(l))} ${l.unit} ${l.name}`).join(", ")}. Reason: ${reason}` });
      });
      toast("Inward reversed.", "ok");
      parentModal?.close();
      await load();
    } catch (error) { reportError(error); }
  }

  /* ---------------- Full rejection (vehicle) / payment hold ---------------- */
  async function rejectReceipt(r, parentModal) {
    const afterKanta = r.stage === "COMPLETED";
    const reason = await confirmDialog(`Full rejection of ${r.geNo} (invoice ${r.invoiceNo})? ${afterKanta ? `The accepted quantity will be taken out of ${warehouseByCode(r.warehouse).name} stock. ` : ""}Nothing will count as received against the PO (the PO quantity stays pending) and this receipt goes on payment hold for accounts. Other receipts are not affected.`,
      { title: "Vehicle rejected", danger: true, okText: "Mark Vehicle Rejected", input: { label: "Rejection reason", required: true, placeholder: "e.g. UV absorbance failed / wrong grade / leaking drums" } });
    if (!reason) return;
    try {
      await runTransaction(db, async (tx) => {
        const ref = doc(db, "receipts", r.id);
        const cur = normalizeReceipt({ id: r.id, ...(await tx.get(ref)).data() });
        const allowed = ["GRN PENDING", "KANTA PENDING", ...(can("qc") ? ["QC PENDING"] : []), ...(can("close") ? ["COMPLETED"] : [])];
        if (!allowed.includes(cur.stage)) throw new Error(cur.stage === "COMPLETED" ? "Only a manager or admin can reject a receipt that is already inwarded." : cur.stage === "QC PENDING" ? "Only a manager or admin can reject material that is in QC." : `A ${receiptStageLabel(cur).toLowerCase()} receipt cannot be rejected.`);
        const poMap = await readPos(tx, cur.lines);
        const done = cur.stage === "COMPLETED";
        const grnDone = cur.stage !== "GRN PENDING";
        const stock = done ? await readStock(tx, cur.lines.map((l) => ({ warehouse: cur.warehouse, itemId: l.itemId }))) : null;
        if (done) {
          const movements = cur.lines.filter((l) => acceptedOf(l) > 0).map((l) => ({ warehouse: cur.warehouse, item: { id: l.itemId, name: l.name, unit: l.unit, category: l.category }, qty: -acceptedOf(l), note: `Vehicle rejected after Kanta ${cur.geNo}: ${reason}` }));
          if (movements.length) applyMovements(tx, stock, movements, { type: "INWARD REJECTED", id: r.id, no: cur.grn?.grnNo || cur.geNo });
        }
        updatePos(tx, poMap, cur.lines, (l) => ({
          invoicedQty: -n(l.invoiceQty),
          ...(grnDone ? { grnQty: -n(l.grnQty) } : {}),
          ...(cur.stage === "KANTA PENDING" ? { pendingKantaQty: -n(l.grnQty) } : {}),
          ...(cur.stage === "QC PENDING" ? { qcPendingQty: -acceptedOf(l), varianceQty: -(n(l.kantaQty) - n(l.grnQty)), rejectedQty: acceptedOf(l) } : {}),
          ...(done ? { receivedQty: -acceptedOf(l), varianceQty: -(n(l.kantaQty) - n(l.grnQty)), rejectedQty: acceptedOf(l) } : cur.stage === "QC PENDING" ? {} : { rejectedQty: vehicleQty(l) })
        }), "VEHICLE REJECTED", () => `${cur.geNo} (invoice ${cur.invoiceNo}) vehicle rejected — counted as zero received; PO quantity pending again. Reason: ${reason}`);
        tx.update(ref, {
          stage: "REJECTED", lines: cur.lines.map((l) => ({ ...l, rejectedQty: vehicleQty(l), acceptedQty: 0, payableQty: 0 })), payableValue: 0,
          rejection: { reason, at: serverTimestamp(), by: by(), stageAtRejection: cur.stage },
          paymentHold: { active: true, scope: "FULL", since: serverTimestamp(), by: by() }
        });
        logActivity(tx, { module: "Inward", action: "VEHICLE REJECTED", refId: r.id, refNo: cur.geNo, summary: `${cur.geNo} (invoice ${cur.invoiceNo}, ${cur.vendor?.name}) VEHICLE REJECTED at ${receiptStageLabel(cur)}${done ? ` — ${cur.lines.map((l) => `−${qty(acceptedOf(l))} ${l.unit} ${l.name}`).join(", ")} removed from stock` : ""}. ${HOLD_TEXT}. Reason: ${reason}` });
      });
      toast(r.stage === "QC PENDING" ? `${r.geNo} rejected at QC — nothing added to stock; payment hold.` : `${r.geNo} marked Vehicle Rejected — payment hold.`);
      parentModal?.close();
      tab = "REJECTED";
      await load();
    } catch (error) { reportError(error); }
  }

  async function resolveHold(r, parentModal) {
    const note = await confirmDialog(`Resolve the payment hold on ${r.geNo} (invoice ${r.invoiceNo})? Quantities do not change; this only records what accounts should do now.`,
      { title: "Resolve payment hold", okText: "Resolve hold", input: { label: "Resolution", required: true, placeholder: "e.g. Vendor credit note CN-118 received — nothing payable for the rejected qty" } });
    if (!note) return;
    try {
      await runTransaction(db, async (tx) => {
        const ref = doc(db, "receipts", r.id);
        const cur = normalizeReceipt({ id: r.id, ...(await tx.get(ref)).data() });
        if (!isOnHold(cur)) throw new Error("There is no active payment hold on this receipt.");
        tx.update(ref, { paymentHold: { ...(cur.paymentHold || {}), active: false, resolution: note, resolvedAt: serverTimestamp(), resolvedBy: by() } });
        logActivity(tx, { module: "Inward", action: "HOLD RESOLVED", refId: r.id, refNo: cur.geNo, summary: `Payment hold on ${cur.geNo} (invoice ${cur.invoiceNo}) resolved: ${note}` });
        cur.poIds.forEach((id) => logActivity(tx, { module: "Purchase Orders", action: "HOLD RESOLVED", refId: id, refNo: cur.lines.find((l) => l.poId === id)?.poNo || "", summary: `Payment hold on ${cur.geNo} resolved: ${note}` }));
      });
      toast("Payment hold resolved.", "ok");
      parentModal?.close();
      await load();
    } catch (error) { reportError(error); }
  }

  function editTransport(r, parentModal) {
    const modal = openModal({
      title: `Transport · ${r.geNo}`,
      body: `<form id="tForm" class="form-grid" style="grid-template-columns:1fr 1fr" novalidate>
        <label class="field"><span>Transport Arrangement <b class="req">*</b></span><select name="transportMode">${transportOptions(r.transportMode)}</select></label>
        <label class="field"><span>Transportation Amount (₹)</span><input type="number" min="0" step="any" name="transportAmount" value="${esc(r.transportAmount ?? "")}" /></label>
        <label class="field"><span>Transporter</span><input name="transporter" value="${esc(r.transporter || "")}" /></label>
        <label class="field"><span>LR No.</span><input name="lrNo" value="${esc(r.lrNo || "")}" /></label>
        <label class="field"><span>Vehicle No.</span><input name="vehicleNo" value="${esc(r.vehicleNo || "")}" /></label>
        <p class="small muted span-2" style="margin:0">Internal tracking only — not printed on the PO and not added to the PO total.</p></form>`,
      footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="saveT">Save transport</button>'
    });
    modal.el.querySelector("#saveT").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      const v = formValues(modal.el.querySelector("#tForm"));
      if (!TRANSPORT_MODES[v.transportMode]) { toast("Select the transport arrangement.", "error"); return; }
      if (v.transportAmount !== "" && !(Number(v.transportAmount) >= 0)) { toast("Transportation amount must be 0 or more.", "error"); return; }
      const next = { transportMode: v.transportMode, transportAmount: amountOf(v.transportAmount), transporter: v.transporter, lrNo: v.lrNo, vehicleNo: v.vehicleNo.toUpperCase() };
      const done = busy(button);
      try {
        await runTransaction(db, async (tx) => {
          const ref = doc(db, "receipts", r.id);
          const cur = (await tx.get(ref)).data();
          if (cur.stage === "CANCELLED") throw new Error("This receipt is cancelled.");
          tx.update(ref, { ...next, transportUpdatedAt: serverTimestamp(), transportUpdatedBy: by() });
          logActivity(tx, { module: "Inward", action: "TRANSPORT", refId: r.id, refNo: cur.geNo, summary: `Transport for ${cur.geNo}: ${transportText(cur)} → ${transportText(next)}${next.transporter ? ` · ${next.transporter}` : ""}${next.lrNo ? ` · LR ${next.lrNo}` : ""}` });
        });
        toast("Transport details saved.", "ok");
        modal.close();
        parentModal?.close();
        await load();
      } catch (error) { reportError(error); } finally { done(); }
    });
  }

  function summaryGrid(r) {
    const poNos = [...new Set(r.lines.map((l) => l.poNo).filter(Boolean))];
    return `<div class="detail-grid">
      <div><span>Receipt</span><b>${esc(r.geNo)}</b></div><div><span>${poNos.length > 1 ? "POs (bill split)" : "PO"}</span><b>${esc(poNos.join(", ") || "Without PO")}</b></div>
      <div><span>Vendor</span><b>${esc(r.vendor?.name)}</b></div><div><span>Warehouse</span><b>${esc(warehouseByCode(r.warehouse).name)}</b></div>
      <div><span>Invoice</span><b>${esc(r.invoiceNo)} · ${fmtDate(r.invoiceDate)}</b></div><div><span>Vehicle</span><b>${esc(r.vehicleNo || "—")}</b></div>
      <div><span>Transport</span><b>${esc(transportText(r))}${r.transporter ? ` · ${esc(r.transporter)}` : ""}${r.lrNo ? ` · LR ${esc(r.lrNo)}` : ""}</b></div>
      <div><span>Received As</span><b>${esc(r.receivedAs || "—")}${r.containers ? ` · ${qty(r.containers)}` : ""}</b></div><div><span>Created</span><b>${fmtDateTime(r.createdAt)} · ${esc(r.createdBy?.name)}</b></div>
      ${r.grn ? `<div><span>GRN</span><b>${esc(r.grn.grnNo)} · ${fmtDateTime(r.grn.at)} · ${esc(r.grn.by?.name)}</b></div>` : ""}
      <div><span>Documents</span><b class="small">${docLinks(r.docs)}</b></div>
    </div>`;
  }

  function openView(r) {
    const rejected = r.stage === "REJECTED";
    const partly = isPartlyRejected(r);
    const buttons = [];
    if (canOperate && r.stage !== "CANCELLED") buttons.push('<button class="btn" id="trRec"><i class="fa-solid fa-truck"></i> Edit transport</button>');
    if (canQc && r.stage === "QC PENDING") buttons.push('<button class="btn primary" id="qcRec"><i class="fa-solid fa-flask-vial"></i> QC release</button>');
    if (canOperate && ["GRN PENDING", "KANTA PENDING"].includes(r.stage)) buttons.push('<button class="btn danger" id="rejRec"><i class="fa-solid fa-ban"></i> Vehicle rejected</button>');
    if (canQc && r.stage === "QC PENDING") buttons.push('<button class="btn danger" id="rejRec"><i class="fa-solid fa-ban"></i> QC failed — reject all</button>');
    if (canResolve && r.stage === "COMPLETED") buttons.push('<button class="btn danger" id="rejRec"><i class="fa-solid fa-ban"></i> Reject after Kanta (reverse stock)</button>');
    if (canResolve && isOnHold(r)) buttons.push('<button class="btn gold" id="resolveHold"><i class="fa-solid fa-unlock"></i> Resolve payment hold</button>');
    if (isAdmin() && ["GRN PENDING", "KANTA PENDING", "QC PENDING"].includes(r.stage)) buttons.push('<button class="btn danger" id="delRec">Delete entry</button>');
    if (isAdmin() && r.stage === "COMPLETED") buttons.push('<button class="btn danger" id="revRec">Reverse inward</button>');
    const holdLine = (what) => (isOnHold(r) ? `<br><b>${HOLD_TEXT}</b>: accounts must not pay ${what} of supplier invoice ${esc(r.invoiceNo)}. This is an instruction for accounts; it does not block payment in Tally.` : `<br>Hold resolved by ${esc(r.paymentHold?.resolvedBy?.name)} on ${fmtDateTime(r.paymentHold?.resolvedAt)} — ${esc(r.paymentHold?.resolution)}`);
    const modal = openModal({
      title: `${r.geNo}${r.grn ? ` · ${r.grn.grnNo}` : ""}`,
      size: "full",
      body: `<div style="display:flex;gap:8px;flex-wrap:wrap">${badge(receiptStageLabel(r))}${accountsBadge(r)}</div><div style="height:12px"></div>
        ${rejected ? `<div class="notice error" style="margin-bottom:12px"><i class="fa-solid fa-ban"></i><div><b>Full rejection — Vehicle Rejected</b> by ${esc(r.rejection?.by?.name)} on ${fmtDateTime(r.rejection?.at)} (at ${esc(r.rejection?.stageAtRejection === "ENTRY" ? "gate entry" : r.rejection?.stageAtRejection === "COMPLETED" ? "after Kanta — stock reversed" : r.rejection?.stageAtRejection)}) — ${esc(r.rejection?.reason)}.
          Nothing from this receipt is counted as received or added to stock.${holdLine("this receipt")}</div></div>` : ""}
        ${partly ? `<div class="notice warn" style="margin-bottom:12px"><i class="fa-solid fa-scale-unbalanced"></i><div><b>Partial rejection</b> by ${esc(r.partialRejection?.by?.name)} on ${fmtDateTime(r.partialRejection?.at)} — ${esc(r.partialRejection?.reason)}.
          Only the accepted quantity went into stock and counts against the PO; the rejected quantity (₹${money(r.partialRejection?.rejectedValue)} before GST) is shown separately.${holdLine("the rejected quantity")}</div></div>` : ""}
        ${summaryGrid(r)}
        <div class="section-title">Items</div>
        <div class="table-wrap"><table class="table"><thead><tr><th>Item</th><th>PO</th><th class="num">Invoice</th><th class="num">GRN</th><th class="num">Kanta</th><th class="num">Short/Excess</th><th class="num">Rejected</th><th class="num">Accepted / Payable</th><th class="num">Payable ₹</th></tr></thead><tbody>
        ${r.lines.map((l) => {
          const weighed = l.kantaQty !== undefined;
          const vq = weighed ? round(n(l.kantaQty) - n(l.grnQty)) : null;
          const accepted = r.stage === "COMPLETED" ? acceptedOf(l) : r.stage === "REJECTED" ? 0 : null;
          return `<tr><td class="strong">${esc(l.name)}</td><td class="small nowrap">${l.poId ? `<a href="/purchase-orders?open=${esc(l.poId)}">${esc(l.poNo)}</a>` : "—"}</td><td class="num">${qty(n(l.invoiceQty))} ${esc(l.unit)}</td><td class="num">${l.grnQty !== undefined ? qty(n(l.grnQty)) : "—"}</td><td class="num">${weighed ? qty(n(l.kantaQty)) : "—"}</td>
            <td class="num" style="color:${diffColor(vq)}">${vq === null ? "—" : fmtDiff(vq)}</td><td class="num" style="color:${n(l.rejectedQty) ? "var(--danger)" : "inherit"}">${qty(n(l.rejectedQty))}</td>
            <td class="num strong">${accepted === null ? "—" : qty(accepted)}</td><td class="num">${accepted !== null && l.rate ? money(accepted * l.rate) : "—"}</td></tr>`;
        }).join("")}
        </tbody></table></div>
        ${r.stage === "QC PENDING" ? `<div class="notice" style="margin-top:12px"><i class="fa-solid fa-flask"></i><div><b>In QC quarantine</b> — weighed on the Kanta but <b>not in stock</b>. A manager / admin releases it (or rejects it) after testing.</div></div>` : ""}
        ${r.qc ? `<div class="section-title">QC release</div><div class="detail-grid"><div><span>Result</span><b>${esc(r.qc.result)}</b></div><div><span>By</span><b>${esc(r.qc.by?.name)} · ${fmtDateTime(r.qc.at)}</b></div><div><span>Test / COA ref.</span><b>${esc(r.qc.reportRef || "—")}</b></div><div><span>Remarks</span><b>${esc(r.qc.remarks || "—")}</b></div></div>` : ""}
        ${r.kanta ? `<div class="section-title">Kanta</div><div class="detail-grid"><div><span>Gross / Tare / Net</span><b>${qty(r.kanta.grossWeight ?? 0)} / ${qty(r.kanta.tareWeight ?? 0)} / ${qty(r.kanta.netWeight ?? 0)} ${esc(r.kanta.weightUnit || "")}</b></div><div><span>By</span><b>${esc(r.kanta.by?.name)} · ${fmtDateTime(r.kanta.at)}</b></div><div><span>Remark</span><b>${esc(r.kanta.remark || "—")}</b></div></div>` : ""}
        ${r.grn ? `<div class="section-title">GRN</div><div class="detail-grid"><div><span>GRN No.</span><b>${esc(r.grn.grnNo)}</b></div><div><span>QC</span><b>${esc(r.grn.qc || "—")}</b></div><div><span>Batch</span><b>${esc(r.grn.batchNo || "—")}</b></div><div><span>Remark</span><b>${esc(r.grn.remark || "—")}</b></div></div>` : ""}
        ${r.transportUpdatedBy ? `<p class="small muted">Transport last edited by ${esc(r.transportUpdatedBy.name)} on ${fmtDateTime(r.transportUpdatedAt)}.</p>` : ""}
        ${r.stage === "CANCELLED" ? `<div class="notice error" style="margin-top:14px">Cancelled by ${esc(r.cancelledBy?.name)} on ${fmtDateTime(r.cancelledAt)} — ${esc(r.cancelReason)}</div>` : ""}`,
      footer: `<button class="btn" data-close>Close</button>${buttons.join("")}`
    });
    modal.el.querySelector("#trRec")?.addEventListener("click", () => editTransport(r, modal));
    modal.el.querySelector("#qcRec")?.addEventListener("click", () => { modal.close(); openQc(r); });
    modal.el.querySelector("#rejRec")?.addEventListener("click", () => rejectReceipt(r, modal));
    modal.el.querySelector("#resolveHold")?.addEventListener("click", () => resolveHold(r, modal));
    modal.el.querySelector("#delRec")?.addEventListener("click", () => deleteReceipt(r, modal));
    modal.el.querySelector("#revRec")?.addEventListener("click", () => reverseInward(r, modal));
  }

  await load();
  document.body.dataset.loaded = "1";
}
