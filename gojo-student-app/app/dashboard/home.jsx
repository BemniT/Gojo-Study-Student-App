import React, { useEffect, useState, useCallback, useRef, useMemo } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Image,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Dimensions,
  Alert,
  Animated,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  ref,
  query,
  orderByChild,
  limitToLast,
  equalTo,
  endAt,
  onValue,
  off,
  get,
  update,
  runTransaction,
} from "firebase/database";
import { database } from "../../constants/firebaseConfig";

/**
 * Home feed with pagination ("load more") for older posts.
 * - Realtime listener fetches newest PAGE_SIZE posts (keeps them live).
 * - "Load more" fetches older pages via one-time queries and appends them.
 * - Prefetches images and caches minimal admin lookups.
 * - Optimistic like UI with atomic DB updates via runTransaction.
 *
 * How pagination works:
 * - Initial realtime query: orderByChild("time"), limitToLast(PAGE_SIZE)
 *   (returns newest PAGE_SIZE posts).
 * - For load more: use orderByChild("time"), endAt(oldestTime), limitToLast(PAGE_SIZE + 1)
 *   then drop duplicate overlap and append older items.
 *
 * Important: add index on Posts.time in RTDB rules for fast queries:
 * "Posts": { ".indexOn": ["time"] }
 */

const SCREEN_WIDTH = Dimensions.get("window").width;
const IMAGE_HEIGHT = Math.round(SCREEN_WIDTH * 0.9 * 0.65);
const PAGE_SIZE = 20;

function timeAgo(iso) {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const seconds = Math.floor((Date.now() - t) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  const years = Math.floor(months / 12);
  return `${years}y`;
}

export default function HomeScreen() {
  // postsLatest: controlled by realtime listener (newest PAGE_SIZE)
  // postsOlder: appended older pages loaded via get()
  const [postsLatest, setPostsLatest] = useState([]); // newest first
  const [postsOlder, setPostsOlder] = useState([]); // older pages appended after latest; oldest at end
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [userId, setUserId] = useState(null);

  // admin cache to avoid repeated User queries
  const adminCacheRef = useRef({});

  // load userId and refresh cached profileImage quickly
  const loadUserContext = useCallback(async () => {
    const uid = await AsyncStorage.getItem("userId");
    setUserId(uid);

    // background: refresh cached profileImage for header
    try {
      const userNodeKey = await AsyncStorage.getItem("userNodeKey");
      if (userNodeKey) {
        const snap = await get(ref(database, `Users/${userNodeKey}`));
        if (snap.exists()) {
          const u = snap.val();
          if (u.profileImage) {
            await AsyncStorage.setItem("profileImage", u.profileImage);
            Image.prefetch(u.profileImage).catch(() => {});
          }
        }
      }
    } catch {
      // ignore
    }

    return uid;
  }, []);

  // Combine latest + older into one array for rendering (newest first)
  const combinedPosts = useMemo(() => {
    return [...postsLatest, ...postsOlder];
  }, [postsLatest, postsOlder]);

  // helper to update a single post across both arrays (used for optimistic like updates)
  const updatePostInState = (postId, updater) => {
    setPostsLatest((prev) => prev.map((p) => (p.postId === postId ? updater(p) : p)));
    setPostsOlder((prev) => prev.map((p) => (p.postId === postId ? updater(p) : p)));
  };

  // Load initial realtime latest PAGE_SIZE posts
  useEffect(() => {
    const postsQuery = query(ref(database, "Posts"), orderByChild("time"), limitToLast(PAGE_SIZE));
    let unsubscribe = null;
    let mounted = true;

    (async () => {
      const currentUserId = await loadUserContext();

      unsubscribe = onValue(
        postsQuery,
        async (snap) => {
          if (!mounted) return;
          if (!snap.exists()) {
            setPostsLatest([]);
            setPostsOlder([]); // clear older too on empty DB
            setHasMore(false);
            setLoading(false);
            return;
          }

          // gather and sort newest-first
          const tmp = [];
          snap.forEach((child) => {
            const val = child.val();
            tmp.push({ postId: val.postId || child.key, data: val });
          });
          tmp.sort((a, b) => {
            const ta = a.data.time ? new Date(a.data.time).getTime() : 0;
            const tb = b.data.time ? new Date(b.data.time).getTime() : 0;
            return tb - ta;
          });

          // unique admin ids needed
          const adminIds = Array.from(new Set(tmp.map((p) => p.data.adminId).filter(Boolean)));

          // fetch admin info only for required admins (cache results)
          await Promise.all(
            adminIds.map(async (aid) => {
              if (adminCacheRef.current[aid]) return;
              try {
                // try username lookup
                const q = query(ref(database, "Users"), orderByChild("username"), equalTo(aid));
                const s = await get(q);
                if (s.exists()) {
                  s.forEach((c) => {
                    adminCacheRef.current[aid] = { ...c.val(), _nodeKey: c.key };
                    return true;
                  });
                  return;
                }
                // fallback: lookup by userId
                const q2 = query(ref(database, "Users"), orderByChild("userId"), equalTo(aid));
                const s2 = await get(q2);
                if (s2.exists()) {
                  s2.forEach((c) => {
                    adminCacheRef.current[aid] = { ...c.val(), _nodeKey: c.key };
                    return true;
                  });
                }
              } catch {
                // ignore
              }
            })
          );

          // build enriched posts and prefetch images
          const enriched = tmp.map((p) => {
            const likesNode = p.data.likes || {};
            const seenNode = p.data.seenBy || {};

            // mark seen best-effort
            if (currentUserId && !seenNode[currentUserId]) {
              const updates = {};
              updates[`Posts/${p.postId}/seenBy/${currentUserId}`] = true;
              update(ref(database), updates).catch(() => {});
              seenNode[currentUserId] = true;
            }

            const admin = adminCacheRef.current[p.data.adminId] || null;
            return { postId: p.postId, data: p.data, admin, likesMap: likesNode, seenMap: seenNode };
          });

          // prefetch images
          enriched.forEach((e) => {
            if (e.data.postUrl) Image.prefetch(e.data.postUrl).catch(() => {});
            if (e.admin && e.admin.profileImage) Image.prefetch(e.admin.profileImage).catch(() => {});
          });

          if (mounted) {
            setPostsLatest(enriched);
            // remove any duplicates that exist in postsOlder (in case the new latest overlapped)
            setPostsOlder((prevOlder) => prevOlder.filter((o) => !enriched.some((el) => el.postId === o.postId)));
            // determine if there may be more older posts (if returned items < page size then maybe none)
            // we can't be sure because DB could have fewer than PAGE_SIZE; keep hasMore true for loadMore attempt
            setHasMore(true);
            setLoading(false);
            setRefreshing(false);
          }
        },
        (err) => {
          console.warn("Posts listener error:", err);
          if (mounted) {
            setLoading(false);
            setRefreshing(false);
          }
        }
      );
    })();

    return () => {
      mounted = false;
      if (unsubscribe) unsubscribe();
      off(postsQuery);
    };
  }, [loadUserContext]);

  const onRefresh = async () => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 700);
  };

  // Load older page (pagination). Appends older posts to postsOlder.
  const loadMore = async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      // find current oldest time from combined posts (last element)
      const combined = [...postsLatest, ...postsOlder];
      if (combined.length === 0) {
        setHasMore(false);
        setLoadingMore(false);
        return;
      }
      const oldest = combined[combined.length - 1];
      const oldestTime = oldest.data.time;
      if (!oldestTime) {
        setHasMore(false);
        setLoadingMore(false);
        return;
      }

      // Query: get PAGE_SIZE + 1 items ending at oldestTime (so we can drop overlap)
      const q = query(ref(database, "Posts"), orderByChild("time"), endAt(oldestTime), limitToLast(PAGE_SIZE + 1));
      const snap = await get(q);
      if (!snap.exists()) {
        setHasMore(false);
        setLoadingMore(false);
        return;
      }

      // collect and sort newest-first then remove duplicate overlap
      const tmp = [];
      snap.forEach((child) => {
        const val = child.val();
        tmp.push({ postId: val.postId || child.key, data: val });
      });
      tmp.sort((a, b) => {
        const ta = a.data.time ? new Date(a.data.time).getTime() : 0;
        const tb = b.data.time ? new Date(b.data.time).getTime() : 0;
        return tb - ta;
      });

      // Remove the duplicate (the one with same postId as oldest) if present at the end/start
      // tmp is newest-first; find and remove any item with postId equal to oldest.postId
      const filtered = tmp.filter((p) => p.postId !== oldest.postId);

      // If filtered is empty, no older items
      if (filtered.length === 0) {
        setHasMore(false);
        setLoadingMore(false);
        return;
      }

      // unique adminIds to fetch
      const adminIds = Array.from(new Set(filtered.map((p) => p.data.adminId).filter(Boolean)));
      await Promise.all(
        adminIds.map(async (aid) => {
          if (adminCacheRef.current[aid]) return;
          try {
            const q1 = query(ref(database, "Users"), orderByChild("username"), equalTo(aid));
            const s1 = await get(q1);
            if (s1.exists()) {
              s1.forEach((c) => {
                adminCacheRef.current[aid] = { ...c.val(), _nodeKey: c.key };
                return true;
              });
              return;
            }
            const q2 = query(ref(database, "Users"), orderByChild("userId"), equalTo(aid));
            const s2 = await get(q2);
            if (s2.exists()) {
              s2.forEach((c) => {
                adminCacheRef.current[aid] = { ...c.val(), _nodeKey: c.key };
                return true;
              });
            }
          } catch {
            // ignore
          }
        })
      );

      const enrichedOlder = filtered.map((p) => {
        const likesNode = p.data.likes || {};
        const seenNode = p.data.seenBy || {};
        const admin = adminCacheRef.current[p.data.adminId] || null;
        return { postId: p.postId, data: p.data, admin, likesMap: likesNode, seenMap: seenNode };
      });

      // prefetch images
      enrichedOlder.forEach((e) => {
        if (e.data.postUrl) Image.prefetch(e.data.postUrl).catch(() => {});
        if (e.admin && e.admin.profileImage) Image.prefetch(e.admin.profileImage).catch(() => {});
      });

      // append older items after the existing older list
      setPostsOlder((prev) => {
        // avoid duplicates if any
        const existingIds = new Set(prev.map((p) => p.postId).concat(postsLatest.map((p) => p.postId)));
        const toAdd = enrichedOlder.filter((p) => !existingIds.has(p.postId));
        const newOlder = [...prev, ...toAdd];
        // If returned items less than PAGE_SIZE, we've exhausted older posts
        if (enrichedOlder.length < PAGE_SIZE) setHasMore(false);
        return newOlder;
      });
    } catch (err) {
      console.warn("loadMore error:", err);
    } finally {
      setLoadingMore(false);
    }
  };

  // Optimistic like + runTransaction (apply updates to whichever array contains the post)
  const toggleLike = async (postId) => {
    const uid = userId || (await loadUserContext());
    if (!uid) {
      Alert.alert("Not signed in", "You must be signed in to like posts.");
      return;
    }

    // find post in latest or older and current liked state
    const findPost = () => {
      let p = postsLatest.find((x) => x.postId === postId);
      if (p) return { which: "latest", p };
      p = postsOlder.find((x) => x.postId === postId);
      if (p) return { which: "older", p };
      return null;
    };

    const found = findPost();
    if (!found) return;
    const currentlyLiked = !!(found.p.likesMap && found.p.likesMap[uid]);

    // optimistic update helper
    const optimisticUpdater = (post) => {
      const likes = { ...(post.likesMap || {}) };
      if (currentlyLiked) delete likes[uid];
      else likes[uid] = true;
      return { ...post, likesMap: likes, data: { ...post.data, likeCount: Object.keys(likes).length } };
    };

    // apply optimistic update
    if (found.which === "latest") setPostsLatest((prev) => prev.map((p) => (p.postId === postId ? optimisticUpdater(p) : p)));
    else setPostsOlder((prev) => prev.map((p) => (p.postId === postId ? optimisticUpdater(p) : p)));

    // runTransaction on DB
    const postRef = ref(database, `Posts/${postId}`);
    try {
      await runTransaction(postRef, (current) => {
        if (current === null) return current;
        if (!current.likes) current.likes = {};
        if (!current.likeCount) current.likeCount = 0;
        const likedBefore = !!current.likes[uid];
        if (likedBefore) {
          if (current.likes && current.likes[uid]) delete current.likes[uid];
          current.likeCount = Math.max(0, (current.likeCount || 1) - 1);
        } else {
          current.likes[uid] = true;
          current.likeCount = (current.likeCount || 0) + 1;
        }
        return current;
      });
      // onValue listener will reconcile for items in postsLatest; for older items loaded via get() we re-fetch if needed
    } catch (err) {
      console.warn("runTransaction failed for like:", err);
      // revert by reloading that single post from DB
      try {
        const snap = await get(postRef);
        if (snap.exists()) {
          const val = snap.val();
          const updated = { postId: val.postId || postId, data: val, likesMap: val.likes || {}, seenMap: val.seenBy || {} };
          // replace in latest or older
          setPostsLatest((prev) => prev.map((p) => (p.postId === postId ? updated : p)));
          setPostsOlder((prev) => prev.map((p) => (p.postId === postId ? updated : p)));
        }
      } catch {
        // ignore
      }
      Alert.alert("Error", "Unable to update like. Please try again.");
    }
  };

  // Post card (with pulse animation)
  function PostCard({ item }) {
    const { postId, data, admin, likesMap = {}, seenMap = {} } = item;
    const likesCount = data.likeCount || Object.keys(likesMap || {}).length;
    const seenCount = Object.keys(seenMap || {}).length;
    const isLiked = userId ? !!likesMap[userId] : false;
    const imageUri = data.postUrl || null;

    const scale = useRef(new Animated.Value(1)).current;
    const animateHeart = () => {
      Animated.sequence([
        Animated.timing(scale, { toValue: 1.18, duration: 140, useNativeDriver: true }),
        Animated.timing(scale, { toValue: 1.0, duration: 140, useNativeDriver: true }),
      ]).start();
    };
    const onHeartPress = () => {
      animateHeart();
      toggleLike(postId);
    };

    return (
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Image
            source={(admin && admin.profileImage) ? { uri: admin.profileImage } : require("../../assets/images/avatar_placeholder.png")}
            style={styles.avatar}
          />
          <View style={{ flex: 1 }}>
            <Text style={styles.username}>{admin?.name || admin?.username || "School Admin"}</Text>
            <Text style={styles.time}>{timeAgo(data.time)}</Text>
          </View>
        </View>

        {imageUri ? <Image source={{ uri: imageUri }} style={styles.postImage} resizeMode="cover" /> : null}

        <View style={styles.actionsRow}>
          <View style={styles.leftActions}>
            <TouchableOpacity onPress={onHeartPress} style={styles.iconBtn} activeOpacity={0.8}>
              <Animated.View style={{ transform: [{ scale }] }}>
                <Ionicons name={isLiked ? "heart" : "heart-outline"} size={28} color={isLiked ? "#E0245E" : "#111"} />
              </Animated.View>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.meta}>
          <Text style={styles.likesText}>{likesCount} {likesCount === 1 ? "like" : "likes"}</Text>
          <Text style={styles.messageText}>
            <Text style={styles.username}>{admin?.username || admin?.name || ""}</Text>
            {"  "}
            {data.message}
          </Text>
          <View style={styles.bottomMetaRow}>
            <Text style={styles.seenText}>{seenCount} seen</Text>
            <Text style={styles.timeSmall}> • {new Date(data.time).toLocaleString?.() ?? ""}</Text>
          </View>
        </View>
      </View>
    );
  }

  const EmptyState = () => (
    <View style={styles.emptyContainer}>
      {(() => {
        try {
          return <Image source={require("../../assets/images/no_data_illustrator.jpg")} style={styles.emptyImage} resizeMode="contain" />;
        } catch {
          return (
            <View style={styles.emptyFallbackIcon}>
              <Ionicons name="newspaper-outline" size={48} color="#B0B8D8" />
            </View>
          );
        }
      })()}
      <Text style={styles.emptyTitle}>No posts yet</Text>
      <Text style={styles.emptySubtitle}>Announcements from your school will appear here.</Text>
    </View>
  );

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#007AFB" />
      </View>
    );
  }

  if (!combinedPosts || combinedPosts.length === 0) {
    return (
      <View style={{ flex: 1, backgroundColor: "#fff" }}>
        <EmptyState />
      </View>
    );
  }

  const ListFooter = () => {
    if (loadingMore) return <ActivityIndicator style={{ margin: 16 }} color="#007AFB" />;
    if (!hasMore) return <Text style={{ textAlign: "center", color: "#888", padding: 12 }}>No more posts</Text>;
    return null;
  };

  return (
    <FlatList
      data={combinedPosts}
      keyExtractor={(i) => i.postId}
      renderItem={({ item }) => <PostCard item={item} />}
      contentContainerStyle={styles.list}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={["#007AFB"]} />}
      onEndReachedThreshold={0.6}
      onEndReached={() => {
        // load older posts when scrolling near bottom
        if (!loadingMore && hasMore) loadMore();
      }}
      ListFooterComponent={<ListFooter />}
    />
  );
}

const styles = StyleSheet.create({
  list: { paddingVertical: 12, paddingHorizontal: 12, backgroundColor: "#fff" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 20, backgroundColor: "#fff" },
  card: {
    backgroundColor: "#fff",
    borderRadius: 12,
    marginBottom: 16,
    overflow: "hidden",
    borderColor: "#F1F3F8",
    borderWidth: 1,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
  },
  avatar: { width: 46, height: 46, borderRadius: 23, marginRight: 10, backgroundColor: "#F6F8FF" },

  username: { fontWeight: "700", color: "#111" },
  time: { color: "#888", fontSize: 12, marginTop: 2 },

  postImage: {
    width: "100%",
    height: IMAGE_HEIGHT,
    backgroundColor: "#EEE",
  },

  actionsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 10,
    paddingVertical: 8,
    alignItems: "center",
  },
  leftActions: { flexDirection: "row", alignItems: "center" },

  iconBtn: { padding: 6 },

  meta: { paddingHorizontal: 12, paddingBottom: 12 },
  likesText: { fontWeight: "700", marginBottom: 6, color: "#111" },
  messageText: { color: "#222", lineHeight: 20 },

  bottomMetaRow: { flexDirection: "row", marginTop: 8, alignItems: "center" },
  seenText: { color: "#888", fontSize: 12 },
  timeSmall: { color: "#888", fontSize: 12 },

  emptyContainer: { flex: 1, backgroundColor: "#fff", alignItems: "center", justifyContent: "center", padding: 28 },
  emptyImage: { width: 260, height: 200, marginBottom: 18 },
  emptyFallbackIcon: { width: 120, height: 120, borderRadius: 60, backgroundColor: "#F6F8FF", alignItems: "center", justifyContent: "center", marginBottom: 12 },
  emptyTitle: { fontSize: 20, fontWeight: "700", color: "#222", marginBottom: 6 },
  emptySubtitle: { fontSize: 14, color: "#8B93B3", textAlign: "center" },
});