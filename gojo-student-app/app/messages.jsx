import React, { useEffect, useState, useRef } from "react";
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
  SafeAreaView,
  Alert,
  Keyboard,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { ref, push, update, get, onValue, off } from "firebase/database";
import { database } from "../constants/firebaseConfig";

/**
 * app/messages.jsx
 *
 * - Uses contactUserId passed in params when possible (props.route.params.contactUserId)
 * - Falls back to resolving contactKey if needed
 * - Respects SafeAreaView and status bar
 * - Hides avatar for consecutive messages from same sender
 */

const PRIMARY = "#007AFB";
const MUTED = "#6B78A8";
const BG = "#FFFFFF";
const INCOMING_BG = "#F1F4FF";
const OUTGOING_BG = "#007AFB";
const INCOMING_TEXT = "#111";
const OUTGOING_TEXT = "#fff";
const AVATAR_PLACEHOLDER = require("../assets/images/avatar_placeholder.png");

function fmtTime(ts) {
  if (!ts) return "";
  try {
    const d = new Date(Number(ts));
    const now = new Date();
    const diff = Math.floor((now - d) / 1000);
    if (diff < 60) return `${diff}s`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
    return d.toLocaleDateString();
  } catch {
    return "";
  }
}

export default function MessagesScreen(props) {
  const router = useRouter();
  const routeParams = (props && props.route && props.route.params) ? props.route.params : {};

  const chatIdParam = routeParams.chatId ?? "";
  const contactKeyParam = routeParams.contactKey ?? "";
  const contactUserIdParam = routeParams.contactUserId ?? ""; // preferred
  const contactNameParam = routeParams.contactName ?? "";
  const contactImageParam = routeParams.contactImage ?? null;

  const [currentUserId, setCurrentUserId] = useState(null);
  const [chatId, setChatId] = useState(chatIdParam || "");
  const [contactUserId, setContactUserId] = useState(contactUserIdParam || "");
  const [contactKey, setContactKey] = useState(contactKeyParam || "");
  const [contactName, setContactName] = useState(contactNameParam);
  const [contactImage, setContactImage] = useState(contactImageParam);

  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [text, setText] = useState("");

  const messagesRefRef = useRef(null);
  const flatListRef = useRef(null);

  // resolve currentUserId and contactUserId fallback
  useEffect(() => {
    let mounted = true;
    (async () => {
      // try to get userId directly from AsyncStorage
      let uId = await AsyncStorage.getItem("userId");
      if (!uId) {
        // fallback to userNodeKey -> Users/{node}.userId
        const nodeKey = await AsyncStorage.getItem("userNodeKey") || await AsyncStorage.getItem("studentNodeKey");
        if (nodeKey) {
          try {
            const snap = await get(ref(database, `Users/${nodeKey}`));
            if (snap.exists()) {
              const v = snap.val();
              if (v && v.userId) uId = v.userId;
            }
          } catch (e) {}
        }
      }
      if (mounted) setCurrentUserId(uId || null);

      // Prefer passed contactUserId; if missing, try to resolve from contactKey param (Users node key) or treat as userId
      if (contactUserIdParam) {
        setContactUserId(contactUserIdParam);
        return;
      }
      if (contactKeyParam) {
        try {
          const uNodeSnap = await get(ref(database, `Users/${contactKeyParam}`));
          if (uNodeSnap.exists()) {
            const uNode = uNodeSnap.val();
            if (uNode && uNode.userId) {
              setContactUserId(uNode.userId);
              setContactName((prev) => prev || uNode.name || uNode.username || "");
              setContactImage((prev) => prev || uNode.profileImage || null);
              return;
            }
          }
        } catch (e) {
          console.warn("messages: error resolving contactKey", e);
        }
        // fallback: treat contactKeyParam as userId
        setContactUserId(contactKeyParam);
      }
    })();
    return () => { mounted = false; };
  }, [contactKeyParam, contactUserIdParam]);

  // subscribe to messages
  useEffect(() => {
    let mounted = true;
    const attach = async () => {
      if (!chatId) {
        setMessages([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      const msgsRef = ref(database, `Chats/${chatId}/messages`);
      messagesRefRef.current = msgsRef;

      const listener = onValue(msgsRef, (snap) => {
        if (!mounted) return;
        const arr = [];
        if (snap.exists()) {
          snap.forEach((child) => {
            arr.push(child.val());
          });
        }
        arr.sort((a, b) => Number(a.timeStamp || 0) - Number(b.timeStamp || 0));
        setMessages(arr);
        setLoading(false);

        if (currentUserId) {
          try {
            update(ref(database, `Chats/${chatId}/unread`), { [currentUserId]: 0 }).catch(() => {});
            const updates = {};
            arr.forEach((m) => {
              if (m.receiverId === currentUserId && !m.seen) updates[`Chats/${chatId}/messages/${m.messageId}/seen`] = true;
            });
            if (Object.keys(updates).length > 0) update(ref(database), updates).catch(() => {});
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

  // auto-scroll when messages change
  useEffect(() => {
    setTimeout(() => {
      try {
        flatListRef.current && flatListRef.current.scrollToEnd({ animated: true });
      } catch (e) {}
    }, 120);
  }, [messages]);

  // create chat and send
  const createChatAndSend = async (messagePayload) => {
    if (!currentUserId || !contactUserId) {
      Alert.alert("Missing participant", "Cannot start chat: missing IDs.");
      return;
    }
    const chatsRoot = ref(database, "Chats");
    const newChatRef = push(chatsRoot);
    const newChatId = newChatRef.key;
    const now = Date.now();
    const lastMessage = {
      seen: false,
      senderId: currentUserId,
      text: messagePayload.text || "",
      timeStamp: messagePayload.timeStamp || now,
      type: messagePayload.type || "text",
    };
    const participants = { [currentUserId]: true, [contactUserId]: true };
    const unread = { [currentUserId]: 0, [contactUserId]: 1 };
    const messageId = push(ref(database, `Chats/${newChatId}/messages`)).key;
    const messageObj = {
      messageId,
      senderId: currentUserId,
      receiverId: contactUserId,
      text: messagePayload.text || "",
      timeStamp: messagePayload.timeStamp || now,
      type: messagePayload.type || "text",
      seen: false,
      edited: false,
      deleted: false,
    };

    const updates = {};
    updates[`Chats/${newChatId}/participants`] = participants;
    updates[`Chats/${newChatId}/lastMessage`] = lastMessage;
    updates[`Chats/${newChatId}/unread`] = unread;
    updates[`Chats/${newChatId}/messages/${messageId}`] = messageObj;

    try {
      await update(ref(database), updates);
      setChatId(newChatId);
    } catch (err) {
      console.warn("createChatAndSend error", err);
      Alert.alert("Send failed", "Could not create chat. Try again.");
    }
  };

  // send message
  const sendMessage = async () => {
    if (!text.trim()) return;
    setSending(true);
    const now = Date.now();
    const payload = { text: text.trim(), timeStamp: now, type: "text" };

    try {
      if (!chatId) {
        await createChatAndSend(payload);
        setText("");
        setSending(false);
        return;
      }

      const messagesRootRef = ref(database, `Chats/${chatId}/messages`);
      const newMsgRef = push(messagesRootRef);
      const messageId = newMsgRef.key;
      const messageObj = {
        messageId,
        senderId: currentUserId,
        receiverId: contactUserId,
        text: payload.text,
        timeStamp: payload.timeStamp,
        type: payload.type,
        seen: false,
        edited: false,
        deleted: false,
      };

      const chatRef = ref(database, `Chats/${chatId}`);
      const chatSnap = await get(chatRef);
      let unreadObj = {};
      if (chatSnap.exists()) unreadObj = chatSnap.child("unread").val() || {};

      const unreadUpdates = {};
      if (chatSnap.exists()) {
        const parts = chatSnap.child("participants").val() || {};
        Object.keys(parts).forEach((p) => {
          if (p === currentUserId) {
            unreadUpdates[`Chats/${chatId}/unread/${p}`] = 0;
          } else {
            const prev = typeof unreadObj[p] === "number" ? unreadObj[p] : 0;
            unreadUpdates[`Chats/${chatId}/unread/${p}`] = prev + 1;
          }
        });
      } else {
        unreadUpdates[`Chats/${chatId}/unread/${contactUserId}`] = (unreadObj[contactUserId] || 0) + 1;
        unreadUpdates[`Chats/${chatId}/unread/${currentUserId}`] = 0;
      }

      const lastMessage = {
        seen: false,
        senderId: currentUserId,
        text: payload.text,
        timeStamp: payload.timeStamp,
        type: payload.type,
      };

      const updates = {
        [`Chats/${chatId}/messages/${messageId}`]: messageObj,
        [`Chats/${chatId}/lastMessage`]: lastMessage,
        ...unreadUpdates,
      };

      await update(ref(database), updates);
      setText("");
    } catch (err) {
      console.warn("sendMessage error", err);
      Alert.alert("Send failed", "Could not send message — try again.");
    } finally {
      setSending(false);
    }
  };

  const renderMessage = ({ item, index }) => {
    const isMe = item.senderId === currentUserId;
    const prev = index > 0 ? messages[index - 1] : null;
    const showAvatar = !prev || prev.senderId !== item.senderId; // hide avatar for consecutive same-sender messages

    return (
      <View style={[styles.messageRow, isMe ? styles.messageRowRight : styles.messageRowLeft]}>
        {!isMe && showAvatar && <Image source={contactImage ? { uri: contactImage } : AVATAR_PLACEHOLDER} style={styles.msgAvatar} />}
        {!isMe && !showAvatar && <View style={{ width: 36 }} />} {/* spacer */}

        <View style={[styles.bubble, isMe ? styles.bubbleRight : styles.bubbleLeft]}>
          <Text style={[styles.bubbleText, isMe ? styles.bubbleTextRight : styles.bubbleTextLeft]}>{item.deleted ? "Message deleted" : item.text}</Text>
          <View style={styles.bubbleMetaRow}>
            <Text style={[styles.bubbleTime, isMe ? styles.bubbleTimeRight : styles.bubbleTimeLeft]}>{fmtTime(item.timeStamp)}</Text>
            {isMe && item.messageId && <Ionicons name={item.seen ? "checkmark-done" : "checkmark"} size={14} color={item.seen ? "#E6F2FF" : "rgba(255,255,255,0.7)"} style={{ marginLeft: 6 }} />}
          </View>
        </View>

        {isMe && <View style={{ width: 36 }} />}
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <StatusBar barStyle="dark-content" backgroundColor={BG} translucent={false} />
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity style={styles.back} onPress={() => router.back()}>
            <Ionicons name="chevron-back" size={22} color="#222" />
          </TouchableOpacity>

          <View style={styles.headerCenter}>
            <Text style={styles.headerName} numberOfLines={1}>{contactName || "Conversation"}</Text>
            <Text style={styles.headerSub}>{contactUserId ? `id:${contactUserId}` : ""}</Text>
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
              data={messages}
              renderItem={renderMessage}
              keyExtractor={(it) => it.messageId || String(it.timeStamp || Math.random())}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={{ paddingVertical: 12, paddingBottom: 24 }}
              onContentSizeChange={() => flatListRef.current && flatListRef.current.scrollToEnd({ animated: true })}
            />
          )}
        </View>

        {/* Input */}
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"}>
          <View style={styles.inputRow}>
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

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: BG },
  container: { flex: 1, backgroundColor: BG },

  header: { height: 62, flexDirection: "row", alignItems: "center", paddingHorizontal: 12, borderBottomColor: "#F1F4FF", borderBottomWidth: 1, backgroundColor: BG },
  back: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  headerCenter: { flex: 1, alignItems: "center" },
  headerName: { fontSize: 16, fontWeight: "700", color: "#111" },
  headerSub: { fontSize: 12, color: MUTED, marginTop: 2 },
  headerRight: { width: 36, alignItems: "center", justifyContent: "center" },
  headerAvatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: "#F1F3F8" },

  messagesWrap: { flex: 1, paddingHorizontal: 12, backgroundColor: BG },

  messageRow: { flexDirection: "row", marginVertical: 6, alignItems: "flex-end" },
  messageRowLeft: { justifyContent: "flex-start" },
  messageRowRight: { justifyContent: "flex-end" },

  msgAvatar: { width: 36, height: 36, borderRadius: 18, marginRight: 8, backgroundColor: "#F1F3F8" },

  bubble: { maxWidth: "78%", paddingVertical: 8, paddingHorizontal: 12, borderRadius: 12 },
  bubbleLeft: { backgroundColor: INCOMING_BG, borderTopLeftRadius: 4 },
  bubbleRight: { backgroundColor: OUTGOING_BG, borderTopRightRadius: 4 },

  bubbleText: { fontSize: 15, lineHeight: 20 },
  bubbleTextLeft: { color: INCOMING_TEXT },
  bubbleTextRight: { color: OUTGOING_TEXT },

  bubbleMetaRow: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", marginTop: 6 },
  bubbleTime: { fontSize: 10, opacity: 0.9 },
  bubbleTimeLeft: { color: MUTED, textAlign: "left" },
  bubbleTimeRight: { color: "rgba(255,255,255,0.85)", textAlign: "right" },

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