import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
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
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { getValue, safeUpdate } from "./lib/dbHelpers";

if (Platform.OS === "android" && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const PRIMARY = "#0B72FF";
const BG = "#FFFFFF";
const TEXT = "#0B2540";
const MUTED = "#6B78A8";
const HEART_REFILL_MS = 20 * 60 * 1000;
const DEFAULT_GLOBAL_MAX_LIVES = 5;
const HEART_COLOR = "#EF4444";

function normalizeGrade(g) {
  if (!g) return null;
  return String(g).trim().toLowerCase().replace(/^grade/i, "");
}
function titleize(s) {
  return String(s || "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
function formatMsToMMSS(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const mm = Math.floor(s / 60).toString().padStart(2, "0");
  const ss = Math.floor(s % 60).toString().padStart(2, "0");
  return `${mm}:${ss}`;
}
function toMsTs(v) {
  const n = Number(v || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e12 ? n * 1000 : n;
}
function getSubjectVisual(subjectKey, subjectName) {
  const k = `${subjectKey || ""} ${subjectName || ""}`.toLowerCase();
  if (k.includes("math")) return { icon: "calculator-variant-outline", bg: "#EEF4FF", color: "#0B72FF" };
  if (k.includes("physics")) return { icon: "atom-variant", bg: "#EFFCF6", color: "#10B981" };
  if (k.includes("chem")) return { icon: "flask-outline", bg: "#FFF7ED", color: "#F97316" };
  if (k.includes("bio")) return { icon: "dna", bg: "#F5F3FF", color: "#8B5CF6" };
  if (k.includes("science")) return { icon: "beaker-outline", bg: "#ECFEFF", color: "#0891B2" };
  if (k.includes("english")) return { icon: "alphabetical", bg: "#FEF2F2", color: "#EF4444" };
  if (k.includes("history")) return { icon: "book-open-page-variant-outline", bg: "#FFF7ED", color: "#EA580C" };
  if (k.includes("geography")) return { icon: "earth", bg: "#ECFDF5", color: "#16A34A" };
  return { icon: "book-education-outline", bg: "#EEF4FF", color: PRIMARY };
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

export default function PackageSubjects() {
  const router = useRouter();
  const params = useLocalSearchParams();

  const packageId = params.packageId;
  const packageName = params.packageName || "Package";
  const incomingGrade = params.studentGrade;

  const [loading, setLoading] = useState(true);
  const [subjects, setSubjects] = useState([]);
  const [expandedId, setExpandedId] = useState(null);
  const [packageType, setPackageType] = useState(null);

  const [globalLives, setGlobalLives] = useState(null);
  const [globalMaxLives, setGlobalMaxLives] = useState(DEFAULT_GLOBAL_MAX_LIVES);
  const [globalRefillMs, setGlobalRefillMs] = useState(HEART_REFILL_MS);
  const [globalLastConsumedAt, setGlobalLastConsumedAt] = useState(null);

  const [showHeartInfoModal, setShowHeartInfoModal] = useState(false);
  const heartModalAnim = useRef(new Animated.Value(0)).current;
  const [nextHeartInMs, setNextHeartInMs] = useState(0);

  const [appExamConfig, setAppExamConfig] = useState({
    lives: {
      defaultMaxLives: DEFAULT_GLOBAL_MAX_LIVES,
      defaultRefillIntervalMs: HEART_REFILL_MS,
    },
    attempts: {
      practiceRefillEnabled: true,
      defaultRefillIntervalMs: 20 * 60 * 1000,
      maxCarryRefills: 999,
    },
  });

  const [nowTs, setNowTs] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowTs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);

    const cfg = await getValue([`Platform1/appConfig/exams`, `appConfig/exams`]);
    if (cfg) {
      setAppExamConfig((prev) => ({
        ...prev,
        ...cfg,
        lives: { ...prev.lives, ...(cfg.lives || {}) },
        attempts: { ...prev.attempts, ...(cfg.attempts || {}) },
      }));
    }

    const sid =
      (await AsyncStorage.getItem("studentNodeKey")) ||
      (await AsyncStorage.getItem("studentId")) ||
      (await AsyncStorage.getItem("username")) ||
      null;

    const gradeStored = normalizeGrade(await AsyncStorage.getItem("studentGrade"));
    const grade = normalizeGrade(incomingGrade) || gradeStored;

    const pkg = await getValue([
      `Platform1/companyExams/packages/${packageId}`,
      `companyExams/packages/${packageId}`,
    ]);

    if (!pkg) {
      setSubjects([]);
      setPackageType(null);
      setLoading(false);
      return;
    }
    setPackageType(pkg.type || null);

    const defaultRefill = Number(cfg?.lives?.defaultRefillIntervalMs || HEART_REFILL_MS);
    const defaultMax = Number(cfg?.lives?.defaultMaxLives || DEFAULT_GLOBAL_MAX_LIVES);

    if (sid) {
      const livesNode = await getValue([`Platform1/studentLives/${sid}`, `studentLives/${sid}`]);
      if (livesNode) {
        const raw = livesNode;
        const lives = Number(raw?.currentLives ?? raw?.lives ?? null);
        const max = Number(raw?.maxLives ?? defaultMax);
        let refillRaw = raw?.refillIntervalMs ?? raw?.refillInterval ?? null;
        let refillMs = defaultRefill;
        if (refillRaw != null) {
          const num = Number(refillRaw);
          if (Number.isFinite(num)) refillMs = num > 1000 ? num : num * 1000;
        }
        const last = toMsTs(raw?.lastConsumedAt ?? raw?.lastConsumed ?? 0) || null;

        setGlobalLives(Number.isFinite(lives) ? lives : null);
        setGlobalMaxLives(Number.isFinite(max) ? max : defaultMax);
        setGlobalRefillMs(refillMs);
        setGlobalLastConsumedAt(last);
      } else {
        setGlobalLives(null);
        setGlobalMaxLives(defaultMax);
        setGlobalRefillMs(defaultRefill);
        setGlobalLastConsumedAt(null);
      }
    } else {
      setGlobalLives(null);
      setGlobalMaxLives(defaultMax);
      setGlobalRefillMs(defaultRefill);
      setGlobalLastConsumedAt(null);
    }

    if (grade && pkg.grade && normalizeGrade(pkg.grade) && normalizeGrade(pkg.grade) !== String(grade)) {
      setSubjects([]);
      setLoading(false);
      return;
    }

    const examMap = (await getValue([`Platform1/companyExams/exams`, `companyExams/exams`])) || {};
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

        let progressRaw = null;
        if (sid && rid && examId) {
          progressRaw = await getValue([
            `Platform1/studentProgress/${sid}/company/${rid}/${examId}`,
            `studentProgress/${sid}/company/${rid}/${examId}`,
          ]);
        }

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
          maxAttempts: Number(examMeta.maxAttempts || 1),
          attemptRefillIntervalMs: Number(examMeta.attemptRefillIntervalMs || 0),
          attemptRefillEnabled: examMeta.attemptRefillEnabled !== false,
          attemptsUsedRaw: Number(progressRaw?.attemptsUsed || 0),
          lastAttemptTsRaw: toMsTs(progressRaw?.lastAttemptTimestamp || progressRaw?.lastSubmittedAt || 0),
          status: r.status || "upcoming",
        });
      }

      out.push({
        id: subjectKey,
        keyName: subjectKey,
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

  const isPractice = useMemo(() => String(packageType || "").toLowerCase() !== "competitive", [packageType]);

  useEffect(() => {
    if (showHeartInfoModal) {
      Animated.spring(heartModalAnim, { toValue: 1, useNativeDriver: true }).start();
    } else {
      Animated.timing(heartModalAnim, { toValue: 0, duration: 160, useNativeDriver: true }).start();
    }
  }, [showHeartInfoModal, heartModalAnim]);

  useEffect(() => {
    let timer;
    let syncing = false;

    async function tickHeart() {
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

      const sid =
        (await AsyncStorage.getItem("studentNodeKey")) ||
        (await AsyncStorage.getItem("studentId")) ||
        (await AsyncStorage.getItem("username")) ||
        null;

      if (state.recovered > 0 && sid && !syncing) {
        syncing = true;
        try {
          await safeUpdate({
            [`Platform1/studentLives/${sid}/currentLives`]: state.currentLives,
            [`Platform1/studentLives/${sid}/lastConsumedAt`]: state.lastConsumedAt,
          });
          setGlobalLives(state.currentLives);
          setGlobalLastConsumedAt(state.lastConsumedAt);
        } catch (e) {
          console.warn("packageSubjects: heart refill sync failed", e);
        } finally {
          syncing = false;
        }
      }
    }

    tickHeart();
    timer = setInterval(tickHeart, 1000);
    return () => clearInterval(timer);
  }, [globalLives, globalMaxLives, globalLastConsumedAt, globalRefillMs]);

  const deriveAttemptState = useCallback((round, now) => {
    const maxAttempts = Number(round.maxAttempts || 1);
    const usedRaw = Number(round.attemptsUsedRaw || 0);
    const lastTs = Number(round.lastAttemptTsRaw || 0);

    if (String(packageType || "").toLowerCase() === "competitive") {
      return { usedEffective: usedRaw, left: Math.max(0, maxAttempts - usedRaw), nextInMs: 0, refill: false };
    }

    const enabled = appExamConfig.attempts.practiceRefillEnabled && round.attemptRefillEnabled !== false;
    const refillMs = Number(round.attemptRefillIntervalMs || appExamConfig.attempts.defaultRefillIntervalMs || 0);

    if (!enabled || !refillMs || !lastTs) {
      return { usedEffective: usedRaw, left: Math.max(0, maxAttempts - usedRaw), nextInMs: 0, refill: false };
    }

    const recoveredRaw = Math.floor(Math.max(0, now - lastTs) / refillMs);
    const maxCarry = Number(appExamConfig.attempts.maxCarryRefills ?? 999);
    const recovered = Math.min(Math.max(0, recoveredRaw), Math.max(0, maxCarry));

    const usedEffective = Math.max(0, usedRaw - recovered);
    const left = Math.max(0, maxAttempts - usedEffective);

    const anchor = lastTs + recovered * refillMs;
    const nextInMs = left >= maxAttempts ? 0 : Math.max(0, refillMs - ((now - anchor) % refillMs));

    return { usedEffective, left, nextInMs, refill: true, recovered, anchor };
  }, [packageType, appExamConfig]);

  const applyAttemptRefillIfNeeded = useCallback(async (sid, round) => {
    if (!sid || !round?.examId || !round?.roundId) return;

    const st = deriveAttemptState(round, Date.now());
    if (!st.refill || st.recovered <= 0) return;

    const maxAttempts = Number(round.maxAttempts || 1);
    const usedNew = Math.max(0, Math.min(maxAttempts, st.usedEffective));
    const anchorTs = Number(st.anchor || Date.now());

    await safeUpdate({
      [`Platform1/studentProgress/${sid}/company/${round.roundId}/${round.examId}/attemptsUsed`]: usedNew,
      [`Platform1/studentProgress/${sid}/company/${round.roundId}/${round.examId}/lastAttemptTimestamp`]: anchorTs,
    }).catch(() => {});
  }, [deriveAttemptState]);

  // ADD effect to run refill persistence periodically:
  useEffect(() => {
    let timer;
    (async () => {
      const sid =
        (await AsyncStorage.getItem("studentNodeKey")) ||
        (await AsyncStorage.getItem("studentId")) ||
        (await AsyncStorage.getItem("username")) ||
        null;

      async function tick() {
        if (!sid || String(packageType || "").toLowerCase() === "competitive") return;
        for (const s of subjects || []) {
          for (const r of s.rounds || []) {
            await applyAttemptRefillIfNeeded(sid, r);
          }
        }
      }

      await tick();
      timer = setInterval(tick, 5000); // every 5s enough
    })();

    return () => clearInterval(timer);
  }, [subjects, packageType, applyAttemptRefillIfNeeded]);

  if (loading) {
    return (
      <SafeAreaView style={[styles.screen, styles.center, { paddingTop: Platform.OS === "android" ? (StatusBar.currentHeight || 0) : 0 }]}>
        <ActivityIndicator color={PRIMARY} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.screen, { paddingTop: Platform.OS === "android" ? (StatusBar.currentHeight || 0) : 0 }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color={TEXT} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{packageName}</Text>
          <Text style={styles.subtitle}>Choose a subject and start a round</Text>
        </View>

        <TouchableOpacity onPress={() => setShowHeartInfoModal(true)} style={{ alignItems: "flex-end", minWidth: 72 }}>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <Ionicons
              name={globalLives != null && globalLives > 0 ? "heart" : "heart-outline"}
              size={20}
              color={globalLives != null && globalLives > 0 ? HEART_COLOR : MUTED}
            />
            <Text style={{ marginLeft: 6, color: PRIMARY, fontWeight: "900" }}>
              {globalLives != null ? `${globalLives}` : "—"}
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
          const v = getSubjectVisual(item.keyName, item.name);

          return (
            <View style={styles.subjectCard}>
              <TouchableOpacity style={styles.subjectTop} activeOpacity={0.9} onPress={() => toggle(item.id)}>
                <View style={[styles.subjectIconWrap, { backgroundColor: v.bg }]}>
                  <MaterialCommunityIcons name={v.icon} size={24} color={v.color} />
                </View>

                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={styles.subjectName}>{titleize(item.name)}</Text>
                  <Text style={styles.subjectChapter}>{item.chapter}</Text>
                  <Text style={styles.roundCount}>{(item.rounds || []).length} rounds</Text>
                </View>

                <Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={20} color={MUTED} />
              </TouchableOpacity>

              {expanded && (
                <View style={styles.expandArea}>
                  {(item.rounds || []).map((r) => {
                    const attemptState = deriveAttemptState(r, nowTs);
                    const disabledByAttempts = attemptState.left <= 0;
                    const disabledByLives = isPractice && globalLives === 0;
                    const disabled = disabledByAttempts || disabledByLives;

                    return (
                      <View key={`${r.roundId}_${r.examId}`} style={{ marginBottom: 10 }}>
                        <View style={styles.roundRow}>
                          <View style={{ flex: 1 }}>
                            <Text style={styles.roundName}>{r.name}</Text>
                            <Text style={styles.roundMeta}>
                              {(r.totalQuestions || 0)} Qs • {Math.round((r.timeLimit || 0) / 60)} min • {r.difficulty}
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
                          <View style={styles.lockInfo}>
                            {disabledByAttempts ? (
                              <>
                                <Text style={styles.noHeartText}>No attempts left for this exam.</Text>
                                {attemptState.refill && attemptState.nextInMs > 0 ? (
                                  <Text style={styles.refillText}>Next attempt in {formatMsToMMSS(attemptState.nextInMs)}</Text>
                                ) : null}
                              </>
                            ) : null}

                            {disabledByLives ? (
                              <>
                                <Text style={[styles.noHeartText, { marginTop: disabledByAttempts ? 6 : 0 }]}>No global lives left for practice.</Text>
                                <Text style={styles.refillText}>Next life in {formatMsToMMSS(nextHeartInMs)}</Text>
                              </>
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

      <Modal visible={showHeartInfoModal} transparent animationType="none" onRequestClose={() => setShowHeartInfoModal(false)}>
        <View style={modalStyles.overlay}>
          <Animated.View style={[modalStyles.card, { transform: [{ scale: heartModalAnim.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }) }], opacity: heartModalAnim }]}>
            <Text style={modalStyles.title}>Lives & refill</Text>
            <Text style={modalStyles.text}>Lives are global and configured by backend appConfig / studentLives.</Text>
            <View style={{ marginTop: 12, alignItems: "center" }}>
              <Ionicons name={globalLives != null && globalLives > 0 ? "heart" : "heart-outline"} size={32} color={globalLives != null && globalLives > 0 ? HEART_COLOR : MUTED} />
              <Text style={{ fontWeight: "900", marginTop: 8, fontSize: 18 }}>{globalLives != null ? `${globalLives} / ${globalMaxLives}` : `— / ${globalMaxLives}`}</Text>
              <Text style={{ marginTop: 8, color: MUTED }}>
                {globalLives != null && globalLives >= globalMaxLives ? "Lives full" : `Next life in: ${formatMsToMMSS(nextHeartInMs)}`}
              </Text>
              <Text style={{ marginTop: 6, color: MUTED, fontSize: 12 }}>
                Refill interval: {Math.round(globalRefillMs / 60000)} min
              </Text>
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
    width: 48,
    height: 48,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  subjectName: { color: TEXT, fontWeight: "900", fontSize: 16 },
  subjectChapter: { marginTop: 2, color: MUTED, fontSize: 12 },
  roundCount: { marginTop: 5, color: PRIMARY, fontWeight: "700", fontSize: 12 },

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

  lockInfo: {
    marginTop: 6,
    marginLeft: 2,
    borderWidth: 1,
    borderColor: "#FED7AA",
    backgroundColor: "#FFF7ED",
    borderRadius: 10,
    padding: 8,
  },
  noHeartText: { color: "#B54708", fontWeight: "800", fontSize: 12 },
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