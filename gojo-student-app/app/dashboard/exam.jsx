import React from "react";
import { View, Text, StyleSheet } from "react-native";

export default function ExamScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.h1}>Exams</Text>
      <Text style={styles.p}>Your exam schedule and results will appear here.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#fff" },
  h1: { fontSize: 22, fontWeight: "700", color: "#222" },
  p: { marginTop: 8, color: "#787777" },
});