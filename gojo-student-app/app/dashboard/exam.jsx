import React, { useEffect, useMemo, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  Image,
  RefreshControl,
  Dimensions,
} from "react-native";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { ref, get } from "firebase/database";
import { database } from "../../constants/firebaseConfig";
import { queryUserByUsernameInSchool, queryUserByChildInSchool } from "../lib/userHelpers";
import { getValue, getSnapshot } from "../lib/dbHelpers";

const { width: SCREEN_W } = Dimensions.get("window");

const PRIMARY = "#0B72FF";
const GOLD = "#F2C94C";
const SILVER = "#C0C6CC";
const BRONZE = "#D08A3A";
const BG = "#FFFFFF";
const TEXT = "#0B2540";
const MUTED = "#6B78A8";
const BORDER = "#EAF0FF";

const CARD_W = Math.round(SCREEN_W * 0.78);
const STORY_AVATAR_SIZE = 64;
const SUBJECT_CARD_W = Math.round(SCREEN_W * 0.46);

const SUBJECT_ICON_MAP = [
  { keys: ["english", "literature"], icon: "book-open-page-variant", color: "#6C5CE7" },
  { keys: ["math", "mathematics", "algebra", "geometry", "maths"], icon: "calculator-variant", color: "#00A8FF" },
  { keys: ["science", "general science", "biology", "chemistry", "physics"], icon: "flask", color: "#00B894" },
  { keys: ["environmental", "env"], icon: "leaf", color: "#00C897" },
  { keys: ["history", "social"], icon: "history", color: "#F39C12" },
  { keys: ["geography"], icon: "map", color: "#0984e3" },
  { keys: ["computer", "ict", "computing"], icon: "laptop", color: "#8e44ad" },
  { keys: ["physical", "pe", "sport"], icon: "run", color: "#e17055" },
  { keys: ["art"], icon: "palette", color: "#FF7675" },
];

function normalizeGrade(g) {
  if (!g) return null;
  const s = String(g).trim().toLowerCase();
  const matched = s.match(/(\d{1,2})/);
  if (matched) return String(matched[1]);
  return s.replace(/^grade\s*/i, "");
}

function normalizeSection(v) {
  return String(v || "").trim().toUpperCase() || null;
}

function getSubjectVisual(subjectName = "") {
  const lower = String(subjectName).toLowerCase();
  const match = SUBJECT_ICON_MAP.find((item) =>
    item.keys.some((key) => lower.includes(key))
  );
  return (
    match || {
      icon: "book-education-outline",
      color: PRIMARY,
    }
  );
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
      const sSnap = await get(ref(database, `Platform1/Schools/${schoolKey}/Students/${studentId}`));
      if (sSnap?.exists()) {
        try {
          await AsyncStorage.setItem("schoolKey", schoolKey);
        } catch {}
        return schoolKey;
      }
    }
  } catch {}

  return null;
}

async function resolveUserProfile(userId) {
  if (!userId) return {};
  try {
    const prefix = String(userId).slice(0, 3).toUpperCase();
    const codeSnap = await get(ref(database, `Platform1/schoolCodeIndex/${prefix}`));
    const schoolKey = codeSnap?.val() || null;
    let profile = null;

    if (schoolKey) {
      try {
        const snap = await queryUserByUsernameInSchool(userId, schoolKey);
        if (snap?.exists()) snap.forEach((c) => { profile = c.val(); return true; });
      } catch {}
    }

    if (!profile) {
      try {
        const snap = await queryUserByChildInSchool("username", userId, null);
        if (snap?.exists()) snap.forEach((c) => { profile = c.val(); return true; });
      } catch {}
    }

    if (!profile) {
      try {
        const rootUser = await get(ref(database, `Users/${userId}`));
        if (rootUser?.exists()) profile = rootUser.val();
      } catch {}
    }

    return { profile };
  } catch {
    return {};
  }
}

export default function ExamScreen() {
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [leaders, setLeaders] = useState([]);
  const [packages, setPackages] = useState([]);
  const [subjects, setSubjects] = useState([]);
  const [studentGrade, setStudentGrade] = useState(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const sid =
        (await AsyncStorage.getItem("studentNodeKey")) ||
        (await AsyncStorage.getItem("studentId")) ||
        (await AsyncStorage.getItem("username")) ||
        null;

      const grade = normalizeGrade(await AsyncStorage.getItem("studentGrade"));
      setStudentGrade(grade || null);

      const schoolKey = await resolveSchoolKeyFast(sid);

      await Promise.all([
        loadLeaders(grade),
        loadPackages(grade),
        loadSubjectsFast({ studentId: sid, schoolKey }),
      ]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchAll();
    setRefreshing(false);
  }, [fetchAll]);

  const loadLeaders = useCallback(async (grade) => {
    try {
      const countrySnap = await getSnapshot([`Platform1/country`, `country`]);
      const country = countrySnap?.val?.() || "Ethiopia";
      const gradeKey = grade ? `grade${grade}` : "grade9";

      const snap = await getSnapshot([
        `Platform1/rankings/country/${country}/${gradeKey}/leaderboard`,
        `rankings/country/${country}/${gradeKey}/leaderboard`,
      ]);

      const raw = [];
      const val = snap?.val ? snap.val() : null;
      if (val) {
        Object.keys(val).forEach((key) => raw.push({ userId: key, rank: val[key]?.rank || 999 }));
      }

      raw.sort((a, b) => (a.rank || 999) - (b.rank || 999));
      const top = raw.slice(0, 5);
      const enriched = await Promise.all(
        top.map(async (e) => ({ ...e, profile: (await resolveUserProfile(e.userId)).profile || null }))
      );
      setLeaders(enriched);
    } catch {
      setLeaders([]);
    }
  }, []);

  const loadPackages = useCallback(async (grade) => {
    try {
      const pkgVal = await getValue([`Platform1/companyExams/packages`, `companyExams/packages`]);
      if (!pkgVal) return setPackages([]);

      const arr = [];
      Object.keys(pkgVal).forEach((key) => {
        const v = pkgVal[key] || {};
        const pkgGrade = normalizeGrade(v.grade);
        if (grade && pkgGrade && pkgGrade !== String(grade)) return;

        arr.push({
          id: key,
          name: v.name || key,
          subtitle:
            v.type === "competitive"
              ? "National Challenge"
              : v.type === "practice"
              ? "Practice Pack"
              : v.type === "entrance"
              ? "Entrance Prep"
              : "Special Pack",
          description: v.description || "Explore package",
          type: v.type || "practice",
          packageIcon: v.packageIcon || "",
          subjectCount: Object.keys(v.subjects || {}).length,
          active: v.active !== false,
        });
      });

      setPackages(arr.filter((p) => p.active));
    } catch {
      setPackages([]);
    }
  }, []);

  const loadSubjectsFast = useCallback(async ({ studentId, schoolKey }) => {
    try {
      if (!studentId || !schoolKey) return setSubjects([]);

      let studentGradeValue = null;
      let studentSection = null;

      const studentSnap = await get(ref(database, `Platform1/Schools/${schoolKey}/Students/${studentId}`));
      if (studentSnap.exists()) {
        const sv = studentSnap.val() || {};
        studentGradeValue =
          normalizeGrade(
            sv?.basicStudentInformation?.grade ??
            sv?.grade ??
            null
          ) || null;

        studentSection =
          normalizeSection(
            sv?.basicStudentInformation?.section ??
            sv?.section ??
            ""
          ) || null;
      }

      if (!studentGradeValue || !studentSection) {
        setSubjects([]);
        return;
      }

      const gradeMgmtSnap = await get(
        ref(database, `Platform1/Schools/${schoolKey}/GradeManagement/grades/${studentGradeValue}`)
      );

      if (!gradeMgmtSnap.exists()) {
        setSubjects([]);
        return;
      }

      const gradeNode = gradeMgmtSnap.val() || {};
      const sectionNode = gradeNode?.sections?.[studentSection] || {};
      const sectionCoursesMap = sectionNode?.courses || {};
      const courseIds = Object.keys(sectionCoursesMap).filter((k) => !!sectionCoursesMap[k]);

      const teacherAssignments = gradeNode?.sectionSubjectTeachers?.[studentSection] || {};
      const assignmentByCourseId = {};

      Object.keys(teacherAssignments).forEach((subjectKey) => {
        const row = teacherAssignments[subjectKey] || {};
        if (row?.courseId) {
          assignmentByCourseId[row.courseId] = {
            subjectKey,
            ...row,
          };
        }
      });

      const baseSubjects = courseIds.map((courseId) => {
        const assignment = assignmentByCourseId[courseId] || {};
        return {
          courseId,
          subject: assignment.subject || courseId,
          name: assignment.subject || courseId,
          grade: studentGradeValue,
          section: studentSection,
          teacherId: assignment.teacherId || "",
          teacherName: assignment.teacherName || "",
        };
      });

      let assessmentsObj = {};
      const assessmentsSnap = await get(
        ref(database, `Platform1/Schools/${schoolKey}/SchoolExams/Assessments`)
      );
      if (assessmentsSnap.exists()) assessmentsObj = assessmentsSnap.val() || {};

      const countByCourse = {};
      Object.keys(assessmentsObj).forEach((aid) => {
        const item = assessmentsObj[aid] || {};
        const cid = item.courseId;
        if (!cid) return;
        if (item.status === "removed") return;
        countByCourse[cid] = (countByCourse[cid] || 0) + 1;
      });

      const out = baseSubjects.map((c) => ({
        ...c,
        assessmentCount: countByCourse[c.courseId] || 0,
      }));

      setSubjects(out);
    } catch {
      setSubjects([]);
    }
  }, []);

  const topSection = useMemo(() => (
    <View>
      <View style={styles.heroBlock}>
        <View style={styles.heroBadge}>
          <Ionicons name="sparkles-outline" size={14} color={PRIMARY} />
          <Text style={styles.heroBadgeText}>Learn • Practice • Compete</Text>
        </View>
        <Text style={styles.heroTitle}>Push your learning further</Text>
        <Text style={styles.heroText}>
          Join challenges, track assessments, and stay sharp with your current subjects.
        </Text>
      </View>

      <View style={styles.sectionHeaderRow}>
        <Text style={styles.sectionTitle}>Top Students</Text>
        <TouchableOpacity style={styles.sectionActionBtn} onPress={() => router.push("../leaderboard")}>
          <Ionicons name="podium-outline" size={15} color="#fff" />
          <Text style={styles.sectionActionBtnText}>Leaderboard</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={leaders}
        horizontal
        keyExtractor={(i) => i.userId}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 10 }}
        showsHorizontalScrollIndicator={false}
        ItemSeparatorComponent={() => <View style={{ width: 12 }} />}
        renderItem={({ item, index }) => {
          const rank = Number(item.rank || index + 1);
          const name = item.profile?.name || item.profile?.username || item.userId;
          const avatar = item.profile?.profileImage || null;
          const trophyColor = rank === 1 ? GOLD : rank === 2 ? SILVER : rank === 3 ? BRONZE : null;

          return (
            <View style={styles.storyWrap}>
              <View style={[styles.avatarShadow, rank === 1 ? styles.firstGlow : null]}>
                {avatar ? (
                  <Image source={{ uri: avatar }} style={styles.avatar} />
                ) : (
                  <View style={styles.avatarFallback}>
                    <Text style={styles.avatarLetter}>{(name || "U")[0]}</Text>
                  </View>
                )}
                {rank <= 3 ? (
                  <View style={[styles.trophyBadge, { backgroundColor: trophyColor }]}>
                    <Ionicons name="trophy" size={10} color="#fff" />
                  </View>
                ) : null}
              </View>
              <Text style={styles.rank}>#{rank}</Text>
              <Text numberOfLines={1} style={styles.storyName}>{name}</Text>
            </View>
          );
        }}
      />

      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Gojo Challenges</Text>
        <Text style={styles.sectionSubtitle}>Curated challenge packs with cleaner, faster access</Text>
      </View>

      {packages.length === 0 ? (
        <View style={styles.emptyAssessments}>
          <MaterialCommunityIcons name="trophy-outline" size={24} color={MUTED} />
          <Text style={styles.emptyAssessmentsText}>No challenge packages available right now.</Text>
        </View>
      ) : (
        <FlatList
          data={packages}
          horizontal
          keyExtractor={(p) => p.id}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 14 }}
          ItemSeparatorComponent={() => <View style={{ width: 12 }} />}
          renderItem={({ item }) => {
            const iconName =
              item.type === "competitive"
                ? "trophy-outline"
                : item.type === "practice"
                ? "book-open-page-variant-outline"
                : "school-outline";

            return (
              <TouchableOpacity
                style={styles.challengeCard}
                activeOpacity={0.92}
                onPress={() =>
                  router.push({
                    pathname: "/packageSubjects",
                    params: {
                      packageId: item.id,
                      packageName: item.name,
                      studentGrade: studentGrade || "",
                    },
                  })
                }
              >
                <View style={styles.challengeTop}>
                  {item.packageIcon ? (
                    <Image source={{ uri: item.packageIcon }} style={styles.challengeIconImage} />
                  ) : (
                    <View style={styles.challengeIconFallback}>
                      <MaterialCommunityIcons name={iconName} size={24} color={PRIMARY} />
                    </View>
                  )}

                  <View style={styles.challengePill}>
                    <Text style={styles.challengePillText}>{item.subtitle}</Text>
                  </View>
                </View>

                <Text numberOfLines={2} style={styles.challengeTitle}>{item.name}</Text>
                <Text numberOfLines={2} style={styles.challengeDesc}>{item.description}</Text>

                <View style={styles.challengeFooter}>
                  <View style={styles.challengeMetaBadge}>
                    <MaterialCommunityIcons name="shape-outline" size={13} color={PRIMARY} />
                    <Text style={styles.challengeMetaText}>{item.subjectCount || 0} subjects</Text>
                  </View>
                  <Ionicons name="arrow-forward" size={16} color={PRIMARY} />
                </View>
              </TouchableOpacity>
            );
          }}
        />
      )}

      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>School Assessments</Text>
        <Text style={styles.sectionSubtitle}>Subjects for your current grade and section</Text>
      </View>

      {subjects.length === 0 ? (
        <View style={styles.emptyAssessments}>
          <MaterialCommunityIcons name="clipboard-text-outline" size={24} color={MUTED} />
          <Text style={styles.emptyAssessmentsText}>No subjects found for this student.</Text>
        </View>
      ) : (
        <FlatList
          data={subjects}
          horizontal
          keyExtractor={(s) => s.courseId}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 20 }}
          ItemSeparatorComponent={() => <View style={{ width: 12 }} />}
          renderItem={({ item }) => {
            const visual = getSubjectVisual(item.subject);

            return (
              <TouchableOpacity
                style={styles.subjectOnlyCard}
                activeOpacity={0.92}
                onPress={() =>
                  router.push({
                    pathname: "/subjectAssessments",
                    params: {
                      courseId: item.courseId,
                      subject: item.subject,
                      grade: item.grade,
                      section: item.section,
                    },
                  })
                }
              >
                <View style={styles.subjectOnlyTop}>
                  <View style={[styles.subjectIconWrap, { backgroundColor: `${visual.color}14` }]}>
                    <MaterialCommunityIcons name={visual.icon} size={20} color={visual.color} />
                  </View>

                  <View style={[
                    styles.countBadge,
                    item.assessmentCount > 0 && styles.countBadgeActive
                  ]}>
                    <Text style={[
                      styles.countBadgeText,
                      item.assessmentCount > 0 && styles.countBadgeTextActive
                    ]}>
                      {item.assessmentCount}
                    </Text>
                  </View>
                </View>

                <Text numberOfLines={1} style={styles.subjectOnlyTitle}>{item.subject}</Text>
                <Text numberOfLines={1} style={styles.subjectOnlyMeta}>
                  Grade {item.grade || "--"} • Section {item.section || "--"}
                </Text>

                <View style={styles.subjectFooterRow}>
                  <Text style={styles.subjectCountLabel}>
                    {item.assessmentCount > 0
                      ? `${item.assessmentCount} assessment${item.assessmentCount === 1 ? "" : "s"}`
                      : "No assessments yet"}
                  </Text>
                  <Ionicons name="chevron-forward" size={14} color={PRIMARY} />
                </View>
              </TouchableOpacity>
            );
          }}
        />
      )}
    </View>
  ), [leaders, packages, subjects, router, studentGrade]);

  if (loading) {
    return (
      <SafeAreaView style={[styles.screen, styles.center]}>
        <ActivityIndicator color={PRIMARY} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen}>
      <FlatList
        data={[]}
        renderItem={null}
        ListHeaderComponent={topSection}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={PRIMARY} />}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: BG },
  center: { alignItems: "center", justifyContent: "center" },

  heroBlock: {
    marginHorizontal: 16,
    marginTop: 14,
    marginBottom: 6,
    padding: 16,
    borderRadius: 20,
    backgroundColor: "#F7FAFF",
    borderWidth: 1,
    borderColor: "#E7F0FF",
  },
  heroBadge: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#EEF4FF",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  heroBadgeText: {
    marginLeft: 6,
    color: PRIMARY,
    fontSize: 12,
    fontWeight: "800",
  },
  heroTitle: {
    marginTop: 12,
    fontSize: 22,
    fontWeight: "900",
    color: TEXT,
  },
  heroText: {
    marginTop: 6,
    color: MUTED,
    lineHeight: 20,
    fontSize: 13,
  },

  sectionHeader: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 8 },
  sectionHeaderRow: {
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sectionTitle: { fontSize: 18, fontWeight: "900", color: TEXT },
  sectionSubtitle: { marginTop: 2, fontSize: 12, color: MUTED },

  sectionActionBtn: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: PRIMARY,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
  },
  sectionActionBtnText: {
    color: "#fff",
    marginLeft: 6,
    fontWeight: "800",
    fontSize: 12,
  },

  storyWrap: { width: STORY_AVATAR_SIZE + 16, alignItems: "center" },
  avatarShadow: {
    width: STORY_AVATAR_SIZE,
    height: STORY_AVATAR_SIZE,
    borderRadius: STORY_AVATAR_SIZE / 2,
    shadowColor: "#000",
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 4,
  },
  firstGlow: { shadowColor: GOLD, shadowOpacity: 0.45, shadowRadius: 12, elevation: 7 },
  avatar: { width: STORY_AVATAR_SIZE, height: STORY_AVATAR_SIZE, borderRadius: STORY_AVATAR_SIZE / 2 },
  avatarFallback: {
    width: STORY_AVATAR_SIZE,
    height: STORY_AVATAR_SIZE,
    borderRadius: STORY_AVATAR_SIZE / 2,
    backgroundColor: PRIMARY,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarLetter: { color: "#fff", fontWeight: "900", fontSize: 20 },
  trophyBadge: {
    position: "absolute",
    top: -4,
    right: -4,
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.4,
    borderColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  rank: { marginTop: 6, color: PRIMARY, fontWeight: "900", fontSize: 12 },
  storyName: { marginTop: 2, width: STORY_AVATAR_SIZE + 8, textAlign: "center", fontSize: 11, color: TEXT },

  challengeCard: {
    width: CARD_W,
    backgroundColor: "#fff",
    borderRadius: 20,
    borderWidth: 1,
    borderColor: BORDER,
    padding: 14,
    shadowColor: "#000",
    shadowOpacity: 0.05,
    shadowRadius: 10,
    elevation: 3,
  },
  challengeTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  challengeIconImage: {
    width: 58,
    height: 58,
    borderRadius: 14,
    backgroundColor: "#F1F5FF",
  },
  challengeIconFallback: {
    width: 58,
    height: 58,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#EEF4FF",
  },
  challengePill: {
    backgroundColor: "#F7FAFF",
    borderWidth: 1,
    borderColor: BORDER,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    marginLeft: 10,
    flexShrink: 1,
  },
  challengePillText: {
    color: PRIMARY,
    fontSize: 11,
    fontWeight: "800",
  },
  challengeTitle: {
    marginTop: 14,
    fontSize: 17,
    fontWeight: "900",
    color: TEXT,
  },
  challengeDesc: {
    marginTop: 6,
    fontSize: 12,
    lineHeight: 18,
    color: MUTED,
  },
  challengeFooter: {
    marginTop: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  challengeMetaBadge: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#EEF4FF",
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 999,
  },
  challengeMetaText: {
    marginLeft: 6,
    color: PRIMARY,
    fontSize: 11,
    fontWeight: "800",
  },

  emptyAssessments: {
    marginHorizontal: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: BORDER,
    backgroundColor: "#F9FBFF",
    borderRadius: 14,
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  emptyAssessmentsText: { color: MUTED, fontSize: 13, fontWeight: "600" },

  subjectOnlyCard: {
    width: SUBJECT_CARD_W,
    backgroundColor: "#fff",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: BORDER,
    padding: 14,
    shadowColor: "#000",
    shadowOpacity: 0.04,
    shadowRadius: 8,
    elevation: 2,
  },
  subjectOnlyTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  subjectIconWrap: {
    width: 38,
    height: 38,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  countBadge: {
    backgroundColor: "#F4F6FA",
    borderRadius: 12,
    minWidth: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 7,
  },
  countBadgeActive: {
    backgroundColor: "#EEF4FF",
  },
  countBadgeText: { color: MUTED, fontSize: 11, fontWeight: "800" },
  countBadgeTextActive: { color: PRIMARY },

  subjectOnlyTitle: { fontSize: 15, fontWeight: "900", color: TEXT },
  subjectOnlyMeta: { marginTop: 4, fontSize: 11, color: MUTED, fontWeight: "600" },
  subjectFooterRow: {
    marginTop: 14,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  subjectCountLabel: { fontSize: 11, color: PRIMARY, fontWeight: "800" },
});