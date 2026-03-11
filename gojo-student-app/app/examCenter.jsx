import React, { useEffect, useState, useRef, useMemo, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  SafeAreaView,
  ScrollView,
  Platform,
  Animated,
  Alert,
  StatusBar,
  Vibration,
  Modal,
  Easing,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useRouter, useLocalSearchParams } from "expo-router";
import { ref, get } from "firebase/database";
import { database } from "../constants/firebaseConfig";
import { Ionicons } from "@expo/vector-icons";
import { getValue, pushAndSet, runTransactionSafe, safeUpdate } from "./lib/dbHelpers";

const C = {
  primary: "#0B72FF",
  muted: "#6B78A8",
  bg: "#FFFFFF",
  text: "#0B2540",
  border: "#EAF0FF",
  success: "#16A34A",
  danger: "#EF4444",
  warningBg: "#FFF7ED",
  warningBorder: "#FED7AA",
};
const HEART_COLOR = "#EF4444";
const DEFAULT_HEART_REFILL_MS = 20 * 60 * 1000;
const DEFAULT_MAX_LIVES = 5;
const WRONGS_PER_LIFE_FALLBACK = 2;

function toMsTs(v) {
  const n = Number(v || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e12 ? n * 1000 : n;
}
function normalizeQuestionOrder(qOrder) {
  if (!qOrder) return [];
  if (Array.isArray(qOrder)) return qOrder;
  if (typeof qOrder === "object") {
    const keys = Object.keys(qOrder);
    const numeric = keys.every((k) => String(Number(k)) === String(k));
    if (numeric) return keys.map((k) => ({ k: Number(k), v: qOrder[k] })).sort((a, b) => a.k - b.k).map((x) => x.v);
    return keys.map((k) => qOrder[k]);
  }
  return [];
}
function scoreExam(questions, order, answers) {
  const qOrder = order.length ? order : questions.map((q) => q.id);
  const map = {};
  (questions || []).forEach((q) => { if (q?.id != null) map[String(q.id)] = q; });

  let correct = 0;
  let total = 0;
  qOrder.forEach((qId) => {
    const q = map[String(qId)];
    if (!q) return;
    total += 1;
    if (String(q.correctAnswer ?? "").trim() !== "" && String(answers?.[String(qId)] ?? "").trim() === String(q.correctAnswer ?? "").trim()) correct += 1;
  });
  const percent = total ? (correct / total) * 100 : 0;
  return { correct, total, percent };
}
function getBadgeAndPoints(examMeta, percent) {
  let badge = null;
  let points = 0;
  if (examMeta?.scoringEnabled && examMeta?.scoring) {
    const s = examMeta.scoring;
    if (percent >= Number(s.platinumPercent || 90)) { badge = "platinum"; points = Number(s.maxPoints || 3); }
    else if (percent >= Number(s.diamondPercent || 85)) { badge = "diamond"; points = 2; }
    else if (percent >= Number(s.goldPercent || 75)) { badge = "gold"; points = 1; }
  }
  return { badge, points };
}
function inWindow(roundMeta) {
  const now = Date.now();
  const start = toMsTs(roundMeta?.startTimestamp);
  const end = toMsTs(roundMeta?.endTimestamp);
  if (!start && !end) return true;
  if (start && now < start) return false;
  if (end && now > end) return false;
  return true;
}
function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function formatTime(sec) {
  const s = Number(sec || 0);
  const mm = Math.floor(s / 60).toString().padStart(2, "0");
  const ss = Math.floor(s % 60).toString().padStart(2, "0");
  return `${mm}:${ss}`;
}
function formatMsToMMSS(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const mm = Math.floor(s / 60).toString().padStart(2, "0");
  const ss = Math.floor(s % 60).toString().padStart(2, "0");
  return `${mm}:${ss}`;
}
function computeRefillState({ currentLives, maxLives, lastConsumedAt, refillMs, now = Date.now() }) {
  const current = Number(currentLives ?? 0);
  const max = Number(maxLives ?? 5);
  const last = Number(lastConsumedAt ?? 0);
  const interval = Number(refillMs ?? 0);

  if (!interval || interval <= 0) return { currentLives: current, lastConsumedAt: last, recovered: 0, nextInMs: 0 };
  if (current >= max) return { currentLives: current, lastConsumedAt: last, recovered: 0, nextInMs: 0 };
  if (!last) return { currentLives: current, lastConsumedAt: now, recovered: 0, nextInMs: interval };

  const elapsed = Math.max(0, now - last);
  const recovered = Math.floor(elapsed / interval);
  const newCurrent = Math.min(max, current + Math.max(0, recovered));
  const newLast = recovered > 0 ? last + recovered * interval : last;
  const nextInMs = newCurrent >= max ? 0 : Math.max(0, interval - ((now - newLast) % interval));

  return { currentLives: newCurrent, lastConsumedAt: newLast, recovered, nextInMs };
}

export default function ExamCenter() {
  const router = useRouter();
  const params = useLocalSearchParams();

  const roundId = params.roundId;
  const examId = params.examId;
  const questionBankIdParam = params.questionBankId;
  const mode = params.mode || "start";

  const [loading, setLoading] = useState(true);
  const [stage, setStage] = useState(mode === "review" ? "review" : "rules");
  const [roundMeta, setRoundMeta] = useState(null);
  const [examMeta, setExamMeta] = useState(null);
  const [isCompetitive, setIsCompetitive] = useState(false);

  const [questions, setQuestions] = useState([]);
  const [questionLoadError, setQuestionLoadError] = useState(null);

  const [studentId, setStudentId] = useState(null);
  const [attemptNo, setAttemptNo] = useState(1);
  const [attemptsUsed, setAttemptsUsed] = useState(0);
  const [effectiveAttemptsUsed, setEffectiveAttemptsUsed] = useState(0);
  const [nextAttemptInMs, setNextAttemptInMs] = useState(0);
  const [attemptId, setAttemptId] = useState(null);

  const [inProgressAttempt, setInProgressAttempt] = useState(null);
  const [reviewAttempt, setReviewAttempt] = useState(null);
  const [lastCompletedAttempt, setLastCompletedAttempt] = useState(null);

  const [order, setOrder] = useState([]);
  const [answers, setAnswers] = useState({});
  const [currentIndex, setCurrentIndex] = useState(0);
  const [selectedFeedback, setSelectedFeedback] = useState(null);

  const [timeLeft, setTimeLeft] = useState(0);
  const timerRef = useRef(null);
  const [result, setResult] = useState(null);

  const [globalLives, setGlobalLives] = useState(null);
  const [globalMaxLives, setGlobalMaxLives] = useState(DEFAULT_MAX_LIVES);
  const [globalRefillMs, setGlobalRefillMs] = useState(DEFAULT_HEART_REFILL_MS);
  const [globalLastConsumedAt, setGlobalLastConsumedAt] = useState(null);

  const [outOfLivesModalVisible, setOutOfLivesModalVisible] = useState(false);
  const [nextHeartInMs, setNextHeartInMs] = useState(0);
  const outModalAnim = useRef(new Animated.Value(0)).current;

  const [showHeartInfoModal, setShowHeartInfoModal] = useState(false);
  const heartModalAnim = useRef(new Animated.Value(0)).current;

  const [feedbackMode, setFeedbackMode] = useState("end");
  const [showFeedbackInfoModal, setShowFeedbackInfoModal] = useState(false);
  const [showAttemptsExhaustedDetails, setShowAttemptsExhaustedDetails] = useState(true);

  const [showPostSubmitReview, setShowPostSubmitReview] = useState(false);
  const [reviewIndex, setReviewIndex] = useState(0);

  const wrongCountRef = useRef(0);

  // [v48] add near other useState/useRef declarations inside ExamCenter component:
const resultPop = useRef(new Animated.Value(0)).current;
const resultPulse = useRef(new Animated.Value(1)).current;
const resultConfetti = useRef(new Animated.Value(0)).current;

const isPass = useMemo(() => {
  const pass = Number(examMeta?.passPercent ?? examMeta?.passingPercent ?? examMeta?.passScore ?? 0);
  if (!pass) return Number(result?.percent || 0) >= 50;
  return Number(result?.percent || 0) >= pass;
}, [examMeta, result]);

const gradeLabel = useMemo(() => {
  const p = Number(result?.percent || 0);
  if (p >= 90) return "Excellent";
  if (p >= 75) return "Great job";
  if (p >= 50) return "Good effort";
  return "Keep practicing";
}, [result]);

  const [appExamConfig, setAppExamConfig] = useState({
    attempts: {
      defaultRefillIntervalMs: 1200000,
      maxCarryRefills: 999,
      practiceRefillEnabled: true,
    },
    lives: {
      defaultMaxLives: DEFAULT_MAX_LIVES,
      defaultRefillIntervalMs: DEFAULT_HEART_REFILL_MS,
      fallbackWrongsPerLife: WRONGS_PER_LIFE_FALLBACK,
    },
    ui: {},
  });

  const loadQuestionBank = useCallback(async (qbId) => {
    setQuestionLoadError(null);
    if (!qbId) {
      setQuestionLoadError("Question bank id missing.");
      setQuestions([]);
      return;
    }

    const direct = [
      `Platform1/questionBanks/${qbId}`,
      `Platform1/questionBanks/questionBanks/${qbId}`,
      `Platform1/companyExams/questionBanks/${qbId}`,
      `companyExams/questionBanks/${qbId}`,
      `questionBanks/${qbId}`,
      `questionBanks/questionBanks/${qbId}`,
    ];

    let qb = await getValue(direct);
    if (qb?.questions) {
      setQuestions(Object.entries(qb.questions).map(([id, q]) => ({ id, ...q })));
      return;
    }

    const parents = [
      `Platform1/questionBanks`,
      `Platform1/questionBanks/questionBanks`,
      `questionBanks`,
      `questionBanks/questionBanks`,
      `Platform1/companyExams/questionBanks`,
      `companyExams/questionBanks`,
      `Platform1`,
    ];

    for (const p of parents) {
      const node = await getValue([p]);
      if (!node) continue;
      if (node[qbId]?.questions) { qb = node[qbId]; break; }
      if (node.questionBanks?.[qbId]?.questions) { qb = node.questionBanks[qbId]; break; }
      if (node.questionBanks?.questionBanks?.[qbId]?.questions) { qb = node.questionBanks.questionBanks[qbId]; break; }
    }

    if (qb?.questions) setQuestions(Object.entries(qb.questions).map(([id, q]) => ({ id, ...q })));
    else {
      setQuestions([]);
      setQuestionLoadError(`Question bank not found for ${qbId}`);
    }
  }, []);

  const findRoundMetaById = useCallback(async (rid) => {
    const pkgs = await getValue([`Platform1/companyExams/packages`, `companyExams/packages`]);
    if (!pkgs) return null;
    for (const pkgKey of Object.keys(pkgs)) {
      const subjects = (pkgs[pkgKey] || {}).subjects || {};
      for (const sk of Object.keys(subjects)) {
        const rounds = (subjects[sk] || {}).rounds || {};
        if (rounds[rid]) return { ...(rounds[rid] || {}), id: rid, packageId: pkgKey, subjectKey: sk };
      }
    }
    return null;
  }, []);

  const submitExam = useCallback(async () => {
    clearInterval(timerRef.current);

    const finalOrder = order.length ? order : questions.map((q) => q.id);
    const computed = scoreExam(questions, finalOrder, answers);
    const scored = getBadgeAndPoints(examMeta, computed.percent);

    const now = Date.now();
    const resultVisible = examMeta?.scoringEnabled ? now >= toMsTs(roundMeta?.resultReleaseTimestamp) : true;

    if (studentId && examId && attemptId) {
      const usedBefore = Number(effectiveAttemptsUsed || attemptsUsed || 0);
      const usedAfter = usedBefore + 1;
      const patch = {};
      patch[`Platform1/attempts/company/${studentId}/${examId}/${attemptId}/endTime`] = now;
      patch[`Platform1/attempts/company/${studentId}/${examId}/${attemptId}/attemptStatus`] = "completed";
      patch[`Platform1/attempts/company/${studentId}/${examId}/${attemptId}/answers`] = answers;
      patch[`Platform1/attempts/company/${studentId}/${examId}/${attemptId}/scorePercent`] = computed.percent;
      patch[`Platform1/attempts/company/${studentId}/${examId}/${attemptId}/correctCount`] = computed.correct;
      patch[`Platform1/attempts/company/${studentId}/${examId}/${attemptId}/pointsAwarded`] = scored.points;
      patch[`Platform1/attempts/company/${studentId}/${examId}/${attemptId}/badge`] = scored.badge;
      patch[`Platform1/attempts/company/${studentId}/${examId}/${attemptId}/resultVisible`] = resultVisible;

      patch[`Platform1/studentProgress/${studentId}/company/${roundId}/${examId}/status`] = "completed";
      patch[`Platform1/studentProgress/${studentId}/company/${roundId}/${examId}/attemptsUsed`] = usedAfter;
      patch[`Platform1/studentProgress/${studentId}/company/${roundId}/${examId}/bestScorePercent`] = computed.percent;
      patch[`Platform1/studentProgress/${studentId}/company/${roundId}/${examId}/lastAttemptId`] = attemptId;
      patch[`Platform1/studentProgress/${studentId}/company/${roundId}/${examId}/lastSubmittedAt`] = now;
      patch[`Platform1/studentProgress/${studentId}/company/${roundId}/${examId}/lastAttemptTimestamp`] = now;
      await safeUpdate(patch).catch(() => {});

      setAttemptsUsed(usedAfter);
      setEffectiveAttemptsUsed(usedAfter);
      setAttemptNo(usedAfter + 1);
    }

    try {
      const pRaw = examMeta?.passingPercent ?? examMeta?.passPercent ?? examMeta?.passScore ?? null;
      const passPercent = pRaw != null ? Number(pRaw) : null;
      const wrongsPerLife = Number(appExamConfig?.lives?.fallbackWrongsPerLife || WRONGS_PER_LIFE_FALLBACK);

      if (!isCompetitive && studentId) {
        const livesPath = `Platform1/studentLives/${studentId}`;
        if (passPercent != null && !Number.isNaN(passPercent)) {
          if (computed.percent < passPercent) {
            await runTransactionSafe(`${livesPath}/currentLives`, (curr) => Math.max(0, Number(curr ?? 0) - 1));
            await safeUpdate({ [`${livesPath}/lastConsumedAt`]: Date.now() }).catch(() => {});
          }
        } else {
          const livesToDeduct = Math.floor(Number(wrongCountRef.current || 0) / Math.max(1, wrongsPerLife));
          if (livesToDeduct > 0) {
            await runTransactionSafe(`${livesPath}/currentLives`, (curr) => Math.max(0, Number(curr ?? 0) - livesToDeduct));
            await safeUpdate({ [`${livesPath}/lastConsumedAt`]: Date.now() }).catch(() => {});
          }
        }

        const updated = await get(ref(database, livesPath)).catch(() => null);
        if (updated?.exists()) {
          const val = updated.val();
          setGlobalLives(Number(val.currentLives ?? val.current ?? 0));
          setGlobalLastConsumedAt(toMsTs(val.lastConsumedAt ?? val.lastConsumed ?? 0));
        }
      }
    } catch (e) {
      console.warn("submitExam: life deduction failed", e);
    }

    setLastCompletedAttempt({ id: attemptId, endTime: Date.now() });
    setResult({
      percent: computed.percent,
      correct: computed.correct,
      total: computed.total,
      badge: scored.badge,
      points: scored.points,
      resultVisible,
    });

    const shouldShowDetailedReview = !isCompetitive && feedbackMode === "end";
    setShowPostSubmitReview(shouldShowDetailedReview);
    setReviewIndex(0);

    wrongCountRef.current = 0;
    setStage("result");
  }, [order, questions, answers, studentId, examId, attemptId, examMeta, roundMeta, isCompetitive, roundId, appExamConfig, feedbackMode, effectiveAttemptsUsed, attemptsUsed]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);

      const cfg = await getValue([`Platform1/appConfig/exams`, `appConfig/exams`]);
      if (!cancelled && cfg) {
        setAppExamConfig((prev) => ({
          ...prev,
          ...cfg,
          attempts: { ...prev.attempts, ...(cfg.attempts || {}) },
          lives: { ...prev.lives, ...(cfg.lives || {}) },
          ui: { ...prev.ui, ...(cfg.ui || {}) },
        }));
      }

      const sid =
        (await AsyncStorage.getItem("studentNodeKey")) ||
        (await AsyncStorage.getItem("studentId")) ||
        (await AsyncStorage.getItem("username")) ||
        null;
      if (!cancelled) setStudentId(sid);

      if (sid) {
        const livesNode = await getValue([`Platform1/studentLives/${sid}`, `studentLives/${sid}`]);
        const defaultRefillMs = Number(cfg?.lives?.defaultRefillIntervalMs || DEFAULT_HEART_REFILL_MS);
        const defaultMaxLives = Number(cfg?.lives?.defaultMaxLives || DEFAULT_MAX_LIVES);

        if (livesNode) {
          const raw = livesNode || {};
          const rawCurrent = Number(raw.currentLives ?? raw.lives ?? 0);
          const max = Number(raw.maxLives ?? raw.max ?? defaultMaxLives);

          let refillMs = defaultRefillMs;
          const refillRaw = raw.refillIntervalMs ?? raw.refillInterval ?? null;
          if (refillRaw != null) {
            const n = Number(refillRaw);
            if (Number.isFinite(n)) refillMs = n > 1000 ? n : n * 1000;
          }

          const lastConsumed = toMsTs(raw.lastConsumedAt ?? raw.lastConsumed ?? 0) || 0;
          let computedCurrent = Number.isFinite(rawCurrent) ? rawCurrent : 0;
          let computedLastConsumed = lastConsumed || 0;

          if (refillMs > 0 && lastConsumed && computedCurrent < max) {
            const elapsed = Math.max(0, Date.now() - lastConsumed);
            const recovered = Math.floor(elapsed / refillMs);
            if (recovered > 0) {
              computedCurrent = Math.min(max, computedCurrent + recovered);
              computedLastConsumed = lastConsumed + recovered * refillMs;
              await safeUpdate({
                [`Platform1/studentLives/${sid}/currentLives`]: computedCurrent,
                [`Platform1/studentLives/${sid}/lastConsumedAt`]: computedLastConsumed,
              }).catch(() => {});
            }
          }

          if (!cancelled) {
            setGlobalLives(computedCurrent);
            setGlobalMaxLives(max || defaultMaxLives);
            setGlobalRefillMs(refillMs);
            setGlobalLastConsumedAt(computedLastConsumed || null);
          }
        } else {
          if (!cancelled) {
            setGlobalLives(null);
            setGlobalMaxLives(defaultMaxLives);
            setGlobalRefillMs(defaultRefillMs);
            setGlobalLastConsumedAt(null);
          }
        }
      }

      const rMeta = await findRoundMetaById(roundId);
      if (!cancelled) setRoundMeta(rMeta || null);

      const exam = await getValue([
        `Platform1/companyExams/exams/${examId}`,
        `companyExams/exams/${examId}`,
        `Platform1/exams/${examId}`,
        `exams/${examId}`,
      ]);
      if (!cancelled) setExamMeta(exam || null);

      let pkgMeta = null;
      if (rMeta?.packageId) {
        pkgMeta = await getValue([`Platform1/companyExams/packages/${rMeta.packageId}`, `companyExams/packages/${rMeta.packageId}`]);
      }
      if (!cancelled) setIsCompetitive(String(pkgMeta?.type || "").toLowerCase() === "competitive");

      if (!cancelled) setFeedbackMode(exam?.scoringEnabled ? "end" : "instant");

      let qbId = questionBankIdParam || exam?.questionBankId || null;
      if (!qbId && examId) {
        const examMap = await getValue([`Platform1/companyExams/exams`, `companyExams/exams`]);
        if (examMap?.[examId]?.questionBankId) qbId = examMap[examId].questionBankId;
      }

      await loadQuestionBank(qbId);

      if (sid && examId) {
        const attemptsNode = (await getValue([`Platform1/attempts/company/${sid}/${examId}`, `attempts/company/${sid}/${examId}`])) || {};
        let entries = attemptsNode || {};
        if (attemptsNode && (attemptsNode.attemptStatus || attemptsNode.startTime || attemptsNode.scorePercent != null)) {
          entries = { legacy_single_attempt: attemptsNode };
        }

        const keys = Object.keys(entries || {});
        let completedCount = 0;
        let latestInProgress = null;
        let latestInProgressKey = null;
        let latestCompleted = null;
        let latestCompletedKey = null;

        for (const k of keys) {
          const a = entries[k] || {};
          const status = String(a.attemptStatus || "").toLowerCase();
          if (status === "completed") {
            completedCount += 1;
            const endT = Number(a.endTime || a.startTime || 0);
            if (!latestCompleted || endT > Number(latestCompleted.endTime || latestCompleted.startTime || 0)) {
              latestCompleted = a;
              latestCompletedKey = k;
            }
          } else if (status === "in_progress") {
            if (!latestInProgress || Number(a.startTime || 0) > Number(latestInProgress.startTime || 0)) {
              latestInProgress = a;
              latestInProgressKey = k;
            }
          }
        }

        if (!cancelled) {
          setAttemptsUsed(completedCount);
          setEffectiveAttemptsUsed(completedCount);
          setAttemptNo(completedCount + 1);
        }

        if (latestInProgress && latestInProgressKey && !cancelled) {
          setInProgressAttempt({ id: latestInProgressKey, ...latestInProgress });
          setAttemptId(latestInProgressKey);
          setOrder(normalizeQuestionOrder(latestInProgress.questionOrder || {}));
          setAnswers(latestInProgress.answers || {});
          if (latestInProgress.remainingSeconds != null) setTimeLeft(Number(latestInProgress.remainingSeconds));
          else if (exam?.timeLimit && latestInProgress.startTime) {
            const elapsed = Math.floor((Date.now() - Number(latestInProgress.startTime || 0)) / 1000);
            setTimeLeft(Math.max(0, Number(exam.timeLimit || 0) - elapsed));
          }
        }

        if (latestCompleted && latestCompletedKey && !cancelled) setLastCompletedAttempt({ id: latestCompletedKey, ...latestCompleted });

        if ((mode === "review" || mode === "result") && keys.length && !cancelled) {
          const completedKeys = keys.filter((k) => String(entries[k]?.attemptStatus || "").toLowerCase() === "completed");
          let latestKey = null;
          if (completedKeys.length) {
            completedKeys.sort((a, b) => Number(entries[b]?.endTime || entries[b]?.startTime || 0) - Number(entries[a]?.endTime || entries[a]?.startTime || 0));
            latestKey = completedKeys[0];
          } else {
            keys.sort((a, b) => Number(entries[b]?.endTime || entries[b]?.startTime || 0) - Number(entries[a]?.endTime || entries[a]?.startTime || 0));
            latestKey = keys[0];
          }
          if (latestKey) {
            const raw = entries[latestKey] || {};
            setReviewAttempt({
              id: latestKey,
              ...raw,
              questionOrder: normalizeQuestionOrder(raw.questionOrder || {}),
              answers: raw.answers || {},
            });
          }
        }
      }

      if (!cancelled) setLoading(false);
    })();

    return () => clearInterval(timerRef.current);
  }, [roundId, examId, questionBankIdParam, mode, findRoundMetaById, loadQuestionBank]);

// [v49] add this effect below your other effects:
useEffect(() => {
  if (stage !== "result") return;

  resultPop.setValue(0);
  resultConfetti.setValue(0);

  Animated.parallel([
    Animated.spring(resultPop, {
      toValue: 1,
      useNativeDriver: true,
      friction: 6,
      tension: 90,
    }),
    Animated.timing(resultConfetti, {
      toValue: 1,
      duration: 700,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }),
  ]).start();

  const pulseLoop = Animated.loop(
    Animated.sequence([
      Animated.timing(resultPulse, { toValue: 1.05, duration: 700, useNativeDriver: true }),
      Animated.timing(resultPulse, { toValue: 1, duration: 700, useNativeDriver: true }),
    ])
  );
  pulseLoop.start();

  return () => {
    pulseLoop.stop();
    resultPulse.setValue(1);
  };
}, [stage, resultPop, resultConfetti, resultPulse]);


  useEffect(() => {
    if (outOfLivesModalVisible) Animated.spring(outModalAnim, { toValue: 1, useNativeDriver: true }).start();
    else Animated.timing(outModalAnim, { toValue: 0, duration: 180, useNativeDriver: true }).start();
  }, [outOfLivesModalVisible, outModalAnim]);

  useEffect(() => {
    if (showHeartInfoModal) Animated.spring(heartModalAnim, { toValue: 1, useNativeDriver: true }).start();
    else Animated.timing(heartModalAnim, { toValue: 0, duration: 180, useNativeDriver: true }).start();
  }, [showHeartInfoModal, heartModalAnim]);

  useEffect(() => {
    let t;
    let syncing = false;

    async function tickAndSync() {
      if (globalLives == null) {
        setNextHeartInMs(0);
        return;
      }

      const state = computeRefillState({
        currentLives: globalLives,
        maxLives: globalMaxLives,
        lastConsumedAt: globalLastConsumedAt,
        refillMs: globalRefillMs,
      });

      setNextHeartInMs(state.nextInMs);

      if (state.recovered > 0 && studentId && !syncing) {
        syncing = true;
        try {
          await safeUpdate({
            [`Platform1/studentLives/${studentId}/currentLives`]: state.currentLives,
            [`Platform1/studentLives/${studentId}/lastConsumedAt`]: state.lastConsumedAt,
          });
          setGlobalLives(state.currentLives);
          setGlobalLastConsumedAt(state.lastConsumedAt);
        } catch (e) {
          console.warn("heart refill sync failed", e);
        } finally {
          syncing = false;
        }
      }
    }

    tickAndSync();
    t = setInterval(tickAndSync, 1000);
    return () => clearInterval(t);
  }, [studentId, globalLives, globalMaxLives, globalLastConsumedAt, globalRefillMs]);

  useEffect(() => {
    let timer;
    async function tickAttemptRefill() {
      if (!studentId || !roundId || !examId || !examMeta) return;

      if (isCompetitive) {
        setEffectiveAttemptsUsed(Number(attemptsUsed || 0));
        setNextAttemptInMs(0);
        return;
      }

      const refillEnabled =
        (examMeta?.attemptRefillEnabled !== false) &&
        (appExamConfig?.attempts?.practiceRefillEnabled !== false);

      const refillMs = Number(
        examMeta?.attemptRefillIntervalMs ??
        appExamConfig?.attempts?.defaultRefillIntervalMs ??
        0
      );

      const progress = await getValue([`Platform1/studentProgress/${studentId}/company/${roundId}/${examId}`]) || {};
      const usedRaw = Number(progress?.attemptsUsed || 0);
      const lastTs = Number(progress?.lastAttemptTimestamp || progress?.lastSubmittedAt || 0);

      if (!refillEnabled || !refillMs || !lastTs) {
        setEffectiveAttemptsUsed(usedRaw);
        setNextAttemptInMs(0);
        return;
      }

      const elapsed = Math.max(0, Date.now() - lastTs);
      const recovered = Math.floor(elapsed / refillMs);
      const usedNew = Math.max(0, usedRaw - recovered);

      const anchor = lastTs + recovered * refillMs;
      const nextMs = usedNew <= 0 ? 0 : Math.max(0, refillMs - ((Date.now() - anchor) % refillMs));

      setEffectiveAttemptsUsed(usedNew);
      setNextAttemptInMs(nextMs);

      if (usedNew !== usedRaw) {
        await safeUpdate({
          [`Platform1/studentProgress/${studentId}/company/${roundId}/${examId}/attemptsUsed`]: usedNew,
          [`Platform1/studentProgress/${studentId}/company/${roundId}/${examId}/lastAttemptTimestamp`]: anchor,
        }).catch(() => {});
        setAttemptsUsed(usedNew);
        setAttemptNo(usedNew + 1);
      }
    }

    tickAttemptRefill();
    timer = setInterval(tickAttemptRefill, 1000);
    return () => clearInterval(timer);
  }, [studentId, roundId, examId, examMeta, appExamConfig?.attempts, isCompetitive, attemptsUsed]);

  const persistStartAttempt = useCallback(async (qOrder) => {
    if (!studentId || !examId) return null;

    const baseAttempt = {
      roundId,
      attemptNo,
      attemptStatus: "in_progress",
      startTime: Date.now(),
      questionOrder: qOrder,
      answers: {},
      scorePercent: null,
      pointsAwarded: 0,
      badge: null,
      rankingCounted: false,
      resultVisible: false,
      feedbackMode,
    };

    const newAttemptId = await pushAndSet(`Platform1/attempts/company/${studentId}/${examId}`, baseAttempt);
    setInProgressAttempt({ id: newAttemptId, ...baseAttempt });
    setAttemptId(newAttemptId);

    try {
      const progressPath = `Platform1/studentProgress/${studentId}/company/${roundId}/${examId}/attemptsUsed`;
      await runTransactionSafe(progressPath, (current = 0) => Number(current || 0) + 1);
      await safeUpdate({ [`Platform1/studentProgress/${studentId}/company/${roundId}/${examId}/lastAttemptTimestamp`]: Date.now() }).catch(() => {});
      setAttemptsUsed((p) => Number(p || 0) + 1);
      setEffectiveAttemptsUsed((p) => Number(p || 0) + 1);
      setAttemptNo((p) => Number(p || 1) + 1);
    } catch {}

    wrongCountRef.current = 0;
    return newAttemptId;
  }, [studentId, examId, roundId, attemptNo, feedbackMode]);

  const attemptsUsedForUI = Number.isFinite(effectiveAttemptsUsed)
    ? effectiveAttemptsUsed
    : Number(attemptsUsed || 0);
  const attemptsLeft = Math.max(0, Number(examMeta?.maxAttempts || 1) - attemptsUsedForUI);

  const startExam = useCallback(async () => {
    if (!examMeta) return Alert.alert("Cannot start", "Exam metadata unavailable.");

    const maxAttempts = Number(examMeta?.maxAttempts || 1);
    if (attemptsUsedForUI >= maxAttempts && !inProgressAttempt) return;

    if (examMeta?.scoringEnabled && (!questions || questions.length === 0)) {
      return Alert.alert("Cannot start", questionLoadError || "Question bank not loaded yet.");
    }

    if (!isCompetitive && globalLives === 0) {
      setOutOfLivesModalVisible(true);
      return;
    }

    const ids = questions.map((q) => q.id);
    if (!ids.length) return Alert.alert("No questions", "Question data not found for this exam.");
    if (inProgressAttempt && attemptId) return Alert.alert("Resume available", "You have an unfinished attempt. Use Resume Test.");

    const qOrder = shuffleArray(ids);
    setOrder(qOrder);
    setAnswers({});
    setCurrentIndex(0);
    setTimeLeft(Number(examMeta?.timeLimit || 600));

    const aId = await persistStartAttempt(qOrder);
    setAttemptId(aId);

    clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setTimeLeft((t) => {
        if (t <= 1) {
          clearInterval(timerRef.current);
          submitExam();
          return 0;
        }
        return t - 1;
      });
    }, 1000);

    setStage("exam");
  }, [examMeta, attemptsUsedForUI, inProgressAttempt, questions, questionLoadError, isCompetitive, globalLives, attemptId, persistStartAttempt, submitExam]);

  const resumeExam = useCallback(() => {
    if (!inProgressAttempt || !attemptId) return Alert.alert("No attempt to resume");

    const normalizedOrder = normalizeQuestionOrder(inProgressAttempt.questionOrder || {});
    if (!order.length && normalizedOrder.length) setOrder(normalizedOrder);
    if (inProgressAttempt.answers) setAnswers(inProgressAttempt.answers || {});

    if (inProgressAttempt.remainingSeconds != null) setTimeLeft(Number(inProgressAttempt.remainingSeconds));
    else if (inProgressAttempt.startTime && examMeta?.timeLimit) {
      const elapsed = Math.floor((Date.now() - Number(inProgressAttempt.startTime || 0)) / 1000);
      setTimeLeft(Math.max(0, Number(examMeta.timeLimit || 600) - elapsed));
    } else setTimeLeft(Number(examMeta?.timeLimit || 600));

    clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setTimeLeft((t) => {
        if (t <= 1) { clearInterval(timerRef.current); submitExam(); return 0; }
        return t - 1;
      });
    }, 1000);

    setStage("exam");
  }, [inProgressAttempt, attemptId, order.length, examMeta, submitExam]);

  const setAnswer = useCallback(async (qId, optionKey) => {
    if (stage !== "exam") return;
    if (feedbackMode === "instant" && answers?.[qId] != null) return;

    setAnswers((p) => ({ ...p, [qId]: optionKey }));

    const q = questions.find((x) => x.id === qId);
    if (q) {
      const correct = String(q.correctAnswer || "") === String(optionKey || "");
      if (!isCompetitive && feedbackMode === "instant") {
        setSelectedFeedback(correct ? "correct" : "wrong");
        Vibration.vibrate(20);
      }
      if (!isCompetitive && !correct) wrongCountRef.current = Number(wrongCountRef.current || 0) + 1;
    }

    if (!studentId || !examId || !attemptId) return;
    await safeUpdate({ [`Platform1/attempts/company/${studentId}/${examId}/${attemptId}/answers/${qId}`]: optionKey }).catch(() => {});
  }, [stage, feedbackMode, answers, questions, isCompetitive, studentId, examId, attemptId]);

  const prevQ = useCallback(() => {
    setSelectedFeedback(null);
    if (currentIndex > 0) setCurrentIndex((i) => i - 1);
  }, [currentIndex]);

  const nextQ = useCallback(() => {
    setSelectedFeedback(null);
    if (currentIndex < (order.length || questions.length) - 1) setCurrentIndex((i) => i + 1);
    else submitExam();
  }, [currentIndex, order.length, questions.length, submitExam]);

  const canStart = useMemo(() => {
    if (!examMeta) return { ok: false, reason: "Exam metadata unavailable." };
    if (examMeta?.scoringEnabled && (!questions || questions.length === 0)) {
      if (questionLoadError) return { ok: false, reason: questionLoadError };
      return { ok: false, reason: "Question bank not loaded yet. Try again in a moment." };
    }

    const maxAttempts = Number(examMeta?.maxAttempts || 1);
    if (attemptsUsedForUI >= maxAttempts && !inProgressAttempt) return { ok: false, reason: "No attempts left for this exam." };

    if (isCompetitive && lastCompletedAttempt && roundMeta?.endTimestamp) {
      if (Date.now() < toMsTs(roundMeta.endTimestamp)) {
        return { ok: false, reason: "You completed this competitive exam. Results will be available after the round ends." };
      }
    }

    if (roundMeta?.startTimestamp && roundMeta?.endTimestamp && !inWindow(roundMeta)) {
      return { ok: false, reason: "This exam is outside the allowed time window." };
    }

    return { ok: true, reason: "" };
  }, [examMeta, questions, questionLoadError, attemptsUsedForUI, inProgressAttempt, isCompetitive, lastCompletedAttempt, roundMeta]);

  const safeAreaPaddingTop = Platform.OS === "android" ? (StatusBar.currentHeight || 0) : 0;
  const qId = order[currentIndex];
  const q = questions.find((x) => x.id === qId);

  const totalQ = Math.max(1, order.length || questions.length || 1);
  const examProgressPct = Math.min(100, Math.max(0, ((currentIndex + 1) / totalQ) * 100));

  const passingPercent = Number(examMeta?.passingPercent ?? examMeta?.passPercent ?? examMeta?.passScore ?? NaN);
  const hasPassPercent = Number.isFinite(passingPercent);
  const scoring = examMeta?.scoring || {};

  const instructionsList = useMemo(() => {
    const src = examMeta?.instructions ?? examMeta?.instruction ?? examMeta?.rules ?? [];
    if (Array.isArray(src)) return src.filter(Boolean).map((x) => String(x));
    if (typeof src === "object") return Object.keys(src).map((k) => src[k]).filter(Boolean).map((x) => String(x));
    if (typeof src === "string" && src.trim()) return [src.trim()];
    return [];
  }, [examMeta]);

  if (loading) {
    return (
      <SafeAreaView style={[styles.loadingWrap, { paddingTop: safeAreaPaddingTop }]}>
        <StatusBar barStyle="dark-content" backgroundColor={C.bg} />
        <ActivityIndicator size="large" color={C.primary} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.safeRoot, { paddingTop: safeAreaPaddingTop }]}>
      <StatusBar barStyle="dark-content" backgroundColor={C.bg} />

      <Modal visible={outOfLivesModalVisible} transparent animationType="none" onRequestClose={() => {}}>
        <View style={modalStyles.overlay}>
          <Animated.View style={[modalStyles.card, { transform: [{ scale: outModalAnim.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1] }) }], opacity: outModalAnim }]}>
            <Text style={modalStyles.title}>You're out of lives</Text>
            <Text style={modalStyles.text}>You have no global lives left to continue practicing.</Text>
            <Text style={[modalStyles.countdown, { marginTop: 12 }]}>Next life in {formatMsToMMSS(nextHeartInMs)}</Text>
            <TouchableOpacity style={modalStyles.closeBtn} onPress={() => setOutOfLivesModalVisible(false)}>
              <Text style={modalStyles.closeBtnText}>OK</Text>
            </TouchableOpacity>
          </Animated.View>
        </View>
      </Modal>

      <Modal visible={showFeedbackInfoModal} animationType="slide" transparent onRequestClose={() => setShowFeedbackInfoModal(false)}>
        <View style={modalStyles.overlay}>
          <View style={modalStyles.card}>
            <Text style={modalStyles.title}>Feedback modes</Text>
            <Text style={modalStyles.modeTitle}>Instant</Text>
            <Text style={modalStyles.modeText}>After answering, immediate correctness is shown and choice is locked.</Text>
            <Text style={modalStyles.modeTitle}>End of exam</Text>
            <Text style={modalStyles.modeText}>You can change answers until submit.</Text>
            <TouchableOpacity style={modalStyles.closeBtnPrimary} onPress={() => setShowFeedbackInfoModal(false)}>
              <Text style={modalStyles.closeBtnTextPrimary}>Got it</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <View style={styles.root}>
        {stage === "rules" && (
          <View style={styles.panel}>
            <View style={styles.headerBar}>
              <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}><Ionicons name="chevron-back" size={22} color={C.text} /></TouchableOpacity>
              <View style={{ flex: 1 }}>
                <Text style={styles.title}>{examMeta?.name || "Practice Test"}</Text>
                <Text style={styles.subtitle}>{roundMeta?.name || ""}</Text>
              </View>
              <TouchableOpacity style={{ minWidth: 72, alignItems: "flex-end" }} onPress={() => setShowHeartInfoModal(true)}>
                <View style={{ flexDirection: "row", alignItems: "center" }}>
                  <Ionicons name={globalLives != null && globalLives > 0 ? "heart" : "heart-outline"} size={18} color={globalLives != null && globalLives > 0 ? HEART_COLOR : C.muted} />
                  <Text style={{ marginLeft: 6, color: C.primary, fontWeight: "900" }}>{globalLives != null ? `${globalLives}` : `—`}</Text>
                </View>
              </TouchableOpacity>
            </View>

            <ScrollView contentContainerStyle={styles.body}>
              <Text style={styles.mainTitle}>Rules</Text>

              <View style={styles.rulesInfoColumn}>
                <View style={styles.rulesRow}>
                  <View style={styles.rulesIconWrap}><Ionicons name="list-outline" size={20} color={C.primary} /></View>
                  <View style={styles.rulesTextWrap}>
                    <Text style={styles.rulesNumber}>{examMeta?.totalQuestions ?? questions.length} questions</Text>
                    <Text style={styles.rulesLabel}>Number of questions</Text>
                  </View>
                </View>

                <View style={styles.rulesRow}>
                  <View style={styles.rulesIconWrap}><Ionicons name="time-outline" size={20} color={C.primary} /></View>
                  <View style={styles.rulesTextWrap}>
                    <Text style={styles.rulesNumber}>{formatTime(examMeta?.timeLimit ?? 0)}</Text>
                    <Text style={styles.rulesLabel}>Time limit</Text>
                  </View>
                </View>

                <View style={styles.rulesRow}>
                  <View style={styles.rulesIconWrap}><Ionicons name="ticket-outline" size={20} color={C.primary} /></View>
                  <View style={styles.rulesTextWrap}>
                    <Text style={styles.rulesNumber}>{Number(attemptsUsedForUI || 0)} / {Number(examMeta?.maxAttempts || 1)}</Text>
                    <Text style={styles.rulesLabel}>Attempts used</Text>
                  </View>
                </View>

                {!isCompetitive && hasPassPercent ? (
                  <View style={styles.rulesRow}>
                    <View style={styles.rulesIconWrap}><Ionicons name="shield-checkmark-outline" size={20} color={C.primary} /></View>
                    <View style={styles.rulesTextWrap}>
                      <Text style={styles.rulesNumber}>{passingPercent}%</Text>
                      <Text style={styles.rulesLabel}>Passing score (practice)</Text>
                    </View>
                  </View>
                ) : null}

                {examMeta?.rankingEnabled ? (
                  <View style={styles.rulesRow}>
                    <View style={styles.rulesIconWrap}><Ionicons name="trophy-outline" size={20} color={C.primary} /></View>
                    <View style={styles.rulesTextWrap}>
                      <Text style={styles.rulesNumber}>Ranking Enabled</Text>
                      <Text style={styles.rulesLabel}>This attempt contributes to leaderboard</Text>
                    </View>
                  </View>
                ) : null}
              </View>

              {!!instructionsList.length && (
                <View style={styles.infoCard}>
                  <Text style={styles.infoTitle}>Instructions</Text>
                  {instructionsList.map((line, idx) => (
                    <Text key={`${line}_${idx}`} style={styles.infoText}>• {line}</Text>
                  ))}
                </View>
              )}

              {attemptsLeft <= 0 && !inProgressAttempt ? (
                <View style={styles.noAttemptsCard}>
                  <TouchableOpacity
                    style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}
                    onPress={() => setShowAttemptsExhaustedDetails((p) => !p)}
                    activeOpacity={0.8}
                  >
                    <View style={{ flexDirection: "row", alignItems: "center" }}>
                      <Ionicons name="alert-circle-outline" size={20} color="#C2410C" />
                      <Text style={styles.noAttemptsTitle}>Attempts exhausted</Text>
                    </View>
                    <Ionicons name={showAttemptsExhaustedDetails ? "chevron-up" : "chevron-down"} size={18} color="#C2410C" />
                  </TouchableOpacity>

                  {showAttemptsExhaustedDetails ? (
                    <>
                      <Text style={styles.noAttemptsSub}>
                        {isCompetitive
                          ? "This round allows limited attempts and you have used all available attempts."
                          : "You used all attempts for this exam. Attempts refill by configured interval."}
                      </Text>
                      {!isCompetitive ? <Text style={styles.noAttemptsTimer}>Next attempt in {formatMsToMMSS(nextAttemptInMs)}</Text> : null}
                    </>
                  ) : null}
                </View>
              ) : null}

              {!isCompetitive && (
                <View style={styles.feedbackRow}>
                  <Text style={{ fontWeight: "800", color: C.text, marginRight: 8 }}>Feedback</Text>
                  <View style={{ flexDirection: "row" }}>
                    <TouchableOpacity style={[styles.toggleBtn, feedbackMode === "instant" ? styles.toggleOn : styles.toggleOff]} onPress={() => setFeedbackMode("instant")}>
                      <Text style={feedbackMode === "instant" ? styles.toggleTextOn : styles.toggleTextOff}>Instant</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.toggleBtn, feedbackMode === "end" ? styles.toggleOn : styles.toggleOff]} onPress={() => setFeedbackMode("end")}>
                      <Text style={feedbackMode === "end" ? styles.toggleTextOn : styles.toggleTextOff}>End of exam</Text>
                    </TouchableOpacity>
                  </View>
                  <TouchableOpacity style={{ marginLeft: 10 }} onPress={() => setShowFeedbackInfoModal(true)}>
                    <Ionicons name="information-circle-outline" size={18} color={C.muted} />
                  </TouchableOpacity>
                </View>
              )}

              {questionLoadError ? <Text style={styles.warning}>{questionLoadError}</Text> : null}
              {!canStart.ok && !questionLoadError ? <Text style={styles.warning}>{canStart.reason}</Text> : null}

              {inProgressAttempt && attemptId ? (
                <TouchableOpacity style={styles.primaryBtn} onPress={resumeExam}>
                  <Text style={styles.primaryBtnText}>Resume Test</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity style={[styles.primaryBtn, !canStart.ok ? { opacity: 0.55 } : null]} disabled={!canStart.ok} onPress={startExam}>
                  <Text style={styles.primaryBtnText}>Start Test</Text>
                </TouchableOpacity>
              )}
            </ScrollView>
          </View>
        )}

        {stage === "exam" && (
          <View style={styles.panel}>
            <View style={styles.headerBar}>
              <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}><Ionicons name="chevron-back" size={22} color={C.text} /></TouchableOpacity>
              <View style={{ flex: 1 }}>
                <Text style={styles.title}>{examMeta?.name || "Exam"}</Text>
                <Text style={styles.subtitle}>Question {Math.min(currentIndex + 1, totalQ)} / {totalQ}</Text>
              </View>
              <View style={styles.timerPill}>
                <Ionicons name="time-outline" size={16} color={C.primary} />
                <Text style={styles.timer}>{formatTime(timeLeft)}</Text>
              </View>
            </View>

            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: `${examProgressPct}%` }]} />
            </View>

            <ScrollView contentContainerStyle={styles.examBody}>
              {!q ? (
                <Text style={styles.warning}>Question not available.</Text>
              ) : (
                <>
                  <View style={styles.qCard}>
                    <Text style={styles.qText}>{q.question}</Text>
                  </View>

                  {Object.keys(q.options || {}).map((optKey) => {
                    const selected = answers?.[q.id] === optKey;
                    const showInstant = feedbackMode === "instant" && answers?.[q.id] != null;
                    const isCorrectOpt = String(q.correctAnswer || "") === String(optKey);
                    const isWrongSel = selected && !isCorrectOpt;

                    return (
                      <TouchableOpacity
                        key={optKey}
                        disabled={showInstant}
                        onPress={() => setAnswer(q.id, optKey)}
                        style={[
                          styles.option,
                          styles.optionDefault,
                          selected ? styles.optionSelected : null,
                          showInstant && isCorrectOpt ? styles.correctFlash : null,
                          showInstant && isWrongSel ? styles.wrongFlash : null,
                        ]}
                      >
                        <View style={[styles.optBadge, selected ? styles.optBadgeSel : styles.optBadgeDef]}>
                          <Text style={styles.optLetter}>{optKey}</Text>
                        </View>
                        <Text style={[styles.optText, selected ? styles.optTextSel : null]}>{q.options[optKey]}</Text>
                      </TouchableOpacity>
                    );
                  })}

                  {feedbackMode === "instant" && selectedFeedback ? (
                    <Text style={{ marginTop: 10, fontWeight: "800", color: selectedFeedback === "correct" ? C.success : C.danger }}>
                      {selectedFeedback === "correct" ? "Correct ✅" : "Wrong ❌"}
                    </Text>
                  ) : null}

                  {feedbackMode === "instant" && answers?.[q?.id] != null && q?.explanation ? (
                    <View style={styles.explanationCard}>
                      <Text style={styles.explanationTitle}>Explanation</Text>
                      <Text style={styles.explanationText}>{q.explanation}</Text>
                    </View>
                  ) : null}
                </>
              )}
            </ScrollView>

            <View style={styles.footer}>
              <TouchableOpacity style={styles.ghostBtn} onPress={prevQ} disabled={currentIndex <= 0}>
                <Text style={styles.ghostTxt}>Previous</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.primaryBtnSmall} onPress={nextQ}>
                <Text style={styles.primaryBtnText}>{currentIndex < totalQ - 1 ? "Next" : "Submit"}</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {stage === "result" && showPostSubmitReview && (
          <View style={styles.panel}>
            <View style={styles.headerBar}>
              <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
                <Ionicons name="chevron-back" size={22} color={C.text} />
              </TouchableOpacity>
              <View style={{ flex: 1 }}>
                <Text style={styles.title}>Review Answers</Text>
                <Text style={styles.subtitle}>{reviewIndex + 1} / {totalQ}</Text>
              </View>
              <Text style={{ fontWeight: "900", color: C.primary }}>{Math.round(Number(result?.percent || 0))}%</Text>
            </View>

            {(() => {
              const rqId = order[reviewIndex];
              const rq = questions.find((x) => x.id === rqId);
              if (!rq) return <Text style={styles.warning}>Review question unavailable.</Text>;

              const selected = answers?.[rq.id];
              const correct = rq.correctAnswer;
              const isCorrect = String(selected || "") === String(correct || "");

              return (
                <ScrollView contentContainerStyle={styles.examBody}>
                  <View style={styles.qCard}>
                    <Text style={styles.qText}>{rq.question}</Text>
                  </View>

                  {Object.keys(rq.options || {}).map((optKey) => {
                    const isSel = selected === optKey;
                    const isRight = String(correct) === String(optKey);

                    return (
                      <View
                        key={optKey}
                        style={[
                          styles.option,
                          styles.optionDefault,
                          isRight ? styles.correctFlash : null,
                          isSel && !isRight ? styles.wrongFlash : null,
                        ]}
                      >
                        <View style={[styles.optBadge, styles.optBadgeDef]}>
                          <Text style={styles.optLetter}>{optKey}</Text>
                        </View>
                        <Text style={styles.optText}>
                          {rq.options[optKey]}
                          {isSel ? " • your answer" : ""}
                          {isRight ? " • correct" : ""}
                        </Text>
                      </View>
                    );
                  })}

                  <View style={styles.explanationCard}>
                    <Text style={[styles.explanationTitle, { color: isCorrect ? C.success : C.danger }]}>
                      {isCorrect ? "Correct ✅" : "Incorrect ❌"}
                    </Text>
                    {!!rq.explanation && <Text style={styles.explanationText}>{rq.explanation}</Text>}
                  </View>
                </ScrollView>
              );
            })()}

            <View style={styles.footer}>
              <TouchableOpacity style={styles.ghostBtn} disabled={reviewIndex <= 0} onPress={() => setReviewIndex((i) => Math.max(0, i - 1))}>
                <Text style={styles.ghostTxt}>Previous</Text>
              </TouchableOpacity>
              {reviewIndex < totalQ - 1 ? (
                <TouchableOpacity style={styles.primaryBtnSmall} onPress={() => setReviewIndex((i) => i + 1)}>
                  <Text style={styles.primaryBtnText}>Next</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity style={styles.primaryBtnSmall} onPress={() => router.back()}>
                  <Text style={styles.primaryBtnText}>Finish</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        )}

{stage === "result" && !showPostSubmitReview && (
  <View style={styles.resultScreen}>
    <Animated.View
      style={[
        styles.resultBgOrnament,
        {
          opacity: resultConfetti.interpolate({ inputRange: [0, 1], outputRange: [0, 0.25] }),
          transform: [{ scale: resultConfetti.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1.1] }) }],
        },
      ]}
    />

    <View style={styles.resultCenter}>
      <Animated.View
        style={[
          styles.resultCard,
          {
            opacity: resultPop,
            transform: [
              { scale: resultPop.interpolate({ inputRange: [0, 1], outputRange: [0.88, 1] }) },
              { translateY: resultPop.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) },
            ],
          },
        ]}
      >
        <Animated.View style={{ transform: [{ scale: resultPulse }] }}>
          <View style={[styles.resultBadgeBubble, { backgroundColor: isPass ? "#ECFDF3" : "#FEF2F2" }]}>
            <Ionicons
              name={isPass ? "checkmark-circle" : "refresh-circle"}
              size={42}
              color={isPass ? C.success : C.danger}
            />
          </View>
        </Animated.View>

        <Text style={styles.resultTitle}>{gradeLabel}</Text>
        <Text style={styles.resultPct}>{Math.round(Number(result?.percent || 0))}%</Text>
        <Text style={styles.resultSub}>{result?.correct ?? 0} / {result?.total ?? 0} correct</Text>

        <View style={styles.resultStatsRow}>
          <View style={styles.resultStatBox}>
            <Text style={styles.resultStatLabel}>Correct</Text>
            <Text style={[styles.resultStatValue, { color: C.success }]}>{result?.correct ?? 0}</Text>
          </View>
          <View style={styles.resultStatBox}>
            <Text style={styles.resultStatLabel}>Wrong</Text>
            <Text style={[styles.resultStatValue, { color: C.danger }]}>
              {Math.max(0, Number(result?.total || 0) - Number(result?.correct || 0))}
            </Text>
          </View>
          <View style={styles.resultStatBox}>
            <Text style={styles.resultStatLabel}>Score</Text>
            <Text style={[styles.resultStatValue, { color: C.primary }]}>
              {Math.round(Number(result?.percent || 0))}%
            </Text>
          </View>
        </View>

        {result?.badge ? (
          <View style={styles.resultChip}>
            <Ionicons name="ribbon" size={14} color={C.primary} />
            <Text style={styles.resultChipText}>Badge: {String(result.badge).toUpperCase()}</Text>
          </View>
        ) : null}

        <View style={{ flexDirection: "row", width: "100%", gap: 10, marginTop: 16 }}>
          {!isCompetitive && feedbackMode === "end" ? (
            <TouchableOpacity
              style={[styles.ghostBtn, { flex: 1 }]}
              onPress={() => {
                setShowPostSubmitReview(true);
                setReviewIndex(Math.max(0, (order.length || questions.length) - 1));
              }}
            >
              <Text style={styles.ghostTxt}>Review</Text>
            </TouchableOpacity>
          ) : null}

          <TouchableOpacity style={[styles.primaryBtnSmall, { flex: 1 }]} onPress={() => router.back()}>
            <Text style={styles.primaryBtnText}>Back to Rounds</Text>
          </TouchableOpacity>
        </View>
      </Animated.View>
    </View>
  </View>
)}
      </View>

      <Modal visible={showHeartInfoModal} transparent animationType="none" onRequestClose={() => setShowHeartInfoModal(false)}>
        <View style={modalStyles.overlay}>
          <Animated.View style={[modalStyles.card, { transform: [{ scale: heartModalAnim.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }) }], opacity: heartModalAnim }]}>
            <Text style={modalStyles.title}>Lives & refill</Text>
            <Text style={modalStyles.text}>Hearts are global across subjects.</Text>
            <View style={{ marginTop: 12, alignItems: "center" }}>
              <Ionicons name={globalLives != null && globalLives > 0 ? "heart" : "heart-outline"} size={32} color={globalLives != null && globalLives > 0 ? HEART_COLOR : C.muted} />
              <Text style={{ fontWeight: "900", marginTop: 8, fontSize: 18 }}>{globalLives != null ? `${globalLives} / ${globalMaxLives}` : `— / ${globalMaxLives}`}</Text>
              <Text style={{ marginTop: 8, color: C.muted }}>
                {globalLives != null && globalLives >= globalMaxLives ? "Lives full" : `Next life in: ${formatMsToMMSS(nextHeartInMs)}`}
              </Text>
              <Text style={{ marginTop: 6, color: C.muted, fontSize: 12 }}>Refill interval: {Math.round(globalRefillMs / 60000)} min</Text>
            </View>
            <TouchableOpacity style={modalStyles.closeBtnPrimary} onPress={() => setShowHeartInfoModal(false)}>
              <Text style={modalStyles.closeBtnTextPrimary}>Close</Text>
            </TouchableOpacity>
          </Animated.View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeRoot: { flex: 1, backgroundColor: C.bg },
  loadingWrap: { flex: 1, backgroundColor: C.bg, justifyContent: "center", alignItems: "center" },

  root: { flex: 1, backgroundColor: C.bg },
  panel: { flex: 1, backgroundColor: C.bg },

  headerBar: {
    minHeight: 62,
    paddingHorizontal: 16,
    paddingTop: Platform.OS === "android" ? (StatusBar.currentHeight || 0) : 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: C.bg,
  },
  backBtn: { width: 40, height: 40, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: "#F7F9FF" },
  title: { fontSize: 18, fontWeight: "900", color: C.text },
  subtitle: { marginTop: 2, color: C.muted, fontSize: 12 },

  body: { paddingHorizontal: 16, paddingBottom: 24 },
  mainTitle: { fontSize: 24, fontWeight: "900", color: C.text, marginTop: 8, marginBottom: 10 },

  rulesInfoColumn: { width: "100%", marginBottom: 12 },
  rulesRow: { flexDirection: "row", alignItems: "center", paddingVertical: 8, borderRadius: 10 },
  rulesIconWrap: {
    width: 48, height: 48, borderRadius: 10, borderWidth: 1, borderColor: "#EAF0FF",
    alignItems: "center", justifyContent: "center", marginRight: 12, backgroundColor: "#fff",
  },
  rulesTextWrap: { flex: 1 },
  rulesNumber: { fontWeight: "900", color: C.text, fontSize: 16 },
  rulesLabel: { color: C.muted, marginTop: 2 },

  infoCard: {
    marginTop: 8,
    borderWidth: 1,
    borderColor: "#EAF0FF",
    backgroundColor: "#F8FAFF",
    borderRadius: 12,
    padding: 12,
  },
  infoTitle: { fontWeight: "900", color: C.text, marginBottom: 6 },
  infoText: { color: C.muted, lineHeight: 20 },

  noAttemptsCard: {
    marginTop: 12,
    borderWidth: 1,
    borderColor: C.warningBorder,
    backgroundColor: C.warningBg,
    borderRadius: 12,
    padding: 12,
  },
  noAttemptsTitle: { marginLeft: 8, fontWeight: "900", color: "#C2410C" },
  noAttemptsSub: { marginTop: 8, color: "#9A3412", lineHeight: 20, fontWeight: "600" },
  noAttemptsTimer: { marginTop: 8, color: C.primary, fontWeight: "900" },

  feedbackRow: { flexDirection: "row", alignItems: "center", marginTop: 10, marginBottom: 8 },
  warning: { marginTop: 12, color: "#B54708", fontWeight: "700" },

  primaryBtn: { marginTop: 18, backgroundColor: C.primary, borderRadius: 12, alignItems: "center", paddingVertical: 14 },
  primaryBtnSmall: { backgroundColor: C.primary, borderRadius: 12, alignItems: "center", paddingVertical: 12, paddingHorizontal: 24 },
  primaryBtnText: { color: "#fff", fontWeight: "900" },

  examBody: { flexGrow: 1, paddingHorizontal: 16, paddingBottom: 12 },
  timerPill: { flexDirection: "row", alignItems: "center", backgroundColor: "#EEF4FF", borderRadius: 12, paddingHorizontal: 10, paddingVertical: 6 },
  timer: { marginLeft: 6, color: C.primary, fontWeight: "800" },

  progressTrack: {
    marginHorizontal: 16,
    marginTop: 8,
    height: 8,
    borderRadius: 999,
    backgroundColor: "#EAF0FF",
    overflow: "hidden",
  },
  progressFill: {
    height: 8,
    backgroundColor: C.primary,
  },

  qCard: { marginTop: 12, backgroundColor: "#fff", borderRadius: 14, borderWidth: 1, borderColor: C.border, padding: 12 },
  qText: { fontSize: 18, fontWeight: "900", color: C.text },

  option: { marginTop: 10, borderRadius: 12, padding: 12, flexDirection: "row", alignItems: "center" },
  optionDefault: { backgroundColor: "#FAFBFF", borderWidth: 1, borderColor: "#EAF0FF" },
  optionSelected: { backgroundColor: C.primary },
  correctFlash: { backgroundColor: "#ECFDF3", borderColor: "#ABEFC6" },
  wrongFlash: { backgroundColor: "#FEF3F2", borderColor: "#FECACA" },

  optBadge: { width: 34, height: 34, borderRadius: 17, marginRight: 10, alignItems: "center", justifyContent: "center" },
  optBadgeDef: { borderWidth: 1, borderColor: C.muted },
  optBadgeSel: { backgroundColor: "#fff" },
  optLetter: { color: C.muted, fontWeight: "800" },

  optText: { flex: 1, color: "#111827", fontSize: 14 },
  optTextSel: { color: "#fff", fontWeight: "800" },

  explanationCard: {
    marginTop: 12,
    borderWidth: 1,
    borderColor: "#EAF0FF",
    backgroundColor: "#F8FAFF",
    borderRadius: 12,
    padding: 12,
  },
  explanationTitle: {
    fontWeight: "900",
    color: C.text,
    marginBottom: 6,
  },
  explanationText: {
    color: C.muted,
    lineHeight: 20,
  },

  footer: { marginTop: 8, marginHorizontal: 16, marginBottom: 12, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  ghostBtn: { borderWidth: 1, borderColor: "#EAF0FF", borderRadius: 10, paddingVertical: 12, paddingHorizontal: 18 },
  ghostTxt: { color: C.muted, fontWeight: "800" },

   resultScreen: { flex: 1, backgroundColor: C.bg },
  resultCenter: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 16 },
  resultCard: {
    width: "100%",
    backgroundColor: "#fff",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: "center",
    padding: 24,
    shadowColor: "#000",
    shadowOpacity: 0.05,
    shadowRadius: 10,
    elevation: 3,
  },
  resultPct: { fontSize: 56, color: C.primary, fontWeight: "900", marginTop: 4 },
  resultSub: { marginTop: 8, color: C.muted, textAlign: "center", fontWeight: "700" },

  resultBgOrnament: {
    position: "absolute",
    top: "15%",
    left: "10%",
    width: 280,
    height: 280,
    borderRadius: 140,
    backgroundColor: C.primary,
  },
  resultBadgeBubble: {
    width: 78,
    height: 78,
    borderRadius: 39,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 2,
  },
  resultTitle: {
    marginTop: 12,
    fontSize: 22,
    fontWeight: "900",
    color: C.text,
  },
  resultStatsRow: {
    marginTop: 14,
    flexDirection: "row",
    width: "100%",
    gap: 8,
  },
  resultStatBox: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#EAF0FF",
    backgroundColor: "#F8FAFF",
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: "center",
  },
  resultStatLabel: {
    color: C.muted,
    fontSize: 11,
    fontWeight: "700",
  },
  resultStatValue: {
    marginTop: 4,
    fontSize: 18,
    fontWeight: "900",
  },
  resultChip: {
    marginTop: 12,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#EEF4FF",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  resultChipText: {
    marginLeft: 6,
    color: C.primary,
    fontWeight: "800",
    fontSize: 12,
  },

  toggleBtn: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10, marginRight: 8, borderWidth: 1, borderColor: "#EAF0FF" },
  toggleOn: { backgroundColor: C.primary, borderColor: C.primary },
  toggleOff: { backgroundColor: "#fff", borderColor: "#EAF0FF" },
  toggleTextOn: { color: "#fff", fontWeight: "800" },
  toggleTextOff: { color: C.text, fontWeight: "800" },
});


const modalStyles = StyleSheet.create({
  overlay: {
    flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "center", alignItems: "center", padding: 20,
  },
  card: {
    width: "100%", maxWidth: 420, backgroundColor: "#fff", borderRadius: 14, padding: 18, alignItems: "center",
  },
  title: { fontSize: 20, fontWeight: "900", marginBottom: 8, color: C.text },
  text: { color: C.muted, textAlign: "center" },
  countdown: { marginTop: 6, fontWeight: "900", color: C.primary },
  closeBtn: { marginTop: 18, backgroundColor: "#E5E7EB", paddingVertical: 10, borderRadius: 10, alignItems: "center", width: "100%" },
  closeBtnText: { color: "#6B7280", fontWeight: "800" },
  modeTitle: { marginTop: 10, fontWeight: "800", color: C.text },
  modeText: { marginTop: 6, color: C.muted, lineHeight: 20 },
  closeBtnPrimary: { marginTop: 18, backgroundColor: C.primary, paddingVertical: 10, borderRadius: 10, alignItems: "center", width: "100%" },
  closeBtnTextPrimary: { color: "#fff", fontWeight: "900" },
});