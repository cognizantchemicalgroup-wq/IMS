import { auth, storage } from "./firebase-config.js";
import { esc, toast } from "./core.js";
import { ref, uploadBytes } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED = /^(application\/pdf|image\/(jpeg|png)|application\/(msword|vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet)|vnd\.ms-excel))$/;

/**
 * Upload a map of { key: File | File[] } under CCPL-IMS/<folder>/.
 * Returns { key: [{name,path}] } with only the keys that had files.
 * Files are private: no public download link is created or stored. They are opened through api/file.php,
 * which checks the signed-in user's token and active profile on every request.
 */
export async function uploadFiles(folder, fileMap) {
  const result = {};
  for (const [key, value] of Object.entries(fileMap)) {
    const files = (Array.isArray(value) ? value : [value]).filter(Boolean);
    for (const file of files) {
      if (!ALLOWED.test(file.type)) throw new Error(`${file.name}: only PDF, JPG, PNG, Word or Excel files are allowed.`);
      if (file.size > MAX_BYTES) throw new Error(`${file.name} is larger than 10 MB.`);
      const safe = file.name.replace(/[^A-Za-z0-9._-]+/g, "_");
      const path = `CCPL-IMS/${folder}/${Date.now()}_${key}_${safe}`;
      await uploadBytes(ref(storage, path), file, { contentType: file.type });
      (result[key] ||= []).push({ name: file.name, path });
    }
  }
  return result;
}

/** Storage path of an attachment; older records kept a download URL, whose path is recovered from it. */
function pathOf(d) {
  if (d?.path) return d.path;
  const m = /\/o\/([^?]+)/.exec(d?.url || "");
  return m ? decodeURIComponent(m[1]) : "";
}

/** Opens a private file (attachment or backup) after checking the user's sign-in on the server. */
export async function openPrivateFile(path, { download = false, name = "" } = {}) {
  const win = download ? null : window.open("", "_blank");
  try {
    const user = auth.currentUser;
    if (!user) throw new Error("Sign in again to open this file.");
    const res = await fetch(`api/file.php?path=${encodeURIComponent(path)}`, { headers: { Authorization: `Bearer ${await user.getIdToken()}` }, cache: "no-store" });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Could not open the file (${res.status}).`);
    const url = URL.createObjectURL(await res.blob());
    if (win) { win.opener = null; win.location.href = url; } else {
      const a = document.createElement("a");
      a.href = url; a.download = name || path.split("/").pop(); document.body.append(a); a.click(); a.remove();
    }
    setTimeout(() => URL.revokeObjectURL(url), 5 * 60 * 1000);
  } catch (error) {
    win?.close();
    toast(error.message, "error");
  }
}

document.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-file]");
  if (!link) return;
  event.preventDefault();
  openPrivateFile(link.dataset.file);
});

const LABELS = { invoice: "Invoice", coa: "COA", other: "Doc", kantaSlip: "Kanta slip", attachment: "Attachment" };
export function docLinks(docs) {
  const links = Object.entries(docs || {}).flatMap(([key, list]) => (list || []).map((d, i) => {
    const path = pathOf(d);
    return path ? `<a href="#" data-file="${esc(path)}" title="${esc(d.name || "")}">${esc(LABELS[key] || key)}${list.length > 1 ? ` ${i + 1}` : ""}</a>` : "";
  }).filter(Boolean));
  return links.length ? links.join(" · ") : '<span class="muted">—</span>';
}
