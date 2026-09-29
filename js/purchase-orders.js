import {
  db, reportError, state, initPage, pageHeader, esc, toast, openModal, confirmDialog, badge, busy, formValues, can, isAdmin,
  listCollection, logActivity, money, qty, fmtDate, fmtDateTime, isoDate, addDays, round, computeTotals,
  reserveNumber, commitNumber, warehouseByCode, warehouseOptions, deriveOrderStatus, progressBar, exportExcel, STATE_CODES
} from "./core.js";
import { createLineEditor } from "./line-editor.js";
import { poSpec, showDocument, safeFileName } from "./pdf.js";
import { collection, doc, runTransaction, serverTimestamp, query, where, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const page = await initPage("po");
if (page) start();

async function start() {
  let pos = [];
  let vendors = [];
  let items = [];
  let tab = "ACTIVE";
  const canEdit = can("commercial");

  page.innerHTML = `${pageHeader("Purchase", "Purchase Orders", "Create, send and track POs until every unit has arrived.",
    `<button class="btn" id="exportBtn"><i class="fa-solid fa-download"></i> Export</button>${canEdit ? '<button class="btn primary" id="newPo"><i class="fa-solid fa-plus"></i> New Purchase Order</button>' : ""}`)}
    <div class="tabs" id="tabs"></div>
    <div class="card">
      <div class="card-head"><div class="toolbar"><input class="input search" id="search" placeholder="Search PO no, vendor, item…" />
        <select class="input" id="whFilter"><option value="">All delivery locations</option>${warehouseOptions("", { includeBlank: false })}</select></div><span class="small muted" id="count"></span></div>
      <div class="table-wrap"><table class="table"><thead><tr><th>PO No.</th><th>Date</th><th>Vendor</th><th>Deliver To</th><th>Items</th><th class="num">Value (₹)</th><th>Received</th><th>Status</th><th></th></tr></thead><tbody id="rows"></tbody></table></div>
    </div>`;

  const TABS = [["ACTIVE", "Open & Partial"], ["OPEN", "Open"], ["PARTIALLY RECEIVED", "Partially received"], ["COMPLETED", "Completed"], ["SHORT CLOSED", "Short closed"], ["CANCELLED", "Cancelled"], ["ALL", "All"]];
  const inTab = (po, t) => t === "ALL" || (t === "ACTIVE" ? ["OPEN", "PARTIALLY RECEIVED"].includes(po.status) : po.status === t);

  function lineProgress(po) {
    const ordered = po.lines.reduce((s, l) => s + (Number(l.qty) || 0), 0);
    const received = po.lines.reduce((s, l) => s + Math.min(Number(l.receivedQty) || 0, Number(l.qty) || 0), 0);
    return { ordered, received };
  }

  function render() {
    page.querySelector("#tabs").innerHTML = TABS.map(([k, label]) => `<button class="tab ${k === tab ? "active" : ""}" data-tab="${k}">${label}<span class="count">${pos.filter((p) => inTab(p, k)).length}</span></button>`).join("");
    const term = page.querySelector("#search").value.trim().toLowerCase();
    const wh = page.querySelector("#whFilter").value;
    const list = pos.filter((p) => inTab(p, tab) && (!wh || p.warehouse === wh)
      && (!term || [p.poNo, p.vendor?.name, p.refNo, ...p.lines.map((l) => l.name)].some((v) => String(v || "").toLowerCase().includes(term))));
    page.querySelector("#count").textContent = `${list.length} purchase order${list.length === 1 ? "" : "s"}`;
    const rows = page.querySelector("#rows");
    if (!list.length) { rows.innerHTML = '<tr><td class="empty" colspan="9">No purchase orders here.</td></tr>'; return; }
    rows.innerHTML = list.map((p) => {
      const { ordered, received } = lineProgress(p);
      const single = p.lines.length === 1 ? p.lines[0] : null;
      return `<tr>
        <td class="strong nowrap"><a href="#" data-view="${esc(p.id)}">${esc(p.poNo)}</a></td>
        <td class="nowrap">${fmtDate(p.date)}</td>
        <td>${esc(p.vendor?.name)}</td>
        <td>${esc(warehouseByCode(p.warehouse).name)}</td>
        <td>${single ? `${esc(single.name)}<div class="small muted">${qty(single.qty)} ${esc(single.unit)}</div>` : `${p.lines.length} items`}</td>
        <td class="num">${money(p.totals?.total)}</td>
        <td>${progressBar(received, ordered)}<div class="progress-label">${single ? `${qty(single.receivedQty || 0)} / ${qty(single.qty)} ${esc(single.unit)}` : `${Math.round((received / (ordered || 1)) * 100)}%`}</div></td>
        <td>${badge(p.status)}</td>
        <td><div class="actions"><button class="btn sm" data-pdf="${esc(p.id)}" title="PDF"><i class="fa-solid fa-file-pdf"></i></button><button class="btn sm" data-view="${esc(p.id)}">Open</button></div></td>
      </tr>`;
    }).join("");
  }

  async function load() {
    [pos, vendors, items] = await Promise.all([
      listCollection("purchaseOrders", "createdAt", "desc"),
      listCollection("vendors"),
      listCollection("items")
    ]);
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
  page.querySelector("#newPo")?.addEventListener("click", () => openEditor());
  page.querySelector("#exportBtn").addEventListener("click", () => {
    const rows = pos.flatMap((p) => p.lines.map((l) => ({
      "PO No": p.poNo, Date: fmtDate(p.date), Vendor: p.vendor?.name, "Vendor GSTIN": p.vendor?.gstin || "", "Deliver To": warehouseByCode(p.warehouse).name,
      Item: l.name, HSN: l.hsn, Unit: l.unit, "Ordered Qty": l.qty, Rate: l.rate, "GST %": l.gstRate, "Line Amount": round(l.qty * l.rate, 2),
      "Invoiced Qty": l.invoicedQty || 0, "Received Qty": l.receivedQty || 0, "Rejected Qty": l.rejectedQty || 0, "Transit Shortage": l.shortQty || 0,
      "Pending Qty": Math.max(0, round(l.qty - (l.receivedQty || 0))), "PO Total": p.totals?.total, Status: p.status
    })));
    if (!rows.length) { toast("Nothing to export."); return; }
    exportExcel(rows, `CCPL_Purchase_Orders_${isoDate()}.xlsx`, "Purchase Orders");
  });

  /* ---------------- Editor ---------------- */
  function openEditor(existing = null, { duplicate = false } = {}) {
    if (!vendors.filter((v) => v.active !== false).length) { toast("Add a vendor first (Purchase → Vendors).", "error"); return; }
    if (!items.filter((i) => i.active !== false).length) { toast("Add items first (Inventory → Items & Packaging).", "error"); return; }
    const po = existing || {};
    const editing = existing && !duplicate;
    const firstWh = po.warehouse || state.warehouses[0]?.code;
    const modal = openModal({
      title: editing ? `Edit ${po.poNo}` : "New Purchase Order",
      size: "full",
      body: `<form id="poForm" novalidate>
        <div class="form-grid">
          <label class="field span-2"><span>Vendor <b class="req">*</b></span><select name="vendorId" required><option value="">Select vendor…</option>${vendors.filter((v) => v.active !== false || v.id === po.vendor?.id).sort((a, b) => a.name.localeCompare(b.name)).map((v) => `<option value="${esc(v.id)}" ${v.id === po.vendor?.id ? "selected" : ""}>${esc(v.name)}${v.gstin ? ` · ${esc(v.gstin)}` : ""}</option>`).join("")}</select></label>
          <label class="field"><span>PO Date <b class="req">*</b></span><input type="date" name="date" value="${esc(editing ? po.date : isoDate())}" required /></label>
          <label class="field"><span>Deliver To <b class="req">*</b></span><select name="warehouse" required>${warehouseOptions(firstWh, { includeBlank: false })}</select></label>
          <label class="field"><span>Payment Terms</span><input name="paymentTerms" value="${esc(po.paymentTerms || "30 Days")}" /></label>
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
    const editor = createLineEditor(modal.el.querySelector("#lines"), {
      items,
      lines: (po.lines || []).map((l) => (duplicate ? { ...l, lineId: undefined } : l)),
      isIntraState: intra
    });
    form.vendorId.addEventListener("change", () => {
      const v = vendorOf();
      if (v?.paymentTermsDays) form.paymentTerms.value = `${v.paymentTermsDays} Days`;
      setTaxType();
    });
    form.warehouse.addEventListener("change", () => { form.destination.value = warehouseByCode(form.warehouse.value).destination || form.destination.value; });
    setTaxType();

    modal.el.querySelector("#savePo").addEventListener("click", async (event) => {
      const values = formValues(form);
      const vendor = vendorOf();
      let lines;
      try {
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
        lines: lines.map((l) => ({ ...l, invoicedQty: 0, receivedQty: 0, rejectedQty: 0, shortQty: 0 })),
        totals,
        itemIds: [...new Set(lines.map((l) => l.itemId))],
        updatedAt: serverTimestamp()
      };
      const done = busy(event.currentTarget);
      try {
        const saved = await runTransaction(db, async (tx) => {
          if (editing) {
            const ref = doc(db, "purchaseOrders", po.id);
            const snap = await tx.get(ref);
            const cur = snap.data();
            if (cur.status !== "OPEN" || cur.lines.some((l) => (l.invoicedQty || 0) > 0)) throw new Error("This PO already has material inward against it and can no longer be edited. Short-close it and raise a new PO instead.");
            data.refNo = values.refNo || cur.poNo;
            tx.update(ref, data);
            logActivity(tx, { module: "Purchase Orders", action: "UPDATE", refId: ref.id, refNo: cur.poNo, summary: `Edited PO ${cur.poNo} · ${vendor.name} · ₹${money(totals.total)}` });
            return { id: ref.id, poNo: cur.poNo };
          }
          const ref = doc(collection(db, "purchaseOrders"));
          const number = await reserveNumber(tx, "PO", { date: values.date, site: wh.docCode });
          commitNumber(tx, number);
          tx.set(ref, { ...data, poNo: number.number, refNo: values.refNo || number.number, status: "OPEN", createdAt: serverTimestamp(), createdBy: { uid: state.user.uid, name: state.profile.name || state.user.email } });
          logActivity(tx, { module: "Purchase Orders", action: "CREATE", refId: ref.id, refNo: number.number, summary: `Created PO ${number.number} · ${vendor.name} · ${lines.map((l) => `${l.name} ${qty(l.qty)} ${l.unit}`).join(", ")} · ₹${money(totals.total)}` });
          return { id: ref.id, poNo: number.number };
        });
        toast(`${saved.poNo} saved.`, "ok");
        modal.close();
        await load();
        const fresh = pos.find((p) => p.id === saved.id);
        if (fresh && !editing) showDocument(poSpec(fresh), `${safeFileName(fresh.poNo)}.pdf`);
      } catch (error) { reportError(error); } finally { done(); }
    });
  }

  /* ---------------- Detail ---------------- */
  async function openDetail(po) {
    if (!po) return;
    const [receiptSnap, logSnap] = await Promise.all([
      getDocs(query(collection(db, "receipts"), where("poId", "==", po.id))),
      getDocs(query(collection(db, "activity"), where("refId", "==", po.id)))
    ]);
    const receipts = receiptSnap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
    const log = logSnap.docs.map((d) => d.data()).sort((a, b) => (b.at?.seconds || 0) - (a.at?.seconds || 0));
    const inProcess = receipts.filter((r) => ["KANTA PENDING", "GRN PENDING"].includes(r.stage));
    const editable = canEdit && po.status === "OPEN" && !po.lines.some((l) => (l.invoicedQty || 0) > 0);
    const closable = can("close") && ["OPEN", "PARTIALLY RECEIVED"].includes(po.status);
    const modal = openModal({
      title: `${po.poNo}`,
      size: "full",
      body: `<div style="display:flex;gap:10px;align-items:center;margin-bottom:14px;flex-wrap:wrap">${badge(po.status)}<span class="muted">${esc(po.vendor?.name)} · Deliver to ${esc(warehouseByCode(po.warehouse).name)} · ₹${money(po.totals?.total)}</span></div>
        ${po.status === "SHORT CLOSED" ? `<div class="notice warn" style="margin-bottom:14px"><i class="fa-solid fa-circle-info"></i><div>Short-closed by <b>${esc(po.closedBy?.name)}</b> on ${fmtDateTime(po.closedAt)} — ${esc(po.closeReason)}</div></div>` : ""}
        ${po.status === "CANCELLED" ? `<div class="notice error" style="margin-bottom:14px"><i class="fa-solid fa-ban"></i><div>Cancelled by <b>${esc(po.closedBy?.name)}</b> on ${fmtDateTime(po.closedAt)} — ${esc(po.closeReason)}</div></div>` : ""}
        <div class="detail-grid" style="margin-bottom:18px">
          <div><span>PO Date</span><b>${fmtDate(po.date)}</b></div><div><span>Payment Terms</span><b>${esc(po.paymentTerms || "—")}</b></div>
          <div><span>Expected Delivery</span><b>${fmtDate(po.expectedDate)}</b></div><div><span>Created By</span><b>${esc(po.createdBy?.name || "—")}</b></div>
          <div><span>Vendor GSTIN</span><b>${esc(po.vendor?.gstin || "—")}</b></div><div><span>Tax</span><b>${po.intraState ? "CGST + SGST" : "IGST"}</b></div>
        </div>
        <div class="section-title">Quantity tracking</div>
        <div class="table-wrap"><table class="table"><thead><tr><th>Item</th><th class="num">Ordered</th><th class="num">Invoiced</th><th class="num">Received (GRN)</th><th class="num">Rejected</th><th class="num">Kanta shortage</th><th class="num">Pending</th><th>Progress</th></tr></thead><tbody>
          ${po.lines.map((l) => `<tr><td class="strong">${esc(l.name)}</td><td class="num">${qty(l.qty)} ${esc(l.unit)}</td><td class="num">${qty(l.invoicedQty || 0)}</td><td class="num strong">${qty(l.receivedQty || 0)}</td><td class="num">${qty(l.rejectedQty || 0)}</td><td class="num" style="color:${(l.shortQty || 0) > 0 ? "var(--danger)" : "inherit"}">${qty(l.shortQty || 0)}</td><td class="num strong">${qty(Math.max(0, round(l.qty - (l.receivedQty || 0))))}</td><td>${progressBar(l.receivedQty || 0, l.qty)}</td></tr>`).join("")}
        </tbody></table></div>
        <div class="section-title">Inward transactions (${receipts.length})</div>
        ${receipts.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Gate Entry</th><th>Date</th><th>Item</th><th>Invoice No.</th><th class="num">Invoice Qty</th><th class="num">Kanta Qty</th><th class="num">Shortage</th><th class="num">Accepted</th><th>GRN</th><th>Stage</th></tr></thead><tbody>
          ${receipts.map((r) => `<tr><td class="strong nowrap">${esc(r.geNo)}</td><td class="nowrap">${fmtDateTime(r.createdAt)}</td><td>${esc(r.item?.name)}</td><td>${esc(r.invoiceNo)}</td><td class="num">${qty(r.invoiceQty)}</td><td class="num">${r.kanta ? qty(r.kanta.receivedQty) : "—"}</td><td class="num" style="color:${(r.shortageQty || 0) > 0 ? "var(--danger)" : "inherit"}">${r.kanta ? qty(r.shortageQty || 0) : "—"}</td><td class="num">${r.grn ? qty(r.grn.acceptedQty) : "—"}</td><td class="nowrap">${esc(r.grn?.grnNo || "—")}</td><td>${badge(r.stage)}</td></tr>`).join("")}
        </tbody></table></div>` : '<p class="muted">No material has arrived against this PO yet.</p>'}
        <div class="section-title">History</div>
        <ul class="timeline">${log.map((a) => `<li><time>${fmtDateTime(a.at)}</time><div><b>${esc(a.userName)}</b> · ${esc(a.summary)}</div></li>`).join("") || '<li class="muted">No history.</li>'}</ul>`,
      footer: `<button class="btn" data-close>Close</button>
        ${canEdit ? '<button class="btn" id="dupPo"><i class="fa-regular fa-copy"></i> Duplicate</button>' : ""}
        ${editable ? '<button class="btn" id="editPo"><i class="fa-solid fa-pen"></i> Edit</button>' : ""}
        ${editable ? '<button class="btn danger" id="cancelPo"><i class="fa-solid fa-ban"></i> Cancel PO</button>' : ""}
        ${closable && !editable ? '<button class="btn gold" id="closePo"><i class="fa-solid fa-flag-checkered"></i> Mark complete (short close)</button>' : ""}
        ${isAdmin() && po.status === "SHORT CLOSED" ? '<button class="btn" id="reopenPo">Reopen</button>' : ""}
        <button class="btn primary" id="pdfPo"><i class="fa-solid fa-file-pdf"></i> View / Download PDF</button>`
    });
    const $ = (s) => modal.el.querySelector(s);
    $("#pdfPo").addEventListener("click", () => showDocument(poSpec(po), `${safeFileName(po.poNo)}.pdf`));
    $("#editPo")?.addEventListener("click", () => { modal.close(); openEditor(po); });
    $("#dupPo")?.addEventListener("click", () => { modal.close(); openEditor(po, { duplicate: true }); });
    const closeWith = async (status, button) => {
      if (status === "SHORT CLOSED" && inProcess.length) {
        toast(`${inProcess.length} inward entr${inProcess.length === 1 ? "y is" : "ies are"} still pending Kanta/GRN for this PO. Complete or delete them first.`, "error");
        return;
      }
      const pending = po.lines.map((l) => `${l.name}: ${qty(Math.max(0, l.qty - (l.receivedQty || 0)))} ${l.unit}`).join(", ");
      const reason = await confirmDialog(status === "CANCELLED"
        ? `Cancel ${po.poNo}? The vendor should be informed separately.`
        : `Mark ${po.poNo} as complete even though it is not fully received? Pending quantity (${pending}) will be dropped and no more inward will be accepted against this PO.`,
      { title: status === "CANCELLED" ? "Cancel purchase order" : "Short close purchase order", okText: status === "CANCELLED" ? "Cancel PO" : "Mark complete", danger: status === "CANCELLED", input: { label: "Reason", required: true, placeholder: "e.g. Vendor cannot supply balance / requirement changed" } });
      if (!reason) return;
      const done = busy(button);
      try {
        await runTransaction(db, async (tx) => {
          const ref = doc(db, "purchaseOrders", po.id);
          const cur = (await tx.get(ref)).data();
          if (!["OPEN", "PARTIALLY RECEIVED"].includes(cur.status)) throw new Error(`PO is already ${cur.status}.`);
          tx.update(ref, { status, closeReason: reason, closedAt: serverTimestamp(), closedBy: { uid: state.user.uid, name: state.profile.name || state.user.email }, updatedAt: serverTimestamp() });
          logActivity(tx, { module: "Purchase Orders", action: status === "CANCELLED" ? "CANCEL" : "SHORT CLOSE", refId: po.id, refNo: po.poNo, summary: `${status === "CANCELLED" ? "Cancelled" : "Short-closed"} PO ${po.poNo}. Pending dropped: ${pending}. Reason: ${reason}` });
        });
        toast(`${po.poNo} ${status === "CANCELLED" ? "cancelled" : "marked complete"}.`, "ok");
        modal.close();
        await load();
      } catch (error) { reportError(error); } finally { done(); }
    };
    $("#cancelPo")?.addEventListener("click", (e) => closeWith("CANCELLED", e.currentTarget));
    $("#closePo")?.addEventListener("click", (e) => closeWith("SHORT CLOSED", e.currentTarget));
    $("#reopenPo")?.addEventListener("click", async (e) => {
      const button = e.currentTarget;
      if (!(await confirmDialog(`Reopen ${po.poNo}?`))) return;
      const done = busy(button);
      try {
        await runTransaction(db, async (tx) => {
          const ref = doc(db, "purchaseOrders", po.id);
          const cur = (await tx.get(ref)).data();
          const status = deriveOrderStatus({ ...cur, status: "OPEN" }, "receivedQty", state.company.poTolerancePct);
          tx.update(ref, { status, closeReason: "", updatedAt: serverTimestamp() });
          logActivity(tx, { module: "Purchase Orders", action: "REOPEN", refId: po.id, refNo: po.poNo, summary: `Reopened PO ${po.poNo}` });
        });
        modal.close();
        await load();
      } catch (error) { reportError(error); } finally { done(); }
    });
  }

  await load();
  const openId = new URLSearchParams(location.search).get("open");
  if (openId) openDetail(pos.find((p) => p.id === openId));
}
