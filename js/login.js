import { auth, db } from "./firebase-config.js";
import {
  onAuthStateChanged, signInWithEmailAndPassword, signOut, sendPasswordResetEmail, setPersistence, browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const form = document.getElementById("loginForm");
const message = document.getElementById("loginMessage");
const button = document.getElementById("loginBtn");

function show(text, kind = "error") {
  message.className = text ? `notice ${kind}` : "";
  message.textContent = text;
}

if (new URLSearchParams(location.search).get("denied")) {
  show("This account is not authorised for the CCPL ERP, or it has been deactivated.");
}

async function isActiveUser(user) {
  const snap = await getDoc(doc(db, "users", user.uid));
  return snap.exists() && snap.data().active === true;
}

let signingIn = false;
onAuthStateChanged(auth, async (user) => {
  if (!user || signingIn) return;
  if (await isActiveUser(user).catch(() => false)) window.location.replace("dashboard.html");
  else await signOut(auth);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = form.email.value.trim();
  const password = form.password.value;
  if (!email || !password) { show("Enter your email and password."); return; }
  signingIn = true;
  button.disabled = true;
  show("");
  try {
    await setPersistence(auth, browserLocalPersistence);
    const { user } = await signInWithEmailAndPassword(auth, email, password);
    if (!(await isActiveUser(user))) {
      await signOut(auth);
      show("This account is not authorised for the CCPL ERP, or it has been deactivated.");
      return;
    }
    window.location.replace("dashboard.html");
  } catch (error) {
    const code = error.code || "";
    if (["auth/invalid-credential", "auth/wrong-password", "auth/user-not-found", "auth/invalid-email"].includes(code)) show("Incorrect email or password.");
    else if (code === "auth/too-many-requests") show("Too many failed attempts. The account is temporarily locked — try again later or reset the password.");
    else if (code === "auth/user-disabled") show("This account has been disabled by the administrator.");
    else { console.error(error); show("Sign-in failed. Check your internet connection and try again."); }
  } finally {
    signingIn = false;
    button.disabled = false;
  }
});

document.getElementById("resetBtn").addEventListener("click", async () => {
  const email = form.email.value.trim();
  if (!email) { show("Enter your email above, then click “Forgot password?” again."); return; }
  try {
    await sendPasswordResetEmail(auth, email);
  } catch (error) {
    console.warn(error);
  }
  show("If this email belongs to an ERP user, a password reset link has been sent.", "info");
});
