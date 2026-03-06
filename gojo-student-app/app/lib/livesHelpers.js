// Helper for global student lives (POC + transactional consume)
// Usage:
//  const lives = await getStudentLives(studentId)
//  const updated = await consumeLife(studentId)  // throws if not enough lives
import { ref, get, runTransaction } from "firebase/database";
import { database } from "../../constants/firebaseConfig";

export async function getStudentLives(studentId) {
  if (!studentId) return null;
  try {
    const snap = await get(ref(database, `Platform1/studentLives/${studentId}`));
    if (snap && snap.exists()) return snap.val();
    const snap2 = await get(ref(database, `studentLives/${studentId}`));
    if (snap2 && snap2.exists()) return snap2.val();
    return null;
  } catch (e) {
    console.warn("getStudentLives error", e && e.message);
    return null;
  }
}

// Atomically consume a life. Returns the updated node value or throws when insufficient lives.
// Note: This runTransaction will create a default node if none exists (maxLives=5).
export async function consumeLife(studentId) {
  if (!studentId) throw new Error("studentId required");
  const nodeRef = ref(database, `Platform1/studentLives/${studentId}`);
  try {
    const result = await runTransaction(nodeRef, (curr) => {
      const now = Date.now();
      const defaultMax = 5;
      const refillIntervalMs = 20 * 60 * 1000;

      if (!curr) {
        // create default with one consumed
        return {
          maxLives: defaultMax,
          currentLives: Math.max(0, defaultMax - 1),
          lastConsumedAt: now,
          refillIntervalMs,
        };
      }

      const max = Number(curr.maxLives || defaultMax);
      const refill = Number(curr.refillIntervalMs || refillIntervalMs);
      const last = Number(curr.lastConsumedAt || now);
      // compute recovered since last
      const recovered = Math.floor((now - last) / refill);
      let current = Number(curr.currentLives ?? max);
      current = Math.min(max, current + recovered);

      if (current <= 0) {
        // abort transaction by returning undefined
        return;
      }
      current = Math.max(0, current - 1);
      return {
        ...curr,
        currentLives: current,
        lastConsumedAt: now,
      };
    });

    if (!result.committed) throw new Error("Not enough lives");
    return result.snapshot.val();
  } catch (err) {
    // Rethrow for caller
    throw err;
  }
}