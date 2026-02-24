import React, { useEffect, useState, useCallback, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  Image,
  Alert,
  Modal,
  SafeAreaView,
  Pressable,
  Platform,
  Linking,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { ref, get } from "firebase/database";
import { database } from "../../constants/firebaseConfig";
import { Ionicons } from "@expo/vector-icons";
import * as FileSystem from "expo-file-system/legacy";
import { WebView } from "react-native-webview";

/**
 * Books screen with improved WebView error handling:
 * - Tries content:// URIs (getContentUriAsync) on Android
 * - If WebView returns ERR_ACCESS_DENIED, attempts to load PDF as base64 html (data URI)
 * - If base64 fallback fails, prompts user to open file externally (Linking.openURL)
 *
 * Keeps:
 * - SHA1-based filenames
 * - per-URL downloading state
 * - simple AsyncStorage index for readable names
 * - cancel downloads
 *
 * Save as: app/dashboard/book.jsx
 */

const PRIMARY = "#007AFB";
const MUTED = "#6B78A8";
const BOOKS_DIR = `${FileSystem.documentDirectory}books/`;
const DOWNLOAD_INDEX_KEY = "downloaded_books_index_v1";

/* small SHA1 */
function sha1(msg) {
  function rotl(n, s) { return (n << s) | (n >>> (32 - s)); }
  function tohex(i) { return ("00000000" + i.toString(16)).slice(-8); }

  var H0 = 0x67452301;
  var H1 = 0xEFCDAB89;
  var H2 = 0x98BADCFE;
  var H3 = 0x10325476;
  var H4 = 0xC3D2E1F0;

  var ml = msg.length;
  var wa = [];
  for (var i = 0; i < ml; i++) {
    wa[i >> 2] |= msg.charCodeAt(i) << (24 - (i % 4) * 8);
  }
  var l = ((ml + 8) >> 6) + 1;
  var words = new Array(l * 16).fill(0);
  for (i = 0; i < wa.length; i++) words[i] = wa[i];
  words[ml >> 2] |= 0x80 << (24 - (ml % 4) * 8);
  words[words.length - 1] = ml * 8;

  for (i = 0; i < words.length; i += 16) {
    var w = words.slice(i, i + 16);
    var a = H0, b = H1, c = H2, d = H3, e = H4;
    for (var t = 0; t < 80; t++) {
      if (t < 16) var wt = w[t];
      else {
        var x = w[(t - 3)] ^ w[(t - 8)] ^ w[(t - 14)] ^ w[(t - 16)];
        wt = (rotl(x, 1));
        w[t] = wt;
      }
      var s, f, k;
      if (t < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
      else if (t < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
      else if (t < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
      else { f = b ^ c ^ d; k = 0xCA62C1D6; }
      var temp = (rotl(a, 5) + f + e + k + (wt >>> 0)) >>> 0;
      e = d; d = c; c = rotl(b, 30) >>> 0; b = a; a = temp;
    }
    H0 = (H0 + a) >>> 0;
    H1 = (H1 + b) >>> 0;
    H2 = (H2 + c) >>> 0;
    H3 = (H3 + d) >>> 0;
    H4 = (H4 + e) >>> 0;
  }

  return tohex(H0) + tohex(H1) + tohex(H2) + tohex(H3) + tohex(H4);
}

export default function BooksScreen() {
  const [loading, setLoading] = useState(true);
  const [subjects, setSubjects] = useState([]);
  const [expanded, setExpanded] = useState({});
  const [studentGrade, setStudentGrade] = useState(null);

  const [downloadProgress, setDownloadProgress] = useState({});
  const [downloadingMap, setDownloadingMap] = useState({});
  const activeDownloadsRef = useRef({});

  const [downloadedFilesList, setDownloadedFilesList] = useState([]);
  const [managerVisible, setManagerVisible] = useState(false);

  // viewer: { visible, uri, title, htmlFallback }
  const [viewer, setViewer] = useState({ visible: false, uri: null, title: "", htmlFallback: null });

  const ensureBooksDir = useCallback(async () => {
    try {
      const info = await FileSystem.getInfoAsync(BOOKS_DIR);
      if (!info.exists) await FileSystem.makeDirectoryAsync(BOOKS_DIR, { intermediates: true });
    } catch (err) {
      console.warn("ensureBooksDir error:", err);
    }
  }, []);

  const getLocalFilename = useCallback((url) => {
    if (!url) return null;
    let ext = null;
    try {
      const pathPart = url.split("?")[0].split("#")[0];
      const parts = pathPart.split(".");
      if (parts.length > 1) {
        const possibleExt = parts[parts.length - 1].toLowerCase();
        if (/^[a-z0-9]{1,5}$/.test(possibleExt)) ext = possibleExt;
      }
    } catch {}
    const h = sha1(url);
    return ext ? `${h}.${ext}` : h;
  }, []);

  const getLocalPathForUrl = useCallback((url) => {
    const name = getLocalFilename(url);
    return name ? `${BOOKS_DIR}${name}` : null;
  }, [getLocalFilename]);

  // AsyncStorage index helpers
  const loadDownloadIndex = useCallback(async () => {
    try {
      const raw = await AsyncStorage.getItem(DOWNLOAD_INDEX_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (err) {
      return {};
    }
  }, []);

  const saveDownloadIndex = useCallback(async (idx) => {
    try {
      await AsyncStorage.setItem(DOWNLOAD_INDEX_KEY, JSON.stringify(idx || {}));
    } catch (err) {
      console.warn("saveDownloadIndex error:", err);
    }
  }, []);

  const registerDownloadMetadata = useCallback(async (url, meta) => {
    try {
      const filename = getLocalFilename(url);
      if (!filename) return;
      const idx = await loadDownloadIndex();
      idx[filename] = { url, title: meta.title || meta.chapterTitle || meta.subjectName || filename, subjectName: meta.subjectName || null, downloadedAt: Date.now() };
      await saveDownloadIndex(idx);
    } catch (err) {
      console.warn("registerDownloadMetadata error:", err);
    }
  }, [getLocalFilename, loadDownloadIndex, saveDownloadIndex]);

  const removeDownloadMetadata = useCallback(async (filename) => {
    try {
      const idx = await loadDownloadIndex();
      if (idx[filename]) {
        delete idx[filename];
        await saveDownloadIndex(idx);
      }
    } catch (err) {
      console.warn("removeDownloadMetadata error:", err);
    }
  }, [loadDownloadIndex, saveDownloadIndex]);

  const refreshDownloadedFiles = useCallback(async () => {
    try {
      await ensureBooksDir();
      const idx = await loadDownloadIndex();
      const names = await FileSystem.readDirectoryAsync(BOOKS_DIR);
      const list = [];
      for (const name of names) {
        if (!name) continue;
        try {
          const uri = `${BOOKS_DIR}${name}`;
          const info = await FileSystem.getInfoAsync(uri);
          if (!info.exists) continue;
          const meta = idx[name] || { url: null, title: name, subjectName: null, downloadedAt: null };
          list.push({
            name,
            uri,
            size: info.size || 0,
            modificationTime: info.modificationTime || 0,
            title: meta.title || meta.url || name,
            url: meta.url || null,
            subjectName: meta.subjectName || null,
            downloadedAt: meta.downloadedAt || null,
          });
        } catch (err) {
          console.warn("file info error", err);
        }
      }
      list.sort((a, b) => (b.modificationTime || 0) - (a.modificationTime || 0));
      setDownloadedFilesList(list);
    } catch (err) {
      console.warn("refreshDownloadedFiles error:", err);
      setDownloadedFilesList([]);
    }
  }, [ensureBooksDir, loadDownloadIndex]);

  const cancelDownload = useCallback(async (url) => {
    try {
      const active = activeDownloadsRef.current[url];
      if (active && active.resumable && typeof active.resumable.cancelAsync === "function") {
        try {
          await active.resumable.cancelAsync();
        } catch (err) {
          console.warn("cancelAsync error:", err);
        }
      }
      const localPath = getLocalPathForUrl(url);
      try {
        const info = await FileSystem.getInfoAsync(localPath);
        if (info.exists) await FileSystem.deleteAsync(localPath, { idempotent: true });
      } catch (e) {}
      setDownloadingMap((s) => { const c = { ...s }; delete c[url]; return c; });
      setDownloadProgress((p) => { const c = { ...p }; delete c[url]; return c; });
      delete activeDownloadsRef.current[url];
    } catch (err) {
      console.warn("cancelDownload error:", err);
    }
  }, [getLocalPathForUrl]);

  const downloadToLocal = useCallback(async (url, meta = {}) => {
    await ensureBooksDir();
    const localPath = getLocalPathForUrl(url);
    try {
      setDownloadingMap((s) => ({ ...s, [url]: true }));
      setDownloadProgress((p) => ({ ...p, [url]: 0 }));

      const downloadResumable = FileSystem.createDownloadResumable(
        url,
        localPath,
        {},
        (dp) => {
          if (dp.totalBytesExpectedToWrite > 0) {
            const prog = dp.totalBytesWritten / dp.totalBytesExpectedToWrite;
            setDownloadProgress((p) => ({ ...p, [url]: prog }));
          }
        }
      );

      activeDownloadsRef.current[url] = { resumable: downloadResumable };

      try {
        const result = await downloadResumable.downloadAsync();
        setDownloadingMap((s) => { const c = { ...s }; delete c[url]; return c; });
        setDownloadProgress((p) => ({ ...p, [url]: 1 }));
        delete activeDownloadsRef.current[url];
        await registerDownloadMetadata(url, meta);
        await refreshDownloadedFiles();
        return result.uri;
      } catch (resumableErr) {
        console.warn("resumable failed:", resumableErr);
        try {
          const fallback = await FileSystem.downloadAsync(url, localPath);
          setDownloadingMap((s) => { const c = { ...s }; delete c[url]; return c; });
          setDownloadProgress((p) => ({ ...p, [url]: 1 }));
          delete activeDownloadsRef.current[url];
          await registerDownloadMetadata(url, meta);
          await refreshDownloadedFiles();
          return fallback.uri;
        } catch (fallbackErr) {
          console.warn("fallback failed:", fallbackErr);
          try {
            const info = await FileSystem.getInfoAsync(localPath);
            if (info.exists) await FileSystem.deleteAsync(localPath, { idempotent: true });
          } catch {}
          setDownloadingMap((s) => { const c = { ...s }; delete c[url]; return c; });
          setDownloadProgress((p) => { const c = { ...p }; delete c[url]; return c; });
          delete activeDownloadsRef.current[url];
          throw fallbackErr || resumableErr;
        }
      }
    } catch (err) {
      console.warn("downloadToLocal final error:", err);
      setDownloadingMap((s) => { const c = { ...s }; delete c[url]; return c; });
      setDownloadProgress((p) => { const c = { ...p }; delete c[url]; return c; });
      delete activeDownloadsRef.current[url];
      try {
        const info = await FileSystem.getInfoAsync(localPath);
        if (info.exists) await FileSystem.deleteAsync(localPath, { idempotent: true });
      } catch {}
      throw err;
    }
  }, [ensureBooksDir, getLocalPathForUrl, registerDownloadMetadata, refreshDownloadedFiles]);

  const deleteFile = useCallback(async (file) => {
    try {
      await FileSystem.deleteAsync(file.uri, { idempotent: true });
      await removeDownloadMetadata(file.name);
      await refreshDownloadedFiles();
      Alert.alert("Deleted", "File removed from app storage.");
    } catch (err) {
      console.warn("deleteFile error:", err);
      Alert.alert("Delete failed", "Unable to delete file.");
    }
  }, [removeDownloadMetadata, refreshDownloadedFiles]);

  // Attempt to open a local file in the WebView (content:// on Android). If the WebView reports an error,
  // the WebView onError handler will use htmlFallback or prompt to open externally.
  const openLocalInViewer = useCallback(async (localPath, title) => {
    try {
      let uri = localPath;
      if (Platform.OS === "android") {
        try {
          const content = await FileSystem.getContentUriAsync(localPath);
          if (content) {
            if (typeof content === "string") uri = content;
            else if (content.uri) uri = content.uri;
          }
        } catch (err) {
          console.warn("getContentUriAsync failed, falling back to file:// :", err);
        }
      }
      // clear any previous htmlFallback
      setViewer({ visible: true, uri, title, htmlFallback: null });
    } catch (err) {
      console.warn("openLocalInViewer error:", err);
      Alert.alert("Error", "Unable to open document.");
    }
  }, []);

  // Try to create a base64 HTML fallback for the given local path and set it to viewer.htmlFallback
  const tryBase64Fallback = useCallback(async (localPath, title) => {
    try {
      // read file as base64
      const base = await FileSystem.readAsStringAsync(localPath, { encoding: FileSystem.EncodingType.Base64 });
      // build simple HTML that uses <embed> and an <iframe> fallback
      const html = `
        <!doctype html>
        <html>
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>html,body{height:100%;margin:0;padding:0;background:#fff}embed,iframe{width:100%;height:100%;border:0}</style>
          </head>
          <body>
            <embed type="application/pdf" src="data:application/pdf;base64,${base}"></embed>
            <iframe src="data:application/pdf;base64,${base}"></iframe>
          </body>
        </html>
      `;
      setViewer({ visible: true, uri: null, title, htmlFallback: html });
      return true;
    } catch (err) {
      console.warn("Base64 fallback failed:", err);
      return false;
    }
  }, []);

  // Called when WebView reports an error loading the page.
  // If error looks like ERR_ACCESS_DENIED try base64 fallback, else offer external open.
  const handleWebViewError = useCallback(async (syntheticEvent) => {
    const { nativeEvent } = syntheticEvent;
    console.warn("WebView error:", nativeEvent);
    const uri = viewer.uri;
    // if we already have an htmlFallback loaded, show prompt to open externally
    if (viewer.htmlFallback) {
      Alert.alert("Can't render", "Unable to render this PDF in-app. Open with an external app?", [
        { text: "Cancel", style: "cancel" },
        { text: "Open externally", onPress: () => Linking.openURL(uri).catch(() => Alert.alert("Error", "Unable to open externally.")) },
      ]);
      return;
    }

    // If access denied, try base64 fallback (only if we have a file:// or content:// path pointing to local file)
    if (nativeEvent && nativeEvent.description && nativeEvent.description.includes("ERR_ACCESS_DENIED")) {
      // attempt to map content:// back to the file path if possible
      let localPath = uri;
      try {
        // If uri is content://, try to obtain a file path. FileSystem doesn't provide reverse mapping, but we can
        // try to reconstruct the file path for our known files by checking known BOOKS_DIR files and matching the name.
        // Simpler: try both uri and known hashed filename candidate from index
        // Try to read directly from uri using readAsStringAsync - that may fail for content://; so attempt candidate path:
        // We will look up downloadedFilesList for an entry with contentUri === uri or try to use last opened file saved.
        const candidates = await FileSystem.readDirectoryAsync(BOOKS_DIR).catch(() => []);
        // try to find a file whose content URI maps to this content URI by comparing FileSystem.getContentUriAsync results
        let matchedLocal = null;
        for (const name of candidates) {
          const path = `${BOOKS_DIR}${name}`;
          try {
            const content = await FileSystem.getContentUriAsync(path);
            const contentUri = typeof content === "string" ? content : content?.uri;
            if (contentUri === uri) { matchedLocal = path; break; }
          } catch (e) {
            // ignore
          }
        }
        if (matchedLocal) localPath = matchedLocal;
      } catch (err) {
        // ignore
      }

      // attempt base64 fallback
      const ok = await tryBase64Fallback(localPath, viewer.title || "Document");
      if (!ok) {
        // fallback to asking user to open externally
        Alert.alert("Can't render in-app", "This PDF couldn't be rendered in-app. Open with an external app instead?", [
          { text: "Cancel", style: "cancel" },
          { text: "Open externally", onPress: () => Linking.openURL(uri).catch(() => Alert.alert("Error", "Unable to open externally.")) },
        ]);
      }
      return;
    }

    // default fallback: prompt external open
    Alert.alert("Unable to open", "Could not load this document in-app. Open with an external app?", [
      { text: "Cancel", style: "cancel" },
      { text: "Open externally", onPress: () => Linking.openURL(viewer.uri).catch(() => Alert.alert("Error", "Unable to open externally.")) },
    ]);
  }, [viewer, tryBase64Fallback]);

  const openChapter = useCallback(async (chapter, subjectName) => {
    const url = chapter.contentUrl;
    if (!url) { Alert.alert("No content", "This chapter has no content URL."); return; }
    try {
      const localPath = getLocalPathForUrl(url);
      const info = await FileSystem.getInfoAsync(localPath);
      if (info.exists) {
        // convert to content URI for Android
        try {
          let uri = localPath;
          if (Platform.OS === "android") {
            const content = await FileSystem.getContentUriAsync(localPath);
            if (content) uri = typeof content === "string" ? content : content.uri;
          }
          setViewer({ visible: true, uri, title: chapter.title, htmlFallback: null });
        } catch (err) {
          // fallback to opening via viewer helper
          setViewer({ visible: true, uri: localPath, title: chapter.title, htmlFallback: null });
        }
        return;
      }
      Alert.alert("Download", "This book will be downloaded into the app for offline reading. Continue?", [
        { text: "Cancel", style: "cancel" },
        {
          text: "Download",
          onPress: async () => {
            try {
              await downloadToLocal(url, { title: chapter.title, subjectName });
              const lp = getLocalPathForUrl(url);
              // convert to content URI on Android
              let uri = lp;
              if (Platform.OS === "android") {
                try {
                  const content = await FileSystem.getContentUriAsync(lp);
                  if (content) uri = typeof content === "string" ? content : content.uri;
                } catch (e) {
                  // ignore
                }
              }
              setViewer({ visible: true, uri, title: chapter.title, htmlFallback: null });
            } catch (err) {
              console.warn("openChapter download failed:", err);
              Alert.alert("Download failed", err?.message || "Unable to download book. Try again.");
            }
          },
        },
      ]);
    } catch (err) {
      console.warn("openChapter error:", err);
      Alert.alert("Error", "Unable to open chapter.");
    }
  }, [getLocalPathForUrl, downloadToLocal]);

  const downloadOrCancel = useCallback(async (chapter, subjectName) => {
    const url = chapter.contentUrl;
    if (!url) { Alert.alert("No content", "No content URL."); return; }
    if (downloadingMap[url]) {
      Alert.alert("Cancel", "Cancel download?", [
        { text: "No", style: "cancel" },
        { text: "Yes", onPress: () => cancelDownload(url) },
      ]);
      return;
    }
    try {
      await downloadToLocal(url, { title: chapter.title, subjectName });
      Alert.alert("Downloaded", "Book downloaded and available in the app.");
    } catch (err) {
      console.warn("downloadOrCancel error:", err);
      Alert.alert("Download failed", err?.message || "Unable to download book.");
    }
  }, [downloadingMap, cancelDownload, downloadToLocal]);

  const loadStudentGrade = useCallback(async () => {
    try {
      const studentNodeKey = (await AsyncStorage.getItem("studentNodeKey")) || (await AsyncStorage.getItem("studentId"));
      if (studentNodeKey) {
        const snap = await get(ref(database, `Students/${studentNodeKey}`));
        if (snap.exists()) {
          const s = snap.val();
          const grade = s.grade ? s.grade.toString() : null;
          setStudentGrade(grade);
          return grade;
        }
      }
      const userNodeKey = await AsyncStorage.getItem("userNodeKey");
      if (userNodeKey) {
        const userSnap = await get(ref(database, `Users/${userNodeKey}`));
        if (userSnap.exists()) {
          const user = userSnap.val();
          if (user.studentId) {
            const studentSnap = await get(ref(database, `Students/${user.studentId}`));
            if (studentSnap.exists()) {
              const st = studentSnap.val();
              const grade = st.grade ? st.grade.toString() : null;
              setStudentGrade(grade);
              return grade;
            }
          }
        }
      }
    } catch (err) {
      console.warn("loadStudentGrade error:", err);
    }
    return null;
  }, []);

  useEffect(() => {
    let mounted = true;
    (async () => {
      setLoading(true);
      await ensureBooksDir();
      await refreshDownloadedFiles();
      const grade = await loadStudentGrade();
      if (!grade) {
        if (mounted) { setSubjects([]); setLoading(false); }
        return;
      }
      const gradeKey = `grade_${grade}`;
      try {
        const snap = await get(ref(database, `Curriculum/${gradeKey}`));
        if (!snap.exists()) {
          if (mounted) { setSubjects([]); setLoading(false); }
          return;
        }
        const subjectsObj = snap.val();
        const list = Object.keys(subjectsObj || {}).map((subjectKey) => {
          const subjectNode = subjectsObj[subjectKey];
          const chaptersObj = subjectNode.chapters || {};
          const chapters = Object.keys(chaptersObj || {}).map((ck) => {
            const c = chaptersObj[ck];
            return {
              chapterKey: c.id || ck,
              title: c.title || `Chapter ${c.order || ""}`,
              contentUrl: c.contentUrl || c.url || null,
              order: typeof c.order === "number" ? c.order : Number(c.order) || 0,
              hasExam: !!c.hasExam,
            };
          });
          chapters.sort((a, b) => (a.order || 0) - (b.order || 0));
          return {
            subjectKey,
            subjectName: subjectNode.subjectName || subjectKey,
            totalChapters: subjectNode.totalChapters || chapters.length,
            chapters,
          };
        });
        if (mounted) setSubjects(list);
      } catch (err) {
        console.warn("load curriculum error:", err);
        if (mounted) setSubjects([]);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [ensureBooksDir, loadStudentGrade, refreshDownloadedFiles]);

  const toggleExpand = useCallback((k) => setExpanded((p) => ({ ...p, [k]: !p[k] })), []);

  function ChapterRow({ chapter, subjectName, index }) {
    const url = chapter.contentUrl;
    const isDownloading = !!downloadingMap[url];
    const progress = Math.round((downloadProgress[url] || 0) * 100);

    const [downloaded, setDownloaded] = useState(false);
    useEffect(() => {
      let mounted = true;
      (async () => {
        if (!url) return;
        const path = getLocalPathForUrl(url);
        try {
          const info = await FileSystem.getInfoAsync(path);
          if (mounted) setDownloaded(!!info.exists);
        } catch {
          if (mounted) setDownloaded(false);
        }
      })();
      return () => { mounted = false; };
    }, [url, downloadingMap[url]]);

    return (
      <View style={styles.chapterRow}>
        <Text style={styles.chapterIndex}>{chapter.order ? chapter.order : index + 1}.</Text>
        <View style={{ flex: 1 }}>
          <Text style={styles.chapterTitle}>{chapter.title}</Text>
          <Text style={styles.chapterMeta}>{chapter.hasExam ? "Has exam" : "No exam"}</Text>
        </View>

        <View style={styles.actionsRight}>
          {isDownloading ? (
            <TouchableOpacity onPress={() => cancelDownload(url)} style={styles.progressWrap}>
              <ActivityIndicator color="#fff" />
              <Text style={styles.progressText}>{progress}%</Text>
            </TouchableOpacity>
          ) : (
            <>
              <Pressable onPress={() => openChapter(chapter, subjectName)} style={[styles.openBtn, { marginRight: 8 }]} android_ripple={{ color: "#0a66d4" }}>
                <Text style={styles.openBtnText}>Read</Text>
              </Pressable>

              <TouchableOpacity onPress={() => downloadOrCancel(chapter, subjectName)} style={[styles.iconDownload, downloaded ? styles.iconDownloaded : null]} activeOpacity={0.85}>
                <Ionicons name={downloaded ? "cloud-done" : "cloud-download-outline"} size={18} color={downloaded ? "#fff" : PRIMARY} />
              </TouchableOpacity>
            </>
          )}
        </View>
      </View>
    );
  }

  const openManagerSafely = useCallback(async () => {
    await refreshDownloadedFiles();
    setManagerVisible(true);
  }, [refreshDownloadedFiles]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={PRIMARY} />
      </View>
    );
  }

  if (!subjects || subjects.length === 0) {
    return (
      <View style={styles.emptyContainer}>
        <Image source={require("../../assets/images/no_data_illustrator.jpg")} style={styles.emptyImage} resizeMode="contain" />
        <Text style={styles.emptyTitle}>No books available</Text>
        <Text style={styles.emptySubtitle}>We couldn't find curriculum for your grade yet.</Text>
      </View>
    );
  }

  const Header = () => (
    <View style={styles.headerRow}>
      <View>
        <Text style={styles.headerTitle}>Books</Text>
        <Text style={styles.headerSubtitle}>Textbooks and chapters for grade {studentGrade || "—"}</Text>
      </View>

      <TouchableOpacity style={styles.downloadManagerBtn} onPress={openManagerSafely}>
        <Ionicons name="cloud-outline" size={20} color={PRIMARY} />
        <Text style={styles.downloadManagerText}>Downloads</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <SafeAreaView style={styles.container}>
      <Header />

      <FlatList
        data={subjects}
        keyExtractor={(item) => item.subjectKey}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <View style={styles.subjectLeft}>
                <View style={styles.subjectIcon}>
                  <Ionicons name="book-outline" size={20} color={PRIMARY} />
                </View>
                <View style={{ marginLeft: 12 }}>
                  <Text style={styles.subjectName}>{item.subjectName}</Text>
                  <Text style={styles.subjectSub}>{item.totalChapters} chapter{item.totalChapters === 1 ? "" : "s"}</Text>
                </View>
              </View>

              <TouchableOpacity style={styles.expandBtn} onPress={() => toggleExpand(item.subjectKey)}>
                <Ionicons name={expanded[item.subjectKey] ? "chevron-up-outline" : "chevron-down-outline"} size={24} color="#444" />
              </TouchableOpacity>
            </View>

            {expanded[item.subjectKey] && (
              <View style={styles.chaptersContainer}>
                {item.chapters.map((ch, idx) => <ChapterRow key={ch.chapterKey} chapter={ch} subjectName={item.subjectName} index={idx} />)}
              </View>
            )}
          </View>
        )}
      />

      {/* Viewer modal: supports uri or htmlFallback */}
      <Modal visible={viewer.visible} animationType="slide" onRequestClose={() => setViewer({ visible: false, uri: null, title: "", htmlFallback: null })}>
        <SafeAreaView style={styles.readerContainer}>
          <View style={styles.readerHeader}>
            <TouchableOpacity onPress={() => setViewer({ visible: false, uri: null, title: "", htmlFallback: null })} style={{ padding: 8 }}>
              <Ionicons name="close" size={22} color="#222" />
            </TouchableOpacity>
            <Text style={styles.readerTitle} numberOfLines={1}>{viewer.title}</Text>
            <View style={{ width: 40 }} />
          </View>

          {viewer.htmlFallback ? (
            <WebView
              originWhitelist={['*']}
              source={{ html: viewer.htmlFallback }}
              style={{ flex: 1, backgroundColor: "#fff" }}
              startInLoadingState
            />
          ) : viewer.uri ? (
            <WebView
              source={{ uri: viewer.uri }}
              originWhitelist={['*']}
              allowFileAccess={true}
              allowUniversalAccessFromFileURLs={true}
              style={{ flex: 1, backgroundColor: "#fff" }}
              startInLoadingState
              javaScriptEnabled
              domStorageEnabled
              onError={handleWebViewError}
            />
          ) : (
            <View style={styles.center}>
              <Text style={{ color: MUTED }}>No document selected</Text>
            </View>
          )}
        </SafeAreaView>
      </Modal>

      {/* Manager modal */}
      <Modal visible={managerVisible} animationType="slide" onRequestClose={() => setManagerVisible(false)}>
        <SafeAreaView style={styles.managerContainer}>
          <View style={styles.managerHeader}>
            <TouchableOpacity onPress={() => setManagerVisible(false)} style={{ padding: 8 }}>
              <Ionicons name="close" size={22} color="#222" />
            </TouchableOpacity>
            <Text style={styles.managerTitle}>Downloaded files</Text>
            <TouchableOpacity onPress={() => refreshDownloadedFiles()} style={{ padding: 8 }}>
              <Ionicons name="refresh" size={20} color={PRIMARY} />
            </TouchableOpacity>
          </View>

          {downloadedFilesList.length === 0 ? (
            <View style={styles.emptyContainer}>
              <Text style={{ color: MUTED }}>No files downloaded yet.</Text>
            </View>
          ) : (
            <FlatList
              data={downloadedFilesList}
              keyExtractor={(f) => f.uri}
              renderItem={({ item }) => (
                <View style={styles.fileRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.fileName}>{item.title}</Text>
                    <Text style={styles.fileMeta}>{(item.size / 1024).toFixed(1)} KB • {item.subjectName || ""}</Text>
                  </View>
                  <View style={{ flexDirection: "row", alignItems: "center" }}>
                    <TouchableOpacity onPress={async () => {
                      try {
                        let uri = item.uri;
                        if (Platform.OS === "android") {
                          const content = await FileSystem.getContentUriAsync(item.uri);
                          if (content) uri = typeof content === "string" ? content : content.uri;
                        }
                        setViewer({ visible: true, uri, title: item.title, htmlFallback: null });
                      } catch (err) {
                        console.warn("open downloaded file error:", err);
                        Alert.alert("Error", "Unable to open file.");
                      }
                    }} style={{ marginRight: 12 }}>
                      <Ionicons name="open-outline" size={22} color={PRIMARY} />
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => {
                      Alert.alert("Delete file", "Delete this file from app storage?", [
                        { text: "Cancel", style: "cancel" },
                        { text: "Delete", style: "destructive", onPress: () => deleteFile(item) },
                      ]);
                    }}>
                      <Ionicons name="trash-outline" size={22} color="#d23f44" />
                    </TouchableOpacity>
                  </View>
                </View>
              )}
            />
          )}
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },

  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 16, paddingTop: 14, paddingBottom: 8, backgroundColor: "#fff" },
  headerTitle: { fontSize: 22, fontWeight: "700", color: "#111" },
  headerSubtitle: { marginTop: 4, color: MUTED, fontSize: 13 },
  downloadManagerBtn: { flexDirection: "row", alignItems: "center" },
  downloadManagerText: { color: PRIMARY, marginLeft: 6 },

  list: { paddingHorizontal: 12, paddingBottom: 24 },

  card: { backgroundColor: "#fff", borderRadius: 12, marginBottom: 12, borderWidth: 1, borderColor: "#F1F3F8", overflow: "hidden" },
  cardHeader: { padding: 12, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  subjectLeft: { flexDirection: "row", alignItems: "center", flex: 1 },
  subjectIcon: { width: 46, height: 46, borderRadius: 10, backgroundColor: "#F0F7FF", alignItems: "center", justifyContent: "center" },
  subjectName: { fontWeight: "700", fontSize: 16, color: "#111" },
  subjectSub: { color: MUTED, marginTop: 4 },
  expandBtn: { paddingHorizontal: 8, paddingVertical: 6, marginLeft: 8 },

  chaptersContainer: { paddingHorizontal: 12, paddingBottom: 12 },
  chapterRow: { flexDirection: "row", alignItems: "center", paddingVertical: 10, borderBottomColor: "#F1F3F8", borderBottomWidth: 1 },
  chapterIndex: { color: MUTED, width: 26 },
  chapterTitle: { fontSize: 15, fontWeight: "600", color: "#222" },
  chapterMeta: { color: MUTED, fontSize: 12, marginTop: 4 },

  actionsRight: { flexDirection: "row", alignItems: "center" },
  openBtn: { backgroundColor: PRIMARY, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  openBtnText: { color: "#fff", fontWeight: "700" },

  iconDownload: { width: 40, height: 40, borderRadius: 8, borderWidth: 1, borderColor: PRIMARY, alignItems: "center", justifyContent: "center" },
  iconDownloaded: { backgroundColor: PRIMARY, borderColor: PRIMARY },

  center: { flex: 1, alignItems: "center", justifyContent: "center" },

  progressWrap: { flexDirection: "row", alignItems: "center", backgroundColor: PRIMARY, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8 },
  progressText: { color: "#fff", marginLeft: 8, fontWeight: "600" },

  emptyContainer: { flex: 1, backgroundColor: "#fff", alignItems: "center", justifyContent: "center", padding: 24 },
  emptyImage: { width: 220, height: 160, marginBottom: 18 },
  emptyTitle: { fontSize: 20, fontWeight: "700", color: "#222", marginBottom: 6 },
  emptySubtitle: { fontSize: 14, color: MUTED, textAlign: "center" },

  readerContainer: { flex: 1, backgroundColor: "#fff" },
  readerHeader: { height: 56, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: "#F1F3F8" },
  readerTitle: { fontWeight: "700", fontSize: 16, color: "#222", flex: 1, textAlign: "center" },

  managerContainer: { flex: 1, backgroundColor: "#fff" },
  managerHeader: { height: 56, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: "#F1F3F8" },
  managerTitle: { fontWeight: "700", fontSize: 16, color: "#222" },

  fileRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 12, borderBottomColor: "#F1F3F8", borderBottomWidth: 1 },
  fileName: { fontSize: 13, fontWeight: "600", color: "#111" },
  fileMeta: { fontSize: 12, color: MUTED, marginTop: 4 },
});