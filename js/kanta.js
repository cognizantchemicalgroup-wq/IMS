import { db, storage } from "./firebase-config.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  where,
  writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
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
const kantaDrawer = document.getElementById("kantaDrawer");
const kantaDrawerBody = document.getElementById("kantaDrawerBody");
const drawerBackdrop = document.getElementById("drawerBackdrop");
const closeKantaDrawer = document.getElementById("closeKantaDrawer");

let pendingEntries = [];

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

function renderRows() {
  kantaCount.textContent = `${pendingEntries.length} record${pendingEntries.length === 1 ? "" : "s"}`;

  if (!pendingEntries.length) {
    kantaTableBody.innerHTML = `<tr><td class="empty-row" colspan="9">No records found</td></tr>`;
    return;
  }

  kantaTableBody.innerHTML = pendingEntries.map((entry) => `
    <tr>
      <td>${escapeHTML(dateText(entry))}</td>
      <td>${escapeHTML(valueOf(entry, "invoiceChallanNo", "invoice_challan_no", "invoice_no", "challan_no"))}</td>
      <td>${escapeHTML(valueOf(entry, "product", "product_name"))}</td>
      <td>${escapeHTML(valueOf(entry, "supplier", "supplier_name"))}</td>
      <td>${escapeHTML(valueOf(entry, "receivingLocation", "receiving_location", "location"))}</td>
      <td>${documentLink(valueOf(entry, "coaFileUrl", "coa_file_url", "supplier_coa_path"))}</td>
      <td>${documentLink(valueOf(entry, "invoiceFileUrl", "invoice_file_url", "invoice_file_path"))}</td>
      <td><span class="status-tag warning">${escapeHTML(entry.status || "KANTA PENDING")}</span></td>
      <td class="action-col">
        <div class="inline-actions">
          <button class="row-action" data-edit-id="${escapeHTML(entry.id)}" type="button">Edit</button>
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
}

function renderKantaEditor(entry) {
  const declaredQuantity = Number(valueOf(entry, "declaredQuantity", "declared_quantity", "quantity"));
  const unit = valueOf(entry, "unit", "quantityUnit", "quantity_unit");

  kantaDrawerBody.innerHTML = `
    <div class="drawer-section">
      <h4>Inward Details</h4>
      <div class="detail-grid">
        <div><span>Supplier</span><strong>${escapeHTML(valueOf(entry, "supplier", "supplier_name"))}</strong></div>
        <div><span>Product</span><strong>${escapeHTML(valueOf(entry, "product", "product_name"))}</strong></div>
        <div><span>Invoice / Challan</span><strong>${escapeHTML(valueOf(entry, "invoiceChallanNo", "invoice_challan_no"))}</strong></div>
        <div><span>Receiving Location</span><strong>${escapeHTML(valueOf(entry, "receivingLocation", "receiving_location", "location"))}</strong></div>
        <div><span>Supplier Lot No.</span><strong>${escapeHTML(valueOf(entry, "supplierLotNo", "supplier_lot_no", "lotNo", "lot_no"))}</strong></div>
        <div><span>Declared Quantity</span><strong>${escapeHTML(declaredQuantity)} ${escapeHTML(unit)}</strong></div>
      </div>
    </div>

    <form id="kantaForm" class="drawer-form" novalidate>
      <div class="drawer-section">
        <h4>Kanta Entry</h4>
        <div class="field-grid">
          <label>
            <span>Gross Weight</span>
            <input type="number" step="0.01" min="0" name="grossWeight" required />
          </label>
          <label>
            <span>Tare Weight</span>
            <input type="number" step="0.01" min="0" name="tareWeight" required />
          </label>
          <label>
            <span>Net Weight</span>
            <input type="number" step="0.01" name="netWeight" readonly />
          </label>
          <label>
            <span>Difference</span>
            <input type="number" step="0.01" name="difference" readonly />
          </label>
          <label>
            <span>Difference %</span>
            <input type="number" step="0.01" name="differencePercentage" readonly />
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
  const grossWeight = kantaForm.elements.grossWeight;
  const tareWeight = kantaForm.elements.tareWeight;
  const netWeight = kantaForm.elements.netWeight;
  const difference = kantaForm.elements.difference;
  const differencePercentage = kantaForm.elements.differencePercentage;
  const calculationMessage = document.getElementById("kantaCalculationMessage");

  function calculate() {
    const gross = Number(grossWeight.value);
    const tare = Number(tareWeight.value);
    const hasWeights = grossWeight.value !== "" && tareWeight.value !== "" && Number.isFinite(gross) && Number.isFinite(tare);
    const valid = hasWeights && gross > 0 && tare >= 0 && gross >= tare && declaredQuantity > 0;
    const net = hasWeights ? Math.max(0, gross - tare) : 0;
    const delta = hasWeights && declaredQuantity > 0 ? net - declaredQuantity : 0;
    const percentage = hasWeights && declaredQuantity > 0 ? (delta / declaredQuantity) * 100 : 0;

    netWeight.value = hasWeights ? net.toFixed(2) : "";
    difference.value = hasWeights ? delta.toFixed(2) : "";
    differencePercentage.value = hasWeights ? percentage.toFixed(2) : "";
    calculationMessage.textContent = hasWeights && gross < tare ? "Gross Weight must be greater than or equal to Tare Weight." : "";
    calculationMessage.style.color = "var(--danger)";
    return { gross, tare, net, difference: delta, differencePercentage: percentage, valid };
  }

  grossWeight.addEventListener("input", calculate);
  tareWeight.addEventListener("input", calculate);

  kantaForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = kantaForm.querySelector("button[type=submit]");
    if (submitButton.disabled) return;

    const weights = calculate();
    if (!weights.valid) {
      calculationMessage.textContent = declaredQuantity <= 0
        ? "Declared Quantity must be greater than 0."
        : "Enter valid weights. Gross Weight must be greater than 0 and greater than or equal to Tare Weight.";
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
        grossWeight: weights.gross,
        tareWeight: weights.tare,
        netWeight: weights.net,
        declaredQuantity,
        difference: weights.difference,
        differencePercentage: weights.differencePercentage,
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
onSnapshot(pendingQuery, (snapshot) => {
  pendingEntries = snapshot.docs
    .map((item) => ({ id: item.id, ...item.data() }))
    .sort((a, b) => (dateOf(b)?.getTime() || 0) - (dateOf(a)?.getTime() || 0));
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
