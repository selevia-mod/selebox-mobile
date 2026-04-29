import { AntDesign, MaterialIcons } from "@expo/vector-icons";
import { useCallback, useRef, useState } from "react";
import { RefreshControl, ScrollView, SectionList, Text, TouchableOpacity, View } from "react-native";
import useAppTheme from "../hooks/useAppTheme";
import EmptyState from "./EmptyState";
import VideoCard from "./VideoCard";

function StyledSectionList({ sections, onRefresh = async () => {}, ...props }) {
  const { theme } = useAppTheme();
  const [selectedSection, setSelectedSection] = useState("All Videos");
  const [refreshing, setRefreshing] = useState(false);
  const [showScrollUp, setShowScrollUp] = useState(false);
  const sectionListRef = useRef(null);
  const lastPressRef = useRef(0);

  const handleScroll = (event) => {
    const offsetY = event.nativeEvent.contentOffset.y;
    setShowScrollUp(offsetY > 500);
  };

  const scrollToTop = () => {
    if (sectionListRef.current?.props.sections.length === 0) return;
    sectionListRef.current?.scrollToLocation({ sectionIndex: 0, itemIndex: 0, animated: true });
  };

  const handleDoublePress = () => {
    const time = new Date().getTime();
    if (time - lastPressRef.current < 300) {
      scrollToTop();
    }
    lastPressRef.current = time;
  };

  const getFilteredSections = () => {
    if (!selectedSection || selectedSection === "All Videos") {
      return sections;
    }

    const filteredSections = sections.filter((section) => section.title === selectedSection);

    if (filteredSections.length > 0 && filteredSections[0].data.length === 0) {
      return [];
    }

    return filteredSections;
  };

  return (
    <View className="w-full flex-1">
      {showScrollUp && (
        <TouchableOpacity
          activeOpacity={0.7}
          className="absolute bottom-16 right-3 z-50 rounded-full p-3"
          style={{ backgroundColor: theme.surfaceElevated, borderWidth: 1, borderColor: theme.border }}
          onPress={scrollToTop}
        >
          <AntDesign name="arrowup" size={18} color={theme.icon} />
        </TouchableOpacity>
      )}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} className="mx-2 space-x-2 pb-4 pt-2">
        <TouchableOpacity
          activeOpacity={0.7}
          key={"All Videos"}
          onPress={() => {
            handleDoublePress();
            scrollToTop();
            setSelectedSection("All Videos");
          }}
          className="h-10 items-center justify-center rounded-full px-4"
          style={{ backgroundColor: selectedSection === "All Videos" ? theme.primary : theme.surfaceMuted }}
        >
          <Text className="font-sans text-sm font-semibold" style={{ color: selectedSection === "All Videos" ? theme.primaryContrast : theme.text }}>
            All Videos
          </Text>
        </TouchableOpacity>
        {sections.map((section) => (
          <TouchableOpacity
            activeOpacity={0.7}
            key={section.title}
            onPress={() => {
              handleDoublePress();
              scrollToTop();
              setSelectedSection(section.title);
            }}
            className="h-10 items-center justify-center rounded-full px-4"
            style={{ backgroundColor: selectedSection === section.title ? theme.primary : theme.surfaceMuted }}
          >
            <Text
              className="font-sans text-sm font-semibold"
              style={{ color: selectedSection === section.title ? theme.primaryContrast : theme.text }}
            >
              {section.title}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
      <SectionList
        className="h-full"
        ref={sectionListRef}
        onScroll={handleScroll}
        initialNumToRender={10}
        maxToRenderPerBatch={20}
        removeClippedSubviews={true}
        windowSize={10}
        sections={getFilteredSections()}
        keyExtractor={(item) => item.uri}
        renderItem={({ item }) => <VideoCard key={item.uri} item={item} />}
        renderSectionHeader={({ section: { title } }) => (
          <View className="flex-row items-center space-x-2 px-2 py-2" style={{ backgroundColor: theme.background }}>
            <MaterialIcons name="multitrack-audio" size={16} color={theme.icon} />
            <Text className="font-pbold text-sm uppercase tracking-[4px]" style={{ color: theme.text }}>
              {title}
            </Text>
          </View>
        )}
        ListEmptyComponent={() => <EmptyState title="No Videos Found" />}
        ListFooterComponent={<View style={{ height: 100 }} />}
        refreshControl={
          <RefreshControl
            tintColor={theme.primary}
            titleColor={theme.text}
            refreshing={refreshing}
            onRefresh={useCallback(async () => {
              setRefreshing(true);
              await onRefresh();
              setRefreshing(false);
            })}
          />
        }
        {...props}
      />
    </View>
  );
}

export default StyledSectionList;
