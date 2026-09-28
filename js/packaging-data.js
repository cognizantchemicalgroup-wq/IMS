import { db } from "./firebase-config.js";
import {
  collection,
  doc,
  getDocs,
  limit,
  orderBy,
  query,
  runTransaction,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export const OUTWARD_PACKAGING_RULE = [
  { material_name: "Empty Box", quantity_per_box: 1, unit: "Pieces" },
  { material_name: "2.5 Litre Bottle", quantity_per_box: 4, unit: "Pieces" },
  { material_name: "Thermocol", quantity_per_box: 2, unit: "Pieces" },
  { material_name: "Box Plate", quantity_per_box: 2, unit: "Pieces" }
];

function valueOf(record, ...keys) {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null && record[key] !== "") return record[key];
  }
  return "";
}

function normalizedName(value) {
  return String(value ?? "").trim().normalize("NFKC");
}

function idPart(value) {
  const encoded = encodeURIComponent(normalizedName(value).toLowerCase());
  return `${encoded.length}_${encoded}`;
}

export function packagingEntityId(value) {
  return idPart(value);
}

export function packagingStockId(customerId, materialId) {
  return `${idPart(customerId)}__${idPart(materialId)}`;
}

function packagingUnitStockId(customerId, materialId, unit) {
  return `${packagingStockId(customerId, materialId)}__${idPart(unit)}`;
}

function receiptIdFor(customerId, reference, lines) {
  const identity = normalizedName(reference)
    ? `reference|${customerId}|${normalizedName(reference).toLocaleLowerCase()}`
    : `lines|${customerId}|${lines.map((line) => `${line.material_id}|${line.unit.toLowerCase()}|${line.quantity}`).sort().join(";")}`;
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < identity.length; index += 1) {
    const code = identity.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `receipt_${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

function positiveQuantity(value, label) {
  const quantity = Number(value);
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error(`${label} must be greater than zero.`);
  return quantity;
}

function getAvailablePackaging(stock) {
  const raw = valueOf(stock, "available_quantity", "availableQuantity", "current_stock", "currentStock");
  const available = raw === "" ? Number.NaN : Number(raw);
  if (!Number.isFinite(available) || available < 0) throw new Error("Packaging stock record has an invalid available quantity.");
  return available;
}

function getProductQuantity(stock) {
  const raw = valueOf(stock, "current_stock", "currentStock", "available_quantity", "availableQuantity", "quantity");
  const quantity = raw === "" ? Number.NaN : Number(raw);
  if (!Number.isFinite(quantity) || quantity < 0) throw new Error("Product stock record has an invalid available quantity.");
  return quantity;
}

export async function loadPackagingStock() {
  const snapshot = await getDocs(collection(db, "packaging_stock"));
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
}

export async function loadPackagingCustomers() {
  const snapshot = await getDocs(collection(db, "customers"));
  return snapshot.docs
    .map((item) => ({ id: item.id, ...item.data(), name: normalizedName(valueOf(item.data(), "name", "customer_name", "customerName", "customer", "display_name")) }))
    .filter((customer) => customer.name && customer.active !== false && customer.is_active !== false && String(customer.status || "ACTIVE").toUpperCase() !== "INACTIVE")
    .sort((first, second) => first.name.localeCompare(second.name));
}

export async function addPackagingCustomer(value) {
  const name = normalizedName(value);
  if (!name) throw new Error("Enter a customer name.");

  const customers = await getDocs(collection(db, "customers"));
  const existing = customers.docs.find((item) => normalizedName(valueOf(item.data(), "name", "customer_name", "customerName", "customer", "display_name")).toLocaleLowerCase() === name.toLocaleLowerCase());
  if (existing) return { id: existing.id, ...existing.data(), name: normalizedName(valueOf(existing.data(), "name", "customer_name", "customerName", "customer", "display_name")) };

  const customerRef = doc(db, "customers", packagingEntityId(name));
  const timestamp = serverTimestamp();
  return runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(customerRef);
    if (snapshot.exists()) return { id: snapshot.id, ...snapshot.data(), name: normalizedName(valueOf(snapshot.data(), "name", "customer_name", "customerName", "customer", "display_name")) };
    const customer = { id: customerRef.id, name, active: true, status: "ACTIVE", created_at: timestamp };
    transaction.set(customerRef, customer);
    return customer;
  });
}

export async function savePackagingStockReceipt(payload) {
  const customerName = normalizedName(payload.customer);
  if (!customerName) throw new Error("Select a customer.");
  if (!Array.isArray(payload.materials) || payload.materials.length === 0) throw new Error("Add at least one packaging material.");

  const customerId = packagingEntityId(customerName);
  const reference = normalizedName(payload.reference);
  const remark = normalizedName(payload.remark);
  const receiptLines = payload.materials.map((line) => {
    const materialName = normalizedName(line.material);
    const unit = normalizedName(line.unit);
    const quantity = positiveQuantity(line.quantity, "Received quantity");
    if (!materialName) throw new Error("Packaging material is required.");
    if (!unit) throw new Error("Unit is required.");
    return { material_id: packagingEntityId(materialName), material_name: materialName, quantity, unit };
  });
  const receiptId = receiptIdFor(customerId, reference, receiptLines);
  const receiptRef = doc(db, "packaging_receipts", receiptId);
  const transactionRefs = receiptLines.map((_, index) => doc(db, "packaging_transactions", `${receiptId}_${index + 1}_IN`));
  const entriesByStock = new Map();
  receiptLines.forEach((line) => {
    const unitStockId = packagingUnitStockId(customerId, line.material_id, line.unit);
    const entry = entriesByStock.get(unitStockId);
    if (entry) entry.quantity += line.quantity;
    else entriesByStock.set(unitStockId, {
      materialId: line.material_id,
      materialName: line.material_name,
      unit: line.unit,
      quantity: line.quantity,
      unitStockId,
      legacyStockId: packagingStockId(customerId, line.material_id)
    });
  });

  const entries = [...entriesByStock.values()];
  const references = new Map();
  entries.forEach((entry) => {
    [entry.legacyStockId, entry.unitStockId].forEach((id) => references.set(id, doc(db, "packaging_stock", id)));
  });
  await runTransaction(db, async (transaction) => {
    const stockRefs = [...references.values()];
    const refs = [receiptRef, ...stockRefs, ...transactionRefs];
    const snapshots = await Promise.all(refs.map((reference) => transaction.get(reference)));
    if (snapshots[0].exists()) throw new Error("This receipt has already been saved.");
    const stockSnapshots = snapshots.slice(1, 1 + stockRefs.length);
    const transactionSnapshots = snapshots.slice(1 + stockRefs.length);
    if (transactionSnapshots.some((snapshot) => snapshot.exists())) throw new Error("History transactions already exist for this receipt.");
    const snapshotById = new Map(stockRefs.map((reference, index) => [reference.id, stockSnapshots[index]]));
    const updates = entries.map((entry) => {
      const legacySnapshot = snapshotById.get(entry.legacyStockId);
      const unitSnapshot = snapshotById.get(entry.unitStockId);
      const legacyUnit = legacySnapshot?.exists() ? normalizedName(valueOf(legacySnapshot.data(), "unit")) : "";
      const targetRef = legacySnapshot?.exists() && legacyUnit.toLowerCase() === entry.unit.toLowerCase()
        ? references.get(entry.legacyStockId)
        : references.get(entry.unitStockId);
      const targetSnapshot = targetRef.id === entry.legacyStockId ? legacySnapshot : unitSnapshot;
      const previous = targetSnapshot?.exists() ? targetSnapshot.data() : {};
      if (targetSnapshot?.exists() && normalizedName(valueOf(previous, "unit")).toLowerCase() !== entry.unit.toLowerCase()) {
        throw new Error(`${entry.materialName} already has a stock record with a different unit.`);
      }
      const receivedValue = valueOf(previous, "received_quantity", "receivedQuantity");
      const consumedValue = valueOf(previous, "consumed_quantity", "consumedQuantity");
      const availableValue = valueOf(previous, "available_quantity", "availableQuantity", "current_stock", "currentStock");
      const consumed = consumedValue === "" ? 0 : Number(consumedValue);
      const available = availableValue === "" ? 0 : Number(availableValue);
      const received = receivedValue === "" ? available + consumed : Number(receivedValue);
      if (![received, consumed, available].every(Number.isFinite) || received < 0 || consumed < 0 || available < 0) {
        throw new Error(`${entry.materialName} stock totals are invalid. The receipt was not saved.`);
      }
      return { entry, targetRef, previous, received, consumed, available };
    });

    const timestamp = serverTimestamp();
    updates.forEach(({ entry, targetRef, previous, received, consumed, available }) => {
      transaction.set(targetRef, {
        id: targetRef.id,
        customer_id: customerId,
        customer_name: customerName,
        material_id: entry.materialId,
        material_name: entry.materialName,
        unit: entry.unit,
        received_quantity: received + entry.quantity,
        consumed_quantity: consumed,
        available_quantity: available + entry.quantity,
        created_at: valueOf(previous, "created_at", "createdAt") || timestamp,
        updated_at: timestamp,
        last_transaction_id: transactionRefs[receiptLines.findIndex((line) => line.material_id === entry.materialId && line.unit.toLowerCase() === entry.unit.toLowerCase())].id
      }, { merge: true });
    });

    transaction.set(receiptRef, {
      id: receiptId,
      customer_id: customerId,
      customer_name: customerName,
      reference,
      remark,
      materials: receiptLines,
      status: "RECEIVED",
      created_at: timestamp
    });
    receiptLines.forEach((line, index) => {
      transaction.set(transactionRefs[index], {
        id: transactionRefs[index].id,
        customer_id: customerId,
        customer_name: customerName,
        material_id: line.material_id,
        material_name: line.material_name,
        transaction_type: "IN",
        quantity: line.quantity,
        unit: line.unit,
        reference_id: receiptId,
        reference: reference || receiptId,
        reference_type: "PACKAGING_RECEIPT",
        receipt_id: receiptId,
        created_at: timestamp,
        remark
      });
    });
  });
  return receiptId;
}

export async function loadPackagingConfigurations() {
  const snapshot = await getDocs(query(collection(db, "packaging_configurations"), orderBy("created_at", "desc")));
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
}

export async function loadPackagingTransactions() {
  const snapshot = await getDocs(query(collection(db, "packaging_transactions"), orderBy("created_at", "desc"), limit(500)));
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
}

export async function loadProductStock() {
  const snapshot = await getDocs(collection(db, "stock"));
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
    .filter((item) => valueOf(item, "product_id", "productId", "product_name", "productName", "product"));
}

export async function loadOutwardRecords() {
  const snapshot = await getDocs(query(collection(db, "outward"), orderBy("created_at", "desc"), limit(100)));
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
}

export async function savePackagingReceipt(payload) {
  const customerName = normalizedName(payload.customer);
  if (!customerName) throw new Error("Select a customer.");
  if (!Array.isArray(payload.materials) || payload.materials.length === 0) throw new Error("Add at least one packaging material.");

  const receiptLines = payload.materials.map((line) => {
    const materialName = normalizedName(line.material);
    const quantity = positiveQuantity(line.quantity, "Received quantity");
    const unit = normalizedName(line.unit);
    if (!materialName) throw new Error("Packaging material is required.");
    if (!unit) throw new Error("Unit is required.");
    return { material_id: packagingEntityId(materialName), material_name: materialName, quantity, unit };
  });
  const customerId = packagingEntityId(customerName);
  const receiptRef = doc(collection(db, "packaging_receipts"));
  const timestamp = serverTimestamp();
  const stockEntries = new Map();
  receiptLines.forEach((line) => {
    const stockId = packagingStockId(customerId, line.material_id);
    const current = stockEntries.get(stockId);
    if (current && current.unit.toLowerCase() !== line.unit.toLowerCase()) {
      throw new Error(`${line.material_name} has conflicting units in this receipt.`);
    }
    if (current) current.quantity += line.quantity;
    else stockEntries.set(stockId, { ...line, quantity: line.quantity, stockId });
  });

  const stockRefs = [...stockEntries.values()].map((entry) => doc(db, "packaging_stock", entry.stockId));
  const transactionRefs = receiptLines.map((_, index) => doc(db, "packaging_transactions", `${receiptRef.id}_${index + 1}_IN`));
  await runTransaction(db, async (transaction) => {
    const refs = [receiptRef, ...stockRefs, ...transactionRefs];
    const snapshots = await Promise.all(refs.map((reference) => transaction.get(reference)));
    if (snapshots[0].exists()) throw new Error("This packaging receipt already exists.");
    const stockSnapshots = snapshots.slice(1, 1 + stockRefs.length);
    const transactionSnapshots = snapshots.slice(1 + stockRefs.length);
    if (transactionSnapshots.some((snapshot) => snapshot.exists())) throw new Error("This receipt has already been recorded.");

    stockSnapshots.forEach((snapshot, index) => {
      const entry = [...stockEntries.values()][index];
      const previous = snapshot.exists() ? snapshot.data() : {};
      if (snapshot.exists() && String(valueOf(previous, "unit")).toLowerCase() !== entry.unit.toLowerCase()) {
        throw new Error(`${entry.material_name} stock is stored as ${valueOf(previous, "unit") || "an unknown unit"}; the receipt unit does not match.`);
      }
      const available = snapshot.exists() ? getAvailablePackaging(previous) : 0;
      const received = Number(valueOf(previous, "received_quantity", "receivedQuantity") || 0);
      const consumed = Number(valueOf(previous, "consumed_quantity", "consumedQuantity") || 0);
      if (!Number.isFinite(received) || received < 0 || !Number.isFinite(consumed) || consumed < 0) {
        throw new Error("Packaging stock totals are invalid; the receipt was not saved.");
      }
      transaction.set(stockRefs[index], {
        id: entry.stockId,
        customer_id: customerId,
        customer_name: customerName,
        material_id: entry.material_id,
        material_name: entry.material_name,
        unit: entry.unit,
        received_quantity: received + entry.quantity,
        consumed_quantity: consumed,
        available_quantity: available + entry.quantity,
        created_at: valueOf(previous, "created_at", "createdAt") || timestamp,
        updated_at: timestamp,
        last_transaction_id: transactionRefs[receiptLines.findIndex((line) => line.material_id === entry.material_id)]?.id || ""
      }, { merge: true });
    });

    transaction.set(receiptRef, {
      id: receiptRef.id,
      customer_id: customerId,
      customer_name: customerName,
      reference: normalizedName(payload.reference),
      remark: normalizedName(payload.remark),
      materials: receiptLines,
      status: "RECEIVED",
      created_at: timestamp,
    });
    receiptLines.forEach((line, index) => {
      transaction.set(transactionRefs[index], {
        id: transactionRefs[index].id,
        customer_id: customerId,
        customer_name: customerName,
        material_id: line.material_id,
        material_name: line.material_name,
        transaction_type: "IN",
        quantity: line.quantity,
        unit: line.unit,
        reference_id: receiptRef.id,
        reference: normalizedName(payload.reference) || receiptRef.id,
        reference_type: "PACKAGING_RECEIPT",
        receipt_id: receiptRef.id,
        created_at: timestamp,
        remark: normalizedName(payload.remark)
      });
    });
  });
  return receiptRef.id;
}

export async function savePackagingConfiguration(configuration) {
  const name = normalizedName(configuration.name);
  const customerName = normalizedName(configuration.customer);
  const productName = normalizedName(configuration.product);
  if (!name) throw new Error("Configuration Name is required.");
  if (!customerName) throw new Error("Customer is required.");
  if (!productName) throw new Error("Product is required.");
  if (!Array.isArray(configuration.materials) || configuration.materials.length === 0) {
    throw new Error("At least one packaging material is required.");
  }
  const materials = configuration.materials.map((line) => {
    const materialName = normalizedName(line.material_name || line.material);
    const quantity = positiveQuantity(line.quantity_per_box ?? line.quantity, "Quantity per box");
    const unit = normalizedName(line.unit);
    if (!materialName) throw new Error("Packaging Material is required.");
    if (!unit) throw new Error("Unit is required.");
    return { material_id: packagingEntityId(materialName), material_name: materialName, quantity_per_box: quantity, unit };
  });
  const configurationRef = configuration.id
    ? doc(db, "packaging_configurations", configuration.id)
    : doc(collection(db, "packaging_configurations"));
  const timestamp = serverTimestamp();
  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(configurationRef);
    transaction.set(configurationRef, {
      id: configurationRef.id,
      name,
      customer_id: packagingEntityId(customerName),
      customer_name: customerName,
      product_id: normalizedName(configuration.product_id || "") || null,
      product_name: productName,
      materials,
      status: "ACTIVE",
      active: true,
      created_at: snapshot.exists() ? valueOf(snapshot.data(), "created_at", "createdAt") || timestamp : timestamp,
      updated_at: timestamp,
    }, { merge: true });
  });
  return { id: configurationRef.id, name, customer: customerName, product: productName, materials, status: "ACTIVE" };
}

export async function saveOutwardDraft(payload, existingId = "") {
  const customerName = normalizedName(payload.customer);
  const productName = normalizedName(payload.product_name);
  const location = normalizedName(payload.location);
  const productStockId = normalizedName(payload.product_stock_id);
  const boxes = Number(payload.number_of_boxes);
  const productQuantity = positiveQuantity(payload.product_quantity, "Product quantity");
  if (!customerName) throw new Error("Customer is required.");
  if (!productName) throw new Error("Product is required.");
  if (!location || !productStockId) throw new Error("Select a valid product stock location.");
  if (!Number.isInteger(boxes) || boxes <= 0) throw new Error("Number of boxes must be a whole number greater than zero.");
  const outwardRef = existingId ? doc(db, "outward", existingId) : doc(collection(db, "outward"));
  const timestamp = serverTimestamp();
  await runTransaction(db, async (transaction) => {
    const [outwardSnapshot, productStockSnapshot] = await Promise.all([
      transaction.get(outwardRef),
      transaction.get(doc(db, "stock", productStockId))
    ]);
    if (outwardSnapshot.exists() && String(valueOf(outwardSnapshot.data(), "status")).toUpperCase() !== "DRAFT") {
      throw new Error("Only a draft Outward can be edited.");
    }
    if (!productStockSnapshot.exists()) throw new Error("The selected product stock record no longer exists.");
    const stock = productStockSnapshot.data();
    if (valueOf(stock, "receiving_location", "location") !== location) throw new Error("Selected product stock location changed. Refresh and try again.");
    transaction.set(outwardRef, {
      id: outwardRef.id,
      status: "DRAFT",
      customer_id: packagingEntityId(customerName),
      customer_name: customerName,
      product_id: valueOf(stock, "product_id", "productId") || null,
      product_name: productName,
      from_company: normalizedName(payload.from_company),
      product_stock_id: productStockId,
      product_quantity: productQuantity,
      product_unit: valueOf(stock, "unit", "quantity_unit", "quantityUnit"),
      receiving_location: location,
      against_po_number: normalizedName(payload.against_po_number),
      number_of_boxes: boxes,
      packaging_stock_updated: false,
      created_at: outwardSnapshot.exists() ? valueOf(outwardSnapshot.data(), "created_at", "createdAt") || timestamp : timestamp,
      updated_at: timestamp,
    }, { merge: true });
  });
  return outwardRef.id;
}

export async function finalizeOutward(outwardId) {
  if (!outwardId) throw new Error("Save this Outward as a draft before finalizing.");
  const outwardRef = doc(db, "outward", outwardId);

  return runTransaction(db, async (transaction) => {
    const outwardSnapshot = await transaction.get(outwardRef);
    if (!outwardSnapshot.exists()) throw new Error("The Outward record was not found.");
    const outward = outwardSnapshot.data();
    const status = String(valueOf(outward, "status")).toUpperCase();
    if (status === "DISPATCHED" && outward.packaging_stock_updated === true) {
      return { id: outwardId, alreadyFinalized: true };
    }
    if (status !== "DRAFT") throw new Error("Only a draft Outward can be finalized.");
    if (outward.packaging_stock_updated === true || valueOf(outward, "packaging_transaction_ids").length) {
      throw new Error("Packaging transactions already exist for this Outward. Contact an administrator before retrying.");
    }

    const boxes = Number(outward.number_of_boxes);
    const productQuantity = positiveQuantity(outward.product_quantity, "Product quantity");
    if (!Number.isInteger(boxes) || boxes <= 0) throw new Error("Number of boxes must be a whole number greater than zero.");
    const productStockRef = doc(db, "stock", outward.product_stock_id);
    const productStockSnapshot = await transaction.get(productStockRef);
    if (!productStockSnapshot.exists()) throw new Error("The selected product stock record is missing.");
    const productStock = productStockSnapshot.data();
    const stockProductId = valueOf(productStock, "product_id", "productId");
    const stockProductName = valueOf(productStock, "product_name", "product", "productName");
    const stockLocation = valueOf(productStock, "receiving_location", "location", "receivingLocation");
    const stockUnit = valueOf(productStock, "unit", "quantity_unit", "quantityUnit");
    if (stockProductName !== outward.product_name || stockLocation !== outward.receiving_location) {
      throw new Error("Product stock identity no longer matches the saved Outward.");
    }
    if (outward.product_id && stockProductId && outward.product_id !== stockProductId) throw new Error("Product ID does not match the saved Outward.");
    if (!stockUnit || stockUnit !== outward.product_unit) throw new Error("Product stock unit changed. Refresh and save the draft again.");
    const availableProduct = getProductQuantity(productStock);
    if (availableProduct < productQuantity) throw new Error(`Insufficient product stock. Available: ${availableProduct} ${stockUnit}, Required: ${productQuantity} ${stockUnit}.`);

    const materialRequirements = OUTWARD_PACKAGING_RULE.map((line) => ({
      materialId: packagingEntityId(line.material_name),
      materialName: line.material_name,
      perBox: line.quantity_per_box,
      required: line.quantity_per_box * boxes,
      unit: line.unit
    }));

    const packageStockRefs = materialRequirements.map((item) => ({
      legacy: doc(db, "packaging_stock", packagingStockId(outward.customer_id, item.materialId)),
      unit: doc(db, "packaging_stock", packagingUnitStockId(outward.customer_id, item.materialId, item.unit))
    }));
    const productLedgerId = `${outwardId}_OUT`;
    const productLedgerRef = doc(db, "stockLedger", productLedgerId);
    const packagingTransactionRefs = materialRequirements.map((item) => doc(db, "packaging_transactions", `${outwardId}__${idPart(item.materialId)}__OUT`));
    const readRefs = [...packageStockRefs.flatMap((references) => [references.legacy, references.unit]), productLedgerRef, ...packagingTransactionRefs];
    const readSnapshots = await Promise.all(readRefs.map((reference) => transaction.get(reference)));
    const packageSnapshots = materialRequirements.map((_, index) => ({
      legacy: readSnapshots[index * 2],
      unit: readSnapshots[index * 2 + 1]
    }));
    const productLedgerSnapshot = readSnapshots[packageStockRefs.length * 2];
    const packagingTransactionSnapshots = readSnapshots.slice(packageStockRefs.length * 2 + 1);
    if (productLedgerSnapshot.exists() || packagingTransactionSnapshots.some((snapshot) => snapshot.exists())) {
      throw new Error("A stock transaction already exists for this Outward. No additional deduction was made.");
    }

    const deductions = materialRequirements.map((requirement, index) => {
      const candidates = packageSnapshots[index];
      const legacyUnit = candidates.legacy.exists() ? normalizedName(valueOf(candidates.legacy.data(), "unit")) : "";
      const stockSnapshot = candidates.legacy.exists() && legacyUnit.toLowerCase() === requirement.unit.toLowerCase()
        ? candidates.legacy
        : candidates.unit;
      const stockRef = stockSnapshot === candidates.legacy ? packageStockRefs[index].legacy : packageStockRefs[index].unit;
      if (!stockSnapshot.exists()) throw new Error(`No packaging stock record exists for ${requirement.materialName} for ${outward.customer_name}.`);
      const stock = stockSnapshot.data();
      if (valueOf(stock, "customer_id") !== outward.customer_id || valueOf(stock, "material_id") !== requirement.materialId) {
        throw new Error(`Packaging stock identity mismatch for ${requirement.materialName}.`);
      }
      const stockUnit = normalizedName(valueOf(stock, "unit"));
      if (stockUnit.toLowerCase() !== requirement.unit.toLowerCase()) {
        throw new Error(`${requirement.materialName} stock is in ${stockUnit || "an unknown unit"}; the configuration requires ${requirement.unit}.`);
      }
      const available = getAvailablePackaging(stock);
      if (available < requirement.required) {
        throw new Error(`Insufficient Packaging Stock. ${requirement.materialName}. Available: ${available}, Required: ${requirement.required}.`);
      }
      const consumedRaw = valueOf(stock, "consumed_quantity", "consumedQuantity");
      const consumed = consumedRaw === "" ? 0 : Number(consumedRaw);
      const receivedRaw = valueOf(stock, "received_quantity", "receivedQuantity");
      const received = receivedRaw === "" ? 0 : Number(receivedRaw);
      if (!Number.isFinite(consumed) || consumed < 0 || !Number.isFinite(received) || received < 0) {
        throw new Error(`Packaging stock totals are invalid for ${requirement.materialName}.`);
      }
      return { ...requirement, available, consumed, received, stockSnapshot, stockRef, transactionRef: packagingTransactionRefs[index] };
    });

    const currentProductIssuedRaw = valueOf(productStock, "total_issued", "totalIssued");
    const currentProductIssued = currentProductIssuedRaw === "" ? 0 : Number(currentProductIssuedRaw);
    const currentProductReceivedRaw = valueOf(productStock, "total_received", "totalReceived");
    const currentProductReceived = currentProductReceivedRaw === "" ? 0 : Number(currentProductReceivedRaw);
    if (!Number.isFinite(currentProductIssued) || currentProductIssued < 0 || !Number.isFinite(currentProductReceived) || currentProductReceived < 0) {
      throw new Error("Product stock totals are invalid. No stock was changed.");
    }

    const timestamp = serverTimestamp();
    const remainingProduct = getProductQuantity(productStock) - productQuantity;
    deductions.forEach((item) => {
      transaction.update(item.stockRef, {
        available_quantity: item.available - item.required,
        consumed_quantity: item.consumed + item.required,
        updated_at: timestamp,
        last_transaction_id: item.transactionRef.id
      });
      transaction.set(item.transactionRef, {
        id: item.transactionRef.id,
        customer_id: outward.customer_id,
        customer_name: outward.customer_name,
        material_id: item.materialId,
        material_name: item.materialName,
        transaction_type: "OUT",
        quantity: -item.required,
        unit: item.unit,
        reference_id: outwardId,
        reference: "Outward Entry",
        reference_type: "OUTWARD",
        outward_id: outwardId,
        product_id: outward.product_id || null,
        product_name: outward.product_name,
        number_of_boxes: boxes,
        created_at: timestamp,
        remark: "Packaging consumed for finalized Outward."
      });
    });
    const currentProduct = getProductQuantity(productStock);
    transaction.update(productStockRef, {
      current_stock: currentProduct - productQuantity,
      total_issued: currentProductIssued + productQuantity,
      updated_at: timestamp,
      last_transaction_id: productLedgerId
    });
    transaction.set(productLedgerRef, {
      transaction_id: productLedgerId,
      outward_id: outwardId,
      stock_id: productStockRef.id,
      product_id: stockProductId || null,
      product_name: stockProductName,
      location: stockLocation,
      location_id: valueOf(productStock, "receiving_location_id", "location_id", "locationId") || null,
      transaction_type: "OUT",
      quantity: productQuantity,
      unit: stockUnit,
      reference_type: "OUTWARD",
      reference_id: outwardId,
      created_at: timestamp
    });
    transaction.update(outwardRef, {
      status: "DISPATCHED",
      finalized_at: timestamp,
      packaging_stock_updated: true,
      packaging_stock_updated_at: timestamp,
      packaging_transaction_ids: deductions.map((item) => item.transactionRef.id),
      product_stock_before: currentProduct,
      product_stock_after: remainingProduct,
      packaging_used: deductions.map((item) => ({
        material_id: item.materialId,
        material_name: item.materialName,
        quantity: item.required,
        unit: item.unit,
        previous_stock: item.available,
        remaining_stock: item.available - item.required
      })),
      product_stock_updated: true,
      product_transaction_id: productLedgerId,
      updated_at: timestamp
    });
    return { id: outwardId, alreadyFinalized: false };
  });
}