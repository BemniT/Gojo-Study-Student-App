import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SafeAreaView, StyleSheet, View, Text, TouchableOpacity, Animated, Easing } from "react-native";
import { Slot, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { getValue } from "./lib/dbHelpers";

type Notif = {
  id: string;
  title?: string;
  body?: string;
  deepLink?: string;
  createdAt?: number;
  type?: string;
  grades?: Record<string, boolean>;
  meta?: {
    packageId?: string;
    subjectKey?: string;
    roundId?: string;
    examId?: string;
    questionBankId?: string;
  };
};

export default function RootLayout() {
  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="auto" />
      <GlobalNotificationToast />
      <Slot />
    </SafeAreaView>
  );
}

function GlobalNotificationToast() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [current, setCurrent] = useState<Notif | null>(null);
  const [queue, setQueue] = useState<Notif[]>([]);
  const [studentId, setStudentId] = useState<string | null>(null);
  const seenIdsRef = useRef<Set<string>>(new Set());

  const slideY = useRef(new Animated.Value(-90)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const bar = useRef(new Animated.Value(1)).current;

  const notifVisual = useCallback((type?: string) => {
    const t = String(type || "").toLowerCase();
    if (t === "new_package") return { icon: "cube-outline" as const, color: "#2563EB", bg: "#EFF6FF" };
    if (t === "new_round") return { icon: "layers-outline" as const, color: "#7C3AED", bg: "#F5F3FF" };
    if (t === "round_live") return { icon: "flash-outline" as const, color: "#EA580C", bg: "#FFF7ED" };
    if (t === "result_released") return { icon: "trophy-outline" as const, color: "#16A34A", bg: "#ECFDF5" };
    return { icon: "notifications-outline" as const, color: "#0B72FF", bg: "#EEF4FF" };
  }, []);

  const parseDeepLink = useCallback((dl?: string) => {
    const deep = String(dl || "");
    if (!deep) return null;
    const [pathname, query] = deep.split("?");
    const params: Record<string, string> = {};
    if (query) {
      query.split("&").forEach((pair) => {
        const [k, v] = pair.split("=");
        if (k) params[decodeURIComponent(k)] = decodeURIComponent(v || "");
      });
    }
    return { pathname: pathname || "/", params };
  }, []);

  const getStudentGradeKey = useCallback(async (sid: string | null) => {
    if (!sid) return null;

    const fromStorage =
      (await AsyncStorage.getItem("studentGrade")) ||
      (await AsyncStorage.getItem("grade")) ||
      "";
    const norm = String(fromStorage).toLowerCase().replace("grade", "").trim();
    if (norm) return `grade${norm}`;

    const schoolCode = await getValue([`Platform1/schoolCodeIndex/${String(sid).slice(0, 3)}`]);
    if (!schoolCode) return null;

    const student = await getValue([`Platform1/Schools/${schoolCode}/Students/${sid}`]) || {};
    const g = String(student?.basicStudentInformation?.grade || student?.grade || "").trim();
    return g ? `grade${g}` : null;
  }, []);

  const goToNotif = useCallback(async (n: Notif) => {
    if (!n) return;

    if (n.meta?.roundId && n.meta?.examId) {
      router.push({
        pathname: "/examCenter",
        params: {
          roundId: n.meta.roundId,
          examId: n.meta.examId,
          questionBankId: n.meta.questionBankId || "",
          mode: "start",
        },
      });
      return;
    }

    const parsed = parseDeepLink(n.deepLink);
    if (parsed) router.push({ pathname: parsed.pathname as any, params: parsed.params });
  }, [parseDeepLink, router]);

  const hideToast = useCallback(() => {
    Animated.parallel([
      Animated.timing(slideY, { toValue: -90, duration: 180, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 0, duration: 160, useNativeDriver: true }),
    ]).start(() => {
      setCurrent(null);
      bar.setValue(1);
    });
  }, [bar, opacity, slideY]);

  const showNext = useCallback((n: Notif) => {
    setCurrent(n);
    slideY.setValue(-90);
    opacity.setValue(0);
    bar.setValue(1);

    Animated.parallel([
      Animated.timing(slideY, { toValue: 0, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }),
      Animated.timing(bar, { toValue: 0, duration: 5000, easing: Easing.linear, useNativeDriver: false }),
    ]).start(({ finished }) => {
      if (finished) hideToast();
    });
  }, [bar, hideToast, opacity, slideY]);

  useEffect(() => {
    (async () => {
      const sid =
        (await AsyncStorage.getItem("studentNodeKey")) ||
        (await AsyncStorage.getItem("studentId")) ||
        (await AsyncStorage.getItem("username")) ||
        null;
      setStudentId(sid);
    })();
  }, []);

  useEffect(() => {
    if (!studentId) return;
    let timer: any;

    async function poll() {
      const gradeKey = await getStudentGradeKey(studentId);
      if (!gradeKey) return;

      const meta = await getValue([`Platform1/usersMeta/${studentId}`, `usersMeta/${studentId}`]) || {};
      const lastSeen = Number(meta?.lastSeenNotificationsAt || 0);

      const node = await getValue([`Platform1/examNotifications`, `examNotifications`]) || {};
      const arr: Notif[] = Object.keys(node).map((id) => ({ id, ...node[id] }));

      const incoming = arr
        .filter((n) => Number(n.createdAt || 0) > lastSeen)
        .filter((n) => !!n?.grades?.[gradeKey])
        .filter((n) => !seenIdsRef.current.has(n.id))
        .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));

      if (incoming.length) {
        incoming.forEach((n) => seenIdsRef.current.add(n.id));
        setQueue((q) => [...q, ...incoming]);
      }
    }

    poll();
    timer = setInterval(poll, 4000);
    return () => clearInterval(timer);
  }, [getStudentGradeKey, studentId]);

  useEffect(() => {
    if (!current && queue.length > 0) {
      const [first, ...rest] = queue;
      setQueue(rest);
      showNext(first);
    }
  }, [current, queue, showNext]);

  const progressWidth = useMemo(
    () => bar.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] }),
    [bar]
  );

  if (!current) return null;
  const vis = notifVisual(current.type);

  return (
    <Animated.View style={[styles.toastWrap, { top: insets.top + 8, transform: [{ translateY: slideY }], opacity }]}>
      <TouchableOpacity
        activeOpacity={0.92}
        style={styles.toastCard}
        onPress={async () => {
          const n = current;
          hideToast();
          await goToNotif(n);
        }}
      >
        <View style={styles.toastHeadRow}>
          <View style={[styles.toastIconWrap, { backgroundColor: vis.bg }]}>
            <Ionicons name={vis.icon} size={16} color={vis.color} />
          </View>
          <Text style={styles.toastTitle} numberOfLines={1}>
            {current.title || "New Notification"}
          </Text>
        </View>
        {!!current.body && (
          <Text style={styles.toastBody} numberOfLines={2}>
            {current.body}
          </Text>
        )}
        <View style={styles.toastBarTrack}>
          <Animated.View style={[styles.toastBarFill, { width: progressWidth }]} />
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },

  toastWrap: {
    position: "absolute",
    left: 12,
    right: 12,
    zIndex: 9999,
    elevation: 9999,
  },
  toastCard: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#EAF0FF",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    shadowColor: "#000",
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 6,
  },
  toastHeadRow: { flexDirection: "row", alignItems: "center" },
  toastIconWrap: {
    width: 24,
    height: 24,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 8,
  },
  toastTitle: { color: "#0B2540", fontWeight: "900", flex: 1 },
  toastBody: { marginTop: 6, color: "#6B78A8", fontSize: 12, lineHeight: 16 },
  toastBarTrack: {
    marginTop: 8,
    height: 4,
    borderRadius: 999,
    overflow: "hidden",
    backgroundColor: "#EAF0FF",
  },
  toastBarFill: {
    height: 4,
    borderRadius: 999,
    backgroundColor: "#0B72FF",
  },
});