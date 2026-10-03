// Quotations and Sales Orders (shared implementation).
// Quotation: DRAFT → SENT → ACCEPTED → CONVERTED (to SO) | REJECTED
// Sales Order: OPEN → PARTIALLY DISPATCHED → COMPLETED | SHORT CLOSED | CANCELLED (dispatch via Outward)
import {
  db, reportError, state, initPage, pageHeader, esc, toast, openModal, confirmDialog, badge, busy, formValues, can, isAdmin,
  listCollection, logActivity, money, qty, fmtDate, fmtDateTime, isoDate, addDays, round, computeTotals,
  reserveNumber, commitNumber, warehouseByCode, warehouseOptions, deriveOrderStatus, progressBar, exportExcel, STATE_CODES
} from "./core.js";
import { createLineEditor } from "./line-editor.js";
import { docTypeField, partyOption, openOtherType, takeDraft } from "./sales-draft.js";
import { quotationSpec, soSpec, showDocument, safeFileName } from "./pdf.js";
import { collection, doc, runTransaction, serverTimestamp, query, where, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const CFG = {
  QT: { nav: "quotations", col: "quotations", noKey: "quoteNo", title: "Quotations", singular: "Quotation", spec: quotationSpec, module: "Quotations",
    tabs: [["ACTIVE", "Draft & Sent"], ["DRAFT", "Draft"], ["SENT", "Sent"], ["ACCEPTED", "Accepted"], ["CONVERTED", "Converted to SO"], ["REJECTED", "Rejected"], ["ALL", "All"]],
    active: ["DRAFT", "SENT"] },
  SO: { nav: "so", col: "salesOrders", noKey: "soNo", title: "Sales Orders", singular: "Sales Order", spec: soSpec, module: "Sales Orders",
    tabs: [["ACTIVE", "Open & Partial"], ["OPEN", "Open"], ["PARTIALLY DISPATCHED", "Partially dispatched"], ["COMPLETED", "Completed"], ["SHORT CLOSED", "Short closed"], ["CANCELLED", "Cancelled"], ["ALL", "All"]],
    active: ["OPEN", "PARTIALLY DISPATCHED"] }
};

export async function startSalesPage(kind) {
  const cfg = CFG[kind];
  const page = await initPage(cfg.nav);
  if (!page) return;
  let docs = []; let customers = []; let items = [];
  let tab = "ACTIVE";
  const canEdit = can("commercial");
  const isQ = kind === "QT";

  page.innerHTML = `${pageHeader("Sales", cfg.title, isQ ? "Prepare and send quotations; convert accepted ones into sales orders." : "Customer orders tracked until fully dispatched.",
    `<button class="btn" id="exportBtn"><i class="fa-solid fa-download"></i> Export</button>${canEdit ? `<button class="btn primary" id="newDoc"><i class="fa-solid fa-plus"></i> New ${cfg.singular}</button>` : ""}`)}
    <div class="tabs" id="tabs"></div>
    <div class="card"><div class="card-head"><div class="toolbar"><input class="input search" id="search" placeholder="Search number, customer, item…" /></div><span class="small muted" id="count"></span></div>
    <div class="table-wrap"><table class="table"><thead><tr><th>${isQ ? "Quotation" : "SO"} No.</th><th>Date</th><th>Customer</th>${isQ ? "<th>Valid until</th>" : "<th>Customer PO</th>"}<th>Items</th><th class="num">Value (₹)</th>${isQ ? "" : "<th>Dispatched</th>"}<th>Status</th><th></th></tr></thead><tbody id="rows"></tbody></table></div></div>`;

  const statusOf = (d) => (isQ && ["DRAFT", "SENT"].includes(d.status) && d.validUntil && d.validUntil < isoDate() ? "EXPIRED" : d.status);
  const inTab = (d, t) => t === "ALL" || (t === "ACTIVE" ? cfg.active.includes(d.status) : d.status === t);

  function render() {
    page.querySelector("#tabs").innerHTML = cfg.tabs.map(([k, l]) => `<button class="tab ${k === tab ? "active" : ""}" data-tab="${k}">${l}<span class="count">${docs.filter((d) => inTab(d, k)).length}</span></button>`).join("");
    const term = page.querySelector("#search").value.trim().toLowerCase();
    const list = docs.filter((d) => inTab(d, tab) && (!term || [d[cfg.noKey], d.customer?.name, d.customerPoNo, ...d.lines.map((l) => l.name)].some((v) => String(v || "").toLowerCase().includes(term))));
    page.querySelector("#count").textContent = `${list.length} ${cfg.title.toLowerCase()}`;
    const rows = page.querySelector("#rows");
    if (!list.length) { rows.innerHTML = `<tr><td class="empty" colspan="9">No ${cfg.title.toLowerCase()} here.</td></tr>`; return; }
    rows.innerHTML = list.map((d) => {
      const ordered = d.lines.reduce((s, l) => s + l.qty, 0);
      const dispatched = d.lines.reduce((s, l) => s + Math.min(l.dispatchedQty || 0, l.qty), 0);
      return `<tr><td class="strong nowrap"><a href="#" data-view="${esc(d.id)}">${esc(d[cfg.noKey])}</a>${d.revision ? ` <span class="badge gray">Rev ${d.revision}</span>` : ""}</td><td class="nowrap">${fmtDate(d.date)}</td><td>${esc(d.customer?.name)}</td>
        ${isQ ? `<td class="nowrap">${fmtDate(d.validUntil)}</td>` : `<td>${esc(d.customerPoNo || "—")}</td>`}
        <td>${d.lines.length === 1 ? `${esc(d.lines[0].name)}<div class="small muted">${qty(d.lines[0].qty)} ${esc(d.lines[0].unit)}</div>` : `${d.lines.length} items`}</td>
        <td class="num">${money(d.totals?.total)}</td>
        ${isQ ? "" : `<td>${progressBar(dispatched, ordered)}<div class="progress-label">${Math.round((dispatched / (ordered || 1)) * 100)}%</div></td>`}
        <td>${badge(statusOf(d))}</td>
        <td><div class="actions"><button class="btn sm" data-pdf="${esc(d.id)}"><i class="fa-solid fa-file-pdf"></i></button><button class="btn sm" data-view="${esc(d.id)}">Open</button></div></td></tr>`;
    }).join("");
  }

  async function load() {
    [docs, customers, items] = await Promise.all([listCollection(cfg.col, "createdAt", "desc"), listCollection("parties"), listCollection("items")]);
    render();
  }

  page.addEventListener("click", (e) => {
    const t = e.target.closest("[data-tab]"); if (t) { tab = t.dataset.tab; render(); return; }
    const v = e.target.closest("[data-view]"); if (v) { e.preventDefault(); openDetail(docs.find((d) => d.id === v.dataset.view)); return; }
    const p = e.target.closest("[data-pdf]"); if (p) { const d = docs.find((x) => x.id === p.dataset.pdf); showDocument(cfg.spec(d), `${safeFileName(d[cfg.noKey])}.pdf`); }
  });
  page.querySelector("#search").addEventListener("input", render);
  page.querySelector("#newDoc")?.addEventListener("click", () => openEditor());
  page.querySelector("#exportBtn").addEventListener("click", () => {
    const rows = docs.flatMap((d) => d.lines.map((l) => ({ [`${cfg.singular} No`]: d[cfg.noKey], Date: fmtDate(d.date), Customer: d.customer?.name, "Customer GSTIN": d.customer?.gstin || "", Item: l.name, Qty: l.qty, Unit: l.unit, Rate: l.rate, "GST %": l.gstRate, Amount: round(l.qty * l.rate, 2), ...(isQ ? { "Valid Until": fmtDate(d.validUntil) } : { "Customer PO": d.customerPoNo || "", Dispatched: l.dispatchedQty || 0, Pending: Math.max(0, round(l.qty - (l.dispatchedQty || 0))) }), Total: d.totals?.total, Status: statusOf(d) })));
    if (!rows.length) { toast("Nothing to export."); return; }
    exportExcel(rows, `CCPL_${cfg.title.replace(/ /g, "_")}_${isoDate()}.xlsx`, cfg.title);
  });

  /* ---------------- Editor ---------------- */
  function openEditor(existing = null, { fromQuotation = null, fromDraft = null } = {}) {
    if (!customers.filter((c) => c.active !== false).length) { toast("Add the customer first (Purchase → Vendors & Customers).", "error"); return; }
    const d = existing || fromQuotation || fromDraft || {};
    const editing = Boolean(existing);
    const soFromQ = !isQ && fromQuotation;
    const modal = openModal({
      title: editing ? `Edit ${d[cfg.noKey]}` : soFromQ ? `Sales Order from ${fromQuotation.quoteNo}` : `New ${cfg.singular}`,
      size: "full",
      body: `<form id="sForm" novalidate><div class="form-grid">
        ${!isQ && !editing && !soFromQ ? docTypeField("SO") : ""}
        <label class="field span-2"><span>Customer / Party <b class="req">*</b></span><select name="customerId"><option value="">Select party…</option>${customers.filter((c) => c.active !== false || c.id === d.customer?.id).sort((a, b) => a.name.localeCompare(b.name)).map((c) => partyOption(c, d.customer?.id)).join("")}</select></label>
        <label class="field"><span>Date <b class="req">*</b></span><input type="date" name="date" value="${esc(editing || fromDraft ? d.date || isoDate() : isoDate())}" /></label>
        ${isQ ? `<label class="field"><span>Valid Until</span><input type="date" name="validUntil" value="${esc(d.validUntil || addDays(isoDate(), 15))}" /></label>
          <label class="field"><span>Enquiry Ref</span><input name="enquiryRef" value="${esc(d.enquiryRef || "")}" /></label>
          <label class="field"><span>Kind Attn.</span><input name="kindAttn" value="${esc(d.kindAttn || "")}" /></label>
          <label class="field"><span>Delivery Period</span><input name="deliveryPeriod" value="${esc(d.deliveryPeriod || "Within 7 days of PO")}" /></label>`
        : `<label class="field"><span>Customer PO No.</span><input name="customerPoNo" value="${esc(d.customerPoNo || "")}" /></label>
          <label class="field"><span>Customer PO Date</span><input type="date" name="customerPoDate" value="${esc(d.customerPoDate || "")}" /></label>
          <label class="field"><span>Dispatch From</span><select name="warehouse">${warehouseOptions(d.warehouse || "")}</select></label>
          <label class="field"><span>Expected Dispatch</span><input type="date" name="expectedDate" value="${esc(d.expectedDate || addDays(isoDate(), 7))}" /></label>`}
        <label class="field"><span>Payment Terms</span><input name="paymentTerms" value="${esc(d.paymentTerms || "30 Days")}" /></label>
        <label class="field"><span>Delivery Terms</span><input name="deliveryTerms" value="${esc(d.deliveryTerms || "Ex-Works")}" /></label>
        <label class="field"><span>Place Of Supply</span><input name="placeOfSupply" value="${esc(d.placeOfSupply || "")}" /></label>
        <label class="field"><span>Tax Type</span><input name="taxType" readonly /></label>
        ${isQ ? "" : `<label class="field span-all"><span>Ship-to address (if different from billing)</span><textarea name="shipTo" rows="2">${esc((d.shipTo?.addressLines || []).join("\n"))}</textarea></label>`}
      </div>
      <div class="section-title">Items</div><div id="lines"></div>
      <div class="section-title">Notes & Terms</div>
      <div class="form-grid"><label class="field span-2"><span>Notes</span><textarea name="notes" rows="4">${esc(d.notes || "")}</textarea></label>
      <label class="field span-2"><span>Terms & Conditions (one per line)</span><textarea name="terms" rows="6">${esc(editing || soFromQ ? d.terms ?? "" : isQ ? state.company.quoteTerms : state.company.soTerms)}</textarea></label></div></form>`,
      footer: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="saveS"><i class="fa-solid fa-floppy-disk"></i> ${editing ? "Save changes" : `Create ${cfg.singular}`}</button>`
    });
    const form = modal.el.querySelector("#sForm");
    const customerOf = () => customers.find((c) => c.id === form.customerId.value);
    const intra = () => { const c = customerOf(); return !c || !c.stateCode || String(c.stateCode) === String(state.company.stateCode); };
    const editor = createLineEditor(modal.el.querySelector("#lines"), { items, lines: d.lines || [], isIntraState: intra, itemFilter: (i) => i.category !== "Packaging" || isQ });
    const syncCustomer = () => {
      const c = customerOf();
      if (c && !form.placeOfSupply.value) form.placeOfSupply.value = c.stateCode ? `${STATE_CODES[c.stateCode] || c.state || ""} (${c.stateCode})` : c.state || "";
      if (c?.paymentTermsDays && !editing) form.paymentTerms.value = `${c.paymentTermsDays} Days`;
      form.taxType.value = intra() ? "CGST + SGST (intra-state)" : "IGST (inter-state)";
      editor.refresh();
    };
    form.customerId.addEventListener("change", () => { form.placeOfSupply.value = ""; syncCustomer(); });
    syncCustomer();
    // Sales Order ⇄ Proforma Invoice: carry what was typed to the other document.
    form.docType?.addEventListener("change", () => {
      if (form.docType.value !== "PI") return;
      const v = formValues(form);
      const days = Number.parseInt(v.paymentTerms, 10);
      modal.close();
      openOtherType("PI", {
        customerId: v.customerId, date: v.date, refNo: v.customerPoNo, refDate: v.customerPoDate, placeOfSupply: v.placeOfSupply,
        warehouse: v.warehouse, shipToLines: v.shipTo ? v.shipTo.split("\n").map((x) => x.trim()).filter(Boolean) : [], notes: v.notes,
        termsDays: Number.isFinite(days) ? days : "", lines: editor.draft()
      });
    });

    modal.el.querySelector("#saveS").addEventListener("click", async (event) => {
      const v = formValues(form);
      const c = customerOf();
      let lines;
      try {
        if (!c) throw new Error("Select a customer.");
        lines = editor.value();
      } catch (error) { toast(error.message, "error"); return; }
      const totals = computeTotals(lines, intra());
      const data = {
        date: v.date, customerId: c.id,
        customer: { id: c.id, name: c.name, gstin: c.gstin || "", pan: c.pan || "", stateCode: c.stateCode || "", address1: c.address1 || "", address2: c.address2 || "", city: c.city || "", pincode: c.pincode || "", state: c.state || "", country: c.country || "India", phone: c.phone || "", email: c.email || "", contactPerson: v.kindAttn || c.contactPerson || "" },
        paymentTerms: v.paymentTerms, deliveryTerms: v.deliveryTerms, placeOfSupply: v.placeOfSupply, notes: v.notes, terms: v.terms, intraState: intra(),
        totals, updatedAt: serverTimestamp(),
        ...(isQ ? { validUntil: v.validUntil, enquiryRef: v.enquiryRef, kindAttn: v.kindAttn, deliveryPeriod: v.deliveryPeriod, lines }
          : { customerPoNo: v.customerPoNo, customerPoDate: v.customerPoDate, warehouse: v.warehouse, warehouseName: v.warehouse ? warehouseByCode(v.warehouse).name : "", expectedDate: v.expectedDate,
            shipTo: v.shipTo ? { name: c.name, addressLines: v.shipTo.split("\n").map((s) => s.trim()).filter(Boolean) } : null,
            lines: lines.map((l) => ({ ...l, dispatchedQty: 0 })) })
      };
      const done = busy(event.currentTarget);
      try {
        const saved = await runTransaction(db, async (tx) => {
          if (editing) {
            const ref = doc(db, cfg.col, d.id);
            const cur = (await tx.get(ref)).data();
            if (isQ && !["DRAFT", "SENT"].includes(cur.status)) throw new Error(`A ${cur.status.toLowerCase()} quotation cannot be edited.`);
            if (!isQ && (cur.status !== "OPEN" || cur.lines.some((l) => (l.dispatchedQty || 0) > 0))) throw new Error("This sales order already has dispatches and cannot be edited. Short-close it instead.");
            const revision = isQ && cur.status === "SENT" ? (cur.revision || 0) + 1 : cur.revision || 0;
            tx.update(ref, { ...data, revision });
            logActivity(tx, { module: cfg.module, action: "UPDATE", refId: ref.id, refNo: cur[cfg.noKey], summary: `Edited ${cur[cfg.noKey]}${revision ? ` (Rev ${revision})` : ""} · ${c.name} · ₹${money(totals.total)}` });
            return { id: ref.id, no: cur[cfg.noKey] };
          }
          const ref = doc(collection(db, cfg.col));
          let qRef = null;
          if (soFromQ) {
            qRef = doc(db, "quotations", fromQuotation.id);
            const q = (await tx.get(qRef)).data();
            if (q.status !== "ACCEPTED") throw new Error("Only an accepted quotation can be converted.");
          }
          const number = await reserveNumber(tx, kind, { date: v.date });
          commitNumber(tx, number, ref.id);
          tx.set(ref, { ...data, [cfg.noKey]: number.number, status: isQ ? "DRAFT" : "OPEN", revision: 0, ...(isQ ? {} : { quotationId: soFromQ ? fromQuotation.id : "", quoteNo: soFromQ ? fromQuotation.quoteNo : "" }), createdAt: serverTimestamp(), createdBy: { uid: state.user.uid, name: state.profile.name || state.user.email } });
          if (qRef) {
            tx.update(qRef, { status: "CONVERTED", soId: ref.id, soNo: number.number, updatedAt: serverTimestamp() });
            logActivity(tx, { module: "Quotations", action: "CONVERTED", refId: fromQuotation.id, refNo: fromQuotation.quoteNo, summary: `${fromQuotation.quoteNo} converted to ${number.number}` });
          }
          logActivity(tx, { module: cfg.module, action: "CREATE", refId: ref.id, refNo: number.number, summary: `Created ${number.number} · ${c.name} · ${lines.map((l) => `${l.name} ${qty(l.qty)} ${l.unit}`).join(", ")} · ₹${money(totals.total)}` });
          return { id: ref.id, no: number.number };
        });
        toast(`${saved.no} saved.`, "ok");
        modal.close();
        await load();
      } catch (error) { reportError(error); } finally { done(); }
    });
  }

  /* ---------------- Detail ---------------- */
  async function openDetail(d) {
    if (!d) return;
    const [logSnap, outSnap] = await Promise.all([
      getDocs(query(collection(db, "activity"), where("refId", "==", d.id))),
      isQ ? Promise.resolve(null) : getDocs(query(collection(db, "outwards"), where("soId", "==", d.id)))
    ]);
    const log = logSnap.docs.map((x) => x.data()).sort((a, b) => (b.at?.seconds || 0) - (a.at?.seconds || 0));
    const outs = outSnap ? outSnap.docs.map((x) => x.data()).sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0)) : [];
    const st = d.status;
    const buttons = [];
    if (isQ && canEdit) {
      if (["DRAFT", "SENT"].includes(st)) buttons.push('<button class="btn" data-act="edit"><i class="fa-solid fa-pen"></i> Edit</button>');
      if (st === "DRAFT") buttons.push('<button class="btn" data-act="SENT">Mark as sent</button>');
      if (["DRAFT", "SENT"].includes(st)) buttons.push('<button class="btn danger" data-act="REJECTED">Mark rejected</button>', '<button class="btn" data-act="ACCEPTED">Mark accepted</button>');
      if (st === "ACCEPTED") buttons.push('<button class="btn gold" data-act="convert"><i class="fa-solid fa-arrow-right"></i> Convert to Sales Order</button>');
    }
    if (!isQ && canEdit) {
      const untouched = st === "OPEN" && !d.lines.some((l) => (l.dispatchedQty || 0) > 0);
      if (untouched) buttons.push('<button class="btn" data-act="edit"><i class="fa-solid fa-pen"></i> Edit</button>', '<button class="btn danger" data-act="CANCELLED">Cancel SO</button>');
      if (can("close") && ["OPEN", "PARTIALLY DISPATCHED"].includes(st) && !untouched) buttons.push('<button class="btn gold" data-act="SHORT CLOSED"><i class="fa-solid fa-flag-checkered"></i> Mark complete (short close)</button>');
      if (isAdmin() && st === "SHORT CLOSED") buttons.push('<button class="btn" data-act="reopen">Reopen</button>');
      if (["OPEN", "PARTIALLY DISPATCHED"].includes(st)) buttons.push('<button class="btn" data-act="proforma"><i class="fa-solid fa-file-invoice-dollar"></i> Create Proforma Invoice</button>');
    }
    const modal = openModal({
      title: `${d[cfg.noKey]}${d.revision ? ` · Rev ${d.revision}` : ""}`,
      size: "full",
      body: `<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px">${badge(statusOf(d))}<span class="muted">${esc(d.customer?.name)} · ₹${money(d.totals?.total)}</span>${d.soNo ? `<a href="sales-orders.html">→ ${esc(d.soNo)}</a>` : ""}${d.quoteNo ? `<span class="muted">from ${esc(d.quoteNo)}</span>` : ""}</div>
        ${d.closeReason ? `<div class="notice warn" style="margin-bottom:14px">${esc(st)} by ${esc(d.closedBy?.name)} on ${fmtDateTime(d.closedAt)} — ${esc(d.closeReason)}</div>` : ""}
        <div class="table-wrap"><table class="table"><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">GST</th><th class="num">Amount</th>${isQ ? "" : '<th class="num">Dispatched</th><th class="num">Pending</th><th>Progress</th>'}</tr></thead><tbody>
        ${d.lines.map((l) => `<tr><td class="strong">${esc(l.name)}<div class="small muted">${esc(l.description || "")}</div></td><td class="num">${qty(l.qty)} ${esc(l.unit)}</td><td class="num">${money(l.rate)}</td><td class="num">${l.gstRate}%</td><td class="num">${money(l.qty * l.rate)}</td>${isQ ? "" : `<td class="num">${qty(l.dispatchedQty || 0)}</td><td class="num strong">${qty(Math.max(0, round(l.qty - (l.dispatchedQty || 0))))}</td><td>${progressBar(l.dispatchedQty || 0, l.qty)}</td>`}</tr>`).join("")}
        </tbody></table></div>
        ${isQ ? "" : `<div class="section-title">Dispatches (${outs.length})</div>${outs.length ? `<table class="table"><thead><tr><th>Challan</th><th>Date</th><th>From</th><th>Items</th><th>Invoice</th><th>Status</th></tr></thead><tbody>${outs.map((o) => `<tr><td class="strong">${esc(o.dcNo)}</td><td>${fmtDate(o.date)}</td><td>${esc(o.warehouseName)}</td><td>${o.lines.map((l) => `${esc(l.name)} ${qty(l.qty)} ${esc(l.unit)}`).join(", ")}</td><td>${esc(o.invoiceNo || "—")}</td><td>${badge(o.status)}</td></tr>`).join("")}</tbody></table>` : '<p class="muted">Nothing dispatched yet. Use <a href="outward.html">Outward / Dispatch</a>.</p>'}`}
        <div class="section-title">History</div>
        <ul class="timeline">${log.map((a) => `<li><time>${fmtDateTime(a.at)}</time><div><b>${esc(a.userName)}</b> · ${esc(a.summary)}</div></li>`).join("") || '<li class="muted">No history.</li>'}</ul>`,
      footer: `<button class="btn" data-close>Close</button>${buttons.join("")}<button class="btn primary" data-act="pdf"><i class="fa-solid fa-file-pdf"></i> View / Download PDF</button>`
    });
    modal.el.querySelector(".modal-foot").addEventListener("click", async (e) => {
      const b = e.target.closest("[data-act]"); if (!b) return;
      const act = b.dataset.act;
      if (act === "pdf") { showDocument(cfg.spec(d), `${safeFileName(d[cfg.noKey])}.pdf`); return; }
      if (act === "edit") { modal.close(); openEditor(d); return; }
      if (act === "convert") { startConvert(d); return; }
      if (act === "proforma") { sessionStorage.setItem("ccpl-pi-from-so", d.id); window.location.href = "proforma.html"; return; }
      const needsReason = ["REJECTED", "CANCELLED", "SHORT CLOSED"].includes(act);
      let reason = "";
      if (act === "reopen") { if (!(await confirmDialog(`Reopen ${d[cfg.noKey]}?`))) return; }
      else if (needsReason) {
        reason = await confirmDialog(act === "SHORT CLOSED" ? `Mark ${d[cfg.noKey]} complete? Pending quantities will be dropped and no more dispatch will be allowed.` : `Mark ${d[cfg.noKey]} as ${act.toLowerCase()}?`, { title: cfg.singular, danger: act !== "SHORT CLOSED", okText: "Confirm", input: { label: "Reason", required: true } });
        if (!reason) return;
      } else if (!(await confirmDialog(`Mark ${d[cfg.noKey]} as ${act.toLowerCase()}?`))) return;
      const done = busy(b);
      try {
        await runTransaction(db, async (tx) => {
          const ref = doc(db, cfg.col, d.id);
          const cur = (await tx.get(ref)).data();
          let status = act;
          if (act === "reopen") status = deriveOrderStatus({ ...cur, status: "OPEN" }, "dispatchedQty");
          const allowed = { SENT: ["DRAFT"], ACCEPTED: ["DRAFT", "SENT"], REJECTED: ["DRAFT", "SENT"], CANCELLED: ["OPEN"], "SHORT CLOSED": ["OPEN", "PARTIALLY DISPATCHED"], reopen: ["SHORT CLOSED"] }[act];
          if (!allowed.includes(cur.status)) throw new Error(`Cannot change status from ${cur.status}.`);
          tx.update(ref, { status, updatedAt: serverTimestamp(), ...(needsReason ? { closeReason: reason, closedAt: serverTimestamp(), closedBy: { uid: state.user.uid, name: state.profile.name || state.user.email } } : {}), ...(act === "reopen" ? { closeReason: "" } : {}) });
          logActivity(tx, { module: cfg.module, action: act === "reopen" ? "REOPEN" : act, refId: d.id, refNo: cur[cfg.noKey], summary: `${cur[cfg.noKey]} → ${status}${reason ? `. Reason: ${reason}` : ""}` });
        });
        toast("Updated.", "ok");
        modal.close();
        await load();
      } catch (error) { reportError(error); } finally { done(); }
    });
  }

  function startConvert(q) {
    sessionStorage.setItem("ccpl-convert-quotation", q.id);
    window.location.href = "sales-orders.html";
  }

  await load();
  document.body.dataset.loaded = "1";
  // Arriving from a Proforma Invoice form switched to "Sales Order"
  const draft = !isQ && canEdit ? takeDraft("SO") : null;
  if (draft) {
    openEditor(null, { fromDraft: {
      customer: { id: draft.customerId }, date: draft.date, customerPoNo: draft.refNo, customerPoDate: draft.refDate, placeOfSupply: draft.placeOfSupply,
      warehouse: draft.warehouse, shipTo: draft.shipToLines?.length ? { addressLines: draft.shipToLines } : null, notes: draft.notes,
      paymentTerms: draft.termsDays !== "" && draft.termsDays !== undefined ? `${draft.termsDays} Days` : undefined, lines: draft.lines || []
    } });
  }
  // Arriving from "Convert to Sales Order"
  if (!isQ) {
    const qid = sessionStorage.getItem("ccpl-convert-quotation");
    if (qid) {
      sessionStorage.removeItem("ccpl-convert-quotation");
      const qs = await listCollection("quotations");
      const q = qs.find((x) => x.id === qid);
      if (q) openEditor(null, { fromQuotation: { ...q, lines: q.lines.map((l) => ({ ...l })) } });
    }
  }
}
