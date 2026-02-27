// app/messages.jsx
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
  Platform,
  Alert,
  Keyboard,
  Modal,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { ref, push, update, get, onValue, off } from "firebase/database";
import { getStorage, ref as storageRef, uploadBytes, getDownloadURL } from "firebase/storage";
import * as ImagePicker from "expo-image-picker";
import { database } from "../constants/firebaseConfig";
import { getOpenedChat, clearOpenedChat } from "./lib/chatStore";
import { useSafeAreaInsets, SafeAreaView } from "react-native-safe-area-context";

/**
 * app/messages.jsx
 * - Updates chats cache with lastSenderId and lastSeen when sending so Chats shows seen state instantly.
 * - Keeps previous features (image upload, viewer, optimistic UI, keyboard handling).
 */

const PRIMARY = "#007AFB";
const MUTED = "#6B78A8";
const BG = "#FFFFFF";
const INCOMING_BG = "#F6F7FB";
const OUTGOING_BG = "#007AFB";
const INCOMING_TEXT = "#111";
const OUTGOING_TEXT = "#fff";
const AVATAR_PLACEHOLDER = require("../assets/images/avatar_placeholder.png");

function fmtTime12(ts) {
  if (!ts) return "";
  try {
    const d = new Date(Number(ts));
    let h = d.getHours();
    const m = d.getMinutes().toString().padStart(2, "0");
    const ampm = h >= 12 ? "PM" : "AM";
    h = h % 12;
    if (h === 0) h = 12;
    return `${h}:${m} ${ampm}`;
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
  const storage = getStorage();

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
  const [currentUserNodeKey, setCurrentUserNodeKey] = useState(null);
  const [chatId, setChatId] = useState(chatFromStore.chatId || "");
  const [contactUserId, setContactUserId] = useState(chatFromStore.contactUserId || "");
  const [contactKey, setContactKey] = useState(chatFromStore.contactKey || "");
  const [contactName, setContactName] = useState(chatFromStore.contactName || "");
  const [contactImage, setContactImage] = useState(chatFromStore.contactImage || null);
  const [contactSubtitle, setContactSubtitle] = useState(""); // subject/role to show under name

  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [text, setText] = useState("");
  const [lastMessageMeta, setLastMessageMeta] = useState(null);

  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [keyboardVisible, setKeyboardVisible] = useState(false);

  const [viewerVisible, setViewerVisible] = useState(false);
  const [viewerImages, setViewerImages] = useState([]);
  const [viewerIndex, setViewerIndex] = useState(0);
  const [viewerFallbackUri, setViewerFallbackUri] = useState(null);
  const [viewerLibAvailable, setViewerLibAvailable] = useState(null);

  const messagesRefRef = useRef(null);
  const lastMessageRefRef = useRef(null);
  const flatListRef = useRef(null);

  const makeDeterministicChatId = (a, b) => `${a}_${b}`;

  // Resolve local ids
  useEffect(() => {
    let mounted = true;
    (async () => {
      let uId = await AsyncStorage.getItem("userId");
      const nodeKey =
        (await AsyncStorage.getItem("userNodeKey")) ||
        (await AsyncStorage.getItem("studentNodeKey")) ||
        (await AsyncStorage.getItem("studentId")) ||
        null;

      if (!uId && nodeKey) {
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

      if (mounted) {
        setCurrentUserId(uId || null);
        setCurrentUserNodeKey(nodeKey || null);
      }
    })();
    return () => { mounted = false; };
  }, []);

  // Resolve contactUserId & subtitle (subject/role) if missing
  useEffect(() => {
    let mounted = true;
    (async () => {
      if (!contactKey) return;
      try {
        const snap = await get(ref(database, `Users/${contactKey}`));
        if (snap.exists()) {
          const v = snap.val();
          if (v && v.userId && mounted) {
            setContactUserId(v.userId);
            setContactName((prev) => prev || v.name || v.username || "");
            setContactImage((prev) => prev || v.profileImage || null);
            // prefer subject, then role/designation
            const subtitle = (v.subject && String(v.subject).trim()) ? v.subject : (v.role || v.designation || "");
            setContactSubtitle(subtitle || "");
            return;
          }
        }
      } catch (e) {
        // ignore
      }
      // fallback: don't show id as subtitle
      if (mounted) setContactSubtitle("");
    })();
    return () => { mounted = false; };
  }, [contactKey]);

  // findOrCreateChatId
  async function findOrCreateChatId(userA, userB, createIfMissing = true) {
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
  }

  // Attach listener and normalize messages
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
            const data = child.val() || {};
            const m = { ...data, messageId: data.messageId || child.key };
            arr.push(m);
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
              if ((String(m.receiverId) === String(currentUserId) || String(m.receiverId) === String(currentUserNodeKey)) && !m.seen) {
                updates[`Chats/${chatId}/messages/${m.messageId}/seen`] = true;
              }
            });
            if (Object.keys(updates).length) update(ref(database), updates).catch(() => {});
          } catch (err) {
            console.warn("[Messages] mark seen error", err);
          }
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
  }, [chatId, currentUserId, currentUserNodeKey]);

  // lastMessage meta listener
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

  // Keyboard listeners
  useEffect(() => {
    const onShow = (e) => {
      setKeyboardVisible(true);
      const h = (e && e.endCoordinates && e.endCoordinates.height) ? e.endCoordinates.height : 300;
      setKeyboardHeight(h);
    };
    const onHide = () => {
      setKeyboardVisible(false);
      setKeyboardHeight(0);
    };

    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";

    const subShow = Keyboard.addListener(showEvent, onShow);
    const subHide = Keyboard.addListener(hideEvent, onHide);

    return () => {
      subShow.remove();
      subHide.remove();
    };
  }, []);

  const getResolvedUserId = async () => {
    if (currentUserId) return currentUserId;
    let uId = await AsyncStorage.getItem("userId");
    if (uId) return uId;
    const nodeKey = await AsyncStorage.getItem("userNodeKey") || await AsyncStorage.getItem("studentNodeKey") || await AsyncStorage.getItem("studentId") || null;
    if (!nodeKey) return null;
    try {
      const snap = await get(ref(database, `Users/${nodeKey}`));
      if (snap.exists()) return snap.val()?.userId || nodeKey;
    } catch {}
    return nodeKey;
  };

  // helper: update chatsCache in AsyncStorage so Chats shows optimistic lastMessage instantly
  // now stores lastSenderId and lastSeen
  async function updateChatsCacheWithLastMessage({ contactKeyLocal, contactUserIdLocal, lastMessageText, timeStamp, lastSenderId = null, lastSeen = false }) {
    try {
      const raw = await AsyncStorage.getItem("chatsCache");
      const cache = raw ? JSON.parse(raw) : [];
      let updated = false;
      const tsNum = Number(timeStamp || Date.now());

      for (let i = 0; i < cache.length; i++) {
        const it = cache[i];
        // match by node key or by userId
        if ((contactKeyLocal && it.key && String(it.key) === String(contactKeyLocal)) || (contactUserIdLocal && it.userId && String(it.userId) === String(contactUserIdLocal))) {
          // only update if our timestamp is newer
          const existingTs = Number(it.lastTime || 0);
          if (tsNum >= existingTs) {
            it.lastMessage = lastMessageText;
            it.lastTime = tsNum;
            it.lastSenderId = lastSenderId;
            it.lastSeen = !!lastSeen;
            cache[i] = it;
            updated = true;
          }
          break;
        }
      }
      if (!updated) {
        // if contact not present, append new cached contact entry so Chats shows it
        const newItem = {
          key: contactKeyLocal || contactUserIdLocal || `u_${Date.now()}`,
          userId: contactUserIdLocal || "",
          name: contactName || "Conversation",
          role: "",
          profileImage: contactImage || null,
          type: "unknown",
          chatId: chatId || "",
          lastMessage: lastMessageText,
          lastTime: tsNum,
          lastSenderId: lastSenderId,
          lastSeen: !!lastSeen,
          unread: 0,
        };
        cache.unshift(newItem);
        updated = true;
      }
      if (updated) {
        await AsyncStorage.setItem("chatsCache", JSON.stringify(cache));
        await AsyncStorage.setItem("chatsCacheFetchedAt", String(Date.now()));
      }
    } catch (e) {
      // ignore cache update errors
      console.warn("[Messages] updateChatsCacheWithLastMessage error", e);
    }
  }

  // helper: uri -> blob
  async function uriToBlob(uri) {
    return await new Promise((resolve, reject) => {
      try {
        const xhr = new XMLHttpRequest();
        xhr.onload = function () {
          resolve(xhr.response);
        };
        xhr.onerror = function () {
          reject(new TypeError("Network request failed"));
        };
        xhr.responseType = "blob";
        xhr.open("GET", uri, true);
        xhr.send(null);
      } catch (err) {
        reject(err);
      }
    });
  }

  // pickImageAndSend (keeps robust behavior)
  async function pickImageAndSend() {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert("Permission required", "Please allow access to photos to attach images.");
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaType?.Images ?? ImagePicker.MediaTypeOptions?.Images ?? ImagePicker.MediaTypeOptions.Images,
        quality: 0.7,
        allowsEditing: false,
      });

      const cancelled = result.cancelled ?? result.canceled;
      if (cancelled) return;

      const localUri = result.uri ?? (result.assets && result.assets[0] && result.assets[0].uri);
      if (!localUri) return;

      const cu = await getResolvedUserId();
      if (!cu) {
        Alert.alert("Missing user id", "Cannot determine current user id.");
        return;
      }
      let chatKeyLocal = chatId;
      if (!chatKeyLocal) {
        chatKeyLocal = await findOrCreateChatId(cu, contactUserId, true);
        if (!chatKeyLocal) {
          Alert.alert("Chat error", "Could not find or create chat");
          return;
        }
        setChatId(chatKeyLocal);
      }

      const messageId = push(ref(database, `Chats/${chatKeyLocal}/messages`)).key;
      const now = Date.now();

      const localMessage = {
        messageId,
        senderId: cu,
        receiverId: contactUserId,
        text: "",
        timeStamp: now,
        type: "image",
        imageUrl: localUri,
        uploading: true,
      };
      // optimistic append
      setMessages((prev) => (prev.some((m) => m.messageId === messageId) ? prev : [...prev, localMessage]));

      // update local chats cache immediately (non-blocking) including lastSenderId & lastSeen
      updateChatsCacheWithLastMessage({
        contactKeyLocal: contactKey || null,
        contactUserIdLocal: contactUserId || null,
        lastMessageText: "📷 Image",
        timeStamp: now,
        lastSenderId: cu,
        lastSeen: false,
      }).catch(() => {});

      const blob = await uriToBlob(localUri);

      const path = `chatImages/${chatKeyLocal}/${messageId}.jpg`;
      const storageReference = storageRef(storage, path);
      await uploadBytes(storageReference, blob);
      const downloadUrl = await getDownloadURL(storageReference);

      const messageObj = {
        messageId,
        senderId: cu,
        receiverId: contactUserId,
        text: "",
        timeStamp: now,
        type: "image",
        imageUrl: downloadUrl,
        seen: false,
        edited: false,
        deleted: false,
      };

      const lastMessage = {
        seen: false,
        senderId: cu,
        text: "📷 Image",
        timeStamp: now,
        type: "image",
      };

      const updates = {
        [`Chats/${chatKeyLocal}/messages/${messageId}`]: messageObj,
        [`Chats/${chatKeyLocal}/lastMessage`]: lastMessage,
        [`Chats/${chatKeyLocal}/unread/${contactUserId}`]: 1,
        [`Chats/${chatKeyLocal}/unread/${cu}`]: 0,
      };

      await update(ref(database), updates);

      // resync
      setTimeout(async () => {
        try {
          const snap = await get(ref(database, `Chats/${chatKeyLocal}/messages`));
          if (snap.exists()) {
            const arr = [];
            snap.forEach((c) => {
              const data = c.val() || {};
              arr.push({ ...data, messageId: data.messageId || c.key });
            });
            arr.sort((a, b) => Number(a.timeStamp || 0) - Number(b.timeStamp || 0));
            setMessages(arr);
          }
        } catch (e) {
          console.warn("[Messages:upload] resync error", e);
        }
      }, 900);
    } catch (err) {
      console.warn("[Messages:pickImageAndSend] error", err);
      Alert.alert("Upload failed", "Could not upload image. Try again.");
    }
  }

  // createChatAndSend & sendMessage function declarations (kept as previously)
  async function createChatAndSend(messagePayload) {
    const cu = await getResolvedUserId();
    if (!cu || !contactUserId) {
      Alert.alert("Missing IDs", `currentUserId=${cu}\ncontactUserId=${contactUserId}\nCannot create chat`);
      return;
    }

    const chatKeyLocal = await findOrCreateChatId(cu, contactUserId, true);
    if (!chatKeyLocal) {
      Alert.alert("Create failed", "Could not create/find chat id");
      return;
    }

    const now = Date.now();
    const messageId = push(ref(database, `Chats/${chatKeyLocal}/messages`)).key;
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
      text: messagePayload.type === "image" ? "📷 Image" : messageObj.text,
      timeStamp: messageObj.timeStamp,
      type: messageObj.type,
    };

    const updates = {
      [`Chats/${chatKeyLocal}/messages/${messageId}`]: messageObj,
      [`Chats/${chatKeyLocal}/lastMessage`]: lastMessage,
    };

    try {
      await update(ref(database), updates);
      setChatId(chatKeyLocal);
      setMessages((prev) => (prev.some((m) => m.messageId === messageId) ? prev : [...prev, messageObj]));

      // update cache so Chats shows the new message immediately (non-blocking)
      updateChatsCacheWithLastMessage({
        contactKeyLocal: contactKey || null,
        contactUserIdLocal: contactUserId || null,
        lastMessageText: lastMessage.text,
        timeStamp: lastMessage.timeStamp,
        lastSenderId: cu,
        lastSeen: false,
      }).catch(() => {});

      setTimeout(async () => {
        try {
          const snap = await get(ref(database, `Chats/${chatKeyLocal}/messages`));
          if (snap.exists()) {
            const arr = [];
            snap.forEach((c) => {
              const data = c.val() || {};
              arr.push({ ...data, messageId: data.messageId || c.key });
            });
            arr.sort((a, b) => Number(a.timeStamp || 0) - Number(b.timeStamp || 0));
            setMessages(arr);
          }
        } catch (e) {}
      }, 900);
    } catch (err) {
      console.warn("[Messages:createChatAndSend] error", err);
      Alert.alert("Send failed", "Could not create chat. Try again.");
    }
  }

  async function sendMessage() {
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

      let chatKeyLocal = chatId;
      if (!chatKeyLocal) {
        chatKeyLocal = await findOrCreateChatId(cu, contactUserId, true);
        if (!chatKeyLocal) {
          Alert.alert("Chat error", "Could not find or create chat");
          setSending(false);
          return;
        }
        setChatId(chatKeyLocal);
      }

      const messageId = push(ref(database, `Chats/${chatKeyLocal}/messages`)).key;
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

      const chatRef = ref(database, `Chats/${chatKeyLocal}`);
      const chatSnap = await get(chatRef);
      let unreadObj = {};
      if (chatSnap.exists()) unreadObj = chatSnap.child("unread").val() || {};

      const unreadUpdates = {};
      if (chatSnap.exists()) {
        const parts = chatSnap.child("participants").val() || {};
        Object.keys(parts).forEach((p) => {
          if (p === cu) unreadUpdates[`Chats/${chatKeyLocal}/unread/${p}`] = 0;
          else {
            const prev = typeof unreadObj[p] === "number" ? unreadObj[p] : 0;
            unreadUpdates[`Chats/${chatKeyLocal}/unread/${p}`] = prev + 1;
          }
        });
      } else {
        unreadUpdates[`Chats/${chatKeyLocal}/unread/${contactUserId}`] = (unreadObj[contactUserId] || 0) + 1;
        unreadUpdates[`Chats/${chatKeyLocal}/unread/${cu}`] = 0;
      }

      const lastMessage = {
        seen: false,
        senderId: cu,
        text: payload.text,
        timeStamp: payload.timeStamp,
        type: payload.type,
      };

      const updates = {
        [`Chats/${chatKeyLocal}/messages/${messageId}`]: messageObj,
        [`Chats/${chatKeyLocal}/lastMessage`]: lastMessage,
        ...unreadUpdates,
      };

      console.log("[Messages:send] writing message", { chatKeyLocal, messageId, receiverId: contactUserId, senderId: cu });

      // optimistic append locally
      setMessages((prev) => (prev.some((m) => m.messageId === messageId) ? prev : [...prev, messageObj]));

      // update local cache immediately (non-blocking) so Chats reflects the new message instantly
      updateChatsCacheWithLastMessage({
        contactKeyLocal: contactKey || null,
        contactUserIdLocal: contactUserId || null,
        lastMessageText: lastMessage.text,
        timeStamp: lastMessage.timeStamp,
        lastSenderId: cu,
        lastSeen: false,
      }).catch(() => {});

      // write to server
      await update(ref(database), updates);

      // re-sync after short delay
      setTimeout(async () => {
        try {
          const snap = await get(ref(database, `Chats/${chatKeyLocal}/messages`));
          if (snap.exists()) {
            const arr = [];
            snap.forEach((c) => {
              const data = c.val() || {};
              arr.push({ ...data, messageId: data.messageId || c.key });
            });
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
  }

  // image viewer open/close (fallback modal used if viewer lib missing)
  function closeViewer() {
    setViewerVisible(false);
    setViewerImages([]);
    setViewerIndex(0);
    setViewerFallbackUri(null);
  }

  async function openImageViewer(message) {
    const uri = message.imageUrl || message.imageUri || message.image || null;
    if (!uri) return;

    if (viewerLibAvailable === null) {
      try {
        await import("react-native-image-viewing");
        setViewerLibAvailable(true);
      } catch (e) {
        setViewerLibAvailable(false);
      }
    }

    if (viewerLibAvailable) {
      setViewerImages([{ uri }]);
      setViewerIndex(0);
      setViewerVisible(true);
      return;
    }

    // fallback modal
    setViewerFallbackUri(uri);
    setViewerVisible(true);
  }

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
    const isMe =
      (currentUserId && String(m.senderId) === String(currentUserId)) ||
      (currentUserNodeKey && String(m.senderId) === String(currentUserNodeKey));

    const prev = index > 0 ? displayItems[index - 1] : null;
    const prevSameSender = prev && prev.type === "message" && String(prev.senderId) === String(m.senderId);
    const showAvatar = !isMe && !prevSameSender;

    const isLastMessage =
      lastMessageMeta && m.messageId && lastMessageMeta.timeStamp && Number(lastMessageMeta.timeStamp) === Number(m.timeStamp);
    const seenFlag = !!m.seen || (isLastMessage && !!lastMessageMeta?.seen);

    // image message
    if (m.type === "image") {
      const imageSource = m.imageUrl ? { uri: m.imageUrl } : (m.imageUrlLocal ? { uri: m.imageUrlLocal } : AVATAR_PLACEHOLDER);
      if (isMe) {
        return (
          <View style={[styles.messageRow, styles.messageRowRight]}>
            <View style={{ flex: 1 }} />
            <View style={{ marginRight: 8 }}>
              <TouchableOpacity activeOpacity={0.9} onPress={() => openImageViewer(m)}>
                <Image source={imageSource} style={styles.outgoingImage} />
                <View style={styles.imageMeta}>
                  <Text style={styles.imageTime}>{fmtTime12(m.timeStamp)}</Text>
                  <Ionicons
                    name={seenFlag ? "checkmark-done" : "checkmark"}
                    size={14}
                    color={seenFlag ? "#CBE8FF" : "rgba(255,255,255,0.75)"}
                    style={{ marginLeft: 8 }}
                  />
                </View>
              </TouchableOpacity>
              <View style={styles.rightTailContainer}><View style={styles.rightTail} /></View>
            </View>
            <View style={{ width: 36 }} />
          </View>
        );
      } else {
        return (
          <View style={[styles.messageRow, styles.messageRowLeft]}>
            {showAvatar ? <Image source={contactImage ? { uri: contactImage } : AVATAR_PLACEHOLDER} style={styles.msgAvatar} /> : <View style={{ width: 36 }} />}
            <View style={{ width: 8 }} />
            <View>
              <TouchableOpacity activeOpacity={0.9} onPress={() => openImageViewer(m)}>
                <Image source={imageSource} style={styles.incomingImage} />
                <View style={styles.incomingImageMeta}>
                  <Text style={styles.imageTimeIncoming}>{fmtTime12(m.timeStamp)}</Text>
                </View>
              </TouchableOpacity>
              <View style={styles.leftTailContainer}><View style={styles.leftTail} /></View>
            </View>
            <View style={{ flex: 1 }} />
          </View>
        );
      }
    }

    // text message
    return (
      <View style={[styles.messageRow, isMe ? styles.messageRowRight : styles.messageRowLeft]}>
        {!isMe && showAvatar && <Image source={contactImage ? { uri: contactImage } : AVATAR_PLACEHOLDER} style={styles.msgAvatar} />}
        {!isMe && !showAvatar && <View style={{ width: 36 }} />}

        <View style={[styles.bubbleWrap, isMe ? { alignItems: "flex-end" } : { alignItems: "flex-start" }]}>
          <View style={[styles.bubble, isMe ? styles.bubbleRight : styles.bubbleLeft]}>
            <Text style={[styles.bubbleText, isMe ? styles.bubbleTextRight : styles.bubbleTextLeft]}>{m.deleted ? "Message deleted" : m.text}</Text>
            <View style={styles.bubbleMetaRow}>
              <Text style={[styles.bubbleTime, isMe ? styles.bubbleTimeRight : styles.bubbleTimeLeft]}>{fmtTime12(m.timeStamp)}</Text>
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
            <Text style={styles.headerSub}>{contactSubtitle || ""}</Text>
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
              contentContainerStyle={{ paddingVertical: 12, paddingBottom: 12 + (keyboardVisible ? keyboardHeight : 0) }}
              onContentSizeChange={() => flatListRef.current && flatListRef.current.scrollToEnd({ animated: true })}
            />
          )}
        </View>

        {/* Input */}
        <View style={[styles.inputRow, { paddingBottom: Math.max(insets.bottom, 8), marginBottom: keyboardVisible ? keyboardHeight : 0 }]}>
          <TouchableOpacity onPress={pickImageAndSend} style={styles.attachmentBtn}>
            <Ionicons name="image-outline" size={22} color={MUTED} />
          </TouchableOpacity>

          <TextInput
            placeholder="Message"
            placeholderTextColor="#9AA4C0"
            value={text}
            onChangeText={setText}
            style={styles.input}
            multiline
            returnKeyType="send"
            onSubmitEditing={sendMessage}
          />
          <TouchableOpacity
            style={[styles.sendBtn, (text.trim() ? styles.sendBtnActive : styles.sendBtnDisabled)]}
            onPress={sendMessage}
            disabled={!text.trim() || sending}
          >
            <Ionicons name="send" size={20} color={text.trim() ? "#fff" : "#BFCBEF"} />
          </TouchableOpacity>
        </View>

        {/* Viewer fallback modal */}
        <Modal visible={viewerVisible && !viewerLibAvailable} transparent animationType="fade" onRequestClose={closeViewer}>
          <View style={styles.modalOverlay}>
            <TouchableOpacity style={styles.modalCloseBtn} onPress={closeViewer}>
              <Ionicons name="close" size={28} color="#fff" />
            </TouchableOpacity>
            <View style={styles.modalContent}>
              {viewerFallbackUri ? (
                <Image source={{ uri: viewerFallbackUri }} style={styles.modalImage} resizeMode="contain" />
              ) : viewerImages.length ? (
                <Image source={{ uri: viewerImages[0].uri }} style={styles.modalImage} resizeMode="contain" />
              ) : null}
            </View>
          </View>
        </Modal>
      </View>
    </SafeAreaView>
  );
}

/* Styles (unchanged from previous) */
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
  bubbleRight: { backgroundColor: OUTGOING_BG, borderTopRightRadius: 6, borderTopLeftRadius: 14, borderBottomRightRadius: 14, borderBottomLeftRadius: 14, marginRight: -20 },

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

  rightTailContainer: { position: "absolute", right: -28, bottom: -2, width: 12, height: 8, overflow: "hidden", alignItems: "flex-end" },
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

  incomingImage: { width: 220, height: 140, borderRadius: 12, resizeMode: "cover", backgroundColor: "#eaeefb" },
  outgoingImage: { width: 220, height: 140, borderRadius: 12, resizeMode: "cover", backgroundColor: "#005ecc" , marginRight: -20},
  imageMeta: { position: "absolute", right: 8, bottom: 6, flexDirection: "row", alignItems: "center" },
  incomingImageMeta: { position: "absolute", left: 8, bottom: 6, flexDirection: "row", alignItems: "center" },
  imageTime: { color: "rgba(255,255,255,0.9)", fontSize: 11 },
  imageTimeIncoming: { color: MUTED, fontSize: 11 },

  dateSeparator: { flexDirection: "row", alignItems: "center", justifyContent: "center" },
  dateLine: { height: 1, backgroundColor: "#EEF4FF", flex: 1, marginHorizontal: 12 },
  dateText: { color: MUTED, fontSize: 12 },

  inputRow: { flexDirection: "row", alignItems: "flex-end", paddingHorizontal: 8, paddingVertical: 10, borderTopColor: "#F1F4FF", borderTopWidth: 1, backgroundColor: BG },
  attachmentBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center", marginRight: 6 },
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

  // modal fallback styles
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.95)", justifyContent: "center", alignItems: "center" },
  modalContent: { flex: 1, justifyContent: "center", alignItems: "center", width: "100%", padding: 12 },
  modalImage: { width: "100%", height: "100%" },
  modalCloseBtn: { position: "absolute", top: 40, right: 20, zIndex: 20 },
});