import React, { useEffect, useState, useRef } from "react";
import { Tabs, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Text, TouchableOpacity, View, Image, StyleSheet } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { ref, get, onValue, off } from "firebase/database";
import { database } from "../../constants/firebaseConfig";

/**
 * Dashboard layout (expo-router Tabs)
 * - Header: left "Gojo Study", right: chat icon + profile avatar
 * - Colors: primary #007AFB, white base
 */

const PRIMARY = "#007AFB";
const WHITE = "#FFFFFF";
const MUTED = "#6B78A8";

export default function DashboardLayout() {
  const router = useRouter();
  const [profileImage, setProfileImage] = useState(null);
  const [totalUnread, setTotalUnread] = useState(0);
  const chatsListenerRef = useRef(null);

  useEffect(() => {
    let userNodeKey = null;
    let userId = null;

    (async () => {
      userNodeKey = await AsyncStorage.getItem("userNodeKey");
      userId = await AsyncStorage.getItem("userId");

      try {
        if (userNodeKey) {
          const snap = await get(ref(database, `Users/${userNodeKey}`));
          if (snap.exists()) {
            setProfileImage(snap.val().profileImage || null);
          }
        }
      } catch (err) {
        console.warn("Failed to fetch user profile", err);
      }

      if (!userId) return;
      const chatsRef = ref(database, "Chats");
      const listener = onValue(chatsRef, (snap) => {
        if (!snap.exists()) {
          setTotalUnread(0);
          return;
        }
        let total = 0;
        snap.forEach((chatSnap) => {
          const unreadNode = chatSnap.child("unread");
          if (unreadNode.exists()) {
            const val = unreadNode.child(userId).val();
            if (typeof val === "number") total += val;
          }
        });
        setTotalUnread(total);
      });
      chatsListenerRef.current = () => off(chatsRef, "value", listener);
    })();

    return () => {
      if (chatsListenerRef.current) chatsListenerRef.current();
    };
  }, []);

  const HeaderLeft = () => <Text style={styles.titleText}>Gojo Study</Text>;

  const HeaderRight = () => (
    <View style={styles.headerRightRow}>
      <TouchableOpacity style={styles.iconButton} onPress={() => router.push("/chat")}>
        <Ionicons name="chatbubble-outline" size={22} color="#222" />
        {totalUnread > 0 && (
          <View style={styles.unreadBadge}>
            <Text style={styles.unreadText}>{totalUnread > 99 ? "99+" : totalUnread}</Text>
          </View>
        )}
      </TouchableOpacity>

      <TouchableOpacity onPress={() => router.push("/profile")} style={{ marginLeft: 12 }}>
        <Image
          source={
            profileImage
              ? { uri: profileImage }
              : require("../../assets/images/avatar_placeholder.png")
          }
          style={styles.profileImage}
        />
      </TouchableOpacity>
    </View>
  );

  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: WHITE },
        headerTitleAlign: "left",
        headerTitle: () => <HeaderLeft />,
        headerRight: () => <HeaderRight />,
        tabBarActiveTintColor: PRIMARY,
        tabBarInactiveTintColor: "#BFD9FF",
        tabBarStyle: { height: 62, backgroundColor: WHITE },
        tabBarLabelStyle: { fontSize: 12 },
      }}
    >
      <Tabs.Screen
        name="home"
        options={{
          title: "Home",
          tabBarIcon: ({ color, size }) => <Ionicons name="home-outline" size={size} color={color} />,
        }}
      />

      <Tabs.Screen
        name="book"
        options={{
          title: "Books",
          tabBarIcon: ({ color, size }) => <Ionicons name="book-outline" size={size} color={color} />,
        }}
      />

      <Tabs.Screen
        name="exam"
        options={{
          title: "Exams",
          tabBarIcon: ({ color, size }) => <Ionicons name="clipboard-outline" size={size} color={color} />,
        }}
      />

      <Tabs.Screen
        name="classMark"
        options={{
          title: "Class Mark",
          tabBarIcon: ({ color, size }) => <Ionicons name="reader-outline" size={size} color={color} />,
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  titleText: { fontSize: 20, color: "#222", fontWeight: "700", marginLeft: 8 },
  headerRightRow: { flexDirection: "row", alignItems: "center", marginRight: 12 },
  profileImage: { width: 38, height: 38, borderRadius: 19, borderWidth: 0.5, borderColor: "#EFEFF4", backgroundColor: "#F6F8FF" },
  iconButton: { width: 38, height: 38, borderRadius: 10, alignItems: "center", justifyContent: "center", position: "relative" },
  unreadBadge: { position: "absolute", right: -6, top: -6, minWidth: 18, height: 18, borderRadius: 9, backgroundColor: "#FF3B30", alignItems: "center", justifyContent: "center", paddingHorizontal: 4 },
  unreadText: { color: "#fff", fontSize: 10, fontWeight: "700" },
});