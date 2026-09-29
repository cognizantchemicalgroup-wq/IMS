import { storage } from "./firebase-config.js";
import { esc } from "./core.js";
import { ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED = /^(application\/pdf|image\/(jpeg|png)|application\/(msword|vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet)|vnd\.ms-excel))$/;

/**
 * Upload a map of { key: File | File[] } under CCPL-IMS/<folder>/.
 * Returns { key: [{name,url}] } with only the keys that had files.
 */
export async function uploadFiles(folder, fileMap) {
  const result = {};
  for (const [key, value] of Object.entries(fileMap)) {
    const files = (Array.isArray(value) ? value : [value]).filter(Boolean);
    for (const file of files) {
      if (!ALLOWED.test(file.type)) throw new Error(`${file.name}: only PDF, JPG, PNG, Word or Excel files are allowed.`);
      if (file.size > MAX_BYTES) throw new Error(`${file.name} is larger than 10 MB.`);
      const safe = file.name.replace(/[^A-Za-z0-9._-]+/g, "_");
      const fileRef = ref(storage, `CCPL-IMS/${folder}/${Date.now()}_${key}_${safe}`);
      await uploadBytes(fileRef, file, { contentType: file.type });
      (result[key] ||= []).push({ name: file.name, url: await getDownloadURL(fileRef) });
    }
  }
  return result;
}

const LABELS = { invoice: "Invoice", coa: "COA", other: "Doc", kantaSlip: "Kanta slip", attachment: "Attachment" };
export function docLinks(docs) {
  const links = Object.entries(docs || {}).flatMap(([key, list]) => (list || []).map((d, i) => `<a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(LABELS[key] || key)}${list.length > 1 ? ` ${i + 1}` : ""}</a>`));
  return links.length ? links.join(" · ") : '<span class="muted">—</span>';
}
