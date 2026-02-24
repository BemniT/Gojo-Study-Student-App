// import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
// import { Stack } from 'expo-router';
// import { StatusBar } from 'expo-status-bar';
// import { SafeAreaView, StyleSheet } from "react-native";
// import { Slot } from "expo-router";
// import 'react-native-reanimated';

// import { useColorScheme } from '@/hooks/use-color-scheme';

// export const unstable_settings = {
//   anchor: '(tabs)',
// };

// export default function RootLayout() {
//   const colorScheme = useColorScheme();

//   return (
//     <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
//       <Stack>
//         <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
//         <Stack.Screen name="modal" options={{ presentation: 'modal', title: 'Modal' }} />
//       </Stack>
//       <StatusBar style="auto" />
//     </ThemeProvider>
//   );
// }
import React from "react";
import { SafeAreaView, StyleSheet } from "react-native";
import { StatusBar } from 'expo-status-bar';
import { Slot } from "expo-router";

/* Minimal root layout: only render Slot and SafeAreaView.
   This prevents accidental global headers from appearing. */
export default function RootLayout() {
  return (
    <SafeAreaView style={styles.container} edges={["top", "left", "right", "bottom"]}>
      <Slot />
    </SafeAreaView>
  );
}
<StatusBar style="auto" />
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
});