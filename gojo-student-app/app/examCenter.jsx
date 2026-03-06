// app/examCenter.jsx
// Added: Feedback info modal (Instant vs End-of-exam) and centered rules screen content.
// Other behavior preserved: feedback-mode toggle (practice defaults to Instant), competitive behavior unchanged.

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
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useRouter, useLocalSearchParams } from "expo-router";
import { ref, get, set, update, push } from "firebase/database";
import { database } from "../constants/firebaseConfig";
import { Ionicons } from "@expo/vector-icons";

const C = {
  primary: "#0B72FF",
  muted: "#6B78A8",
  bg: "#FFFFFF",
  text: "#0B2540",
  border: "#EAF0FF",
  success: "#16A34A",
  danger: "#EF4444",
};

const SLIDE_DISTANCE = 420;

async function tryGet(paths) {
  for (const p of paths) {
    try {
      const snap = await get(ref(database, p));
      if (snap && snap.exists()) return snap.val();
    } catch (e) {
      // continue
    }
  }
  return null;
}

function normalizeQuestionOrder(qOrder) {
  if (!qOrder) return [];
  if (Array.isArray(qOrder)) return qOrder;
  if (typeof qOrder === "object") {
    const keys = Object.keys(qOrder);
    const numeric = keys.every((k) => String(Number(k)) === String(k));
    if (numeric)
      return keys.map((k) => ({ k: Number(k), v: qOrder[k] })).sort((a, b) => a.k - b.k).map((x) => x.v);
    return keys.map((k) => qOrder[k]);
  }
  return [];
}

function scoreExam(questions, order, answers) {
  const qOrder = order.length ? order : questions.map((q) => q.id);
  const total = qOrder.length;
  let correct = 0;
  qOrder.forEach((qId) => {
    const q = questions.find((x) => x.id === qId) || {};
    if (String(answers[qId] || "") === String(q.correctAnswer || "")) correct += 1;
  });
  const percent = total ? (correct / total) * 100 : 0;
  return { correct, total, percent };
}
function getBadgeAndPoints(examMeta, percent) {
  let badge = null;
  let points = 0;
  if (examMeta?.scoringEnabled && examMeta?.scoring) {
    const s = examMeta.scoring;
    if (percent >= Number(s.platinumPercent || 90)) {
      badge = "platinum";
      points = Number(s.maxPoints || 3);
    } else if (percent >= Number(s.diamondPercent || 85)) {
      badge = "diamond";
      points = 2;
    } else if (percent >= Number(s.goldPercent || 75)) {
      badge = "gold";
      points = 1;
    }
  }
  return { badge, points };
}
function inWindow(roundMeta) {
  const now = Date.now();
  const start = Number(roundMeta?.startTimestamp || 0);
  const end = Number(roundMeta?.endTimestamp || 0);
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
function capitalize(s) { if (!s) return ""; return s[0].toUpperCase() + s.slice(1); }
function formatTime(sec) {
  const s = Number(sec || 0);
  const mm = Math.floor(s / 60).toString().padStart(2, "0");
  const ss = Math.floor(s % 60).toString().padStart(2, "0");
  return `${mm}:${ss}`;
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
  const [packageMeta, setPackageMeta] = useState(null);
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

  // Feedback mode: instant | end ; practice defaults to instant
  const [feedbackMode, setFeedbackMode] = useState("end");

  // Modal visibility
  const [showFeedbackInfoModal, setShowFeedbackInfoModal] = useState(false);

  const slide = useRef(new Animated.Value(0)).current;
  const progressAnim = useRef(new Animated.Value(0)).current;

  // Question bank loader (robust)
  const loadQuestionBank = useCallback(async (qbId) => {
    setQuestionLoadError(null);
    if (!qbId) {
      setQuestionLoadError("Question bank id missing.");
      setQuestions([]);
      return;
    }

    const paths = [
      `Platform1/companyExams/questionBanks/${qbId}`,
      `companyExams/questionBanks/${qbId}`,
      `Platform1/questionBanks/${qbId}`,
      `questionBanks/${qbId}`,
      `Platform1/questionBanks/questionBanks/${qbId}`,
      `questionBanks/questionBanks/${qbId}`,
    ];

    let qb = await tryGet(paths);
    if (!qb || !qb.questions) {
      // second attempt to find under parent containers
      const parents = [
        `Platform1/questionBanks`,
        `Platform1/questionBanks/questionBanks`,
        `questionBanks`,
        `questionBanks/questionBanks`,
        `Platform1/companyExams/questionBanks`,
        `companyExams/questionBanks`,
      ];
      for (const p of parents) {
        const node = await tryGet([p]);
        if (!node) continue;
        if (node[qbId] && node[qbId].questions) { qb = node[qbId]; break; }
        if (node.questionBanks && node.questionBanks[qbId] && node.questionBanks[qbId].questions) { qb = node.questionBanks[qbId]; break; }
        if (node.questionBanks && node.questionBanks.questionBanks && node.questionBanks.questionBanks[qbId] && node.questionBanks.questionBanks[qbId].questions) {
          qb = node.questionBanks.questionBanks[qbId]; break;
        }
      }
    }

    if (qb && qb.questions) {
      setQuestions(Object.entries(qb.questions).map(([id, q]) => ({ id, ...q })));
      setQuestionLoadError(null);
    } else {
      setQuestions([]);
      setQuestionLoadError(`Question bank not found for ${qbId}`);
      console.warn("QB lookup failed for", qbId);
    }
  }, []);

  // find round metadata inside packages
  const findRoundMetaById = useCallback(async (rid) => {
    const pkgs = await tryGet([`Platform1/companyExams/packages`, `companyExams/packages`]);
    if (!pkgs) return null;
    for (const pkgKey of Object.keys(pkgs)) {
      const pkg = pkgs[pkgKey] || {};
      const subjects = pkg.subjects || {};
      for (const sk of Object.keys(subjects)) {
        const subj = subjects[sk] || {};
        const rounds = subj.rounds || {};
        if (rounds && rounds[rid]) {
          const r = rounds[rid] || {};
          return { ...r, id: rid, packageId: pkgKey, subjectKey: sk };
        }
      }
    }
    return null;
  }, []);

  const loadPackageMeta = useCallback(async (pkgId) => {
    if (!pkgId) return null;
    const pkg = await tryGet([`Platform1/companyExams/packages/${pkgId}`, `companyExams/packages/${pkgId}`]);
    return pkg || null;
  }, []);

  // main load
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);

      const sid =
        (await AsyncStorage.getItem("studentNodeKey")) ||
        (await AsyncStorage.getItem("studentId")) ||
        (await AsyncStorage.getItem("username")) ||
        null;
      if (!cancelled) setStudentId(sid);

      const rMeta = await findRoundMetaById(roundId);
      if (!cancelled) setRoundMeta(rMeta || null);

      const exam = await tryGet([
        `Platform1/companyExams/exams/${examId}`,
        `companyExams/exams/${examId}`,
        `Platform1/exams/${examId}`,
        `exams/${examId}`,
      ]);
      if (!cancelled) setExamMeta(exam || null);

      let pkgMeta = null;
      if (rMeta?.packageId) {
        pkgMeta = await loadPackageMeta(rMeta.packageId);
        if (!cancelled) setPackageMeta(pkgMeta || null);
        if (!cancelled) setIsCompetitive(String(pkgMeta?.type || "").toLowerCase() === "competitive");
      } else {
        if (!cancelled) setPackageMeta(null);
        if (!cancelled) setIsCompetitive(false);
      }

      // default feedback mode: practice (no scoring) => instant
      if (!cancelled) {
        const defaultMode = exam && exam.scoringEnabled ? "end" : "instant";
        setFeedbackMode(defaultMode);
      }

      // resolve qb id
      let qbId = questionBankIdParam || (exam && exam.questionBankId) || null;
      if (!qbId && examId) {
        const examMap = await tryGet([`Platform1/companyExams/exams`, `companyExams/exams`]);
        if (examMap && examMap[examId] && examMap[examId].questionBankId) qbId = examMap[examId].questionBankId;
      }

      await loadQuestionBank(qbId);

      // attempts
      if (sid && examId) {
        const attemptsNode = (await tryGet([`Platform1/attempts/company/${sid}/${examId}`, `attempts/company/${sid}/${examId}`])) || {};
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
          const status = (a.attemptStatus || "").toLowerCase();
          if (status === "completed") {
            completedCount += 1;
            const endT = Number(a.endTime || a.startTime || 0);
            if (!latestCompleted || endT > (Number(latestCompleted.endTime || latestCompleted.startTime || 0))) {
              latestCompleted = a;
              latestCompletedKey = k;
            }
          } else if (status === "in_progress") {
            if (!latestInProgress) {
              latestInProgress = a;
              latestInProgressKey = k;
            } else {
              const prevStart = Number(latestInProgress.startTime || 0);
              const currStart = Number(a.startTime || 0);
              if (currStart > prevStart) {
                latestInProgress = a;
                latestInProgressKey = k;
              }
            }
          }
        }

        if (!cancelled) {
          setAttemptsUsed(completedCount);
          setAttemptNo(completedCount + 1);
        }

        if (latestInProgress && latestInProgressKey && !cancelled) {
          setInProgressAttempt({ id: latestInProgressKey, ...latestInProgress });
          setAttemptId(latestInProgressKey);
          setOrder(normalizeQuestionOrder(latestInProgress.questionOrder || {}));
          setAnswers(latestInProgress.answers || {});
          if (latestInProgress.remainingSeconds != null) setTimeLeft(Number(latestInProgress.remainingSeconds));
          else if (exam && exam.timeLimit && latestInProgress.startTime) {
            const elapsed = Math.floor((Date.now() - Number(latestInProgress.startTime || 0)) / 1000);
            setTimeLeft(Math.max(0, Number(exam.timeLimit || 0) - elapsed));
          }
        }

        if (latestCompleted && latestCompletedKey && !cancelled) {
          setLastCompletedAttempt({ id: latestCompletedKey, ...latestCompleted });
        }

        if ((mode === "review" || mode === "result") && keys.length && !cancelled) {
          const completedKeys = keys.filter((k) => ((entries[k]?.attemptStatus || "").toLowerCase() === "completed"));
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
            setReviewAttempt({ id: latestKey, ...raw, questionOrder: normalizeQuestionOrder(raw.questionOrder || {}), answers: raw.answers || {} });
          }
        }
      }

      if (!cancelled) setLoading(false);
    })();

    return () => clearInterval(timerRef.current);
  }, [roundId, examId, questionBankIdParam, mode, findRoundMetaById, loadQuestionBank, loadPackageMeta]);

  useEffect(() => {
    if (stage === "rules") Animated.timing(slide, { toValue: 0, duration: 260, useNativeDriver: true }).start();
    else if (stage === "exam") Animated.timing(slide, { toValue: 1, duration: 260, useNativeDriver: true }).start();
  }, [stage, slide]);

  useEffect(() => {
    const total = Math.max(1, (order.length || questions.length || 1));
    const p = ((currentIndex + 1) / total) * 100;
    Animated.timing(progressAnim, { toValue: p, duration: 220, useNativeDriver: false }).start();
  }, [currentIndex, order.length, questions.length, progressAnim]);

  const persistStartAttempt = useCallback(async (qOrder) => {
    if (!studentId || !examId) return null;
    const pathA = `attempts/company/${studentId}/${examId}`;
    const newRef = push(ref(database, pathA));
    const newAttemptId = newRef.key;
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
    await set(ref(database, `${pathA}/${newAttemptId}`), baseAttempt).catch(() => {});
    await set(ref(database, `Platform1/${pathA}/${newAttemptId}`), baseAttempt).catch(() => {});
    return newAttemptId;
  }, [studentId, examId, attemptNo, roundId, feedbackMode]);

  const startExam = useCallback(async () => {
    if (!examMeta) { Alert.alert("Cannot start", "Exam metadata unavailable."); return; }

    const maxAttempts = Number(examMeta?.maxAttempts || 1);
    if (isCompetitive && attemptsUsed >= maxAttempts && !inProgressAttempt) {
      Alert.alert("No Attempts", "This competitive exam allows one attempt only.");
      return;
    }

    if (examMeta?.scoringEnabled && (!questions || questions.length === 0)) {
      if (questionLoadError) Alert.alert("Cannot start", questionLoadError);
      else Alert.alert("Cannot start", "Question bank not loaded yet.");
      return;
    }

    const ids = questions.map((q) => q.id);
    if (!ids.length) { Alert.alert("No questions", "Question data not found for this exam."); return; }

    if (inProgressAttempt && attemptId) { Alert.alert("Resume available", "You have an unfinished attempt. Use Resume Test."); return; }

    setOrder(shuffleArray(ids));
    setAnswers({});
    setCurrentIndex(0);
    setTimeLeft(Number(examMeta?.timeLimit || 600));

    const aId = await persistStartAttempt(shuffleArray(ids));
    setAttemptId(aId);

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
  }, [examMeta, questions, inProgressAttempt, attemptId, persistStartAttempt, questionLoadError, isCompetitive, attemptsUsed]);

  const resumeExam = useCallback(() => {
    if (!inProgressAttempt || !attemptId) { Alert.alert("No attempt to resume"); return; }

    const normalizedOrder = normalizeQuestionOrder(inProgressAttempt.questionOrder || {});
    if (!order.length && normalizedOrder.length) setOrder(normalizedOrder);
    if (inProgressAttempt.answers) setAnswers(inProgressAttempt.answers || {});
    if (inProgressAttempt.remainingSeconds != null) setTimeLeft(Number(inProgressAttempt.remainingSeconds));
    else if (inProgressAttempt.startTime && examMeta?.timeLimit) {
      const elapsed = Math.floor((Date.now() - Number(inProgressAttempt.startTime || 0)) / 1000);
      setTimeLeft(Math.max(0, Number(examMeta.timeLimit || 600) - elapsed));
    } else setTimeLeft(Number(examMeta?.timeLimit || 600));

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
  }, [inProgressAttempt, attemptId, examMeta]);

  // IMPORTANT: Do NOT show correct/wrong flash for competitive exams.
  const setAnswer = useCallback(async (qId, optionKey) => {
    if (stage !== "exam") return;
    setAnswers((p) => ({ ...p, [qId]: optionKey }));

    const q = questions.find((x) => x.id === qId);
    if (q) {
      const correct = String(q.correctAnswer || "") === String(optionKey || "");
      // show immediate correct/wrong feedback only for non-competitive exams AND instant mode
      if (!isCompetitive && feedbackMode === "instant") {
        setSelectedFeedback(correct ? "correct" : "wrong");
        Vibration.vibrate(20);
        // keep feedback visible until user navigates to avoid flash->blue issue
      } else {
        // neutral selection only
      }
    }

    if (!studentId || !examId || !attemptId) return;
    const patch = {};
    patch[`attempts/company/${studentId}/${examId}/${attemptId}/answers/${qId}`] = optionKey;
    patch[`Platform1/attempts/company/${studentId}/${examId}/${attemptId}/answers/${qId}`] = optionKey;
    await update(ref(database), patch).catch(() => {});
  }, [stage, questions, studentId, examId, attemptId, isCompetitive, feedbackMode]);

  const prevQ = useCallback(() => {
    setSelectedFeedback(null);
    if (currentIndex > 0) setCurrentIndex((i) => i - 1);
  }, [currentIndex]);

  const nextQ = useCallback(() => {
    setSelectedFeedback(null);
    if (currentIndex < (order.length || questions.length) - 1) setCurrentIndex((i) => i + 1);
    else submitExam();
  }, [currentIndex, order.length, questions.length]);

  async function submitExam() {
    clearInterval(timerRef.current);

    const finalOrder = order.length ? order : questions.map((q) => q.id);
    const computed = scoreExam(questions, finalOrder, answers);
    const scored = getBadgeAndPoints(examMeta, computed.percent);

    const now = Date.now();
    const resultVisible = examMeta?.scoringEnabled ? now >= Number(roundMeta?.resultReleaseTimestamp || 0) : true;

    if (studentId && examId && attemptId) {
      const patch = {};
      patch[`attempts/company/${studentId}/${examId}/${attemptId}/endTime`] = now;
      patch[`attempts/company/${studentId}/${examId}/${attemptId}/attemptStatus`] = "completed";
      patch[`attempts/company/${studentId}/${examId}/${attemptId}/answers`] = answers;
      patch[`attempts/company/${studentId}/${examId}/${attemptId}/scorePercent`] = computed.percent;
      patch[`attempts/company/${studentId}/${examId}/${attemptId}/correctCount`] = computed.correct;
      patch[`attempts/company/${studentId}/${examId}/${attemptId}/pointsAwarded`] = scored.points;
      patch[`attempts/company/${studentId}/${examId}/${attemptId}/badge`] = scored.badge;
      patch[`attempts/company/${studentId}/${examId}/${attemptId}/resultVisible`] = resultVisible;

      patch[`Platform1/attempts/company/${studentId}/${examId}/${attemptId}/endTime`] = now;
      patch[`Platform1/attempts/company/${studentId}/${examId}/${attemptId}/attemptStatus`] = "completed";
      patch[`Platform1/attempts/company/${studentId}/${examId}/${attemptId}/answers`] = answers;
      patch[`Platform1/attempts/company/${studentId}/${examId}/${attemptId}/scorePercent`] = computed.percent;
      patch[`Platform1/attempts/company/${studentId}/${examId}/${attemptId}/correctCount`] = computed.correct;
      patch[`Platform1/attempts/company/${studentId}/${examId}/${attemptId}/pointsAwarded`] = scored.points;
      patch[`Platform1/attempts/company/${studentId}/${examId}/${attemptId}/badge`] = scored.badge;
      patch[`Platform1/attempts/company/${studentId}/${examId}/${attemptId}/resultVisible`] = resultVisible;

      patch[`studentProgress/${studentId}/company/${roundId}/${examId}/status`] = "completed";
      patch[`studentProgress/${studentId}/company/${roundId}/${examId}/attemptsUsed`] = attemptNo;
      patch[`studentProgress/${studentId}/company/${roundId}/${examId}/bestScorePercent`] = computed.percent;
      patch[`studentProgress/${studentId}/company/${roundId}/${examId}/lastAttemptId`] = attemptId;
      patch[`studentProgress/${studentId}/company/${roundId}/${examId}/lastSubmittedAt`] = now;

      patch[`Platform1/studentProgress/${studentId}/company/${roundId}/${examId}/status`] = "completed";
      patch[`Platform1/studentProgress/${studentId}/company/${roundId}/${examId}/attemptsUsed`] = attemptNo;
      patch[`Platform1/studentProgress/${studentId}/company/${roundId}/${examId}/bestScorePercent`] = computed.percent;
      patch[`Platform1/studentProgress/${studentId}/company/${roundId}/${examId}/lastAttemptId`] = attemptId;
      patch[`Platform1/studentProgress/${studentId}/company/${roundId}/${examId}/lastSubmittedAt`] = now;

      await update(ref(database), patch).catch(() => {});
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

    setStage("result");
  }

  const canStart = useMemo(() => {
    if (!examMeta) return { ok: false, reason: "Exam metadata unavailable." };
    if (examMeta?.scoringEnabled && (!questions || questions.length === 0)) {
      if (questionLoadError) return { ok: false, reason: questionLoadError };
      return { ok: false, reason: "Question bank not loaded yet. Try again in a moment." };
    }
    const maxAttempts = Number(examMeta?.maxAttempts || 1);
    if (attemptsUsed >= maxAttempts && !inProgressAttempt) return { ok: false, reason: "No attempts left for this exam." };

    if (isCompetitive && lastCompletedAttempt && roundMeta?.endTimestamp) {
      const now = Date.now();
      if (now < Number(roundMeta.endTimestamp)) {
        return { ok: false, reason: "You completed this competitive exam. Results will be available after the round ends." };
      }
    }

    if (roundMeta?.startTimestamp && roundMeta?.endTimestamp && !inWindow(roundMeta)) return { ok: false, reason: "This exam is outside the allowed time window." };
    return { ok: true, reason: "" };
  }, [examMeta, questions, questionLoadError, attemptsUsed, inProgressAttempt, isCompetitive, lastCompletedAttempt, roundMeta]);

  const safeAreaPaddingTop = Platform.OS === "android" ? (StatusBar.currentHeight || 0) : 0;

  if (loading) {
    return (
      <SafeAreaView style={[styles.loadingWrap, { paddingTop: safeAreaPaddingTop }]}>
        <StatusBar barStyle="dark-content" backgroundColor={C.bg} />
        <ActivityIndicator size="large" color={C.primary} />
      </SafeAreaView>
    );
  }

  // Review mode (unchanged)
  if (mode === "review") {
    const reviewOrder = normalizeQuestionOrder(reviewAttempt?.questionOrder || {});
    const reviewAnswers = reviewAttempt?.answers || {};
    const now = Date.now();
    const roundEndsAt = Number(roundMeta?.endTimestamp || 0);
    const reviewLocked = isCompetitive && roundEndsAt && now < roundEndsAt;

    return (
      <SafeAreaView style={[styles.safeRoot, { paddingTop: safeAreaPaddingTop }]}>
        <StatusBar barStyle="dark-content" backgroundColor={C.bg} />
        <View style={styles.headerBar}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}><Ionicons name="chevron-back" size={24} color={C.text} /></TouchableOpacity>
          <Text style={styles.headerTitle}>Review Attempt</Text>
          <View style={{ width: 24 }} />
        </View>

        <ScrollView contentContainerStyle={styles.body}>
          <Text style={styles.mainTitle}>{examMeta?.name || "Exam Review"}</Text>
          {reviewLocked ? (
            <Text style={styles.muted}>You submitted this competitive exam early. Review will unlock after round end.</Text>
          ) : null}
          {reviewOrder.length === 0 ? <Text style={styles.muted}>No attempt data found for review.</Text> : null}
          {reviewOrder.map((qid, idx) => {
            const item = questions.find((qq) => qq.id === qid);
            if (!item) return null;
            const selected = reviewAnswers[qid];
            const correct = item.correctAnswer;
            return (
              <View key={qid} style={styles.reviewCard}>
                <Text style={styles.reviewQ}>{idx + 1}. {item.question}</Text>
                {Object.keys(item.options || {}).map((optKey) => {
                  const isSel = selected === optKey;
                  const isRight = correct === optKey;
                  return (
                    <View key={optKey} style={[styles.reviewOpt, isRight ? styles.reviewRight : null, isSel && !isRight ? styles.reviewWrong : null]}>
                      <Text style={styles.reviewOptText}>
                        {optKey}. {item.options[optKey]} {isSel ? "• your answer" : ""} {isRight ? "• correct" : ""}
                      </Text>
                    </View>
                  );
                })}
                {!!item.explanation && <Text style={styles.explain}>Explanation: {item.explanation}</Text>}
              </View>
            );
          })}
        </ScrollView>
      </SafeAreaView>
    );
  }

  // interactive flow
  const qId = order[currentIndex];
  const q = questions.find((x) => x.id === qId);

  return (
    <SafeAreaView style={[styles.safeRoot, { paddingTop: safeAreaPaddingTop }]}>
      <StatusBar barStyle="dark-content" backgroundColor={C.bg} />

      {/* Feedback info modal — centered explanatory content */}
      <Modal visible={showFeedbackInfoModal} animationType="slide" transparent onRequestClose={() => setShowFeedbackInfoModal(false)}>
        <View style={modalStyles.overlay}>
          <View style={modalStyles.card}>
            <Text style={modalStyles.title}>Feedback modes</Text>

            <Text style={modalStyles.modeTitle}>Instant</Text>
            <Text style={modalStyles.modeText}>
              After you answer each question you'll immediately see whether your choice was correct or incorrect, plus a short explanation.
              This mode is best when learning and practicing.
            </Text>

            <Text style={modalStyles.modeTitle}>End of exam</Text>
            <Text style={modalStyles.modeText}>
              Answers are recorded silently during the attempt. You will only see correctness and explanations after you submit and review.
              This mode is best for exam-like conditions.
            </Text>

            <TouchableOpacity style={modalStyles.closeBtn} onPress={() => setShowFeedbackInfoModal(false)}>
              <Text style={modalStyles.closeBtnText}>Got it</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <View style={styles.root}>
        {stage !== "result" && (
          <Animated.View style={[styles.panel, { transform: [{ translateX: slide.interpolate({ inputRange: [0, 1], outputRange: [0, -SLIDE_DISTANCE] }) }] }]}>
            <View style={styles.headerBar}>
              <TouchableOpacity onPress={() => router.back()}><Ionicons name="chevron-back" size={24} color={C.text} /></TouchableOpacity>
              <Text style={styles.headerTitle}>{examMeta?.subject ? `${capitalize(examMeta.subject)} Test` : "Exam Rules"}</Text>
              <View style={{ width: 24 }} />
            </View>

            {/* Centered rules content: flexGrow + justifyContent center */}
            <ScrollView contentContainerStyle={[styles.body, styles.centeredBody]}>
              <Text style={styles.mainTitle}>{examMeta?.name || "Practice Test"}</Text>

              <View style={styles.infoCard}>
                <Text style={styles.stat}>📝 {examMeta?.totalQuestions || questions.length} questions</Text>
                <Text style={styles.stat}>⏱ {formatTime(examMeta?.timeLimit || 0)}</Text>
                <Text style={styles.stat}>🎟 Attempt {Math.min(attemptNo, Number(examMeta?.maxAttempts || 1))}/{Number(examMeta?.maxAttempts || 1)}</Text>
              </View>

              {/* Feedback toggle row with info */}
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
                    <Ionicons name="information-circle-outline" size={20} color={C.muted} />
                  </TouchableOpacity>
                </View>
              )}

              <Text style={styles.blockTitle}>Before you start</Text>
              {(examMeta?.rules
                ? Object.keys(examMeta.rules).map((k) => examMeta.rules[k]).filter(Boolean)
                : ["No exiting exam", "One attempt only", "Auto submit at end time"]
              ).map((rule, idx) => (
                <Text key={idx} style={styles.ruleText}>• {rule}</Text>
              ))}

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
          </Animated.View>
        )}

        {stage !== "result" && (
          <Animated.View style={[styles.panel, { transform: [{ translateX: slide.interpolate({ inputRange: [0, 1], outputRange: [SLIDE_DISTANCE, 0] }) }] }]}>
            <View style={styles.headerBar}>
              <TouchableOpacity onPress={() => router.back()}><Ionicons name="chevron-back" size={24} color={C.text} /></TouchableOpacity>
              <Text style={styles.headerTitle}>{examMeta?.subject ? capitalize(examMeta.subject) : "Exam"}</Text>
              <View style={{ width: 24 }} />
            </View>

            <View style={styles.examBody}>
              <View style={styles.topRow}>
                <Text style={styles.counter}>{currentIndex + 1} / {order.length || questions.length}</Text>
                <View style={styles.timerPill}>
                  <Ionicons name="time-outline" size={14} color={C.primary} />
                  <Text style={styles.timer}>{formatTime(timeLeft)}</Text>
                </View>
              </View>

              <View style={styles.progressTrack}>
                <Animated.View
                  style={[styles.progressFill, { width: progressAnim.interpolate({ inputRange: [0, 100], outputRange: ["0%", "100%"] }) }]}
                />
              </View>

              <ScrollView style={{ marginTop: 14 }}>
                <View style={styles.qCard}>
                  <Text style={styles.qText}>{q?.question || "No question available."}</Text>

                  <View style={{ marginTop: 14 }}>
                    {q && Object.keys(q.options || {}).map((optKey, idx) => {
                      const selected = answers[q.id] === optKey;
                      const flashStyle =
                        selectedFeedback === "correct" && selected
                          ? styles.correctFlash
                          : selectedFeedback === "wrong" && selected
                          ? styles.wrongFlash
                          : null;

                      // For competitive exams we intentionally DO NOT apply correct/wrong flash
                      const appliedFlash = isCompetitive ? null : flashStyle;

                      return (
                        <TouchableOpacity
                          key={optKey}
                          style={[styles.option, selected ? styles.optionSelected : styles.optionDefault, appliedFlash]}
                          onPress={() => setAnswer(q.id, optKey)}
                          activeOpacity={0.9}
                        >
                          <View style={[styles.optBadge, selected ? styles.optBadgeSel : styles.optBadgeDef]}>
                            {selected ? <Ionicons name="checkmark" size={14} color="#fff" /> : <Text style={styles.optLetter}>{String.fromCharCode(65 + idx)}</Text>}
                          </View>
                          <Text style={[styles.optText, selected ? styles.optTextSel : null]}>{q.options[optKey]}</Text>
                        </TouchableOpacity>
                      );
                    })}

                    {/* Explanation display for Instant mode (practice only) */}
                    {!isCompetitive && feedbackMode === "instant" && selectedFeedback && q && answers[q.id] && (
                      <View style={{ marginTop: 12 }}>
                        <Text style={{ fontWeight: "800", color: selectedFeedback === "correct" ? C.success : C.danger }}>
                          {selectedFeedback === "correct" ? "Correct" : "Incorrect"}
                        </Text>
                        {!!q.explanation && <Text style={{ marginTop: 8, color: C.muted }}>{q.explanation}</Text>}
                      </View>
                    )}
                  </View>
                </View>
              </ScrollView>

              <View style={styles.footer}>
                <TouchableOpacity style={styles.ghostBtn} disabled={currentIndex === 0} onPress={prevQ}>
                  <Text style={[styles.ghostTxt, currentIndex === 0 ? { opacity: 0.4 } : null]}>Previous</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.primaryBtnSmall} onPress={nextQ}>
                  <Text style={styles.primaryBtnText}>{currentIndex === (order.length || questions.length) - 1 ? "Submit" : "Next"}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </Animated.View>
        )}

        {stage === "result" && (
          <View style={styles.resultScreen}>
            <View style={styles.headerBar}>
              <TouchableOpacity onPress={() => router.push("/dashboard")}><Ionicons name="chevron-back" size={24} color={C.text} /></TouchableOpacity>
              <Text style={styles.headerTitle}>Result</Text>
              <View style={{ width: 24 }} />
            </View>

            <View style={styles.resultCenter}>
              <View style={styles.resultCard}>
                {result?.resultVisible ? (
                  <>
                    <Text style={styles.celebrate}>🎉</Text>
                    <Text style={styles.resultPct}>{Math.round(result?.percent || 0)}%</Text>
                    <Text style={styles.resultSub}>{result?.correct || 0} / {result?.total || 0} correct</Text>
                    <Text style={styles.resultBadgeText}>{result?.badge ? `${String(result.badge).toUpperCase()} • ${result.points} point(s)` : "No badge"}</Text>
                  </>
                ) : (
                  <>
                    <Text style={[styles.resultPct, { fontSize: 34 }]}>Submitted</Text>
                    <Text style={styles.resultSub}>
                      {isCompetitive && roundMeta?.endTimestamp && Date.now() < Number(roundMeta.endTimestamp)
                        ? "You submitted this competitive exam. Results will be visible after the round ends."
                        : "Your result will be visible after release time."}
                    </Text>
                  </>
                )}
                <TouchableOpacity style={[styles.primaryBtnSmall, { marginTop: 18 }]} onPress={() => router.push("/dashboard")}>
                  <Text style={styles.primaryBtnText}>Back to Home</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeRoot: { flex: 1, backgroundColor: C.bg },
  loadingWrap: { flex: 1, backgroundColor: C.bg, justifyContent: "center", alignItems: "center" },

  root: { flex: 1, backgroundColor: C.bg },
  panel: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, backgroundColor: C.bg },

  headerBar: {
    minHeight: 62,
    paddingHorizontal: 16,
    paddingTop: Platform.OS === "android" ? (StatusBar.currentHeight || 0) : 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: C.bg,
  },
  headerTitle: { color: C.text, fontSize: 17, fontWeight: "900" },

  body: { paddingHorizontal: 16, paddingBottom: 24 },
  centeredBody: { flexGrow: 1, justifyContent: "center" }, // centers rules content vertically
  mainTitle: { fontSize: 24, fontWeight: "900", color: C.text, marginTop: 8, marginBottom: 10 },
  muted: { color: C.muted },

  infoCard: {
    backgroundColor: "#F7FAFF",
    borderWidth: 1,
    borderColor: "#EAF0FF",
    borderRadius: 14,
    padding: 12,
    marginBottom: 12,
  },
  stat: { color: C.muted, fontWeight: "700", marginBottom: 6 },

  feedbackRow: { flexDirection: "row", alignItems: "center", marginBottom: 10 },

  blockTitle: { fontSize: 16, fontWeight: "900", color: C.text, marginTop: 8 },
  ruleText: { color: "#374151", marginTop: 8, lineHeight: 20 },
  warning: { marginTop: 12, color: "#B54708", fontWeight: "700" },

  primaryBtn: { marginTop: 18, backgroundColor: C.primary, borderRadius: 12, alignItems: "center", paddingVertical: 14 },
  primaryBtnSmall: { backgroundColor: C.primary, borderRadius: 12, alignItems: "center", paddingVertical: 12, paddingHorizontal: 24 },
  primaryBtnText: { color: "#fff", fontWeight: "900" },

  examBody: { flex: 1, paddingHorizontal: 16, paddingBottom: 12 },
  topRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  counter: { color: C.muted, fontWeight: "800" },
  timerPill: { flexDirection: "row", alignItems: "center", backgroundColor: "#EEF4FF", borderRadius: 12, paddingHorizontal: 10, paddingVertical: 6 },
  timer: { marginLeft: 6, color: C.primary, fontWeight: "800" },

  progressTrack: { marginTop: 10, height: 8, borderRadius: 999, backgroundColor: "#EAF0FF", overflow: "hidden" },
  progressFill: { height: 8, backgroundColor: C.primary },

  qCard: { backgroundColor: "#fff", borderRadius: 14, borderWidth: 1, borderColor: C.border, padding: 12 },
  qText: { fontSize: 18, fontWeight: "900", color: C.text },

  option: { marginTop: 10, borderRadius: 12, padding: 12, flexDirection: "row", alignItems: "center" },
  optionDefault: { backgroundColor: "#FAFBFF", borderWidth: 1, borderColor: "#EAF0FF" },
  optionSelected: { backgroundColor: C.primary },
  correctFlash: { backgroundColor: C.success },
  wrongFlash: { backgroundColor: C.danger },

  optBadge: { width: 34, height: 34, borderRadius: 17, marginRight: 10, alignItems: "center", justifyContent: "center" },
  optBadgeDef: { borderWidth: 1, borderColor: C.muted },
  optBadgeSel: { backgroundColor: "#fff" },
  optLetter: { color: C.muted, fontWeight: "800" },

  optText: { flex: 1, color: "#111827", fontSize: 14 },
  optTextSel: { color: "#fff", fontWeight: "800" },

  footer: { marginTop: 14, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
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
  celebrate: { fontSize: 28 },
  resultPct: { fontSize: 56, color: C.primary, fontWeight: "900", marginTop: 4 },
  resultSub: { marginTop: 8, color: C.muted, textAlign: "center", fontWeight: "700" },
  resultBadgeText: { marginTop: 8, color: C.text, fontWeight: "800" },

  reviewCard: {
    marginTop: 12,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 12,
    backgroundColor: "#fff",
    padding: 12,
  },
  reviewQ: { color: C.text, fontWeight: "900", fontSize: 15 },
  reviewOpt: {
    marginTop: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#EEF4FF",
    backgroundColor: "#F8FAFF",
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  reviewRight: { backgroundColor: "#ECFDF3", borderColor: "#ABEFC6" },
  reviewWrong: { backgroundColor: "#FEF3F2", borderColor: "#FECACA" },
  reviewOptText: { color: "#344054", fontSize: 13 },
  explain: { marginTop: 8, color: "#475467", fontStyle: "italic" },

  // header & toggles
  backBtn: { width: 40, height: 40, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: "#F7F9FF" },
  headerBarCompact: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },

  // toggle styles
  toggleBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
    marginRight: 8,
    borderWidth: 1,
    borderColor: "#EAF0FF",
  },
  toggleOn: { backgroundColor: C.primary, borderColor: C.primary },
  toggleOff: { backgroundColor: "#fff", borderColor: "#EAF0FF" },
  toggleTextOn: { color: "#fff", fontWeight: "800" },
  toggleTextOff: { color: C.text, fontWeight: "800" },
});

const modalStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  card: {
    width: "100%",
    maxWidth: 680,
    backgroundColor: "#fff",
    borderRadius: 14,
    padding: 18,
  },
  title: { fontSize: 20, fontWeight: "900", marginBottom: 12, color: C.text },
  modeTitle: { marginTop: 10, fontWeight: "800", color: C.text },
  modeText: { marginTop: 6, color: C.muted, lineHeight: 20 },
  closeBtn: {
    marginTop: 18,
    backgroundColor: C.primary,
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: "center",
  },
  closeBtnText: { color: "#fff", fontWeight: "900" },
});