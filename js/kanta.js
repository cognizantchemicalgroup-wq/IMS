import { db, storage } from "./firebase-config.js";
import {
  collection,
  doc,
  deleteDoc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  where,
  writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  deleteObject,
  getDownloadURL,
  ref,
  uploadBytes
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

const sidebar = document.getElementById("sidebar");
const overlay = document.getElementById("mobileOverlay");
const mobileToggle = document.getElementById("mobileMenuToggle");
const kantaTableBody = document.getElementById("kantaTableBody");
const kantaCount = document.getElementById("kantaCount");
const kantaMessage = document.getElementById("kantaMessage");
const kantaSearchBy = document.getElementById("kantaSearchBy");
const kantaSearchInput = document.getElementById("kantaSearchInput");
const kantaSearchFieldLabel = document.getElementById("kantaSearchFieldLabel");
const kantaSearchFieldWrap = document.getElementById("kantaSearchFieldWrap");
const kantaFromDate = document.getElementById("kantaFromDate");
const kantaToDate = document.getElementById("kantaToDate");
const kantaFromDateWrap = document.getElementById("kantaFromDateWrap");
const kantaToDateWrap = document.getElementById("kantaToDateWrap");
const kantaSearchButton = document.getElementById("kantaSearchButton");
const kantaDrawer = document.getElementById("kantaDrawer");
const kantaDrawerBody = document.getElementById("kantaDrawerBody");
const drawerBackdrop = document.getElementById("drawerBackdrop");
const closeKantaDrawer = document.getElementById("closeKantaDrawer");

let pendingEntries = [];

function filterValue(record, keyOptions) {
  return String(valueOf(record, ...keyOptions) || "").trim();
}

function matchesDateRange(record, fromDate, toDate) {
  const date = dateOf(record);
  if (!date) return false;
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  if (fromDate && localDate < fromDate) return false;
  if (toDate && localDate > toDate) return false;
  return true;
}

function getSearchSuggestions(entries, keyOptions) {
  return [...new Set(entries.map((entry) => filterValue(entry, keyOptions)).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function updateKantaSearchUI() {
  const searchBy = kantaSearchBy.value;
  const isDateSearch = searchBy === "date";
  kantaSearchFieldWrap.classList.toggle("hidden", isDateSearch);
  kantaFromDateWrap.classList.toggle("hidden", !isDateSearch);
  kantaToDateWrap.classList.toggle("hidden", !isDateSearch);
  kantaSearchInput.disabled = isDateSearch;

  const fieldMap = {
    product: ["product", "product_name"],
    supplier: ["supplier", "supplier_name"],
    receivingLocation: ["receivingLocation", "receiving_location", "location"]
  };

  if (fieldMap[searchBy]) {
    const suggestions = getSearchSuggestions(pendingEntries, fieldMap[searchBy]);
    const suggestionsList = document.getElementById("kantaSearchSuggestions");
    suggestionsList.innerHTML = suggestions.map((value) => `<option value="${escapeHTML(value)}"></option>`).join("");
    kantaSearchFieldLabel.textContent = searchBy === "product" ? "Product" : searchBy === "supplier" ? "Supplier" : "Receiving Location";
    kantaSearchInput.placeholder = `Enter ${kantaSearchFieldLabel.textContent.toLowerCase()}`;
  } else {
    document.getElementById("kantaSearchSuggestions").innerHTML = "";
    kantaSearchFieldLabel.textContent = "Search Entry";
    kantaSearchInput.placeholder = "Enter search value";
  }

  if (isDateSearch) {
    kantaSearchInput.value = "";
  }
}

function matchesSearch(entry, searchBy, searchValue, fromDate, toDate) {
  if (!searchBy) return true;

  if (searchBy === "date") {
    return matchesDateRange(entry, fromDate, toDate);
  }

  const fieldMap = {
    product: ["product", "product_name"],
    supplier: ["supplier", "supplier_name"],
    receivingLocation: ["receivingLocation", "receiving_location", "location"]
  };

  const targetValue = String(filterValue(entry, fieldMap[searchBy] || []) || "").trim().toLowerCase();
  return !searchValue || targetValue.includes(searchValue.toLowerCase());
}

function escapeHTML(value) {
  return String(value ?? "—")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function valueOf(record, ...keys) {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null && record[key] !== "") return record[key];
  }
  return "";
}

function dateOf(record) {
  const value = valueOf(record, "createdAt", "created_at", "timestamp", "date");
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateText(record) {
  const date = dateOf(record);
  return date ? date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—";
}

function openKantaDrawer() {
  kantaDrawer.classList.add("open");
  drawerBackdrop.classList.add("show");
}

function closeKantaDrawerPanel() {
  kantaDrawer.classList.remove("open");
  drawerBackdrop.classList.remove("show");
  kantaDrawerBody.innerHTML = "";
}

function documentLink(url) {
  return url
    ? `<a class="row-action" href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">View</a>`
    : `<span class="document-unavailable">Document not available</span>`;
}

function storageRefFromUrl(url) {
  if (!url || typeof url !== "string") return null;
  try {
    const decoded = decodeURIComponent(url);
    const match = decoded.match(/\/o\/(.+?)(\?.*)?$/);
    if (!match) return null;
    return ref(storage, decodeURIComponent(match[1]));
  } catch (error) {
    console.warn("Unable to resolve storage reference from URL.", error);
    return null;
  }
}

function deleteEntryWithFiles(entry) {
  const fileUrls = [
    entry.kantaSlipUrl,
    entry.coaFileUrl,
    entry.coa_file_url,
    entry.invoiceFileUrl,
    entry.invoice_file_url,
    entry.poFileUrl,
    entry.po_file_url
  ].filter(Boolean);

  const uniqueUrls = [...new Set(fileUrls)];
  const deleteFileTasks = uniqueUrls
    .map((url) => {
      const fileRef = storageRefFromUrl(url);
      return fileRef ? deleteObject(fileRef).catch(() => undefined) : Promise.resolve();
    });

  const firestoreDeletes = [
    deleteDoc(doc(db, "inward", entry.id)).catch(() => undefined),
    deleteDoc(doc(db, "kanta", entry.id)).catch(() => undefined)
  ];

  return Promise.all([
    ...deleteFileTasks,
    ...firestoreDeletes,
    ...getDocs(query(collection(db, "grn"), where("inwardId", "==", entry.id)))
      .then((snapshot) => snapshot.docs.map((docItem) => deleteDoc(doc(db, "grn", docItem.id)).catch(() => undefined)))
      .catch(() => [])
  ]).then(() => undefined);
}

function renderRows() {
  const searchBy = kantaSearchBy.value;
  const searchValue = kantaSearchInput.value.trim();
  const fromDate = kantaFromDate.value;
  const toDate = kantaToDate.value;

  const filteredEntries = pendingEntries.filter((entry) => matchesSearch(entry, searchBy, searchValue, fromDate, toDate));
  kantaCount.textContent = `${filteredEntries.length} record${filteredEntries.length === 1 ? "" : "s"}`;

  if (!filteredEntries.length) {
    kantaTableBody.innerHTML = `<tr><td class="empty-row" colspan="11">No records found</td></tr>`;
    return;
  }

  kantaTableBody.innerHTML = filteredEntries.map((entry) => `
    <tr>
      <td>${escapeHTML(dateText(entry))}</td>
      <td>${escapeHTML(valueOf(entry, "invoiceChallanNo", "invoice_challan_no", "invoice_no", "challan_no"))}</td>
      <td>${escapeHTML(valueOf(entry, "purchaseOrder", "purchase_order", "poNumber", "po_number"))}</td>
      <td>${escapeHTML(valueOf(entry, "product", "product_name"))}</td>
      <td>${escapeHTML(valueOf(entry, "supplier", "supplier_name"))}</td>
      <td>${escapeHTML(valueOf(entry, "receivingLocation", "receiving_location", "location"))}</td>
      <td>${documentLink(valueOf(entry, "coaFileUrl", "coa_file_url", "supplier_coa_path"))}</td>
      <td>${documentLink(valueOf(entry, "invoiceFileUrl", "invoice_file_url", "invoice_file_path"))}</td>
      <td>${documentLink(valueOf(entry, "poFileUrl", "po_file_url", "purchase_order_file_url"))}</td>
      <td><span class="status-tag warning">${escapeHTML(entry.status || "KANTA PENDING")}</span></td>
      <td class="action-col">
        <div class="inline-actions">
          <button class="row-action" data-edit-id="${escapeHTML(entry.id)}" type="button">Edit</button>
          <button class="row-action danger" data-delete-id="${escapeHTML(entry.id)}" type="button">Delete</button>
        </div>
      </td>
    </tr>
  `).join("");

  kantaTableBody.querySelectorAll("[data-edit-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const entry = pendingEntries.find((item) => item.id === button.dataset.editId);
      if (entry) renderKantaEditor(entry);
    });
  });

  kantaTableBody.querySelectorAll("[data-delete-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      const entry = pendingEntries.find((item) => item.id === button.dataset.deleteId);
      if (!entry) return;

      const confirmed = window.confirm("Are you sure you want to delete this Kanta entry? This will remove the Kanta record and any related uploaded documents for this entry.");
      if (!confirmed) return;

      button.disabled = true;
      button.textContent = "Deleting...";
      try {
        await deleteEntryWithFiles(entry);
        pendingEntries = pendingEntries.filter((item) => item.id !== entry.id);
        kantaMessage.textContent = "Kanta entry deleted successfully.";
        kantaMessage.style.color = "var(--success)";
        renderRows();
      } catch (error) {
        console.error("Unable to delete Kanta record.", error);
        button.disabled = false;
        button.textContent = "Delete";
        kantaMessage.textContent = "Kanta record could not be deleted. Please check your connection and try again.";
        kantaMessage.style.color = "var(--danger)";
      }
    });
  });
}

function renderKantaEditor(entry) {
  const declaredQuantity = valueOf(entry, "declaredQuantity", "declared_quantity", "quantity");
  const declaredQuantityText = declaredQuantity !== "" ? String(declaredQuantity) : "";
  const unit = valueOf(entry, "unit", "quantityUnit", "quantity_unit");
  const receiveType = valueOf(entry, "receiveType", "receive_type", "receivedAs", "received_as");
  const purchaseOrder = valueOf(entry, "purchaseOrder", "purchase_order", "poNumber", "po_number");
  const industryType = valueOf(entry, "industryType", "industry_type");

  kantaDrawerBody.innerHTML = `
    <div class="drawer-section">
      <h4>Inward Details</h4>
      <div class="detail-grid">
        <div><span>Industry Type</span><strong>${escapeHTML(industryType || "—")}</strong></div>
        <div><span>Purchase Order (PO)</span><strong>${escapeHTML(purchaseOrder || "—")}</strong></div>
        <div><span>Supplier</span><strong>${escapeHTML(valueOf(entry, "supplier", "supplier_name"))}</strong></div>
        <div><span>Product</span><strong>${escapeHTML(valueOf(entry, "product", "product_name"))}</strong></div>
        <div><span>Invoice / Challan</span><strong>${escapeHTML(valueOf(entry, "invoiceChallanNo", "invoice_challan_no"))}</strong></div>
        <div><span>Receiving Location</span><strong>${escapeHTML(valueOf(entry, "receivingLocation", "receiving_location", "location"))}</strong></div>
        <div><span>Receive Type</span><strong>${escapeHTML(receiveType || "—")}</strong></div>
        <div><span>Declared Quantity</span><strong>${escapeHTML(declaredQuantityText || "—")}${declaredQuantityText && unit ? ` ${escapeHTML(unit)}` : ""}</strong></div>
      </div>
    </div>

    <form id="kantaForm" class="drawer-form" novalidate>
      <div class="drawer-section">
        <h4>Kanta Entry</h4>
        <div class="field-grid">
          <label>
            <span>Declared Quantity</span>
            <input type="text" name="declaredQuantity" value="${escapeHTML(declaredQuantityText)}" readonly />
          </label>
          <label>
            <span>Received Qty</span>
            <input type="number" step="0.01" min="0" name="receivedQty" required />
          </label>
          <label>
            <span>Difference</span>
            <input type="number" step="0.01" name="difference" required />
          </label>
          <label>
            <span>Difference in %</span>
            <input type="number" step="0.01" name="differencePercentage" required />
          </label>
          <label>
            <span>Kanta Slip</span>
            <input type="file" name="kantaSlip" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx" />
          </label>
        </div>
        <p class="kanta-calculation-message" id="kantaCalculationMessage" aria-live="polite"></p>
      </div>
      <div class="drawer-actions">
        <button type="submit" class="primary-btn">Save Kanta</button>
      </div>
    </form>
  `;

  const kantaForm = document.getElementById("kantaForm");
  const receivedQty = kantaForm.elements.receivedQty;
  const difference = kantaForm.elements.difference;
  const differencePercentage = kantaForm.elements.differencePercentage;
  const calculationMessage = document.getElementById("kantaCalculationMessage");

  kantaForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = kantaForm.querySelector("button[type=submit]");
    if (submitButton.disabled) return;

    const rawReceived = Number(receivedQty.value);
    const validReceived = receivedQty.value !== "" && Number.isFinite(rawReceived) && rawReceived >= 0;
    const parsedDifference = Number(difference.value);
    const parsedDifferencePercentage = Number(differencePercentage.value);
    const validDeclared = declaredQuantityText !== "" && String(declaredQuantityText).trim() !== "";

    if (!validReceived || !validDeclared) {
      calculationMessage.textContent = !validDeclared ? "Declared Quantity must be available before saving Kanta." : "Please enter a valid received quantity.";
      calculationMessage.style.color = "var(--danger)";
      return;
    }

    if (!Number.isFinite(parsedDifference) || !Number.isFinite(parsedDifferencePercentage)) {
      calculationMessage.textContent = "Please enter both Difference and Difference in % manually.";
      calculationMessage.style.color = "var(--danger)";
      return;
    }

    submitButton.disabled = true;
    submitButton.textContent = "Saving...";

    try {
      const existing = await getDocs(query(collection(db, "kanta"), where("inwardId", "==", entry.id)));
      const deterministicKanta = await getDoc(doc(db, "kanta", entry.id));
      if (!existing.empty || deterministicKanta.exists() || entry.status !== "KANTA PENDING") {
        throw new Error("This inward record already has a completed Kanta entry.");
      }

      const slip = kantaForm.elements.kantaSlip.files[0];
      const kantaRef = doc(db, "kanta", entry.id);
      let kantaSlipUrl = "";
      if (slip) {
        const fileName = slip.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const slipRef = ref(storage, `CCPL-IMS/kanta-slips/${entry.id}/${Date.now()}-${fileName}`);
        await uploadBytes(slipRef, slip);
        kantaSlipUrl = await getDownloadURL(slipRef);
      }

      const batch = writeBatch(db);
      batch.set(kantaRef, {
        inwardId: entry.id,
        receivedQty: rawReceived,
        received_quantity: rawReceived,
        difference: parsedDifference,
        differencePercentage: parsedDifferencePercentage,
        difference_percentage: parsedDifferencePercentage,
        kantaSlipUrl,
        status: "KANTA COMPLETED",
        createdAt: serverTimestamp()
      });
      batch.update(doc(db, "inward", entry.id), { status: "GRN PENDING" });
      await batch.commit();

      kantaMessage.textContent = "Kanta entry saved successfully.";
      kantaMessage.style.color = "var(--success)";
      closeKantaDrawerPanel();
    } catch (error) {
      console.error("Unable to save Kanta entry.", error);
      calculationMessage.textContent = error.message.includes("already has")
        ? error.message
        : "Kanta entry could not be saved. Please check your connection and try again.";
      calculationMessage.style.color = "var(--danger)";
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = "Save Kanta";
    }
  });

  openKantaDrawer();
}

const pendingQuery = query(collection(db, "inward"), where("status", "==", "KANTA PENDING"));
kantaSearchBy.addEventListener("change", () => {
  updateKantaSearchUI();
  renderRows();
});
kantaSearchInput.addEventListener("input", renderRows);
kantaFromDate.addEventListener("change", renderRows);
kantaToDate.addEventListener("change", renderRows);
kantaSearchButton.addEventListener("click", renderRows);
onSnapshot(pendingQuery, (snapshot) => {
  pendingEntries = snapshot.docs
    .map((item) => ({ id: item.id, ...item.data() }))
    .sort((a, b) => (dateOf(b)?.getTime() || 0) - (dateOf(a)?.getTime() || 0));
  updateKantaSearchUI();
  renderRows();
}, (error) => {
  console.error("Unable to load Kanta pending records.", error);
  pendingEntries = [];
  kantaCount.textContent = "0 records";
  kantaTableBody.innerHTML = `<tr><td class="empty-row" colspan="9">Unable to load records. Please refresh and try again.</td></tr>`;
});

closeKantaDrawer.addEventListener("click", closeKantaDrawerPanel);
drawerBackdrop.addEventListener("click", closeKantaDrawerPanel);

if (mobileToggle) {
  mobileToggle.addEventListener("click", () => {
    sidebar.classList.toggle("open");
    overlay.classList.toggle("active");
  });
}

if (overlay) {
  overlay.addEventListener("click", () => {
    sidebar.classList.remove("open");
    overlay.classList.remove("active");
  });
}

window.addEventListener("resize", () => {
  if (window.innerWidth > 820) {
    sidebar.classList.remove("open");
    overlay.classList.remove("active");
  }
});
