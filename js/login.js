import { auth, db, USING_EMULATOR } from "./firebase-config.js?v=20261010b";
import {
  onAuthStateChanged, signInWithEmailAndPassword, signInWithCustomToken, signOut, sendPasswordResetEmail, setPersistence, browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { startSession } from "./core.js?v=20261010b";

// DOM elements
const loginForm = document.getElementById("loginForm");
const loginMessage = document.getElementById("loginMessage");
const loginBtn = document.getElementById("loginBtn");

function showLoginMsg(text, kind = "error") {
  loginMessage.className = text ? `notice ${kind}` : "";
  loginMessage.textContent = text;
}

const apiEndpoint = (file) => new URL(`api/${file}`, window.location.href).href;

if (new URLSearchParams(location.search).get("denied")) {
  showLoginMsg("This account is not authorised for the CCPL ERP, or it has been deactivated.");
}

async function activeProfile(user) {
  const snap = await getDoc(doc(db, "users", user.uid));
  return snap.exists() && snap.data().active === true ? snap.data() : null;
}

let signingIn = false;
onAuthStateChanged(auth, async (user) => {
  if (!user || signingIn) return;
  if (await activeProfile(user).catch(() => null)) {
    const p = window.location.pathname;
    if (p.endsWith("dashboard") || p.endsWith("dashboard.html")) return;
    window.location.replace("dashboard.html");
  } else {
    await signOut(auth);
  }
});

// Direct email/password sign-in (OTP removed)
loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = loginForm.email.value.trim();
  const password = loginForm.password.value;

  if (!email || !password) {
    showLoginMsg("Enter your email and password.");
    return;
  }

  signingIn = true;
  loginBtn.disabled = true;
  showLoginMsg("");

  try {
    await setPersistence(auth, browserLocalPersistence).catch((pErr) => {
      console.warn("Storage persistence warning:", pErr);
    });

    let user;
    try {
      const userCredential = await signInWithEmailAndPassword(auth, email, password);
      user = userCredential.user;
    } catch (fbError) {
      if (["auth/invalid-credential", "auth/wrong-password", "auth/user-not-found", "auth/invalid-email"].includes(fbError.code)) {
        throw fbError;
      }
      // Fallback via PHP backend if direct client REST endpoint is restricted
      try {
        const res = await fetch(apiEndpoint("login.php"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.success && data.custom_token) {
          const cred = await signInWithCustomToken(auth, data.custom_token);
          user = cred.user;
        } else {
          throw new Error(data.error || fbError.message);
        }
      } catch {
        throw fbError;
      }
    }

    const profile = await activeProfile(user);
    if (!profile) {
      await signOut(auth);
      showLoginMsg("This account is not authorised for the CCPL ERP, or it has been deactivated.");
      signingIn = false;
      loginBtn.disabled = false;
      return;
    }

    await startSession(user, profile).catch((e) => console.warn("Could not record session", e));
    window.location.replace("dashboard.html");
  } catch (error) {
    const code = error.code || "";
    if (!code.startsWith("auth/")) console.error("Sign-in failed:", error);
    if (["auth/invalid-credential", "auth/wrong-password", "auth/user-not-found", "auth/invalid-email"].includes(code)) {
      showLoginMsg("Incorrect email or password.");
    } else if (code === "auth/user-disabled") {
      showLoginMsg("This account has been disabled by an administrator.");
    } else if (code === "auth/too-many-requests") {
      showLoginMsg("Too many sign-in attempts. Please try again in a few minutes.");
    } else {
      showLoginMsg(error.message || "Sign-in failed. Please check credentials and connection.");
    }
    signingIn = false;
    loginBtn.disabled = false;
  }
});

// Forgot password reset
document.getElementById("resetBtn").addEventListener("click", async () => {
  const email = loginForm.email.value.trim();
  if (!email) {
    showLoginMsg("Enter your email above, then click “Forgot password?” again.");
    return;
  }
  try {
    await sendPasswordResetEmail(auth, email);
  } catch (error) {
    console.warn(error);
  }
  showLoginMsg("If this email belongs to an ERP user, a password reset link has been sent.", "info");
});
