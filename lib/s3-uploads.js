import * as FileSystem from "expo-file-system";
import secrets from "../private/secrets";

export async function UploadFilesToS3(file, fileId, type = "video", bucketName) {
  try {
    // Force file type and extension
    let contentType, extension;
    if (type === "video") {
      contentType = "video/mp4";
      extension = "mp4";
    } else if (type === "image") {
      contentType = "image/jpeg";
      extension = "jpg";
    } else {
      throw new Error("Unsupported type. Only 'video' or 'image' are allowed.");
    }

    // Step 2: Get pre-signed URL
    const presignedUrlRes = await fetch("https://npgbo6z7xa.execute-api.ap-southeast-1.amazonaws.com/prod/s3-upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileId: fileId,
        fileType: contentType,
        bucketName: bucketName || secrets.AWS_VIDEOS_BUCKET_NAME,
      }),
    });

    const { uploadUrl, fileUrl } = await presignedUrlRes.json();

    // Step 3: Upload to S3
    const uploadResult = await FileSystem.uploadAsync(uploadUrl, file.uri, {
      httpMethod: "PUT",
      uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
      headers: {
        "Content-Type": contentType,
      },
    });

    if (uploadResult.status === 200) {
      const s3Url = `https://${bucketName}.s3.ap-southeast-1.amazonaws.com/`;
      const tempCloudFrontUrl =
        bucketName === secrets.AWS_CLIPS_BUCKET_NAME ? secrets.AWS_CLIPS_CLOUDFRONT_DOMAIN : secrets.AWS_VIDEOS_CLOUDFRONT_DOMAIN;

      const cloudFrontUrl = fileUrl.replace(s3Url, tempCloudFrontUrl);
      console.log(cloudFrontUrl, fileId);
      return cloudFrontUrl;
    } else {
      console.error("❌ S3 upload failed:", uploadResult);
      return false;
    }
  } catch (err) {
    console.error("❌ Upload error:", err.message);
    return false;
  }
}
