// app/dashboard/exam.jsx
// ... (only updated portions shown in full file below)
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
import { getStudentLives } from "../lib/livesHelpers"; // new

const { width: SCREEN_W } = Dimensions.get("window");
const PRIMARY = "#0B72FF";
const GOLD = "#F2C94C";
const SILVER = "#C0C6CC";
const BRONZE = "#D08A3A";
const BG = "#FFFFFF";
const TEXT = "#0B2540";
const MUTED = "#6B78A8";
const CARD_W = Math.round(SCREEN_W * 0.76);
const STORY_AVATAR_SIZE = 64;

async function tryGet(paths) {
  for (const p of paths) {
    try {
      const snap = await get(ref(database, p));
      if (snap?.exists()) return snap;
    } catch {}
  }
  return null;
}

function normalizeGrade(g) {
  if (!g) return null;
  return String(g).trim().toLowerCase().replace(/^grade/i, "");
}

async function resolveSchoolKeyForPrefix(prefix) {
  const snap = await tryGet([`Platform1/schoolCodeIndex/${prefix}`, `schoolCodeIndex/${prefix}`]);
  return snap?.val?.() || null;
}
async function queryUserProfile(userId) {
  if (!userId) return {};
  try {
    const prefix = String(userId).slice(0, 3).toUpperCase();
    const schoolKey = await resolveSchoolKeyForPrefix(prefix);
    let profile = null;

    if (schoolKey) {
      try {
        const snap = await queryUserByUsernameInSchool(userId, schoolKey);
        if (snap?.exists()) {
          snap.forEach((c) => {
            profile = c.val();
            return true;
          });
        }
      } catch {}
    }
    if (!profile) {
      try {
        const snap = await queryUserByChildInSchool("username", userId, null);
        if (snap?.exists()) {
          snap.forEach((c) => {
            profile = c.val();
            return true;
          });
        }
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

  // NEW: global lives (POC read-only)
  const [studentLives, setStudentLives] = useState(null);

  const fetchAll = useCallback(async () => {
    const grade = normalizeGrade(await AsyncStorage.getItem("studentGrade"));
    setStudentGrade(grade || null);

    // load student id to fetch lives
    const sid =
      (await AsyncStorage.getItem("studentNodeKey")) ||
      (await AsyncStorage.getItem("studentId")) ||
      (await AsyncStorage.getItem("username")) ||
      null;

    if (sid) {
      try {
        const lives = await getStudentLives(sid);
        if (lives) setStudentLives(lives);
      } catch (e) {
        // ignore in POC
      }
    }

    await Promise.all([loadLeaders(grade), loadPackages(grade)]);
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      await fetchAll();
      setLoading(false);
    })();
  }, [fetchAll]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchAll();
    setRefreshing(false);
  }, [fetchAll]);

  const loadLeaders = useCallback(async (grade) => {
    try {
      const countrySnap = await tryGet([`Platform1/country`, `country`]);
      const country = countrySnap?.val?.() || "Ethiopia";
      const gradeKey = grade ? `grade${grade}` : "grade9";

      const snap = await tryGet([
        `Platform1/rankings/country/${country}/${gradeKey}/leaderboard`,
        `rankings/country/${country}/${gradeKey}/leaderboard`,
      ]);

      const raw = [];
      if (snap?.exists()) {
        snap.forEach((c) => {
          const v = c.val() || {};
          raw.push({ userId: c.key, rank: v.rank || 999 });
        });
      }
      raw.sort((a, b) => (a.rank || 999) - (b.rank || 999));
      const top = raw.slice(0, 5);

      const enriched = await Promise.all(
        top.map(async (entry) => {
          const u = await queryUserProfile(entry.userId);
          return { ...entry, profile: u.profile || null };
        })
      );
      setLeaders(enriched);
    } catch {
      setLeaders([]);
    }
  }, []);

  const loadPackages = useCallback(async (grade) => {
    try {
      const pkgSnap = await tryGet([
        `Platform1/companyExams/packages`,
        `companyExams/packages`,
      ]);

      if (!pkgSnap?.exists()) {
        setPackages([]);
        return;
      }

      const arr = [];
      pkgSnap.forEach((c) => {
        const v = c.val() || {};
        const pkgGrade = normalizeGrade(v.grade);
        if (grade && pkgGrade && pkgGrade !== String(grade)) return; // filter by student grade

        const subjectsNode = v.subjects || {};
        const subjectCount = Object.keys(subjectsNode).length;

        arr.push({
          id: c.key,
          name: v.name || c.key,
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
          subjectCount,
          active: v.active !== false,
        });
      });

      setPackages(arr.filter((p) => p.active));
    } catch (e) {
      console.warn("loadPackages error", e);
      setPackages([]);
    }
  }, []);

  const topSection = useMemo(
    () => (
      <View>
        {/* HEADER */}
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>Exams</Text>
            <Text style={styles.subtitle}>Compete nationally and improve your skills</Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            {/* Lives display (POC read-only) */}
            {studentLives ? (
              <View style={{ marginRight: 8, alignItems: "center" }}>
                <Text style={{ fontWeight: "800", color: PRIMARY }}>Lives</Text>
                <View style={{ flexDirection: "row", marginTop: 4 }}>
                  {Array.from({ length: Number(studentLives.maxLives || 5) }).map((_, i) => (
                    <Text key={i} style={{ marginLeft: 4, opacity: i < Number(studentLives.currentLives || 0) ? 1 : 0.25 }}>
                      ❤️
                    </Text>
                  ))}
                </View>
              </View>
            ) : null}
            <TouchableOpacity style={styles.leaderBtn} onPress={() => router.push("/exam/leaderboard")}>
              <Ionicons name="trophy" size={15} color="#fff" />
              <Text style={styles.leaderBtnText}>Leaderboard</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* SECTION 1: LEADERBOARD */}
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
                  {avatar ? (
                    <Image source={{ uri: avatar }} style={styles.avatar} />
                  ) : (
                    <View style={styles.avatarFallback}><Text style={styles.avatarLetter}>{(name || "U")[0]}</Text></View>
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

        {/* SECTION 2: PACKAGE CARDS */}
        <View style={styles.sectionHeader}><Text style={styles.sectionTitle}>Company Level Packages</Text></View>
        <FlatList
          data={packages}
          horizontal
          keyExtractor={(p) => p.id}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 14 }}
          ItemSeparatorComponent={() => <View style={{ width: 12 }} />}
          renderItem={({ item }) => {
            const icon =
              item.type === "competitive"
                ? "trophy-outline"
                : item.type === "practice"
                ? "book-open-page-variant-outline"
                : item.type === "entrance"
                ? "school-outline"
                : "star-outline";
            return (
              <TouchableOpacity
                style={styles.packageCard}
                activeOpacity={0.9}
                onPress={() =>
                  router.push({
                    pathname: "/packageSubjects",
                    params: { packageId: item.id, packageName: item.name, studentGrade: studentGrade || "" },
                  })
                }
              >
                <MaterialCommunityIcons name={icon} size={24} color={PRIMARY} />
                <Text style={styles.packageTitle}>{item.name}</Text>
                <Text style={styles.packageSubtitle}>{item.subtitle}</Text>
                <Text numberOfLines={2} style={styles.packageDesc}>{item.description}</Text>
                <Text style={styles.packageMeta}>{item.subjectCount || 0} subjects</Text>
              </TouchableOpacity>
            );
          }}
        />

        {/* SECTION 3: SCHOOL PLACEHOLDER */}
        <View style={styles.sectionHeader}><Text style={styles.sectionTitle}>School Level Exams</Text></View>
        <View style={styles.schoolCard}>
          <Text style={styles.schoolComing}>School activities coming soon</Text>
        </View>
      </View>
    ),
    [leaders, packages, router, studentGrade, studentLives]
  );

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

  header: {
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 8,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  title: { fontSize: 24, fontWeight: "900", color: TEXT },
  subtitle: { marginTop: 4, color: MUTED, fontSize: 13 },

  leaderBtn: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: PRIMARY,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
  },
  leaderBtnText: { color: "#fff", marginLeft: 6, fontWeight: "800", fontSize: 12 },

  sectionHeader: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 8 },
  sectionTitle: { fontSize: 18, fontWeight: "900", color: TEXT },

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
  firstGlow: {
    shadowColor: GOLD,
    shadowOpacity: 0.45,
    shadowRadius: 12,
    elevation: 7,
  },
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

  packageCard: {
    width: CARD_W,
    backgroundColor: "#fff",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#EAF0FF",
    padding: 14,
    shadowColor: "#000",
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 3,
  },
  packageTitle: { marginTop: 8, fontSize: 17, fontWeight: "900", color: TEXT },
  packageSubtitle: { marginTop: 4, fontSize: 12, color: PRIMARY, fontWeight: "700" },
  packageDesc: { marginTop: 6, color: MUTED, lineHeight: 18, fontSize: 12 },
  packageMeta: { marginTop: 10, color: TEXT, fontWeight: "800", fontSize: 12 },

  schoolCard: {
    marginHorizontal: 16,
    marginBottom: 24,
    backgroundColor: "#fff",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#EAF0FF",
    padding: 16,
    shadowColor: "#000",
    shadowOpacity: 0.04,
    shadowRadius: 8,
    elevation: 2,
  },
  schoolComing: { color: MUTED, fontWeight: "700" },
});