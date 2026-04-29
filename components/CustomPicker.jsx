import { MaterialIcons } from "@expo/vector-icons";
import { useState } from "react";
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import useAppTheme from "../hooks/useAppTheme";

const CustomPicker = ({
  options = [],
  selectedValue,
  onValueChange,
  placeholder = "Select...",
  buttonClassName = "flex-row items-center justify-between py-2 rounded-md",
  buttonBackgroundClassName = "",
  textClassName = "text-[20px]",
  dropdownClassName = "w-4/5 max-h-60 rounded-md shadow-lg",
  highlightClassName = "bg-violet-300/40",
}) => {
  const { theme } = useAppTheme();
  const [isOpen, setIsOpen] = useState(false);

  const handleSelect = (value) => {
    onValueChange?.(value);
    setIsOpen(false);
  };

  return (
    <View>
      {/* Picker Button */}
      <TouchableOpacity className={`${buttonBackgroundClassName} ${buttonClassName}`} onPress={() => setIsOpen(true)} activeOpacity={0.8}>
        <Text className="mr-2 text-[20px]" style={{ color: theme.text }}>
          {selectedValue || placeholder}
        </Text>
        <MaterialIcons name={isOpen ? "arrow-drop-up" : "arrow-drop-down"} size={35} color={theme.icon} />
      </TouchableOpacity>

      {/* Modal */}
      <Modal transparent visible={isOpen} animationType="fade" onRequestClose={() => setIsOpen(false)}>
        {/* Dark Background */}
        <TouchableOpacity
          className="flex-1 items-center justify-center"
          style={{ backgroundColor: theme.backdrop }}
          activeOpacity={1}
          onPressOut={() => setIsOpen(false)}
        >
          {/* Dropdown Container */}
          <View className={dropdownClassName} style={{ backgroundColor: theme.surfaceElevated, borderWidth: 1, borderColor: theme.border }}>
            <ScrollView
              style={styles.scrollContainer}
              contentContainerStyle={{ paddingVertical: 4 }}
              showsVerticalScrollIndicator
              indicatorStyle="default"
            >
              {options.map((item, index) => (
                <TouchableOpacity
                  key={`${item}-${index}`}
                  onPress={() => handleSelect(item)}
                  className={`px-4 py-3 ${selectedValue === item ? highlightClassName : ""}`}
                  style={selectedValue === item ? { backgroundColor: theme.primarySoft } : undefined}
                >
                  <Text className={textClassName} style={{ color: theme.text }}>
                    {item}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
};

export default CustomPicker;

const styles = StyleSheet.create({
  scrollContainer: {
    maxHeight: 900,
  },
});
