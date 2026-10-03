// One-time / repeatable setup for CCPL ERP.
//   • creates (or updates the password of) every login listed in admin/users.json
//   • writes their /users/{uid} profile (role + active) — only these people can use the ERP
//   • seeds company legal details, the 4 warehouses and the packaging items (only if missing)
//
// Live project:  GOOGLE_APPLICATION_CREDENTIALS=./service-account.json node admin/setup.mjs
// Emulator:      node admin/setup.mjs --emulator
import { readFileSync, existsSync } from "node:fs";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const emulator = process.argv.includes("--emulator");
if (emulator) {
  process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
  process.env.FIREBASE_AUTH_EMULATOR_HOST ||= "127.0.0.1:9099";
}
const usersArg = process.argv.indexOf("--users");
const usersFile = usersArg > 0 ? new URL(process.argv[usersArg + 1], `file://${process.cwd()}/`) : new URL("./users.json", import.meta.url);
if (!existsSync(usersFile)) {
  console.error("admin/users.json not found. Copy admin/users.example.json to admin/users.json and fill in the passwords.");
  process.exit(1);
}
const users = JSON.parse(readFileSync(usersFile, "utf8"));

initializeApp(emulator ? { projectId: "demo-ccpl" } : { credential: applicationDefault(), projectId: "ccpl-ims" });
const auth = getAuth();
const db = getFirestore();

const ROLES = ["admin", "manager", "operator", "viewer"];
for (const u of users) {
  if (!u.email || !u.password || !ROLES.includes(u.role)) throw new Error(`Invalid entry for ${u.email}: email, password and role (${ROLES.join("/")}) are required.`);
  if (u.password.length < 10) throw new Error(`Password for ${u.email} must be at least 10 characters.`);
  let record;
  try {
    record = await auth.getUserByEmail(u.email);
    await auth.updateUser(record.uid, { password: u.password, displayName: u.name, disabled: false });
    console.log(`updated  ${u.email}`);
  } catch (error) {
    if (error.code !== "auth/user-not-found") throw error;
    record = await auth.createUser({ email: u.email, password: u.password, displayName: u.name, emailVerified: true });
    console.log(`created  ${u.email}`);
  }
  await db.doc(`users/${record.uid}`).set({
    name: u.name, email: u.email.toLowerCase(), role: u.role, active: u.active !== false, createdAt: FieldValue.serverTimestamp()
  }, { merge: true });
}

const company = db.doc("settings/company");
if (!(await company.get()).exists) {
  await company.set({
    name: "Cognizant Chemical Pvt. Ltd.",
    addressLines: ["Office No. 120 DISMA Complex,", "Plot No 246, Kalamboli Panvel,", "Raigad Maharashtra 410218 India"],
    state: "Maharashtra", stateCode: "27", gstin: "27AAGCC5829E1ZN", pan: "AAGCC5829E",
    email: "admin@cognizantchemical.com", phone: "9619662255", poTolerancePct: 0.5,
    bankHolder: "COGNIZANT CHEMICAL PVT LTD", bankName: "ICICI BANK", bankAccount: "484105000428", bankIfsc: "ICIC0004841", bankBranch: "SEC - 3, KARANJADE"
  });
  console.log("seeded   company details");
}

const warehouses = [
  { code: "PG-106", name: "PG 106", docCode: "PG", sort: 1, destination: "PATALGANGA", addressLines: ["PLOT NO. E-106, NEAR CHAWANE VILLAGE,", "MIDC, ADDITIONAL PATALGANGA INDUSTRIAL AREA", "PATALGANGA,", "RAIGAD Maharashtra 410220 India"] },
  { code: "PG-153", name: "PG-153", docCode: "PG", sort: 2, destination: "PATALGANGA", addressLines: ["PLOT NO. E-153, NEAR CHAWANE VILLAGE,", "MIDC, ADDITIONAL PATALGANGA INDUSTRIAL AREA", "PATALGANGA,", "RAIGAD Maharashtra 410220 India"] },
  { code: "BREEZE", name: "Breeze", docCode: "BR", sort: 3, destination: "", addressLines: [] },
  { code: "TALOJA", name: "Taloja Unit", docCode: "TL", sort: 4, destination: "TALOJA", addressLines: [] }
];
for (const w of warehouses) {
  const ref = db.doc(`warehouses/${w.code}`);
  if (!(await ref.get()).exists) { const { code, ...data } = w; await ref.set({ ...data, active: true }); console.log(`seeded   warehouse ${code}`); }
}

const packaging = [
  { name: "M S Drum", code: "PKG-MSD", hsn: "73101090", unit: "NOS", gstRate: 18, capacity: 200, capacityUnit: "LTR", description: "MS drum" },
  { name: "HDPE Drum", code: "PKG-HDD", hsn: "39233090", unit: "NOS", gstRate: 18, capacity: 200, capacityUnit: "LTR", description: "HDPE drum" },
  { name: "Carboy", code: "PKG-CBY", hsn: "39233090", unit: "NOS", gstRate: 18, capacity: 35, capacityUnit: "LTR", description: "HDPE carboy" },
  { name: "2.5 Litre Bottle", code: "PKG-B25", hsn: "39233090", unit: "NOS", gstRate: 18, capacity: 2.5, capacityUnit: "LTR", description: "2.5 L bottle" },
  { name: "4 Litre Bottle", code: "PKG-B04", hsn: "39233090", unit: "NOS", gstRate: 18, capacity: 4, capacityUnit: "LTR", description: "4 L bottle" }
];
const existingItems = (await db.collection("items").get()).docs.map((d) => d.data().name.toLowerCase());
for (const p of packaging) {
  if (existingItems.includes(p.name.toLowerCase())) continue;
  await db.collection("items").add({ ...p, category: "Packaging", reorderLevel: null, active: true, createdAt: FieldValue.serverTimestamp() });
  console.log(`seeded   item ${p.name}`);
}
console.log("\nDone. Only the users above can sign in.");
