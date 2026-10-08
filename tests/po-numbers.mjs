// Rules test for manual PO numbers, data-entry pause and the reset grant.
// Run:  npx firebase emulators:exec --only auth,firestore --project demo-ccpl "node tests/po-numbers.mjs"
import { initializeApp as adminApp } from "firebase-admin/app";
import { getAuth as adminAuth } from "firebase-admin/auth";
import { getFirestore as adminDb, FieldValue } from "firebase-admin/firestore";
import { initializeApp } from "firebase/app";
import { getAuth, connectAuthEmulator, signInWithEmailAndPassword } from "firebase/auth";
import {
  getFirestore, connectFirestoreEmulator, doc, collection, runTransaction, serverTimestamp, setDoc, getDoc, deleteDoc, updateDoc, writeBatch
} from "firebase/firestore";
import { createHash } from "node:crypto";

process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= "127.0.0.1:9099";
const PROJECT = "demo-ccpl";
adminApp({ projectId: PROJECT });
const aauth = adminAuth();
const adb = adminDb();

// Same as js/core.js
const cleanPoNo = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
const poNumberKey = (v) => `PO_${cleanPoNo(v).toUpperCase().replace(/\//g, "%2F")}`;
const DUP = "This PO number already exists. Please enter a different PO number.";

const SUPER = "rupesh.mudliar@cognizantchemical.com";
const people = { super: [SUPER, "admin"], mgr: ["mgr@test.local", "manager"], mgr2: ["mgr2@test.local", "manager"], op: ["op@test.local", "operator"] };
for (const [, [email, role]] of Object.entries(people)) {
  const u = await aauth.createUser({ email, password: "password123" }).catch(() => aauth.getUserByEmail(email));
  await adb.doc(`users/${u.uid}`).set({ email, role, active: true, name: email });
}
await adb.doc("items/ITEM1").set({ name: "Methanol", code: "RM001", unit: "kg" });

async function client(key) {
  const app = initializeApp({ apiKey: "demo", projectId: PROJECT }, key);
  const auth = getAuth(app); connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  const db = getFirestore(app); connectFirestoreEmulator(db, "127.0.0.1", 8080);
  await signInWithEmailAndPassword(auth, people[key][0], "password123");
  return { db, uid: auth.currentUser.uid };
}
const C = { super: await client("super"), mgr: await client("mgr"), mgr2: await client("mgr2"), op: await client("op") };

// Same save logic as js/purchase-orders.js (create)
async function createPo({ db, uid }, typed) {
  const poNo = cleanPoNo(typed); const key = poNumberKey(poNo);
  return runTransaction(db, async (tx) => {
    const keyRef = doc(db, "poNumbers", key);
    const ref = doc(collection(db, "purchaseOrders"));
    if ((await tx.get(keyRef)).exists()) throw new Error(DUP);
    tx.set(keyRef, { number: poNo, poId: ref.id, at: serverTimestamp(), by: { uid } });
    tx.set(ref, { poNo, poNoKey: key, status: "OPEN", lines: [], createdAt: serverTimestamp() });
    return ref.id;
  });
}
async function renumberPo({ db, uid }, id, typed) {
  const poNo = cleanPoNo(typed); const key = poNumberKey(poNo);
  return runTransaction(db, async (tx) => {
    const ref = doc(db, "purchaseOrders", id);
    const cur = (await tx.get(ref)).data();
    const oldKey = cur.poNoKey;
    if (key === oldKey) { tx.update(ref, { poNo: cur.poNo, poNoKey: oldKey, notes: "edited" }); return "same"; }
    const keyRef = doc(db, "poNumbers", key);
    if ((await tx.get(keyRef)).exists()) throw new Error(DUP);
    const oldReg = await tx.get(doc(db, "poNumbers", oldKey));
    tx.set(keyRef, { number: poNo, poId: id, at: serverTimestamp(), by: { uid } });
    if (oldReg.exists() && oldReg.data().poId === id) tx.delete(doc(db, "poNumbers", oldKey));
    tx.update(ref, { poNo, poNoKey: key });
    return "renumbered";
  });
}

let failures = 0;
async function expectOk(name, fn) { try { const r = await fn(); console.log(`PASS  ${name}`); return r; } catch (e) { failures++; console.log(`FAIL  ${name}: ${e.message}`); } }
async function expectFail(name, fn, match = null) {
  try { await fn(); failures++; console.log(`FAIL  ${name}: succeeded but should have been refused`); }
  catch (e) { if (match && !String(e.message).includes(match) && !String(e.code).includes(match)) { failures++; console.log(`FAIL  ${name}: wrong error ${e.code || ""} ${e.message}`); } else console.log(`PASS  ${name} (${e.code || e.message})`); }
}

const id1 = await expectOk("manager creates CCPL/PH/001/26-27", () => createPo(C.mgr, "CCPL/PH/001/26-27"));
await expectFail("same number, other case + spaces is blocked", () => createPo(C.mgr2, "  ccpl/ph/001/26-27 "), DUP);
await expectFail("bypassing the client check: overwrite registry", () => setDoc(doc(C.mgr2.db, "poNumbers", poNumberKey("CCPL/PH/001/26-27")), { number: "x", poId: "zzz" }), "permission-denied");
await expectFail("bypassing the client check: PO without registry", () => setDoc(doc(C.mgr2.db, "purchaseOrders", "rogue1"), { poNo: "CCPL/PH/001/26-27", poNoKey: poNumberKey("CCPL/PH/001/26-27"), status: "OPEN" }), "permission-denied");
await expectFail("PO whose key does not match its number", async () => {
  const b = writeBatch(C.mgr.db);
  b.set(doc(C.mgr.db, "poNumbers", "PO_OTHER"), { number: "X", poId: "rogue2" });
  b.set(doc(C.mgr.db, "purchaseOrders", "rogue2"), { poNo: "CCPL/PH/001/26-27", poNoKey: "PO_OTHER", status: "OPEN" });
  await b.commit();
}, "permission-denied");
await expectFail("operator cannot create a PO", () => createPo(C.op, "OP/1"), "permission-denied");
await expectFail("invalid characters refused by rules", async () => {
  const b = writeBatch(C.mgr.db); const k = poNumberKey("BAD<script>");
  b.set(doc(C.mgr.db, "poNumbers", k), { number: "BAD<script>", poId: "rogue3" });
  b.set(doc(C.mgr.db, "purchaseOrders", "rogue3"), { poNo: "BAD<script>", poNoKey: k, status: "OPEN" });
  await b.commit();
}, "permission-denied");
await expectOk("any new series/format is accepted (CCPL/OCT 26/01)", () => createPo(C.mgr, "CCPL/OCT 26/01"));
await expectOk("completely different prefix accepted (PO-2026-0001)", () => createPo(C.mgr, "PO-2026-0001"));

// Simultaneous submissions of the same new number
const results = await Promise.allSettled([createPo(C.mgr, "CCPL/PH/002/26-27"), createPo(C.mgr2, "ccpl/ph/002/26-27")]);
const ok = results.filter((r) => r.status === "fulfilled").length;
const regs = (await adb.collection("purchaseOrders").where("poNoKey", "==", poNumberKey("CCPL/PH/002/26-27")).get()).size;
if (ok === 1 && regs === 1) console.log(`PASS  simultaneous saves: exactly one PO created (other: ${results.find((r) => r.status === "rejected")?.reason?.message})`);
else { failures++; console.log(`FAIL  simultaneous saves: ${ok} succeeded, ${regs} POs stored`); }
// 10 at once
const many = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => createPo(i % 2 ? C.mgr : C.mgr2, " CCPL/PH/003/26-27")));
const stored3 = (await adb.collection("purchaseOrders").where("poNoKey", "==", poNumberKey("CCPL/PH/003/26-27")).get()).size;
if (many.filter((r) => r.status === "fulfilled").length === 1 && stored3 === 1) console.log("PASS  10 simultaneous saves: exactly one PO created");
else { failures++; console.log(`FAIL  10 simultaneous saves: stored ${stored3}`); }

await expectOk("edit PO keeping its number (different case typed) is accepted", async () => { if (await renumberPo(C.mgr, id1, "ccpl/ph/001/26-27") !== "same") throw new Error("not same"); });
await expectFail("edit PO to another PO's number is blocked", () => renumberPo(C.mgr, id1, "PO-2026-0001"), DUP);
await expectOk("edit PO to a new number (typo fix)", () => renumberPo(C.mgr, id1, "CCPL/PH/101/26-27"));
await expectOk("old number released after renumber can be used", () => createPo(C.mgr, "CCPL/PH/001/26-27"));
// cancelled numbers stay reserved
const idC = await expectOk("create PO to cancel", () => createPo(C.mgr, "CCPL/PH/050/26-27"));
await expectOk("cancel PO", () => updateDoc(doc(C.mgr.db, "purchaseOrders", idC), { status: "CANCELLED" }));
await expectFail("cancelled PO number cannot be reused", () => createPo(C.mgr2, "CCPL/PH/050/26-27"), DUP);
await expectFail("registry of cancelled PO cannot be deleted", () => deleteDoc(doc(C.mgr.db, "poNumbers", poNumberKey("CCPL/PH/050/26-27"))), "permission-denied");
await expectFail("cancelled PO cannot be renumbered", async () => {
  const b = writeBatch(C.mgr.db); const k = poNumberKey("NEW/1");
  b.set(doc(C.mgr.db, "poNumbers", k), { number: "NEW/1", poId: idC });
  b.update(doc(C.mgr.db, "purchaseOrders", idC), { poNo: "NEW/1", poNoKey: k });
  await b.commit();
}, "permission-denied");
// operator updates (inward) still work
await expectOk("operator inward update of PO lines", () => updateDoc(doc(C.op.db, "purchaseOrders", id1), { lines: [], status: "PARTIALLY RECEIVED", updatedAt: serverTimestamp() }));

// Data-entry pause
await expectFail("manager cannot pause data entry", () => setDoc(doc(C.mgr.db, "settings", "maintenance"), { paused: true }), "permission-denied");
await expectOk("super admin pauses data entry", () => setDoc(doc(C.super.db, "settings", "maintenance"), { paused: true, reason: "test" }));
await expectFail("manager save refused while paused", () => createPo(C.mgr, "PAUSED/1"), "permission-denied");
await expectFail("item edit refused while paused", () => updateDoc(doc(C.op.db, "items", "ITEM1"), { name: "x" }), "permission-denied");
await expectOk("super admin can still save while paused", () => createPo(C.super, "SUPER/1"));
await expectOk("super admin resumes", () => setDoc(doc(C.super.db, "settings", "maintenance"), { paused: false }));
await expectOk("manager save works after resume", () => createPo(C.mgr, "RESUMED/1"));

// Reset grant
const sha = (t) => createHash("sha256").update(t).digest("hex");
const salt = "abcd"; const proof = sha(`${salt}:resetpw`);
await expectOk("super admin sets reset password", async () => { const b = writeBatch(C.super.db); b.set(doc(C.super.db, "secure", "resetLock"), { hash: sha(proof) }); b.set(doc(C.super.db, "secure", "resetInfo"), { salt }); await b.commit(); });
await expectFail("bulk delete without grant refused", () => deleteDoc(doc(C.super.db, "poNumbers", poNumberKey("CCPL/PH/050/26-27"))), "permission-denied");
await expectFail("wrong reset password refused", () => setDoc(doc(C.super.db, "secure", "resetGrant"), { uid: C.super.uid, at: serverTimestamp(), proof: sha(`${salt}:wrong`) }), "permission-denied");
await expectFail("manager cannot open a grant", () => setDoc(doc(C.mgr.db, "secure", "resetGrant"), { uid: C.mgr.uid, at: serverTimestamp(), proof }), "permission-denied");
await expectOk("right reset password opens the grant", () => setDoc(doc(C.super.db, "secure", "resetGrant"), { uid: C.super.uid, at: serverTimestamp(), proof }));
await expectOk("with grant: delete POs, PO-number register, stock ledger, activity", async () => {
  for (const c of ["purchaseOrders", "poNumbers"]) {
    const snap = await adb.collection(c).get();
    const b = writeBatch(C.super.db); snap.docs.forEach((d) => b.delete(doc(C.super.db, c, d.id))); await b.commit();
  }
  await adb.doc("stockLedger/L1").set({ x: 1 }); await adb.doc("activity/A1").set({ x: 1 });
  const b = writeBatch(C.super.db); b.delete(doc(C.super.db, "stockLedger", "L1")); b.delete(doc(C.super.db, "activity", "A1")); await b.commit();
});
const counts = { pos: (await adb.collection("purchaseOrders").get()).size, regs: (await adb.collection("poNumbers").get()).size, items: (await adb.collection("items").get()).size };
if (counts.pos === 0 && counts.regs === 0 && counts.items === 1) console.log(`PASS  after reset: 0 POs, 0 PO numbers, items ${counts.items}`); else { failures++; console.log(`FAIL  after reset ${JSON.stringify(counts)}`); }
await expectOk("first PO after reset", () => createPo(C.mgr, "CCPL/PH/001/26-27"));

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
