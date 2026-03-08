import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  LayoutAnimation,
  UIManager,
  Platform,
  StatusBar,
  Modal,
  Animated,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { ref, get } from "firebase/database";
import { database } from "../constants/firebaseConfig";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";

if (Platform.OS === "android" && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const PRIMARY = "#0B72FF";
const BG = "#FFFFFF";
const TEXT = "#0B2540";
const MUTED = "#6B78A8";
const HEART_REFILL_MS = 20 * 60 * 1000; // fallback 20 minutes
const DEFAULT_GLOBAL_MAX_LIVES = 5;
const HEART_COLOR = "#EF4444";

async function tryGet(paths) {
  for (const p of paths) {
    try {
      const snap = await get(ref(database, p));
      if (snap) return snap;
    } catch {}
  }
  return null;
}

function normalizeGrade(g) {
  if (!g) return null;
  return String(g).trim().toLowerCase().replace(/^grade/i, "");
}
function titleize(s) {
  return String(s || "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
function formatTimeLeft(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(sec / 60).toString().padStart(2, "0");
  const ss = Math.floor(sec % 60).toString().padStart(2, "0");
  return `${mm}:${ss}`;
}
function formatMsToMMSS(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const mm = Math.floor(s / 60).toString().padStart(2, "0");
  const ss = Math.floor(s % 60).toString().padStart(2, "0");
  return `${mm}:${ss}`;
}

export default function PackageSubjects() {
  const router = useRouter();
  const params = useLocalSearchParams();

  const packageId = params.packageId;
  const packageName = params.packageName || "Package";
  const incomingGrade = params.studentGrade;

  const [loading, setLoading] = useState(true);
  const [subjects, setSubjects] = useState([]);
  const [expandedId, setExpandedId] = useState(null);
  const [packageType, setPackageType] = useState(null); // 'competitive' | 'practice' | etc

  // global lives
  const [globalLives, setGlobalLives] = useState(null);
  const [globalMaxLives, setGlobalMaxLives] = useState(DEFAULT_GLOBAL_MAX_LIVES);
  const [globalRefillMs, setGlobalRefillMs] = useState(HEART_REFILL_MS);
  const [globalLastConsumedAt, setGlobalLastConsumedAt] = useState(null);

  // heart info modal
  const [showHeartInfoModal, setShowHeartInfoModal] = useState(false);
  const heartModalAnim = useRef(new Animated.Value(0)).current;
  const [nextHeartInMs, setNextHeartInMs] = useState(0);

  // ticking clock for UI timers (does NOT trigger reload)
  const [nowTs, setNowTs] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowTs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // load package & related exam metadata once when packageId or incomingGrade changes
  const load = useCallback(async () => {
    setLoading(true);

    const sid =
      (await AsyncStorage.getItem("studentNodeKey")) ||
      (await AsyncStorage.getItem("studentId")) ||
      (await AsyncStorage.getItem("username")) ||
      null;

    const gradeStored = normalizeGrade(await AsyncStorage.getItem("studentGrade"));
    const grade = normalizeGrade(incomingGrade) || gradeStored;

    // 1) read package from DB (your path)
    const pkgSnap = await tryGet([
      `Platform1/companyExams/packages/${packageId}`,
      `companyExams/packages/${packageId}`,
    ]);

    if (!pkgSnap || !pkgSnap.exists()) {
      setSubjects([]);
      setPackageType(null);
      setLoading(false);
      return;
    }
    const pkg = pkgSnap.val() || {};
    setPackageType(pkg.type || null);

    // load global lives state (best-effort)
    if (sid) {
      const livesNode = await tryGet([`Platform1/studentLives/${sid}`, `studentLives/${sid}`]);
      if (livesNode) {
        // livesNode may be snapshot or value object depending on tryGet result
        const raw = typeof livesNode.val === "function" ? livesNode.val() : livesNode;
        const lives = Number(raw?.currentLives ?? raw?.lives ?? null);
        const max = Number(raw?.maxLives ?? DEFAULT_GLOBAL_MAX_LIVES);
        let refillRaw = raw?.refillIntervalMs ?? raw?.refillInterval ?? null;
        let refillMs = HEART_REFILL_MS;
        if (refillRaw != null) {
          const num = Number(refillRaw);
          if (!Number.isFinite(num)) refillMs = HEART_REFILL_MS;
          else refillMs = num > 1000 ? num : num * 1000;
        }
        const last = Number(raw?.lastConsumedAt ?? raw?.lastConsumed ?? 0) || null;
        setGlobalLives(Number.isFinite(lives) ? lives : null);
        setGlobalMaxLives(Number.isFinite(max) ? max : DEFAULT_GLOBAL_MAX_LIVES);
        setGlobalRefillMs(refillMs);
        setGlobalLastConsumedAt(last);
      } else {
        setGlobalLives(null);
        setGlobalMaxLives(DEFAULT_GLOBAL_MAX_LIVES);
        setGlobalRefillMs(HEART_REFILL_MS);
        setGlobalLastConsumedAt(null);
      }
    } else {
      setGlobalLives(null);
      setGlobalMaxLives(DEFAULT_GLOBAL_MAX_LIVES);
      setGlobalRefillMs(HEART_REFILL_MS);
      setGlobalLastConsumedAt(null);
    }

    // if package has grade and it doesn't match student's grade, show empty
    if (grade && pkg.grade && normalizeGrade(pkg.grade) && normalizeGrade(pkg.grade) !== String(grade)) {
      setSubjects([]);
      setLoading(false);
      return;
    }

    // 2) load the global exams node so we can enrich exam metadata (timeLimit, totalQuestions, maxAttempts)
    const examsSnap = await tryGet([`Platform1/companyExams/exams`, `companyExams/exams`]);
    const examMap = examsSnap?.exists() ? examsSnap.val() || {} : {};

    // Build subjects array; store raw progress fields so timers can be computed client-side
    const subjectsNode = pkg.subjects || {};
    const out = [];

    for (const subjectKey of Object.keys(subjectsNode)) {
      const subject = subjectsNode[subjectKey] || {};
      const roundsNode = subject.rounds || {};

      const roundsArr = [];
      for (const rid of Object.keys(roundsNode)) {
        const r = roundsNode[rid] || {};
        const examId = r.examId;
        const examMeta = examMap?.[examId] || {};

        // fetch progress for this student (if sid present) - keep raw values
        let progressRaw = null;
        if (sid && rid && examId) {
          const pSnap = await tryGet([
            `Platform1/studentProgress/${sid}/company/${rid}/${examId}`,
            `studentProgress/${sid}/company/${rid}/${examId}`,
          ]);
          if (pSnap && pSnap.exists) progressRaw = typeof pSnap.val === "function" ? pSnap.val() : pSnap;
          else if (pSnap) progressRaw = pSnap;
        }

        const maxAttempts = Number(examMeta.maxAttempts || 1);
        const attemptsUsedRaw = Number(progressRaw?.attemptsUsed || 0);
        const lastAttemptTsRaw = Number(progressRaw?.lastAttemptTimestamp || progressRaw?.lastSubmittedAt || 0);

        // store raw values (do NOT compute remainingHearts here)
        roundsArr.push({
          id: rid,
          roundId: rid,
          examId,
          questionBankId: examMeta.questionBankId || "",
          name: r.name || rid,
          chapter: r.chapter || "",
          totalQuestions: Number(examMeta.totalQuestions || 0),
          timeLimit: Number(examMeta.timeLimit || 0),
          difficulty: examMeta.difficulty || "medium",
          maxAttempts,
          attemptsUsedRaw,
          lastAttemptTsRaw,
          status: r.status || "upcoming",
        });
      }

      out.push({
        id: subjectKey,
        name: subject.name || subjectKey,
        chapter: subject.chapter || "Subject rounds",
        rounds: roundsArr,
      });
    }

    setSubjects(out);
    setLoading(false);
  }, [packageId, incomingGrade]);

  useEffect(() => {
    load();
  }, [load]);

  const toggle = (id) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpandedId((prev) => (prev === id ? null : id));
  };

  // derive hearts & next-heart countdown for a round (pure function)
  function deriveHearts(round, now = Date.now(), refillMs = HEART_REFILL_MS) {
    const maxAttempts = Number(round.maxAttempts || 1);
    const used = Number(round.attemptsUsedRaw || 0);
    const lastTs = Number(round.lastAttemptTsRaw || 0);

    // Competitive package: NO refill
    if (packageType === "competitive") {
      const remainingHearts = Math.max(0, maxAttempts - used);
      return { remainingHearts, nextHeartInMs: 0, competitive: true };
    }

    if (!lastTs || used <= 0) {
      return { remainingHearts: Math.max(0, maxAttempts - used), nextHeartInMs: 0, competitive: false };
    }

    const recovered = Math.floor((now - lastTs) / refillMs);
    const effectiveUsed = Math.max(0, used - recovered);
    const remainingHearts = Math.max(0, maxAttempts - effectiveUsed);

    let nextHeartInMs = 0;
    if (remainingHearts < maxAttempts) {
      const elapsedSinceLast = now - lastTs;
      nextHeartInMs = refillMs - (elapsedSinceLast % refillMs);
    }

    return { remainingHearts, nextHeartInMs, competitive: false };
  }

  // heart modal animation & countdown
  useEffect(() => {
    if (showHeartInfoModal) {
      Animated.spring(heartModalAnim, { toValue: 1, useNativeDriver: true }).start();
    } else {
      Animated.timing(heartModalAnim, { toValue: 0, duration: 160, useNativeDriver: true }).start();
    }
  }, [showHeartInfoModal]);

  useEffect(() => {
    let timer;
    function recompute() {
      if (!globalLastConsumedAt || !globalRefillMs) {
        setNextHeartInMs(globalRefillMs || HEART_REFILL_MS);
        return;
      }
      const now = Date.now();
      const elapsed = now - Number(globalLastConsumedAt || 0);
      if (elapsed < 0) {
        setNextHeartInMs(globalRefillMs);
        return;
      }
      const remainder = elapsed % globalRefillMs;
      const next = Math.max(0, globalRefillMs - remainder);
      setNextHeartInMs(next);
    }
    recompute();
    if (showHeartInfoModal) timer = setInterval(recompute, 1000);
    return () => clearInterval(timer);
  }, [globalLastConsumedAt, globalRefillMs, showHeartInfoModal]);

  if (loading) {
    return (
      <SafeAreaView
        style={[
          styles.screen,
          styles.center,
          { paddingTop: Platform.OS === "android" ? (StatusBar.currentHeight || 0) : 0 },
        ]}
      >
        <ActivityIndicator color={PRIMARY} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView
      style={[styles.screen, { paddingTop: Platform.OS === "android" ? (StatusBar.currentHeight || 0) : 0 }]}
    >
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color={TEXT} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{packageName}</Text>
          <Text style={styles.subtitle}>Choose a subject and start a round</Text>
        </View>

        {/* Global lives preview: single linear heart + number (tappable) */}
        <TouchableOpacity onPress={() => setShowHeartInfoModal(true)} style={{ alignItems: "flex-end", minWidth: 60 }}>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <Ionicons
              name={globalLives != null && globalLives > 0 ? "heart" : "heart-outline"}
              size={20}
              color={globalLives != null && globalLives > 0 ? HEART_COLOR : MUTED}
            />
            <Text style={{ marginLeft: 6, color: PRIMARY, fontWeight: "900" }}>
              {globalLives != null ? `${globalLives}` : `—`}
            </Text>
          </View>
        </TouchableOpacity>
      </View>

      <FlatList
        data={subjects}
        keyExtractor={(s) => s.id}
        contentContainerStyle={{ padding: 16, paddingBottom: 24 }}
        ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
        renderItem={({ item }) => {
          const expanded = expandedId === item.id;

          // compute maximum hearts across rounds for hearts preview
          const livesMax = Math.max(1, ...(item.rounds || []).map((r) => Number(r.maxAttempts || 1)));
          // compute current hearts for each round, but for preview we take the max remaining across rounds
          const remainingArray = (item.rounds || []).map((r) => deriveHearts(r, nowTs, globalRefillMs).remainingHearts);
          const livesNow = remainingArray.length ? Math.max(...remainingArray) : livesMax;

          return (
            <View style={styles.subjectCard}>
              <TouchableOpacity style={styles.subjectTop} activeOpacity={0.9} onPress={() => toggle(item.id)}>
                <View style={styles.subjectIconWrap}>
                  <MaterialCommunityIcons name="book-education-outline" size={22} color={PRIMARY} />
                </View>

                <View style={{ flex: 1, marginLeft: 10 }}>
                  <Text style={styles.subjectName}>{titleize(item.name)}</Text>
                  <Text style={styles.subjectChapter}>{item.chapter}</Text>
                  <Text style={styles.roundCount}>{(item.rounds || []).length} rounds</Text>

                  <View style={styles.heartsRow}>
                    <Ionicons name={livesNow > 0 ? "heart" : "heart-outline"} size={16} color={livesNow > 0 ? HEART_COLOR : MUTED} />
                    <Text style={{ marginLeft: 6, fontWeight: "800", color: PRIMARY }}>{livesNow}</Text>
                  </View>
                </View>

                <Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={20} color={MUTED} />
              </TouchableOpacity>

              {expanded && (
                <View style={styles.expandArea}>
                  {(item.rounds || []).map((r) => {
                    const { remainingHearts, nextHeartInMs, competitive } = deriveHearts(r, nowTs, globalRefillMs);
                    const disabled = remainingHearts <= 0;
                    return (
                      <View key={`${r.roundId}_${r.examId}`} style={{ marginBottom: 10 }}>
                        <View style={styles.roundRow}>
                          <View style={{ flex: 1 }}>
                            <Text style={styles.roundName}>{r.name}</Text>
                            <Text style={styles.roundMeta}>
                              {r.totalQuestions || 0} Qs • {Math.round((r.timeLimit || 0) / 60)} min • {r.difficulty}
                            </Text>
                          </View>

                          <TouchableOpacity
                            disabled={disabled}
                            style={[styles.startBtn, disabled ? styles.startBtnDisabled : null]}
                            onPress={() =>
                              router.push({
                                pathname: "/examCenter",
                                params: {
                                  roundId: r.roundId,
                                  examId: r.examId,
                                  questionBankId: r.questionBankId,
                                  mode: "start",
                                },
                              })
                            }
                          >
                            <Text style={styles.startBtnText}>{disabled ? "Locked" : "Start"}</Text>
                          </TouchableOpacity>
                        </View>

                        {disabled ? (
                          <View style={{ marginTop: 4, marginLeft: 2 }}>
                            {competitive ? (
                              <Text style={styles.noHeartText}>No attempts left — this is a competitive round (no refills)</Text>
                            ) : (
                              <Text style={styles.noHeartText}>No hearts left — refilling soon</Text>
                            )}

                            {!competitive && nextHeartInMs > 0 ? (
                              <Text style={styles.refillText}>Next heart in {formatTimeLeft(nextHeartInMs)}</Text>
                            ) : null}
                          </View>
                        ) : null}
                      </View>
                    );
                  })}
                </View>
              )}
            </View>
          );
        }}
      />

      {/* Heart Info Modal */}
      <Modal visible={showHeartInfoModal} transparent animationType="none" onRequestClose={() => setShowHeartInfoModal(false)}>
        <View style={modalStyles.overlay}>
          <Animated.View style={[modalStyles.card, { transform: [{ scale: heartModalAnim.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }) }], opacity: heartModalAnim }]}>
            <Text style={modalStyles.title}>Lives & refill</Text>
            <Text style={modalStyles.text}>Hearts are global. If you fail the exam (or use hearts), they are deducted and refill automatically over time.</Text>
            <View style={{ marginTop: 12, alignItems: "center" }}>
              <Ionicons name={globalLives != null && globalLives > 0 ? "heart" : "heart-outline"} size={32} color={globalLives != null && globalLives > 0 ? HEART_COLOR : MUTED} />
              <Text style={{ fontWeight: "900", marginTop: 8, fontSize: 18 }}>{globalLives != null ? `${globalLives} / ${globalMaxLives}` : `— / ${globalMaxLives}`}</Text>
              <Text style={{ marginTop: 8, color: MUTED }}>Next life in: {formatMsToMMSS(nextHeartInMs)}</Text>
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
  screen: { flex: 1, backgroundColor: BG },
  center: { alignItems: "center", justifyContent: "center" },

  header: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 8,
    flexDirection: "row",
    alignItems: "center",
  },
  backBtn: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 10,
    backgroundColor: "#F7F9FF",
  },
  title: { fontSize: 21, fontWeight: "900", color: TEXT },
  subtitle: { marginTop: 2, color: MUTED, fontSize: 12 },

  subjectCard: {
    backgroundColor: "#fff",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#EAF0FF",
    padding: 12,
    shadowColor: "#000",
    shadowOpacity: 0.04,
    shadowRadius: 8,
    elevation: 2,
  },
  subjectTop: { flexDirection: "row", alignItems: "center" },
  subjectIconWrap: {
    width: 42,
    height: 42,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#EEF4FF",
  },
  subjectName: { color: TEXT, fontWeight: "900", fontSize: 15 },
  subjectChapter: { marginTop: 2, color: MUTED, fontSize: 12 },
  roundCount: { marginTop: 4, color: PRIMARY, fontWeight: "700", fontSize: 12 },

  heartsRow: { marginTop: 6, flexDirection: "row", alignItems: "center" },

  expandArea: {
    marginTop: 10,
    borderTopWidth: 1,
    borderTopColor: "#EEF4FF",
    paddingTop: 10,
  },

  roundRow: {
    backgroundColor: "#FBFCFF",
    borderWidth: 1,
    borderColor: "#EEF4FF",
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
  },
  roundName: { color: TEXT, fontWeight: "800", fontSize: 14 },
  roundMeta: { marginTop: 3, color: MUTED, fontSize: 12 },

  startBtn: {
    backgroundColor: PRIMARY,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
  },
  startBtnDisabled: { backgroundColor: "#DDE8FF" },
  startBtnText: { color: "#fff", fontWeight: "800", fontSize: 12 },

  noHeartText: { color: "#B54708", fontWeight: "700", fontSize: 12 },
  refillText: { marginTop: 2, color: MUTED, fontSize: 12, fontWeight: "700" },
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
    maxWidth: 420,
    backgroundColor: "#fff",
    borderRadius: 14,
    padding: 18,
    alignItems: "center",
  },
  title: { fontSize: 20, fontWeight: "900", marginBottom: 8, color: TEXT },
  text: { color: MUTED, textAlign: "center" },
  closeBtnPrimary: { marginTop: 18, backgroundColor: PRIMARY, paddingVertical: 10, borderRadius: 10, alignItems: "center", width: "100%" },
  closeBtnTextPrimary: { color: "#fff", fontWeight: "900" },
});