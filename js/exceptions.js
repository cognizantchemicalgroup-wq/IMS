// Exceptions: only the things that need attention today.
import { initPage, pageHeader, esc, state, listCollection, exportExcel, isoDate, toast } from "./core.js";
import { computeExceptions } from "./exceptions-data.js";

const page = await initPage("exceptions");
if (page) start();

async function start() {
  const [pos, receipts, adjustments] = await Promise.all([listCollection("purchaseOrders"), listCollection("receipts"), listCollection("adjustments")]);
  const groups = computeExceptions({ pos, receipts, adjustments, company: state.company });
  const total = groups.reduce((s, g) => s + g.rows.length, 0);
  page.innerHTML = `${pageHeader("Overview", "Exceptions", total ? `${total} item${total === 1 ? "" : "s"} need attention.` : "Nothing needs attention right now.",
    '<button class="btn" id="exportBtn"><i class="fa-solid fa-download"></i> Export</button>')}
    <div class="grid cols-4" style="margin-bottom:16px">${groups.map((g) => `<a class="card kpi" href="#${g.key}" style="color:inherit"><div class="label"><i class="fa-solid ${g.icon}"></i>${esc(g.title)}</div><div class="value" style="color:${g.rows.length ? `var(--${g.tone === "red" ? "danger" : g.tone === "amber" ? "warning" : "brand"})` : "var(--success)"}">${g.rows.length}</div></a>`).join("")}</div>
    ${groups.filter((g) => g.rows.length).map((g) => `<div class="card" id="${g.key}"><div class="card-head"><h3><i class="fa-solid ${g.icon}"></i> ${esc(g.title)} <span class="badge ${g.tone}">${g.rows.length}</span></h3><span class="small muted">${esc(g.help)}</span></div>
      <div class="table-wrap"><table class="table"><thead><tr><th>Reference</th><th>Details</th><th>Info</th><th class="num">Days</th></tr></thead><tbody>
      ${g.rows.map((r) => `<tr><td class="strong nowrap"><a href="${esc(r.href)}">${esc(r.ref)}</a></td><td>${esc(r.text)}</td><td class="small muted">${esc(r.meta)}</td><td class="num">${r.days}</td></tr>`).join("")}
      </tbody></table></div></div>`).join("") || '<div class="notice ok"><i class="fa-solid fa-circle-check"></i><div>All clear — no exceptions.</div></div>'}`;
  page.querySelector("#exportBtn").addEventListener("click", () => {
    const rows = groups.flatMap((g) => g.rows.map((r) => ({ Exception: g.title, Reference: r.ref, Details: r.text, Info: r.meta, Days: r.days })));
    if (!rows.length) { toast("Nothing to export."); return; }
    exportExcel(rows, `CCPL_Exceptions_${isoDate()}.xlsx`, "Exceptions");
  });
  document.body.dataset.loaded = "1";
}
