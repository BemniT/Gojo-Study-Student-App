// dashboard/_layout.jsx
import React, { useEffect, useState } from "react";
import { View, ActivityIndicator } from "react-native";
import { Slot, useRouter } from "expo-router";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { Ionicons } from "@expo/vector-icons";
import { auth } from "../../constants/firebaseConfig"; // Firebase config
import { onAuthStateChanged } from "firebase/auth";

// Import your tabs
import Home from "./home";
import ClassMark from "./classMark";
import Messages from "./exam";
import Settings from "./book";

const Tab = createBottomTabNavigator();

export default function DashboardLayout() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState(null);

  // Check if user is logged in
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      if (currentUser) {
        setUser(currentUser);
      } else {
        router.replace("/index"); // Redirect to login if not logged in
      }
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
        <ActivityIndicator size="large" color="#0000ff" />
      </View>
    );
  }

  // Bottom Tab Navigator for dashboard
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarIcon: ({ color, size }) => {
          let iconName;

          if (route.name === "home") iconName = "home-outline";
          else if (route.name === "classMark") iconName = "school-outline";
          else if (route.name === "book") iconName = "chatbubble-outline";
          else if (route.name === "exam") iconName = "settings-outline";

          return <Ionicons name={iconName} size={size} color={color} />;
        },
        tabBarActiveTintColor: "#007AFF",
        tabBarInactiveTintColor: "gray",
      })}
    >
      <Tab.Screen name="home" component={Home} />
      <Tab.Screen name="classMark" component={ClassMark} />
      <Tab.Screen name="book" component={Book} />
      <Tab.Screen name="exam" component={Exam} />
    </Tab.Navigator>
  );
}