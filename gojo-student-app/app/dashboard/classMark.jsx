import React, { useEffect, useState, useCallback, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  LayoutAnimation,
  UIManager,
  Platform,
  ScrollView,
  Animated,
  Modal,
  TouchableWithoutFeedback,
  Dimensions,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { ref, get } from "firebase/database";
import { database } from "../../constants/firebaseConfig";
import { Ionicons } from "@expo/vector-icons";

/**
 * ClassMark screen — improved UI (progress bars + insights)
 * Make sure this file name matches the import/route exactly (case-sensitive on mobile).
 */

const PRIMARY = "#007AFB";
const MUTED = "#6B78A8";
const SUCCESS = "#27AE60";
const WARNING = "#F2C94C";
const DANGER = "#EB5757";
const CARD_BORDER = "#F1F3F8";

if (Platform.OS === "android" && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

function humanNumber(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "-";
  return Number(n).toString();
}

const clamp = (v, a = 0, b = 100) => Math.max(a, Math.min(b, v));
const percentColor = (p) => {
  if (p >= 85) return SUCCESS;
  if (p >= 70) return PRIMARY;
  if (p >= 50) return WARNING;
  return DANGER;
};

function ProgressBar({ percent = 0, height = 10, borderRadius = 8, background = "#F1F3F8", style }) {
  const width = useRef(new Animated.Value(0)).current;
  const percentClamped = clamp(Math.round(percent), 0, 100);
  const color = percentColor(percentClamped);

  useEffect(() => {
    Animated.timing(width, {
      toValue: percentClamped,
      duration: 650,
      useNativeDriver: false,
    }).start();
  }, [percentClamped]);

  const animatedWidth = width.interpolate({
    inputRange: [0, 100],
    outputRange: ["0%", "100%"],
  });

  return (
    <View style={[{ backgroundColor: background, height, borderRadius, overflow: "hidden" }, style]}>
      <Animated.View style={{ width: animatedWidth, height, backgroundColor: color, borderRadius }} />
    </View>
  );
}

function BottomSheet({ visible, onClose, title, children, height = 300 }) {
  const translateY = useRef(new Animated.Value(height)).current;

  useEffect(() => {
    if (visible) {
      Animated.timing(translateY, { toValue: 0, duration: 320, useNativeDriver: true }).start();
    } else {
      Animated.timing(translateY, { toValue: height, duration: 220, useNativeDriver: true }).start();
    }
  }, [visible]);

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.modalBackdrop} />
      </TouchableWithoutFeedback>

      <Animated.View style={[styles.sheetContainer, { height, transform: [{ translateY }] }]}>
        <View style={styles.sheetHandle} />
        <Text style={styles.sheetTitle}>{title}</Text>
        <View style={{ flex: 1 }}>{children}</View>
      </Animated.View>
    </Modal>
  );
}

export default function ClassMarkScreen() {
  const [loading, setLoading] = useState(true);
  const [courses, setCourses] = useState([]);
  const [expandedCourses, setExpandedCourses] = useState({});
  const [marksMap, setMarksMap] = useState({});
  const [studentGrade, setStudentGrade] = useState(null);
  const [studentSection, setStudentSection] = useState(null);
  const [studentId, setStudentId] = useState(null);

  const [insightVisible, setInsightVisible] = useState(false);
  const [insightPayload, setInsightPayload] = useState(null);

  const loadStudentContext = useCallback(async () => {
    try {
      const sNode = (await AsyncStorage.getItem("studentNodeKey")) || (await AsyncStorage.getItem("studentId"));
      if (sNode) {
        const snap = await get(ref(database, `Students/${sNode}`));
        if (snap.exists()) {
          const s = snap.val();
          setStudentId(sNode);
          setStudentGrade(s.grade ? String(s.grade) : null);
          setStudentSection(s.section ? String(s.section) : null);
          return { studentId: sNode, grade: String(s.grade || ""), section: String(s.section || "") };
        }
      }

      const userNodeKey = await AsyncStorage.getItem("userNodeKey");
      if (userNodeKey) {
        const userSnap = await get(ref(database, `Users/${userNodeKey}`));
        if (userSnap.exists()) {
          const user = userSnap.val();
          if (user.studentId) {
            const sSnap = await get(ref(database, `Students/${user.studentId}`));
            if (sSnap.exists()) {
              const s = sSnap.val();
              setStudentId(user.studentId);
              setStudentGrade(s.grade ? String(s.grade) : null);
              setStudentSection(s.section ? String(s.section) : null);
              return { studentId: user.studentId, grade: String(s.grade || ""), section: String(s.section || "") };
            }
          }
        }
      }
    } catch (err) {
      console.warn("loadStudentContext error:", err);
    }
    return null;
  }, []);

  useEffect(() => {
    let mounted = true;
    (async () => {
      setLoading(true);
      const ctx = await loadStudentContext();
      if (!ctx) {
        if (mounted) { setCourses([]); setLoading(false); }
        return;
      }

      const grade = ctx.grade;
      const section = ctx.section;
      const sid = ctx.studentId;

      try {
        const snap = await get(ref(database, "Courses"));
        const list = [];
        if (snap.exists()) {
          snap.forEach((child) => {
            const val = child.val();
            const key = child.key;
            const cGrade = String(val.grade ?? "");
            const cSection = String(val.section ?? "");
            if (cGrade === String(grade) && cSection === String(section)) {
              list.push({ key, data: val });
            }
          });
        }
        list.sort((a, b) => (a.data.name || "").localeCompare(b.data.name || ""));

        if (!mounted) return;
        setCourses(list);

        const marks = {};
        await Promise.all(
          list.map(async (c) => {
            try {
              const cmSnap = await get(ref(database, `ClassMarks/${c.key}/${sid}`));
              marks[c.key] = cmSnap.exists() ? cmSnap.val() : null;
            } catch (err) {
              console.warn("fetch classmarks error for", c.key, err);
              marks[c.key] = null;
            }
          })
        );

        if (!mounted) return;
        setMarksMap(marks);
      } catch (err) {
        console.warn("failed to load courses/classmarks", err);
        if (mounted) { setCourses([]); setMarksMap({}); }
      } finally {
        if (mounted) setLoading(false);
      }
    })();

    return () => { mounted = false; };
  }, [loadStudentContext]);

  const toggleCourse = (k) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpandedCourses((p) => ({ ...p, [k]: !p[k] }));
  };

  const parseAssessments = (assessmentsNode) => {
    if (!assessmentsNode) return [];
    return Object.keys(assessmentsNode).map((k) => {
      const v = assessmentsNode[k] || {};
      return { key: k, name: v.name || k, max: v.max != null ? Number(v.max) : null, score: v.score != null ? Number(v.score) : null };
    });
  };

  const calcQuarterTotals = (assessmentsNode) => {
    const arr = parseAssessments(assessmentsNode);
    let totalScore = 0;
    let totalMax = 0;
    arr.forEach((a) => {
      if (a.score != null) totalScore += Number(a.score);
      if (a.max != null) totalMax += Number(a.max);
    });
    const percent = totalMax > 0 ? (totalScore / totalMax) * 100 : null;
    return { totalScore, totalMax, percent, items: arr };
  };

  const computeCourseOverall = (marks) => {
    if (!marks) return { score: 0, max: 0, percent: null };

    let accumulatedScore = 0;
    let accumulatedMax = 0;

    Object.keys(marks).forEach((semKey) => {
      const sem = marks[semKey];
      if (!sem) return;
      Object.keys(sem).forEach((qKey) => {
        const qNode = sem[qKey];
        if (!qNode) return;
        const assessNode = qNode.assessments || qNode.assessment || {};
        const res = calcQuarterTotals(assessNode);
        accumulatedScore += Number(res.totalScore || 0);
        accumulatedMax += Number(res.totalMax || 0);
      });
    });

    const percent = accumulatedMax > 0 ? (accumulatedScore / accumulatedMax) * 100 : null;
    return { score: accumulatedScore, max: accumulatedMax, percent };
  };

  const insightForPercent = (percent) => {
    if (percent === null) return { title: "No data", message: "No assessments recorded yet for this course.", tone: MUTED };
    const p = Math.round(percent);
    if (p >= 90) return { title: "Outstanding", message: "Excellent work — keep it up! You're performing at the top of the class.", tone: SUCCESS };
    if (p >= 80) return { title: "Great", message: "Very good performance. A little more practice and you'll be exceptional.", tone: PRIMARY };
    if (p >= 65) return { title: "Good", message: "Solid performance. Focus on weaker topics to improve further.", tone: "#3AA0FF" };
    if (p >= 50) return { title: "Fair", message: "You're getting there. Spend time on missed assessments and ask your teacher for help.", tone: WARNING };
    return { title: "Needs improvement", message: "Below expectation. Please review the material and consider extra practice.", tone: DANGER };
  };

  const showCourseInsight = (courseKey, courseName) => {
    const marks = marksMap[courseKey] || {};
    const overall = computeCourseOverall(marks);
    const insight = insightForPercent(overall.percent);
    const breakdown = [];
    Object.keys(marks || {}).forEach((semKey) => {
      const sem = marks[semKey];
      const quarterList = [];
      Object.keys(sem || {}).forEach((qk) => {
        const qNode = sem[qk];
        const res = calcQuarterTotals((qNode && (qNode.assessments || qNode.assessment)) || {});
        quarterList.push({ key: qk, score: res.totalScore, max: res.totalMax, percent: res.percent });
      });
      breakdown.push({ semKey, quarters: quarterList });
    });

    setInsightPayload({ courseKey, courseName, overall, insight, breakdown });
    setInsightVisible(true);
  };

  const renderCourse = ({ item }) => {
    const courseKey = item.key;
    const course = item.data;
    const marks = marksMap[courseKey] || {};
    const overall = computeCourseOverall(marks);
    const percent = overall.percent !== null ? Math.round(overall.percent) : null;
    const displayPercent = percent !== null ? percent : 0;
    const color = percent !== null ? percentColor(percent) : MUTED;

    return (
      <View style={styles.card} key={courseKey}>
        <View style={styles.cardHeader}>
          <View style={{ flex: 1 }}>
            <Text style={styles.courseName}>{course.name || course.subject || courseKey}</Text>
            <Text style={styles.courseSub}>{course.subject || ""} • Grade {course.grade || ""} {course.section ? `• Section ${course.section}` : ""}</Text>
            <View style={{ marginTop: 10 }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                <Text style={styles.smallMuted}>Overall progress</Text>
                <Text style={[styles.boldPercent, { color: color }]}>{percent !== null ? `${percent}%` : "–"}</Text>
              </View>
              <ProgressBar percent={displayPercent} height={12} style={{ marginTop: 8 }} />
            </View>
          </View>

          <View style={{ marginLeft: 12, alignItems: "flex-end" }}>
            <TouchableOpacity onPress={() => toggleCourse(courseKey)} style={{ padding: 8 }}>
              <Ionicons name={expandedCourses[courseKey] ? "chevron-up-outline" : "chevron-down-outline"} size={22} color={MUTED} />
            </TouchableOpacity>

            <TouchableOpacity onPress={() => showCourseInsight(courseKey, course.name)} style={styles.insightBtn}>
              <Ionicons name="pulse" size={16} color="#fff" />
              <Text style={styles.insightBtnText}>Insights</Text>
            </TouchableOpacity>
          </View>
        </View>

        {expandedCourses[courseKey] && (
          <View style={styles.cardBody}>
            {Object.keys(marks || {}).length === 0 ? (
              <Text style={styles.noAssess}>No marks recorded yet for this course.</Text>
            ) : (
              Object.keys(marks || {}).map((semKey) => {
                const semNode = marks[semKey] || {};
                const quarterKeys = Object.keys(semNode || {}).filter((k) => String(k).toLowerCase().startsWith("q"));
                const quarters = quarterKeys.length > 0 ? quarterKeys : Object.keys(semNode);
                return (
                  <View key={semKey} style={styles.semesterBlock}>
                    <View style={styles.semesterHeader}>
                      <Text style={styles.semesterTitle}>{semKey.replace(/_/g, " ").toUpperCase()}</Text>
                    </View>

                    {quarters.map((qk) => {
                      const qNode = semNode[qk] || {};
                      const assessmentsNode = qNode.assessments || qNode.assessment || {};
                      const { totalScore, totalMax, percent: qPercent, items } = calcQuarterTotals(assessmentsNode);
                      const qPercentDisplay = qPercent !== null ? Math.round(qPercent) : null;

                      return (
                        <View key={qk} style={styles.quarterCard}>
                          <View style={styles.quarterHeader}>
                            <Text style={styles.quarterTitle}>{qk.toUpperCase()}</Text>
                            <Text style={styles.quarterSummary}>{humanNumber(totalScore)} / {humanNumber(totalMax)}</Text>
                          </View>

                          <ProgressBar percent={qPercentDisplay || 0} height={10} style={{ marginTop: 8 }} />

                          <View style={{ marginTop: 10 }}>
                            {items.length === 0 ? (
                              <Text style={styles.noAssess}>No assessments yet</Text>
                            ) : (
                              items.map((a) => (
                                <View style={styles.assRow} key={a.key}>
                                  <View style={{ flex: 1 }}>
                                    <Text style={styles.assName}>{a.name}</Text>
                                    <Text style={styles.assMeta}>Max: {a.max != null ? a.max : "-"}  •  Score: {a.score != null ? a.score : "-"}</Text>
                                  </View>
                                  <View style={{ width: 60, alignItems: "flex-end" }}>
                                    <Text style={[styles.assScore, { color: percentColor((a.score && a.max) ? (a.score / a.max) * 100 : 0) }]}>
                                      {a.score != null ? a.score : "-"}
                                    </Text>
                                  </View>
                                </View>
                              ))
                            )}
                          </View>

                          {qNode && qNode.teacherName ? <Text style={styles.teacherSmall}>Teacher: {qNode.teacherName}</Text> : null}
                        </View>
                      );
                    })}
                  </View>
                );
              })
            )}
          </View>
        )}
      </View>
    );
  };

  const InsightSheet = () => {
    if (!insightPayload) return null;
    const { courseName, overall, insight, breakdown } = insightPayload;
    const percent = overall.percent !== null ? Math.round(overall.percent) : null;
    const color = percent !== null ? percentColor(percent) : MUTED;

    return (
      <BottomSheet visible={insightVisible} onClose={() => setInsightVisible(false)} title={courseName || "Insights"} height={320}>
        <View style={{ paddingHorizontal: 14, paddingTop: 6 }}>
          <Text style={[styles.insightTitle, { color }]}>{insight.title}</Text>
          <Text style={styles.insightMessage}>{insight.message}</Text>

          <View style={{ marginTop: 12, marginBottom: 6 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <Text style={styles.smallMuted}>Overall Score</Text>
              <Text style={{ fontWeight: "700", color }}>{percent !== null ? `${percent}%` : "–"}</Text>
            </View>
            <ProgressBar percent={percent !== null ? percent : 0} height={12} style={{ marginTop: 8 }} />
          </View>

          <View style={{ marginTop: 10 }}>
            <Text style={styles.smallMuted}>Breakdown</Text>
            <ScrollView style={{ maxHeight: 110, marginTop: 8 }}>
              {breakdown.length === 0 ? <Text style={styles.noAssess}>No data</Text> : breakdown.map((s) => (
                <View key={s.semKey} style={{ marginBottom: 8 }}>
                  <Text style={{ fontWeight: "700", color: "#222" }}>{s.semKey.toUpperCase()}</Text>
                  {s.quarters.map((q) => {
                    const pq = q.percent !== null ? Math.round(q.percent) : null;
                    return (
                      <View key={q.key} style={{ marginTop: 6 }}>
                        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                          <Text style={{ color: MUTED }}>{q.key.toUpperCase()}</Text>
                          <Text style={{ color: pq !== null ? percentColor(pq) : MUTED }}>{pq !== null ? `${pq}%` : "-"}</Text>
                        </View>
                      </View>
                    );
                  })}
                </View>
              ))}
            </ScrollView>
          </View>

          <View style={{ marginTop: 12, flexDirection: "row", justifyContent: "space-between" }}>
            <TouchableOpacity onPress={() => { setInsightVisible(false); }} style={styles.sheetBtn}>
              <Text style={styles.sheetBtnText}>Close</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { setInsightVisible(false); Alert.alert("Tip", "Ask your teacher for extra help on topics you missed."); }} style={[styles.sheetBtn, { backgroundColor: PRIMARY }]}>
              <Text style={[styles.sheetBtnText, { color: "#fff" }]}>Need Help?</Text>
            </TouchableOpacity>
          </View>
        </View>
      </BottomSheet>
    );
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={PRIMARY} />
      </View>
    );
  }

  if (!courses || courses.length === 0) {
    return (
      <View style={styles.emptyWrap}>
        <Text style={styles.emptyTitle}>No Courses Found</Text>
        <Text style={styles.emptySubtitle}>We couldn't find any courses for your grade/section.</Text>
      </View>
    );
  }

  const Header = () => (
    <View style={styles.headerRow}>
      <View>
        <Text style={styles.headerTitle}>Class Marks</Text>
        <Text style={styles.headerSubtitle}>See your assessments by course, semester and quarter. Tap "Insights" for a quick analysis.</Text>
      </View>
    </View>
  );

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 12, paddingBottom: 48 }}>
      <Header />

      <FlatList
        data={courses}
        keyExtractor={(i) => i.key}
        renderItem={renderCourse}
        contentContainerStyle={{ paddingTop: 12, paddingBottom: 32 }}
        scrollEnabled={false}
      />

      {insightVisible && <InsightSheet />}
      {!insightVisible && <View />}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },

  headerRow: { marginBottom: 6 },
  headerTitle: { fontSize: 22, fontWeight: "700", color: "#111", paddingHorizontal: 2 },
  headerSubtitle: { marginTop: 6, color: MUTED, paddingHorizontal: 2 },

  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 20 },

  card: {
    backgroundColor: "#fff",
    borderRadius: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: CARD_BORDER,
    overflow: "hidden",
  },
  cardHeader: { flexDirection: "row", alignItems: "flex-start", padding: 12 },
  courseName: { fontWeight: "700", fontSize: 16, color: "#111" },
  courseSub: { color: MUTED, marginTop: 6 },

  insightBtn: { marginTop: 8, backgroundColor: PRIMARY, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, flexDirection: "row", alignItems: "center" },
  insightBtnText: { color: "#fff", marginLeft: 6, fontWeight: "700", fontSize: 12 },

  cardBody: { paddingHorizontal: 12, paddingBottom: 12 },

  semesterBlock: { marginTop: 10, paddingVertical: 8 },
  semesterHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  semesterTitle: { fontWeight: "700", color: "#222", marginBottom: 8 },

  quarterCard: {
    backgroundColor: "#FBFCFF",
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "#EEF4FF",
  },
  quarterHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  quarterTitle: { fontWeight: "700", color: "#0b4ea2" },
  quarterSummary: { fontWeight: "700", color: "#0b4ea2" },

  assessmentsList: { marginTop: 8 },
  assRow: { flexDirection: "row", alignItems: "center", paddingVertical: 8, borderBottomColor: "#F1F3F8", borderBottomWidth: 1 },
  assName: { fontWeight: "600", color: "#222" },
  assMeta: { color: MUTED, fontSize: 12, marginTop: 4 },
  assScore: { fontWeight: "700", color: PRIMARY },

  noAssess: { color: MUTED, fontStyle: "italic" },

  teacherSmall: { marginTop: 8, color: MUTED, fontSize: 12 },

  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)" },
  sheetContainer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "#fff",
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    paddingTop: 8,
    paddingHorizontal: 6,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
    elevation: 10,
  },
  sheetHandle: { width: 48, height: 6, borderRadius: 4, backgroundColor: "#E6E9F2", alignSelf: "center", marginBottom: 8 },
  sheetTitle: { fontWeight: "700", fontSize: 16, color: "#222", paddingHorizontal: 12, marginBottom: 8 },
  sheetBtn: { paddingVertical: 10, paddingHorizontal: 18, borderRadius: 10, backgroundColor: "#F1F3F8" },
  sheetBtnText: { fontWeight: "700", color: "#222" },

  insightTitle: { fontSize: 18, fontWeight: "800" },
  insightMessage: { color: MUTED, marginTop: 6 },

  smallMuted: { color: MUTED, fontSize: 12 },
  boldPercent: { fontSize: 16, fontWeight: "800" },

  fileRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 12, borderBottomColor: "#F1F3F8", borderBottomWidth: 1 },
  fileName: { fontSize: 13, fontWeight: "600", color: "#111" },
  fileMeta: { fontSize: 12, color: MUTED, marginTop: 4 },

  emptyWrap: { flex: 1, alignItems: "center", justifyContent: "center", paddingTop: 80 },
  emptyTitle: { fontSize: 18, fontWeight: "700", color: "#222", marginBottom: 6 },
  emptySubtitle: { fontSize: 14, color: MUTED, textAlign: "center" },
});