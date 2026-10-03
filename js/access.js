// Private access & process audit — visible only to the super admin (see SUPER_ADMIN_EMAIL in core.js;
// the database rules enforce the same restriction for the sessions data).
import {
  db, initPage, pageHeader, esc, toast, listCollection, fmtDateTime, isoDate, toDate, exportExcel, normalizeReceipt, qty
} from "./core.js";
import { collection, getDocs, limit, orderBy, query, where } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const page = await initPage("access", { superAdminOnly: true });
if (page) start();

function duration(from, to) {
  const a = toDate(from); const b = toDate(to);
  if (!a || !b) return "—";
  const mins = Math.max(0, Math.round((b - a) / 60000));
  if (mins < 1) return "under 1 min";
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  if (h < 48) return `${h} h ${mins % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}
const device = (ua = "") => (/Mobile|Android|iPhone/i.test(ua) ? "Mobile" : "Computer") + (/Edg\//.test(ua) ? " · Edge" : /Chrome\//.test(ua) ? " · Chrome" : /Firefox\//.test(ua) ? " · Firefox" : /Safari\//.test(ua) ? " · Safari" : "");

async function start() {
  const [sessionSnap, users, receiptsRaw, inwardLogSnap] = await Promise.all([
    getDocs(query(collection(db, "sessions"), orderBy("loginAt", "desc"), limit(1000))),
    listCollection("users"),
    listCollection("receipts", "createdAt", "desc"),
    getDocs(query(collection(db, "activity"), where("module", "==", "Inward")))
  ]);
  const sessions = sessionSnap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }));
  const receipts = receiptsRaw.map(normalizeReceipt);
  const inwardLog = inwardLogSnap.docs.map((d) => d.data()).sort((a, b) => (b.at?.seconds || 0) - (a.at?.seconds || 0));
  let tab = "users";

  page.innerHTML = `${pageHeader("Private · Super admin", "Access Audit", "Logins, sessions and who did GRN / Kanta — visible only to you.",
    '<button class="btn" id="exportBtn"><i class="fa-solid fa-download"></i> Export this tab</button>')}
    <div class="tabs" id="tabs"></div><div id="body"></div>`;
  const TABS = [["users", "Users · last active"], ["sessions", "Login sessions"], ["grnKanta", "GRN → Kanta timing"], ["edits", "GRN / Kanta changes"]];

  const userRows = () => users.map((u) => {
    const mine = sessions.filter((s) => s.uid === u.id);
    const last = mine[0];
    const lastActive = mine.reduce((m, s) => Math.max(m, toDate(s.lastActiveAt)?.getTime() || 0), 0);
    const online = last && !last.logoutAt && lastActive && Date.now() - lastActive < 10 * 60 * 1000;
    return { u, last, lastActive, online, count30: mine.filter((s) => (toDate(s.loginAt)?.getTime() || 0) > Date.now() - 30 * 86400000).length };
  }).sort((a, b) => b.lastActive - a.lastActive);

  const timing = () => receipts.filter((r) => r.grn).map((r) => ({
    r, grnAt: r.grn?.at, kantaAt: r.kanta?.at,
    waitMin: r.kanta ? Math.round(((toDate(r.kanta.at) || 0) - (toDate(r.grn.at) || 0)) / 60000) : Math.round((Date.now() - (toDate(r.grn.at)?.getTime() || Date.now())) / 60000)
  }));

  function render() {
    page.querySelector("#tabs").innerHTML = TABS.map(([k, l]) => `<button class="tab ${k === tab ? "active" : ""}" data-tab="${k}">${l}</button>`).join("");
    const body = page.querySelector("#body");
    if (tab === "users") {
      body.innerHTML = `<div class="card"><div class="table-wrap"><table class="table"><thead><tr><th>User</th><th>Role</th><th>Status</th><th>Last login</th><th>Last active</th><th>Last logout</th><th class="num">Logins (30 days)</th></tr></thead><tbody>
        ${userRows().map(({ u, last, lastActive, online, count30 }) => `<tr><td class="strong">${esc(u.name)}<div class="small muted">${esc(u.email)}</div></td><td>${esc(u.role)}</td><td>${online ? '<span class="badge green">Online now</span>' : u.active ? '<span class="badge gray">Offline</span>' : '<span class="badge red">Deactivated</span>'}</td>
          <td class="nowrap">${last ? fmtDateTime(last.loginAt) : "Never"}</td><td class="nowrap">${lastActive ? fmtDateTime(new Date(lastActive)) : "—"}</td><td class="nowrap">${last?.logoutAt ? `${fmtDateTime(last.logoutAt)} <span class="small muted">(${esc(last.endReason)})</span>` : "—"}</td><td class="num">${count30}</td></tr>`).join("")}
        </tbody></table></div></div>`;
    } else if (tab === "sessions") {
      body.innerHTML = `<div class="card"><div class="table-wrap"><table class="table"><thead><tr><th>User</th><th>Login</th><th>Last active</th><th>Logout</th><th>Ended by</th><th>Duration</th><th>Device</th></tr></thead><tbody>
        ${sessions.map((s) => `<tr><td class="strong">${esc(s.userName)}<div class="small muted">${esc(s.email)}</div></td><td class="nowrap mono">${fmtDateTime(s.loginAt)}${s.resumed ? ' <span class="badge gray">remembered</span>' : ""}</td><td class="nowrap mono">${fmtDateTime(s.lastActiveAt)}</td><td class="nowrap mono">${s.logoutAt ? fmtDateTime(s.logoutAt) : "—"}</td>
          <td>${s.logoutAt ? esc(s.endReason === "idle" ? "Auto (60 min idle)" : "Sign out") : "Still signed in / closed browser"}</td><td>${duration(s.loginAt, s.logoutAt || s.lastActiveAt)}</td><td class="small">${esc(device(s.userAgent))}</td></tr>`).join("") || '<tr><td class="empty" colspan="7">No sessions recorded yet.</td></tr>'}
        </tbody></table></div></div>`;
    } else if (tab === "grnKanta") {
      const rows = timing();
      const done = rows.filter((x) => x.r.kanta && x.r.stage !== "REJECTED");
      const waiting = rows.filter((x) => !x.r.kanta && x.r.stage === "KANTA PENDING");
      const avg = done.length ? Math.round(done.reduce((s, x) => s + x.waitMin, 0) / done.length) : 0;
      body.innerHTML = `<div class="grid cols-4" style="margin-bottom:16px"><div class="card kpi"><div class="label">Average GRN → Kanta</div><div class="value">${done.length ? duration(new Date(0), new Date(avg * 60000)) : "—"}</div><div class="hint">${done.length} completed</div></div>
        <div class="card kpi"><div class="label">Waiting for Kanta now</div><div class="value">${waiting.length}</div></div></div>
        <div class="card"><div class="table-wrap"><table class="table"><thead><tr><th>Receipt / GRN</th><th>PO</th><th>Items</th><th>Invoice entered by</th><th>GRN by · at</th><th>Kanta by · at</th><th>GRN → Kanta</th></tr></thead><tbody>
        ${rows.map(({ r, waitMin }) => `<tr><td class="strong nowrap">${esc(r.geNo)}<div class="small muted">${esc(r.grn?.grnNo)}</div></td><td class="nowrap">${esc(r.poNo || "—")}</td><td class="small">${r.lines.map((l) => `${esc(l.name)} ${qty(l.grnQty)}${l.kantaQty !== undefined ? `→${qty(l.kantaQty)}` : ""} ${esc(l.unit)}`).join("<br>")}</td>
          <td class="small">${esc(r.createdBy?.name)}<div class="muted">${fmtDateTime(r.createdAt)}</div></td><td class="small">${esc(r.grn?.by?.name)}<div class="muted">${fmtDateTime(r.grn?.at)}</div></td>
          <td class="small">${r.kanta ? `${esc(r.kanta.by?.name)}<div class="muted">${fmtDateTime(r.kanta.at)}</div>` : r.stage === "REJECTED" ? "—" : r.stage === "CANCELLED" ? "—" : '<span class="badge amber">Pending</span>'}${r.stage === "REJECTED" ? `<div><span class="badge red">Vehicle rejected</span> <span class="muted">${esc(r.rejection?.by?.name || "")} · ${fmtDateTime(r.rejection?.at)}</span></div>` : ""}</td>
          <td class="nowrap strong" style="color:${waitMin > 24 * 60 && r.stage === "KANTA PENDING" ? "var(--danger)" : "inherit"}">${r.kanta ? duration(r.grn.at, r.kanta.at) : r.stage === "KANTA PENDING" ? `${duration(r.grn.at, new Date())} so far` : "—"}</td></tr>`).join("") || '<tr><td class="empty" colspan="7">No GRNs yet.</td></tr>'}
        </tbody></table></div></div>`;
    } else {
      body.innerHTML = `<div class="card"><div class="table-wrap"><table class="table"><thead><tr><th>Date & time</th><th>User</th><th>Action</th><th>Reference</th><th>Details</th></tr></thead><tbody>
        ${inwardLog.map((a) => `<tr><td class="nowrap mono">${fmtDateTime(a.at)}</td><td class="nowrap">${esc(a.userName)}</td><td><span class="badge indigo">${esc(a.action)}</span></td><td class="nowrap strong">${esc(a.refNo)}</td><td>${esc(a.summary)}</td></tr>`).join("") || '<tr><td class="empty" colspan="5">No inward activity yet.</td></tr>'}
        </tbody></table></div></div>`;
    }
  }

  page.addEventListener("click", (e) => { const t = e.target.closest("[data-tab]"); if (t) { tab = t.dataset.tab; render(); } });
  page.querySelector("#exportBtn").addEventListener("click", () => {
    let rows = [];
    if (tab === "users") rows = userRows().map(({ u, last, lastActive, count30 }) => ({ User: u.name, Email: u.email, Role: u.role, Active: u.active ? "Yes" : "No", "Last Login": last ? fmtDateTime(last.loginAt) : "", "Last Active": lastActive ? fmtDateTime(new Date(lastActive)) : "", "Last Logout": last?.logoutAt ? fmtDateTime(last.logoutAt) : "", "Logins (30 days)": count30 }));
    if (tab === "sessions") rows = sessions.map((s) => ({ User: s.userName, Email: s.email, Login: fmtDateTime(s.loginAt), "Last Active": fmtDateTime(s.lastActiveAt), Logout: s.logoutAt ? fmtDateTime(s.logoutAt) : "", "Ended By": s.endReason || "", Duration: duration(s.loginAt, s.logoutAt || s.lastActiveAt), Device: device(s.userAgent) }));
    if (tab === "grnKanta") rows = timing().map(({ r }) => ({ Receipt: r.geNo, GRN: r.grn?.grnNo, PO: r.poNo, "Invoice By": r.createdBy?.name, "Invoice At": fmtDateTime(r.createdAt), "GRN By": r.grn?.by?.name, "GRN At": fmtDateTime(r.grn?.at), "Kanta By": r.kanta?.by?.name || "", "Kanta At": r.kanta ? fmtDateTime(r.kanta.at) : "", "GRN to Kanta": r.kanta ? duration(r.grn.at, r.kanta.at) : r.stage === "KANTA PENDING" ? "Pending" : "", "Vehicle Rejected": r.stage === "REJECTED" ? `${r.rejection?.by?.name || ""} ${fmtDateTime(r.rejection?.at)} — ${r.rejection?.reason || ""}` : "" }));
    if (tab === "edits") rows = inwardLog.map((a) => ({ "Date & Time": fmtDateTime(a.at), User: a.userName, Action: a.action, Reference: a.refNo, Details: a.summary }));
    if (!rows.length) { toast("Nothing to export."); return; }
    exportExcel(rows, `CCPL_Access_${tab}_${isoDate()}.xlsx`, tab);
  });
  render();
  document.body.dataset.loaded = "1";
}
