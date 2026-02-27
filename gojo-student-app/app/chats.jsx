// app/chats.jsx
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
  RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { ref, get } from "firebase/database";
import { database } from "../constants/firebaseConfig";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { setOpenedChat } from "./lib/chatStore";
import { useFocusEffect } from "@react-navigation/native";

/**
 * app/chats.jsx
 *
 * - Merge server results with local cache ("chatsCache") and keep whichever lastTime is newer.
 * - Preserve lastSenderId and lastSeen fields in the cache so seen state can be shown immediately.
 * - Time format for last message now uses 12-hour format "8:20 AM".
 * - Show seen tick on chats list when last message sender is current user and lastMessage.seen === true.
 */

const PRIMARY = "#007AFB";
const MUTED = "#6B78A8";
const AVATAR_PLACEHOLDER = require("../assets/images/avatar_placeholder.png");

const FILTERS = ["All", "Management", "Teachers", "Parents"];
const debounceWindowMs = 15 * 1000;

function shortText(s, n = 60) {
  if (!s && s !== 0) return "";
  const t = String(s);
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}
function fmtTime12(ts) {
  if (!ts) return "";
  try {
    const d = new Date(Number(ts));
    let h = d.getHours();
    const m = d.getMinutes().toString().padStart(2, "0");
    const ampm = h >= 12 ? "AM" : "AM"; // placeholder
    // fix above: compute am/pm properly
    const ampmProper = d.getHours() >= 12 ? "PM" : "AM";
    h = d.getHours() % 12;
    if (h === 0) h = 12;
    return `${h}:${m} ${ampmProper}`;
  } catch {
    return "";
  }
}

export default function ChatsScreen() {
  const router = useRouter();

  const [loadingInitial, setLoadingInitial] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState("All");
  const [contacts, setContacts] = useState([]);
  const [currentUserNodeKey, setCurrentUserNodeKey] = useState(null);
  const [currentUserId, setCurrentUserId] = useState(null);

  const cacheRef = useRef({
    studentNodeKey: null,
    teacherIdsForStudent: null,
    teacherNodeKeys: null,
  });
  const lastFetchedAtRef = useRef(0);

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
    } catch (e) {}
    return nodeKey;
  }, []);

  const loadCacheAndShow = async () => {
    try {
      const raw = await AsyncStorage.getItem("chatsCache");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          setContacts(parsed);
          setLoadingInitial(false);
          const fetchedAt = Number(await AsyncStorage.getItem("chatsCacheFetchedAt") || 0);
          lastFetchedAtRef.current = fetchedAt;
          return true;
        }
      }
    } catch (e) {}
    return false;
  };

  // Core loader with merge: server results + cache (keep newest lastTime)
  const loadData = useCallback(
    async ({ background = false } = {}) => {
      if (!background) setLoadingInitial(true);
      try {
        const nodeKey =
          (await AsyncStorage.getItem("userNodeKey")) ||
          (await AsyncStorage.getItem("studentNodeKey")) ||
          (await AsyncStorage.getItem("studentId")) ||
          null;
        setCurrentUserNodeKey(nodeKey);

        const resolvedUserId = await resolveCurrentUserId();
        setCurrentUserId(resolvedUserId || null);

        // Resolve student's grade/section
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

        // If cached student differs, recompute teacher assignment caches
        if (cacheRef.current.studentNodeKey !== studentNodeKey || !cacheRef.current.teacherIdsForStudent) {
          // Courses -> courseKeys
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

          // TeacherAssignments -> teacherIdsForStudent
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

          // Teachers node -> teacherId -> userNodeKey
          const teacherNodeKeyMap = {};
          try {
            const teachersSnap = await get(ref(database, "Teachers"));
            if (teachersSnap.exists()) {
              teachersSnap.forEach((child) => {
                const v = child.val();
                const teacherId = v?.teacherId;
                const userNode = v?.userId;
                if (teacherId && userNode) teacherNodeKeyMap[teacherId] = userNode;
              });
            }
          } catch (e) {
            console.warn("Teachers fetch failed", e);
          }

          cacheRef.current.studentNodeKey = studentNodeKey;
          cacheRef.current.teacherIdsForStudent = teacherIdsForStudent;
          cacheRef.current.teacherNodeKeys = teacherNodeKeyMap;
        }

        // Build sets of teacher user node keys and admin keys
        const teacherUserNodeKeys = new Set();
        for (const tid of Array.from(cacheRef.current.teacherIdsForStudent || [])) {
          const nodek = cacheRef.current.teacherNodeKeys?.[tid];
          if (nodek) teacherUserNodeKeys.add(nodek);
        }

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

        // Load Users for union of node keys
        const userNodeKeysToLoad = new Set([...Array.from(teacherUserNodeKeys), ...Array.from(adminUserNodeKeys)]);
        const userProfiles = {};
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

        // Build contacts map
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
            lastSenderId: null,
            lastSeen: false,
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
            lastSenderId: null,
            lastSeen: false,
            unread: 0,
          });
        }

        // Merge Chats metadata and set lastSenderId/lastSeen if present
        try {
          const chatsSnap = await get(ref(database, "Chats"));
          if (chatsSnap.exists()) {
            chatsSnap.forEach((child) => {
              const chatKey = child.key;
              const val = child.val();
              const participants = val.participants || {};
              const last = val.lastMessage || null;
              const unreadObj = val.unread || {};

              if (currentUserId && participants && participants[currentUserId]) {
                const otherKeys = Object.keys(participants).filter((k) => k !== currentUserId);
                if (otherKeys.length === 0) return;
                const other = otherKeys[0];
                for (const [k, contact] of contactsMap.entries()) {
                  if (String(contact.userId) === String(other)) {
                    const existing = contactsMap.get(k);
                    existing.chatId = chatKey;
                    existing.lastMessage = last?.text || existing.lastMessage;
                    existing.lastTime = last?.timeStamp || existing.lastTime;
                    existing.lastSenderId = last?.senderId ?? existing.lastSenderId;
                    existing.lastSeen = typeof last?.seen === "boolean" ? last.seen : existing.lastSeen;
                    const unreadCount = Number(unreadObj[currentUserId] ?? 0);
                    const lastSender = last?.senderId ?? null;
                    existing.unread = lastSender && String(lastSender) === String(currentUserId) ? 0 : unreadCount;
                    contactsMap.set(k, existing);
                  }
                }
              }
            });
          }
        } catch (e) {
          console.warn("Chats merge failed", e);
        }

        // Convert to array
        const serverArr = Array.from(contactsMap.values()).map((c) => ({
          key: c.nodeKey,
          userId: c.userId,
          name: c.name,
          role: c.role,
          profileImage: c.profileImage,
          type: c.type,
          chatId: c.chatId,
          lastMessage: c.lastMessage,
          lastTime: c.lastTime,
          lastSenderId: c.lastSenderId,
          lastSeen: c.lastSeen,
          unread: c.unread || 0,
        }));

        // Merge with cache: prefer newer lastTime (cache or server) per contact and keep cache-only entries
        const rawCache = await AsyncStorage.getItem("chatsCache");
        const cache = rawCache ? JSON.parse(rawCache) : [];
        const cacheByKey = new Map();
        for (const c of cache) {
          const k = String(c.key || c.userId || "");
          cacheByKey.set(k, c);
        }

        const merged = [];
        for (const s of serverArr) {
          const k = String(s.key || s.userId || "");
          const cached = cacheByKey.get(k);
          if (cached) {
            const cachedTs = Number(cached.lastTime || 0);
            const serverTs = Number(s.lastTime || 0);
            if (cachedTs > serverTs) {
              merged.push({
                ...s,
                name: s.name || cached.name,
                profileImage: s.profileImage || cached.profileImage,
                lastMessage: cached.lastMessage,
                lastTime: cached.lastTime,
                lastSenderId: cached.lastSenderId ?? s.lastSenderId,
                lastSeen: typeof cached.lastSeen === "boolean" ? cached.lastSeen : s.lastSeen,
                unread: cached.unread ?? s.unread ?? 0,
              });
            } else {
              merged.push(s);
            }
            cacheByKey.delete(k);
          } else {
            merged.push(s);
          }
        }

        // Add remaining cached-only entries
        for (const [k, cached] of cacheByKey.entries()) {
          merged.push(cached);
        }

        // Sort
        merged.sort((a, b) => {
          if ((b.unread || 0) - (a.unread || 0) !== 0) return (b.unread || 0) - (a.unread || 0);
          const ta = a.lastTime ? Number(a.lastTime) : 0;
          const tb = b.lastTime ? Number(b.lastTime) : 0;
          if (tb - ta !== 0) return tb - ta;
          return (a.name || "").localeCompare(b.name || "");
        });

        setContacts(merged);

        try {
          await AsyncStorage.setItem("chatsCache", JSON.stringify(merged));
          await AsyncStorage.setItem("chatsCacheFetchedAt", String(Date.now()));
          lastFetchedAtRef.current = Date.now();
        } catch (e) {
          // ignore
        }
      } catch (err) {
        console.warn("loadData error", err);
      } finally {
        if (!background) setLoadingInitial(false);
        setRefreshing(false);
      }
    },
    [currentUserId, resolveCurrentUserId]
  );

  useEffect(() => {
    let mounted = true;
    (async () => {
      const hadCache = await loadCacheAndShow();
      try {
        const fetchedAtStr = await AsyncStorage.getItem("chatsCacheFetchedAt");
        const fetchedAt = fetchedAtStr ? Number(fetchedAtStr) : 0;
        const now = Date.now();
        if (!fetchedAt || now - fetchedAt > debounceWindowMs) {
          loadData({ background: true });
        } else {
          lastFetchedAtRef.current = fetchedAt;
        }
      } catch (e) {
        loadData({ background: true });
      }
    })();
    return () => { mounted = false; };
  }, [loadData]);

  useFocusEffect(
    useCallback(() => {
      const now = Date.now();
      if (now - (lastFetchedAtRef.current || 0) > debounceWindowMs) {
        loadData({ background: true });
      }
    }, [loadData])
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadData({ background: false });
  }, [loadData]);

  const onOpenChat = async (contact) => {
    if (!contact) return;

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

  const filteredContacts = contacts.filter((c) => {
    if (filter === "All") return true;
    if (filter === "Management") return c.type === "management";
    if (filter === "Teachers") return c.type === "teacher";
    if (filter === "Parents") return c.type === "parent";
    return true;
  });

  const hasAssignedTeachers = contacts.some((c) => c.type === "teacher");

  if (loadingInitial && contacts.length === 0) {
    return (
      <SafeAreaView edges={["top", "bottom"]} style={styles.safe}>
        <StatusBar barStyle="dark-content" backgroundColor="#ffffff" translucent={false} />
        <View style={styles.center}>
          <ActivityIndicator size="large" color={PRIMARY} />
        </View>
      </SafeAreaView>
    );
  }

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
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
            <Ionicons name="chevron-back" size={22} color="#222" />
          </TouchableOpacity>

          <Text style={styles.headerTitle}>Messages</Text>

          <TouchableOpacity onPress={() => Alert.alert("Search", "Search not implemented yet")}>
            <Ionicons name="search-outline" size={20} color={MUTED} />
          </TouchableOpacity>
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

        {filteredContacts.length === 0 ? (
          <View style={styles.emptyWrap}>
            <Text style={styles.emptyTitle}>No contacts</Text>
            <Text style={styles.emptySubtitle}>No {filter.toLowerCase()} contacts found yet.</Text>
          </View>
        ) : (
          <FlatList
            data={filteredContacts}
            keyExtractor={(it) => it.key}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
            renderItem={({ item }) => {
              const lastWasMine = item.lastSenderId && currentUserId && String(item.lastSenderId) === String(currentUserId);
              const seenFlag = !!item.lastSeen;
              return (
                <TouchableOpacity style={styles.itemWrapper} onPress={() => onOpenChat(item)} activeOpacity={0.9}>
                  <View style={styles.row}>
                    <Image source={item.profileImage ? { uri: item.profileImage } : AVATAR_PLACEHOLDER} style={styles.avatar} />
                    <View style={{ flex: 1, marginLeft: 12 }}>
                      <View style={styles.rowTop}>
                        <View style={{ flex: 1, flexDirection: "row", alignItems: "center" }}>
                          <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
                          {item.role ? <View style={styles.badge}><Text style={styles.badgeText}>{item.role}</Text></View> : null}
                        </View>

                        <View style={{ alignItems: "flex-end", flexDirection: "row", alignItemsVertical: "center" }}>
                          <Text style={styles.time}>{fmtTime12(item.lastTime)}</Text>
                          <View style={{ width: 8 }} />
                          {lastWasMine ? (
                            <Ionicons
                              name={seenFlag ? "checkmark-done" : "checkmark"}
                              size={16}
                              color={seenFlag ? PRIMARY : MUTED}
                            />
                          ) : null}
                          {item.unread ? <View style={styles.unreadPill}><Text style={styles.unreadText}>{item.unread}</Text></View> : null}
                        </View>
                      </View>

                      <View style={{ marginTop: 6 }}>
                        <Text style={styles.subtitleText} numberOfLines={1}>{shortText(item.lastMessage || (item.role === "Teacher" ? "Tap to message your teacher" : "Start a conversation"))}</Text>
                      </View>
                    </View>
                  </View>
                </TouchableOpacity>
              );
            }}
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