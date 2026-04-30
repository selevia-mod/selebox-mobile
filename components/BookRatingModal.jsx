import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { Modal, Text, TouchableOpacity, View } from "react-native";
import useAppTheme from "../hooks/useAppTheme";

const BookRatingModal = ({ isVisible, onClose, onSubmit }) => {
  const { theme } = useAppTheme();
  const [selectedRating, setSelectedRating] = useState(0);

  const handleRate = (value) => {
    setSelectedRating(value);
  };

  const handleSubmit = () => {
    if (selectedRating > 0) {
      onSubmit(selectedRating);
      onClose();
    }
  };

  const isDisabled = selectedRating === 0;

  return (
    <Modal visible={isVisible} transparent animationType="fade">
      <View className="flex-1 items-center justify-center" style={{ backgroundColor: theme.backdrop }}>
        <View className="w-72 rounded-xl p-5" style={{ backgroundColor: theme.surfaceElevated, borderWidth: 1, borderColor: theme.border }}>
          <Text className="mb-3 text-center text-lg font-semibold" style={{ color: theme.text }}>
            Rate this Book
          </Text>

          {/* ⭐ Star Row */}
          <View className="mb-5 flex-row justify-center">
            {[1, 2, 3, 4, 5].map((star) => (
              <TouchableOpacity key={star} onPress={() => handleRate(star)} activeOpacity={0.7}>
                <Ionicons
                  name={star <= selectedRating ? "star" : "star-outline"}
                  size={35}
                  color={star <= selectedRating ? theme.coin : theme.textSubtle}
                  style={{ marginHorizontal: 4 }}
                />
              </TouchableOpacity>
            ))}
          </View>

          <TouchableOpacity
            onPress={handleSubmit}
            disabled={isDisabled}
            className="rounded-full py-3"
            style={{ backgroundColor: isDisabled ? theme.primarySoft : theme.primary }}
          >
            <Text className="text-center font-semibold" style={{ color: theme.primaryContrast }}>
              {isDisabled ? "Select a Rating" : "Submit Rating"}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity onPress={onClose} className="mt-3">
            <Text className="text-center" style={{ color: theme.textSoft }}>
              Cancel
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
};

export default BookRatingModal;
