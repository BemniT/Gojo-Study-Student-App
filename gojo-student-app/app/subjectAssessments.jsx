import React, { useEffect, useState, useCallback, useMemo } from "react";
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { ref, get } from "firebase/database";
import { database } from "../constants/firebaseConfig";
import { getSnapshot } from "./lib/dbHelpers";

const PRIMARY = "#0B72FF";
const MUTED = "#6B78A8";
const TEXT = "#0B2540";
const BORDER = "#EAF0FF";
const BG = "#FFFFFF";
const CARD = "#FFFFFF";
const SUCCESS = "#12B76A";
const WARNING = "#F59E0B";
const DANGER = "#EF4444";
const INFO = "#0EA5E9";

const SUBJECT_ICON_MAP = [
  { keys: ["english", "literature"], icon: "book-open-page-variant", color: "#6C5CE7" },
  { keys: ["math", "mathematics", "algebra", "geometry", "maths"], icon: "calculator-variant", color: "#00A8FF" },
  { keys: ["science", "general science", "biology", "chemistry", "physics"], icon: "flask", color: "#00B894" },
  { keys: ["environmental", "env"], icon: "leaf", color: "#00C897" },
  { keys: ["history", "social"], icon: "history", color: "#F39C12" },
  { keys: ["geography"], icon: "map", color: "#0984E3" },
  { keys: ["computer", "ict", "computing"], icon: "laptop", color: "#8E44AD" },
  { keys: ["physical", "pe", "sport"], icon: "run", color: "#E17055" },
  { keys: ["art"], icon: "palette", color: "#FF7675" },
];

function getSubjectVisual(subjectName = "") {
  const lower = String(subjectName).toLowerCase();
  const match = SUBJECT_ICON_MAP.find((item) =>
    item.keys.some((key) => lower.includes(key))
  );
  return match || { icon: "book-education-outline", color: PRIMARY };
}

function normalizeUnixTimestamp(ts) {
  const num = Number(ts);
  if (!num || Number.isNaN(num)) return null;
  return num < 1000000000000 ? num * 1000 : num;
}

function formatDueDate(dueDate) {
  const normalized = normalizeUnixTimestamp(dueDate);
  if (!normalized) return "No due date";

  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return "No due date";

  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function getAssessmentStatus({ submitted, finalScore, dueDate }) {
  if (submitted) {
    if (typeof finalScore === "number") {
      return { label: "Graded", color: SUCCESS, icon: "checkmark-circle" };
    }
    return { label: "Submitted", color: INFO, icon: "cloud-done-outline" };
  }

  const normalizedDueDate = normalizeUnixTimestamp(dueDate);
  if (normalizedDueDate && Date.now() > normalizedDueDate) {
    return { label: "Overdue", color: DANGER, icon: "alert-circle-outline" };
  }

  return { label: "Pending", color: WARNING, icon: "time-outline" };
}

function getTypeMeta(type = "") {
  const t = String(type || "").toLowerCase();

  if (t.includes("worksheet")) return { label: "Worksheet", icon: "document-text-outline" };
  if (t.includes("quiz")) return { label: "Quiz", icon: "help-circle-outline" };
  if (t.includes("test")) return { label: type || "Test", icon: "create-outline" };
  if (t.includes("exam")) return { label: "Exam", icon: "school-outline" };

  return { label: type || "Assessment", icon: "reader-outline" };
}

async function resolveSchoolKeyFast(studentId) {
  if (!studentId) return null;

  try {
    const cached = await AsyncStorage.getItem("schoolKey");
    if (cached) return cached;
  } catch {}

  try {
    const schoolsSnap = await getSnapshot([`Platform1/Schools`]);
    const schools = schoolsSnap?.val ? schoolsSnap.val() || {} : {};
    for (const schoolKey of Object.keys(schools)) {
      const s = await get(ref(database, `Platform1/Schools/${schoolKey}/Students/${studentId}`));
      if (s.exists()) {
        try { await AsyncStorage.setItem("schoolKey", schoolKey); } catch {}
        return schoolKey;
      }
    }
  } catch {}

  return null;
}

export default function SubjectAssessmentsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { courseId, subject, grade, section } = useLocalSearchParams();

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [items, setItems] = useState([]);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const sid =
        (await AsyncStorage.getItem("studentNodeKey")) ||
        (await AsyncStorage.getItem("studentId")) ||
        (await AsyncStorage.getItem("username")) ||
        null;

      const sk = await resolveSchoolKeyFast(sid);

      let assessmentsObj = {};
      if (sk) {
        const scoped = await get(ref(database, `Platform1/Schools/${sk}/SchoolExams/Assessments`));
        if (scoped.exists()) assessmentsObj = scoped.val() || {};
      }

      if (!Object.keys(assessmentsObj).length) {
        const global = await get(ref(database, `SchoolExams/Assessments`));
        if (global.exists()) assessmentsObj = global.val() || {};
      }

      const list = Object.keys(assessmentsObj)
        .map((aid) => ({ assessmentId: aid, ...assessmentsObj[aid] }))
        .filter((a) => String(a.courseId) === String(courseId))
        .filter((a) => String(a.status || "").toLowerCase() !== "removed")
        .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));

      const enriched = await Promise.all(
        list.map(async (a) => {
          let idx = null;

          if (sk && sid) {
            const scoped = await get(
              ref(database, `Platform1/Schools/${sk}/SchoolExams/SubmissionIndex/${a.assessmentId}/${sid}`)
            );
            if (scoped.exists()) idx = scoped.val() || {};
          }

          if (!idx && sid) {
            const global = await get(ref(database, `SchoolExams/SubmissionIndex/${a.assessmentId}/${sid}`));
            if (global.exists()) idx = global.val() || {};
          }

          return {
            ...a,
            submitted: !!idx,
            finalScore: typeof idx?.finalScore === "number" ? idx.finalScore : null,
          };
        })
      );

      setItems(enriched);
    } finally {
      setLoading(false);
    }
  }, [courseId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  }, [loadData]);

  const visual = useMemo(() => getSubjectVisual(subject), [subject]);

  const stats = useMemo(() => {
    const total = items.length;
    const submitted = items.filter((x) => x.submitted).length;
    const pending = items.filter((x) => !x.submitted).length;
    return { total, submitted, pending };
  }, [items]);

  if (loading) {
    return (
      <SafeAreaView style={[styles.center, { paddingTop: insets.top, backgroundColor: BG }]}>
        <ActivityIndicator color={PRIMARY} size="large" />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen}>
      <FlatList
        data={items}
        keyExtractor={(i) => i.assessmentId}
        contentContainerStyle={{
          paddingBottom: Math.max(24, insets.bottom + 16),
        }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={PRIMARY} />
        }
        ListHeaderComponent={
          <>
            <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
              <TouchableOpacity onPress={() => router.back()} style={styles.backIconBtn}>
                <Ionicons name="arrow-back" size={20} color={PRIMARY} />
              </TouchableOpacity>

              <TouchableOpacity onPress={onRefresh} style={styles.headerActionBtn}>
                <Ionicons name="refresh-outline" size={18} color={PRIMARY} />
              </TouchableOpacity>
            </View>

            <View style={styles.heroCard}>
              <View style={[styles.heroIconWrap, { backgroundColor: `${visual.color}16` }]}>
                <MaterialCommunityIcons name={visual.icon} size={26} color={visual.color} />
              </View>

              <View style={{ flex: 1 }}>
                <Text style={styles.heroTitle}>{subject || "Subject"}</Text>
                <Text style={styles.heroSubTitle}>
                  Grade {grade || "--"} • Section {section || "--"}
                </Text>
                <Text style={styles.heroText}>
                  View available school assessments and continue where needed.
                </Text>
              </View>
            </View>

            <View style={styles.statsRow}>
              <View style={styles.statCard}>
                <Text style={styles.statValue}>{stats.total}</Text>
                <Text style={styles.statLabel}>Total</Text>
              </View>
              <View style={styles.statCard}>
                <Text style={[styles.statValue, { color: INFO }]}>{stats.submitted}</Text>
                <Text style={styles.statLabel}>Submitted</Text>
              </View>
              <View style={styles.statCardLast}>
                <Text style={[styles.statValue, { color: WARNING }]}>{stats.pending}</Text>
                <Text style={styles.statLabel}>Pending</Text>
              </View>
            </View>

            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Assessments</Text>
              <Text style={styles.sectionSubtitle}>
                {items.length ? "Tap any card to open it." : "No published assessments yet."}
              </Text>
            </View>
          </>
        }
        ListEmptyComponent={
          <View style={styles.emptyWrap}>
            <View style={styles.emptyIconWrap}>
              <MaterialCommunityIcons name="clipboard-text-outline" size={28} color={MUTED} />
            </View>
            <Text style={styles.emptyTitle}>No assessments available</Text>
            <Text style={styles.emptyText}>
              Your teacher has not published assessments for this subject yet.
            </Text>
          </View>
        }
        renderItem={({ item }) => {
          const status = getAssessmentStatus({
            submitted: item.submitted,
            finalScore: item.finalScore,
            dueDate: item.dueDate,
          });

          const typeMeta = getTypeMeta(item.type);
          const dueLabel = formatDueDate(item.dueDate);

          return (
            <TouchableOpacity
              style={styles.card}
              activeOpacity={0.92}
              onPress={() =>
                router.push({
                  pathname: "/takeAssessment",
                  params: {
                    assessmentId: item.assessmentId,
                    courseId: item.courseId,
                    title: item.title || "Assessment",
                  },
                })
              }
            >
              <View style={styles.cardTopRow}>
                <View style={styles.typeBadge}>
                  <Ionicons name={typeMeta.icon} size={11} color={PRIMARY} />
                  <Text style={styles.typeText}>{typeMeta.label}</Text>
                </View>

                <View style={[styles.statusBadge, { backgroundColor: `${status.color}18` }]}>
                  <Ionicons name={status.icon} size={11} color={status.color} />
                  <Text style={[styles.statusText, { color: status.color }]}>{status.label}</Text>
                </View>
              </View>

              <Text style={styles.cardTitle} numberOfLines={1}>
                {item.title || "Assessment"}
              </Text>

              <View style={styles.metaGrid}>
                <View style={styles.metaChip}>
                  <Ionicons name="calendar-outline" size={12} color={MUTED} />
                  <Text style={styles.metaChipText}>{dueLabel}</Text>
                </View>

                <View style={styles.metaChip}>
                  <Ionicons name="help-circle-outline" size={12} color={MUTED} />
                  <Text style={styles.metaChipText}>{Number(item.questionCount || 0)} Qs</Text>
                </View>

                <View style={styles.metaChip}>
                  <Ionicons name="ribbon-outline" size={12} color={MUTED} />
                  <Text style={styles.metaChipText}>{Number(item.totalPoints || 0)} pts</Text>
                </View>

                <View style={styles.metaChip}>
                  <Ionicons name="time-outline" size={12} color={MUTED} />
                  <Text style={styles.metaChipText}>
                    {item.timeLimitMinutes ? `${item.timeLimitMinutes} min` : "No limit"}
                  </Text>
                </View>
              </View>

              <View style={styles.cardFooter}>
                <View style={{ flex: 1 }}>
                  {typeof item.finalScore === "number" ? (
                    <Text style={styles.scoreText}>Score: {item.finalScore}</Text>
                  ) : (
                    <Text style={styles.scoreHint}>
                      {item.submitted ? "Waiting for result" : "Ready to start"}
                    </Text>
                  )}
                </View>

                <View style={styles.openWrap}>
                  <Text style={styles.openText}>{item.submitted ? "Open" : "Start"}</Text>
                  <Ionicons name="arrow-forward" size={14} color={PRIMARY} />
                </View>
              </View>
            </TouchableOpacity>
          );
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: BG },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },

  header: {
    paddingHorizontal: 14,
    paddingBottom: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  backIconBtn: {
    width: 38,
    height: 38,
    borderRadius: 12,
    backgroundColor: "#EEF4FF",
    alignItems: "center",
    justifyContent: "center",
  },
  headerActionBtn: {
    width: 38,
    height: 38,
    borderRadius: 12,
    backgroundColor: "#F7FAFF",
    borderWidth: 1,
    borderColor: BORDER,
    alignItems: "center",
    justifyContent: "center",
  },

  heroCard: {
    marginHorizontal: 14,
    marginTop: 4,
    padding: 16,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: BORDER,
    backgroundColor: "#F8FBFF",
    flexDirection: "row",
    alignItems: "flex-start",
  },
  heroIconWrap: {
    width: 54,
    height: 54,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 14,
  },
  heroTitle: {
    fontSize: 21,
    fontWeight: "900",
    color: TEXT,
  },
  heroSubTitle: {
    marginTop: 4,
    fontSize: 12,
    color: MUTED,
    fontWeight: "700",
  },
  heroText: {
    marginTop: 8,
    color: MUTED,
    fontSize: 13,
    lineHeight: 18,
  },

  statsRow: {
    flexDirection: "row",
    paddingHorizontal: 14,
    marginTop: 12,
  },
  statCard: {
    flex: 1,
    marginRight: 10,
    backgroundColor: CARD,
    borderWidth: 1,
    borderColor: BORDER,
    borderRadius: 16,
    paddingVertical: 13,
    alignItems: "center",
  },
  statCardLast: {
    flex: 1,
    backgroundColor: CARD,
    borderWidth: 1,
    borderColor: BORDER,
    borderRadius: 16,
    paddingVertical: 13,
    alignItems: "center",
  },
  statValue: {
    fontSize: 17,
    fontWeight: "900",
    color: TEXT,
  },
  statLabel: {
    marginTop: 4,
    fontSize: 12,
    color: MUTED,
    fontWeight: "700",
  },

  sectionHeader: {
    paddingHorizontal: 14,
    paddingTop: 18,
    paddingBottom: 8,
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: "900",
    color: TEXT,
  },
  sectionSubtitle: {
    marginTop: 4,
    fontSize: 12,
    color: MUTED,
    fontWeight: "600",
  },

  emptyWrap: {
    marginHorizontal: 14,
    marginTop: 8,
    borderWidth: 1,
    borderColor: BORDER,
    borderRadius: 18,
    padding: 22,
    alignItems: "center",
    backgroundColor: "#FBFDFF",
  },
  emptyIconWrap: {
    width: 56,
    height: 56,
    borderRadius: 18,
    backgroundColor: "#F1F5FF",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 12,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: "900",
    color: TEXT,
  },
  emptyText: {
    marginTop: 6,
    color: MUTED,
    textAlign: "center",
    lineHeight: 19,
  },

  card: {
    marginHorizontal: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: BORDER,
    borderRadius: 18,
    padding: 12,
    backgroundColor: CARD,
  },
  cardTopRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  typeBadge: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#EEF4FF",
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  typeText: {
    marginLeft: 5,
    color: PRIMARY,
    fontSize: 10.5,
    fontWeight: "800",
  },
  statusBadge: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  statusText: {
    marginLeft: 5,
    fontSize: 10.5,
    fontWeight: "800",
  },

  cardTitle: {
    marginTop: 10,
    fontSize: 15,
    fontWeight: "900",
    color: TEXT,
  },

  metaGrid: {
    marginTop: 10,
    flexDirection: "row",
    flexWrap: "wrap",
  },
  metaChip: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#F8FAFF",
    borderWidth: 1,
    borderColor: "#F1F4FA",
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 6,
    marginRight: 8,
    marginBottom: 8,
  },
  metaChipText: {
    marginLeft: 6,
    color: MUTED,
    fontSize: 11,
    fontWeight: "700",
  },

  cardFooter: {
    marginTop: 2,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: "#F2F5FB",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  scoreText: {
    color: SUCCESS,
    fontWeight: "800",
    fontSize: 12.5,
  },
  scoreHint: {
    color: MUTED,
    fontWeight: "700",
    fontSize: 11.5,
  },
  openWrap: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#EEF4FF",
    borderRadius: 999,
    paddingHorizontal: 11,
    paddingVertical: 7,
  },
  openText: {
    color: PRIMARY,
    fontWeight: "800",
    marginRight: 6,
    fontSize: 11.5,
  },
});