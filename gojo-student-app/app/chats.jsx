import React, { useEffect, useState, useCallback, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  Image,
  StatusBar,
  Alert,
  ScrollView,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { ref, get, update } from "firebase/database";
import { database } from "../constants/firebaseConfig";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { setOpenedChat } from "./lib/chatStore";

/**
 * app/chats.jsx
 *
 * Improvements in this patch:
 * 1) Teacher resolution (TeacherAssignments -> Teachers -> Users) is done once per load and cached in-memory
 *    to avoid repeated DB reads when rendering the list.
 * 2) Adds explicit "no assigned teachers" empty state when the student has no teachers assigned.
 * 3) Keeps deterministic chat id lookup when opening chats and correct unread-badge behavior.
 *
 * Notes:
 * - Chats use deterministic IDs "<userA>_<userB>" (finds either order)
 * - This file expects Users nodes to have .userId property (your DB).
 */

const PRIMARY = "#007AFB";
const MUTED = "#6B78A8";
const AVATAR_PLACEHOLDER = require("../assets/images/avatar_placeholder.png");

const FILTERS = ["All", "Management", "Teachers", "Parents"];

function shortText(s, n = 60) {
  if (!s && s !== 0) return "";
  const t = String(s);
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

function fmtTime(ts) {
  if (!ts) return "";
  try {
    const d = new Date(Number(ts));
    const now = new Date();
    const diff = (now - d) / 1000;
    if (diff < 60) return `${Math.floor(diff)}s`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
    return d.toLocaleDateString();
  } catch {
    return "";
  }
}

export default function ChatsScreen() {
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("All");
  const [contacts, setContacts] = useState([]);
  const [currentUserNodeKey, setCurrentUserNodeKey] = useState(null);
  const [currentUserId, setCurrentUserId] = useState(null);

  // cacheRef keeps teacher resolution cached for the current student key.
  const cacheRef = useRef({
    studentNodeKey: null,
    teacherIdsForStudent: null, // Set of teacherIds assigned to the student
    teacherNodeKeys: null, // Map teacherId -> Users.nodeKey (user node key)
  });

  const makeDeterministicChatId = (a, b) => `${a}_${b}`;

  const resolveCurrentUserId = useCallback(async () => {
    let uId = await AsyncStorage.getItem("userId");
    if (uId) return uId;
    const nodeKey =
      (await AsyncStorage.getItem("userNodeKey")) ||
      (await AsyncStorage.getItem("studentNodeKey")) ||
      (await AsyncStorage.getItem("studentId")) ||
      null;
    if (!nodeKey) return null;
    try {
      const snap = await get(ref(database, `Users/${nodeKey}`));
      if (snap.exists()) {
        const v = snap.val();
        return v?.userId || nodeKey;
      }
    } catch (e) {
      // ignore
    }
    return nodeKey;
  }, []);

  // Primary load: gather assigned teachers (cached), admins, build contacts list
  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const nodeKey =
        (await AsyncStorage.getItem("userNodeKey")) ||
        (await AsyncStorage.getItem("studentNodeKey")) ||
        (await AsyncStorage.getItem("studentId")) ||
        null;
      setCurrentUserNodeKey(nodeKey);

      const resolvedUserId = await resolveCurrentUserId();
      setCurrentUserId(resolvedUserId || null);

      // Resolve student grade/section
      let studentGrade = null;
      let studentSection = null;
      let studentNodeKey = null;
      try {
        studentNodeKey =
          (await AsyncStorage.getItem("studentNodeKey")) ||
          (await AsyncStorage.getItem("studentId")) ||
          null;
        if (studentNodeKey) {
          const snap = await get(ref(database, `Students/${studentNodeKey}`));
          if (snap.exists()) {
            const s = snap.val();
            studentGrade = s.grade ? String(s.grade) : null;
            studentSection = s.section ? String(s.section) : null;
          }
        }
      } catch (e) {
        console.warn("students fetch failed", e);
      }

      // Only refresh teacher assignments resolution if student changed
      if (cacheRef.current.studentNodeKey !== studentNodeKey || !cacheRef.current.teacherIdsForStudent) {
        // 1) load Courses and build matching course keys for student's grade/section
        const courseKeys = new Set();
        try {
          const coursesSnap = await get(ref(database, "Courses"));
          if (coursesSnap.exists() && studentGrade && studentSection) {
            coursesSnap.forEach((c) => {
              const val = c.val();
              const key = c.key;
              if (String(val.grade ?? "") === String(studentGrade) && String(val.section ?? "") === String(studentSection)) {
                courseKeys.add(key);
              }
            });
          }
        } catch (e) {
          console.warn("Courses fetch failed", e);
        }

        // 2) load TeacherAssignments (single read) and collect teacherIds for those courses
        const teacherIdsForStudent = new Set();
        try {
          const taSnap = await get(ref(database, "TeacherAssignments"));
          if (taSnap.exists() && courseKeys.size > 0) {
            taSnap.forEach((child) => {
              const val = child.val();
              if (val && val.courseId && courseKeys.has(val.courseId) && val.teacherId) {
                teacherIdsForStudent.add(val.teacherId);
              }
            });
          }
        } catch (e) {
          console.warn("TeacherAssignments fetch failed", e);
        }

        // 3) load Teachers node once and map teacherId -> Users nodeKey (userNodeKey)
        const teacherNodeKeyMap = {}; // teacherId -> userNodeKey (Users node key)
        try {
          const teachersSnap = await get(ref(database, "Teachers"));
          if (teachersSnap.exists()) {
            teachersSnap.forEach((child) => {
              const v = child.val();
              const teacherId = v?.teacherId;
              const userNode = v?.userId; // your Teachers have userId which points to Users node key
              if (teacherId && userNode) {
                teacherNodeKeyMap[teacherId] = userNode;
              }
            });
          }
        } catch (e) {
          console.warn("Teachers fetch failed", e);
        }

        // store cache
        cacheRef.current.studentNodeKey = studentNodeKey;
        cacheRef.current.teacherIdsForStudent = teacherIdsForStudent;
        cacheRef.current.teacherNodeKeys = teacherNodeKeyMap;
      } // end caching resolution

      // Build set of teacher user node keys assigned to this student
      const teacherUserNodeKeys = new Set();
      for (const tid of Array.from(cacheRef.current.teacherIdsForStudent || [])) {
        const nodek = cacheRef.current.teacherNodeKeys?.[tid];
        if (nodek) teacherUserNodeKeys.add(nodek);
      }

      // Admins: include all School_Admins (unchanged)
      const adminUserNodeKeys = new Set();
      try {
        const saSnap = await get(ref(database, "School_Admins"));
        if (saSnap.exists()) {
          saSnap.forEach((child) => {
            const v = child.val();
            if (v && v.userId) adminUserNodeKeys.add(v.userId);
          });
        }
      } catch (e) {
        console.warn("School_Admins fetch failed", e);
      }

      // Helper: load Users profiles in parallel for the union of node keys we need
      const userNodeKeysToLoad = new Set([...Array.from(teacherUserNodeKeys), ...Array.from(adminUserNodeKeys)]);
      const userProfiles = {}; // nodeKey -> profile
      await Promise.all(
        Array.from(userNodeKeysToLoad).map(async (nodeKey) => {
          try {
            const snap = await get(ref(database, `Users/${nodeKey}`));
            if (snap.exists()) userProfiles[nodeKey] = snap.val();
          } catch (e) {
            // ignore individual failures
          }
        })
      );

      // Build contacts map (only assigned teachers + admins)
      const contactsMap = new Map();
      for (const nodeKey of Array.from(teacherUserNodeKeys)) {
        const profile = userProfiles[nodeKey] || null;
        contactsMap.set(nodeKey, {
          nodeKey,
          userId: profile?.userId || nodeKey,
          name: profile?.name || profile?.username || "Teacher",
          role: "Teacher",
          profileImage: profile?.profileImage || null,
          type: "teacher",
          chatId: null,
          lastMessage: null,
          lastTime: null,
          unread: 0,
        });
      }
      for (const nodeKey of Array.from(adminUserNodeKeys)) {
        if (contactsMap.has(nodeKey)) continue;
        const profile = userProfiles[nodeKey] || null;
        contactsMap.set(nodeKey, {
          nodeKey,
          userId: profile?.userId || nodeKey,
          name: profile?.name || profile?.username || "Admin",
          role: "Management",
          profileImage: profile?.profileImage || null,
          type: "management",
          chatId: null,
          lastMessage: null,
          lastTime: null,
          unread: 0,
        });
      }

      // Merge Chats metadata and set unread counts for currentUserId
      try {
        const chatsSnap = await get(ref(database, "Chats"));
        if (chatsSnap.exists()) {
          chatsSnap.forEach((child) => {
            const chatKey = child.key;
            const val = child.val();
            const participants = val.participants || {};
            const last = val.lastMessage || null;
            const unreadObj = val.unread || {};

            // If currentUserId present, find other participant and attach metadata to contact whose userId === other
            if (currentUserId && participants && participants[currentUserId]) {
              const otherKeys = Object.keys(participants).filter((k) => k !== currentUserId);
              if (otherKeys.length === 0) return;
              const other = otherKeys[0];
              // find contact whose userId matches other
              for (const [k, contact] of contactsMap.entries()) {
                if (String(contact.userId) === String(other)) {
                  const existing = contactsMap.get(k);
                  existing.chatId = chatKey;
                  existing.lastMessage = last?.text || existing.lastMessage;
                  existing.lastTime = last?.timeStamp || existing.lastTime;
                  const unreadCount = Number(unreadObj[currentUserId] ?? 0);
                  const lastSender = last?.senderId ?? null;
                  existing.unread = lastSender && String(lastSender) === String(currentUserId) ? 0 : unreadCount;
                  contactsMap.set(k, existing);
                }
              }
            } else {
              // For chats where current user is not a participant, ignore for now.
            }
          });
        }
      } catch (e) {
        console.warn("Chats merge failed", e);
      }

      // Convert to array
      const arr = Array.from(contactsMap.values()).map((c) => ({
        key: c.nodeKey,
        userId: c.userId,
        name: c.name,
        role: c.role,
        profileImage: c.profileImage,
        type: c.type,
        chatId: c.chatId,
        lastMessage: c.lastMessage,
        lastTime: c.lastTime,
        unread: c.unread || 0,
      }));

      // Sort - unread first, then recent
      arr.sort((a, b) => {
        if ((b.unread || 0) - (a.unread || 0) !== 0) return (b.unread || 0) - (a.unread || 0);
        const ta = a.lastTime ? Number(a.lastTime) : 0;
        const tb = b.lastTime ? Number(b.lastTime) : 0;
        if (tb - ta !== 0) return tb - ta;
        return (a.name || "").localeCompare(b.name || "");
      });

      setContacts(arr);
    } catch (err) {
      console.warn("loadData error", err);
      setContacts([]);
    } finally {
      setLoading(false);
    }
  }, [currentUserId, resolveCurrentUserId]);

  // initial effects
  useEffect(() => {
    (async () => {
      const uNodeKey =
        (await AsyncStorage.getItem("userNodeKey")) ||
        (await AsyncStorage.getItem("studentNodeKey")) ||
        (await AsyncStorage.getItem("studentId")) ||
        null;
      setCurrentUserNodeKey(uNodeKey);
      const resolved = await resolveCurrentUserId();
      setCurrentUserId(resolved || null);
    })();
  }, [resolveCurrentUserId]);

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUserNodeKey, currentUserId]);

  // onOpenChat: resolve contactUserId and deterministic chat id, store in chatStore then navigate
  const onOpenChat = async (contact) => {
    if (!contact) return;

    // resolve contactUserId
    let contactUserId = contact.userId || "";
    if (!contactUserId) {
      try {
        const snap = await get(ref(database, `Users/${contact.key}`));
        if (snap.exists()) contactUserId = snap.val()?.userId || contact.key;
        else contactUserId = contact.key;
      } catch (e) {
        contactUserId = contact.key;
      }
    }

    // resolve myUserId
    let myUserId = await AsyncStorage.getItem("userId");
    if (!myUserId) {
      const nodeKey =
        (await AsyncStorage.getItem("userNodeKey")) ||
        (await AsyncStorage.getItem("studentNodeKey")) ||
        (await AsyncStorage.getItem("studentId")) ||
        null;
      if (nodeKey) {
        try {
          const snap = await get(ref(database, `Users/${nodeKey}`));
          if (snap.exists()) myUserId = snap.val()?.userId || nodeKey;
          else myUserId = nodeKey;
        } catch (e) {
          myUserId = nodeKey;
        }
      }
    }

    // try to find existing chat id deterministically
    let existingChatId = "";
    if (myUserId && contactUserId) {
      try {
        const c1 = makeDeterministicChatId(myUserId, contactUserId);
        const c2 = makeDeterministicChatId(contactUserId, myUserId);
        const s1 = await get(ref(database, `Chats/${c1}`));
        if (s1.exists()) existingChatId = c1;
        else {
          const s2 = await get(ref(database, `Chats/${c2}`));
          if (s2.exists()) existingChatId = c2;
        }
      } catch (e) {
        console.warn("onOpenChat find existing chat error", e);
      }
    }

    setOpenedChat({
      chatId: existingChatId || "",
      contactKey: contact.key || "",
      contactUserId: contactUserId || "",
      contactName: contact.name || "",
      contactImage: contact.profileImage || "",
    });

    router.push("/messages");
  };

  // Filtered contacts per selected filter
  const filteredContacts = contacts.filter((c) => {
    if (filter === "All") return true;
    if (filter === "Management") return c.type === "management";
    if (filter === "Teachers") return c.type === "teacher";
    if (filter === "Parents") return c.type === "parent";
    return true;
  });

  // UI: If no assigned teachers at all, show a dedicated empty state
  const hasAssignedTeachers = contacts.some((c) => c.type === "teacher");

  if (loading) {
    return (
      <SafeAreaView edges={["top", "bottom"]} style={styles.safe}>
        <StatusBar barStyle="dark-content" backgroundColor="#ffffff" translucent={false} />
        <View style={styles.center}>
          <ActivityIndicator size="large" color={PRIMARY} />
        </View>
      </SafeAreaView>
    );
  }

  // If user selected filter "Teachers" and there are none, show message
  if (filter === "Teachers" && !hasAssignedTeachers) {
    return (
      <SafeAreaView edges={["top", "bottom"]} style={styles.safe}>
        <StatusBar barStyle="dark-content" backgroundColor="#ffffff" translucent={false} />
        <View style={styles.container}>
          <View style={styles.headerRow}>
            <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
              <Ionicons name="chevron-back" size={22} color="#222" />
            </TouchableOpacity>

            <Text style={styles.headerTitle}>Messages</Text>

            <View style={{ width: 36 }} />
          </View>

          <View style={styles.filterContainer}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterScrollContent}>
              {FILTERS.map((f) => (
                <TouchableOpacity
                  key={f}
                  onPress={() => setFilter(f)}
                  activeOpacity={0.85}
                  style={[styles.filterPill, filter === f ? styles.filterPillActive : null]}
                >
                  <Text style={[styles.filterPillText, filter === f ? styles.filterPillTextActive : null]}>{f}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>

          <View style={styles.emptyWrap}>
            <Text style={styles.emptyTitle}>No assigned teachers</Text>
            <Text style={styles.emptySubtitle}>There are currently no teachers assigned to this student.</Text>
            <Text style={[styles.emptySubtitle, { marginTop: 12 }]}>Contact the school administration if this looks incorrect.</Text>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  const renderSeparator = () => <View style={styles.separatorLine} />;

  return (
    <SafeAreaView edges={["top", "bottom"]} style={styles.safe}>
      <StatusBar barStyle="dark-content" backgroundColor="#ffffff" translucent={false} />
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
            <Ionicons name="chevron-back" size={22} color="#222" />
          </TouchableOpacity>

          <Text style={styles.headerTitle}>Messages</Text>

          <TouchableOpacity onPress={() => Alert.alert("Search", "Search not implemented yet")}>
            <Ionicons name="search-outline" size={20} color={MUTED} />
          </TouchableOpacity>
        </View>

        {/* Filters */}
        <View style={styles.filterContainer}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterScrollContent}>
            {FILTERS.map((f) => (
              <TouchableOpacity
                key={f}
                onPress={() => setFilter(f)}
                activeOpacity={0.85}
                style={[styles.filterPill, filter === f ? styles.filterPillActive : null]}
              >
                <Text style={[styles.filterPillText, filter === f ? styles.filterPillTextActive : null]}>{f}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>

        {/* Contacts */}
        {filteredContacts.length === 0 ? (
          <View style={styles.emptyWrap}>
            <Text style={styles.emptyTitle}>No contacts</Text>
            <Text style={styles.emptySubtitle}>No {filter.toLowerCase()} contacts found yet.</Text>
          </View>
        ) : (
          <FlatList
            data={filteredContacts}
            keyExtractor={(it) => it.key}
            renderItem={({ item }) => (
              <TouchableOpacity style={styles.itemWrapper} onPress={() => onOpenChat(item)} activeOpacity={0.9}>
                <View style={styles.row}>
                  <Image source={item.profileImage ? { uri: item.profileImage } : AVATAR_PLACEHOLDER} style={styles.avatar} />
                  <View style={{ flex: 1, marginLeft: 12 }}>
                    <View style={styles.rowTop}>
                      <View style={{ flex: 1, flexDirection: "row", alignItems: "center" }}>
                        <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
                        {item.role ? <View style={styles.badge}><Text style={styles.badgeText}>{item.role}</Text></View> : null}
                      </View>

                      <View style={{ alignItems: "flex-end" }}>
                        <Text style={styles.time}>{fmtTime(item.lastTime)}</Text>
                        {item.unread ? <View style={styles.unreadPill}><Text style={styles.unreadText}>{item.unread}</Text></View> : null}
                      </View>
                    </View>

                    <View style={{ marginTop: 6 }}>
                      <Text style={styles.subtitleText} numberOfLines={1}>{shortText(item.lastMessage || (item.role === "Teacher" ? "Tap to message your teacher" : "Start a conversation"))}</Text>
                    </View>
                  </View>
                </View>
              </TouchableOpacity>
            )}
            ItemSeparatorComponent={renderSeparator}
            contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 20 }}
          />
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#fff" },
  container: { flex: 1, backgroundColor: "#fff" },

  headerRow: { paddingHorizontal: 12, paddingTop: 12, paddingBottom: 6, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  backButton: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  headerTitle: { fontSize: 20, fontWeight: "800", color: "#111" },

  filterContainer: { height: 52, justifyContent: "center" },
  filterScrollContent: { paddingHorizontal: 12, alignItems: "center" },
  filterPill: {
    height: 36,
    paddingHorizontal: 14,
    borderRadius: 18,
    backgroundColor: "#F8FAFF",
    marginRight: 10,
    minWidth: 88,
    justifyContent: "center",
    alignItems: "center",
  },
  filterPillActive: { backgroundColor: PRIMARY },
  filterPillText: { color: MUTED, fontWeight: "700", fontSize: 13 },
  filterPillTextActive: { color: "#fff" },

  itemWrapper: { paddingHorizontal: 0 },
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 12, backgroundColor: "#fff" },
  avatar: { width: 56, height: 56, borderRadius: 28, backgroundColor: "#F1F3F8" },
  rowTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  name: { fontWeight: "700", fontSize: 16, color: "#111", marginRight: 8 },
  badge: { marginLeft: 6, paddingHorizontal: 7, paddingVertical: 3, borderRadius: 8, backgroundColor: "#F1F7FF" },
  badgeText: { color: PRIMARY, fontWeight: "700", fontSize: 11 },
  subtitleText: { color: MUTED, fontSize: 13, flex: 1 },

  time: { color: MUTED, fontSize: 11 },
  unreadPill: { marginTop: 8, backgroundColor: PRIMARY, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 12, minWidth: 24, alignItems: "center" },
  unreadText: { color: "#fff", fontWeight: "700", fontSize: 12 },

  separatorLine: { height: 1, backgroundColor: "#EEF4FF", marginLeft: 56 + 12 + 8, marginRight: 0 },

  center: { flex: 1, alignItems: "center", justifyContent: "center" },

  emptyWrap: { flex: 1, alignItems: "center", justifyContent: "center", paddingTop: 40, paddingHorizontal: 24 },
  emptyTitle: { fontWeight: "700", fontSize: 16, color: "#222", textAlign: "center" },
  emptySubtitle: { color: MUTED, marginTop: 6, textAlign: "center" },
});