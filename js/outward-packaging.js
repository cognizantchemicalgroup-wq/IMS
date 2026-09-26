import {
  cancelOutwardDraft,
  finalizeOutward,
  loadOutwardRecords,
  loadPackagingConfigurations,
  loadPackagingStock,
  loadProductStock,
  packagingEntityId,
  packagingStockId,
  saveOutwardDraft
} from "./packaging-data.js";

const recipeRecords = [];
const packagingStockRecords = [];
const productStockRecords = [];
const outwardRecords = [];
let selectedOutwardId = "";
let selectedOutwardStatus = "";
let busy = false;

const customerSelect = document.querySelector("#packagingCustomer");
const packagingProductSelect = document.querySelector("#packagingProduct");
const configurationSelect = document.querySelector("#packagingConfiguration");
const productSelect = document.querySelector("#outwardProduct");
const productStockSelect = document.querySelector("#outwardProductStock");
const productQuantityInput = document.querySelector("#outwardProductQuantity");
const boxesInput = document.querySelector("#numberOfBoxes");
const packagingResults = document.querySelector("#packagingResults");
const noConfigurationMessage = document.querySelector("#packagingNoConfig");
const finalizeButton = document.querySelector("#finalizeOutward");
const saveDraftButton = document.querySelector("#saveOutwardDraft");
const cancelDraftButton = document.querySelector("#cancelOutwardDraft");
const outwardForm = document.querySelector("#outwardForm");

function normalized(value) {
  return String(value ?? "").trim().normalize("NFKC");
}

function recordCustomer(configuration) {
  return String(configuration.customer_name || configuration.customer || "").trim();
}

function recordProduct(configuration) {
  return String(configuration.product_name || configuration.product || "").trim();
}

function productName(stock) {
  return String(stock.product_name || stock.product || stock.productName || "").trim();
}

function productQuantity(stock) {
  const value = stock.current_stock ?? stock.currentStock ?? stock.available_quantity ?? stock.availableQuantity ?? stock.quantity;
  const quantity = Number(value);
  return Number.isFinite(quantity) && quantity >= 0 ? quantity : 0;
}

function productUnit(stock) {
  return String(stock.unit || stock.quantity_unit || stock.quantityUnit || "").trim();
}

function stockLocation(stock) {
  return String(stock.receiving_location || stock.location || stock.receivingLocation || "").trim();
}

function stockCustomer(stock) {
  return String(stock.customer_name || stock.customer || "").trim();
}

function stockMaterial(stock) {
  return String(stock.material_name || stock.material || "").trim();
}

function stockMaterialId(stock) {
  return String(stock.material_id || packagingEntityId(stockMaterial(stock)));
}

function addTableCell(row, value, className = "") {
  const cell = document.createElement("td");
  cell.textContent = String(value);
  if (className) cell.className = className;
  row.append(cell);
  return cell;
}

function replaceOptions(select, values, prompt, selected = "") {
  select.replaceChildren(new Option(prompt, ""), ...values.map((item) => new Option(item.label, item.value)));
  if (values.some((item) => item.value === selected)) select.value = selected;
}

function populateBaseSelectors() {
  const customers = [...new Set([
    ...recipeRecords.filter((record) => record.active !== false).map(recordCustomer),
    ...packagingStockRecords.map(stockCustomer)
  ].filter(Boolean))].sort();
  replaceOptions(customerSelect, customers.map((customer) => ({ value: customer, label: customer })), "Select customer", customerSelect.value);

  const products = [...new Set(productStockRecords.map(productName).filter(Boolean))].sort();
  replaceOptions(productSelect, products.map((product) => ({ value: product, label: product })), "Select product", productSelect.value);
  updateProductStockOptions();
  updatePackagingProducts();
}

function updateProductStockOptions() {
  const name = productSelect.value;
  const records = productStockRecords.filter((record) => productName(record) === name);
  const currentValue = productStockSelect.value;
  const choices = records.map((record) => {
    const location = stockLocation(record) || "Unspecified location";
    const unit = productUnit(record);
    return {
      value: record.id,
      label: `${location} Â· ${productQuantity(record).toLocaleString()} ${unit}`.trim()
    };
  });
  replaceOptions(productStockSelect, choices, "Select product stock location", currentValue);
  productStockSelect.disabled = choices.length === 0;
  const selected = records.find((record) => record.id === productStockSelect.value) || records[0];
  if (selected && !productStockSelect.value) productStockSelect.value = selected.id;
  document.querySelector("#demoProductName").textContent = name || "Select a product";
  document.querySelector("#demoProductStock").textContent = selected
    ? `${productQuantity(selected).toLocaleString()} ${productUnit(selected)} available at ${stockLocation(selected) || "the selected location"}`
    : "No product stock record available";
  document.querySelector("#productQuantityUnit").textContent = selected?.unit
    ? `Quantity to dispatch (${productUnit(selected)})`
    : "Quantity to dispatch";
  renderPackagingPreview();
}

function updatePackagingProducts(selectedProduct = "") {
  const customer = customerSelect.value;
  const products = [...new Set(recipeRecords
    .filter((record) => record.active !== false && String(record.status || "ACTIVE").toUpperCase() === "ACTIVE" && recordCustomer(record) === customer)
    .map(recordProduct)
    .filter(Boolean))].sort();
  replaceOptions(packagingProductSelect, products.map((product) => ({ value: product, label: product })), "Select product", selectedProduct || packagingProductSelect.value);
  updateConfigurations();
}

function updateConfigurations(selectedConfiguration = "") {
  const customer = customerSelect.value;
  const product = packagingProductSelect.value;
  const records = recipeRecords.filter((record) => record.active !== false
    && String(record.status || "ACTIVE").toUpperCase() === "ACTIVE"
    && recordCustomer(record) === customer
    && recordProduct(record) === product);
  replaceOptions(configurationSelect, records.map((record) => ({
    value: record.id,
    label: record.name || record.configuration_name || "Unnamed configuration"
  })), "Select configuration", selectedConfiguration || configurationSelect.value);
  renderPackagingPreview();
}

function selectedRecipe() {
  return recipeRecords.find((record) => record.id === configurationSelect.value) || null;
}

function selectedProductStock() {
  return productStockRecords.find((record) => record.id === productStockSelect.value) || null;
}

function availableFor(customer, materialId, materialName) {
  const customerId = packagingEntityId(customer);
  const stockId = packagingStockId(customerId, materialId);
  const record = packagingStockRecords.find((item) => item.id === stockId)
    || packagingStockRecords.find((item) => item.customer_id === customerId && stockMaterialId(item) === materialId)
    || packagingStockRecords.find((item) => stockCustomer(item) === customer && stockMaterial(item).toLowerCase() === materialName.toLowerCase());
  if (!record) return { available: 0, unit: "", found: false };
  const raw = record.available_quantity ?? record.availableQuantity ?? record.current_stock ?? record.currentStock;
  const quantity = Number(raw);
  return { available: Number.isFinite(quantity) && quantity >= 0 ? quantity : 0, unit: String(record.unit || ""), found: true };
}

function recipeMaterials(recipe) {
  return Array.isArray(recipe?.materials) ? recipe.materials.map((material) => ({
    materialId: String(material.material_id || packagingEntityId(material.material_name || material.material || "")),
    materialName: String(material.material_name || material.material || "").trim(),
    perBox: Number(material.quantity_per_box ?? material.quantity),
    unit: String(material.unit || "").trim()
  })) : [];
}

function setWarning(shortages) {
  const warning = document.querySelector("#stockWarning");
  warning.replaceChildren();
  warning.classList.toggle("visible", shortages.length > 0);
  if (!shortages.length) return;
  const heading = document.createElement("strong");
  heading.textContent = "Insufficient Packaging Stock";
  warning.append(heading);
  shortages.forEach((item) => {
    const message = document.createElement("span");
    message.textContent = `${item.material}: Available: ${item.available}, Required: ${item.required}.`;
    warning.append(message, document.createElement("br"));
  });
}

function renderPackagingPreview() {
  const recipe = selectedRecipe();
  const boxCount = Number(boxesInput.value);
  const boxCountValid = Number.isInteger(boxCount) && boxCount > 0;
  const boxField = document.querySelector("#numberOfBoxesField");
  const boxError = document.querySelector("#numberOfBoxesError");
  boxField.classList.toggle("invalid", !boxCountValid);
  boxError.textContent = boxCountValid ? "" : "Enter a whole number greater than zero.";
  const productStock = selectedProductStock();
  const productQty = Number(productQuantityInput.value);
  const productQtyValid = Number.isFinite(productQty) && productQty > 0;
  const productQtyAvailable = productStock ? productQuantity(productStock) : 0;
  const productShortage = !productStock || !productQtyValid || productQty > productQtyAvailable;
  document.querySelector("#outwardProductQuantityField").classList.toggle("invalid", !productQtyValid);
  document.querySelector("#outwardProductQuantityError").textContent = productQtyValid
    ? productStock && productQty > productQtyAvailable ? `Available product stock: ${productQtyAvailable} ${productUnit(productStock)}.` : ""
    : "Enter a quantity greater than zero.";

  if (!recipe || !boxCountValid) {
    packagingResults.hidden = true;
    noConfigurationMessage.hidden = false;
    document.querySelector("#consumptionSummary").hidden = true;
    finalizeButton.disabled = true;
    document.querySelector("#outwardFinalizeHint").textContent = recipe
      ? "Enter a whole number of boxes to preview packaging requirements."
      : "Select a matching customer, product, and packaging configuration.";
    return;
  }

  noConfigurationMessage.hidden = true;
  packagingResults.hidden = false;
  const requirements = recipeMaterials(recipe);
  const requiredBody = document.querySelector("#requiredMaterials");
  const stockBody = document.querySelector("#packagingStockPreview");
  const summaryBody = document.querySelector("#summaryMaterials");
  requiredBody.replaceChildren();
  stockBody.replaceChildren();
  summaryBody.replaceChildren();
  const shortages = [];
  requirements.forEach((item) => {
    const required = item.perBox * boxCount;
    const stock = availableFor(customerSelect.value, item.materialId, item.materialName);
    const unitMatches = stock.found && stock.unit.toLowerCase() === item.unit.toLowerCase();
    const available = unitMatches ? stock.available : 0;
    const insufficient = !unitMatches || required > available;

    const requiredRow = document.createElement("tr");
    addTableCell(requiredRow, item.materialName, "outward-material");
    addTableCell(requiredRow, item.perBox, "outward-number");
    addTableCell(requiredRow, required, "outward-number");
    addTableCell(requiredRow, item.unit);
    requiredBody.append(requiredRow);

    const stockRow = document.createElement("tr");
    stockRow.className = insufficient ? "stock-shortage-row" : "stock-ok-row";
    addTableCell(stockRow, item.materialName, "outward-material");
    addTableCell(stockRow, available, "outward-number");
    addTableCell(stockRow, required, "outward-number");
    addTableCell(stockRow, available - required, "outward-number");
    const statusCell = document.createElement("td");
    const status = document.createElement("span");
    status.className = `stock-preview-status ${insufficient ? "insufficient" : "available"}`;
    const icon = document.createElement("i");
    icon.className = `fa-solid ${insufficient ? "fa-triangle-exclamation" : "fa-circle-check"}`;
    icon.setAttribute("aria-hidden", "true");
    status.append(icon, document.createTextNode(insufficient ? "Insufficient Stock" : "Available"));
    statusCell.append(status);
    stockRow.append(statusCell);
    stockBody.append(stockRow);

    const summaryRow = document.createElement("tr");
    addTableCell(summaryRow, item.materialName, "outward-material");
    addTableCell(summaryRow, item.perBox, "outward-number");
    addTableCell(summaryRow, required, "outward-number");
    addTableCell(summaryRow, item.unit);
    summaryBody.append(summaryRow);

    if (insufficient) shortages.push({ material: item.materialName, available, required, missing: !stock.found || !unitMatches });
  });
  setWarning(shortages);

  document.querySelector("#summaryCustomer").textContent = recipeCustomer(recipe);
  document.querySelector("#summaryProduct").textContent = recordProduct(recipe);
  document.querySelector("#summaryConfiguration").textContent = recipe.name || recipe.configuration_name || "";
  document.querySelector("#summaryBoxes").textContent = String(boxCount);
  document.querySelector("#summaryMaterialCount").textContent = `Total Packaging Required: ${requirements.length} material types`;
  document.querySelector("#consumptionSummary").hidden = false;

  const alreadyDispatched = selectedOutwardStatus === "DISPATCHED";
  const cancelled = selectedOutwardStatus === "CANCELLED";
  finalizeButton.disabled = busy || cancelled || ((!alreadyDispatched) && (shortages.length > 0 || productShortage));
  saveDraftButton.disabled = busy || Boolean(selectedOutwardStatus && selectedOutwardStatus !== "DRAFT");
  cancelDraftButton.disabled = busy || selectedOutwardStatus !== "DRAFT";
  document.querySelector("#outwardFinalizeHint").textContent = alreadyDispatched
    ? "This Outward is already dispatched. Retrying will not deduct stock again."
    : cancelled
      ? "This draft was cancelled. No stock was deducted and it cannot be finalized."
    : productShortage
      ? "Product inventory is insufficient or unavailable. Product stock is validated separately from packaging stock."
      : shortages.length
        ? "Finalization is disabled until each customer-owned packaging material has sufficient stock and a matching unit."
        : selectedOutwardId
          ? "The saved draft can be finalized. Both stock updates run atomically on the server."
          : "Finalize saves this draft and atomically validates/deducts product and packaging stock.";
}

function recipeCustomer(recipe) {
  return recordCustomer(recipe);
}

function currentPayload() {
  const stock = selectedProductStock();
  const recipe = selectedRecipe();
  return {
    customer: customerSelect.value,
    product_name: productSelect.value,
    product_stock_id: stock?.id || "",
    location: stockLocation(stock || {}),
    product_quantity: productQuantityInput.value,
    configuration_id: recipe?.id || "",
    number_of_boxes: boxesInput.value
  };
}

function showMessage(message, isError = false) {
  const toast = document.querySelector("#outwardToast");
  toast.textContent = message;
  toast.classList.add("visible");
  toast.classList.toggle("error", isError);
}

function setBusy(value) {
  busy = value;
  saveDraftButton.disabled = value || Boolean(selectedOutwardStatus && selectedOutwardStatus !== "DRAFT");
  cancelDraftButton.disabled = value || selectedOutwardStatus !== "DRAFT";
  saveDraftButton.innerHTML = value
    ? '<i class="fa-solid fa-spinner fa-spin"></i> Saving'
    : '<i class="fa-regular fa-floppy-disk"></i> Save Draft';
  renderPackagingPreview();
  if (value) finalizeButton.disabled = true;
}

function refreshOutwardStatus(outward) {
  selectedOutwardId = outward?.id || "";
  selectedOutwardStatus = String(outward?.status || "").toUpperCase();
  document.querySelector("#outwardRecordStatus").textContent = outward
    ? `${selectedOutwardStatus}: ${outward.id}`
    : "No draft saved";
  renderPackagingPreview();
}

function updateSavedOutwardOptions() {
  const selector = document.querySelector("#existingOutward");
  const priorValue = selector.value;
  const records = [...outwardRecords].sort((first, second) => {
    const firstDate = first.created_at?.toMillis?.() || 0;
    const secondDate = second.created_at?.toMillis?.() || 0;
    return secondDate - firstDate;
  });
  selector.replaceChildren(new Option("New Outward", ""), ...records.map((record) => new Option(
    `${String(record.status || "DRAFT").toUpperCase()} Â· ${record.customer_name || "Customer"} Â· ${record.product_name || "Product"} Â· ${record.id}`,
    record.id
  )));
  if (records.some((record) => record.id === priorValue)) selector.value = priorValue;
}

async function saveDraft() {
  if (busy) return null;
  document.querySelector("#outwardToast").classList.remove("visible");
  const payload = currentPayload();
  if (!payload.customer) throw new Error("Customer is required.");
  if (!payload.product_name) throw new Error("Product is required.");
  if (!payload.product_stock_id) throw new Error("Select an available product stock location.");
  if (!payload.configuration_id) throw new Error("Select a packaging configuration.");
  if (!Number.isInteger(Number(payload.number_of_boxes)) || Number(payload.number_of_boxes) <= 0) throw new Error("Number of boxes must be a whole number greater than zero.");
  if (!Number.isFinite(Number(payload.product_quantity)) || Number(payload.product_quantity) <= 0) throw new Error("Product quantity must be greater than zero.");
  if (selectedOutwardStatus === "DISPATCHED") throw new Error("A dispatched Outward cannot be edited. Select New Outward to start another record.");
  setBusy(true);
  try {
    selectedOutwardId = await saveOutwardDraft(payload, selectedOutwardId);
    selectedOutwardStatus = "DRAFT";
    const saved = {
      id: selectedOutwardId,
      ...payload,
      customer_name: payload.customer,
      status: "DRAFT",
      created_at: new Date()
    };
    const existingIndex = outwardRecords.findIndex((record) => record.id === selectedOutwardId);
    if (existingIndex >= 0) outwardRecords[existingIndex] = { ...outwardRecords[existingIndex], ...saved };
    else outwardRecords.unshift(saved);
    updateSavedOutwardOptions();
    document.querySelector("#existingOutward").value = selectedOutwardId;
    refreshOutwardStatus(saved);
    showMessage(`Draft ${selectedOutwardId} saved. No product or packaging stock was deducted.`);
    return selectedOutwardId;
  } finally {
    setBusy(false);
  }
}

function restoreOutward(outward) {
  customerSelect.value = outward.customer_name || "";
  updatePackagingProducts(outward.product_name || "");
  productSelect.value = outward.product_name || "";
  updateProductStockOptions();
  productStockSelect.value = outward.product_stock_id || "";
  productQuantityInput.value = outward.product_quantity ?? "";
  const stock = selectedProductStock();
  replaceOptions(packagingProductSelect, [...new Set(recipeRecords.filter((record) => recordCustomer(record) === customerSelect.value).map(recordProduct).filter(Boolean))]
    .map((product) => ({ value: product, label: product })), "Select product", outward.product_name || "");
  replaceOptions(configurationSelect, recipeRecords.filter((record) => recordCustomer(record) === customerSelect.value && recordProduct(record) === outward.product_name)
    .map((record) => ({ value: record.id, label: record.name || record.configuration_name || "Unnamed configuration" })), "Select configuration", outward.packaging_configuration_id || "");
  boxesInput.value = outward.number_of_boxes ?? "";
  selectedOutwardId = outward.id;
  selectedOutwardStatus = String(outward.status || "").toUpperCase();
  document.querySelector("#outwardRecordStatus").textContent = `${selectedOutwardStatus}: ${outward.id}`;
  if (stock) {
    document.querySelector("#demoProductName").textContent = productName(stock);
    document.querySelector("#demoProductStock").textContent = `${productQuantity(stock).toLocaleString()} ${productUnit(stock)} available at ${stockLocation(stock)}`;
  }
  renderPackagingPreview();
}

async function handleFinalize(event) {
  event.preventDefault();
  if (busy || finalizeButton.disabled) return;
  document.querySelector("#outwardToast").classList.remove("visible");
  setBusy(true);
  try {
    if (!selectedOutwardId) {
      const payload = currentPayload();
      if (!payload.customer) throw new Error("Customer is required.");
      if (!payload.product_name) throw new Error("Product is required.");
      if (!payload.product_stock_id) throw new Error("Select an available product stock location.");
      if (!payload.configuration_id) throw new Error("Packaging configuration is required.");
      if (!Number.isInteger(Number(payload.number_of_boxes)) || Number(payload.number_of_boxes) <= 0) throw new Error("Number of boxes must be a whole number greater than zero.");
      if (!Number.isFinite(Number(payload.product_quantity)) || Number(payload.product_quantity) <= 0) throw new Error("Product quantity must be greater than zero.");
      selectedOutwardId = await saveOutwardDraft(payload);
      selectedOutwardStatus = "DRAFT";
    } else if (selectedOutwardStatus === "DRAFT") {
      await saveOutwardDraft(currentPayload(), selectedOutwardId);
    }
    const result = await finalizeOutward(selectedOutwardId);
    selectedOutwardStatus = "DISPATCHED";
    const existing = outwardRecords.find((record) => record.id === selectedOutwardId) || {};
    const saved = { ...existing, ...currentPayload(), id: selectedOutwardId, status: "DISPATCHED" };
    const recordIndex = outwardRecords.findIndex((record) => record.id === selectedOutwardId);
    if (recordIndex >= 0) outwardRecords[recordIndex] = saved;
    else outwardRecords.unshift(saved);
    updateSavedOutwardOptions();
    document.querySelector("#existingOutward").value = selectedOutwardId;
    refreshOutwardStatus(saved);
    const successMessage = result.alreadyFinalized
      ? `Outward ${selectedOutwardId} was already dispatched. No additional stock deduction was made.`
      : `Outward ${selectedOutwardId} was dispatched. Product stock and customer packaging stock were updated atomically.`;
    showMessage(successMessage);
    try {
      await reloadStockData();
    } catch (refreshError) {
      console.error("Outward was committed, but the stock preview could not be refreshed.", refreshError);
      showMessage(`${successMessage} Refresh the page to reload current stock.`);
    }
  } catch (error) {
    showMessage(error.message || "Outward could not be finalized. No stock was changed.", true);
  } finally {
    setBusy(false);
  }
}

async function cancelDraft() {
  if (busy || selectedOutwardStatus !== "DRAFT") return;
  setBusy(true);
  try {
    await cancelOutwardDraft(selectedOutwardId);
    selectedOutwardStatus = "CANCELLED";
    const record = outwardRecords.find((item) => item.id === selectedOutwardId);
    if (record) record.status = "CANCELLED";
    document.querySelector("#outwardRecordStatus").textContent = `CANCELLED: ${selectedOutwardId}`;
    showMessage(`Draft ${selectedOutwardId} cancelled. No product or packaging stock was deducted.`);
    renderPackagingPreview();
  } catch (error) {
    showMessage(error.message || "Draft could not be cancelled.", true);
  } finally {
    setBusy(false);
  }
}

async function reloadStockData() {
  const [packageRecords, productRecords, outwards] = await Promise.all([
    loadPackagingStock(), loadProductStock(), loadOutwardRecords()
  ]);
  packagingStockRecords.splice(0, packagingStockRecords.length, ...packageRecords);
  productStockRecords.splice(0, productStockRecords.length, ...productRecords);
  outwardRecords.splice(0, outwardRecords.length, ...outwards);
  updateProductStockOptions();
  updateSavedOutwardOptions();
  renderPackagingPreview();
}

function initializeEvents() {
  customerSelect.addEventListener("change", () => updatePackagingProducts());
  packagingProductSelect.addEventListener("change", () => updateConfigurations());
  configurationSelect.addEventListener("change", renderPackagingPreview);
  productSelect.addEventListener("change", updateProductStockOptions);
  productStockSelect.addEventListener("change", updateProductStockOptions);
  boxesInput.addEventListener("input", renderPackagingPreview);
  productQuantityInput.addEventListener("input", renderPackagingPreview);
  document.querySelector("#existingOutward").addEventListener("change", (event) => {
    const record = outwardRecords.find((item) => item.id === event.target.value);
    if (record) restoreOutward(record);
    else {
      selectedOutwardId = "";
      selectedOutwardStatus = "";
      document.querySelector("#outwardRecordStatus").textContent = "No draft saved";
      renderPackagingPreview();
    }
  });
  saveDraftButton.addEventListener("click", async () => {
    try {
      await saveDraft();
    } catch (error) {
      showMessage(error.message || "Draft could not be saved.", true);
    }
  });
  cancelDraftButton.addEventListener("click", cancelDraft);
  outwardForm.addEventListener("submit", handleFinalize);
  document.querySelector("#outwardProduct").addEventListener("change", (event) => {
    if ([...packagingProductSelect.options].some((option) => option.value === event.target.value)) {
      packagingProductSelect.value = event.target.value;
      updateConfigurations();
    }
  });
  const sidebar = document.querySelector("#sidebar");
  const mobileMenuToggle = document.querySelector("#mobileMenuToggle");
  mobileMenuToggle.addEventListener("click", () => {
    const open = sidebar.classList.toggle("open");
    mobileMenuToggle.setAttribute("aria-expanded", String(open));
    mobileMenuToggle.setAttribute("aria-label", open ? "Close navigation menu" : "Open navigation menu");
  });
}

async function initializeOutward() {
  initializeEvents();
  try {
    const [configurations, packagingStocks, productStocks, savedOutwards] = await Promise.all([
      loadPackagingConfigurations(), loadPackagingStock(), loadProductStock(), loadOutwardRecords()
    ]);
    recipeRecords.push(...configurations);
    packagingStockRecords.push(...packagingStocks);
    productStockRecords.push(...productStocks);
    outwardRecords.push(...savedOutwards);
    populateBaseSelectors();
    updateSavedOutwardOptions();
    const firstDraft = outwardRecords.find((record) => String(record.status || "").toUpperCase() === "DRAFT");
    const lastDispatched = outwardRecords.find((record) => String(record.status || "").toUpperCase() === "DISPATCHED");
    const resumable = firstDraft || lastDispatched;
    if (resumable) {
      document.querySelector("#existingOutward").value = resumable.id;
      restoreOutward(resumable);
    } else {
      renderPackagingPreview();
    }
    document.querySelector("#outwardDemoNotice").textContent = "Product Inventory and customer Packaging Stock are separate. Draft saves do not deduct either stock.";
  } catch (error) {
    showMessage(error.message || "Outward data could not be loaded. Check your connection and access.", true);
    document.querySelector("#outwardFinalizeHint").textContent = "Outward requires live product stock, active packaging configurations, and customer packaging stock.";
  }
}

initializeOutward();
