/**
 * The one place that knows about Firebase.
 *
 * Three services, three jobs:
 *   Auth      — who you are (Google or GitHub; nothing is stored without it)
 *   Firestore — the account: name, tier, usage, referrals, conversations
 *   Realtime Database — the bridge to the Mac at home, unchanged in shape from
 *                       the one G-Micro already uses. Jobs go in, tokens come
 *                       back. There is no inference server in this project.
 *
 * The web config is public by design — it identifies the project, it does not
 * grant anything. Access is decided by the security rules in `firebase/`.
 */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, onAuthStateChanged, GoogleAuthProvider, signInAnonymously,
  signInWithPopup, signInWithRedirect, getRedirectResult, signOut, deleteUser,
  linkWithPopup, linkWithRedirect,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, doc, collection, getDoc, getDocs, setDoc, updateDoc, addDoc,
  deleteDoc, query, where, orderBy, limit, onSnapshot, serverTimestamp,
  writeBatch, increment, Timestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { getDatabase } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
import { problem } from './ui.js';

const CONFIG = {
  apiKey: 'AIzaSyCiNb3wGWfE1xt19CmeEF3M4hh2KQ_QcqM',
  authDomain: 'narew-labs.firebaseapp.com',
  databaseURL: 'https://narew-labs-default-rtdb.europe-west1.firebasedatabase.app',
  projectId: 'narew-labs',
  storageBucket: 'narew-labs.firebasestorage.app',
  messagingSenderId: '611126878648',
  appId: '1:611126878648:web:2e3f0b740e810ee2c5ef4d',
};

export const app = initializeApp(CONFIG);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const rtdb = getDatabase(app);

export {
  doc, collection, getDoc, getDocs, setDoc, updateDoc, addDoc, deleteDoc,
  query, where, orderBy, limit, onSnapshot, serverTimestamp, writeBatch,
  increment, Timestamp,
};

/* ------------------------------------------------------------------ auth -- */

const googleProvider = () => new GoogleAuthProvider();

/**
 * Sign in with Google, choosing the flow the browser will actually allow.
 *
 * Safari on iOS blocks the popup often enough that treating it as the happy
 * path is a bug: the window opens, gets swallowed, and the user is left on a
 * screen that looks broken. On a touch device we go straight to redirect.
 */
export async function signIn(which = 'google') {
  if (which !== 'google') throw new Error(`Nieznany sposób logowania: ${which}`);
  const provider = googleProvider();

  if (matchMedia('(pointer: coarse)').matches) return signInWithRedirect(auth, provider);

  try {
    return await signInWithPopup(auth, provider);
  } catch (e) {
    if (e?.code === 'auth/popup-blocked' || e?.code === 'auth/operation-not-supported-in-this-environment') {
      return signInWithRedirect(auth, provider);
    }
    throw e;
  }
}

/**
 * Sign in as a guest.
 *
 * A real Firebase account with a real uid, so everything downstream — the
 * account document, usage, history, tiers — works identically. What it does not
 * have is a way back: the account lives in this browser's credentials, so
 * clearing site data or signing out abandons it. That is said on the button
 * rather than discovered afterwards, and Settings offers a way out via
 * `linkGoogle` before it matters.
 */
export const signInAsGuest = () => signInAnonymously(auth);

/** Turn the guest account into a Google one, keeping its uid and its data. */
export async function linkGoogle() {
  const provider = googleProvider();
  if (matchMedia('(pointer: coarse)').matches) return linkWithRedirect(auth.currentUser, provider);
  try {
    return await linkWithPopup(auth.currentUser, provider);
  } catch (e) {
    if (e?.code === 'auth/popup-blocked') return linkWithRedirect(auth.currentUser, provider);
    throw e;
  }
}

export const finishRedirectSignIn = () => getRedirectResult(auth);
export const signOutNow = () => signOut(auth);
export const deleteCurrentUser = () => deleteUser(auth.currentUser);
export const watchAuth = (fn) => onAuthStateChanged(auth, fn);

/**
 * Turn a Firebase error into something a person can act on.
 *
 * The two that matter most here are configuration, not user error: a provider
 * that was never switched on in the console, and a domain that was never added
 * to the allow-list. Both look like a dead button unless we say so.
 */
export function explainAuthError(e) {
  const code = e?.code || '';
  if (code.includes('operation-not-allowed')) {
    return 'Ten sposób logowania nie jest jeszcze włączony w konsoli Firebase.';
  }
  if (code.includes('unauthorized-domain')) {
    return 'Ta domena nie jest dopuszczona w Firebase Auth. Trzeba ją dodać w konsoli.';
  }
  if (code.includes('popup-closed-by-user') || code.includes('cancelled-popup-request')) {
    return 'Logowanie przerwane.';
  }
  if (code.includes('account-exists-with-different-credential') || code.includes('credential-already-in-use')) {
    return 'To konto Google jest już używane. Wyloguj się i zaloguj przez Google.';
  }
  if (code.includes('admin-restricted-operation')) {
    return 'Wejście jako gość nie jest włączone w konsoli Firebase.';
  }
  if (code.includes('network-request-failed')) return 'Brak połączenia. Sprawdź internet i spróbuj jeszcze raz.';
  /* Never the library's own string. An unmapped code used to put raw English on
     the sign-in card - the exact failure the shared helper exists to prevent,
     and the gate was the one screen not using it. */
  return problem(e, 'Nie udało mi się zalogować. Spróbuj jeszcze raz.');
}
