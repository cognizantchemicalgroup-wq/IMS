// Daily log: every action in the ERP, to the second, with who did it. Read-only (cannot be edited or deleted).
import { db, initPage, pageHeader, esc, toast, fmtDateTime, isoDate, exportExcel } from "./core.js";
import { collection, getDocs, orderBy, query, where, Timestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const page = await initPage("activity");
if (page) start();

async function start() {
  let rows = [];
  page.innerHTML = `${pageHeader("Admin", "Activity Log", "Every action, by whom, to the second. This log cannot be edited or deleted by anyone.",
    '<button class="btn" id="exportBtn"><i class="fa-solid fa-download"></i> Export</button>')}
    <div class="card"><div class="card-head"><div class="toolbar">
      <label class="field"><span>From</span><input class="input" type="date" id="from" value="${isoDate()}" /></label>
      <label class="field"><span>To</span><input class="input" type="date" id="to" value="${isoDate()}" /></label>
      <label class="field"><span>User</span><select class="input" id="user"><option value="">All users</option></select></label>
      <label class="field"><span>Module</span><select class="input" id="module"><option value="">All modules</option></select></label>
      <label class="field" style="flex:1"><span>Search</span><input class="input search" id="search" placeholder="PO no, item, text…" /></label>
    </div><span class="small muted" id="count"></span></div>
    <div class="table-wrap"><table class="table"><thead><tr><th>Date & time</th><th>User</th><th>Module</th><th>Action</th><th>Reference</th><th>Details</th></tr></thead><tbody id="rows"></tbody></table></div></div>`;
  const $ = (s) => page.querySelector(s);

  async function load() {
    const from = $("#from").value || isoDate();
    const to = $("#to").value || from;
    const start = Timestamp.fromDate(new Date(`${from}T00:00:00`));
    const end = Timestamp.fromDate(new Date(`${to}T23:59:59.999`));
    const snap = await getDocs(query(collection(db, "activity"), where("at", ">=", start), where("at", "<=", end), orderBy("at", "desc")));
    rows = snap.docs.map((d) => d.data());
    const fill = (sel, values) => { const cur = sel.value; sel.innerHTML = sel.options[0].outerHTML + [...new Set(values)].sort().map((v) => `<option ${v === cur ? "selected" : ""}>${esc(v)}</option>`).join(""); };
    fill($("#user"), rows.map((r) => r.userName));
    fill($("#module"), rows.map((r) => r.module));
    render();
  }
  const filtered = () => {
    const u = $("#user").value; const m = $("#module").value; const t = $("#search").value.trim().toLowerCase();
    return rows.filter((r) => (!u || r.userName === u) && (!m || r.module === m) && (!t || `${r.summary} ${r.refNo} ${r.action}`.toLowerCase().includes(t)));
  };
  function render() {
    const list = filtered();
    $("#count").textContent = `${list.length} events`;
    $("#rows").innerHTML = list.map((r) => `<tr><td class="nowrap mono">${fmtDateTime(r.at)}</td><td class="nowrap">${esc(r.userName)}<div class="small muted">${esc(r.email)}</div></td><td>${esc(r.module)}</td><td><span class="badge indigo">${esc(r.action)}</span></td><td class="nowrap strong">${esc(r.refNo)}</td><td>${esc(r.summary)}</td></tr>`).join("") || '<tr><td class="empty" colspan="6">No activity in this period.</td></tr>';
  }
  $("#from").addEventListener("change", load);
  $("#to").addEventListener("change", load);
  ["#user", "#module"].forEach((s) => $(s).addEventListener("change", render));
  $("#search").addEventListener("input", render);
  $("#exportBtn").addEventListener("click", () => {
    const list = filtered();
    if (!list.length) { toast("Nothing to export."); return; }
    exportExcel(list.map((r) => ({ "Date & Time": fmtDateTime(r.at), User: r.userName, Email: r.email, Module: r.module, Action: r.action, Reference: r.refNo, Details: r.summary })), `CCPL_Activity_${$("#from").value}_to_${$("#to").value}.xlsx`, "Activity");
  });
  await load();
}
