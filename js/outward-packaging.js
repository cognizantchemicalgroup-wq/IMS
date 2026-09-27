const outwardRecipes = [{
  id: "abc-acetone-25",
  name: "2.5L Bottle Packing",
  customer: "ABC Chemicals",
  product: "Acetone 2.5L",
  materials: [
    { material: "Empty Box", quantity: 1, unit: "Pieces" },
    { material: "2.5 Litre Bottle", quantity: 4, unit: "Pieces" },
    { material: "Thermocol", quantity: 2, unit: "Pieces" },
    { material: "Box Plate", quantity: 2, unit: "Pieces" }
  ]
}];

const availablePackagingStock = {
  "ABC Chemicals": {
    "Empty Box": 10,
    "2.5 Litre Bottle": 10,
    Thermocol: 10,
    "Box Plate": 10
  }
};

const customerSelect = document.querySelector("#packagingCustomer");
const packagingProductSelect = document.querySelector("#packagingProduct");
const configurationSelect = document.querySelector("#packagingConfiguration");
const boxesInput = document.querySelector("#numberOfBoxes");
const packagingResults = document.querySelector("#packagingResults");
const noConfigurationMessage = document.querySelector("#packagingNoConfig");
const finalizeButton = document.querySelector("#finalizeOutward");

function addTableCell(row, value, className = "") {
  const cell = document.createElement("td");
  cell.textContent = value;
  if (className) cell.className = className;
  row.append(cell);
  return cell;
}

function matchingRecipes() {
  return outwardRecipes.filter((recipe) => recipe.customer === customerSelect.value && recipe.product === packagingProductSelect.value);
}

function refreshConfigurations() {
  const recipes = matchingRecipes();
  configurationSelect.replaceChildren(new Option("Select configuration", ""));
  recipes.forEach((recipe) => configurationSelect.add(new Option(recipe.name, recipe.id)));
  configurationSelect.value = recipes[0]?.id || "";
  renderPackagingPreview();
}

function renderRequiredMaterials(recipe, boxes) {
  const body = document.querySelector("#requiredMaterials");
  const stockBody = document.querySelector("#packagingStockPreview");
  const summaryBody = document.querySelector("#summaryMaterials");
  body.replaceChildren();
  stockBody.replaceChildren();
  summaryBody.replaceChildren();
  const customerStock = availablePackagingStock[recipe.customer] || {};
  const shortages = [];

  recipe.materials.forEach((material) => {
    const required = material.quantity * boxes;
    const available = customerStock[material.material] ?? 0;
    const balance = available - required;
    const shortage = required > available;

    const requiredRow = document.createElement("tr");
    addTableCell(requiredRow, material.material, "outward-material");
    addTableCell(requiredRow, String(material.quantity), "outward-number");
    addTableCell(requiredRow, String(required), "outward-number");
    addTableCell(requiredRow, material.unit);
    body.append(requiredRow);

    const stockRow = document.createElement("tr");
    stockRow.className = shortage ? "stock-shortage-row" : "stock-ok-row";
    addTableCell(stockRow, material.material, "outward-material");
    addTableCell(stockRow, String(available), "outward-number");
    addTableCell(stockRow, String(required), "outward-number");
    addTableCell(stockRow, String(balance), "outward-number");
    const statusCell = document.createElement("td");
    const status = document.createElement("span");
    status.className = `stock-preview-status ${shortage ? "insufficient" : "available"}`;
    const statusIcon = document.createElement("i");
    statusIcon.className = `fa-solid ${shortage ? "fa-triangle-exclamation" : "fa-circle-check"}`;
    statusIcon.setAttribute("aria-hidden", "true");
    status.append(statusIcon, document.createTextNode(shortage ? "Insufficient Stock" : "Available"));
    statusCell.append(status);
    stockRow.append(statusCell);
    stockBody.append(stockRow);

    const summaryRow = document.createElement("tr");
    addTableCell(summaryRow, material.material, "outward-material");
    addTableCell(summaryRow, String(material.quantity), "outward-number");
    addTableCell(summaryRow, String(required), "outward-number");
    addTableCell(summaryRow, material.unit);
    summaryBody.append(summaryRow);

    if (shortage) shortages.push({ material: material.material, available, required });
  });

  const warning = document.querySelector("#stockWarning");
  warning.replaceChildren();
  warning.classList.toggle("visible", shortages.length > 0);
  if (shortages.length) {
    const heading = document.createElement("strong");
    heading.textContent = "Insufficient Packaging Stock";
    warning.append(heading);
    shortages.forEach((shortage) => {
      const message = document.createElement("span");
      message.textContent = `${shortage.material}: Available: ${shortage.available}, Required: ${shortage.required}.`;
      warning.append(message, document.createElement("br"));
    });
  }

  document.querySelector("#summaryCustomer").textContent = recipe.customer;
  document.querySelector("#summaryProduct").textContent = recipe.product;
  document.querySelector("#summaryConfiguration").textContent = recipe.name;
  document.querySelector("#summaryBoxes").textContent = String(boxes);
  document.querySelector("#summaryMaterialCount").textContent = `Total Packaging Required: ${recipe.materials.length} material types`;
  document.querySelector("#consumptionSummary").hidden = false;
  return shortages;
}

function renderPackagingPreview() {
  const recipe = outwardRecipes.find((item) => item.id === configurationSelect.value);
  const boxCount = Number(boxesInput.value);
  const boxCountValid = Number.isInteger(boxCount) && boxCount > 0;
  const boxField = document.querySelector("#numberOfBoxesField");
  const boxError = document.querySelector("#numberOfBoxesError");
  boxField.classList.toggle("invalid", !boxCountValid);
  boxError.textContent = boxCountValid ? "" : "Enter a whole number greater than zero.";
  noConfigurationMessage.hidden = Boolean(recipe) && boxCountValid;

  if (!recipe || !boxCountValid) {
    packagingResults.hidden = true;
    document.querySelector("#consumptionSummary").hidden = true;
    finalizeButton.disabled = true;
    document.querySelector("#outwardFinalizeHint").textContent = recipe
      ? "Enter a whole number of boxes to preview packaging requirements."
      : "Select a matching packaging configuration to continue.";
    return;
  }

  noConfigurationMessage.hidden = true;
  packagingResults.hidden = false;
  const shortages = renderRequiredMaterials(recipe, boxCount);
  finalizeButton.disabled = shortages.length > 0;
  document.querySelector("#outwardFinalizeHint").textContent = shortages.length
    ? "Finalization is disabled while demo packaging stock is insufficient."
    : "Preview only. No product or packaging stock will be changed.";
}

customerSelect.addEventListener("change", refreshConfigurations);
packagingProductSelect.addEventListener("change", refreshConfigurations);
configurationSelect.addEventListener("change", renderPackagingPreview);
boxesInput.addEventListener("input", renderPackagingPreview);
document.querySelector("#outwardProduct").addEventListener("change", (event) => {
  document.querySelector("#demoProductName").textContent = event.target.value;
});
document.querySelector("#outwardForm").addEventListener("submit", (event) => {
  event.preventDefault();
  if (finalizeButton.disabled) return;
  const toast = document.querySelector("#outwardToast");
  toast.textContent = "Preview only. No outward record was created and no stock was deducted.";
  toast.classList.add("visible");
});

const sidebar = document.querySelector("#sidebar");
const mobileMenuToggle = document.querySelector("#mobileMenuToggle");
mobileMenuToggle.addEventListener("click", () => {
  const open = sidebar.classList.toggle("open");
  mobileMenuToggle.setAttribute("aria-expanded", String(open));
  mobileMenuToggle.setAttribute("aria-label", open ? "Close navigation menu" : "Open navigation menu");
});

refreshConfigurations();