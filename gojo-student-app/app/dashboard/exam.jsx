import React, { useEffect, useMemo, useState, useCallback } from "react";
import {
  View, Text, StyleSheet, SafeAreaView, TouchableOpacity, FlatList, ActivityIndicator, Image, RefreshControl, Dimensions
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
const CARD_W = Math.round(SCREEN_W * 0.72);
const STORY_AVATAR_SIZE = 64;

function normalizeGrade(g) {
  if (!g) return null;
  const s = String(g).trim().toLowerCase();
  const matched = s.match(/(\d{1,2})/);
  if (matched) return String(matched[1]);
  return s.replace(/^grade\s*/i, "");
}

async function findStudentRecordUnderSchools(studentId) {
  if (!studentId) return null;
  try {
    const schoolsSnap = await getSnapshot([`Platform1/Schools`]);
    if (!schoolsSnap) return null;
    const schools = schoolsSnap.val() || {};
    for (const schoolKey of Object.keys(schools)) {
      try {
        const studentSnap = await get(ref(database, `Platform1/Schools/${schoolKey}/Students/${studentId}`));
        if (studentSnap && studentSnap.exists()) return { ...studentSnap.val(), _schoolKey: schoolKey };
      } catch {}
    }
  } catch {}
  return null;
}

async function resolveStudentGradeFromPlatform(studentId) {
  const rec = await findStudentRecordUnderSchools(studentId);
  if (rec) {
    const gradeRaw = rec?.basicStudentInformation?.grade ?? rec?.grade ?? rec?.basicStudentInformation?.academicGrade ?? null;
    const normalized = normalizeGrade(gradeRaw);
    if (normalized) return normalized;
  }
  try {
    const snap = await get(ref(database, `Platform1/Students/${studentId}`));
    if (snap?.exists()) {
      const val = snap.val() || {};
      const gradeRaw = val?.basicStudentInformation?.grade ?? val?.grade ?? null;
      const normalized = normalizeGrade(gradeRaw);
      if (normalized) return normalized;
    }
  } catch {}
  return null;
}

async function resolveUserProfile(userId) {
  if (!userId) return {};
  try {
    const prefix = String(userId).slice(0, 3).toUpperCase();
    const schoolsIndexSnap = await get(ref(database, `Platform1/schoolCodeIndex/${prefix}`));
    const schoolKey = schoolsIndexSnap?.val() || null;
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
  const [studentGrade, setStudentGrade] = useState(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    let gradeRaw = await AsyncStorage.getItem("studentGrade");
    let grade = normalizeGrade(gradeRaw);

    const sid =
      (await AsyncStorage.getItem("studentNodeKey")) ||
      (await AsyncStorage.getItem("studentId")) ||
      (await AsyncStorage.getItem("username")) ||
      null;

    if ((!grade || grade === "") && sid) {
      try {
        const derived = await resolveStudentGradeFromPlatform(sid);
        if (derived) {
          grade = derived;
          try { await AsyncStorage.setItem("studentGrade", `grade${derived}`); } catch {}
        }
      } catch {}
    }

    setStudentGrade(grade || null);
    await Promise.all([loadLeaders(grade), loadPackages(grade)]);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchAll();
    setRefreshing(false);
  }, [fetchAll]);

  const loadLeaders = useCallback(async (grade) => {
    try {
      const countrySnap = await getSnapshot([`Platform1/country`, `country`]);
      const country = (countrySnap?.val && countrySnap.val()) || "Ethiopia";
      const gradeKey = grade ? `grade${grade}` : "grade9";

      const snap = await getSnapshot([
        `Platform1/rankings/country/${country}/${gradeKey}/leaderboard`,
        `rankings/country/${country}/${gradeKey}/leaderboard`,
      ]);

      const raw = [];
      const val = snap?.val ? snap.val() : null;
      if (val) {
        Object.keys(val).forEach((key) => {
          const v = val[key] || {};
          raw.push({ userId: key, rank: v.rank || 999 });
        });
      }

      raw.sort((a, b) => (a.rank || 999) - (b.rank || 999));
      const top = raw.slice(0, 5);
      const enriched = await Promise.all(top.map(async (entry) => ({ ...entry, profile: (await resolveUserProfile(entry.userId)).profile || null })));
      setLeaders(enriched);
    } catch {
      setLeaders([]);
    }
  }, []);

  const loadPackages = useCallback(async (grade) => {
    try {
      const pkgSnapVal = await getValue([`Platform1/companyExams/packages`, `companyExams/packages`]);
      if (!pkgSnapVal) return setPackages([]);

      const arr = [];
      Object.keys(pkgSnapVal).forEach((key) => {
        const v = pkgSnapVal[key] || {};
        const pkgGrade = normalizeGrade(v.grade);
        if (grade && pkgGrade && pkgGrade !== String(grade)) return;

        arr.push({
          id: key,
          name: v.name || key,
          subtitle:
            v.type === "competitive" ? "National Challenge" :
            v.type === "practice" ? "Practice Pack" :
            v.type === "entrance" ? "Entrance Prep" : "Special Pack",
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

  const topSection = useMemo(() => (
    <View>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Exams</Text>
          <Text style={styles.subtitle}>Compete nationally and improve your skills</Text>
        </View>
        <TouchableOpacity style={styles.leaderBtn} onPress={() => router.push("../leaderboard")}>
          <Ionicons name="trophy" size={15} color="#fff" />
          <Text style={styles.leaderBtnText}>Leaderboard</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.sectionHeader}><Text style={styles.sectionTitle}>Top Students</Text></View>
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
                {avatar ? <Image source={{ uri: avatar }} style={styles.avatar} /> : <View style={styles.avatarFallback}><Text style={styles.avatarLetter}>{(name || "U")[0]}</Text></View>}
                {rank <= 3 ? <View style={[styles.trophyBadge, { backgroundColor: trophyColor }]}><Ionicons name="trophy" size={10} color="#fff" /></View> : null}
              </View>
              <Text style={styles.rank}>#{rank}</Text>
              <Text numberOfLines={1} style={styles.storyName}>{name}</Text>
            </View>
          );
        }}
      />

      <View style={styles.sectionHeader}><Text style={styles.sectionTitle}>Gojo Challenges</Text></View>
      <FlatList
        data={packages}
        horizontal
        keyExtractor={(p) => p.id}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 14 }}
        ItemSeparatorComponent={() => <View style={{ width: 12 }} />}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={styles.packageCard}
            activeOpacity={0.9}
            onPress={() => router.push({ pathname: "/packageSubjects", params: { packageId: item.id, packageName: item.name, studentGrade: studentGrade || "" } })}
          >
            {item.packageIcon ? (
              <Image source={{ uri: item.packageIcon }} style={styles.packageIconImage} />
            ) : (
              <View style={styles.packageIconFallback}>
                <MaterialCommunityIcons
                  name={item.type === "competitive" ? "trophy-outline" : item.type === "practice" ? "book-open-page-variant-outline" : "school-outline"}
                  size={22}
                  color={PRIMARY}
                />
              </View>
            )}
            <View style={{ flex: 1 }}>
              <Text style={styles.packageTitle}>{item.name}</Text>
              <Text style={styles.packageSubtitle}>{item.subtitle}</Text>
              <Text numberOfLines={2} style={styles.packageDesc}>{item.description}</Text>
              <Text style={styles.packageMeta}>{item.subjectCount || 0} subjects</Text>
            </View>
          </TouchableOpacity>
        )}
      />
    </View>
  ), [leaders, packages, router, studentGrade]);

  if (loading) return <SafeAreaView style={[styles.screen, styles.center]}><ActivityIndicator color={PRIMARY} /></SafeAreaView>;

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
  header: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 8, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  title: { fontSize: 24, fontWeight: "900", color: TEXT },
  subtitle: { marginTop: 4, color: MUTED, fontSize: 13 },
  leaderBtn: { flexDirection: "row", alignItems: "center", backgroundColor: PRIMARY, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12 },
  leaderBtnText: { color: "#fff", marginLeft: 6, fontWeight: "800", fontSize: 12 },
  sectionHeader: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 8 },
  sectionTitle: { fontSize: 18, fontWeight: "900", color: TEXT },
  storyWrap: { width: STORY_AVATAR_SIZE + 16, alignItems: "center" },
  avatarShadow: { width: STORY_AVATAR_SIZE, height: STORY_AVATAR_SIZE, borderRadius: STORY_AVATAR_SIZE / 2, shadowColor: "#000", shadowOpacity: 0.1, shadowRadius: 8, elevation: 4 },
  firstGlow: { shadowColor: GOLD, shadowOpacity: 0.45, shadowRadius: 12, elevation: 7 },
  avatar: { width: STORY_AVATAR_SIZE, height: STORY_AVATAR_SIZE, borderRadius: STORY_AVATAR_SIZE / 2 },
  avatarFallback: { width: STORY_AVATAR_SIZE, height: STORY_AVATAR_SIZE, borderRadius: STORY_AVATAR_SIZE / 2, backgroundColor: PRIMARY, alignItems: "center", justifyContent: "center" },
  avatarLetter: { color: "#fff", fontWeight: "900", fontSize: 20 },
  trophyBadge: { position: "absolute", top: -4, right: -4, width: 22, height: 22, borderRadius: 11, borderWidth: 1.4, borderColor: "#fff", alignItems: "center", justifyContent: "center" },
  rank: { marginTop: 6, color: PRIMARY, fontWeight: "900", fontSize: 12 },
  storyName: { marginTop: 2, width: STORY_AVATAR_SIZE + 8, textAlign: "center", fontSize: 11, color: TEXT },

  packageCard: {
    width: CARD_W,
    backgroundColor: "#fff",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#EAF0FF",
    padding: 12,
    flexDirection: "row",
    alignItems: "center",
    shadowColor: "#000",
    shadowOpacity: 0.04,
    shadowRadius: 8,
    elevation: 2,
  },
  packageIconImage: { width: 56, height: 56, borderRadius: 12, marginRight: 10, backgroundColor: "#F1F5FF" },
  packageIconFallback: { width: 56, height: 56, borderRadius: 12, marginRight: 10, alignItems: "center", justifyContent: "center", backgroundColor: "#EEF4FF" },
  packageTitle: { fontSize: 16, fontWeight: "900", color: TEXT },
  packageSubtitle: { marginTop: 2, fontSize: 12, color: PRIMARY, fontWeight: "700" },
  packageDesc: { marginTop: 4, color: MUTED, lineHeight: 17, fontSize: 12 },
  packageMeta: { marginTop: 6, color: TEXT, fontWeight: "800", fontSize: 12 },
});