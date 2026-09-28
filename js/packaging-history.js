import { db } from "./firebase-config.js";
import { collection, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

let transactions = [];
let transactionDocuments = null;
let receiptDocuments = null;

const historyRows = document.querySelector("#historyRows");
const tableWrap = document.querySelector("#tableWrap");
const emptyState = document.querySelector("#emptyState");
const searchInput = document.querySelector("#historySearch");
const customerFilter = document.querySelector("#customerFilter");
const materialFilter = document.querySelector("#materialFilter");
const typeFilter = document.querySelector("#typeFilter");
const dateFromFilter = document.querySelector("#dateFromFilter");
const dateToFilter = document.querySelector("#dateToFilter");
const transactionDrawer = document.querySelector("#transactionDrawer");
const drawerOverlay = document.querySelector("#drawerOverlay");
let lastViewButton = null;

function valueOf(record, ...keys) {
  for (const key of keys) {
    if (record?.[key] !== undefined && record[key] !== null && record[key] !== "") return record[key];
  }
  return "";
}

function dateValue(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  if (typeof value === "object" && Number.isFinite(value.seconds)) return new Date(value.seconds * 1000);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatTransactionDate(value) {
  const date = dateValue(value);
  return date ? new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true
  }).format(date) : "—";
}

function transactionUser(value) {
  if (typeof value === "string") return value || "—";
  return valueOf(value || {}, "name", "displayName", "email", "uid") || "—";
}

function normalizeTransaction(data, id) {
  const type = String(valueOf(data, "transaction_type", "transactionType", "type")).toUpperCase();
  const quantity = Number(valueOf(data, "quantity", "received_quantity", "receivedQuantity"));
  const date = dateValue(valueOf(data, "created_at", "createdAt", "timestamp", "date"));
  const customer = String(valueOf(data, "customer_name", "customerName", "customer")).trim();
  const material = String(valueOf(data, "material_name", "materialName", "material")).trim();
  const unit = String(valueOf(data, "unit", "quantity_unit", "quantityUnit")).trim();
  if (!["IN", "OUT"].includes(type) || !Number.isFinite(quantity) || !customer || !material || !unit) return null;
  return {
    id,
    date,
    customer,
    material,
    materialId: valueOf(data, "material_id", "materialId"),
    type,
    quantity: Math.abs(quantity),
    unit,
    reference: String(valueOf(data, "reference", "reference_id", "referenceId") || "—"),
    user: transactionUser(valueOf(data, "created_by", "createdBy", "user")),
    relatedOutward: String(valueOf(data, "related_outward", "relatedOutward", "outward_id", "outwardId") || "—"),
    remark: String(valueOf(data, "remark", "notes") || "—"),
    receiptId: String(valueOf(data, "receipt_id", "receiptId") || (String(valueOf(data, "reference_type", "referenceType")).toUpperCase() === "PACKAGING_RECEIPT" ? valueOf(data, "reference_id", "referenceId") : "")),
    referenceType: String(valueOf(data, "reference_type", "referenceType") || ""),
    numberOfBoxes: valueOf(data, "number_of_boxes", "numberOfBoxes")
  };
}

function normalizeReceiptLines(receipt, receiptId) {
  const materials = valueOf(receipt, "materials", "lines");
  if (!Array.isArray(materials)) return [];
  return materials.map((line, index) => normalizeTransaction({
    customer_name: valueOf(receipt, "customer_name", "customerName", "customer"),
    material_name: valueOf(line, "material_name", "materialName", "material"),
    material_id: valueOf(line, "material_id", "materialId"),
    transaction_type: "IN",
    quantity: valueOf(line, "quantity", "received_quantity", "receivedQuantity"),
    unit: valueOf(line, "unit", "quantity_unit", "quantityUnit"),
    created_at: valueOf(receipt, "created_at", "createdAt", "timestamp"),
    reference: valueOf(receipt, "reference", "reference_id") || receiptId,
    reference_id: receiptId,
    receipt_id: receiptId,
    reference_type: "PACKAGING_RECEIPT",
    created_by: valueOf(receipt, "created_by", "createdBy", "user"),
    remark: valueOf(receipt, "remark", "notes")
  }, `${receiptId}_${index + 1}_IN`)).filter(Boolean);
}

function receiptLineKey(record) {
  const receiptId = record.receiptId || (record.referenceType.toUpperCase() === "PACKAGING_RECEIPT" ? record.reference : "");
  if (!receiptId) return "";
  return [receiptId, record.materialId || record.material.toLowerCase(), record.unit.toLowerCase(), record.quantity].join("|");
}

function transactionDateKey(date) {
  if (!date) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function addCell(row, value, className = "") {
  const cell = document.createElement("td");
  cell.textContent = value;
  if (className) cell.className = className;
  row.append(cell);
  return cell;
}

function renderUnitTotals(selector, type) {
  const totals = new Map();
  transactions.filter((record) => record.type === type).forEach((record) => {
    totals.set(record.unit, (totals.get(record.unit) || 0) + record.quantity);
  });
  const element = document.querySelector(selector);
  const children = [];
  [...totals].forEach(([unit, quantity], index) => {
    if (index) {
      const separator = document.createElement("span");
      separator.className = "stat-unit-separator";
      separator.textContent = "·";
      children.push(separator);
    }
    const total = document.createElement("span");
    total.className = "stat-unit-total";
    total.textContent = `${quantity} ${unit}`;
    children.push(total);
  });
  element.replaceChildren(...children);
}

function updateHistorySummary() {
  document.querySelector("#totalTransactions").textContent = String(transactions.length);
  document.querySelector("#customerCount").textContent = String(new Set(transactions.map((record) => record.customer)).size);
  renderUnitTotals("#totalReceived", "IN");
  renderUnitTotals("#totalConsumed", "OUT");
}

function updateFilterOptions() {
  const selectedCustomer = customerFilter.value;
  const selectedMaterial = materialFilter.value;
  const customers = [...new Set(transactions.map((record) => record.customer))].sort((first, second) => first.localeCompare(second));
  const materials = [...new Set(transactions.map((record) => record.material))].sort((first, second) => first.localeCompare(second));
  customerFilter.replaceChildren(new Option("All customers", ""), ...customers.map((customer) => new Option(customer, customer)));
  materialFilter.replaceChildren(new Option("All materials", ""), ...materials.map((material) => new Option(material, material)));
  customerFilter.value = customers.includes(selectedCustomer) ? selectedCustomer : "";
  materialFilter.value = materials.includes(selectedMaterial) ? selectedMaterial : "";
}

function getFilteredTransactions() {
  const query = searchInput.value.trim().toLowerCase();
  const fromDate = dateFromFilter.value;
  const toDate = dateToFilter.value;
  return transactions.filter((record) => {
    const searchableText = [record.customer, record.material, record.reference].join(" ").toLowerCase();
    const date = transactionDateKey(record.date);
    return (!query || searchableText.includes(query))
      && (!customerFilter.value || record.customer === customerFilter.value)
      && (!materialFilter.value || record.material === materialFilter.value)
      && (!typeFilter.value || record.type === typeFilter.value)
      && (!fromDate || date >= fromDate)
      && (!toDate || date <= toDate);
  });
}

function renderTransactions() {
  const filtered = getFilteredTransactions();
  filtered.sort((first, second) => (second.date?.getTime() || 0) - (first.date?.getTime() || 0));
  historyRows.replaceChildren(...filtered.map((record) => {
    const row = document.createElement("tr");
    addCell(row, formatTransactionDate(record.date));
    addCell(row, record.customer);
    addCell(row, record.material, "product-name");
    const typeCell = addCell(row, "");
    const typeBadge = document.createElement("span");
    typeBadge.className = `history-type history-type-${record.type.toLowerCase()}`;
    typeBadge.textContent = record.type;
    typeCell.append(typeBadge);
    addCell(row, `${record.type === "IN" ? "+" : "-"}${record.quantity}`, `history-quantity history-quantity-${record.type.toLowerCase()}`);
    addCell(row, record.unit);
    addCell(row, record.reference, "history-reference");
    addCell(row, record.user);
    const actionCell = addCell(row, "");
    const viewButton = document.createElement("button");
    viewButton.className = "view-button";
    viewButton.type = "button";
    viewButton.textContent = "View";
    viewButton.setAttribute("aria-label", `View transaction ${record.reference}, ${record.material}`);
    viewButton.addEventListener("click", () => openTransaction(record, viewButton));
    actionCell.append(viewButton);
    return row;
  }));

  tableWrap.hidden = filtered.length === 0;
  emptyState.hidden = filtered.length !== 0;
  const countText = `${filtered.length} ${filtered.length === 1 ? "transaction" : "transactions"}`;
  document.querySelector("#historySummaryCount").textContent = countText;
  document.querySelector("#resultCountFooter").textContent = countText;
}

function openTransaction(record, trigger) {
  lastViewButton = trigger;
  document.querySelector("#drawerTitle").textContent = record.reference;
  const grid = document.createElement("div");
  grid.className = "detail-grid";
  const details = [
    ["Date & Time", formatTransactionDate(record.date)],
    ["Customer", record.customer],
    ["Packaging Material", record.material],
    ["Transaction Type", record.type],
    ["Quantity", `${record.type === "IN" ? "+" : "-"}${record.quantity}`],
    ["Unit", record.unit],
    ["Reference Number", record.reference],
    ["Related Outward", record.relatedOutward],
    ["User", record.user],
    ["Remark", record.remark]
  ];
  if (record.receiptId) details.push(["Receipt ID", record.receiptId]);
  if (record.referenceType) details.push(["Reference Type", record.referenceType]);
  if (record.numberOfBoxes) details.push(["Number of Boxes", String(record.numberOfBoxes)]);
  details.forEach(([label, value]) => {
    const item = document.createElement("div");
    const detailLabel = document.createElement("span");
    detailLabel.className = "detail-label";
    detailLabel.textContent = label;
    const detailValue = document.createElement("span");
    detailValue.className = "detail-value";
    detailValue.textContent = value;
    item.append(detailLabel, detailValue);
    grid.append(item);
  });
  const card = document.createElement("section");
  card.className = "detail-card";
  card.append(grid);
  document.querySelector("#drawerContent").replaceChildren(card);
  transactionDrawer.classList.add("open");
  transactionDrawer.setAttribute("aria-hidden", "false");
  drawerOverlay.classList.add("active");
  document.querySelector("#closeDrawerIcon").focus();
}

function closeTransaction() {
  transactionDrawer.classList.remove("open");
  transactionDrawer.setAttribute("aria-hidden", "true");
  drawerOverlay.classList.remove("active");
  lastViewButton?.focus();
}

function incrementCount(counts, key) {
  if (key) counts.set(key, (counts.get(key) || 0) + 1);
}

function renderLoadedTransactions() {
  if (!transactionDocuments || !receiptDocuments) return;
  const storedTransactions = transactionDocuments
    .map((item) => normalizeTransaction(item.data, item.id))
    .filter(Boolean);
  const existingReceiptLines = new Map();
  storedTransactions.forEach((record) => incrementCount(existingReceiptLines, receiptLineKey(record)));
  const receiptTransactions = receiptDocuments
    .flatMap((item) => normalizeReceiptLines(item.data, item.id))
    .filter((record) => {
      const key = receiptLineKey(record);
      const count = existingReceiptLines.get(key) || 0;
      if (!count) return true;
      existingReceiptLines.set(key, count - 1);
      return false;
    });

  transactions = [...storedTransactions, ...receiptTransactions]
    .sort((first, second) => (second.date?.getTime() || 0) - (first.date?.getTime() || 0));
  emptyState.querySelector("h3").textContent = "No packaging transactions found.";
  emptyState.querySelector("p").textContent = "Reset filters or check again after a receipt is saved.";
  updateFilterOptions();
  updateHistorySummary();
  renderTransactions();
}

function showLoadError(error) {
  console.error("Unable to load packaging transactions.", error);
  tableWrap.hidden = true;
  emptyState.hidden = false;
  emptyState.querySelector("h3").textContent = "Packaging transactions could not be loaded.";
  emptyState.querySelector("p").textContent = "Check your connection and try again.";
  document.querySelector("#historySummaryCount").textContent = "Unable to load transactions";
  document.querySelector("#resultCountFooter").textContent = "Unable to load transactions";
}

onSnapshot(collection(db, "packaging_transactions"), (snapshot) => {
  transactionDocuments = snapshot.docs.map((item) => ({ id: item.id, data: item.data() }));
  renderLoadedTransactions();
}, showLoadError);

onSnapshot(collection(db, "packaging_receipts"), (snapshot) => {
  receiptDocuments = snapshot.docs.map((item) => ({ id: item.id, data: item.data() }));
  renderLoadedTransactions();
}, showLoadError);

[searchInput, customerFilter, materialFilter, typeFilter, dateFromFilter, dateToFilter].forEach((control) => {
  control.addEventListener(control === searchInput ? "input" : "change", renderTransactions);
});

document.querySelector("#resetFilters").addEventListener("click", () => {
  searchInput.value = "";
  customerFilter.value = "";
  materialFilter.value = "";
  typeFilter.value = "";
  dateFromFilter.value = "";
  dateToFilter.value = "";
  renderTransactions();
});

document.querySelector("#closeDrawer").addEventListener("click", closeTransaction);
document.querySelector("#closeDrawerIcon").addEventListener("click", closeTransaction);
drawerOverlay.addEventListener("click", closeTransaction);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeTransaction();
});

const sidebar = document.querySelector("#sidebar");
const mobileMenuToggle = document.querySelector("#mobileMenuToggle");
mobileMenuToggle.addEventListener("click", () => {
  const open = sidebar.classList.toggle("open");
  mobileMenuToggle.setAttribute("aria-expanded", String(open));
  mobileMenuToggle.setAttribute("aria-label", open ? "Close navigation menu" : "Open navigation menu");
});
sidebar.querySelectorAll(".nav-item").forEach((link) => link.addEventListener("click", () => {
  sidebar.classList.remove("open");
  mobileMenuToggle.setAttribute("aria-expanded", "false");
}));

