import { db, storage } from "./firebase-config.js";
import {
  collection,
  doc,
  serverTimestamp,
  setDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  deleteObject,
  getDownloadURL,
  ref,
  uploadBytes
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

const form = document.getElementById("inwardForm");
const formMessage = document.getElementById("formMessage");
const submitButton = form.querySelector("button[type=submit]");
const receivedAs = document.getElementById("receivedAs");
const invoiceUpload = document.getElementById("invoiceUpload");
const supplierCoa = document.getElementById("supplierCoa");

function showMessage(message, color = "var(--danger)") {
  formMessage.textContent = message;
  formMessage.style.color = color;
}

function setFieldValidity(field, valid) {
  field.style.borderColor = valid ? "var(--border)" : "var(--danger)";
}

function positiveNumber(id, label) {
  const field = document.getElementById(id);
  const value = Number(field.value);
  const valid = field.value.trim() !== "" && Number.isFinite(value) && value > 0;
  setFieldValidity(field, valid);
  return valid ? value : { error: `${label} must be greater than 0.` };
}

function calculateQuantity() {
  const type = receivedAs.value;

  if (type === "drums") {
    const containers = positiveNumber("totalDrums", "Total drums");
    const quantity = positiveNumber("qtyPerDrum", "Quantity per drum");
    if (typeof containers !== "number") return containers;
    if (typeof quantity !== "number") return quantity;
    const declaredQuantity = containers * quantity;
    document.getElementById("totalDeclaredQty").value = declaredQuantity.toFixed(2);
    return { declaredQuantity, unit: "kg", totalContainers: containers, qtyPerContainer: quantity };
  }

  if (type === "ibc") {
    const containers = positiveNumber("noOfIbcs", "Number of IBCs");
    const quantity = positiveNumber("qtyPerIbc", "Quantity per IBC");
    if (typeof containers !== "number") return containers;
    if (typeof quantity !== "number") return quantity;
    const declaredQuantity = containers * quantity;
    document.getElementById("calculatedQtyIbc").value = declaredQuantity.toFixed(2);
    return { declaredQuantity, unit: "L", totalContainers: containers, qtyPerContainer: quantity };
  }

  if (type === "tanker") {
    const quantity = positiveNumber("invoiceQty", "Tanker quantity");
    const unit = document.getElementById("invoiceUnit");
    const validUnit = Boolean(unit.value);
    setFieldValidity(unit, validUnit);
    if (typeof quantity !== "number") return quantity;
    if (!validUnit) return { error: "Please select a tanker quantity unit." };
    document.getElementById("calculatedQtyTanker").value = quantity.toFixed(2);
    return { declaredQuantity: quantity, unit: unit.value, totalContainers: null, qtyPerContainer: null };
  }

  if (type === "other") {
    const quantity = positiveNumber("otherQuantity", "Quantity");
    if (typeof quantity !== "number") return quantity;
    return { declaredQuantity: quantity, unit: "Other", totalContainers: null, qtyPerContainer: null };
  }

  return { error: "Please select how the material was received." };
}

function validateRequiredFields() {
  const requiredIds = ["supplier", "product", "receivingLocation", "receivedAs"];
  let valid = true;

  requiredIds.forEach((id) => {
    const field = document.getElementById(id);
    const fieldValid = Boolean(field.value);
    setFieldValidity(field, fieldValid);
    valid = fieldValid && valid;
  });

  if (!valid) showMessage("Please complete all required fields before receiving the material.");
  return valid;
}

const MAX_FILE_SIZE = 10 * 1024 * 1024;

function validateFile(file, label) {
  if (!file) return null;
  const allowedTypes = new Set([
    "application/pdf",
    "image/jpeg",
    "image/png",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  ]);

  if (!allowedTypes.has(file.type)) {
    return `${label} must be a PDF or a supported document/image file.`;
  }
  if (file.size <= 0 || file.size > MAX_FILE_SIZE) {
    return `${label} must be smaller than 10 MB.`;
  }
  return null;
}

async function uploadDocument(file, folder, inwardId, uploadedRefs) {
  if (!file) return "";
  const filePath = `CCPL-IMS/${folder}/${inwardId}/${file.name}`;
  const fileRef = ref(storage, filePath);
  await uploadBytes(fileRef, file, { contentType: file.type });
  uploadedRefs.push(fileRef);
  return getDownloadURL(fileRef);
}

async function deleteUploadedFiles(uploadedRefs) {
  await Promise.all(uploadedRefs.map(async (fileRef) => {
    try {
      await deleteObject(fileRef);
    } catch (error) {
      console.error("Unable to clean up uploaded inward document.", error);
    }
  }));
}

function resetForm() {
  form.reset();
  receivedAs.dispatchEvent(new Event("change"));
  document.getElementById("totalDeclaredQty").value = "";
  document.getElementById("calculatedQtyIbc").value = "";
  document.getElementById("calculatedQtyTanker").value = "";
  document.getElementById("invoiceFileName").textContent = "No file selected";
  document.getElementById("coaFileName").textContent = "No file selected";
  form.querySelectorAll("input, select").forEach((field) => {
    field.style.borderColor = "var(--border)";
  });
}

["calculateDrumsBtn", "calculateIbcBtn", "calculateTankerBtn"].forEach((id) => {
  document.getElementById(id).addEventListener("click", () => {
    const result = calculateQuantity();
    if (result.error) showMessage(result.error);
    else showMessage(`Calculated quantity: ${result.declaredQuantity} ${result.unit}.`, "var(--success)");
  });
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (submitButton.disabled) return;
  showMessage("");

  if (!validateRequiredFields()) return;
  const quantity = calculateQuantity();
  if (quantity.error) {
    showMessage(quantity.error);
    return;
  }

  const invoiceFile = invoiceUpload.files[0];
  const coaFile = supplierCoa.files[0];
  const invoiceValidationError = validateFile(invoiceFile, "Invoice");
  const coaValidationError = validateFile(coaFile, "Supplier COA");
  if (invoiceValidationError) {
    showMessage(invoiceValidationError);
    return;
  }
  if (coaValidationError) {
    showMessage(coaValidationError);
    return;
  }

  submitButton.disabled = true;
  submitButton.textContent = "Saving...";

  const inwardRef = doc(collection(db, "inward"));
  const data = {
    supplier: document.getElementById("supplier").value,
    product: document.getElementById("product").value,
    vehicleNo: document.getElementById("vehicleNo").value.trim(),
    invoiceChallanNo: document.getElementById("invoiceChallanNo").value.trim(),
    receivingLocation: document.getElementById("receivingLocation").value,
    supplierLotNo: document.getElementById("supplierLotNo").value.trim(),
    receivedAs: receivedAs.value,
    totalContainers: quantity.totalContainers,
    qtyPerContainer: quantity.qtyPerContainer,
    declaredQuantity: quantity.declaredQuantity,
    unit: quantity.unit,
    status: "KANTA PENDING",
    invoiceFileUrl: "",
    coaFileUrl: "",
    createdAt: serverTimestamp()
  };

  const uploadedRefs = [];

  try {
    try {
      data.invoiceFileUrl = await uploadDocument(invoiceFile, "invoices", inwardRef.id, uploadedRefs);
    } catch (error) {
      console.error("Invoice upload failed.", error);
      await deleteUploadedFiles(uploadedRefs);
      showMessage("Invoice upload failed.");
      return;
    }

    try {
      data.coaFileUrl = await uploadDocument(coaFile, "supplier-coa", inwardRef.id, uploadedRefs);
    } catch (error) {
      console.error("Supplier COA upload failed.", error);
      await deleteUploadedFiles(uploadedRefs);
      showMessage("Supplier COA upload failed.");
      return;
    }

    await setDoc(inwardRef, data);
    showMessage(`Material received successfully. Inward ID: ${inwardRef.id}`, "var(--success)");
    resetForm();
  } catch (error) {
    console.error("Unable to save inward record.", error);
    await deleteUploadedFiles(uploadedRefs);
    showMessage("Unable to save inward record.");
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Receive Material";
  }
});
