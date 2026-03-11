import React, { useEffect, useState, useCallback, useRef, useMemo } from "react";
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
  TextInput,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { ref, get } from "firebase/database";
import { database } from "../../constants/firebaseConfig";
import { Ionicons } from "@expo/vector-icons";
import * as FileSystem from "expo-file-system/legacy";
import { WebView } from "react-native-webview";

const PRIMARY = "#0B72FF";
const TEXT = "#0B2540";
const MUTED = "#6B78A8";
const CARD = "#FFFFFF";
const BORDER = "#EAF0FF";
const BG = "#FFFFFF";

const BOOKS_DIR = `${FileSystem.documentDirectory}books/`;
const DOWNLOAD_INDEX_KEY = "downloaded_books_index_v1";

function sha1(msg) {
  function rotl(n, s) { return (n << s) | (n >>> (32 - s)); }
  function tohex(i) { return ("00000000" + i.toString(16)).slice(-8); }
  let H0 = 0x67452301, H1 = 0xEFCDAB89, H2 = 0x98BADCFE, H3 = 0x10325476, H4 = 0xC3D2E1F0;
  const ml = msg.length;
  const wa = [];
  for (let i = 0; i < ml; i++) wa[i >> 2] |= msg.charCodeAt(i) << (24 - (i % 4) * 8);
  const l = ((ml + 8) >> 6) + 1;
  const words = new Array(l * 16).fill(0);
  for (let i = 0; i < wa.length; i++) words[i] = wa[i];
  words[ml >> 2] |= 0x80 << (24 - (ml % 4) * 8);
  words[words.length - 1] = ml * 8;

  for (let i = 0; i < words.length; i += 16) {
    const w = words.slice(i, i + 16);
    let a = H0, b = H1, c = H2, d = H3, e = H4;
    for (let t = 0; t < 80; t++) {
      let wt;
      if (t < 16) wt = w[t];
      else {
        const x = w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16];
        wt = rotl(x, 1); w[t] = wt;
      }
      let f, k;
      if (t < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
      else if (t < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
      else if (t < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
      else { f = b ^ c ^ d; k = 0xCA62C1D6; }
      const temp = (rotl(a, 5) + f + e + k + (wt >>> 0)) >>> 0;
      e = d; d = c; c = rotl(b, 30) >>> 0; b = a; a = temp;
    }
    H0 = (H0 + a) >>> 0; H1 = (H1 + b) >>> 0; H2 = (H2 + c) >>> 0; H3 = (H3 + d) >>> 0; H4 = (H4 + e) >>> 0;
  }
  return tohex(H0) + tohex(H1) + tohex(H2) + tohex(H3) + tohex(H4);
}

function titleize(s) {
  return String(s || "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function BooksScreen() {
  const [loading, setLoading] = useState(true);
  const [subjects, setSubjects] = useState([]);
  const [expanded, setExpanded] = useState({});
  const [studentGrade, setStudentGrade] = useState(null);

  const [search, setSearch] = useState("");
  const [languageFilter, setLanguageFilter] = useState("All");

  const [downloadProgress, setDownloadProgress] = useState({});
  const [downloadingMap, setDownloadingMap] = useState({});
  const activeDownloadsRef = useRef({});

  const [downloadedFilesList, setDownloadedFilesList] = useState([]);
  const [managerVisible, setManagerVisible] = useState(false);

  // in-app only online viewer (no external app, no local PDF render)
  const [viewer, setViewer] = useState({ visible: false, uri: null, title: "" });

  const ensureBooksDir = useCallback(async () => {
    const info = await FileSystem.getInfoAsync(BOOKS_DIR);
    if (!info.exists) await FileSystem.makeDirectoryAsync(BOOKS_DIR, { intermediates: true });
  }, []);

  const getLocalFilename = useCallback((url) => {
    if (!url) return null;
    let ext = "pdf";
    try {
      const pathPart = url.split("?")[0].split("#")[0];
      const parts = pathPart.split(".");
      if (parts.length > 1) {
        const e = parts[parts.length - 1].toLowerCase();
        if (/^[a-z0-9]{1,5}$/.test(e)) ext = e;
      }
    } catch {}
    return `${sha1(url)}.${ext}`;
  }, []);

  const getLocalPathForUrl = useCallback((url) => {
    const name = getLocalFilename(url);
    return name ? `${BOOKS_DIR}${name}` : null;
  }, [getLocalFilename]);

  const loadDownloadIndex = useCallback(async () => {
    try {
      const raw = await AsyncStorage.getItem(DOWNLOAD_INDEX_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }, []);

  const saveDownloadIndex = useCallback(async (idx) => {
    await AsyncStorage.setItem(DOWNLOAD_INDEX_KEY, JSON.stringify(idx || {}));
  }, []);

  const registerDownloadMetadata = useCallback(async (url, meta) => {
    const filename = getLocalFilename(url);
    if (!filename) return;
    const idx = await loadDownloadIndex();
    idx[filename] = {
      url,
      title: meta.title || filename,
      subjectName: meta.subjectName || null,
      downloadedAt: Date.now(),
    };
    await saveDownloadIndex(idx);
  }, [getLocalFilename, loadDownloadIndex, saveDownloadIndex]);

  const removeDownloadMetadata = useCallback(async (filename) => {
    const idx = await loadDownloadIndex();
    if (idx[filename]) {
      delete idx[filename];
      await saveDownloadIndex(idx);
    }
  }, [loadDownloadIndex, saveDownloadIndex]);

  const refreshDownloadedFiles = useCallback(async () => {
    await ensureBooksDir();
    const idx = await loadDownloadIndex();
    const names = await FileSystem.readDirectoryAsync(BOOKS_DIR);
    const list = [];
    for (const name of names) {
      const uri = `${BOOKS_DIR}${name}`;
      const info = await FileSystem.getInfoAsync(uri);
      if (!info.exists) continue;
      const meta = idx[name] || {};
      list.push({
        name,
        uri,
        size: info.size || 0,
        modificationTime: info.modificationTime || 0,
        title: meta.title || name,
        url: meta.url || null,
        subjectName: meta.subjectName || null,
      });
    }
    list.sort((a, b) => (b.modificationTime || 0) - (a.modificationTime || 0));
    setDownloadedFilesList(list);
  }, [ensureBooksDir, loadDownloadIndex]);

  const cancelDownload = useCallback(async (url) => {
    const active = activeDownloadsRef.current[url];
    if (active?.resumable?.cancelAsync) {
      try { await active.resumable.cancelAsync(); } catch {}
    }
    const localPath = getLocalPathForUrl(url);
    const info = await FileSystem.getInfoAsync(localPath);
    if (info.exists) await FileSystem.deleteAsync(localPath, { idempotent: true });

    setDownloadingMap((s) => { const c = { ...s }; delete c[url]; return c; });
    setDownloadProgress((s) => { const c = { ...s }; delete c[url]; return c; });
    delete activeDownloadsRef.current[url];
  }, [getLocalPathForUrl]);

  const downloadToLocal = useCallback(async (url, meta = {}) => {
    await ensureBooksDir();
    const localPath = getLocalPathForUrl(url);

    setDownloadingMap((s) => ({ ...s, [url]: true }));
    setDownloadProgress((s) => ({ ...s, [url]: 0 }));

    const resumable = FileSystem.createDownloadResumable(
      url,
      localPath,
      {},
      (dp) => {
        if (dp.totalBytesExpectedToWrite > 0) {
          setDownloadProgress((s) => ({
            ...s,
            [url]: dp.totalBytesWritten / dp.totalBytesExpectedToWrite,
          }));
        }
      }
    );
    activeDownloadsRef.current[url] = { resumable };

    try {
      const out = await resumable.downloadAsync();
      setDownloadingMap((s) => { const c = { ...s }; delete c[url]; return c; });
      setDownloadProgress((s) => ({ ...s, [url]: 1 }));
      delete activeDownloadsRef.current[url];
      await registerDownloadMetadata(url, meta);
      await refreshDownloadedFiles();
      return out.uri;
    } catch (err) {
      try {
        const fb = await FileSystem.downloadAsync(url, localPath);
        setDownloadingMap((s) => { const c = { ...s }; delete c[url]; return c; });
        setDownloadProgress((s) => ({ ...s, [url]: 1 }));
        delete activeDownloadsRef.current[url];
        await registerDownloadMetadata(url, meta);
        await refreshDownloadedFiles();
        return fb.uri;
      } catch (e) {
        const info = await FileSystem.getInfoAsync(localPath);
        if (info.exists) await FileSystem.deleteAsync(localPath, { idempotent: true });
        setDownloadingMap((s) => { const c = { ...s }; delete c[url]; return c; });
        setDownloadProgress((s) => { const c = { ...s }; delete c[url]; return c; });
        delete activeDownloadsRef.current[url];
        throw e || err;
      }
    }
  }, [ensureBooksDir, getLocalPathForUrl, registerDownloadMetadata, refreshDownloadedFiles]);

  const openRemotePdfInViewer = useCallback((remoteUrl, title) => {
    const gview = `https://docs.google.com/gview?embedded=1&url=${encodeURIComponent(remoteUrl)}`;
    setViewer({ visible: true, uri: gview, title });
  }, []);

  const deleteFile = useCallback(async (file) => {
    await FileSystem.deleteAsync(file.uri, { idempotent: true });
    await removeDownloadMetadata(file.name);
    await refreshDownloadedFiles();
  }, [removeDownloadMetadata, refreshDownloadedFiles]);

  const loadStudentGrade = useCallback(async () => {
    try {
      const studentNodeKey =
        (await AsyncStorage.getItem("studentNodeKey")) ||
        (await AsyncStorage.getItem("studentId")) ||
        (await AsyncStorage.getItem("username")) ||
        null;

      if (!studentNodeKey) return null;

      const prefix = String(studentNodeKey).slice(0, 3).toUpperCase();
      const schoolCodeSnap = await get(ref(database, `Platform1/schoolCodeIndex/${prefix}`));
      const schoolCode = schoolCodeSnap.exists() ? schoolCodeSnap.val() : null;

      if (schoolCode) {
        const stSnap = await get(ref(database, `Platform1/Schools/${schoolCode}/Students/${studentNodeKey}`));
        if (stSnap.exists()) {
          const st = stSnap.val() || {};
          const g = String(st?.basicStudentInformation?.grade || st?.grade || "").trim();
          if (g) {
            setStudentGrade(g);
            return g;
          }
        }
      }

      const cached = await AsyncStorage.getItem("studentGrade");
      if (cached) {
        const g = String(cached).toLowerCase().replace("grade", "").trim();
        if (g) {
          setStudentGrade(g);
          return g;
        }
      }
    } catch (err) {
      console.warn("loadStudentGrade error:", err);
    }
    return null;
  }, []);

  const openUnit = useCallback(async (unit, subjectName) => {
    const url = unit.pdfUrl;
    if (!url) return Alert.alert("No PDF", "This unit has no pdfUrl.");

    const localPath = getLocalPathForUrl(url);
    const info = await FileSystem.getInfoAsync(localPath);

    // In-app only policy:
    // - If downloaded: still read online in-app (gview) since local render isn't stable without native PDF lib.
    // - If not downloaded: read online or download for offline cache only.
    if (info.exists) {
      return openRemotePdfInViewer(url, unit.title);
    }

    Alert.alert("Read Unit", "Choose action.", [
      { text: "Cancel", style: "cancel" },
      { text: "Read Online", onPress: () => openRemotePdfInViewer(url, unit.title) },
      {
        text: "Download (cache only)",
        onPress: async () => {
          try {
            await downloadToLocal(url, { title: unit.title, subjectName });
            Alert.alert("Downloaded", "Saved for offline cache. Reading stays in-app online.");
          } catch {
            Alert.alert("Download failed", "Unable to download this unit.");
          }
        },
      },
    ]);
  }, [downloadToLocal, getLocalPathForUrl, openRemotePdfInViewer]);

  const downloadOrCancel = useCallback(async (unit, subjectName) => {
    const url = unit.pdfUrl;
    if (!url) return Alert.alert("No PDF", "This unit has no pdfUrl.");
    if (downloadingMap[url]) {
      return Alert.alert("Cancel download?", "", [
        { text: "No", style: "cancel" },
        { text: "Yes", onPress: () => cancelDownload(url) },
      ]);
    }
    try {
      await downloadToLocal(url, { title: unit.title, subjectName });
      Alert.alert("Done", "Unit downloaded (cache).");
    } catch {
      Alert.alert("Failed", "Download failed.");
    }
  }, [cancelDownload, downloadToLocal, downloadingMap]);

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

      const gradeKey = `grade${grade}`;
      try {
        const snap = await get(ref(database, `Platform1/TextBooks/${gradeKey}`));
        if (!snap.exists()) {
          if (mounted) { setSubjects([]); setLoading(false); }
          return;
        }

        const booksObj = snap.val() || {};
        const list = Object.keys(booksObj).map((subjectKey) => {
          const b = booksObj[subjectKey] || {};
          const unitsObj = b.units || {};

          const units = Object.keys(unitsObj).map((uk, idx) => {
            const u = unitsObj[uk] || {};
            return {
              unitKey: uk,
              order: Number(String(uk).replace(/\D/g, "")) || idx + 1,
              title: u.title || titleize(uk),
              pdfUrl: u.pdfUrl || null,
            };
          }).sort((a, b2) => a.order - b2.order);

          return {
            subjectKey,
            subjectName: titleize(subjectKey),
            title: b.title || titleize(subjectKey),
            coverUrl: b.coverUrl || null,
            language: b.language || "",
            region: b.region || "",
            units,
            totalUnits: units.length,
          };
        });

        if (mounted) setSubjects(list);
      } catch (err) {
        console.warn("TextBooks load error:", err);
        if (mounted) setSubjects([]);
      } finally {
        if (mounted) setLoading(false);
      }
    })();

    return () => { mounted = false; };
  }, [ensureBooksDir, loadStudentGrade, refreshDownloadedFiles]);

  const toggleExpand = useCallback((k) => setExpanded((p) => ({ ...p, [k]: !p[k] })), []);

  const languages = useMemo(() => {
    const set = new Set(subjects.map((s) => s.language).filter(Boolean));
    return ["All", ...Array.from(set)];
  }, [subjects]);

  const filteredSubjects = useMemo(() => {
    const q = search.trim().toLowerCase();
    return subjects
      .filter((s) => languageFilter === "All" || s.language === languageFilter)
      .map((s) => {
        if (!q) return s;
        const units = s.units.filter((u) => u.title.toLowerCase().includes(q));
        const subjectMatch = s.subjectName.toLowerCase().includes(q) || s.title.toLowerCase().includes(q);
        if (subjectMatch) return s;
        return { ...s, units, totalUnits: units.length };
      })
      .filter((s) => s.totalUnits > 0 || s.subjectName.toLowerCase().includes(search.toLowerCase()));
  }, [subjects, search, languageFilter]);

  function UnitRow({ unit, subjectName, index }) {
    const url = unit.pdfUrl;
    const isDownloading = !!downloadingMap[url];
    const progress = Math.round((downloadProgress[url] || 0) * 100);

    const [downloaded, setDownloaded] = useState(false);
    useEffect(() => {
      let mounted = true;
      (async () => {
        if (!url) return;
        const path = getLocalPathForUrl(url);
        const info = await FileSystem.getInfoAsync(path).catch(() => ({ exists: false }));
        if (mounted) setDownloaded(!!info.exists);
      })();
      return () => { mounted = false; };
    }, [url, downloadingMap[url], getLocalPathForUrl]);

    return (
      <View style={styles.unitRow}>
        <Text style={styles.unitIndex}>{unit.order || index + 1}.</Text>
        <View style={{ flex: 1 }}>
          <Text style={styles.unitTitle}>{unit.title}</Text>
          <Text style={styles.unitMeta}>
            {downloaded ? "Downloaded (cache)" : "Cloud"} • PDF
          </Text>
        </View>

        {isDownloading ? (
          <TouchableOpacity onPress={() => cancelDownload(url)} style={styles.progressWrap}>
            <ActivityIndicator color="#fff" />
            <Text style={styles.progressText}>{progress}%</Text>
          </TouchableOpacity>
        ) : (
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <Pressable onPress={() => openUnit(unit, subjectName)} style={[styles.readBtn, { marginRight: 8 }]}>
              <Text style={styles.readBtnText}>Read</Text>
            </Pressable>
            <TouchableOpacity onPress={() => downloadOrCancel(unit, subjectName)} style={[styles.iconDownload, downloaded ? styles.iconDownloaded : null]}>
              <Ionicons name={downloaded ? "cloud-done" : "cloud-download-outline"} size={18} color={downloaded ? "#fff" : PRIMARY} />
            </TouchableOpacity>
          </View>
        )}
      </View>
    );
  }

  const totalDownloadedSizeMB = useMemo(() => {
    const total = downloadedFilesList.reduce((s, f) => s + (f.size || 0), 0);
    return (total / (1024 * 1024)).toFixed(2);
  }, [downloadedFilesList]);

  if (loading) {
    return <View style={styles.center}><ActivityIndicator size="large" color={PRIMARY} /></View>;
  }

  if (!subjects.length) {
    return (
      <View style={styles.emptyContainer}>
        <Image source={require("../../assets/images/no_data_illustrator.jpg")} style={styles.emptyImage} resizeMode="contain" />
        <Text style={styles.emptyTitle}>No textbooks available</Text>
        <Text style={styles.emptySubtitle}>We couldn’t find textbooks for grade {studentGrade || "—"}.</Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.headerTitle}>TextBooks</Text>
          <Text style={styles.headerSubtitle}>Grade {studentGrade || "—"} • Learn by units</Text>
        </View>

        <TouchableOpacity style={styles.downloadManagerBtn} onPress={async () => { await refreshDownloadedFiles(); setManagerVisible(true); }}>
          <Ionicons name="cloud-outline" size={20} color={PRIMARY} />
          <Text style={styles.downloadManagerText}>Downloads</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.toolbar}>
        <View style={styles.searchWrap}>
          <Ionicons name="search-outline" size={18} color={MUTED} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search subject or unit"
            placeholderTextColor={MUTED}
            style={styles.searchInput}
          />
        </View>

        <FlatList
          horizontal
          data={languages}
          keyExtractor={(x) => x}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingLeft: 12 }}
          renderItem={({ item }) => (
            <TouchableOpacity onPress={() => setLanguageFilter(item)} style={[styles.filterChip, languageFilter === item ? styles.filterChipOn : null]}>
              <Text style={[styles.filterChipText, languageFilter === item ? styles.filterChipTextOn : null]}>{item}</Text>
            </TouchableOpacity>
          )}
        />
      </View>

      <FlatList
        data={filteredSubjects}
        keyExtractor={(item) => item.subjectKey}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <View style={{ flexDirection: "row", alignItems: "center", flex: 1 }}>
                <Image source={item.coverUrl ? { uri: item.coverUrl } : require("../../assets/images/no_data_illustrator.jpg")} style={styles.cover} />
                <View style={{ marginLeft: 12, flex: 1 }}>
                  <Text style={styles.subjectName}>{item.title}</Text>
                  <Text style={styles.subjectSub}>{item.totalUnits} unit{item.totalUnits === 1 ? "" : "s"}</Text>
                  <View style={{ flexDirection: "row", marginTop: 6 }}>
                    {!!item.language && <Text style={styles.metaChip}>{item.language}</Text>}
                    {!!item.region && <Text style={styles.metaChip}>{item.region}</Text>}
                  </View>
                </View>
              </View>

              <TouchableOpacity style={styles.expandBtn} onPress={() => toggleExpand(item.subjectKey)}>
                <Ionicons name={expanded[item.subjectKey] ? "chevron-up-outline" : "chevron-down-outline"} size={24} color="#444" />
              </TouchableOpacity>
            </View>

            {expanded[item.subjectKey] && (
              <View style={styles.unitsContainer}>
                {item.units.map((u, idx) => <UnitRow key={u.unitKey} unit={u} subjectName={item.subjectName} index={idx} />)}
              </View>
            )}
          </View>
        )}
      />

      {/* In-app online reader only */}
      <Modal visible={viewer.visible} animationType="slide" onRequestClose={() => setViewer({ visible: false, uri: null, title: "" })}>
        <SafeAreaView style={styles.readerContainer}>
          <View style={styles.readerHeader}>
            <TouchableOpacity onPress={() => setViewer({ visible: false, uri: null, title: "" })} style={{ padding: 8 }}>
              <Ionicons name="close" size={22} color="#222" />
            </TouchableOpacity>
            <Text style={styles.readerTitle} numberOfLines={1}>{viewer.title}</Text>
            <View style={{ width: 36 }} />
          </View>

          {viewer.uri ? (
            <WebView
              source={{ uri: viewer.uri }}
              originWhitelist={["*"]}
              javaScriptEnabled
              domStorageEnabled
              startInLoadingState
              style={{ flex: 1, backgroundColor: "#fff" }}
              onError={() => Alert.alert("Unable to load", "Could not open online reader for this PDF.")}
            />
          ) : (
            <View style={styles.center}><Text style={{ color: MUTED }}>No document selected</Text></View>
          )}
        </SafeAreaView>
      </Modal>

      <Modal visible={managerVisible} animationType="slide" onRequestClose={() => setManagerVisible(false)}>
        <SafeAreaView style={styles.managerContainer}>
          <View style={styles.managerHeader}>
            <TouchableOpacity onPress={() => setManagerVisible(false)} style={{ padding: 8 }}>
              <Ionicons name="close" size={22} color="#222" />
            </TouchableOpacity>
            <View style={{ alignItems: "center" }}>
              <Text style={styles.managerTitle}>Downloads</Text>
              <Text style={{ color: MUTED, fontSize: 12 }}>{downloadedFilesList.length} files • {totalDownloadedSizeMB} MB</Text>
            </View>
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
                    <TouchableOpacity
                      onPress={() => {
                        if (item.url) openRemotePdfInViewer(item.url, item.title);
                        else Alert.alert("No online link", "This cached file has no source URL.");
                      }}
                      style={{ marginRight: 12 }}
                    >
                      <Ionicons name="open-outline" size={22} color={PRIMARY} />
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() =>
                        Alert.alert("Delete file", "Delete this file from app storage?", [
                          { text: "Cancel", style: "cancel" },
                          {
                            text: "Delete",
                            style: "destructive",
                            onPress: async () => {
                              try {
                                await deleteFile(item);
                                Alert.alert("Deleted", "File removed.");
                              } catch {
                                Alert.alert("Error", "Delete failed.");
                              }
                            },
                          },
                        ])
                      }
                    >
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
  container: { flex: 1, backgroundColor: BG },

  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 10,
    backgroundColor: "#fff",
    borderBottomWidth: 1,
    borderBottomColor: BORDER,
  },
  headerTitle: { fontSize: 22, fontWeight: "800", color: TEXT },
  headerSubtitle: { marginTop: 4, color: MUTED, fontSize: 13 },
  downloadManagerBtn: { flexDirection: "row", alignItems: "center" },
  downloadManagerText: { color: PRIMARY, marginLeft: 6, fontWeight: "700" },

  toolbar: { backgroundColor: "#fff", borderBottomWidth: 1, borderBottomColor: BORDER, paddingBottom: 10 },
  searchWrap: {
    marginHorizontal: 12,
    marginTop: 10,
    borderWidth: 1,
    borderColor: BORDER,
    borderRadius: 10,
    backgroundColor: "#fff",
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
  },
  searchInput: { flex: 1, height: 40, color: TEXT, marginLeft: 8 },
  filterChip: {
    borderWidth: 1,
    borderColor: BORDER,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: "#fff",
    marginRight: 8,
  },
  filterChipOn: { backgroundColor: "#EAF3FF", borderColor: PRIMARY },
  filterChipText: { color: MUTED, fontSize: 12, fontWeight: "700" },
  filterChipTextOn: { color: PRIMARY },

  list: { padding: 12, paddingBottom: 24 },

  card: {
    backgroundColor: CARD,
    borderRadius: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: BORDER,
    overflow: "hidden",
  },
  cardHeader: { padding: 12, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  cover: { width: 52, height: 70, borderRadius: 8, backgroundColor: "#EDF2FF" },
  subjectName: { fontWeight: "800", fontSize: 16, color: TEXT },
  subjectSub: { color: MUTED, marginTop: 4, fontSize: 12 },
  metaChip: {
    marginRight: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: "#F1F5FF",
    color: PRIMARY,
    fontSize: 11,
    overflow: "hidden",
  },
  expandBtn: { paddingHorizontal: 8, paddingVertical: 6 },

  unitsContainer: { paddingHorizontal: 12, paddingBottom: 12 },
  unitRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    borderTopColor: BORDER,
    borderTopWidth: 1,
  },
  unitIndex: { color: MUTED, width: 26, fontWeight: "700" },
  unitTitle: { fontSize: 14, fontWeight: "700", color: "#1B2B45" },
  unitMeta: { color: MUTED, fontSize: 12, marginTop: 3 },

  readBtn: {
    backgroundColor: PRIMARY,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  readBtnText: { color: "#fff", fontWeight: "800" },

  iconDownload: {
    width: 40,
    height: 40,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: PRIMARY,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#fff",
  },
  iconDownloaded: { backgroundColor: PRIMARY, borderColor: PRIMARY },

  center: { flex: 1, alignItems: "center", justifyContent: "center" },

  progressWrap: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: PRIMARY,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
  },
  progressText: { color: "#fff", marginLeft: 8, fontWeight: "700" },

  emptyContainer: { flex: 1, backgroundColor: BG, alignItems: "center", justifyContent: "center", padding: 24 },
  emptyImage: { width: 220, height: 160, marginBottom: 18 },
  emptyTitle: { fontSize: 20, fontWeight: "800", color: "#222", marginBottom: 6 },
  emptySubtitle: { fontSize: 14, color: MUTED, textAlign: "center" },

  readerContainer: { flex: 1, backgroundColor: "#fff" },
  readerHeader: {
    height: 56,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: BORDER,
  },
  readerTitle: { fontWeight: "700", fontSize: 15, color: "#222", flex: 1, textAlign: "center" },

  managerContainer: { flex: 1, backgroundColor: "#fff" },
  managerHeader: {
    height: 56,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: BORDER,
  },
  managerTitle: { fontWeight: "700", fontSize: 16, color: "#222" },

  fileRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderBottomColor: BORDER,
    borderBottomWidth: 1,
  },
  fileName: { fontSize: 13, fontWeight: "700", color: "#111" },
  fileMeta: { fontSize: 12, color: MUTED, marginTop: 4 },
});