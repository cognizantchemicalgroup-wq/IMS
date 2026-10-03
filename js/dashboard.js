import {
  db, initPage, pageHeader, esc, listCollection, money, qty, fmtDate, fmtDateTime, isoDate, round, warehouseByCode, activeWarehouses, state,
  OPEN_PO_STATUSES
} from "./core.js";
import { computeExceptions } from "./exceptions-data.js";
import { collection, getDocs, limit, orderBy, query } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const page = await initPage("dashboard");
if (page) start();

async function start() {
  const header = pageHeader("Overview", `Welcome, ${state.profile.name || state.user.email}`, new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" }));
  page.innerHTML = `${header}<div class="boot" style="min-height:30vh"><div><i class="fa-solid fa-spinner fa-spin"></i> Loading…</div></div>`;
  const [pos, receipts, sos, transfers, stock, adjustments, actSnap] = await Promise.all([
    listCollection("purchaseOrders"), listCollection("receipts"), listCollection("salesOrders"), listCollection("transfers"),
    listCollection("inventory"), listCollection("adjustments"),
    getDocs(query(collection(db, "activity"), orderBy("at", "desc"), limit(25)))
  ]);
  const activity = actSnap.docs.map((d) => d.data());
  const openPos = pos.filter((p) => OPEN_PO_STATUSES.includes(p.status));
  const grnPending = receipts.filter((r) => r.stage === "GRN PENDING");
  const kantaPending = receipts.filter((r) => r.stage === "KANTA PENDING");
  const openSos = sos.filter((s) => ["OPEN", "PARTIALLY DISPATCHED"].includes(s.status));
  const inTransit = transfers.filter((t) => t.status === "IN TRANSIT");
  const pendingPoValue = openPos.reduce((sum, p) => sum + p.lines.reduce((s, l) => s + Math.max(0, l.qty - (l.receivedQty || 0)) * l.rate, 0), 0);
  const today = isoDate();
  const pendingLines = openPos.flatMap((p) => p.lines.filter((l) => l.qty - (l.receivedQty || 0) > 0.0005).map((l) => ({ p, l, overdue: p.expectedDate && p.expectedDate < today })))
    .sort((a, b) => (a.p.expectedDate || "9").localeCompare(b.p.expectedDate || "9")).slice(0, 10);
  const exceptions = computeExceptions({ pos, receipts, adjustments, company: state.company });
  const exceptionTotal = exceptions.reduce((s, g) => s + g.rows.length, 0);

  const kpi = (icon, label, value, hint, href) => `<a class="card kpi" href="${href}" style="color:inherit"><div class="label"><i class="fa-solid ${icon}"></i>${label}</div><div class="value">${value}</div><div class="hint">${hint}</div></a>`;
  page.innerHTML = `${header}
    <div class="grid cols-4">
      ${kpi("fa-file-invoice", "Open purchase orders", openPos.length, `₹${money(pendingPoValue)} still to be inwarded`, "purchase-orders.html")}
      ${kpi("fa-scale-balanced", "Awaiting GRN / Kanta", `${grnPending.length} / ${kantaPending.length}`, "stock is added only after Kanta", "inward.html")}
      ${kpi("fa-file-contract", "Open sales orders", openSos.length, "awaiting dispatch", "sales-orders.html")}
      ${kpi("fa-triangle-exclamation", "Exceptions", exceptionTotal, exceptionTotal ? "need attention" : "all clear", "exceptions.html")}
    </div>
    <div class="card" style="margin-top:16px"><div class="card-head"><h3><i class="fa-solid fa-triangle-exclamation"></i> Needs attention</h3><a href="exceptions.html" class="small">Open Exceptions →</a></div>
      <div class="card-body" style="display:flex;flex-wrap:wrap;gap:8px">${exceptions.map((g) => `<a href="exceptions.html#${g.key}" class="badge ${g.rows.length ? g.tone : "green"}" style="font-size:12px;padding:6px 12px">${esc(g.title)}: ${g.rows.length}</a>`).join("")}</div></div>
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
      <div class="card"><div class="card-head"><h3>Transfers in transit</h3><a href="transfers.html" class="small">Transfers →</a></div>
        <div class="table-wrap"><table class="table"><thead><tr><th>Transfer</th><th>Route</th><th>Items</th></tr></thead><tbody>
        ${inTransit.map((t) => `<tr><td class="strong">${esc(t.trNo)}</td><td>${esc(warehouseByCode(t.from).name)} → ${esc(warehouseByCode(t.to).name)}</td><td class="small">${t.lines.map((l) => `${esc(l.name)} ${qty(l.qtySent)}`).join(", ")}</td></tr>`).join("") || '<tr><td class="empty" colspan="3">None in transit.</td></tr>'}
        </tbody></table></div></div>
    </div>`;
  document.body.dataset.loaded = "1";
}
