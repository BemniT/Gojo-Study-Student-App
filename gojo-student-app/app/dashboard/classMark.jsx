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
  Modal,
  Animated,
  Image,
  PanResponder,
  Dimensions,
  TouchableWithoutFeedback,
  Alert,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { ref, get } from "firebase/database";
import { database } from "../../constants/firebaseConfig";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { Svg, Circle } from "react-native-svg";

/* app/dashboard/classMark.jsx
   - Handle drag to collapse when full (one-finger) via handle pan responder
   - Quarter header progress in bottom sheet changed from circular -> linear
*/

const { height: SCREEN_H } = Dimensions.get("window");
const PRIMARY = "#007AFB";
const MUTED = "#6B78A8";
const SUCCESS = "#27AE60";
const WARNING = "#F2C94C";
const DANGER = "#EB5757";
const CARD_BORDER = "#F1F3F8";

if (Platform.OS === "android" && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const clamp = (v, a = 0, b = 100) => Math.max(a, Math.min(b, v));
function humanNumber(n) { if (n == null || Number.isNaN(Number(n))) return "-"; return String(n); }
const percentColor = (p) => { if (p == null) return MUTED; if (p >= 85) return SUCCESS; if (p >= 70) return PRIMARY; if (p >= 50) return WARNING; return DANGER; };

/* mapping subject names -> icon */
const SUBJECT_ICON_MAP = [
  { keys: ["english", "literature"], icon: "book-open-page-variant", color: "#6C5CE7" },
  { keys: ["math", "mathematics", "algebra", "geometry"], icon: "calculator-variant", color: "#00A8FF" },
  { keys: ["science", "general science", "biology", "chemistry", "physics"], icon: "flask", color: "#00B894" },
  { keys: ["environmental", "env"], icon: "leaf", color: "#00C897" },
  { keys: ["history", "social"], icon: "history", color: "#F39C12" },
  { keys: ["geography"], icon: "map", color: "#0984e3" },
  { keys: ["computer", "ict", "computing"], icon: "laptop", color: "#8e44ad" },
  { keys: ["physical", "pe", "sport"], icon: "run", color: "#e17055" },
];
function getSubjectIcon(subjectText = "") {
  const s = (subjectText || "").toLowerCase();
  for (const entry of SUBJECT_ICON_MAP) {
    for (const k of entry.keys) if (s.includes(k)) return { name: entry.icon, color: entry.color };
  }
  return { name: "book-outline", color: "#6e6e6e" };
}

/* Circular overall progress (white center) */
function CircularProgress({ size = 120, strokeWidth = 10, percent = 0, color }) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const pct = clamp(Math.round(percent || 0), 0, 100);
  const strokeDashoffset = circumference - (circumference * pct) / 100;
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center", backgroundColor: "#fff", borderRadius: size / 2 }}>
      <Svg width={size} height={size}>
        <Circle fill="none" stroke="#EEF4FF" cx={size / 2} cy={size / 2} r={radius} strokeWidth={strokeWidth} />
        <Circle
          fill="none"
          stroke={color || percentColor(pct)}
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          rotation="-90"
          originX={size / 2}
          originY={size / 2}
          strokeDasharray={`${circumference} ${circumference}`}
          strokeDashoffset={strokeDashoffset}
        />
      </Svg>
      <Text style={{ position: "absolute", fontWeight: "800", fontSize: 20, color: color || percentColor(pct) }}>{pct !== null ? `${pct}%` : "-"}</Text>
    </View>
  );
}

/* Animated linear progress */
function LinearProgress({ percent = 0, height = 8, style }) {
  const widthAnim = useRef(new Animated.Value(0)).current;
  const pct = clamp(Math.round(percent || 0), 0, 100);
  const color = percentColor(pct);
  useEffect(() => { Animated.timing(widthAnim, { toValue: pct, duration: 450, useNativeDriver: false }).start(); }, [pct]);
  const w = widthAnim.interpolate({ inputRange: [0, 100], outputRange: ["0%", "100%"] });
  return (
    <View style={[{ backgroundColor: "#EEF4FF", height, borderRadius: 8, overflow: "hidden" }, style]}>
      <Animated.View style={{ width: w, height, backgroundColor: color }} />
    </View>
  );
}

/* Bottom sheet with main pan and handle pan (handle always captures to collapse when full) */
function DraggableBottomSheet({ visible, onClose, contentHeight = SCREEN_H * 0.85, innerScrollAtTopRef, onSnapChange, children }) {
  const sheetHeight = contentHeight;
  const fullY = 0;
  const halfY = sheetHeight * 0.5; // start at 50%
  const hiddenY = sheetHeight;

  const translateY = useRef(new Animated.Value(hiddenY)).current;
  const lastY = useRef(hiddenY);

  useEffect(() => {
    if (visible) { Animated.timing(translateY, { toValue: halfY, duration: 260, useNativeDriver: true }).start(); lastY.current = halfY; onSnapChange && onSnapChange('half'); }
    else { Animated.timing(translateY, { toValue: hiddenY, duration: 220, useNativeDriver: true }).start(); lastY.current = hiddenY; onSnapChange && onSnapChange('hidden'); }
  }, [visible]);

  // main pan captures when sheet isn't full
  const panResponder = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (_, gesture) => {
      const dy = Math.abs(gesture.dy);
      if (dy <= 4) return false;
      // only capture when sheet not full (so single-finger drag moves sheet until full)
      return lastY.current !== fullY;
    },
    onPanResponderGrant: () => { translateY.setOffset(lastY.current); translateY.setValue(0); },
    onPanResponderMove: (_, gesture) => { translateY.setValue(gesture.dy); },
    onPanResponderRelease: (_, gesture) => {
      translateY.flattenOffset();
      const vy = gesture.vy;
      const moved = lastY.current + gesture.dy;
      const snaps = [fullY, halfY, hiddenY];
      let nearest = snaps.reduce((a, b) => (Math.abs(b - moved) < Math.abs(a - moved) ? b : a), snaps[0]);
      if (vy < -0.5) nearest = fullY;
      if (vy > 0.6) nearest = hiddenY;
      Animated.spring(translateY, { toValue: nearest, useNativeDriver: true, bounciness: 6 }).start(() => {
        lastY.current = nearest;
        onSnapChange && onSnapChange(nearest === fullY ? 'full' : nearest === halfY ? 'half' : 'hidden');
        if (nearest >= sheetHeight * 0.95) onClose && onClose();
      });
    },
  })).current;

  // handle pan: always capture so user can collapse when sheet is full (one-finger)
  const handlePanResponder = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: () => { translateY.setOffset(lastY.current); translateY.setValue(0); },
    onPanResponderMove: (_, gesture) => { translateY.setValue(gesture.dy); },
    onPanResponderRelease: (_, gesture) => {
      translateY.flattenOffset();
      const vy = gesture.vy;
      const moved = lastY.current + gesture.dy;
      const snaps = [fullY, halfY, hiddenY];
      let nearest = snaps.reduce((a, b) => (Math.abs(b - moved) < Math.abs(a - moved) ? b : a), snaps[0]);
      if (vy < -0.5) nearest = fullY;
      if (vy > 0.6) nearest = hiddenY;
      Animated.spring(translateY, { toValue: nearest, useNativeDriver: true, bounciness: 6 }).start(() => {
        lastY.current = nearest;
        onSnapChange && onSnapChange(nearest === fullY ? 'full' : nearest === halfY ? 'half' : 'hidden');
        if (nearest >= sheetHeight * 0.95) onClose && onClose();
      });
    },
  })).current;

  if (!visible) return null;

  const handleToggle = () => {
    const target = lastY.current === fullY ? halfY : fullY;
    Animated.spring(translateY, { toValue: target, useNativeDriver: true, bounciness: 6 }).start(() => {
      lastY.current = target;
      onSnapChange && onSnapChange(target === fullY ? 'full' : 'half');
    });
  };

  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose}>
      <TouchableWithoutFeedback onPress={onClose}><View style={styles.sheetBackdrop} /></TouchableWithoutFeedback>

      <Animated.View style={[styles.sheetContainer, { height: sheetHeight, transform: [{ translateY }] }]} {...panResponder.panHandlers}>
        <View style={styles.handleRow}>
          <TouchableOpacity activeOpacity={0.9} onPress={handleToggle} style={styles.sheetHandleTouchable}>
            <View style={styles.sheetHandle} />
          </TouchableOpacity>
          {/* invisible view to expand handle touch area and attach pan handlers */}
          <View style={styles.handleDragZone} {...handlePanResponder.panHandlers} />
        </View>

        <View style={{ flex: 1 }}>{children}</View>
      </Animated.View>
    </Modal>
  );
}

/* main screen */
export default function ClassMarkScreen() {
  const [loading, setLoading] = useState(true);
  const [courses, setCourses] = useState([]);
  const [expanded, setExpanded] = useState({});
  const [marksMap, setMarksMap] = useState({});
  const [studentId, setStudentId] = useState(null);
  const [studentGrade, setStudentGrade] = useState(null);
  const [studentSection, setStudentSection] = useState(null);

  const [sheetVisible, setSheetVisible] = useState(false);
  const [sheetCourseKey, setSheetCourseKey] = useState(null);
  const [sheetCourseName, setSheetCourseName] = useState(null);
  const [selectedSemester, setSelectedSemester] = useState(null);
  const [teacherProfile, setTeacherProfile] = useState({ name: null, profileImage: null });

  const innerScrollAtTopRef = useRef(true);

  const loadStudent = useCallback(async () => {
    try {
      const sNode = (await AsyncStorage.getItem("studentNodeKey")) || (await AsyncStorage.getItem("studentId"));
      if (sNode) {
        const snap = await get(ref(database, `Students/${sNode}`));
        if (snap.exists()) {
          const s = snap.val();
          setStudentId(sNode); setStudentGrade(String(s.grade ?? "")); setStudentSection(String(s.section ?? ""));
          return { id: sNode, grade: String(s.grade ?? ""), section: String(s.section ?? "") };
        }
      }
      const userNode = await AsyncStorage.getItem("userNodeKey");
      if (userNode) {
        const uSnap = await get(ref(database, `Users/${userNode}`));
        if (uSnap.exists()) {
          const u = uSnap.val();
          if (u.studentId) {
            const sSnap = await get(ref(database, `Students/${u.studentId}`));
            if (sSnap.exists()) {
              const s = sSnap.val();
              setStudentId(u.studentId); setStudentGrade(String(s.grade ?? "")); setStudentSection(String(s.section ?? ""));
              return { id: u.studentId, grade: String(s.grade ?? ""), section: String(s.section ?? "") };
            }
          }
        }
      }
    } catch (e) { console.warn("loadStudent error", e); }
    return null;
  }, []);

  useEffect(() => {
    let mounted = true;
    (async () => {
      setLoading(true);
      const ctx = await loadStudent();
      if (!ctx) { if (mounted) setLoading(false); return; }
      const grade = ctx.grade, section = ctx.section, sid = ctx.id;

      try {
        const snap = await get(ref(database, "Courses"));
        const list = [];
        if (snap.exists()) {
          snap.forEach((child) => {
            const val = child.val(), key = child.key;
            if (String(val.grade ?? "") === String(grade) && String(val.section ?? "") === String(section)) {
              list.push({ key, data: val });
            }
          });
        }
        list.sort((a, b) => (a.data.name || "").localeCompare(b.data.name || ""));
        if (!mounted) return;
        setCourses(list);

        const marks = {};
        await Promise.all(list.map(async (c) => {
          try {
            const cm = await get(ref(database, `ClassMarks/${c.key}/${sid}`));
            marks[c.key] = cm.exists() ? cm.val() : null;
          } catch (err) { console.warn("classmark fetch", err); marks[c.key] = null; }
        }));
        if (!mounted) return;
        setMarksMap(marks);
      } catch (err) { console.warn(err); if (mounted) { setCourses([]); setMarksMap({}); } } finally { if (mounted) setLoading(false); }
    })();
    return () => { mounted = false; };
  }, [loadStudent]);

  const toggle = (k) => { LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut); setExpanded((p) => ({ ...p, [k]: !p[k] })); };

  const parseAssessments = (node) => {
    if (!node) return [];
    return Object.keys(node).map((k) => { const v = node[k] || {}; return { key: k, name: v.name || k, max: v.max != null ? Number(v.max) : null, score: v.score != null ? Number(v.score) : null }; });
  };

  const quarterTotals = (node) => {
    const arr = parseAssessments(node);
    let s = 0, m = 0;
    arr.forEach((a) => { if (a.score != null) s += a.score; if (a.max != null) m += a.max; });
    const percent = m > 0 ? (s / m) * 100 : null;
    return { s, m, percent, items: arr };
  };

  const courseOverall = (marks) => {
    if (!marks) return { s: 0, m: 0, percent: null };
    let s = 0, m = 0;
    Object.keys(marks).forEach((sem) => {
      const semNode = marks[sem] || {};
      Object.keys(semNode).forEach((qk) => {
        const q = semNode[qk] || {};
        const res = quarterTotals(q.assessments || q.assessment || {});
        s += Number(res.s || 0); m += Number(res.m || 0);
      });
    });
    return { s, m, percent: m > 0 ? (s / m) * 100 : null };
  };

  const fetchTeacherProfileForCourse = useCallback(async (courseId) => {
    try {
      const taSnap = await get(ref(database, "TeacherAssignments"));
      let foundTeacherId = null;
      if (taSnap.exists()) {
        taSnap.forEach((child) => {
          const val = child.val();
          if (val && val.courseId === courseId) foundTeacherId = val.teacherId || null;
        });
      }
      if (!foundTeacherId) return null;
      const tSnap = await get(ref(database, `Teachers/${foundTeacherId}`));
      if (!tSnap.exists()) return null;
      const tVal = tSnap.val(); const userId = tVal.userId; if (!userId) return null;
      const uSnap = await get(ref(database, `Users/${userId}`)); if (!uSnap.exists()) return null;
      const uVal = uSnap.val(); return { name: uVal.name || null, profileImage: uVal.profileImage || null };
    } catch (err) { console.warn("fetchTeacherProfileForCourse error:", err); return null; }
  }, []);

  const openSheet = async (courseKey, courseName) => {
    setSheetCourseKey(courseKey); setSheetCourseName(courseName || null);
    const marks = marksMap[courseKey] || {};
    const semKeys = Object.keys(marks || {});
    setSelectedSemester(semKeys.length > 0 ? semKeys[0] : null);
    const profile = await fetchTeacherProfileForCourse(courseKey);
    setTeacherProfile(profile || { name: null, profileImage: null });
    innerScrollAtTopRef.current = true;
    setSheetVisible(true);
  };

  const CourseTile = ({ item }) => {
    const courseKey = item.key; const data = item.data; const marks = marksMap[courseKey] || {};
    const overall = courseOverall(marks); const percent = overall.percent !== null ? Math.round(overall.percent) : null;
    const subjectText = (data.subject || data.name || "").toLowerCase(); const iconEntry = getSubjectIcon(subjectText);

    return (
      <View style={styles.cardWrapper}>
        <TouchableOpacity activeOpacity={0.95} style={styles.cardView} onPress={() => toggle(courseKey)}>
          <View style={styles.cardInner}>
            <View style={[styles.subjectImage, { backgroundColor: "#F6F9FF", alignItems: "center", justifyContent: "center" }]}>
              <MaterialCommunityIcons name={iconEntry.name} size={42} color={iconEntry.color} />
            </View>

            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={styles.subjectName}>{data.name || data.subject || courseKey}</Text>
              <Text style={styles.gradeSection}>Grade {data.grade || ""}{data.section ? ` • ${data.section}` : ""}</Text>

              <View style={{ marginTop: 10 }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                  <Text style={styles.smallMuted}>Progress</Text>
                  <Text style={[styles.percentText, { color: percentColor(percent) }]}>{percent !== null ? `${percent}%` : "–"}</Text>
                </View>
                <LinearProgress percent={percent || 0} style={{ marginTop: 8 }} />
              </View>
            </View>

            <TouchableOpacity style={styles.moreBtn} onPress={() => openSheet(courseKey, data.name || data.subject)}>
              <Ionicons name="chevron-forward" size={22} color={MUTED} />
            </TouchableOpacity>
          </View>

          {expanded[courseKey] && (
            <View style={styles.details}>
              {Object.keys(marks || {}).length === 0 ? <Text style={styles.noAssess}>No assessments yet</Text> : (
                Object.keys(marks || {}).map((semKey) => {
                  const semNode = marks[semKey] || {};
                  const qKeys = Object.keys(semNode || {}).filter((k) => /^q\d+/i.test(k));
                  const quarters = qKeys.length > 0 ? qKeys : Object.keys(semNode);
                  return (
                    <View key={semKey} style={{ marginTop: 8 }}>
                      <Text style={styles.semLabel}>{semKey.toUpperCase()}</Text>
                      {quarters.map((qk) => {
                        const q = semNode[qk] || {};
                        const res = quarterTotals(q.assessments || q.assessment || {});
                        return (
                          <View key={qk} style={styles.assessmentRow}>
                            <View style={{ flex: 1 }}>
                              <Text style={styles.assName}>{qk.toUpperCase()}</Text>
                              <Text style={styles.assMeta}>{humanNumber(res.s)} / {humanNumber(res.m)}</Text>
                            </View>
                            <View style={{ width: 140 }}>
                              <LinearProgress percent={res.percent || 0} />
                            </View>
                          </View>
                        );
                      })}
                    </View>
                  );
                })
              )}
            </View>
          )}
        </TouchableOpacity>
      </View>
    );
  };

  if (loading) return (<View style={styles.center}><ActivityIndicator size="large" color={PRIMARY} /></View>);

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={{ padding: 12, paddingBottom: 80 }}>
        <Text style={styles.title}>Class Marks</Text>
        <Text style={styles.subtitle}>Tap a card to expand quick details. Open details for a complete breakdown.</Text>

        <FlatList
          data={courses}
          keyExtractor={(i) => i.key}
          renderItem={CourseTile}
          ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
          contentContainerStyle={{ paddingTop: 12 }}
          scrollEnabled={false}
        />
      </ScrollView>

      <DraggableBottomSheet visible={sheetVisible} onClose={() => setSheetVisible(false)} contentHeight={SCREEN_H * 0.85} innerScrollAtTopRef={innerScrollAtTopRef}>
        <CourseSheetInner
          courseKey={sheetCourseKey}
          courseName={sheetCourseName}
          marks={marksMap[sheetCourseKey]}
          onClose={() => setSheetVisible(false)}
          selectedSemester={selectedSemester}
          setSelectedSemester={setSelectedSemester}
          teacherProfile={teacherProfile}
          innerScrollAtTopRef={innerScrollAtTopRef}
        />
      </DraggableBottomSheet>
    </View>
  );
}

/* CourseSheetInner: shows quarters for selected semester — quarter header uses linear progress */
function CourseSheetInner({ courseKey, courseName, marks = {}, onClose, selectedSemester, setSelectedSemester, teacherProfile, innerScrollAtTopRef }) {
  const [expandedQuarter, setExpandedQuarter] = useState({});

  useEffect(() => { setExpandedQuarter({}); }, [courseKey, selectedSemester]);

  const computeTotals = useCallback((marksObj) => {
    let s = 0, m = 0;
    Object.keys(marksObj || {}).forEach((sem) => {
      const semNode = marksObj[sem] || {};
      Object.keys(semNode).forEach((qk) => {
        const q = semNode[qk] || {};
        const arr = q.assessments || q.assessment || {};
        Object.keys(arr).forEach((k) => {
          const a = arr[k] || {};
          if (a.score != null) s += Number(a.score);
          if (a.max != null) m += Number(a.max);
        });
      });
    });
    return { s, m, percent: m > 0 ? (s / m) * 100 : null };
  }, []);

  const overall = computeTotals(marks);
  const semKeys = Object.keys(marks || {});
  const selSem = selectedSemester || (semKeys.length > 0 ? semKeys[0] : null);

  const getQuarterKeys = (semNode) => {
    if (!semNode) return [];
    const keys = Object.keys(semNode || {});
    const qkeys = keys.filter((k) => /^q\d+/i.test(k));
    if (qkeys.length > 0) return qkeys.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (semNode.assessments || semNode.assessment) return ["default"];
    return keys;
  };

  const onInnerScroll = (e) => { const y = e.nativeEvent.contentOffset.y; innerScrollAtTopRef.current = y <= 5; };

  const semNode = selSem ? (marks[selSem] || {}) : null;
  const quarterKeys = getQuarterKeys(semNode);

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 10 }}>
        <View style={styles.avatar}>
          {teacherProfile?.profileImage ? <Image source={{ uri: teacherProfile.profileImage }} style={{ width: 40, height: 40, borderRadius: 20 }} /> : <Ionicons name="person" size={24} color="#fff" />}
        </View>
        <View style={{ marginLeft: 10, flex: 1 }}>
          <Text style={{ fontWeight: "700" }}>{teacherProfile?.name || "Teacher"}</Text>
          <Text style={{ color: MUTED, marginTop: 4 }}>{courseName || ""}</Text>
        </View>
        <TouchableOpacity style={styles.semSelector} onPress={() => {
          if (!semKeys.length) return;
          const idx = semKeys.indexOf(selSem);
          const next = idx === -1 || idx === semKeys.length - 1 ? semKeys[0] : semKeys[idx + 1];
          setSelectedSemester(next); setExpandedQuarter({}); // reset expanded quarters
        }}>
          <Text style={{ color: PRIMARY, fontWeight: "700" }}>{selSem ? selSem.toUpperCase() : "SEM"}</Text>
        </TouchableOpacity>
      </View>

      <View style={{ alignItems: "center", marginBottom: 12 }}>
        <CircularProgress percent={overall.percent ?? 0} size={120} strokeWidth={10} color={percentColor(Math.round(overall.percent ?? 0))} />
        <Text style={{ color: MUTED, marginTop: 8 }}>Overall score</Text>
      </View>

      <View style={{ flex: 1, paddingHorizontal: 6 }}>
        <Text style={{ fontWeight: "700", marginBottom: 8 }}>{selSem ? `${selSem.toUpperCase()} - Quarters` : "Quarters"}</Text>

        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 24 }} nestedScrollEnabled onScroll={onInnerScroll} scrollEventThrottle={16}>
          {selSem ? (
            quarterKeys.length === 0 ? <Text style={{ color: MUTED }}>No quarter data</Text> : quarterKeys.map((qk) => {
              const qn = qk === "default" ? (semNode?.assessments || semNode?.assessment || {}) : (semNode[qk] || {});
              const arr = qk === "default" ? qn : (qn.assessments || qn.assessment || {});
              const items = Object.keys(arr || {}).map((k) => ({ key: k, ...arr[k] }));
              let s = 0, m = 0; items.forEach((it) => { if (it.score != null) s += Number(it.score); if (it.max != null) m += Number(it.max); });
              const pct = m > 0 ? (s / m) * 100 : null;
              const isExpanded = !!expandedQuarter[qk];

              return (
                <View key={qk} style={{ marginBottom: 12 }}>
                  <TouchableOpacity activeOpacity={0.95} onPress={() => setExpandedQuarter((p) => ({ ...p, [qk]: !p[qk] }))} style={styles.semCard}>
                    <View style={{ flexDirection: "row", alignItems: "center" }}>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontWeight: "800", fontSize: 15 }}>{qk === "default" ? "Assessments" : qk.toUpperCase()}</Text>
                        <Text style={{ color: MUTED, marginTop: 4 }}>{humanNumber(s)} / {humanNumber(m)}</Text>
                      </View>

                      <View style={{ width: 160, marginLeft: 12 }}>
                        <LinearProgress percent={pct || 0} height={10} />
                        <Text style={{ textAlign: "right", marginTop: 6, fontWeight: "700", color: percentColor(Math.round(pct ?? 0)) }}>{pct !== null ? `${Math.round(pct)}%` : "-"}</Text>
                      </View>

                      <Ionicons name={isExpanded ? "chevron-up" : "chevron-down"} size={20} color={MUTED} style={{ marginLeft: 8 }} />
                    </View>

                    {isExpanded && (
                      <View style={{ marginTop: 12 }}>
                        {items.length === 0 ? <Text style={{ color: MUTED }}>No assessments</Text> : items.map((it) => (
                          <View key={it.key} style={styles.assRow}>
                            <View style={{ flex: 1 }}>
                              <Text style={{ fontWeight: "600" }}>{it.name || it.key}</Text>
                              <Text style={{ color: MUTED, marginTop: 4 }}>Max: {it.max ?? "-"} • Score: {it.score ?? "-"}</Text>
                            </View>
                            <Text style={{ fontWeight: "700", color: percentColor((it.score && it.max) ? (it.score / it.max) * 100 : 0) }}>{it.score ?? "-"}</Text>
                          </View>
                        ))}
                      </View>
                    )}
                  </TouchableOpacity>
                </View>
              );
            })
          ) : <Text style={{ color: MUTED }}>No semester selected or no data</Text>}
        </ScrollView>
      </View>

      <View style={{ flexDirection: "row", justifyContent: "space-between", padding: 12 }}>
        <TouchableOpacity onPress={onClose} style={[styles.sheetBtn, { backgroundColor: "#F1F3F8" }]}>
          <Text style={{ fontWeight: "700" }}>Close</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => { Alert.alert("Request Help", "Teacher notified (placeholder)."); }} style={[styles.sheetBtn, { backgroundColor: PRIMARY }]}>
          <Text style={{ fontWeight: "700", color: "#fff" }}>Ask Teacher</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

/* styles */
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  title: { fontSize: 22, fontWeight: "700", color: "#111", padding: 12 },
  subtitle: { color: MUTED, paddingHorizontal: 12 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },

  cardWrapper: { marginBottom: 12 },
  cardView: { backgroundColor: "#fff", borderRadius: 16, borderWidth: 1, borderColor: CARD_BORDER, padding: 12, elevation: 2, shadowColor: "#000", shadowOpacity: 0.03, shadowRadius: 6 },
  cardInner: { flexDirection: "row", alignItems: "center" },
  subjectImage: { width: 80, height: 80, borderRadius: 10 },
  subjectName: { fontWeight: "700", fontSize: 16, color: "#111" },
  gradeSection: { color: MUTED, marginTop: 6 },
  smallMuted: { color: MUTED, fontSize: 12 },
  percentText: { fontWeight: "800" },
  moreBtn: { paddingHorizontal: 6 },

  details: { marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: "#F1F3F8" },
  semLabel: { fontWeight: "700", marginBottom: 8 },
  assessmentRow: { flexDirection: "row", alignItems: "center", marginBottom: 8 },
  assName: { fontWeight: "600" },
  assMeta: { color: MUTED, marginTop: 4 },
  noAssess: { color: MUTED, fontStyle: "italic" },

  sheetBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.36)" },
  sheetContainer: { position: "absolute", left: 0, right: 0, bottom: 0, backgroundColor: "#fff", borderTopLeftRadius: 14, borderTopRightRadius: 14, paddingTop: 6, paddingHorizontal: 12, elevation: 12 },
  handleRow: { flexDirection: "row", alignItems: "center", justifyContent: "center" },
  sheetHandleTouchable: { alignItems: "center", paddingVertical: 8, flex: 0 },
  sheetHandle: { width: 48, height: 6, borderRadius: 6, backgroundColor: "#E6E9F2" },
  handleDragZone: { position: "absolute", top: 0, left: 0, right: 0, height: 36 }, // captures drags on handle area

  semCard: { backgroundColor: "#fff", borderRadius: 12, padding: 12, borderWidth: 1, borderColor: "#F1F3F8", marginBottom: 10 },
  quarterBlock: { marginTop: 10, paddingTop: 8 },
  assRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 8, borderBottomColor: "#F1F3F8", borderBottomWidth: 1 },

  avatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: PRIMARY, alignItems: "center", justifyContent: "center" },
  semSelector: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, borderWidth: 1, borderColor: "#EEF4FF" },

  sheetQuarter: { marginBottom: 12 },
  sheetBtn: { flex: 1, paddingVertical: 12, alignItems: "center", borderRadius: 10, marginHorizontal: 6 },
});