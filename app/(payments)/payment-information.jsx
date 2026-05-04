import { Ionicons, MaterialCommunityIcons, MaterialIcons } from "@expo/vector-icons";
import DateTimePicker, { DateTimePickerAndroid } from "@react-native-community/datetimepicker";
import * as ImagePicker from "expo-image-picker";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Image, Platform, Text, TextInput, TouchableOpacity, View } from "react-native";
import Modal from "react-native-modal";
import { CustomAlertModal } from "../../components";
import { useGlobalContext } from "../../context/global-provider";
import useAppTheme from "../../hooks/useAppTheme";
import UserDocumentsService from "../../lib/user-documents";
import { formatDate, parseDateOnly } from "../../utils/formatDate";

const PAYMENT_OPTIONS = ["gcash", "maya", "bank", "gotyme"];
const ATTACHMENTS = [
  { key: "qr_code", label: "QR Code For Method of Payment", iconFamily: "MaterialCommunityIcons", iconName: "qrcode-scan", required: true },
  {
    key: "valid_id",
    label: "Valid ID (Government ID)",
    iconFamily: "MaterialCommunityIcons",
    iconName: "card-account-details-outline",
    required: true,
  },
  { key: "signature", label: "Signature", iconFamily: "MaterialCommunityIcons", iconName: "draw", required: true },
];

const AttachmentIcon = ({ family, name, color }) => {
  if (family === "MaterialCommunityIcons") return <MaterialCommunityIcons name={name} size={20} color={color} />;
  return <MaterialIcons name={name} size={20} color={color} />;
};

const PaymentInformation = () => {
  const { user } = useGlobalContext();
  const { theme, isDarkMode } = useAppTheme();

  const [form, setForm] = useState({
    name: "",
    phone: "",
    email: "",
    address: "",
    dateOfBirth: new Date(),
    paymentMethod: null,
    valid_id: null,
    qr_code: null,
    signature: null,
  });

  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [isReadOnly, setIsReadOnly] = useState(false);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [tempDate, setTempDate] = useState(new Date());
  const [pickerModalOpen, setPickerModalOpen] = useState(false);
  const [currentType, setCurrentType] = useState(null);
  const [messageOpen, setMessageOpen] = useState(false);

  // -------------------------
  // Field Validation
  // -------------------------
  const validateField = (key, value) => {
    switch (key) {
      case "name":
        return value.trim() ? "" : "Name is required.";
      case "phone":
        if (!value.trim()) return "Phone number is required.";
        if (!/^\d{10,15}$/.test(value)) return "Invalid phone number.";
        return "";
      case "email":
        if (!value.trim()) return "Email is required.";
        if (!/\S+@\S+\.\S+/.test(value)) return "Invalid email format.";
        return "";
      case "address":
        return value.trim() ? "" : "Address is required.";
      default:
        return "";
    }
  };

  const validateForm = () => {
    const newErrors = {};
    Object.keys(form).forEach((key) => {
      if (["name", "phone", "email", "address"].includes(key)) {
        const error = validateField(key, form[key]);
        if (error) newErrors[key] = error;
      }
    });
    if (!form.paymentMethod) newErrors.paymentMethod = "Select a payment method.";
    ATTACHMENTS.forEach((att) => {
      if (!form[att.key]) newErrors[att.key] = `${att.label} is required.`;
    });
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  // -------------------------
  // Form Updates
  // -------------------------
  const updateForm = (key, value) => {
    if (isReadOnly) return;
    setForm((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => ({ ...prev, [key]: validateField(key, value) }));
  };

  const openAndroidDobPicker = () => {
    DateTimePickerAndroid.open({
      value: form.dateOfBirth,
      mode: "date",
      maximumDate: new Date(),
      onChange: (event, selectedDate) => {
        if (event.type === "set" && selectedDate) {
          updateForm("dateOfBirth", selectedDate);
        }
      },
    });
  };

  const handleOpenDobPicker = () => {
    if (isReadOnly) return;
    if (Platform.OS === "android") {
      openAndroidDobPicker();
    } else {
      setTempDate(form.dateOfBirth);
      setShowDatePicker(true);
    }
  };

  // -------------------------
  // Load User Data
  // -------------------------
  useEffect(() => {
    const loadUserDocs = async () => {
      try {
        setLoading(true);
        const docs = await UserDocumentsService.fetchPaymentInfo(user.$id);
        if (docs) {
          setForm({
            name: docs.name || "",
            phone: docs.phone || "",
            email: docs.email || "",
            address: docs.address || "",
            paymentMethod: docs.payment_method || null,
            dateOfBirth: parseDateOnly(docs.date_of_birth) || new Date(),
            valid_id: docs.valid_id ? { uri: docs.valid_id } : null,
            qr_code: docs.qr_code ? { uri: docs.qr_code } : null,
            signature: docs.signature ? { uri: docs.signature } : null,
          });
          setIsReadOnly(true);
        }
      } catch (err) {
        Alert.alert("Error", err.message || "Failed to load payment info");
      } finally {
        setLoading(false);
      }
    };
    loadUserDocs();
  }, []);

  // -------------------------
  // Image Picker
  // -------------------------
  const handlePickImage = (type) => {
    if (!isReadOnly) {
      setCurrentType(type);
      setPickerModalOpen(true);
    }
  };

  const pickFromCamera = async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Permission Denied", "Please allow access to the camera.");
      return;
    }

    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: "Images",
      quality: 1,
    });

    if (!result.canceled && currentType) {
      updateForm(currentType, result.assets[0]);
    }

    setPickerModalOpen(false);
  };

  const pickFromGallery = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Permission Denied", "Please allow access to the photo library.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: "Images", quality: 1 });
    if (!result.canceled && currentType) updateForm(currentType, result.assets[0]);
    setPickerModalOpen(false);
  };

  // -------------------------
  // Submit Form
  // -------------------------
  const handleSubmit = async () => {
    if (isReadOnly) return;
    if (!validateForm()) return;

    try {
      setSaving(true);

      // Each attachment goes to its own storage `kind` so admin
      // review tools can group by type. Pre-existing http(s)/signed
      // URLs (already-uploaded files re-shown to the user) skip the
      // upload entirely.
      const uploadIfNeeded = async (file, field) => {
        if (!file?.uri) return null;
        if (file.uri.startsWith("http")) return file.uri;
        return await UserDocumentsService.uploadFile(file, user.$id, field);
      };

      const payload = {
        ...form,
        dateOfBirth: formatDate(form.dateOfBirth),
        valid_id: await uploadIfNeeded(form.valid_id, "valid_id"),
        qr_code: await uploadIfNeeded(form.qr_code, "qr_code"),
        signature: await uploadIfNeeded(form.signature, "signature"),
      };

      await UserDocumentsService.savePaymentInfo(user.$id, payload);
      setTimeout(() => setMessageOpen(true), 600);
      setIsReadOnly(true);
    } catch (err) {
      Alert.alert("Error", err.message || "Something went wrong");
    } finally {
      setSaving(false);
    }
  };

  // -------------------------
  // Render Helpers
  // -------------------------
  const renderInputField = ({ key, label, type = "default", multiline = false, placeholder, required = false }) => (
    <View key={key} className="mb-5">
      <View className="mb-2 flex-row items-center">
        <Text className="text-xs font-medium" style={{ color: theme.textSoft }}>
          {label}
        </Text>
        {required && <View className="ml-1.5 h-1.5 w-1.5 rounded-full" style={{ backgroundColor: theme.danger }} />}
      </View>
      <TextInput
        editable={!isReadOnly}
        value={form[key]}
        onChangeText={(text) => updateForm(key, text)}
        keyboardType={type}
        multiline={multiline}
        placeholder={placeholder || `Enter ${label}`}
        placeholderTextColor={theme.placeholder}
        textAlignVertical={multiline ? "top" : "center"}
        className={`rounded-xl px-4 py-3 ${isReadOnly ? "opacity-50" : ""}`}
        style={{ backgroundColor: theme.inputBackground, color: theme.inputText }}
      />
      {errors[key] && (
        <Text className="mt-1 text-xs" style={{ color: theme.danger }}>
          {errors[key]}
        </Text>
      )}
    </View>
  );

  const renderAttachment = ({ key, label, iconFamily, iconName, required }) => (
    <View key={key} className="mb-6 rounded-2xl p-5" style={{ backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border }}>
      <View className="mb-3 flex-row items-center">
        <View className="mr-2 h-8 w-8 items-center justify-center rounded-lg" style={{ backgroundColor: theme.primarySoft }}>
          <AttachmentIcon family={iconFamily} name={iconName} color={theme.primary} />
        </View>
        <View className="flex-1 flex-row items-center">
          <Text className="text-sm font-semibold" style={{ color: theme.textSoft }} numberOfLines={2}>
            {label}
          </Text>
          {required && <View className="ml-1.5 h-1.5 w-1.5 rounded-full" style={{ backgroundColor: theme.danger }} />}
        </View>
      </View>
      {errors[key] && (
        <Text className="mb-3 text-xs" style={{ color: theme.danger }}>
          {errors[key]}
        </Text>
      )}
      <TouchableOpacity
        disabled={isReadOnly}
        className="items-center justify-center rounded-xl border border-dashed p-6"
        style={{ borderColor: theme.borderStrong, backgroundColor: theme.surfaceMuted }}
        onPress={() => handlePickImage(key)}
      >
        {form[key] ? (
          <Image source={{ uri: form[key].uri }} className="h-40 w-full rounded-lg" resizeMode="cover" />
        ) : (
          <>
            <MaterialIcons name="cloud-upload" size={40} color={theme.textSoft} />
            <Text className="mt-2 text-sm" style={{ color: theme.textSoft }}>
              Tap to upload {key.replace("_", " ")}
            </Text>
          </>
        )}
      </TouchableOpacity>
    </View>
  );

  return (
    <View className="flex-1 py-5" style={{ backgroundColor: theme.background }}>
      {/* Loader Modal */}
      <Modal
        isVisible={loading || saving}
        backdropOpacity={0.4}
        animationIn="fadeIn"
        animationOut="fadeOut"
        style={{ justifyContent: "center", alignItems: "center" }}
      >
        <View className="rounded-2xl px-6 py-6" style={{ backgroundColor: theme.surfaceElevated, borderWidth: 1, borderColor: theme.border }}>
          <ActivityIndicator size="large" color={theme.primary} />
          <Text className="mt-3" style={{ color: theme.textMuted }}>
            {saving ? "Saving..." : "Loading..."}
          </Text>
        </View>
      </Modal>

      {/* Disclaimer */}
      <View className="mb-4 flex-row rounded-2xl p-4" style={{ backgroundColor: theme.accentAmberSoft }}>
        <Ionicons name="information-circle" size={20} color={theme.accentAmber} style={{ marginTop: 2 }} />
        <Text className="ml-2 flex-1 text-xs leading-5" style={{ color: theme.accentAmber }}>
          Once submitted, payment information cannot be changed. For any updates, please contact{" "}
          <Text className="font-bold" style={{ color: theme.text }}>
            support@selebox.com
          </Text>
          .
        </Text>
      </View>

      <CustomAlertModal
        message="Your payment information has been saved!"
        iconName="check-circle"
        messageOpen={messageOpen}
        closeMessage={() => setMessageOpen(false)}
      />

      {/* Basic Info */}
      <View className="mb-6 rounded-2xl p-5" style={{ backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border }}>
        <View className="mb-4 flex-row items-center">
          <View className="mr-2 h-1 w-3 rounded-full" style={{ backgroundColor: theme.primary }} />
          <Text className="text-sm font-semibold" style={{ color: theme.textSoft }}>
            Basic Information
          </Text>
        </View>
        {renderInputField({ key: "name", label: "Full Name", required: true })}
        {renderInputField({ key: "phone", label: "Phone Number", type: "phone-pad", required: true })}
        {renderInputField({ key: "email", label: "Email Address", type: "email-address", required: true })}

        {/* Date of Birth */}
        <View className="mb-5">
          <View className="mb-2 flex-row items-center">
            <Text className="text-xs font-medium" style={{ color: theme.textSoft }}>
              Date of Birth
            </Text>
            <View className="ml-1.5 h-1.5 w-1.5 rounded-full" style={{ backgroundColor: theme.danger }} />
          </View>
          <TouchableOpacity
            disabled={isReadOnly}
            className={`flex-row items-center justify-between rounded-xl px-4 py-3 ${isReadOnly ? "opacity-50" : ""}`}
            style={{ backgroundColor: theme.inputBackground }}
            onPress={handleOpenDobPicker}
          >
            <Text style={{ color: theme.inputText }}>
              {form.dateOfBirth.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}
            </Text>
            {!isReadOnly && <Ionicons name="calendar-outline" size={20} color={theme.iconMuted} />}
          </TouchableOpacity>
        </View>

        {/* Address */}
        {renderInputField({ key: "address", label: "Address", multiline: true, placeholder: "Enter full address", required: true })}
      </View>

      {/* Payment Method */}
      <View className="mb-6 rounded-2xl p-5" style={{ backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border }}>
        <View className="mb-4 flex-row items-center">
          <View className="mr-2 h-1 w-3 rounded-full" style={{ backgroundColor: theme.accentGreen }} />
          <Text className="text-sm font-semibold" style={{ color: theme.textSoft }}>
            Method of Payment
          </Text>
          <View className="ml-1.5 h-1.5 w-1.5 rounded-full" style={{ backgroundColor: theme.danger }} />
        </View>
        {errors.paymentMethod && (
          <Text className="-mt-3 mb-3 text-xs" style={{ color: theme.danger }}>
            {errors.paymentMethod}
          </Text>
        )}
        <View className="flex-row flex-wrap justify-between">
          {PAYMENT_OPTIONS.map((item) => {
            const isSelected = form.paymentMethod === item;
            return (
              <TouchableOpacity
                key={item}
                disabled={isReadOnly}
                onPress={() => updateForm("paymentMethod", item)}
                className="mb-3 w-[48%] rounded-full px-4 py-3"
                style={{ backgroundColor: isSelected ? theme.primary : theme.surfaceStrong }}
              >
                <Text className="text-center font-medium capitalize" style={{ color: isSelected ? theme.primaryContrast : theme.textMuted }}>
                  {item}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {/* Attachments */}
      {ATTACHMENTS.map(renderAttachment)}

      {/* Save Button */}
      {!isReadOnly && (
        <TouchableOpacity
          className="my-7 flex-row items-center justify-center rounded-xl py-3.5"
          style={{ backgroundColor: theme.primary }}
          onPress={handleSubmit}
        >
          <Ionicons name="checkmark-circle" size={20} color={theme.primaryContrast} />
          <Text className="ml-2 text-center text-lg font-bold" style={{ color: theme.primaryContrast }}>
            Save Information
          </Text>
        </TouchableOpacity>
      )}

      {/* Date of Birth Calendar Modal (iOS) */}
      {Platform.OS === "ios" && (
        <Modal
          isVisible={showDatePicker}
          onBackdropPress={() => setShowDatePicker(false)}
          onSwipeComplete={() => setShowDatePicker(false)}
          swipeDirection="down"
          style={{ justifyContent: "flex-end", margin: 0 }}
          backdropOpacity={0.4}
          propagateSwipe
        >
          <View className="rounded-t-2xl px-6 pb-8 pt-4" style={{ backgroundColor: theme.surfaceElevated }}>
            <View className="mb-2 items-center">
              <View className="h-1 w-10 rounded-full" style={{ backgroundColor: theme.handle }} />
            </View>
            <Text className="mb-2 text-center text-lg font-semibold" style={{ color: theme.text }}>
              Date of Birth
            </Text>
            <DateTimePicker
              value={tempDate}
              mode="date"
              display="inline"
              maximumDate={new Date()}
              themeVariant={isDarkMode ? "dark" : "light"}
              onChange={(e, date) => {
                if (e.type === "set" && date) {
                  setTempDate(date);
                }
              }}
            />
            <View className="mt-4 flex-row justify-between gap-3">
              <TouchableOpacity
                className="flex-1 rounded-lg py-3"
                style={{ backgroundColor: theme.surfaceStrong }}
                onPress={() => setShowDatePicker(false)}
              >
                <Text className="text-center font-semibold" style={{ color: theme.textMuted }}>
                  Cancel
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                className="flex-1 rounded-lg py-3"
                style={{ backgroundColor: theme.primary }}
                onPress={() => {
                  updateForm("dateOfBirth", tempDate);
                  setShowDatePicker(false);
                }}
              >
                <Text className="text-center font-bold" style={{ color: theme.primaryContrast }}>
                  Confirm
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>
      )}

      {/* Picker Modal */}
      <Modal
        isVisible={pickerModalOpen}
        onBackdropPress={() => setPickerModalOpen(false)}
        onBackButtonPress={() => setPickerModalOpen(false)}
        swipeDirection="down"
        onSwipeComplete={() => setPickerModalOpen(false)}
        style={{ justifyContent: "flex-end", margin: 0 }}
        backdropOpacity={0.4}
        propagateSwipe
      >
        <View className="rounded-t-2xl p-6" style={{ backgroundColor: theme.surfaceElevated }}>
          <View className="mb-4 items-center">
            <View className="h-1 w-10 rounded-full" style={{ backgroundColor: theme.handle }} />
          </View>
          <Text className="mb-4 text-center text-lg font-semibold" style={{ color: theme.text }}>
            Choose an option
          </Text>
          <TouchableOpacity
            className="mb-3 flex-row items-center justify-center rounded-lg py-3"
            style={{ backgroundColor: theme.primary }}
            onPress={pickFromCamera}
          >
            <Ionicons name="camera" size={18} color={theme.primaryContrast} />
            <Text className="ml-2 font-bold" style={{ color: theme.primaryContrast }}>
              Take a Photo
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            className="mb-3 flex-row items-center justify-center rounded-lg py-3"
            style={{ backgroundColor: theme.primary }}
            onPress={pickFromGallery}
          >
            <Ionicons name="images" size={18} color={theme.primaryContrast} />
            <Text className="ml-2 font-bold" style={{ color: theme.primaryContrast }}>
              Choose from Gallery
            </Text>
          </TouchableOpacity>
          <TouchableOpacity className="rounded-lg py-3" style={{ backgroundColor: theme.surfaceStrong }} onPress={() => setPickerModalOpen(false)}>
            <Text className="text-center font-semibold" style={{ color: theme.textMuted }}>
              Cancel
            </Text>
          </TouchableOpacity>
        </View>
      </Modal>
    </View>
  );
};

export default PaymentInformation;
