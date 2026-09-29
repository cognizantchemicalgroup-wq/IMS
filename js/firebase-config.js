import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, connectAuthEmulator } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, connectFirestoreEmulator } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getStorage, connectStorageEmulator } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyASaR4XRhIgrSMAgvHGaLpxfCKMKvDLLro",
  authDomain: "ccpl-ims.firebaseapp.com",
  projectId: "ccpl-ims",
  storageBucket: "ccpl-ims.firebasestorage.app",
  messagingSenderId: "477570894491",
  appId: "1:477570894491:web:bafaf6d719303eabbc143e",
  measurementId: "G-9ZMMEDKWB6"
};

// Local testing: open any page with ?emulator=1 (remembered for the tab session)
// to run against the Firebase emulators instead of live data.
const params = new URLSearchParams(window.location.search);
if (params.get("emulator") === "1") sessionStorage.setItem("ccpl-emulator", "1");
if (params.get("emulator") === "0") sessionStorage.removeItem("ccpl-emulator");
export const USING_EMULATOR = sessionStorage.getItem("ccpl-emulator") === "1"
  && ["localhost", "127.0.0.1"].includes(window.location.hostname);

const app = initializeApp(USING_EMULATOR ? { ...firebaseConfig, projectId: "demo-ccpl", storageBucket: "demo-ccpl.appspot.com" } : firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);

if (USING_EMULATOR) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
  connectStorageEmulator(storage, "127.0.0.1", 9199);
}
