import {
  OUTWARD_PACKAGING_RULE,
  finalizeOutward,
  loadOutwardRecords,
  loadPackagingCustomers,
  loadPackagingStock,
  loadProductStock,
  packagingEntityId,
  packagingStockId,
  saveOutwardDraft
} from "./packaging-data.js";

const form = document.querySelector("#outwardForm");
const fromSelect = document.querySelector("#outwardFrom");
const customerSelect = document.querySelector("#outwardCustomer");
const productSelect = document.querySelector("#outwardProduct");
const locationSelect = document.querySelector("#outwardLocation");
const quantityInput = document.querySelector("#outwardQuantity");
const boxesInput = document.querySelector("#numberOfBoxes");
const poInput = document.querySelector("#againstPoNumber");
const finalizeButton = document.querySelector("#finalizeOutward");
const toast = document.querySelector("#outwardToast");
const viewDialog = document.querySelector("#outwardViewDialog");

let customers = [];
let products = [];
let productStock = [];
let packagingStock = [];
let outwardEntries = [];
let pendingDraftId = "";

function valueOf(record, ...keys) {
  for (const key of keys) {
    if (record?.[key] !== undefined && record[key] !== null && record[key] !== "") return record[key];
  }
  return "";
}

function normalized(value) {
  return String(value ?? "").trim().normalize("NFKC").toLowerCase();
}

function customerLabel(value) {
  return String(value ?? "").replace(/\bchemicals\b/ig, "Chemicals");
}

function stockQuantity(record) {
  const raw = valueOf(record, "current_stock", "currentStock", "available_quantity", "availableQuantity", "quantity");
  return raw === "" ? Number.NaN : Number(raw);
}

function availablePackaging(record) {
  const raw = valueOf(record, "available_quantity", "availableQuantity", "current_stock", "currentStock");
  if (raw !== "") return Number(raw);
  const received = Number(valueOf(record, "received_quantity", "receivedQuantity") || 0);
  const consumed = Number(valueOf(record, "consumed_quantity", "consumedQuantity") || 0);
  return received - consumed;
}

function dateValue(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  if (typeof value === "object" && Number.isFinite(value.seconds)) return new Date(value.seconds * 1000);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateText(value) {
  const date = dateValue(value);
  return date ? date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—";
}

function formatNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value).toLocaleString(undefined, { maximumFractionDigits: 3 }) : "—";
}

function addCell(row, value, className = "") {
  const cell = document.createElement("td");
  cell.textContent = String(value ?? "—");
  if (className) cell.className = className;
  row.append(cell);
  return cell;
}

function renderCustomerOptions() {
  const selected = customerSelect.value;
  customerSelect.replaceChildren(new Option("Select customer", ""));
  customers.forEach((customer) => customerSelect.add(new Option(customerLabel(customer.name), customer.name)));
  customerSelect.value = customers.some((customer) => customer.name === selected) ? selected : "";
}

function renderProductOptions() {
  const selected = productSelect.value;
  const uniqueProducts = new Map();
  productStock.forEach((record) => {
    const name = String(valueOf(record, "product_name", "product", "productName")).trim();
    const productId = String(valueOf(record, "product_id", "productId") || name);
    const quantity = stockQuantity(record);
    if (name && Number.isFinite(quantity) && quantity >= 0) {
      if (!uniqueProducts.has(productId)) uniqueProducts.set(productId, { id: productId, name });
    }
  });
  products = [...uniqueProducts.values()].sort((first, second) => first.name.localeCompare(second.name));
  productSelect.replaceChildren(new Option(products.length ? "Select product" : "No inventory products found", ""));
  products.forEach((product) => productSelect.add(new Option(product.name, product.id)));
  productSelect.value = products.some((product) => product.id === selected) ? selected : "";
}

function selectedProduct() {
  return products.find((product) => product.id === productSelect.value) || null;
}

function selectedProductStock() {
  const product = selectedProduct();
  if (!product || !locationSelect.value) return null;
  return productStock.find((record) => {
    const recordId = String(valueOf(record, "product_id", "productId") || valueOf(record, "product_name", "product", "productName"));
    const recordName = String(valueOf(record, "product_name", "product", "productName"));
    return (recordId === product.id || recordName === product.name)
      && normalized(valueOf(record, "receiving_location", "location", "receivingLocation")) === normalized(locationSelect.value);
  }) || null;
}

function customerStockFor(customerName, materialId, materialName, unit) {
  const customerId = packagingEntityId(customerName);
  const matching = packagingStock.filter((record) => {
    const recordCustomerId = String(valueOf(record, "customer_id", "customerId"));
    const recordCustomer = normalized(valueOf(record, "customer_name", "customerName", "customer"));
    const recordMaterialId = String(valueOf(record, "material_id", "materialId"));
    const recordMaterial = normalized(valueOf(record, "material_name", "materialName", "material"));
    return (recordCustomerId === customerId || recordCustomer === normalized(customerName))
      && (recordMaterialId === materialId || recordMaterial === normalized(materialName))
      && normalized(valueOf(record, "unit")) === normalized(unit);
  });
  const legacyId = packagingStockId(customerId, materialId);
  return matching.find((record) => record.id === legacyId) || matching[0] || null;
}

function renderProductAvailability() {
  const product = selectedProduct();
  const record = selectedProductStock();
  const stockValue = record ? stockQuantity(record) : Number.NaN;
  document.querySelector("#selectedProductName").textContent = product && locationSelect.value
    ? `${product.name} / ${locationSelect.value}`
    : "Select product and location";
  document.querySelector("#availableProductStock").textContent = record && Number.isFinite(stockValue)
    ? `Available Stock: ${formatNumber(stockValue)} ${valueOf(record, "unit", "quantity_unit", "quantityUnit")}`
    : product && locationSelect.value ? "No inventory record for this product at the selected location." : "—";
  updateValidation();
}

function renderCustomerPackaging() {
  const customerName = customerSelect.value;
  const tbody = document.querySelector("#customerPackagingRows");
  const empty = document.querySelector("#customerPackagingEmpty");
  const records = customerName ? packagingStock.filter((record) => {
    const customerId = String(valueOf(record, "customer_id", "customerId"));
    const recordName = normalized(valueOf(record, "customer_name", "customerName", "customer"));
    return customerId === packagingEntityId(customerName) || recordName === normalized(customerName);
  }).sort((first, second) => String(valueOf(first, "material_name", "materialName")).localeCompare(String(valueOf(second, "material_name", "materialName")))) : [];
  tbody.replaceChildren(...records.map((record) => {
    const row = document.createElement("tr");
    addCell(row, valueOf(record, "material_name", "materialName", "material"), "outward-material");
    addCell(row, formatNumber(availablePackaging(record)), "outward-number");
    addCell(row, valueOf(record, "unit") || "—");
    return row;
  }));
  document.querySelector("#customerPackagingCaption").textContent = customerName
    ? `Available packaging stock recorded for ${customerName}.`
    : "Select a customer to view packaging availability.";
  empty.hidden = !customerName || records.length > 0;
  renderPackagingRequirements();
}

function renderPackagingRequirements() {
  const boxes = Number(boxesInput.value);
  const boxesValid = Number.isInteger(boxes) && boxes > 0;
  const customerName = customerSelect.value;
  const requirements = boxesValid ? OUTWARD_PACKAGING_RULE.map((material) => {
    const materialId = packagingEntityId(material.material_name);
    const required = material.quantity_per_box * boxes;
    const stock = customerName ? customerStockFor(customerName, materialId, material.material_name, material.unit) : null;
    const available = stock ? availablePackaging(stock) : Number.NaN;
    return { ...material, materialId, required, available, shortage: Boolean(customerName && (!stock || !Number.isFinite(available) || available < required)) };
  }) : [];
  const tbody = document.querySelector("#packagingStockPreview");
  tbody.replaceChildren(...requirements.map((item) => {
    const row = document.createElement("tr");
    row.className = item.shortage ? "stock-shortage-row" : "stock-ok-row";
    addCell(row, item.material_name, "outward-material");
    addCell(row, formatNumber(item.quantity_per_box), "outward-number");
    addCell(row, customerName ? formatNumber(item.available) : "Select customer", "outward-number");
    addCell(row, formatNumber(item.required), "outward-number");
    const balance = item.available - item.required;
    addCell(row, !customerName ? "—" : item.shortage ? `Shortage: ${formatNumber(Math.max(0, item.required - item.available))}` : formatNumber(balance), "outward-number");
    addCell(row, item.unit);
    return row;
  }));
  document.querySelector("#consumptionSummary").hidden = requirements.length === 0;
  const shortages = requirements.filter((item) => item.shortage);
  const status = document.querySelector("#packagingStockStatus");
  status.className = `stock-availability ${shortages.length ? "insufficient" : "available"}`;
  status.textContent = shortages.length ? "Insufficient Packaging Stock"
    : !customerName && requirements.length ? "Select customer to check availability"
      : requirements.length ? "Packaging Stock Available" : "Enter a whole number of boxes";
  const warning = document.querySelector("#stockWarning");
  warning.replaceChildren();
  warning.classList.toggle("visible", shortages.length > 0);
  if (shortages.length) {
    const title = document.createElement("strong");
    title.textContent = "Insufficient packaging stock. Dispatch is blocked.";
    warning.append(title);
    shortages.forEach((item) => {
      const detail = document.createElement("span");
      detail.textContent = `${item.material_name}: Available ${formatNumber(item.available)}, Required ${formatNumber(item.required)}, Shortage ${formatNumber(Math.max(0, item.required - item.available))}.`;
      warning.append(document.createElement("br"), detail);
    });
  }
  updateValidation();
}

function updateValidation() {
  const productStockRecord = selectedProductStock();
  const available = productStockRecord ? stockQuantity(productStockRecord) : Number.NaN;
  const quantity = Number(quantityInput.value);
  const boxes = Number(boxesInput.value);
  const boxesValid = Number.isInteger(boxes) && boxes > 0;
  const packagingOk = Boolean(customerSelect.value && boxesValid && OUTWARD_PACKAGING_RULE.every((material) => {
    const stock = customerStockFor(customerSelect.value, packagingEntityId(material.material_name), material.material_name, material.unit);
    return stock && availablePackaging(stock) >= material.quantity_per_box * boxes;
  }));
  const productOk = productStockRecord && Number.isFinite(available) && available >= 0
    && Number.isFinite(quantity) && quantity > 0 && quantity <= available;
  const ready = Boolean(fromSelect.value && customerSelect.value && selectedProduct() && locationSelect.value
    && productOk && boxesValid && packagingOk);
  const productWarning = document.querySelector("#productStockWarning");
  productWarning.replaceChildren();
  productWarning.classList.toggle("visible", Boolean(productStockRecord && Number.isFinite(quantity) && quantity > available));
  if (productStockRecord && Number.isFinite(quantity) && quantity > available) {
    productWarning.textContent = `Insufficient product stock. Available: ${formatNumber(available)} ${valueOf(productStockRecord, "unit")}; requested: ${formatNumber(quantity)}.`;
  }
  finalizeButton.disabled = !ready;
  return ready;
}

function renderOutwardEntries() {
  const dispatched = outwardEntries.filter((entry) => String(valueOf(entry, "status")).toUpperCase() === "DISPATCHED");
  const tbody = document.querySelector("#outwardEntriesBody");
  tbody.replaceChildren(...dispatched.map((entry) => {
    const row = document.createElement("tr");
    const quantity = `${formatNumber(valueOf(entry, "product_quantity", "productQuantity"))} ${valueOf(entry, "product_unit", "productUnit")}`.trim();
    [dateText(valueOf(entry, "finalized_at", "created_at", "createdAt")), valueOf(entry, "product_name", "productName"), quantity,
      valueOf(entry, "from_company", "from") || "—", customerLabel(valueOf(entry, "customer_name", "customerName")),
      valueOf(entry, "number_of_boxes", "numberOfBoxes"), "Dispatched"].forEach((value) => addCell(row, value));
    const action = addCell(row, "");
    const view = document.createElement("button");
    view.className = "view-button";
    view.type = "button";
    view.textContent = "View";
    view.addEventListener("click", () => openOutwardDetails(entry));
    action.append(view);
    return row;
  }));
  document.querySelector("#outwardEntriesWrap").hidden = dispatched.length === 0;
  const empty = document.querySelector("#outwardEntriesEmpty");
  empty.hidden = dispatched.length > 0;
  empty.textContent = dispatched.length ? "" : "No dispatched outward entries yet.";
}

function appendDetail(container, label, value) {
  const item = document.createElement("div");
  const caption = document.createElement("span");
  caption.className = "detail-label";
  caption.textContent = label;
  const detail = document.createElement("strong");
  detail.className = "detail-value";
  detail.textContent = String(value || "—");
  item.append(caption, detail);
  container.append(item);
}

function openOutwardDetails(entry) {
  document.querySelector("#outwardViewTitle").textContent = `Outward ${entry.id}`;
  const content = document.querySelector("#outwardViewContent");
  content.replaceChildren();
  const grid = document.createElement("div");
  grid.className = "outward-detail-grid";
  const quantity = Number(valueOf(entry, "product_quantity", "productQuantity"));
  const productBefore = valueOf(entry, "product_stock_before");
  const productAfter = valueOf(entry, "product_stock_after");
  [
    ["Date & Time", dateText(valueOf(entry, "finalized_at", "created_at", "createdAt"))],
    ["From", valueOf(entry, "from_company", "from")],
    ["To", customerLabel(valueOf(entry, "customer_name", "customerName"))],
    ["Product", valueOf(entry, "product_name", "productName")],
    ["Location", valueOf(entry, "receiving_location", "location")],
    ["Quantity", `${formatNumber(quantity)} ${valueOf(entry, "product_unit", "productUnit")}`.trim()],
    ["Number of Boxes", valueOf(entry, "number_of_boxes", "numberOfBoxes")],
    ["Against PO Number", valueOf(entry, "against_po_number", "againstPoNumber")],
    ["Status", valueOf(entry, "status")]
  ].forEach(([label, value]) => appendDetail(grid, label, value));
  content.append(grid);

  const productSection = document.createElement("section");
  productSection.className = "outward-detail-section";
  const productHeading = document.createElement("h3");
  productHeading.textContent = "Product Stock";
  const productTable = document.createElement("table");
  productTable.className = "outward-table";
  productTable.innerHTML = "<thead><tr><th>Previous Stock</th><th>Outward Quantity</th><th>Remaining Stock</th></tr></thead>";
  const productBody = document.createElement("tbody");
  const productRow = document.createElement("tr");
  [productBefore === "" ? "—" : `${formatNumber(productBefore)} ${valueOf(entry, "product_unit", "productUnit")}`,
    `${formatNumber(quantity)} ${valueOf(entry, "product_unit", "productUnit")}`,
    productAfter === "" ? "—" : `${formatNumber(productAfter)} ${valueOf(entry, "product_unit", "productUnit")}`].forEach((value) => addCell(productRow, value));
  productBody.append(productRow);
  productTable.append(productBody);
  productSection.append(productHeading, productTable);
  content.append(productSection);

  const packagingSection = document.createElement("section");
  packagingSection.className = "outward-detail-section";
  const packagingHeading = document.createElement("h3");
  packagingHeading.textContent = "Packaging Used";
  const packagingTable = document.createElement("table");
  packagingTable.className = "outward-table";
  packagingTable.innerHTML = "<thead><tr><th>Material</th><th>Quantity</th><th>Unit</th></tr></thead>";
  const packagingBody = document.createElement("tbody");
  const used = Array.isArray(entry.packaging_used) ? entry.packaging_used : [];
  used.forEach((material) => {
    const row = document.createElement("tr");
    addCell(row, valueOf(material, "material_name", "material"), "outward-material");
    addCell(row, formatNumber(valueOf(material, "quantity")), "outward-number");
    addCell(row, valueOf(material, "unit"));
    packagingBody.append(row);
  });
  if (!used.length) {
    const row = document.createElement("tr");
    addCell(row, "No packaging detail was saved for this entry.");
    packagingBody.append(row);
  }
  packagingTable.append(packagingBody);
  packagingSection.append(packagingHeading, packagingTable);
  content.append(packagingSection);
  viewDialog.showModal();
}

async function refreshStockData() {
  [productStock, packagingStock] = await Promise.all([loadProductStock(), loadPackagingStock()]);
  renderProductOptions();
  renderProductAvailability();
  renderCustomerPackaging();
}

async function initialize() {
  try {
    [customers, productStock, packagingStock, outwardEntries] = await Promise.all([
      loadPackagingCustomers(), loadProductStock(), loadPackagingStock(), loadOutwardRecords()
    ]);
    renderCustomerOptions();
    renderProductOptions();
    renderCustomerPackaging();
    renderProductAvailability();
    renderOutwardEntries();
    if (!products.length) document.querySelector("#outwardFinalizeHint").textContent = "No product inventory is available to dispatch.";
  } catch (error) {
    console.error("Unable to load Outward data.", error);
    toast.textContent = error.message || "Outward data could not be loaded. Check your connection and refresh.";
    toast.classList.add("visible");
    document.querySelector("#outwardEntriesEmpty").textContent = "Outward entries could not be loaded.";
  }
}

[customerSelect, productSelect, locationSelect].forEach((control) => control.addEventListener("change", () => {
  toast.classList.remove("visible");
  if (control === customerSelect) renderCustomerPackaging();
  if (control === productSelect || control === locationSelect) renderProductAvailability();
  updateValidation();
}));
[quantityInput, boxesInput].forEach((control) => control.addEventListener("input", () => {
  renderPackagingRequirements();
  renderProductAvailability();
}));
fromSelect.addEventListener("change", updateValidation);
poInput.addEventListener("input", () => toast.classList.remove("visible"));

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (finalizeButton.disabled || !updateValidation()) return;
  const product = selectedProduct();
  const stock = selectedProductStock();
  const customer = customers.find((record) => record.name === customerSelect.value);
  finalizeButton.disabled = true;
  finalizeButton.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Dispatching...';
  toast.classList.remove("visible");
  try {
    pendingDraftId = await saveOutwardDraft({
      from_company: fromSelect.value,
      customer: customer.name,
      product_name: product.name,
      product_stock_id: stock.id,
      product_quantity: Number(quantityInput.value),
      location: locationSelect.value,
      against_po_number: poInput.value.trim(),
      number_of_boxes: Number(boxesInput.value)
    }, pendingDraftId);
    await finalizeOutward(pendingDraftId);
    pendingDraftId = "";
    toast.textContent = "Outward dispatched. Product inventory and customer packaging stock were updated.";
    toast.classList.add("visible");
    outwardEntries = await loadOutwardRecords();
    renderOutwardEntries();
    await refreshStockData();
    form.reset();
    renderPackagingRequirements();
    renderProductAvailability();
    renderCustomerPackaging();
  } catch (error) {
    console.error("Unable to finalize Outward.", error);
    toast.textContent = error.message || "Dispatch could not be completed. No stock was changed.";
    toast.classList.add("visible");
  } finally {
    finalizeButton.innerHTML = '<i class="fa-solid fa-truck-fast"></i> Final Dispatch';
    updateValidation();
  }
});

document.querySelector("#closeOutwardView").addEventListener("click", () => viewDialog.close());
document.querySelector("#closeOutwardViewButton").addEventListener("click", () => viewDialog.close());
viewDialog.addEventListener("click", (event) => {
  if (event.target === viewDialog) viewDialog.close();
});

document.querySelector("#mobileMenuToggle").addEventListener("click", (event) => {
  const button = event.currentTarget;
  const open = document.querySelector("#sidebar").classList.toggle("open");
  button.setAttribute("aria-expanded", String(open));
  button.setAttribute("aria-label", open ? "Close navigation menu" : "Open navigation menu");
});

initialize();
