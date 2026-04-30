import { Feather, Ionicons, MaterialIcons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, FlatList, Text, TextInput, TouchableOpacity, View } from "react-native";
import Animated, { FadeIn, FadeOut, LinearTransition } from "react-native-reanimated";
import { Query } from "react-native-appwrite";
import FastImage from "react-native-fast-image";
import { SafeAreaView } from "react-native-safe-area-context";
import { Loader } from "../../components";
import AnimatedSkeleton, { getRandomSkeletonWidth } from "../../components/AnimatedSkeleton";
import { useGlobalContext } from "../../context/global-provider";
import { FollowService } from "../../lib/follows";
import { StreamService } from "../../lib/stream";
import { fetchUsersByQuery } from "../../lib/users";

const NewChat = () => {
  const { user, allCreators, setCurrentChat } = useGlobalContext();
  const [search, setSearch] = useState("");
  const [users, setUsers] = useState([]);
  const [selectedUsers, setSelectedUsers] = useState([]);
  const [following, setFollowing] = useState([]);
  const [groupName, setGroupName] = useState("");
  const [randomCreators, setRandomCreators] = useState([]);
  const [newChatLoading, setNewChatLoading] = useState(true);

  const streamService = new StreamService();

  useEffect(() => {
    const fetchFollowings = async () => {
      try {
        const followingData = await FollowService.getFollowing({ userId: user?.$id });
        setFollowing(followingData);
        setNewChatLoading(false);
      } catch (error) {
        console.log("fetchFollowings: error", error);
        setNewChatLoading(false);
      }
    };

    const shuffleRandomCreators = () => {
      const shuffled = allCreators.sort(() => 0.5 - Math.random());
      const randomCreators = shuffled.slice(0, 20);
      setRandomCreators(randomCreators);
    };

    fetchFollowings();
    shuffleRandomCreators();
  }, []);

  useEffect(() => {
    if (search.trim() === "") {
      setUsers([]);
      return;
    }

    const delaySearch = setTimeout(async () => {
      try {
        const response = await fetchUsersByQuery([Query.contains("username", search)]);
        setUsers(response.documents);
      } catch (err) {
        console.error("Fetch users error:", err);
      }
    }, 300);

    return () => clearTimeout(delaySearch);
  }, [search]);

  const toggleUserSelection = (user) => {
    if (selectedUsers.some((u) => u.$id === user.$id)) {
      setSelectedUsers(selectedUsers.filter((u) => u.$id !== user.$id));
    } else {
      setSelectedUsers([...selectedUsers, user]);
    }
  };

  const handleDone = async () => {
    try {
      if (selectedUsers.length === 1) {
        const channel = await streamService.createNewChannel({
          currentUser: user,
          selectedUsers: selectedUsers,
        });
        router.replace({
          pathname: "channel",
          params: { channelId: channel.id },
        });
      } else {
        const channel = await streamService.createNewChannel({
          currentUser: user,
          selectedUsers: selectedUsers,
          groupName: groupName,
        });
        router.replace({
          pathname: "channel",
          params: { channelId: channel.id },
        });
      }
    } catch (error) {
      console.log("createNewChannel: error", error);
      if (error?.message?.includes("deleted user") || error?.message?.includes("don't exist")) {
        Alert.alert("Unavailable", "This user's account is no longer active.");
      } else {
        Alert.alert("Error", "Could not create the conversation. Please try again.");
      }
    }
  };

  const renderListEmptyComponent = () => {
    return newChatLoading ? (
      <View>
        {[...Array(8)].map((_, index) => (
          <View key={index} className="mx-4 mb-2 flex-row items-center rounded-2xl bg-white/5 p-3">
            <AnimatedSkeleton className="h-12 w-12 rounded-xl bg-white/40" />
            <AnimatedSkeleton className="ml-4 h-6 rounded-xl bg-white/20" style={{ width: getRandomSkeletonWidth() }} />
          </View>
        ))}
      </View>
    ) : (
      <View className="items-center justify-center px-4 py-10">
        <Feather name="user-x" size={36} color="rgba(255,255,255,0.3)" style={{ marginBottom: 8 }} />
        <Text className="font-sans text-base font-medium text-white">No following users</Text>
      </View>
    );
  };

  return (
    <SafeAreaView className="flex-1 bg-gray-900">
      <Loader isLoading={false} isFullHeightWidth={true} />
      {/* Header */}
      <View className="flex-row items-center justify-between px-4 pb-3 pt-2">
        <View className="flex-row items-center">
          <TouchableOpacity
            onPress={() => router.back()}
            className="h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/5"
          >
            <MaterialIcons name="arrow-back" size={20} color="white" />
          </TouchableOpacity>
          <Text className="ml-3 font-sans text-2xl font-bold text-white">New Message</Text>
        </View>
        <TouchableOpacity onPress={handleDone} disabled={selectedUsers.length === 0}>
          <View
            style={{
              backgroundColor: selectedUsers.length > 0 ? "#7975D4" : "transparent",
              paddingHorizontal: 16,
              paddingVertical: 6,
              borderRadius: 8,
            }}
          >
            <Text className="text-base font-bold" style={{ color: selectedUsers.length === 0 ? "rgba(255,255,255,0.3)" : "#fff" }}>
              Done
            </Text>
          </View>
        </TouchableOpacity>
      </View>

      <View className="mx-4 mb-2 flex-row items-center rounded-xl bg-white/[0.08] px-3">
        <Feather name="search" size={16} color="rgba(255,255,255,0.4)" />
        <TextInput
          className="ml-2 flex-1 py-3 text-base text-white"
          placeholder="Search users..."
          placeholderTextColor="#777"
          value={search}
          onChangeText={setSearch}
          textAlignVertical="center"
        />
      </View>

      <Animated.View className="max-h-60 px-4" layout={LinearTransition}>
        <Animated.FlatList
          data={selectedUsers}
          keyExtractor={(item) => item.$id}
          itemLayoutAnimation={LinearTransition}
          renderItem={({ item }) => (
            <Animated.View className="mr-2 items-center py-2" style={{ width: 80 }} entering={FadeIn.duration(200)} exiting={FadeOut.duration(200)}>
              <TouchableOpacity onPress={() => toggleUserSelection(item)} activeOpacity={0.7}>
                <FastImage key={item.$id} source={{ uri: item.avatar }} className="h-12 w-12 rounded-xl bg-white/10" />
                <View
                  style={{
                    position: "absolute",
                    top: -4,
                    right: -4,
                    backgroundColor: "#ef4444",
                    borderRadius: 999,
                    width: 18,
                    height: 18,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Ionicons name="close" size={12} color="#fff" />
                </View>
              </TouchableOpacity>
              <Text className="mt-2 text-center text-white/80" numberOfLines={2} ellipsizeMode="tail">
                {item?.username}
              </Text>
            </Animated.View>
          )}
          horizontal
          showsHorizontalScrollIndicator={false}
        />
      </Animated.View>

      {selectedUsers.length > 1 && (
        <Animated.View className="max-h-60" entering={FadeIn.duration(200)} exiting={FadeOut.duration(150)} layout={LinearTransition}>
          <TextInput
            className="mx-4 mb-2 rounded-xl bg-white/[0.08] px-3 py-3 text-base text-white"
            placeholder="Group name (optional)"
            placeholderTextColor="#777"
            value={groupName}
            onChangeText={setGroupName}
            textAlignVertical="center"
          />
        </Animated.View>
      )}

      <FlatList
        data={search === "" ? randomCreators : users}
        keyExtractor={(item) => item.$id}
        showsVerticalScrollIndicator={false}
        renderItem={({ item }) => (
          <TouchableOpacity
            className="mx-4 mb-2 flex-row items-center justify-between rounded-2xl bg-white/5 p-3"
            onPress={() => toggleUserSelection(item)}
          >
            <View className="flex-row items-center">
              <FastImage source={{ uri: item.avatar, priority: FastImage.priority.normal }} className="h-12 w-12 rounded-xl bg-white/10" />
              <Text className="ml-4 font-sans text-base font-medium text-white">{item.username}</Text>
            </View>
            <TouchableOpacity onPress={() => toggleUserSelection(item)}>
              <View
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 11,
                  backgroundColor: selectedUsers.some((u) => u.$id === item.$id) ? "#7975D4" : "transparent",
                  borderWidth: selectedUsers.some((u) => u.$id === item.$id) ? 0 : 2,
                  borderColor: "rgba(255,255,255,0.3)",
                }}
              />
            </TouchableOpacity>
          </TouchableOpacity>
        )}
        ListHeaderComponent={
          search.length === 0 && (
            <View>
              <View className="flex-row items-center px-4 pb-1">
                <Ionicons name="people" size={14} color="#f59e0b" style={{ marginRight: 6 }} />
                <Text className="text-sm font-bold tracking-[1px] text-white/50">Following</Text>
              </View>
              <FlatList
                data={following}
                keyExtractor={(item) => item.followingId?.$id}
                renderItem={({ item }) => (
                  <TouchableOpacity
                    className="mx-4 mb-2 flex-row items-center justify-between rounded-2xl bg-white/5 p-3"
                    onPress={() => toggleUserSelection(item.followingId)}
                  >
                    <View className="flex-row items-center">
                      <FastImage
                        source={{ uri: item?.followingId?.avatar, priority: FastImage.priority.normal }}
                        className="h-12 w-12 rounded-xl bg-white/10"
                      />
                      <Text className="ml-4 font-sans text-base font-medium text-white">{item?.followingId?.username ?? "Deleted User"}</Text>
                    </View>

                    <TouchableOpacity onPress={() => toggleUserSelection(item?.followingId)}>
                      <View
                        style={{
                          width: 22,
                          height: 22,
                          borderRadius: 11,
                          backgroundColor: selectedUsers.some((u) => u.$id === item.followingId?.$id) ? "#7975D4" : "transparent",
                          borderWidth: selectedUsers.some((u) => u.$id === item.followingId?.$id) ? 0 : 2,
                          borderColor: "rgba(255,255,255,0.3)",
                        }}
                      />
                    </TouchableOpacity>
                  </TouchableOpacity>
                )}
                ListEmptyComponent={renderListEmptyComponent}
              />
              <View className="mt-2 flex-row items-center px-4 pb-1">
                <Ionicons name="sparkles" size={14} color="#a78bfa" style={{ marginRight: 6 }} />
                <Text className="text-sm font-bold tracking-[1px] text-white/50">Suggested</Text>
                <View style={{ backgroundColor: "rgba(167,139,250,0.15)", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, marginLeft: 8 }}>
                  <Text style={{ fontSize: 10, color: "#a78bfa", fontWeight: "600" }}>Coming Soon</Text>
                </View>
              </View>
            </View>
          )
        }
      />
    </SafeAreaView>
  );
};

export default NewChat;
