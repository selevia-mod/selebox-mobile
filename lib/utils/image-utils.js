import * as FileSystem from "expo-file-system";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { Image } from "react-native";

const getImageSize = async (uri, fallbackWidth = 0, fallbackHeight = 0) =>
  new Promise((resolve) => {
    if (fallbackWidth > 0 && fallbackHeight > 0) {
      resolve({ width: fallbackWidth, height: fallbackHeight });
      return;
    }

    Image.getSize(
      uri,
      (width, height) => resolve({ width, height }),
      () => resolve({ width: fallbackWidth, height: fallbackHeight }),
    );
  });

export async function convertToWebP(uri, { compress = 0.7, maxWidth = 1200, sourceWidth = 0, sourceHeight = 0 } = {}) {
  try {
    const { width: originalWidth } = await getImageSize(uri, sourceWidth, sourceHeight);
    let context = ImageManipulator.manipulate(uri);

    if (maxWidth && originalWidth > maxWidth) {
      context = context.resize({ width: maxWidth });
    }

    const imageRef = await context.renderAsync();
    const result = await imageRef.saveAsync({ format: SaveFormat.WEBP, compress });
    const fileInfo = await FileSystem.getInfoAsync(result.uri, { size: true });
    return { uri: result.uri, width: result.width, height: result.height, fileSize: fileInfo.size };
  } catch (error) {
    console.warn("WebP conversion failed, using original:", error.message);
    const fileInfo = await FileSystem.getInfoAsync(uri, { size: true });
    return { uri, fileSize: fileInfo.size };
  }
}

export async function cleanupTempFile(tempUri, originalUri) {
  try {
    if (tempUri && tempUri !== originalUri) {
      await FileSystem.deleteAsync(tempUri, { idempotent: true });
    }
  } catch {}
}

const LOCAL_PICKED_IMAGE_DIR = `${FileSystem.documentDirectory || ""}picked-images/`;

const extractExtension = (value = "") => {
  const normalizedValue = String(value || "")
    .split("?")[0]
    .split("#")[0];
  const match = normalizedValue.match(/(\.[a-z0-9]+)$/i);
  return match?.[1]?.toLowerCase() || "";
};

const extensionFromMimeType = (mimeType = "") => {
  const normalizedMimeType = String(mimeType || "").toLowerCase();
  if (!normalizedMimeType.startsWith("image/")) return "";
  const subtype = normalizedMimeType.split("/")[1] || "";
  if (subtype === "jpeg") return ".jpg";
  if (subtype === "heif") return ".heif";
  if (subtype === "heic") return ".heic";
  if (subtype === "png") return ".png";
  if (subtype === "webp") return ".webp";
  return subtype ? `.${subtype}` : "";
};

const getFileExtension = (asset = {}) => {
  return extractExtension(asset?.uri) || extensionFromMimeType(asset?.mimeType) || extractExtension(asset?.fileName) || ".jpg";
};

const getSaveFormatForExtension = (extension = "") => {
  const normalizedExtension = String(extension || "").toLowerCase();
  if (normalizedExtension === ".png") return SaveFormat.PNG;
  if (normalizedExtension === ".webp") return SaveFormat.WEBP;
  return SaveFormat.JPEG;
};

export async function persistImagePickerAsset(asset, prefix = "image") {
  const sourceUri = asset?.uri || "";
  if (!sourceUri) return asset;
  if (!FileSystem.documentDirectory) return asset;
  if (sourceUri.startsWith(LOCAL_PICKED_IMAGE_DIR)) return asset;

  await FileSystem.makeDirectoryAsync(LOCAL_PICKED_IMAGE_DIR, { intermediates: true });
  const extension = getFileExtension(asset);
  const targetUri = `${LOCAL_PICKED_IMAGE_DIR}${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${extension}`;
  let tempNormalizedUri = "";

  try {
    if (sourceUri.startsWith("file://")) {
      await FileSystem.copyAsync({
        from: sourceUri,
        to: targetUri,
      });
    } else {
      const imageRef = await ImageManipulator.manipulate(sourceUri).renderAsync();
      const normalizedImage = await imageRef.saveAsync({
        format: getSaveFormatForExtension(extension),
        compress: 1,
      });
      tempNormalizedUri = normalizedImage?.uri || "";
      if (!tempNormalizedUri) return asset;
      await FileSystem.copyAsync({
        from: tempNormalizedUri,
        to: targetUri,
      });
    }
  } finally {
    await cleanupTempFile(tempNormalizedUri, sourceUri);
  }

  const copiedInfo = await FileSystem.getInfoAsync(targetUri, { size: true });
  const targetFileName = targetUri.split("/").pop();
  return {
    ...asset,
    uri: targetUri,
    fileName: targetFileName,
    fileSize: copiedInfo?.size || asset?.fileSize || 0,
  };
}
