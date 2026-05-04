import secrets from "../private/secrets";

export async function UploadToBunnyStorage(path, file) {
  try {
    const fileResponse = await fetch(file.uri);
    const fileBlob = await fileResponse.blob();
    const response = await fetch(`https://sg.storage.bunnycdn.com/singapore-main-storage-zone/${path}`, {
      method: "PUT",
      headers: {
        AccessKey: secrets.BUNNY_STORAGE_ACCESS_KEY,
        "Content-Type": "application/octet-stream",
      },
      body: fileBlob, // Ensure this is a valid ReadableStream or Buffer
    });
    if (response.ok) {
      return true;
    }
    return false;
  } catch (error) {
    console.error("Upload error:", error);
    return false;
  }
}

export async function DeleteFromBunnyStorage(path) {
  try {
    const response = await fetch(`https://sg.storage.bunnycdn.com/singapore-main-storage-zone/${path}`, {
      method: "DELETE",
      headers: {
        AccessKey: secrets.BUNNY_STORAGE_ACCESS_KEY,
      },
    });
    if (response.ok) {
      return true;
    }
    return false;
  } catch (error) {
    console.error("Upload error:", error);
    return false;
  }
}

// UploadClipToBunnyStorage / DeleteClipFromBunnyStorage removed —
// clips feature retired May 2026. The historical
// `singapore-main-storage-zone-clips` Bunny zone is left in place so
// existing clip files keep playing for users on old bundles; once a
// data migration script copies them to a permanent home (or once the
// retention window passes), the zone can be torn down on Bunny.

export async function UploadVideoToBunnyStorage(path, file) {
  try {
    console.log("file", file);
    const fileResponse = await fetch(file.uri);
    const fileBlob = await fileResponse.blob();
    const response = await fetch(`https://sg.storage.bunnycdn.com/selebox-videos-storage/${path}`, {
      method: "PUT",
      headers: {
        AccessKey: secrets.BUNNY_VIDEOS_STORAGE_ACCESS_KEY,
        "Content-Type": "application/octet-stream",
      },
      body: fileBlob, // Ensure this is a valid ReadableStream or Buffer
    });
    if (response.ok) {
      return true;
    }
    return false;
  } catch (error) {
    console.error("Upload error:", error);
    return false;
  }
}

export async function DeleteVideoFromBunnyStorage(path) {
  try {
    const response = await fetch(`https://sg.storage.bunnycdn.com/selebox-videos-storage/${path}`, {
      method: "DELETE",
      headers: {
        AccessKey: secrets.BUNNY_VIDEOS_STORAGE_ACCESS_KEY,
      },
    });
    if (response.ok) {
      return true;
    }
    return false;
  } catch (error) {
    console.error("Upload error:", error);
    return false;
  }
}
