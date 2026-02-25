import React, { useEffect, useState, useCallback } from "react";
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
import { ref, get } from "firebase/database";
import { database } from "../constants/firebaseConfig";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";

/**
 * app/chats.jsx
 *
 * - App-level chats screen (route: /chats)
 * - Resolves contactUserId when opening a chat and passes it to /messages
 * - UI: Telegram-like contacts list with horizontal filters
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

export default function ChatsScreen(props) {
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("All");
  const [contacts, setContacts] = useState([]);
  const [currentUserKey, setCurrentUserKey] = useState(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const uKey = (await AsyncStorage.getItem("userNodeKey")) || (await AsyncStorage.getItem("studentNodeKey")) || (await AsyncStorage.getItem("studentId"));
      setCurrentUserKey(uKey || null);

      // student context
      let studentGrade = null;
      let studentSection = null;
      try {
        const studentNodeKey = (await AsyncStorage.getItem("studentNodeKey")) || (await AsyncStorage.getItem("studentId"));
        if (studentNodeKey) {
          const snap = await get(ref(database, `Students/${studentNodeKey}`));
          if (snap.exists()) {
            const s = snap.val();
            studentGrade = s.grade ? String(s.grade) : null;
            studentSection = s.section ? String(s.section) : null;
          }
        }
      } catch (err) {}

      // courses
      const courseKeys = [];
      try {
        const coursesSnap = await get(ref(database, "Courses"));
        if (coursesSnap.exists()) {
          coursesSnap.forEach((c) => {
            const val = c.val();
            const key = c.key;
            if (studentGrade && studentSection) {
              if (String(val.grade ?? "") === String(studentGrade) && String(val.section ?? "") === String(studentSection)) {
                courseKeys.push(key);
              }
            }
          });
        }
      } catch (err) {
        console.warn("Courses fetch error", err);
      }

      // teacher assignments -> teachers -> users
      const teacherIds = new Set();
      try {
        const taSnap = await get(ref(database, "TeacherAssignments"));
        if (taSnap.exists()) {
          taSnap.forEach((child) => {
            const val = child.val();
            if (val && courseKeys.includes(val.courseId) && val.teacherId) teacherIds.add(val.teacherId);
          });
        }
      } catch (err) {
        console.warn("TeacherAssignments fetch error", err);
      }

      const teacherUserIds = new Set();
      for (const teacherId of Array.from(teacherIds)) {
        try {
          const tSnap = await get(ref(database, `Teachers/${teacherId}`));
          if (tSnap.exists()) {
            const tVal = tSnap.val();
            if (tVal && tVal.userId) teacherUserIds.add(tVal.userId); // this is a userId (per your DB)
          }
        } catch (err) {
          console.warn("Teachers fetch error", err);
        }
      }

      // admins
      const adminUserIds = new Set();
      try {
        const saSnap = await get(ref(database, "School_Admins"));
        if (saSnap.exists()) {
          saSnap.forEach((child) => {
            const val = child.val();
            if (val && val.userId) adminUserIds.add(val.userId);
          });
        }
      } catch (err) {
        console.warn("School_Admins fetch error", err);
      }

      // contactsMap keyed by Users node key OR userId (we'll only display)
      const contactsMap = new Map();
      const loadUserProfileByUserIdOrNode = async (userIdOrNodeKey) => {
        // Try to find user by node key in Users/<nodeKey>
        try {
          const nodeSnap = await get(ref(database, `Users/${userIdOrNodeKey}`));
          if (nodeSnap.exists()) return nodeSnap.val();
        } catch (e) {}
        // If not found, try to find by scanning Users for userId equal to userIdOrNodeKey (rare; expensive)
        try {
          const usersSnap = await get(ref(database, "Users"));
          if (usersSnap.exists()) {
            let found = null;
            usersSnap.forEach((child) => {
              const val = child.val();
              if (val && val.userId === userIdOrNodeKey) {
                found = val;
              }
            });
            if (found) return found;
          }
        } catch (e) {}
        return null;
      };

      // Add teachers (these are userIds as resolved above)
      for (const ukey of Array.from(teacherUserIds)) {
        const profile = await loadUserProfileByUserIdOrNode(ukey);
        contactsMap.set(ukey, {
          key: ukey,
          displayName: profile?.name || profile?.username || "Teacher",
          role: "Teacher",
          profileImage: profile?.profileImage || null,
          type: "teacher",
          chatId: null,
          lastMessage: null,
          lastTime: null,
          unread: 0,
        });
      }

      // Add admins
      for (const ukey of Array.from(adminUserIds)) {
        if (contactsMap.has(ukey)) continue;
        const profile = await loadUserProfileByUserIdOrNode(ukey);
        contactsMap.set(ukey, {
          key: ukey,
          displayName: profile?.name || profile?.username || "Admin",
          role: "Management",
          profileImage: profile?.profileImage || null,
          type: "management",
          chatId: null,
          lastMessage: null,
          lastTime: null,
          unread: 0,
        });
      }

      // merge Chats metadata to attach chatId, lastMessage, unread
      if (uKey) {
        try {
          const chatsSnap = await get(ref(database, "Chats"));
          if (chatsSnap.exists()) {
            chatsSnap.forEach((child) => {
              const chatKey = child.key;
              const val = child.val();
              const participants = val.participants || {};
              if (participants && participants[uKey]) {
                const otherKeys = Object.keys(participants).filter((k) => k !== uKey);
                const other = otherKeys.length > 0 ? otherKeys[0] : null;
                const last = val.lastMessage || null;
                const unreadObj = val.unread || {};
                const unreadCount = unreadObj && typeof unreadObj[uKey] !== "undefined" ? Number(unreadObj[uKey]) : 0;

                if (other) {
                  // other is stored as userId (per your DB), use it as key
                  const key = other;
                  if (!contactsMap.has(key)) {
                    // create generic contact
                    contactsMap.set(key, {
                      key,
                      displayName: key,
                      role: "Contact",
                      profileImage: null,
                      type: "unknown",
                      chatId: chatKey,
                      lastMessage: last?.text || null,
                      lastTime: last?.timeStamp || null,
                      unread: unreadCount,
                    });
                  } else {
                    const existing = contactsMap.get(key);
                    existing.chatId = chatKey;
                    existing.lastMessage = last?.text || existing.lastMessage;
                    existing.lastTime = last?.timeStamp || existing.lastTime;
                    existing.unread = unreadCount;
                    contactsMap.set(key, existing);
                  }
                }
              }
            });
          }
        } catch (err) {
          console.warn("Chats fetch error", err);
        }
      }

      // convert and sort
      const contactsArr = Array.from(contactsMap.values()).map((c) => ({
        key: c.key,
        name: c.displayName,
        role: c.role,
        profileImage: c.profileImage,
        type: c.type,
        chatId: c.chatId,
        lastMessage: c.lastMessage,
        lastTime: c.lastTime,
        unread: c.unread || 0,
      }));

      contactsArr.sort((a, b) => {
        if ((b.unread || 0) - (a.unread || 0) !== 0) return (b.unread || 0) - (a.unread || 0);
        const ta = a.lastTime ? Number(a.lastTime) : 0;
        const tb = b.lastTime ? Number(b.lastTime) : 0;
        if (tb - ta !== 0) return tb - ta;
        return (a.name || "").localeCompare(b.name || "");
      });

      setContacts(contactsArr);
    } catch (err) {
      console.warn("loadData error", err);
      setContacts([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      const uKey = (await AsyncStorage.getItem("userNodeKey")) || (await AsyncStorage.getItem("studentNodeKey")) || (await AsyncStorage.getItem("studentId"));
      setCurrentUserKey(uKey || null);
    })();
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData, currentUserKey]);

  const filteredContacts = contacts.filter((c) => {
    if (filter === "All") return true;
    if (filter === "Management") return c.type === "management";
    if (filter === "Teachers") return c.type === "teacher";
    if (filter === "Parents") return c.type === "parent";
    return true;
  });

  // resolve the contact userId when opening chat, then navigate
  const resolveContactUserId = async (contactKey) => {
    // Try Users/{nodeKey} first
    try {
      const nodeSnap = await get(ref(database, `Users/${contactKey}`));
      if (nodeSnap.exists()) {
        const v = nodeSnap.val();
        if (v && v.userId) return v.userId;
        // fallback to node key
        return contactKey;
      }
    } catch (err) {
      // ignore
    }
    // Otherwise assume contactKey is already userId
    return contactKey;
  };

  const onOpenChat = async (contact) => {
    if (!contact) return;

    // Resolve contactUserId (userId used in Chats participant keys)
    const contactUserId = await resolveContactUserId(contact.key);

    const params = {
      chatId: contact.chatId || "",
      contactKey: contact.key || "",
      contactUserId: contactUserId || "",
      contactName: contact.name || "",
      contactImage: contact.profileImage || "",
    };

    router.push({ pathname: "/messages", params });
  };

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
              <TouchableOpacity key={f} onPress={() => setFilter(f)} activeOpacity={0.85} style={[styles.filterPill, filter === f ? styles.filterPillActive : null]}>
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

  emptyWrap: { flex: 1, alignItems: "center", justifyContent: "center" },
  emptyTitle: { fontWeight: "700", fontSize: 16, color: "#222" },
  emptySubtitle: { color: MUTED, marginTop: 6 },
});