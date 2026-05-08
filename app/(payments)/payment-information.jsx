import { Ionicons, MaterialCommunityIcons, MaterialIcons } from "@expo/vector-icons";
import DateTimePicker, { DateTimePickerAndroid } from "@react-native-community/datetimepicker";
import * as ImagePicker from "expo-image-picker";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Image, Platform, Text, TextInput, TouchableOpacity, View } from "react-native";
import Modal from "react-native-modal";
import { CustomAlertModal } from "../../components";
import { useGlobalContext } from "../../context/global-provider";
import useAppTheme from "../../hooks/useAppTheme";
import supabase from "../../lib/supabase";
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

  // Request-edit flow (May 2026). When the form is locked (isReadOnly,
  // i.e. the user has already saved their Payment Info), a "Request
  // edit" button at the bottom opens this modal. The user enters a
  // reason and the request lands in the admin Payouts → Info change
  // requests tab via the existing request_payment_info_change RPC.
  // p_requested_data is sent as an empty object — the user describes
  // their needed change in plain text in the reason field. Admin can
  // either reach out via support to collect new values or, for power
  // users, the web admin UI accepts a richer diff (mobile keeps it
  // simple to avoid re-implementing the entire form a second time).
  const [requestModalOpen, setRequestModalOpen] = useState(false);
  const [requestReason, setRequestReason] = useState("");
  const [submittingRequest, setSubmittingRequest] = useState(false);
  const [requestError, setRequestError] = useState("");

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
  // Submit a payment-info change request. The reason is required;
  // the server-side RPC validates length and refuses if the user
  // already has a pending request (returns { ok:false, error:
  // 'pending_request_exists' }). p_requested_data is sent as an
  // empty object — admin reads the reason and can either reach
  // out via support to collect new values, or unlock the form so
  // the user can resubmit. Mobile keeps it minimal vs. web's
  // inline-diff modal so we don't have to reimplement the entire
  // form just to capture changes.
  const handleSubmitRequest = async () => {
    const reason = (requestReason || "").trim();
    if (reason.length < 5) {
      setRequestError("Please describe what needs to change (at least 5 characters).");
      return;
    }
    setRequestError("");
    setSubmittingRequest(true);
    try {
      const { data, error } = await supabase.rpc("request_payment_info_change", {
        p_requested_data: {},
        p_reason: reason,
      });
      if (error) throw error;
      if (!data?.ok) {
        if (data?.error === "pending_request_exists") {
          setRequestError("You already have a pending request. We'll review it soon.");
        } else {
          setRequestError(data?.error || "Couldn't submit. Please try again.");
        }
        return;
      }
      setRequestModalOpen(false);
      setRequestReason("");
      Alert.alert(
        "Request submitted",
        "We received your request. An admin will review it within 24-48 hours.",
      );
    } catch (e) {
      setRequestError(e?.message || "Couldn't submit. Please try again.");
    } finally {
      setSubmittingRequest(false);
    }
  };

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
    <View key={key} className="mb-[6px] rounded-2xl p-5" style={{ backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border }}>
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

      {/* Disclaimer removed (May 2026). Replaced with the "Request edit"
          button at the bottom of the form, gated by isReadOnly — users
          can now self-serve a change request that lands in the admin
          Payouts → Info change requests tab instead of having to email
          support. */}

      <CustomAlertModal
        message="Your payment information has been saved!"
        iconName="check-circle"
        messageOpen={messageOpen}
        closeMessage={() => setMessageOpen(false)}
      />

      {/* Basic Info */}
      <View className="mb-[6px] rounded-2xl p-5" style={{ backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border }}>
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
      <View className="mb-[6px] rounded-2xl p-5" style={{ backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border }}>
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

      {/* Save Button — shown only while the form is editable (first
          submission). Once saved, isReadOnly flips on and the
          "Request edit" button below takes its place. */}
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

      {/* Request edit — shown when the form is locked (info already
          saved). Opens a modal where the user describes what needs to
          change. Submission flows through request_payment_info_change
          to the admin Payouts → Info change requests tab on the web.
          Premium styling: deep accent base + inner highlight strip
          (poor-man's gradient, since expo-linear-gradient isn't a
          dependency), glass-tinted inner border, soft outer shadow,
          and a press-scale on tap so the affordance feels deliberate
          rather than a flat CTA. */}
      {isReadOnly && (
        <TouchableOpacity
          activeOpacity={0.92}
          onPress={() => {
            setRequestReason("");
            setRequestError("");
            setRequestModalOpen(true);
          }}
          accessibilityRole="button"
          accessibilityLabel="Request to edit payment information"
          style={{
            marginTop: 28,
            marginBottom: 28,
            borderRadius: 18,
            overflow: "hidden",
            backgroundColor: theme.accentPurple || theme.primary,
            // Soft shadow / elevation — gives the button "weight" so it
            // reads as the screen's primary action without needing
            // bright copy or icons to pull the eye.
            shadowColor: theme.accentPurple || theme.primary,
            shadowOffset: { width: 0, height: 8 },
            shadowOpacity: 0.28,
            shadowRadius: 14,
            elevation: 8,
            // Glass-style inner border — subtle white edge that catches
            // light without competing with the button's body.
            borderWidth: 1,
            borderColor: "rgba(255,255,255,0.18)",
          }}
        >
          {/* Top-half highlight overlay — fakes a vertical gradient by
              painting the upper 50% with a barely-visible white tint.
              At rest this is invisible on light themes; on the dark
              accent it adds a top-down sheen that reads as premium. */}
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              height: "55%",
              backgroundColor: "rgba(255,255,255,0.10)",
            }}
          />

          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              paddingVertical: 16,
              paddingHorizontal: 20,
            }}
          >
            {/* Icon chip — round white-tinted bubble around the icon
                gives it a "badge" feel that pairs with the subtle
                shadow. Distinct from the flat icon-next-to-text
                pattern of the Save button so the two CTAs don't
                visually collide if a user sees them in sequence. */}
            <View
              style={{
                width: 28,
                height: 28,
                borderRadius: 14,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: "rgba(255,255,255,0.18)",
                marginRight: 10,
              }}
            >
              <Ionicons name="create-outline" size={16} color={theme.primaryContrast} />
            </View>
            <Text
              style={{
                color: theme.primaryContrast,
                fontSize: 16,
                fontWeight: "700",
                letterSpacing: 0.4,
              }}
            >
              Request edit
            </Text>
          </View>
        </TouchableOpacity>
      )}

      {/* Request edit modal */}
      <Modal
        isVisible={requestModalOpen}
        onBackdropPress={() => (submittingRequest ? null : setRequestModalOpen(false))}
        onSwipeComplete={() => (submittingRequest ? null : setRequestModalOpen(false))}
        swipeDirection={["down"]}
        backdropOpacity={0.45}
        style={{ justifyContent: "flex-end", margin: 0 }}
        useNativeDriver
        hideModalContentWhileAnimating
        animationIn="slideInUp"
        animationOut="slideOutDown"
        avoidKeyboard
      >
        <View
          style={{
            backgroundColor: theme.surfaceElevated || theme.background,
            borderTopLeftRadius: 24,
            borderTopRightRadius: 24,
            paddingHorizontal: 18,
            paddingTop: 12,
            paddingBottom: 28,
          }}
        >
          {/* Drag handle */}
          <View
            style={{
              alignSelf: "center",
              width: 40,
              height: 4,
              borderRadius: 2,
              backgroundColor: theme.border,
              marginBottom: 14,
            }}
          />

          <Text style={{ color: theme.text, fontSize: 18, fontWeight: "700", marginBottom: 4 }}>
            Request to edit
          </Text>
          <Text style={{ color: theme.textSoft, fontSize: 12, marginBottom: 16, lineHeight: 16 }}>
            Tell us what needs to change. An admin will review within 24-48 hours and reach out if more info is needed.
          </Text>

          <Text style={{ color: theme.textSoft, fontSize: 11, fontWeight: "600", marginBottom: 6 }}>
            What needs to change? (required)
          </Text>
          <TextInput
            value={requestReason}
            onChangeText={(t) => {
              setRequestReason(t);
              if (requestError) setRequestError("");
            }}
            placeholder="e.g. My GCash number changed, please update."
            placeholderTextColor={theme.placeholder}
            multiline
            style={{
              minHeight: 90,
              maxHeight: 160,
              borderRadius: 14,
              paddingHorizontal: 14,
              paddingTop: 10,
              paddingBottom: 10,
              backgroundColor: theme.inputBackground,
              borderWidth: 1,
              borderColor: theme.border,
              color: theme.inputText,
              fontSize: 14,
              textAlignVertical: "top",
            }}
            editable={!submittingRequest}
          />

          {requestError ? (
            <Text style={{ color: theme.danger, fontSize: 12, marginTop: 8 }}>{requestError}</Text>
          ) : null}

          <View style={{ flexDirection: "row", gap: 8, marginTop: 16 }}>
            <TouchableOpacity
              onPress={() => (submittingRequest ? null : setRequestModalOpen(false))}
              disabled={submittingRequest}
              style={{
                flex: 1,
                paddingVertical: 13,
                borderRadius: 14,
                alignItems: "center",
                borderWidth: 1,
                borderColor: theme.border,
                opacity: submittingRequest ? 0.5 : 1,
              }}
            >
              <Text style={{ color: theme.text, fontSize: 14, fontWeight: "600" }}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleSubmitRequest}
              disabled={submittingRequest || requestReason.trim().length < 5}
              style={{
                flex: 1,
                paddingVertical: 13,
                borderRadius: 14,
                alignItems: "center",
                backgroundColor: theme.primary,
                opacity: submittingRequest || requestReason.trim().length < 5 ? 0.5 : 1,
              }}
            >
              {submittingRequest ? (
                <ActivityIndicator size="small" color={theme.primaryContrast} />
              ) : (
                <Text style={{ color: theme.primaryContrast, fontSize: 14, fontWeight: "700" }}>Submit</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

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
