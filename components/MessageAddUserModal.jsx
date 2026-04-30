import { Feather, Ionicons } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import { Dimensions, FlatList, Text, TextInput, TouchableOpacity, View } from "react-native";
import Animated, { FadeIn, FadeOut, LinearTransition } from "react-native-reanimated";
import { Query } from "react-native-appwrite";
import FastImage from "react-native-fast-image";
import Modal from "react-native-modal";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useGlobalContext } from "../context/global-provider";
import useAppTheme from "../hooks/useAppTheme";
import { FollowService } from "../lib/follows";
import { fetchUsersByQuery } from "../lib/users";

const SCREEN_HEIGHT = Dimensions.get("window").height;

const MessageAddUserModal = ({ existingUsers, isVisible, onClose, handleAddUsers }) => {
  const { theme } = useAppTheme();
  const insets = useSafeAreaInsets();
  const { user, allCreators } = useGlobalContext();
  const [search, setSearch] = useState("");
  const [users, setUsers] = useState([]);
  const [selectedUsers, setSelectedUsers] = useState([]);
  const [randomCreators, setRandomCreators] = useState([]);
  const [following, setFollowing] = useState([]);
  const [followingLoading, setFollowingLoading] = useState(true);

  useEffect(() => {
    const shuffleRandomCreators = () => {
      const shuffled = allCreators.sort(() => 0.5 - Math.random());
      const randomCreators = shuffled.slice(0, 20).filter((item) => !existingUsers?.includes(item?.$id));
      setRandomCreators(randomCreators);
    };

    const fetchFollowings = async () => {
      try {
        const followingData = await FollowService.getFollowing({ userId: user?.$id });
        setFollowing(followingData.filter((item) => !existingUsers?.includes(item?.followingId?.$id)));
        setFollowingLoading(false);
      } catch (error) {
        console.log("fetchFollowings: error", error);
        setFollowingLoading(false);
      }
    };

    shuffleRandomCreators();
    fetchFollowings();
  }, []);

  useEffect(() => {
    if (search.trim() === "") {
      setUsers([]);
      return;
    }

    const delaySearch = setTimeout(async () => {
      try {
        const response = await fetchUsersByQuery([Query.contains("username", search)]);
        setUsers(response.documents.filter((item) => !existingUsers.includes(item?.$id)));
      } catch (err) {
        console.error("Fetch users error:", err);
      }
    }, 300);

    return () => clearTimeout(delaySearch);
  }, [search]);

  const onAddUsers = () => {
    handleAddUsers(selectedUsers);
  };

  const toggleUserSelection = (user) => {
    if (selectedUsers.some((u) => u.$id === user.$id)) {
      setSelectedUsers(selectedUsers.filter((u) => u.$id !== user.$id));
    } else {
      setSelectedUsers([...selectedUsers, user]);
    }
  };

  return (
    <Modal
      isVisible={isVisible}
      onBackdropPress={onClose}
      onBackButtonPress={onClose}
      swipeDirection="down"
      onSwipeComplete={onClose}
      style={{ justifyContent: "flex-end", margin: 0 }}
      backdropOpacity={0.3}
      propagateSwipe
    >
      <View
        style={[
          { height: SCREEN_HEIGHT * 0.8, borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingBottom: insets.bottom + 16 },
          { backgroundColor: theme.surfaceElevated, borderTopWidth: 1, borderTopColor: theme.border },
        ]}
      >
        {/* Drag Handle */}
        <View className="items-center py-2">
          <View className="h-1.5 w-20 rounded-full" style={{ backgroundColor: theme.handle }} />
        </View>

        <View className="flex-row items-center justify-between px-4 py-2">
          <TouchableOpacity className="flex-1" onPress={onClose}>
            <Text className="font-medium" style={{ color: theme.primary }}>
              Cancel
            </Text>
          </TouchableOpacity>
          <Text className="flex-1 text-center text-base font-bold" style={{ color: theme.text }}>
            Choose Users
          </Text>
          <TouchableOpacity
            disabled={!selectedUsers?.length > 0}
            style={{ opacity: selectedUsers?.length > 0 ? 1 : 0 }}
            className="flex-1 items-end"
            onPress={onAddUsers}
          >
            <View
              style={{
                backgroundColor: selectedUsers?.length > 0 ? theme.primary : "transparent",
                paddingHorizontal: 16,
                paddingVertical: 6,
                borderRadius: 8,
              }}
            >
              <Text className="font-medium" style={{ color: theme.primaryContrast }}>
                Add
              </Text>
            </View>
          </TouchableOpacity>
        </View>

        <View
          className="mx-4 my-2 flex-row items-center rounded-xl px-3"
          style={{ backgroundColor: theme.inputBackground, borderWidth: 1, borderColor: theme.inputBorder }}
        >
          <Feather name="search" size={16} color={theme.iconMuted} />
          <TextInput
            className="ml-2 flex-1 py-3 text-base"
            style={{ color: theme.inputText }}
            placeholder="Search users..."
            placeholderTextColor={theme.placeholder}
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
                  <FastImage
                    key={item.$id}
                    source={{ uri: item.avatar }}
                    className="h-12 w-12 rounded-xl"
                    style={{ backgroundColor: theme.surfaceMuted }}
                  />
                  <View
                    style={{
                      position: "absolute",
                      top: -4,
                      right: -4,
                      backgroundColor: theme.danger,
                      borderRadius: 999,
                      width: 18,
                      height: 18,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Ionicons name="close" size={12} color={theme.primaryContrast} />
                  </View>
                </TouchableOpacity>
                <Text className="mt-2 text-center" style={{ color: theme.textMuted }} numberOfLines={2} ellipsizeMode="tail">
                  {item?.username}
                </Text>
              </Animated.View>
            )}
            horizontal
            showsHorizontalScrollIndicator={false}
          />
        </Animated.View>

        <FlatList
          data={search === "" ? randomCreators : users}
          keyExtractor={(item) => item.$id}
          showsVerticalScrollIndicator={false}
          renderItem={({ item }) => (
            <TouchableOpacity
              className="mx-4 mb-2 flex-row items-center justify-between rounded-2xl p-3"
              style={{ backgroundColor: theme.card }}
              onPress={() => toggleUserSelection(item)}
            >
              <View className="flex-row items-center">
                <FastImage
                  source={{ uri: item.avatar, priority: FastImage.priority.normal }}
                  className="h-12 w-12 rounded-xl"
                  style={{ backgroundColor: theme.surfaceMuted }}
                />
                <Text className="ml-4 font-sans text-base font-medium" style={{ color: theme.text }}>
                  {item.username}
                </Text>
              </View>
              <TouchableOpacity onPress={() => toggleUserSelection(item)}>
                <View
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 11,
                    backgroundColor: selectedUsers.some((u) => u.$id === item.$id) ? theme.primary : "transparent",
                    borderWidth: selectedUsers.some((u) => u.$id === item.$id) ? 0 : 2,
                    borderColor: theme.borderStrong,
                  }}
                />
              </TouchableOpacity>
            </TouchableOpacity>
          )}
          ListHeaderComponent={
            !search && (
              <View>
                <View className="flex-row items-center px-4 pb-1">
                  <Ionicons name="people" size={14} color={theme.accentAmber} style={{ marginRight: 6 }} />
                  <Text className="text-sm font-bold tracking-[1px]" style={{ color: theme.textSoft }}>
                    Following
                  </Text>
                </View>
                <FlatList
                  data={following}
                  keyExtractor={(item) => item.followingId?.$id}
                  renderItem={({ item }) => (
                    <TouchableOpacity
                      className="mx-4 mb-2 flex-row items-center justify-between rounded-2xl p-3"
                      style={{ backgroundColor: theme.card }}
                      onPress={() => toggleUserSelection(item.followingId)}
                    >
                      <View className="flex-row items-center">
                        <FastImage
                          source={{ uri: item?.followingId?.avatar, priority: FastImage.priority.normal }}
                          className="h-12 w-12 rounded-xl"
                          style={{ backgroundColor: theme.surfaceMuted }}
                        />
                        <Text className="ml-4 font-sans text-base font-medium" style={{ color: theme.text }}>
                          {item?.followingId?.username ?? "Deleted User"}
                        </Text>
                      </View>
                      <TouchableOpacity onPress={() => toggleUserSelection(item?.followingId)}>
                        <View
                          style={{
                            width: 22,
                            height: 22,
                            borderRadius: 11,
                            backgroundColor: selectedUsers.some((u) => u.$id === item.followingId?.$id) ? theme.primary : "transparent",
                            borderWidth: selectedUsers.some((u) => u.$id === item.followingId?.$id) ? 0 : 2,
                            borderColor: theme.borderStrong,
                          }}
                        />
                      </TouchableOpacity>
                    </TouchableOpacity>
                  )}
                  ListEmptyComponent={
                    followingLoading ? null : (
                      <View className="items-center justify-center px-4 py-6">
                        <Feather name="user-x" size={28} color={theme.iconMuted} style={{ marginBottom: 6 }} />
                        <Text className="font-sans text-sm font-medium" style={{ color: theme.textSoft }}>
                          No following users
                        </Text>
                      </View>
                    )
                  }
                />
                <View className="mt-2 flex-row items-center px-4 pb-1">
                  <Ionicons name="sparkles" size={14} color={theme.accentPurple} style={{ marginRight: 6 }} />
                  <Text className="text-sm font-bold tracking-[1px]" style={{ color: theme.textSoft }}>
                    Suggested Users
                  </Text>
                </View>
              </View>
            )
          }
        />
      </View>
    </Modal>
  );
};

export default MessageAddUserModal;
