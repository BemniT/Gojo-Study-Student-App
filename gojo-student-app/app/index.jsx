import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  Alert,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { useRouter } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { ref, query, orderByChild, equalTo, get } from "firebase/database";
import { database } from "../constants/firebaseConfig";

export default function LoginScreen() {
  const router = useRouter();

  const [identifier, setIdentifier] = useState(""); // username / studentId / phone / email
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Try to find user by several possible fields
  const findUserByIdentifier = async (id) => {
    const fields = ["username"];
    for (const field of fields) {
      try {
        const q = query(ref(database, "Users"), orderByChild(field), equalTo(id));
        const snap = await get(q);
        if (snap.exists()) {
          let found = null;
          snap.forEach((child) => {
            found = { ...child.val(), _nodeKey: child.key };
            return true; // stop after first
          });
          if (found) return found;
        }
      } catch (err) {
        // continue trying other fields
        console.warn(`Error querying field ${field}:`, err);
      }
    }
    return null;
  };

  const handleSignIn = async () => {
    setError("");
    const id = identifier.trim();
    if (!id || !password) {
      setError("Please enter your username (or studentId/phone/email) and password.");
      return;
    }

    setLoading(true);
    try {
      const user = await findUserByIdentifier(id);
      if (!user) {
        setError("No account found with that identifier.");
        return;
      }

      // The DB in your example stores plaintext passwords (not recommended).
      // We compare directly here to match your DB structure.
      if (!user.password) {
        setError("This account has no password set. Contact admin.");
        return;
      }

      if (user.password !== password) {
        setError("Incorrect password.");
        return;
      }

      if (typeof user.isActive === "boolean" && !user.isActive) {
        setError("This account is inactive. Contact the administrator.");
        return;
      }

      // Persist useful identifiers for other parts of the app
      // - user.userId (if present) seems to be the actual uid in your DB example
      // - user.studentId is the school-specific id
      // - user._nodeKey is the RTDB node key for this user record
      await AsyncStorage.multiSet([
        ["userId", user.userId || ""],
        ["studentId", user.studentId || ""],
        ["userNodeKey", user._nodeKey || ""],
        ["role", user.role || ""],
      ]);

      // Navigate into the app (replace stack so user cannot go back to login)
      router.replace("/dashboard/home");
    } catch (err) {
      console.error("Login error:", err);
      setError("Unable to sign in. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleGuest = () => {
    // optional: allow guests or testing
    router.replace("/dashboard/home");
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="dark" />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.flex}
      >
        <View style={styles.inner}>
          <Text style={styles.title}>Welcome to Gojo Study</Text>
          <Text style={styles.subtitle}>Sign in with your username or student ID</Text>

          {error ? <Text style={styles.errorText}>{error}</Text> : null}

          <TextInput
            value={identifier}
            onChangeText={setIdentifier}
            placeholder="Username / Student ID / Phone / Email"
            placeholderTextColor="#9AA0A6"
            autoCapitalize="none"
            style={styles.input}
            returnKeyType="next"
            textContentType="username"
          />

          <TextInput
            value={password}
            onChangeText={setPassword}
            placeholder="Password"
            placeholderTextColor="#9AA0A6"
            secureTextEntry
            style={styles.input}
            returnKeyType="done"
            textContentType="password"
          />

          <TouchableOpacity
            style={[styles.button, loading && styles.buttonDisabled]}
            onPress={handleSignIn}
            disabled={loading}
          >
            {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Sign in</Text>}
          </TouchableOpacity>

          <View style={styles.row}>
            <Text style={styles.smallText}>Don't have an account?</Text>
            <TouchableOpacity onPress={() => router.push("/register")}>
              <Text style={[styles.smallText, styles.linkText]}> Create account</Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity style={styles.guest} onPress={handleGuest}>
            <Text style={styles.guestText}>Continue as guest</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.footer}>
          <Text style={styles.footerText}>By continuing you agree to our Terms & Privacy.</Text>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: {
    flex: 1,
    backgroundColor: "#fff",
  },
  inner: {
    paddingHorizontal: 24,
    paddingTop: 48,
    flex: 1,
  },
  title: {
    fontSize: 28,
    fontWeight: "700",
    color: "#111",
  },
  subtitle: {
    marginTop: 6,
    color: "#666",
    marginBottom: 18,
  },
  input: {
    height: 48,
    borderWidth: 1,
    borderColor: "#E6E9EE",
    borderRadius: 8,
    paddingHorizontal: 12,
    marginTop: 12,
    backgroundColor: "#fff",
    color: "#111",
  },
  button: {
    height: 48,
    backgroundColor: "#1e90ff",
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 18,
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  buttonText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 16,
  },
  row: {
    flexDirection: "row",
    justifyContent: "center",
    marginTop: 16,
  },
  smallText: {
    color: "#666",
  },
  linkText: {
    color: "#1e90ff",
    fontWeight: "700",
  },
  guest: {
    marginTop: 12,
    alignItems: "center",
  },
  guestText: {
    color: "#888",
  },
  errorText: {
    color: "#B00020",
    marginTop: 6,
    marginBottom: 2,
  },
  footer: {
    padding: 20,
    borderTopWidth: 1,
    borderTopColor: "#F1F3F6",
    alignItems: "center",
  },
  footerText: {
    color: "#9AA0A6",
    fontSize: 12,
  },
});