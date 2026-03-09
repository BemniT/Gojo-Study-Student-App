import React, { useEffect, useState, useRef, useMemo, useCallback } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, SafeAreaView, ScrollView,
  Platform, Animated, Alert, StatusBar, Vibration, Modal,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useRouter, useLocalSearchParams } from "expo-router";
import { ref, get } from "firebase/database";
import { database } from "../constants/firebaseConfig";
import { Ionicons } from "@expo/vector-icons";
import { getValue, pushAndSet, runTransactionSafe, safeUpdate } from "./lib/dbHelpers";

const C = {
  primary: "#0B72FF", muted: "#6B78A8", bg: "#FFFFFF", text: "#0B2540",
  border: "#EAF0FF", success: "#16A34A", danger: "#EF4444",
  warningBg: "#FFF7ED", warningBorder: "#FED7AA",
};
const HEART_COLOR = "#EF4444";
const DEFAULT_HEART_REFILL_MS = 20 * 60 * 1000;
const DEFAULT_MAX_LIVES = 5;
const WRONGS_PER_LIFE_FALLBACK = 2;

function toMsTs(v) { const n = Number(v || 0); if (!Number.isFinite(n) || n <= 0) return 0; return n < 1e12 ? n * 1000 : n; }
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
  let correct = 0, total = 0;
  qOrder.forEach((qId) => {
    const q = map[String(qId)];
    if (!q) return;
    total += 1;
    if (String(q.correctAnswer ?? "").trim() !== "" && String(answers?.[String(qId)] ?? "").trim() === String(q.correctAnswer ?? "").trim()) correct += 1;
  });
  return { correct, total, percent: total ? (correct / total) * 100 : 0 };
}
function getBadgeAndPoints(examMeta, percent) {
  let badge = null, points = 0;
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
  return `${Math.floor(s / 60).toString().padStart(2, "0")}:${Math.floor(s % 60).toString().padStart(2, "0")}`;
}
function formatMsToMMSS(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60).toString().padStart(2, "0")}:${Math.floor(s % 60).toString().padStart(2, "0")}`;
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
function resolveLivesPolicy(appCfgLives, studentLivesRaw) {
  const useStudentOverride = appCfgLives?.useStudentOverride !== false;
  const maxDefault = Number(appCfgLives?.defaultMaxLives || DEFAULT_MAX_LIVES);
  const refillDefault = Number(appCfgLives?.defaultRefillIntervalMs || DEFAULT_HEART_REFILL_MS);

  const studentMax = Number(studentLivesRaw?.maxLives ?? studentLivesRaw?.max ?? NaN);
  const rawRefill = studentLivesRaw?.refillIntervalMs ?? studentLivesRaw?.refillInterval ?? null;
  let studentRefill = NaN;
  if (rawRefill != null) {
    const n = Number(rawRefill);
    if (Number.isFinite(n)) studentRefill = n > 1000 ? n : n * 1000;
  }

  const maxLives = useStudentOverride && Number.isFinite(studentMax) ? studentMax : maxDefault;
  const refillMs = useStudentOverride && Number.isFinite(studentRefill) ? studentRefill : refillDefault;
  return { maxLives, refillMs, useStudentOverride };
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
  const [appExamConfig, setAppExamConfig] = useState({
    lives: {
      defaultMaxLives: DEFAULT_MAX_LIVES,
      defaultRefillIntervalMs: DEFAULT_HEART_REFILL_MS,
      fallbackWrongsPerLife: WRONGS_PER_LIFE_FALLBACK,
      useStudentOverride: true,
    },
    ui: {},
  });

  const loadQuestionBank = useCallback(async (qbId) => {
    setQuestionLoadError(null);
    if (!qbId) { setQuestionLoadError("Question bank id missing."); setQuestions([]); return; }

    const direct = [
      `Platform1/questionBanks/${qbId}`,
      `Platform1/questionBanks/questionBanks/${qbId}`,
      `Platform1/companyExams/questionBanks/${qbId}`,
      `companyExams/questionBanks/${qbId}`,
      `questionBanks/${qbId}`,
      `questionBanks/questionBanks/${qbId}`,
    ];

    let qb = await getValue(direct);
    if (qb?.questions) { setQuestions(Object.entries(qb.questions).map(([id, q]) => ({ id, ...q }))); return; }

    const parents = [
      `Platform1/questionBanks`, `Platform1/questionBanks/questionBanks`, `questionBanks`,
      `questionBanks/questionBanks`, `Platform1/companyExams/questionBanks`, `companyExams/questionBanks`, `Platform1`,
    ];

    for (const p of parents) {
      const node = await getValue([p]);
      if (!node) continue;
      if (node[qbId]?.questions) { qb = node[qbId]; break; }
      if (node.questionBanks?.[qbId]?.questions) { qb = node.questionBanks[qbId]; break; }
      if (node.questionBanks?.questionBanks?.[qbId]?.questions) { qb = node.questionBanks.questionBanks[qbId]; break; }
    }

    if (qb?.questions) setQuestions(Object.entries(qb.questions).map(([id, q]) => ({ id, ...q })));
    else { setQuestions([]); setQuestionLoadError(`Question bank not found for ${qbId}`); }
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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);

      const cfg = await getValue([`Platform1/appConfig/exams`, `appConfig/exams`]);
      if (!cancelled && cfg) {
        setAppExamConfig((prev) => ({
          ...prev,
          ...cfg,
          lives: { ...prev.lives, ...(cfg.lives || {}) },
          ui: { ...prev.ui, ...(cfg.ui || {}) },
        }));
      }

      const sid =
        (await AsyncStorage.getItem("studentNodeKey")) ||
        (await AsyncStorage.getItem("studentId")) ||
        (await AsyncStorage.getItem("username")) || null;
      if (!cancelled) setStudentId(sid);

      if (sid) {
        const livesNode = await getValue([`Platform1/studentLives/${sid}`, `studentLives/${sid}`]);
        const policy = resolveLivesPolicy(cfg?.lives || {}, livesNode || {});
        const raw = livesNode || {};
        const rawCurrent = Number(raw.currentLives ?? raw.lives ?? 0);
        const lastConsumed = toMsTs(raw.lastConsumedAt ?? raw.lastConsumed ?? 0) || 0;

        let computedCurrent = Number.isFinite(rawCurrent) ? rawCurrent : 0;
        let computedLastConsumed = lastConsumed || 0;

        if (policy.refillMs > 0 && lastConsumed && computedCurrent < policy.maxLives) {
          const elapsed = Math.max(0, Date.now() - lastConsumed);
          const recovered = Math.floor(elapsed / policy.refillMs);
          if (recovered > 0) {
            computedCurrent = Math.min(policy.maxLives, computedCurrent + recovered);
            computedLastConsumed = lastConsumed + recovered * policy.refillMs;
            await safeUpdate({
              [`Platform1/studentLives/${sid}/currentLives`]: computedCurrent,
              [`Platform1/studentLives/${sid}/lastConsumedAt`]: computedLastConsumed,
            }).catch(() => {});
          }
        }

        if (!cancelled) {
          setGlobalLives(computedCurrent);
          setGlobalMaxLives(policy.maxLives);
          setGlobalRefillMs(policy.refillMs);
          setGlobalLastConsumedAt(computedLastConsumed || null);
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
      if (rMeta?.packageId) pkgMeta = await getValue([`Platform1/companyExams/packages/${rMeta.packageId}`, `companyExams/packages/${rMeta.packageId}`]);
      if (!cancelled) setIsCompetitive(String(pkgMeta?.type || "").toLowerCase() === "competitive");
      if (!cancelled) setFeedbackMode(exam?.scoringEnabled ? "end" : "instant");

      let qbId = questionBankIdParam || exam?.questionBankId || null;
      if (!qbId && examId) {
        const examMap = await getValue([`Platform1/companyExams/exams`, `companyExams/exams`]);
        if (examMap?.[examId]?.questionBankId) qbId = examMap[examId].questionBankId;
      }
      await loadQuestionBank(qbId);

      if (!cancelled) setLoading(false);
    })();

    return () => clearInterval(timerRef.current);
  }, [roundId, examId, questionBankIdParam, mode, findRoundMetaById, loadQuestionBank]);

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
    async function tick() {
      if (globalLives == null) return setNextHeartInMs(0);
      const state = computeRefillState({
        currentLives: globalLives, maxLives: globalMaxLives,
        lastConsumedAt: globalLastConsumedAt, refillMs: globalRefillMs,
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
        } finally { syncing = false; }
      }
    }
    tick();
    t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [studentId, globalLives, globalMaxLives, globalLastConsumedAt, globalRefillMs]);

  const persistStartAttempt = useCallback(async (qOrder) => {
    if (!studentId || !examId) return null;
    const baseAttempt = {
      roundId, attemptNo, attemptStatus: "in_progress", startTime: Date.now(),
      questionOrder: qOrder, answers: {}, scorePercent: null, pointsAwarded: 0,
      badge: null, rankingCounted: false, resultVisible: false, feedbackMode,
    };
    const newAttemptId = await pushAndSet(`Platform1/attempts/company/${studentId}/${examId}`, baseAttempt);
    setInProgressAttempt({ id: newAttemptId, ...baseAttempt });
    setAttemptId(newAttemptId);

    try {
      const progressPath = `Platform1/studentProgress/${studentId}/company/${roundId}/${examId}/attemptsUsed`;
      await runTransactionSafe(progressPath, (current = 0) => Number(current || 0) + 1);
      await safeUpdate({ [`Platform1/studentProgress/${studentId}/company/${roundId}/${examId}/lastAttemptTimestamp`]: Date.now() }).catch(() => {});
      setAttemptsUsed((p) => Number(p || 0) + 1);
    } catch {}
    wrongCountRef.current = 0;
    return newAttemptId;
  }, [studentId, examId, roundId, attemptNo, feedbackMode]);

  const submitExam = useCallback(async () => {
    clearInterval(timerRef.current);
    const finalOrder = order.length ? order : questions.map((q) => q.id);
    const computed = scoreExam(questions, finalOrder, answers);
    const scored = getBadgeAndPoints(examMeta, computed.percent);
    const now = Date.now();
    const resultVisible = examMeta?.scoringEnabled ? now >= toMsTs(roundMeta?.resultReleaseTimestamp) : true;

    if (studentId && examId && attemptId) {
      await safeUpdate({
        [`Platform1/attempts/company/${studentId}/${examId}/${attemptId}/endTime`]: now,
        [`Platform1/attempts/company/${studentId}/${examId}/${attemptId}/attemptStatus`]: "completed",
        [`Platform1/attempts/company/${studentId}/${examId}/${attemptId}/answers`]: answers,
        [`Platform1/attempts/company/${studentId}/${examId}/${attemptId}/scorePercent`]: computed.percent,
        [`Platform1/attempts/company/${studentId}/${examId}/${attemptId}/correctCount`]: computed.correct,
        [`Platform1/attempts/company/${studentId}/${examId}/${attemptId}/pointsAwarded`]: scored.points,
        [`Platform1/attempts/company/${studentId}/${examId}/${attemptId}/badge`]: scored.badge,
        [`Platform1/attempts/company/${studentId}/${examId}/${attemptId}/resultVisible`]: resultVisible,
      }).catch(() => {});
    }

    setResult({
      percent: computed.percent, correct: computed.correct, total: computed.total,
      badge: scored.badge, points: scored.points, resultVisible,
    });

    const shouldShowDetailedReview = !isCompetitive && feedbackMode === "end";
    setShowPostSubmitReview(shouldShowDetailedReview);
    setReviewIndex(0);
    setStage("result");
  }, [order, questions, answers, examMeta, roundMeta, studentId, examId, attemptId, isCompetitive, feedbackMode]);

  const attemptsLeft = Math.max(0, Number(examMeta?.maxAttempts || 1) - Number(attemptsUsed || 0));
  const totalQ = Math.max(1, order.length || questions.length || 1);
  const examProgressPct = Math.min(100, Math.max(0, ((currentIndex + 1) / totalQ) * 100));
  const qId = order[currentIndex];
  const q = questions.find((x) => x.id === qId);

  const startExam = useCallback(async () => {
    if (!examMeta) return Alert.alert("Cannot start", "Exam metadata unavailable.");
    const maxAttempts = Number(examMeta?.maxAttempts || 1);
    if (attemptsUsed >= maxAttempts && !inProgressAttempt) return;
    if (examMeta?.scoringEnabled && (!questions || questions.length === 0)) return Alert.alert("Cannot start", questionLoadError || "Question bank not loaded yet.");
    if (!isCompetitive && globalLives === 0) return setOutOfLivesModalVisible(true);

    const ids = questions.map((q) => q.id);
    if (!ids.length) return Alert.alert("No questions", "Question data not found for this exam.");

    const qOrder = shuffleArray(ids);
    setOrder(qOrder); setAnswers({}); setCurrentIndex(0); setTimeLeft(Number(examMeta?.timeLimit || 600));
    await persistStartAttempt(qOrder);

    clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setTimeLeft((t) => {
        if (t <= 1) { clearInterval(timerRef.current); submitExam(); return 0; }
        return t - 1;
      });
    }, 1000);
    setStage("exam");
  }, [examMeta, attemptsUsed, inProgressAttempt, questions, questionLoadError, isCompetitive, globalLives, persistStartAttempt, submitExam]);

  const setAnswer = useCallback(async (qid, optionKey) => {
    if (stage !== "exam") return;
    if (feedbackMode === "instant" && answers?.[qid] != null) return;
    setAnswers((p) => ({ ...p, [qid]: optionKey }));
    const qq = questions.find((x) => x.id === qid);
    if (qq && !isCompetitive && feedbackMode === "instant") {
      const correct = String(qq.correctAnswer || "") === String(optionKey || "");
      setSelectedFeedback(correct ? "correct" : "wrong");
      Vibration.vibrate(20);
    }
    if (!studentId || !examId || !attemptId) return;
    await safeUpdate({ [`Platform1/attempts/company/${studentId}/${examId}/${attemptId}/answers/${qid}`]: optionKey }).catch(() => {});
  }, [stage, feedbackMode, answers, questions, isCompetitive, studentId, examId, attemptId]);

  if (loading) {
    return (
      <SafeAreaView style={styles.loadingWrap}>
        <ActivityIndicator size="large" color={C.primary} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeRoot}>
      <StatusBar barStyle="dark-content" backgroundColor={C.bg} />

      {stage === "rules" && (
        <View style={styles.panel}>
          <View style={styles.headerBar}>
            <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
              <Ionicons name="chevron-back" size={22} color={C.text} />
            </TouchableOpacity>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>{examMeta?.name || "Practice Test"}</Text>
            </View>
          </View>
          <ScrollView contentContainerStyle={styles.body}>
            <Text style={styles.mainTitle}>Rules</Text>
            <TouchableOpacity style={styles.primaryBtn} onPress={startExam}>
              <Text style={styles.primaryBtnText}>Start Test</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      )}

      {stage === "exam" && (
        <View style={styles.panel}>
          <View style={styles.headerBar}>
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
            {q ? (
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
                        styles.option, styles.optionDefault,
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
            ) : <Text style={styles.warning}>Question not available.</Text>}
          </ScrollView>

          <View style={styles.footer}>
            <TouchableOpacity style={styles.ghostBtn} disabled={currentIndex <= 0} onPress={() => setCurrentIndex((i) => Math.max(0, i - 1))}>
              <Text style={styles.ghostTxt}>Previous</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.primaryBtnSmall} onPress={() => currentIndex < totalQ - 1 ? setCurrentIndex((i) => i + 1) : submitExam()}>
              <Text style={styles.primaryBtnText}>{currentIndex < totalQ - 1 ? "Next" : "Submit"}</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {stage === "result" && showPostSubmitReview && (
        <View style={styles.panel}>
          <View style={styles.headerBar}>
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
                <View style={styles.qCard}><Text style={styles.qText}>{rq.question}</Text></View>
                {Object.keys(rq.options || {}).map((optKey) => {
                  const isSel = selected === optKey;
                  const isRight = String(correct) === String(optKey);
                  return (
                    <View key={optKey} style={[styles.option, styles.optionDefault, isRight ? styles.correctFlash : null, isSel && !isRight ? styles.wrongFlash : null]}>
                      <View style={[styles.optBadge, styles.optBadgeDef]}><Text style={styles.optLetter}>{optKey}</Text></View>
                      <Text style={styles.optText}>{rq.options[optKey]}{isSel ? " • your answer" : ""}{isRight ? " • correct" : ""}</Text>
                    </View>
                  );
                })}
                <View style={styles.explanationCard}>
                  <Text style={[styles.explanationTitle, { color: isCorrect ? C.success : C.danger }]}>{isCorrect ? "Correct ✅" : "Incorrect ❌"}</Text>
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
          <View style={styles.resultCenter}>
            <View style={styles.resultCard}>
              <Text style={styles.celebrate}>🎉</Text>
              <Text style={styles.resultPct}>{Math.round(Number(result?.percent || 0))}%</Text>
              <Text style={styles.resultSub}>{result?.correct ?? 0} / {result?.total ?? 0} correct</Text>
              <View style={{ flexDirection: "row", width: "100%", gap: 10, marginTop: 14 }}>
                {!isCompetitive && feedbackMode === "end" ? (
                  <TouchableOpacity style={[styles.ghostBtn, { flex: 1 }]} onPress={() => { setShowPostSubmitReview(true); setReviewIndex(Math.max(0, totalQ - 1)); }}>
                    <Text style={styles.ghostTxt}>Previous</Text>
                  </TouchableOpacity>
                ) : null}
                <TouchableOpacity style={[styles.primaryBtnSmall, { flex: 1 }]} onPress={() => router.back()}>
                  <Text style={styles.primaryBtnText}>Back to Rounds</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeRoot: { flex: 1, backgroundColor: C.bg },
  loadingWrap: { flex: 1, backgroundColor: C.bg, justifyContent: "center", alignItems: "center" },
  root: { flex: 1, backgroundColor: C.bg },
  panel: { flex: 1, backgroundColor: C.bg },

  headerBar: {
    minHeight: 62, paddingHorizontal: 16,
    paddingTop: Platform.OS === "android" ? (StatusBar.currentHeight || 0) : 0,
    flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: C.bg,
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
    marginTop: 8, borderWidth: 1, borderColor: "#EAF0FF",
    backgroundColor: "#F8FAFF", borderRadius: 12, padding: 12,
  },
  infoTitle: { fontWeight: "900", color: C.text, marginBottom: 6 },
  infoText: { color: C.muted, lineHeight: 20 },

  noAttemptsCard: {
    marginTop: 12, borderWidth: 1, borderColor: C.warningBorder,
    backgroundColor: C.warningBg, borderRadius: 12, padding: 12,
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

  progressTrack: { marginHorizontal: 16, marginTop: 8, height: 8, borderRadius: 999, backgroundColor: "#EAF0FF", overflow: "hidden" },
  progressFill: { height: 8, backgroundColor: C.primary },

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
    marginTop: 12, borderWidth: 1, borderColor: "#EAF0FF",
    backgroundColor: "#F8FAFF", borderRadius: 12, padding: 12,
  },
  explanationTitle: { fontWeight: "900", color: C.text, marginBottom: 6 },
  explanationText: { color: C.muted, lineHeight: 20 },

  footer: { marginTop: 8, marginHorizontal: 16, marginBottom: 12, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  ghostBtn: { borderWidth: 1, borderColor: "#EAF0FF", borderRadius: 10, paddingVertical: 12, paddingHorizontal: 18 },
  ghostTxt: { color: C.muted, fontWeight: "800" },

  resultScreen: { flex: 1, backgroundColor: C.bg },
  resultCenter: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 16 },
  resultCard: {
    width: "100%", backgroundColor: "#fff", borderRadius: 16, borderWidth: 1, borderColor: C.border,
    alignItems: "center", padding: 24, shadowColor: "#000", shadowOpacity: 0.05, shadowRadius: 10, elevation: 3,
  },
  celebrate: { fontSize: 28 },
  resultPct: { fontSize: 56, color: C.primary, fontWeight: "900", marginTop: 4 },
  resultSub: { marginTop: 8, color: C.muted, textAlign: "center", fontWeight: "700" },

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