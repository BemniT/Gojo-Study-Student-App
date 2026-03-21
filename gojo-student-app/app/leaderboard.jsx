import React, { useEffect, useMemo, useState, useCallback, useRef } from "react";
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
  TextInput,
  Platform,
  StatusBar,
  Modal,
  Animated,
  Easing,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { ref, get } from "firebase/database";
import { database } from "../constants/firebaseConfig";
import { getSnapshot } from "./lib/dbHelpers";
import { queryUserByUsernameInSchool, queryUserByChildInSchool } from "./lib/userHelpers";

const C = {
  primary: "#0B72FF",
  text: "#0B2540",
  muted: "#6B78A8",
  bg: "#FFFFFF",
  border: "#EAF0FF",
  gold: "#F2C94C",
  silver: "#C0C6CC",
  bronze: "#D08A3A",
};

function normalizeGrade(g) {
  if (!g) return null;
  const s = String(g).trim().toLowerCase();
  const m = s.match(/(\d{1,2})/);
  return m ? String(m[1]) : s.replace(/^grade\s*/i, "");
}

function yearsFromDob(dob) {
  if (!dob) return "";
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age >= 0 ? String(age) : "";
}

async function resolveUserProfile(userId) {
  if (!userId) return { profile: null, schoolCode: null };
  try {
    const prefix = String(userId).slice(0, 3).toUpperCase();
    const idx = await get(ref(database, `Platform1/schoolCodeIndex/${prefix}`));
    const schoolCode = idx?.val() || null;
    let profile = null;

    if (schoolCode) {
      try {
        const snap = await queryUserByUsernameInSchool(userId, schoolCode);
        if (snap?.exists()) snap.forEach((c) => { profile = c.val(); return true; });
      } catch {}
    }

    if (!profile) {
      try {
        const snap = await queryUserByChildInSchool("username", userId, null);
        if (snap?.exists()) snap.forEach((c) => { profile = c.val(); return true; });
      } catch {}
    }

    return { profile, schoolCode };
  } catch {
    return { profile: null, schoolCode: null };
  }
}

async function resolveStudentAndSchoolDetails(userId, fallbackSchoolCode) {
  try {
    const schoolCode = fallbackSchoolCode || null;
    if (!schoolCode) return { student: null, schoolInfo: null };

    const usersSnap = await get(ref(database, `Platform1/Schools/${schoolCode}/Users/${userId}`));
    const user = usersSnap?.exists() ? usersSnap.val() : null;
    const studentId = user?.studentId || null;

    let student = null;
    if (studentId) {
      const st = await get(ref(database, `Platform1/Schools/${schoolCode}/Students/${studentId}`));
      if (st?.exists()) student = st.val();
    }

    const schoolInfoSnap = await get(ref(database, `Platform1/Schools/${schoolCode}/schoolInfo`));
    const schoolInfo = schoolInfoSnap?.exists() ? schoolInfoSnap.val() : null;

    return { student, schoolInfo };
  } catch {
    return { student: null, schoolInfo: null };
  }
}
function PodiumItem({ item, place, rankColor, animatedStyle }) {
  const isFirst = place === 1;
  const medalColor = rankColor(place);

  if (!item) {
    return (
      <Animated.View style={[styles.podiumCol, isFirst ? styles.podiumCenter : null, animatedStyle]}>
        <View
          style={[
            styles.podiumAvatarWrap,
            isFirst ? styles.podiumAvatarWrapFirst : null,
            styles.emptyPodiumAvatarWrap,
            { borderColor: medalColor },
          ]}
        >
          <Ionicons name="person-outline" size={isFirst ? 28 : 24} color={medalColor} />
          <View style={[styles.medalBadge, { backgroundColor: medalColor }]}>
            <Text style={styles.medalText}>{place}</Text>
          </View>
        </View>

        <Text numberOfLines={1} style={styles.podiumNameEmpty}>
          Open Spot
        </Text>
        <Text style={styles.podiumPtsEmpty}>Not taken yet</Text>

        <View
          style={[
            styles.podiumBlock,
            isFirst ? styles.podiumBlockFirst : styles.podiumBlockSide,
            { backgroundColor: `${medalColor}22` },
          ]}
        >
          <Text style={[styles.podiumBlockText, { color: medalColor }]}>#{place}</Text>
        </View>
      </Animated.View>
    );
  }

  return (
    <Animated.View style={[styles.podiumCol, isFirst ? styles.podiumCenter : null, animatedStyle]}>
      <View
        style={[
          styles.podiumAvatarWrap,
          isFirst ? styles.podiumAvatarWrapFirst : null,
          { borderColor: medalColor },
        ]}
      >
        {item.avatar ? (
          <Image source={{ uri: item.avatar }} style={styles.podiumAvatar} />
        ) : (
          <View style={styles.podiumAvatarFallback}>
            <Text style={styles.initial}>{(item.name || "U")[0]}</Text>
          </View>
        )}
        <View style={[styles.medalBadge, { backgroundColor: medalColor }]}>
          <Text style={styles.medalText}>{place}</Text>
        </View>
      </View>

      <Text numberOfLines={1} style={styles.podiumName}>{item.name}</Text>
      <Text style={styles.podiumPts}>{item.totalPoints} pts</Text>

      <View
        style={[
          styles.podiumBlock,
          isFirst ? styles.podiumBlockFirst : styles.podiumBlockSide,
          { backgroundColor: `${medalColor}33` },
        ]}
      >
        <Text style={[styles.podiumBlockText, { color: medalColor }]}>#{place}</Text>
      </View>
    </Animated.View>
  );
}
export default function LeaderboardScreen() {
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [country, setCountry] = useState("Ethiopia");
  const [schoolCode, setSchoolCode] = useState(null);
  const [grade, setGrade] = useState("7");
  const [scope, setScope] = useState("country");

  const [countryRows, setCountryRows] = useState([]);
  const [schoolRows, setSchoolRows] = useState([]);

  const [myUserId, setMyUserId] = useState(null);
  const [search, setSearch] = useState("");

  const [profileModalVisible, setProfileModalVisible] = useState(false);
  const [profileLoading, setProfileLoading] = useState(false);
  const [selectedProfile, setSelectedProfile] = useState(null);

  const safeTop = Platform.OS === "android" ? (StatusBar.currentHeight || 0) : 0;

  const firstAnim = useRef(new Animated.Value(0)).current;
  const secondAnim = useRef(new Animated.Value(0)).current;
  const thirdAnim = useRef(new Animated.Value(0)).current;

  const enrichRows = useCallback(async (valObj) => {
    const base = Object.keys(valObj || {}).map((uid) => ({
      userId: uid,
      rank: Number(valObj[uid]?.rank || 9999),
      totalPoints: Number(valObj[uid]?.totalPoints || 0),
    }));
    base.sort((a, b) => a.rank - b.rank);

    return Promise.all(
      base.map(async (r) => {
        const { profile, schoolCode: resolvedSchool } = await resolveUserProfile(r.userId);
        return {
          ...r,
          name: profile?.name || profile?.username || r.userId,
          avatar: profile?.profileImage || null,
          schoolCode: resolvedSchool || null,
        };
      })
    );
  }, []);

  const load = useCallback(async () => {
    setLoading(true);

    const sid =
      (await AsyncStorage.getItem("studentNodeKey")) ||
      (await AsyncStorage.getItem("studentId")) ||
      (await AsyncStorage.getItem("username")) ||
      null;
    setMyUserId(sid);

    const gradeRaw = await AsyncStorage.getItem("studentGrade");
    const g = normalizeGrade(gradeRaw) || "7";
    setGrade(g);

    const countrySnap = await getSnapshot([`Platform1/country`, `country`]);
    const c = (countrySnap?.val && countrySnap.val()) || "Ethiopia";
    setCountry(c);

    let mySchool = null;
    if (sid) {
      try {
        const pref = String(sid).slice(0, 3).toUpperCase();
        const idx = await get(ref(database, `Platform1/schoolCodeIndex/${pref}`));
        mySchool = idx?.val() || null;
      } catch {}
    }
    setSchoolCode(mySchool);

    const gradeKey = `grade${g}`;
    const countryPath = `Platform1/rankings/country/${c}/${gradeKey}/leaderboard`;
    const schoolPath = mySchool ? `Platform1/rankings/schools/${mySchool}/${gradeKey}/leaderboard` : null;

    const countrySnapLb = await getSnapshot([countryPath]);
    const countryVal = countrySnapLb?.val ? countrySnapLb.val() : null;
    const enrichedCountry = countryVal ? await enrichRows(countryVal) : [];
    setCountryRows(enrichedCountry);

    if (schoolPath) {
      const schoolSnapLb = await getSnapshot([schoolPath]);
      const schoolVal = schoolSnapLb?.val ? schoolSnapLb.val() : null;
      const enrichedSchool = schoolVal ? await enrichRows(schoolVal) : [];
      setSchoolRows(enrichedSchool);
    } else {
      setSchoolRows([]);
    }

    setLoading(false);
  }, [enrichRows]);

  useEffect(() => { load(); }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const rows = useMemo(
    () => (scope === "school" ? schoolRows : countryRows),
    [scope, schoolRows, countryRows]
  );

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      String(r.name || "").toLowerCase().includes(q) ||
      String(r.userId || "").toLowerCase().includes(q)
    );
  }, [rows, search]);

  const top3 = useMemo(() => rows.filter((r) => r.rank <= 3).sort((a, b) => a.rank - b.rank), [rows]);
  const myRow = useMemo(() => rows.find((r) => r.userId === myUserId) || null, [rows, myUserId]);

  const podium = useMemo(() => {
    const first = top3.find((x) => x.rank === 1) || null;
    const second = top3.find((x) => x.rank === 2) || null;
    const third = top3.find((x) => x.rank === 3) || null;
    return { first, second, third };
  }, [top3]);

  const hasPodium = !!(podium.first || podium.second || podium.third);

  useEffect(() => {
    firstAnim.setValue(0);
    secondAnim.setValue(0);
    thirdAnim.setValue(0);

    if (!hasPodium) return;

    Animated.stagger(120, [
      Animated.timing(secondAnim, {
        toValue: 1,
        duration: 500,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(firstAnim, {
        toValue: 1,
        duration: 580,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(thirdAnim, {
        toValue: 1,
        duration: 500,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, [hasPodium, firstAnim, secondAnim, thirdAnim, scope]);

  const firstAnimatedStyle = {
    opacity: firstAnim,
    transform: [
      {
        translateY: firstAnim.interpolate({
          inputRange: [0, 1],
          outputRange: [44, 0],
        }),
      },
      {
        scale: firstAnim.interpolate({
          inputRange: [0, 1],
          outputRange: [0.94, 1],
        }),
      },
    ],
  };

  const secondAnimatedStyle = {
    opacity: secondAnim,
    transform: [
      {
        translateY: secondAnim.interpolate({
          inputRange: [0, 1],
          outputRange: [34, 0],
        }),
      },
      {
        scale: secondAnim.interpolate({
          inputRange: [0, 1],
          outputRange: [0.95, 1],
        }),
      },
    ],
  };

  const thirdAnimatedStyle = {
    opacity: thirdAnim,
    transform: [
      {
        translateY: thirdAnim.interpolate({
          inputRange: [0, 1],
          outputRange: [34, 0],
        }),
      },
      {
        scale: thirdAnim.interpolate({
          inputRange: [0, 1],
          outputRange: [0.95, 1],
        }),
      },
    ],
  };

  const rankColor = (rank) =>
    rank === 1 ? C.gold : rank === 2 ? C.silver : rank === 3 ? C.bronze : C.primary;

  const openStudentProfile = async (item) => {
    setProfileModalVisible(true);
    setProfileLoading(true);
    setSelectedProfile(null);

    const { student, schoolInfo } = await resolveStudentAndSchoolDetails(item.userId, item.schoolCode);

    const gender = student?.basicStudentInformation?.gender || student?.gender || "";
    const dob = student?.basicStudentInformation?.dob || student?.dob || "";
    const age = yearsFromDob(dob);

    const city =
      student?.addressInformation?.city ||
      schoolInfo?.city ||
      schoolInfo?.address?.city ||
      "";

    const region =
      student?.addressInformation?.region ||
      schoolInfo?.region ||
      schoolInfo?.address?.region ||
      "";

    setSelectedProfile({
      name: item.name,
      rank: item.rank,
      points: item.totalPoints,
      avatar: item.avatar,
      gender,
      age,
      schoolName: schoolInfo?.name || "",
      schoolCode: item.schoolCode || "",
      city,
      region,
    });
    setProfileLoading(false);
  };

  if (loading) {
    return (
      <SafeAreaView style={[styles.screen, { paddingTop: safeTop }]}>
        <StatusBar barStyle="dark-content" backgroundColor={C.bg} />
        <View style={styles.center}>
          <ActivityIndicator color={C.primary} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.screen, { paddingTop: safeTop }]}>
      <StatusBar barStyle="dark-content" backgroundColor={C.bg} />

      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color={C.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Leaderboard</Text>
          <Text style={styles.sub}>
            {scope === "country"
              ? `${country} • Grade ${grade}`
              : `${schoolCode || "My School"} • Grade ${grade}`}
          </Text>
        </View>
      </View>

      <View style={styles.toggleWrap}>
        <TouchableOpacity
          onPress={() => setScope("country")}
          style={[styles.toggleBtn, scope === "country" ? styles.toggleOn : styles.toggleOff]}
        >
          <Text style={scope === "country" ? styles.toggleTextOn : styles.toggleTextOff}>
            Country
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => setScope("school")}
          style={[styles.toggleBtn, scope === "school" ? styles.toggleOn : styles.toggleOff]}
          disabled={!schoolCode}
        >
          <Text style={scope === "school" ? styles.toggleTextOn : styles.toggleTextOff}>
            School
          </Text>
        </TouchableOpacity>
      </View>

      <View style={styles.searchWrap}>
        <Ionicons name="search-outline" size={18} color={C.muted} />
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search student by name or ID"
          placeholderTextColor="#9CA7CF"
          style={styles.searchInput}
        />
      </View>

      {myRow ? (
        <View style={styles.meCard}>
          <Text style={styles.meText}>Your Rank</Text>
          <Text style={styles.meRank}>#{myRow.rank}</Text>
          <Text style={styles.mePts}>{myRow.totalPoints} pts</Text>
        </View>
      ) : null}

      {hasPodium ? (
        <View style={styles.podiumWrap}>
          <PodiumItem item={podium.second} place={2} rankColor={rankColor} animatedStyle={secondAnimatedStyle} />
          <PodiumItem item={podium.first} place={1} rankColor={rankColor} animatedStyle={firstAnimatedStyle} />
          <PodiumItem item={podium.third} place={3} rankColor={rankColor} animatedStyle={thirdAnimatedStyle} />
        </View>
      ) : null}

      <FlatList
        data={filteredRows}
        keyExtractor={(i) => i.userId}
        contentContainerStyle={{ padding: 16, paddingBottom: 26 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.primary} />}
        ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
        ListEmptyComponent={
          <View style={styles.emptyWrap}>
            <Text style={styles.emptyText}>No students found.</Text>
          </View>
        }
        renderItem={({ item }) => (
          <TouchableOpacity activeOpacity={0.9} onPress={() => openStudentProfile(item)}>
            <View style={[styles.row, item.userId === myUserId ? styles.myRow : null]}>
              <Text style={[styles.rank, { color: rankColor(item.rank) }]}>#{item.rank}</Text>
              {item.avatar ? (
                <Image source={{ uri: item.avatar }} style={styles.avatar} />
              ) : (
                <View style={styles.avatarFallback}>
                  <Text style={styles.initial}>{(item.name || "U")[0]}</Text>
                </View>
              )}
              <View style={{ flex: 1, marginLeft: 10 }}>
                <Text numberOfLines={1} style={styles.name}>{item.name}</Text>
                <Text style={styles.points}>{item.totalPoints} points</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={C.muted} />
            </View>
          </TouchableOpacity>
        )}
      />

      <Modal
        visible={profileModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setProfileModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            {profileLoading ? (
              <ActivityIndicator color={C.primary} />
            ) : (
              <>
                <View style={styles.profileHero}>
                  {selectedProfile?.avatar ? (
                    <Image source={{ uri: selectedProfile.avatar }} style={styles.modalAvatar} />
                  ) : (
                    <View style={[styles.modalAvatar, styles.avatarFallback]}>
                      <Text style={styles.initial}>{(selectedProfile?.name || "U")[0]}</Text>
                    </View>
                  )}

                  <Text style={styles.modalName}>{selectedProfile?.name || "-"}</Text>
                  <View style={styles.modalRankBadge}>
                    <Text style={styles.modalRank}>#{selectedProfile?.rank || "-"} • {selectedProfile?.points || 0} pts</Text>
                  </View>
                </View>

                <View style={styles.infoGrid}>
                  <InfoRow label="Age" value={selectedProfile?.age || "-"} />
                  <InfoRow label="Gender" value={selectedProfile?.gender || "-"} />
                  <InfoRow label="School" value={selectedProfile?.schoolName || "-"} />
                  <InfoRow label="School Code" value={selectedProfile?.schoolCode || "-"} />
                  <InfoRow label="Region" value={selectedProfile?.region || "-"} />
                  <InfoRow label="City" value={selectedProfile?.city || "-"} />
                </View>

                <TouchableOpacity style={styles.closeBtn} onPress={() => setProfileModalVisible(false)}>
                  <Text style={styles.closeBtnText}>Close</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function InfoRow({ label, value }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },

  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 8,
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 10,
    marginRight: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#F7F9FF",
  },
  title: { fontSize: 22, fontWeight: "900", color: C.text },
  sub: { color: C.muted, marginTop: 2 },

  toggleWrap: { flexDirection: "row", paddingHorizontal: 16, gap: 8, marginTop: 6 },
  toggleBtn: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 10, borderWidth: 1 },
  toggleOn: { backgroundColor: C.primary, borderColor: C.primary },
  toggleOff: { backgroundColor: "#fff", borderColor: C.border },
  toggleTextOn: { color: "#fff", fontWeight: "800" },
  toggleTextOff: { color: C.text, fontWeight: "800" },

  searchWrap: {
    marginHorizontal: 16,
    marginTop: 10,
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: "#fff",
  },
  searchInput: { marginLeft: 8, flex: 1, color: C.text, fontWeight: "600" },

  meCard: {
    marginHorizontal: 16,
    marginTop: 10,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 14,
    padding: 12,
    backgroundColor: "#F8FAFF",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  meText: { color: C.muted, fontWeight: "700" },
  meRank: { color: C.primary, fontWeight: "900", fontSize: 20 },
  mePts: { color: C.text, fontWeight: "800" },

  podiumWrap: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    marginTop: 4,
    marginBottom: 12,
  },
  podiumCol: { flex: 1, alignItems: "center" },
  podiumCenter: { marginHorizontal: 4 },

  podiumAvatarWrap: {
    width: 66,
    height: 66,
    borderRadius: 33,
    borderWidth: 2.5,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#fff",
  },
  podiumAvatarWrapFirst: { width: 78, height: 78, borderRadius: 39 },
  podiumAvatar: { width: "100%", height: "100%", borderRadius: 999 },
  podiumAvatarFallback: {
    width: "100%",
    height: "100%",
    borderRadius: 999,
    backgroundColor: C.primary,
    alignItems: "center",
    justifyContent: "center",
  },

  medalBadge: {
    position: "absolute",
    bottom: -6,
    right: -6,
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  medalText: { color: "#fff", fontWeight: "900", fontSize: 12 },

  podiumName: {
    marginTop: 8,
    fontWeight: "800",
    color: C.text,
    fontSize: 12,
    width: 90,
    textAlign: "center",
  },
  podiumPts: { marginTop: 2, color: C.muted, fontSize: 11, fontWeight: "700" },

  podiumBlock: {
    marginTop: 8,
    width: "80%",
    borderTopLeftRadius: 10,
    borderTopRightRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  podiumBlockFirst: { height: 70 },
  podiumBlockSide: { height: 48 },
  podiumBlockText: { fontWeight: "900", fontSize: 18 },

  row: {
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 14,
    backgroundColor: "#fff",
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
  },
  myRow: { backgroundColor: "#F1F7FF", borderColor: "#CFE1FF" },
  rank: { width: 44, fontWeight: "900", fontSize: 16 },
  avatar: { width: 42, height: 42, borderRadius: 21 },
  avatarFallback: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: C.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  initial: { color: "#fff", fontWeight: "900" },
  name: { color: C.text, fontWeight: "800", fontSize: 14 },
  points: { color: C.muted, marginTop: 2, fontSize: 12 },

  emptyWrap: { alignItems: "center", paddingVertical: 30 },
  emptyText: { color: C.muted, fontWeight: "700" },

  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  modalCard: {
    width: "100%",
    maxWidth: 420,
    backgroundColor: "#fff",
    borderRadius: 22,
    padding: 18,
  },
  profileHero: {
    alignItems: "center",
    paddingBottom: 6,
  },
  modalAvatar: { width: 78, height: 78, borderRadius: 39 },
  modalName: {
    marginTop: 12,
    fontWeight: "900",
    color: C.text,
    fontSize: 19,
  },
  modalRankBadge: {
    marginTop: 8,
    backgroundColor: "#EEF4FF",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  modalRank: { color: C.primary, fontWeight: "800" },


  emptyPodiumAvatarWrap: {
  backgroundColor: "#F8FAFF",
  borderStyle: "dashed",
},

podiumNameEmpty: {
  marginTop: 8,
  fontWeight: "800",
  color: C.muted,
  fontSize: 12,
  width: 90,
  textAlign: "center",
},

podiumPtsEmpty: {
  marginTop: 2,
  color: "#98A2B3",
  fontSize: 11,
  fontWeight: "700",
},
  infoGrid: { marginTop: 16, gap: 8 },
  infoRow: {
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  infoLabel: { color: C.muted, fontWeight: "700" },
  infoValue: { color: C.text, fontWeight: "800", maxWidth: "60%", textAlign: "right" },

  closeBtn: {
    marginTop: 16,
    backgroundColor: C.primary,
    borderRadius: 12,
    alignItems: "center",
    paddingVertical: 12,
  },
  closeBtnText: { color: "#fff", fontWeight: "900" },
});