import {
  db, initPage, pageHeader, esc, listCollection, money, qty, fmtDate, fmtDateTime, isoDate, round, badge, warehouseByCode, activeWarehouses, state
} from "./core.js";
import { collection, getDocs, limit, orderBy, query } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const page = await initPage("dashboard");
if (page) start();

async function start() {
  page.innerHTML = `${pageHeader("Overview", `Welcome, ${state.profile.name || state.user.email}`, new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" }))}
    <div class="boot" style="min-height:30vh"><div><i class="fa-solid fa-spinner fa-spin"></i> Loading…</div></div>`;
  const [pos, receipts, sos, transfers, stock, items, actSnap] = await Promise.all([
    listCollection("purchaseOrders"), listCollection("receipts"), listCollection("salesOrders"), listCollection("transfers"),
    listCollection("inventory"), listCollection("items"),
    getDocs(query(collection(db, "activity"), orderBy("at", "desc"), limit(25)))
  ]);
  const activity = actSnap.docs.map((d) => d.data());
  const openPos = pos.filter((p) => ["OPEN", "PARTIALLY RECEIVED"].includes(p.status));
  const kantaPending = receipts.filter((r) => r.stage === "KANTA PENDING");
  const grnPending = receipts.filter((r) => r.stage === "GRN PENDING");
  const openSos = sos.filter((s) => ["OPEN", "PARTIALLY DISPATCHED"].includes(s.status));
  const inTransit = transfers.filter((t) => t.status === "IN TRANSIT");
  const pendingPoValue = openPos.reduce((sum, p) => sum + p.lines.reduce((s, l) => s + Math.max(0, l.qty - (l.receivedQty || 0)) * l.rate, 0), 0);
  const today = isoDate();
  const pendingLines = openPos.flatMap((p) => p.lines.filter((l) => l.qty - (l.receivedQty || 0) > 0.0005).map((l) => ({ p, l, overdue: p.expectedDate && p.expectedDate < today })))
    .sort((a, b) => (a.p.expectedDate || "9").localeCompare(b.p.expectedDate || "9")).slice(0, 10);
  const totals = new Map();
  stock.forEach((s) => totals.set(s.itemId, (totals.get(s.itemId) || 0) + Number(s.qty || 0)));
  const low = items.filter((i) => i.reorderLevel && (totals.get(i.id) || 0) < i.reorderLevel);

  const kpi = (icon, label, value, hint, href) => `<a class="card kpi" href="${href}" style="color:inherit"><div class="label"><i class="fa-solid ${icon}"></i>${label}</div><div class="value">${value}</div><div class="hint">${hint}</div></a>`;
  page.innerHTML = `${pageHeader("Overview", `Welcome, ${state.profile.name || state.user.email}`, new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" }))}
    <div class="grid cols-4">
      ${kpi("fa-file-invoice", "Open purchase orders", openPos.length, `₹${money(pendingPoValue)} still to be received`, "purchase-orders.html")}
      ${kpi("fa-scale-balanced", "Awaiting Kanta / GRN", `${kantaPending.length} / ${grnPending.length}`, "gate entries in process", "inward.html")}
      ${kpi("fa-file-contract", "Open sales orders", openSos.length, "awaiting dispatch", "sales-orders.html")}
      ${kpi("fa-right-left", "Transfers in transit", inTransit.length, inTransit.map((t) => `${warehouseByCode(t.from).name}→${warehouseByCode(t.to).name}`).slice(0, 2).join(", ") || "none", "transfers.html")}
    </div>
    <div class="grid cols-2" style="margin-top:16px">
      <div class="card"><div class="card-head"><h3>Material pending against POs</h3><a href="purchase-orders.html" class="small">All POs →</a></div>
        <div class="table-wrap"><table class="table"><thead><tr><th>PO</th><th>Vendor</th><th>Item</th><th class="num">Pending</th><th>Expected</th></tr></thead><tbody>
        ${pendingLines.map(({ p, l, overdue }) => `<tr><td class="nowrap"><a href="purchase-orders.html?open=${esc(p.id)}">${esc(p.poNo)}</a></td><td>${esc(p.vendor?.name)}</td><td>${esc(l.name)}</td><td class="num strong">${qty(round(l.qty - (l.receivedQty || 0)))} ${esc(l.unit)}</td><td class="nowrap">${overdue ? `<span class="badge red">${fmtDate(p.expectedDate)}</span>` : fmtDate(p.expectedDate)}</td></tr>`).join("") || '<tr><td class="empty" colspan="5">Nothing pending.</td></tr>'}
        </tbody></table></div></div>
      <div class="card"><div class="card-head"><h3>Recent activity</h3><a href="activity.html" class="small">Full log →</a></div>
        <div class="card-body" style="max-height:420px;overflow:auto"><ul class="timeline">${activity.map((a) => `<li><time>${fmtDateTime(a.at)}</time><div><b>${esc(a.userName)}</b> <span class="badge gray">${esc(a.module)}</span><div class="small">${esc(a.summary)}</div></div></li>`).join("") || '<li class="muted">No activity yet.</li>'}</ul></div></div>
    </div>
    <div class="grid cols-2" style="margin-top:16px">
      <div class="card"><div class="card-head"><h3>Stock by warehouse</h3><a href="inventory.html" class="small">Stock →</a></div>
        <div class="table-wrap"><table class="table"><thead><tr><th>Warehouse</th><th class="num">Materials</th><th class="num">Packaging types</th></tr></thead><tbody>
        ${activeWarehouses().map((w) => { const rows = stock.filter((s) => s.warehouse === w.code && s.qty > 0); const pk = rows.filter((s) => s.category === "Packaging").length; return `<tr><td class="strong">${esc(w.name)}</td><td class="num">${rows.length - pk}</td><td class="num">${pk}</td></tr>`; }).join("")}
        </tbody></table></div></div>
      <div class="card"><div class="card-head"><h3>Alerts</h3></div><div class="card-body">
        ${low.length ? low.map((i) => `<div class="notice warn" style="margin-bottom:8px"><i class="fa-solid fa-triangle-exclamation"></i><div><b>${esc(i.name)}</b> is below reorder level: ${qty(totals.get(i.id) || 0)} / ${qty(i.reorderLevel)} ${esc(i.unit)}</div></div>`).join("") : ""}
        ${grnPending.length ? `<div class="notice info" style="margin-bottom:8px"><i class="fa-solid fa-circle-info"></i><div>${grnPending.length} entr${grnPending.length === 1 ? "y is" : "ies are"} waiting for GRN — stock is not updated until GRN is finalized.</div></div>` : ""}
        ${receipts.filter((r) => (r.shortageQty || 0) > 0 && r.stage !== "CANCELLED").slice(0, 5).map((r) => `<div class="notice error" style="margin-bottom:8px"><i class="fa-solid fa-scale-unbalanced"></i><div>Kanta shortage on ${esc(r.geNo)} (${esc(r.poNo || "no PO")}): invoice ${qty(r.invoiceQty)}, actual ${qty(r.kanta?.receivedQty)} ${esc(r.item?.unit)} · ${esc(r.vendor?.name)}</div></div>`).join("")}
        ${!low.length && !grnPending.length ? '<p class="muted">No alerts.</p>' : ""}
        ${openSos.length ? `<p class="small muted">Open SOs: ${openSos.slice(0, 5).map((s) => `${esc(s.soNo)} ${badge(s.status)}`).join(" ")}</p>` : ""}
      </div></div>
    </div>`;
}
