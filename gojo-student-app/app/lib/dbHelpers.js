// Lightweight firebase realtime helpers used across screens.
//
// Usage:
//   const val = await getValue(['Platform1/studentLives/abc']);
//   const snap = await getSnapshot(['Platform1/companyExams/packages']);
//   const newKey = await pushAndSet('Platform1/attempts/company/uid/examId', attemptObj);
//   await runTransactionSafe('Platform1/studentProgress/uid/company/rid/examId/attemptsUsed', curr => Number(curr||0)+1);
//
// Keeps consistent semantics: getValue returns plain object or null, getSnapshot returns snapshot or null.
import { get, ref, runTransaction, push, set, update } from "firebase/database";
import { database } from "../../constants/firebaseConfig";

/**
 * Return the plain JS value for the first existing path.
 * Returns null when not found.
 */
export async function getValue(paths) {
  for (const p of paths) {
    try {
      const snap = await get(ref(database, p));
      if (snap && snap.exists()) return snap.val();
    } catch (e) {
      // ignore and continue
    }
  }
  return null;
}

/**
 * Return the snapshot for the first existing path (or null).
 */
export async function getSnapshot(paths) {
  for (const p of paths) {
    try {
      const snap = await get(ref(database, p));
      if (snap && snap.exists()) return snap;
    } catch (e) {
      // ignore
    }
  }
  return null;
}

/**
 * Safe transaction helper. updater receives currentValue and must return new value.
 * Example: await runTransactionSafe('Platform1/studentLives/uid/currentLives', curr => Math.max(0, (curr||0)-1));
 */
export async function runTransactionSafe(path, updater) {
  const nodeRef = ref(database, path);
  return runTransaction(nodeRef, (current) => {
    try {
      return updater(current);
    } catch (e) {
      return current;
    }
  });
}

/**
 * Push and set helper that returns key.
 */
export async function pushAndSet(basePath, value) {
  const newRef = push(ref(database, basePath));
  const newKey = newRef.key;
  await set(ref(database, `${basePath}/${newKey}`), value);
  return newKey;
}

/**
 * Atomic update map
 */
export async function safeUpdate(patch) {
  return update(ref(database), patch);
}