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

export async function UploadClipToBunnyStorage(path, file) {
  try {
    const fileResponse = await fetch(file.uri);
    const fileBlob = await fileResponse.blob();
    const response = await fetch(`https://sg.storage.bunnycdn.com/singapore-main-storage-zone-clips/${path}`, {
      method: "PUT",
      headers: {
        AccessKey: secrets.BUNNY_CLIPS_STORAGE_ACCESS_KEY,
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

export async function DeleteClipFromBunnyStorage(path) {
  try {
    const response = await fetch(`https://sg.storage.bunnycdn.com/singapore-main-storage-zone-clips/${path}`, {
      method: "DELETE",
      headers: {
        AccessKey: secrets.BUNNY_CLIPS_STORAGE_ACCESS_KEY,
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
