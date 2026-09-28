import { addPackagingCustomer, loadPackagingCustomers, savePackagingStockReceipt } from "./packaging-data.js";

const materialRows = document.querySelector("#materialRows");
const rowsEmpty = document.querySelector("#rowsEmpty");
const receiptForm = document.querySelector("#receiptForm");
const customerSelect = document.querySelector("#customerSelect");
const customerField = document.querySelector("#customerField");
const customerDialog = document.querySelector("#customerDialog");
const customerForm = document.querySelector("#customerForm");
const materialNames = ["Empty Box", "2.5 Litre Bottle", "Thermocol", "Box Plate"];
const unitNames = ["Pieces", "KG", "Liter"];
let customerRecords = [];

function renderCustomerOptions(selectedName = "") {
  customerSelect.replaceChildren(new Option("Select Customer", ""));
  if (!customerRecords.length) {
    const emptyOption = new Option("No customers found", "");
    emptyOption.disabled = true;
    customerSelect.add(emptyOption);
  } else {
    customerRecords.forEach((customer) => customerSelect.add(new Option(customer.name, customer.name)));
  }
  customerSelect.value = customerRecords.some((customer) => customer.name === selectedName) ? selectedName : "";
}

async function refreshCustomerOptions(selectedName = "") {
  customerRecords = await loadPackagingCustomers();
  renderCustomerOptions(selectedName);
}

function showReceiptStatus(message, isError = false) {
  const banner = document.querySelector("#successBanner");
  banner.classList.toggle("error", isError);
  document.querySelector("#successMessage").textContent = message;
  banner.classList.add("visible");
}

function updateTimestamp() {
  document.querySelector("#receivedAt").value = new Intl.DateTimeFormat("en-IN", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit"
  }).format(new Date());
}

function makeRow() {
  const row = document.createElement("tr");
  row.innerHTML = `
    <td><select class="material-input" aria-label="Packaging material"><option value="">Select packaging material</option></select><span class="row-error material-error"></span></td>
    <td><input class="qty-input" type="number" min="0.01" step="any" aria-label="Received quantity" placeholder="0"><span class="row-error quantity-error"></span></td>
    <td><select class="unit-input" aria-label="Unit"><option value="">Select unit</option>${unitNames.map((unit) => `<option>${unit}</option>`).join("")}</select><span class="row-error unit-error"></span></td>
    <td><button class="row-remove" type="button" aria-label="Remove material row"><i class="fa-solid fa-trash-can"></i></button></td>`;
  row.querySelector(".row-remove").addEventListener("click", () => {
    row.remove();
    syncRowsEmpty();
    clearSuccess();
  });
  row.querySelectorAll("input, select").forEach((field) => field.addEventListener(field.tagName === "SELECT" ? "change" : "input", () => {
    row.classList.remove("row-invalid");
    row.querySelectorAll(".row-error").forEach((error) => { error.textContent = ""; });
    clearSuccess();
  }));
  const materialSelect = row.querySelector(".material-input");
  materialNames.forEach((material) => materialSelect.add(new Option(material, material)));
  materialRows.append(row);
  syncRowsEmpty();
  return row;
}

function syncRowsEmpty() {
  rowsEmpty.hidden = materialRows.children.length > 0;
}

function clearSuccess() {
  document.querySelector("#successBanner").classList.remove("visible");
}

function showError(row, selector, message) {
  row.querySelector(selector).textContent = message;
  row.classList.add("row-invalid");
}

document.querySelector("#addRow").addEventListener("click", () => {
  const row = makeRow();
  row.querySelector(".material-input").focus();
  clearSuccess();
});

document.querySelector("#showAddMaterial").addEventListener("click", () => {
  const panel = document.querySelector("#newMaterialPanel");
  panel.hidden = !panel.hidden;
  if (!panel.hidden) document.querySelector("#newMaterialInput").focus();
});

document.querySelector("#confirmAddMaterial").addEventListener("click", () => {
  const input = document.querySelector("#newMaterialInput");
  const name = input.value.trim();
  if (!name) {
    input.setCustomValidity("Enter a material name.");
    input.reportValidity();
    return;
  }
  input.setCustomValidity("");
  if (!materialNames.some((material) => material.toLowerCase() === name.toLowerCase())) {
    materialNames.push(name);
    materialRows.querySelectorAll(".material-input").forEach((select) => select.add(new Option(name, name)));
  }
  let targetRow = materialRows.lastElementChild;
  if (!targetRow) targetRow = makeRow();
  targetRow.querySelector(".material-input").value = name;
  input.value = "";
  document.querySelector("#newMaterialPanel").hidden = true;
  clearSuccess();
});

customerSelect.addEventListener("change", () => {
  customerField.classList.remove("invalid");
  document.querySelector("#customerError").textContent = "";
  clearSuccess();
});

function openCustomerDialog() {
  document.querySelector("#customerDialogError").textContent = "";
  customerForm.reset();
  customerDialog.showModal();
  document.querySelector("#newCustomerName").focus();
}

document.querySelector("#addCustomerButton").addEventListener("click", openCustomerDialog);
document.querySelector("#cancelAddCustomer").addEventListener("click", () => customerDialog.close());
customerDialog.addEventListener("click", (event) => {
  if (event.target === customerDialog) customerDialog.close();
});
customerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = document.querySelector("#newCustomerName").value.trim();
  const error = document.querySelector("#customerDialogError");
  if (!name) {
    error.textContent = "Enter a customer name.";
    return;
  }
  const submitButton = document.querySelector("#saveNewCustomer");
  submitButton.disabled = true;
  error.textContent = "";
  try {
    const customer = await addPackagingCustomer(name);
    await refreshCustomerOptions(customer.name);
    customerDialog.close();
    customerSelect.focus();
    clearSuccess();
  } catch (saveError) {
    console.error("Unable to add customer.", saveError);
    error.textContent = saveError.message || "Customer could not be added. Please try again.";
  } finally {
    submitButton.disabled = false;
  }
});

document.querySelector("#referenceInput").addEventListener("input", clearSuccess);
document.querySelector("#remarkInput").addEventListener("input", clearSuccess);

receiptForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearSuccess();
  const customer = customerSelect.value.trim();
  const customerValid = customerRecords.some((record) => record.name === customer);
  customerField.classList.toggle("invalid", !customerValid);
  document.querySelector("#customerError").textContent = customerValid ? "" : "Select a customer from the list.";

  let valid = customerValid && materialRows.children.length > 0;
  [...materialRows.children].forEach((row) => {
    const materialInput = row.querySelector(".material-input");
    const quantityInput = row.querySelector(".qty-input");
    const unitInput = row.querySelector(".unit-input");
    let rowValid = true;
    if (!materialInput.value.trim()) {
      showError(row, ".material-error", "Select a material.");
      rowValid = false;
    }
    if (!quantityInput.value || Number(quantityInput.value) <= 0) {
      showError(row, ".quantity-error", "Enter a quantity above zero.");
      rowValid = false;
    }
    if (!unitInput.value) {
      showError(row, ".unit-error", "Select a unit.");
      rowValid = false;
    }
    valid = valid && rowValid;
  });

  if (!materialRows.children.length) {
    rowsEmpty.textContent = "Add at least one packaging material before saving.";
    rowsEmpty.hidden = false;
  } else {
    rowsEmpty.textContent = "No materials added yet. Use “Add row” to start this receipt.";
  }
  if (!valid) {
    const firstInvalid = receiptForm.querySelector(".invalid select, .invalid input, .row-invalid input, .row-invalid select");
    firstInvalid?.focus();
    return;
  }

  const count = materialRows.children.length;
  const submitButton = receiptForm.querySelector("button[type=submit]");
  submitButton.disabled = true;
  submitButton.textContent = "Saving...";
  try {
    await savePackagingStockReceipt({
      customer,
      reference: document.querySelector("#referenceInput").value.trim(),
      remark: document.querySelector("#remarkInput").value.trim(),
      materials: [...materialRows.children].map((row) => ({
        material: row.querySelector(".material-input").value.trim(),
        quantity: Number(row.querySelector(".qty-input").value),
        unit: row.querySelector(".unit-input").value
      }))
    });
    showReceiptStatus(`Packaging stock updated for ${customer}.`);
    document.querySelector("#successBanner").scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (saveError) {
    console.error("Unable to save packaging receipt.", saveError);
    showReceiptStatus(saveError.message || "Receipt could not be saved. Please try again.", true);
  } finally {
    submitButton.disabled = false;
    submitButton.innerHTML = '<i class="fa-solid fa-check"></i> Save Receipt';
  }
});

const sidebar = document.querySelector("#sidebar");
const mobileMenuToggle = document.querySelector("#mobileMenuToggle");
mobileMenuToggle.addEventListener("click", () => {
  const open = sidebar.classList.toggle("open");
  mobileMenuToggle.setAttribute("aria-expanded", String(open));
  mobileMenuToggle.setAttribute("aria-label", open ? "Close navigation menu" : "Open navigation menu");
});

updateTimestamp();
makeRow();
refreshCustomerOptions().catch((error) => {
  console.error("Unable to load customer master data.", error);
  renderCustomerOptions();
  document.querySelector("#customerError").textContent = "Customer list could not be loaded. Check your connection and try again.";
});