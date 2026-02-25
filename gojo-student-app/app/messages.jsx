import React, { useEffect, useState, useRef, useMemo } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  Image,
  StatusBar,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  Alert,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { ref, push, update, get, onValue, off } from "firebase/database";
import { database } from "../constants/firebaseConfig";
import { getOpenedChat, clearOpenedChat } from "./lib/chatStore";
import { useSafeAreaInsets, SafeAreaView } from "react-native-safe-area-context";

/**
 * app/messages.jsx
 *
 * - Uses deterministic chat IDs: "<userA>_<userB>" (finds either order)
 * - If chat doesn't exist, it creates it at the deterministic key
 * - Optimistic append so sent messages appear immediately
 * - Date separators, bubble tails, per-message seen ticks
 * - Respects safe areas (status + system bars)
 */

const PRIMARY = "#007AFB";
const MUTED = "#6B78A8";
const BG = "#FFFFFF";
const INCOMING_BG = "#F6F7FB";
const OUTGOING_BG = "#007AFB";
const INCOMING_TEXT = "#111";
const OUTGOING_TEXT = "#fff";
const AVATAR_PLACEHOLDER = require("../assets/images/avatar_placeholder.png");

function fmtTime(ts) {
  if (!ts) return "";
  try {
    const d = new Date(Number(ts));
    const hh = d.getHours().toString().padStart(2, "0");
    const mm = d.getMinutes().toString().padStart(2, "0");
    return `${hh}:${mm}`;
  } catch {
    return "";
  }
}

function stripTime(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
function dateLabelForTs(ts) {
  if (!ts) return "";
  const date = new Date(Number(ts));
  const today = new Date();
  const diffDays = Math.floor((stripTime(today) - stripTime(date)) / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return date.toLocaleDateString();
}

export default function MessagesScreen(props) {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const opened = getOpenedChat() || {};
  const routeParams = (props && props.route && props.route.params) ? props.route.params : {};
  const chatFromStore = {
    chatId: opened.chatId ?? routeParams.chatId ?? "",
    contactKey: opened.contactKey ?? routeParams.contactKey ?? "",
    contactUserId: opened.contactUserId ?? routeParams.contactUserId ?? "",
    contactName: opened.contactName ?? routeParams.contactName ?? "",
    contactImage: opened.contactImage ?? routeParams.contactImage ?? null,
  };
  clearOpenedChat();

  const [currentUserId, setCurrentUserId] = useState(null);
  const [chatId, setChatId] = useState(chatFromStore.chatId || "");
  const [contactUserId, setContactUserId] = useState(chatFromStore.contactUserId || "");
  const [contactKey, setContactKey] = useState(chatFromStore.contactKey || "");
  const [contactName, setContactName] = useState(chatFromStore.contactName || "");
  const [contactImage, setContactImage] = useState(chatFromStore.contactImage || null);

  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [text, setText] = useState("");
  const [lastMessageMeta, setLastMessageMeta] = useState(null);

  const messagesRefRef = useRef(null);
  const lastMessageRefRef = useRef(null);
  const flatListRef = useRef(null);

  const makeDeterministicChatId = (a, b) => `${a}_${b}`;

  // try to find existing deterministic chat id (no create)
  const findExistingChatId = async (a, b) => {
    if (!a || !b) return "";
    const c1 = makeDeterministicChatId(a, b);
    const c2 = makeDeterministicChatId(b, a);
    try {
      const s1 = await get(ref(database, `Chats/${c1}`));
      if (s1.exists()) return c1;
      const s2 = await get(ref(database, `Chats/${c2}`));
      if (s2.exists()) return c2;
      return "";
    } catch (e) {
      console.warn("[Messages] findExistingChatId error", e);
      return "";
    }
  };

  // find or create deterministic chat id
  const findOrCreateChatId = async (userA, userB, createIfMissing = true) => {
    if (!userA || !userB) return null;
    const c1 = makeDeterministicChatId(userA, userB);
    const c2 = makeDeterministicChatId(userB, userA);
    try {
      const s1 = await get(ref(database, `Chats/${c1}`));
      if (s1.exists()) return c1;
      const s2 = await get(ref(database, `Chats/${c2}`));
      if (s2.exists()) return c2;
      if (!createIfMissing) return null;

      const now = Date.now();
      const participants = { [userA]: true, [userB]: true };
      const lastMessage = { seen: false, senderId: userA, text: "", timeStamp: now, type: "system" };
      const unread = { [userA]: 0, [userB]: 0 };

      const baseUpdates = {};
      baseUpdates[`Chats/${c1}/participants`] = participants;
      baseUpdates[`Chats/${c1}/lastMessage`] = lastMessage;
      baseUpdates[`Chats/${c1}/unread`] = unread;

      await update(ref(database), baseUpdates);
      return c1;
    } catch (err) {
      console.warn("[Messages] findOrCreateChatId error", err);
      return null;
    }
  };

  // Resolve current user id
  useEffect(() => {
    let mounted = true;
    (async () => {
      let uId = await AsyncStorage.getItem("userId");
      if (!uId) {
        const nodeKey = await AsyncStorage.getItem("userNodeKey")
          || await AsyncStorage.getItem("studentNodeKey")
          || await AsyncStorage.getItem("studentId")
          || null;
        if (nodeKey) {
          try {
            const snap = await get(ref(database, `Users/${nodeKey}`));
            if (snap.exists()) {
              const v = snap.val();
              uId = v?.userId || nodeKey;
            } else {
              uId = nodeKey;
            }
          } catch {
            uId = nodeKey;
          }
        }
      }
      if (mounted) setCurrentUserId(uId || null);
    })();
    return () => { mounted = false; };
  }, []);

  // Resolve contactUserId if missing & attempt to set chatId if not provided by store
  useEffect(() => {
    let mounted = true;
    (async () => {
      if (!contactUserId && contactKey) {
        try {
          const snap = await get(ref(database, `Users/${contactKey}`));
          if (snap.exists()) {
            const v = snap.val();
            if (v && v.userId && mounted) {
              setContactUserId(v.userId);
              setContactName((prev) => prev || v.name || v.username || "");
              setContactImage((prev) => prev || v.profileImage || null);
            }
          }
        } catch (e) { /* ignore */ }
      }

      // If chatId wasn't provided via store, try to find existing chat deterministically
      if (!chatId && contactUserId && currentUserId) {
        const existing = await findExistingChatId(currentUserId, contactUserId);
        if (existing && mounted) setChatId(existing);
      }
    })();
    return () => { mounted = false; };
  }, [contactKey, contactUserId, currentUserId, chatId]);

  // Subscribe to messages for this chatId
  useEffect(() => {
    let mounted = true;
    const attach = async () => {
      if (!chatId) {
        setMessages([]);
        setLoading(false);
        console.log("[Messages] no chatId yet");
        return;
      }
      setLoading(true);
      const msgsRef = ref(database, `Chats/${chatId}/messages`);
      messagesRefRef.current = msgsRef;
      const listener = onValue(msgsRef, (snap) => {
        if (!mounted) return;
        const arr = [];
        if (snap.exists()) {
          snap.forEach((child) => arr.push(child.val()));
        }
        arr.sort((a, b) => Number(a.timeStamp || 0) - Number(b.timeStamp || 0));
        setMessages(arr);
        setLoading(false);
        console.log("[Messages:onValue]", { chatId, currentUserId, count: arr.length, senders: arr.map(m => m.senderId) });

        if (currentUserId) {
          try {
            update(ref(database, `Chats/${chatId}/unread`), { [currentUserId]: 0 }).catch(() => {});
            const updates = {};
            arr.forEach((m) => {
              if (m.receiverId === currentUserId && !m.seen) {
                updates[`Chats/${chatId}/messages/${m.messageId}/seen`] = true;
              }
            });
            if (Object.keys(updates).length) update(ref(database), updates).catch(() => {});
          } catch (err) {}
        }
      });
      messagesRefRef.current._listener = listener;
    };

    attach();

    return () => {
      mounted = false;
      if (messagesRefRef.current) {
        try { off(messagesRefRef.current); } catch (e) {}
      }
    };
  }, [chatId, currentUserId]);

  // Subscribe to lastMessage meta for seen ticks
  useEffect(() => {
    if (!chatId) {
      setLastMessageMeta(null);
      return;
    }
    const lastRef = ref(database, `Chats/${chatId}/lastMessage`);
    lastMessageRefRef.current = lastRef;
    const unsub = onValue(lastRef, (snap) => {
      if (snap.exists()) setLastMessageMeta(snap.val());
      else setLastMessageMeta(null);
    });
    return () => {
      try { off(lastRef); } catch (e) {}
      lastMessageRefRef.current = null;
    };
  }, [chatId]);

  // Auto-scroll
  useEffect(() => {
    setTimeout(() => {
      try { flatListRef.current && flatListRef.current.scrollToEnd({ animated: true }); } catch (e) {}
    }, 120);
  }, [messages]);

  // Helper to resolve user id
  const getResolvedUserId = async () => {
    if (currentUserId) return currentUserId;
    let uId = await AsyncStorage.getItem("userId");
    if (uId) return uId;
    const nodeKey = await AsyncStorage.getItem("userNodeKey")
      || await AsyncStorage.getItem("studentNodeKey")
      || await AsyncStorage.getItem("studentId")
      || null;
    if (!nodeKey) return null;
    try {
      const snap = await get(ref(database, `Users/${nodeKey}`));
      if (snap.exists()) {
        const v = snap.val();
        return v?.userId || nodeKey;
      }
    } catch {}
    return nodeKey;
  };

  // Create chat at deterministic id and append message
  const createChatAndSend = async (messagePayload) => {
    const cu = await getResolvedUserId();
    if (!cu || !contactUserId) {
      Alert.alert("Missing IDs", `currentUserId=${cu}\ncontactUserId=${contactUserId}\nCannot create chat`);
      return;
    }

    const chatKey = await findOrCreateChatId(cu, contactUserId, true);
    if (!chatKey) {
      Alert.alert("Create failed", "Could not create/find chat id");
      return;
    }

    const now = Date.now();
    const messageId = push(ref(database, `Chats/${chatKey}/messages`)).key;
    const messageObj = {
      messageId,
      senderId: cu,
      receiverId: contactUserId,
      text: messagePayload.text || "",
      timeStamp: messagePayload.timeStamp || now,
      type: messagePayload.type || "text",
      seen: false,
      edited: false,
      deleted: false,
    };

    const lastMessage = {
      seen: false,
      senderId: cu,
      text: messageObj.text,
      timeStamp: messageObj.timeStamp,
      type: messageObj.type,
    };

    // Build unread updates best-effort
    const updates = {
      [`Chats/${chatKey}/messages/${messageId}`]: messageObj,
      [`Chats/${chatKey}/lastMessage`]: lastMessage,
    };

    try {
      await update(ref(database), updates);
      setChatId(chatKey);
      setMessages((prev) => (prev.some((m) => m.messageId === messageId) ? prev : [...prev, messageObj]));
      setTimeout(async () => {
        try {
          const snap = await get(ref(database, `Chats/${chatKey}/messages`));
          if (snap.exists()) {
            const arr = [];
            snap.forEach((c) => arr.push(c.val()));
            arr.sort((a, b) => Number(a.timeStamp || 0) - Number(b.timeStamp || 0));
            setMessages(arr);
          }
        } catch {}
      }, 900);
    } catch (err) {
      console.warn("[Messages:createChatAndSend] error", err);
      Alert.alert("Send failed", "Could not create chat. Try again.");
    }
  };

  // Send message using deterministic chat id
  const sendMessage = async () => {
    if (!text.trim()) return;
    setSending(true);
    const now = Date.now();
    const payload = { text: text.trim(), timeStamp: now, type: "text" };

    try {
      const cu = await getResolvedUserId();
      if (!cu) {
        Alert.alert("Missing user id", "Cannot determine current user id.");
        setSending(false);
        return;
      }

      let chatKey = chatId;
      if (!chatKey) {
        chatKey = await findOrCreateChatId(cu, contactUserId, true);
        if (!chatKey) {
          Alert.alert("Chat error", "Could not find or create chat");
          setSending(false);
          return;
        }
        setChatId(chatKey);
      }

      const messageId = push(ref(database, `Chats/${chatKey}/messages`)).key;
      const messageObj = {
        messageId,
        senderId: cu,
        receiverId: contactUserId,
        text: payload.text,
        timeStamp: payload.timeStamp,
        type: payload.type,
        seen: false,
        edited: false,
        deleted: false,
      };

      // compute unread updates best-effort
      const chatRef = ref(database, `Chats/${chatKey}`);
      const chatSnap = await get(chatRef);
      let unreadObj = {};
      if (chatSnap.exists()) unreadObj = chatSnap.child("unread").val() || {};

      const unreadUpdates = {};
      if (chatSnap.exists()) {
        const parts = chatSnap.child("participants").val() || {};
        Object.keys(parts).forEach((p) => {
          if (p === cu) unreadUpdates[`Chats/${chatKey}/unread/${p}`] = 0;
          else {
            const prev = typeof unreadObj[p] === "number" ? unreadObj[p] : 0;
            unreadUpdates[`Chats/${chatKey}/unread/${p}`] = prev + 1;
          }
        });
      } else {
        unreadUpdates[`Chats/${chatKey}/unread/${contactUserId}`] = (unreadObj[contactUserId] || 0) + 1;
        unreadUpdates[`Chats/${chatKey}/unread/${cu}`] = 0;
      }

      const lastMessage = {
        seen: false,
        senderId: cu,
        text: payload.text,
        timeStamp: payload.timeStamp,
        type: payload.type,
      };

      const updates = {
        [`Chats/${chatKey}/messages/${messageId}`]: messageObj,
        [`Chats/${chatKey}/lastMessage`]: lastMessage,
        ...unreadUpdates,
      };

      console.log("[Messages:send] writing message", { chatKey, messageId, receiverId: contactUserId, senderId: cu });
      await update(ref(database), updates);

      // optimistic append + resync
      setMessages((prev) => (prev.some((m) => m.messageId === messageId) ? prev : [...prev, messageObj]));
      setTimeout(async () => {
        try {
          const snap = await get(ref(database, `Chats/${chatKey}/messages`));
          if (snap.exists()) {
            const arr = [];
            snap.forEach((c) => arr.push(c.val()));
            arr.sort((a, b) => Number(a.timeStamp || 0) - Number(b.timeStamp || 0));
            setMessages(arr);
          }
        } catch (e) {
          console.warn("[Messages:send] resync error", e);
        }
      }, 900);

      setText("");
    } catch (err) {
      console.warn("[Messages:send] error", err);
      Alert.alert("Send failed", "Could not send message — try again.");
    } finally {
      setSending(false);
    }
  };

  // Build display items with date separators
  const displayItems = useMemo(() => {
    const items = [];
    let lastDateLabel = null;
    messages.forEach((m) => {
      const label = dateLabelForTs(m.timeStamp);
      if (label !== lastDateLabel) {
        items.push({ type: "date", id: `date-${m.timeStamp}`, label });
        lastDateLabel = label;
      }
      items.push({ type: "message", ...m });
    });
    return items;
  }, [messages]);

  const renderDateSeparator = (label) => (
    <View style={styles.dateSeparator}>
      <View style={styles.dateLine} />
      <Text style={styles.dateText}>{label}</Text>
      <View style={styles.dateLine} />
    </View>
  );

  const renderMessage = ({ item, index }) => {
    if (item.type === "date") return <View style={{ paddingVertical: 10 }}>{renderDateSeparator(item.label)}</View>;
    const m = item;
    const isMe = String(m.senderId) === String(currentUserId);
    const prev = index > 0 ? displayItems[index - 1] : null;
    const prevSameSender = prev && prev.type === "message" && String(prev.senderId) === String(m.senderId);
    const showAvatar = !isMe && !prevSameSender;

    const isLastMessage =
      lastMessageMeta && m.messageId && lastMessageMeta.timeStamp && Number(lastMessageMeta.timeStamp) === Number(m.timeStamp);
    const seenFlag = !!m.seen || (isLastMessage && !!lastMessageMeta?.seen);

    return (
      <View style={[styles.messageRow, isMe ? styles.messageRowRight : styles.messageRowLeft]}>
        {!isMe && showAvatar && <Image source={contactImage ? { uri: contactImage } : AVATAR_PLACEHOLDER} style={styles.msgAvatar} />}
        {!isMe && !showAvatar && <View style={{ width: 36 }} />}

        <View style={[styles.bubbleWrap, isMe ? { alignItems: "flex-end" } : { alignItems: "flex-start" }]}>
          <View style={[styles.bubble, isMe ? styles.bubbleRight : styles.bubbleLeft]}>
            <Text style={[styles.bubbleText, isMe ? styles.bubbleTextRight : styles.bubbleTextLeft]}>{m.deleted ? "Message deleted" : m.text}</Text>
            <View style={styles.bubbleMetaRow}>
              <Text style={[styles.bubbleTime, isMe ? styles.bubbleTimeRight : styles.bubbleTimeLeft]}>{fmtTime(m.timeStamp)}</Text>
              {isMe && (
                <Ionicons
                  name={seenFlag ? "checkmark-done" : "checkmark"}
                  size={14}
                  color={seenFlag ? "#CBE8FF" : "rgba(255,255,255,0.75)"}
                  style={{ marginLeft: 8 }}
                />
              )}
            </View>
          </View>

          {!isMe ? (
            <View style={styles.leftTailContainer}>
              <View style={styles.leftTail} />
            </View>
          ) : (
            <View style={styles.rightTailContainer}>
              <View style={styles.rightTail} />
            </View>
          )}
        </View>

        {isMe && <View style={{ width: 36 }} />}
      </View>
    );
  };

  return (
    <SafeAreaView style={[styles.safe, { paddingTop: insets.top }]} edges={["bottom"]}>
      <StatusBar barStyle="dark-content" backgroundColor={BG} translucent={false} />
      <View style={[styles.container, { paddingBottom: insets.bottom }]}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity style={styles.back} onPress={() => router.back()}>
            <Ionicons name="chevron-back" size={22} color="#222" />
          </TouchableOpacity>

          <View style={styles.headerCenter}>
            <Text style={styles.headerName} numberOfLines={1}>{contactName || "Conversation"}</Text>
            <Text style={styles.headerSub}>{contactUserId ? `id: ${contactUserId}` : ""}</Text>
          </View>

          <TouchableOpacity style={styles.headerRight} onPress={() => Alert.alert("Contact", "Open contact profile")}>
            <Image source={contactImage ? { uri: contactImage } : AVATAR_PLACEHOLDER} style={styles.headerAvatar} />
          </TouchableOpacity>
        </View>

        {/* Messages */}
        <View style={styles.messagesWrap}>
          {loading ? (
            <ActivityIndicator size="small" color={PRIMARY} style={{ marginTop: 24 }} />
          ) : (
            <FlatList
              ref={flatListRef}
              data={displayItems}
              renderItem={renderMessage}
              keyExtractor={(it, idx) => (it.type === "date" ? it.id : it.messageId || `${it.timeStamp}-${idx}`)}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={{ paddingVertical: 12, paddingBottom: 24 }}
              onContentSizeChange={() => flatListRef.current && flatListRef.current.scrollToEnd({ animated: true })}
            />
          )}
        </View>

        {/* Input */}
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"}>
          <View style={[styles.inputRow, { paddingBottom: Math.max(insets.bottom, 8) }]}>
            <TextInput
              placeholder="Message"
              placeholderTextColor="#9AA4C0"
              value={text}
              onChangeText={setText}
              style={styles.input}
              multiline
              returnKeyType="send"
              onSubmitEditing={() => sendMessage()}
            />
            <TouchableOpacity
              style={[styles.sendBtn, (text.trim() ? styles.sendBtnActive : styles.sendBtnDisabled)]}
              onPress={sendMessage}
              disabled={!text.trim() || sending}
            >
              <Ionicons name="send" size={20} color={text.trim() ? "#fff" : "#BFCBEF"} />
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </View>
    </SafeAreaView>
  );
}

/* Styles (same as earlier) */
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: BG },
  container: { flex: 1, backgroundColor: BG },

  header: { height: 62, flexDirection: "row", alignItems: "center", paddingHorizontal: 12, borderBottomColor: "#F1F4FF", borderBottomWidth: 1, backgroundColor: BG },
  back: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  headerCenter: { flex: 1, alignItems: "center" },
  headerName: { fontSize: 16, fontWeight: "700", color: "#111", letterSpacing: 0.1 },
  headerSub: { fontSize: 12, color: MUTED, marginTop: 2 },
  headerRight: { width: 36, alignItems: "center", justifyContent: "center" },
  headerAvatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: "#F1F3F8" },

  messagesWrap: { flex: 1, paddingHorizontal: 12, backgroundColor: BG },

  messageRow: { flexDirection: "row", marginVertical: 6, alignItems: "flex-end" },
  messageRowLeft: { justifyContent: "flex-start" },
  messageRowRight: { justifyContent: "flex-end" },

  msgAvatar: { width: 36, height: 36, borderRadius: 18, marginRight: 8, backgroundColor: "#F1F3F8" },

  bubbleWrap: { maxWidth: "78%", position: "relative" },
  bubble: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 14,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.03,
    shadowRadius: 2,
    elevation: 0,
  },
  bubbleLeft: { backgroundColor: INCOMING_BG, borderTopLeftRadius: 6, borderTopRightRadius: 14, borderBottomRightRadius: 14, borderBottomLeftRadius: 14 },
  bubbleRight: { backgroundColor: OUTGOING_BG, borderTopRightRadius: 6, borderTopLeftRadius: 14, borderBottomRightRadius: 14, borderBottomLeftRadius: 14 },

  bubbleText: { fontSize: 15, lineHeight: 20 },
  bubbleTextLeft: { color: INCOMING_TEXT, fontWeight: "500" },
  bubbleTextRight: { color: OUTGOING_TEXT, fontWeight: "500" },

  bubbleMetaRow: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", marginTop: 6 },
  bubbleTime: { fontSize: 10, opacity: 0.9 },
  bubbleTimeLeft: { color: MUTED, textAlign: "left" },
  bubbleTimeRight: { color: "rgba(255,255,255,0.85)", textAlign: "right" },

  leftTailContainer: { position: "absolute", left: -6, bottom: -2, width: 12, height: 8, overflow: "hidden", alignItems: "flex-start" },
  leftTail: {
    width: 0,
    height: 0,
    borderLeftWidth: 6,
    borderRightWidth: 6,
    borderBottomWidth: 8,
    borderLeftColor: "transparent",
    borderRightColor: "transparent",
    borderBottomColor: INCOMING_BG,
    transform: [{ rotate: "180deg" }],
  },

  rightTailContainer: { position: "absolute", right: -6, bottom: -2, width: 12, height: 8, overflow: "hidden", alignItems: "flex-end" },
  rightTail: {
    width: 0,
    height: 0,
    borderLeftWidth: 6,
    borderRightWidth: 6,
    borderBottomWidth: 8,
    borderLeftColor: "transparent",
    borderRightColor: "transparent",
    borderBottomColor: OUTGOING_BG,
    transform: [{ rotate: "0deg" }],
  },

  dateSeparator: { flexDirection: "row", alignItems: "center", justifyContent: "center" },
  dateLine: { height: 1, backgroundColor: "#EEF4FF", flex: 1, marginHorizontal: 12 },
  dateText: { color: MUTED, fontSize: 12 },

  inputRow: { flexDirection: "row", alignItems: "flex-end", paddingHorizontal: 12, paddingVertical: 10, borderTopColor: "#F1F4FF", borderTopWidth: 1, backgroundColor: BG },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 140,
    paddingHorizontal: 12,
    paddingVertical: Platform.OS === "ios" ? 8 : 6,
    borderRadius: 20,
    backgroundColor: "#F8FAFF",
    color: "#111",
    fontSize: 15,
    marginRight: 8,
  },
  sendBtn: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  sendBtnActive: { backgroundColor: PRIMARY },
  sendBtnDisabled: { backgroundColor: "#F1F4FF" },
});