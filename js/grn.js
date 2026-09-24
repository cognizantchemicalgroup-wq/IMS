import { db } from "./firebase-config.js";
import {
  collection,
  doc,
  getDocs,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  where
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const sidebar = document.getElementById("sidebar");
const overlay = document.getElementById("mobileOverlay");
const mobileToggle = document.getElementById("mobileMenuToggle");
const grnTableBody = document.getElementById("grnTableBody");
const grnCount = document.getElementById("grnCount");
const grnDrawer = document.getElementById("grnDrawer");
const grnDrawerBody = document.getElementById("grnDrawerBody");
const drawerBackdrop = document.getElementById("drawerBackdrop");
const closeGrnDrawer = document.getElementById("closeGrnDrawer");
let pendingEntries = [];
let kantaRecords = [];

function escapeHTML(value) {
  return String(value ?? "—").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function valueOf(record, ...keys) {
  for (const key of keys) if (record[key] !== undefined && record[key] !== null && record[key] !== "") return record[key];
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

function documentLink(url) {
  return url ? `<a class="row-action" href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">View</a>` : `<span>Document not available</span>`;
}

function openGrnDrawer() {
  grnDrawer.classList.add("open");
  drawerBackdrop.classList.add("show");
}

function closeGrnDrawerPanel() {
  grnDrawer.classList.remove("open");
  drawerBackdrop.classList.remove("show");
  grnDrawerBody.innerHTML = "";
}

function kantaFor(entry) {
  return kantaRecords.find((record) => record.inwardId === entry.id && (record.status === "KANTA COMPLETED" || record.status === "GRN FINALIZED"));
}

function renderRows() {
  grnCount.textContent = `${pendingEntries.length} record${pendingEntries.length === 1 ? "" : "s"}`;
  if (!pendingEntries.length) {
    grnTableBody.innerHTML = `<tr><td class="empty-row" colspan="10">No records found</td></tr>`;
    return;
  }

  grnTableBody.innerHTML = pendingEntries.map((entry) => {
    const kanta = kantaFor(entry);
    const kantaQuantity = Number(valueOf(kanta || {}, "netWeight", "net_weight"));
    return `<tr>
      <td>${escapeHTML(dateText(entry))}</td>
      <td>${escapeHTML(valueOf(entry, "invoiceChallanNo", "invoice_challan_no", "invoice_no", "challan_no"))}</td>
      <td>${escapeHTML(valueOf(entry, "product", "product_name"))}</td>
      <td>${escapeHTML(valueOf(entry, "supplier", "supplier_name"))}</td>
      <td>${escapeHTML(valueOf(entry, "receivingLocation", "receiving_location", "location"))}</td>
      <td>${Number.isFinite(kantaQuantity) && kantaQuantity > 0 ? escapeHTML(kantaQuantity) : "—"}</td>
      <td>${documentLink(valueOf(entry, "coaFileUrl", "coa_file_url", "supplier_coa_path"))}</td>
      <td>${documentLink(valueOf(entry, "invoiceFileUrl", "invoice_file_url", "invoiceFilePath"))}</td>
      <td><span class="status-tag warning">GRN PENDING</span></td>
      <td class="action-col"><button class="row-action" data-edit-id="${escapeHTML(entry.id)}" type="button">Edit</button></td>
    </tr>`;
  }).join("");

  grnTableBody.querySelectorAll("[data-edit-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const entry = pendingEntries.find((item) => item.id === button.dataset.editId);
      if (entry) renderEditor(entry);
    });
  });
}

function renderEditor(entry) {
  const kanta = kantaFor(entry);
  const declaredQuantity = Number(valueOf(entry, "declaredQuantity", "declared_quantity", "quantity"));
  const kantaQuantity = Number(valueOf(kanta || {}, "netWeight", "net_weight"));
  const unit = valueOf(entry, "unit", "quantityUnit", "quantity_unit");

  grnDrawerBody.innerHTML = `
    <div class="drawer-section"><h4>Inward Details</h4><div class="detail-grid">
      <div><span>Invoice / Challan</span><strong>${escapeHTML(valueOf(entry, "invoiceChallanNo", "invoice_challan_no"))}</strong></div>
      <div><span>Supplier</span><strong>${escapeHTML(valueOf(entry, "supplier", "supplier_name"))}</strong></div>
      <div><span>Product</span><strong>${escapeHTML(valueOf(entry, "product", "product_name"))}</strong></div>
      <div><span>Receiving Location</span><strong>${escapeHTML(valueOf(entry, "receivingLocation", "receiving_location", "location"))}</strong></div>
      <div><span>Supplier Lot No.</span><strong>${escapeHTML(valueOf(entry, "supplierLotNo", "supplier_lot_no", "lotNo", "lot_no"))}</strong></div>
      <div><span>Declared Quantity</span><strong>${escapeHTML(declaredQuantity)} ${escapeHTML(unit)}</strong></div>
      <div><span>Kanta Quantity</span><strong>${escapeHTML(kantaQuantity)} ${escapeHTML(unit)}</strong></div>
    </div></div>
    <div class="drawer-section"><h4>GRN Finalize</h4><form id="grnForm" class="drawer-form" novalidate>
      <div class="field-grid">
        <label><span>Final Accepted Quantity</span><input type="number" step="0.01" min="0" name="finalAcceptedQuantity" required /></label>
        <label><span>Remark</span><input type="text" name="remark" placeholder="Optional remarks" /></label>
        <label><span>Kanta Difference</span><input type="number" step="0.01" name="difference" readonly /></label>
        <label><span>Rejected / Short Quantity</span><input type="number" step="0.01" name="rejectedQuantity" readonly /></label>
        <label><span>Acceptance %</span><input type="number" step="0.01" name="acceptancePercentage" readonly /></label>
      </div>
      <p id="grnMessage" aria-live="polite"></p>
      <div class="drawer-actions"><button type="submit" class="primary-btn">Finalize GRN</button></div>
    </form></div>`;

  const form = document.getElementById("grnForm");
  const accepted = form.elements.finalAcceptedQuantity;
  const difference = form.elements.difference;
  const rejected = form.elements.rejectedQuantity;
  const percentage = form.elements.acceptancePercentage;
  const message = document.getElementById("grnMessage");
  const submitButton = form.querySelector("button[type=submit]");

  function calculate() {
    const acceptedValue = Number(accepted.value);
    const validNumber = accepted.value !== "" && Number.isFinite(acceptedValue);
    const valid = validNumber && acceptedValue >= 0 && kantaQuantity > 0 && acceptedValue <= kantaQuantity;
    const delta = validNumber && kantaQuantity > 0 ? kantaQuantity - acceptedValue : 0;
    difference.value = validNumber ? delta.toFixed(2) : "";
    rejected.value = validNumber ? delta.toFixed(2) : "";
    percentage.value = validNumber && kantaQuantity > 0 ? ((acceptedValue / kantaQuantity) * 100).toFixed(2) : "";
    message.textContent = validNumber && acceptedValue > kantaQuantity ? "Final Accepted Quantity cannot exceed Kanta Quantity." : "";
    message.style.color = "var(--danger)";
    return { acceptedValue, delta, valid, acceptancePercentage: kantaQuantity > 0 ? (acceptedValue / kantaQuantity) * 100 : 0 };
  }

  accepted.addEventListener("input", calculate);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submitButton.disabled) return;
    const result = calculate();
    if (!result.valid) {
      message.textContent = kantaQuantity <= 0 ? "A valid Kanta Quantity is required before finalizing." : "Enter a Final Accepted Quantity from 0 up to the Kanta Quantity.";
      return;
    }
    submitButton.disabled = true;
    submitButton.textContent = "Finalizing...";

    try {
      const existingGrn = await getDocs(query(collection(db, "grn"), where("inwardId", "==", entry.id)));
      if (!existingGrn.empty) throw new Error("GRN already finalized.");
      const stockSnapshot = await getDocs(collection(db, "stock"));

      await runTransaction(db, async (transaction) => {
        const inwardRef = doc(db, "inward", entry.id);
        const kantaRef = doc(db, "kanta", kanta.id);
        const grnRef = doc(db, "grn", entry.id);
        const inwardSnapshot = await transaction.get(inwardRef);
        const kantaSnapshot = await transaction.get(kantaRef);
        const grnSnapshot = await transaction.get(grnRef);
        if (!inwardSnapshot.exists() || !kantaSnapshot.exists()) throw new Error("The source record is no longer available.");
        if (!existingGrn.empty || grnSnapshot.exists() || inwardSnapshot.data().status === "GRN FINALIZED") throw new Error("GRN already finalized.");

        const stockData = stockSnapshot.docs.map((item) => ({ ref: item.ref, data: item.data() }));
        const product = valueOf(entry, "product", "product_name");
        const lotNo = valueOf(entry, "supplierLotNo", "supplier_lot_no", "lotNo", "lot_no");
        const location = valueOf(entry, "receivingLocation", "receiving_location", "location");
        const stockMatch = stockData.find(({ data }) => valueOf(data, "product", "product_name") === product && valueOf(data, "lotNo", "lot_no") === lotNo && valueOf(data, "location", "receivingLocation", "receiving_location") === location && valueOf(data, "unit", "quantityUnit", "quantity_unit") === unit);
        const stockQuantity = stockMatch ? Number(valueOf(stockMatch.data, "quantity", "availableQuantity", "available_quantity")) || 0 : 0;
        if (stockMatch) await transaction.get(stockMatch.ref);
        const stockId = encodeURIComponent(`${product}|${lotNo}|${location}|${unit}`).slice(0, 1_200);
        const newStockRef = doc(db, "stock", stockId);
        if (!stockMatch) await transaction.get(newStockRef);

        transaction.set(grnRef, { inwardId: entry.id, kantaId: kanta.id, finalAcceptedQuantity: result.acceptedValue, kantaQuantity, difference: result.delta, rejectedQuantity: result.delta, acceptancePercentage: result.acceptancePercentage, remark: form.elements.remark.value.trim(), status: "GRN FINALIZED", finalizedAt: serverTimestamp() });
        transaction.update(inwardRef, { status: "GRN FINALIZED" });
        transaction.update(kantaRef, { status: "GRN FINALIZED" });
        const stockPayload = { product, lotNo, location, quantity: stockQuantity + result.acceptedValue, unit, updatedAt: serverTimestamp() };
        if (stockMatch) transaction.set(stockMatch.ref, stockPayload, { merge: true });
        else transaction.set(newStockRef, stockPayload);
      });
      closeGrnDrawerPanel();
    } catch (error) {
      console.error("Unable to finalize GRN.", error);
      message.textContent = error.message === "GRN already finalized." ? error.message : "Unable to finalize GRN. Please try again.";
      message.style.color = "var(--danger)";
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = "Finalize GRN";
    }
  });
  openGrnDrawer();
}

function listen() {
  onSnapshot(query(collection(db, "inward"), where("status", "==", "GRN PENDING")), (snapshot) => {
    pendingEntries = snapshot.docs.map((item) => ({ id: item.id, ...item.data() })).sort((a, b) => (dateOf(b)?.getTime() || 0) - (dateOf(a)?.getTime() || 0));
    renderRows();
  }, (error) => {
    console.error("Unable to load GRN pending records.", error);
    grnTableBody.innerHTML = `<tr><td class="empty-row" colspan="10">Unable to load records. Please refresh and try again.</td></tr>`;
  });
  onSnapshot(collection(db, "kanta"), (snapshot) => {
    kantaRecords = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
    renderRows();
  }, (error) => console.error("Unable to load Kanta records for GRN.", error));
}

closeGrnDrawer.addEventListener("click", closeGrnDrawerPanel);
drawerBackdrop.addEventListener("click", closeGrnDrawerPanel);
if (mobileToggle) mobileToggle.addEventListener("click", () => { sidebar.classList.toggle("open"); overlay.classList.toggle("active"); });
if (overlay) overlay.addEventListener("click", () => { sidebar.classList.remove("open"); overlay.classList.remove("active"); });
window.addEventListener("resize", () => { if (window.innerWidth > 820) { sidebar.classList.remove("open"); overlay.classList.remove("active"); } });
listen();
