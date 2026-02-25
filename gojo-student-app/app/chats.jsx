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
import { setOpenedChat } from "./lib/chatStore";

/**
 * app/chats.jsx
 *
 * - Resolves contactUserId when opening a chat and writes an "opened chat" payload to chatStore
 * - Attempts to find an existing deterministic chatId (userA_userB or userB_userA)
 * - Navigates to /messages (messages.jsx will create the chat if missing)
 *
 * Notes:
 * - Chats in your DB are keyed deterministically using "<userIdA>_<userIdB>"
 * - This file tries to resolve the userId values (from Users/{nodeKey}.userId or from contact.userId)
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
  const [currentUserNodeKey, setCurrentUserNodeKey] = useState(null);

  const makeDeterministicChatId = (a, b) => `${a}_${b}`;

  const findExistingChatIdForContact = async (myUserId, contactUserId) => {
    if (!myUserId || !contactUserId) return "";
    const c1 = makeDeterministicChatId(myUserId, contactUserId);
    const c2 = makeDeterministicChatId(contactUserId, myUserId);
    try {
      const s1 = await get(ref(database, `Chats/${c1}`));
      if (s1.exists()) return c1;
      const s2 = await get(ref(database, `Chats/${c2}`));
      if (s2.exists()) return c2;
      return "";
    } catch (e) {
      console.warn("findExistingChatIdForContact error", e);
      return "";
    }
  };

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const userNodeKey =
        (await AsyncStorage.getItem("userNodeKey")) ||
        (await AsyncStorage.getItem("studentNodeKey")) ||
        (await AsyncStorage.getItem("studentId")) ||
        null;
      setCurrentUserNodeKey(userNodeKey);

      // Gather teachers and admins as contacts (using Users node keys referenced in Teachers/School_Admins)
      const teacherUserNodeKeys = new Set();
      try {
        const teachersSnap = await get(ref(database, "Teachers"));
        if (teachersSnap.exists()) {
          teachersSnap.forEach((child) => {
            const v = child.val();
            if (v && v.userId) teacherUserNodeKeys.add(v.userId);
          });
        }
      } catch (e) {
        console.warn("Teachers fetch failed", e);
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

      // Helper to load Users/{nodeKey}
      const loadUserNodeProfile = async (nodeKey) => {
        try {
          const snap = await get(ref(database, `Users/${nodeKey}`));
          if (snap.exists()) return snap.val();
        } catch (e) {}
        return null;
      };

      // Build contacts map keyed by Users node key
      const contactsMap = new Map();

      for (const nodeKey of Array.from(teacherUserNodeKeys)) {
        const profile = await loadUserNodeProfile(nodeKey);
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
        const profile = await loadUserNodeProfile(nodeKey);
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

      // Merge Chats metadata so we can show chatId, lastMessage, unread
      try {
        const chatsSnap = await get(ref(database, "Chats"));
        if (chatsSnap.exists()) {
          chatsSnap.forEach((child) => {
            const chatKey = child.key;
            const val = child.val();
            const participants = val.participants || {};
            const last = val.lastMessage || null;
            const unreadObj = val.unread || {};
            // For each participant in chat, if their userId matches a contact, attach metadata
            Object.keys(participants).forEach((partUserId) => {
              for (const [k, contact] of contactsMap.entries()) {
                if (String(contact.userId) === String(partUserId)) {
                  const existing = contactsMap.get(k);
                  existing.chatId = chatKey;
                  existing.lastMessage = last?.text || existing.lastMessage;
                  existing.lastTime = last?.timeStamp || existing.lastTime;
                  // unread count for the contact (best-effort)
                  existing.unread = Number(unreadObj[partUserId] ?? existing.unread ?? 0);
                  contactsMap.set(k, existing);
                }
              }
            });
          });
        }
      } catch (e) {
        console.warn("Chats merge failed", e);
      }

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
  }, []);

  useEffect(() => {
    (async () => {
      const uKey =
        (await AsyncStorage.getItem("userNodeKey")) ||
        (await AsyncStorage.getItem("studentNodeKey")) ||
        (await AsyncStorage.getItem("studentId")) ||
        null;
      setCurrentUserNodeKey(uKey);
    })();
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData, currentUserNodeKey]);

  // onOpenChat resolves contactUserId and our own userId and writes to chatStore
  const onOpenChat = async (contact) => {
    if (!contact) return;

    // Resolve contactUserId (prefer contact.userId property)
    let contactUserId = contact.userId || "";
    if (!contactUserId) {
      try {
        const snap = await get(ref(database, `Users/${contact.key}`));
        if (snap.exists()) {
          contactUserId = snap.val()?.userId || contact.key;
        } else {
          contactUserId = contact.key;
        }
      } catch (e) {
        contactUserId = contact.key;
      }
    }

    // Resolve myUserId (try AsyncStorage "userId" first, otherwise lookup Users/{nodeKey}.userId)
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

    // attempt to find existing deterministic chatId (either order)
    let existingChatId = "";
    if (myUserId && contactUserId) {
      const c1 = makeDeterministicChatId(myUserId, contactUserId);
      const c2 = makeDeterministicChatId(contactUserId, myUserId);
      try {
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

    // Save opening payload (messages.jsx reads store on mount)
    setOpenedChat({
      chatId: existingChatId || "",
      contactKey: contact.key || "",
      contactUserId: contactUserId || "",
      contactName: contact.name || "",
      contactImage: contact.profileImage || "",
    });

    router.push("/messages");
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
        {contacts.length === 0 ? (
          <View style={styles.emptyWrap}>
            <Text style={styles.emptyTitle}>No contacts</Text>
            <Text style={styles.emptySubtitle}>No {filter.toLowerCase()} contacts found yet.</Text>
          </View>
        ) : (
          <FlatList
            data={contacts}
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