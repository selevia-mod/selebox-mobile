// User-documents service — Supabase implementation.
//
// Replaces the Appwrite-flavored payment-info module that hit
// `usersPaymentInformationId` collection + Appwrite Storage. Mobile's
// PaymentInformation screen consumes a stable shape with these legacy
// keys (name / phone / email / address / payment_method /
// date_of_birth / valid_id / qr_code / signature). We adapt the
// Supabase column names — author_kyc uses full_name /
// id_document_url / payment_qr_url / signature_url — into that shape
// on read, and back the other way on write.
//
// Storage: web's KYC pipeline uses the `kyc-uploads` private bucket
// with the path pattern `{user_id}/{kind}-{timestamp}-{random}.{ext}`
// where kind ∈ {id, qr, sig}. We mirror that pattern so admin review
// surfaces (which already join on these paths) keep working unchanged.

import supabase from "./supabase";

const BUCKET = "kyc-uploads";

// Generate a path under the bucket. Matches the web's convention.
const buildPath = (userId, kind, fileExt = "webp") => {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 10);
  return `${userId}/${kind}-${ts}-${rand}.${fileExt}`;
};

// Map an attachment field key (mobile-side) to the storage `kind` segment.
const KIND_FOR_FIELD = {
  valid_id: "id",
  qr_code: "qr",
  signature: "sig",
};

// Returns a public-style URL for a file stored in the bucket. Even
// though the bucket is private, Supabase issues a stable storage URL
// the admin tools can sign on demand. Mobile only needs to display
// what was previously uploaded, and admin Review will sign URLs
// before serving — so we just hand back the storage path here and
// let consumers sign-on-render.
//
// For the mobile read path, we resolve the path into a signed URL
// (1 hour) so the form can preview the saved attachment.
const signFor1h = async (path) => {
  if (!path) return null;
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 60 * 60);
  if (error) {
    console.log("[user-documents] signed url error:", error.message);
    return null;
  }
  return data?.signedUrl || null;
};

const UserDocumentsService = {
  /**
   * Upload a file to Supabase Storage. Accepts the React Native asset
   * shape (uri, type, fileSize, fileName).
   *
   * @param {object} file  — { uri, fileSize?, fileName?, mimeType? }
   * @param {string} userId
   * @param {string} field — one of: 'valid_id' | 'qr_code' | 'signature'
   * @returns {Promise<string>} the storage path (saved in the
   *                            corresponding *_url column)
   */
  async uploadFile(file, userId, field = "valid_id") {
    if (!file?.uri) throw new Error("uploadFile: missing file uri");
    if (!userId) throw new Error("uploadFile: missing userId");

    // Convert to webp first — same compression pass the legacy
    // Appwrite path used. Cheap and meaningfully smaller for QR + IDs.
    const { convertToWebP, cleanupTempFile } = require("./utils/image-utils");
    const webp = await convertToWebP(file.uri);
    const path = buildPath(userId, KIND_FOR_FIELD[field] || "id", "webp");

    try {
      // Read the file as an ArrayBuffer so the Supabase client uploads
      // raw bytes (RN's fetch+blob path is the standard recipe).
      const response = await fetch(webp.uri);
      const blob = await response.blob();

      const { error } = await supabase.storage.from(BUCKET).upload(path, blob, {
        contentType: "image/webp",
        upsert: false,
      });
      if (error) throw error;
      return path;
    } catch (error) {
      console.error("[user-documents] upload error:", error.message || error);
      throw error;
    } finally {
      cleanupTempFile(webp.uri, file.uri);
    }
  },

  /**
   * Save / submit payment info. Goes through the submit_author_kyc RPC
   * which validates fields server-side and flips status to 'pending'.
   * The RPC also enforces the "submit once" rule — re-submission only
   * works after admin rejection (status = 'rejected').
   *
   * @param {string} userId — kept for API parity; the RPC reads auth.uid()
   * @param {object} data   — mobile form payload (legacy field names)
   */
  async savePaymentInfo(_userId, data) {
    const payload = {
      p_full_name: data.name || null,
      p_date_of_birth: data.dateOfBirth || null,
      // Mobile form doesn't currently capture id_type / id_number.
      // Server RPC accepts nulls for both — admin can backfill if
      // needed, or we add the inputs in a follow-up.
      p_id_type: null,
      p_id_number: null,
      p_id_document_url: data.valid_id || null,
      p_selfie_url: null,
      p_phone: data.phone || null,
      p_email: data.email || null,
      p_address: data.address || null,
      p_payment_method: data.paymentMethod || null,
      p_payment_qr_url: data.qr_code || null,
      p_signature_url: data.signature || null,
    };
    const { data: result, error } = await supabase.rpc("submit_author_kyc", payload);
    if (error) throw error;
    if (result?.ok === false) {
      const err = new Error(result?.error || "kyc_submit_failed");
      err.code = result?.error;
      throw err;
    }
    return result;
  },

  /**
   * Fetch the current user's payment info. Returns a legacy-shaped
   * object the form can drop into setForm() unchanged, with image
   * fields converted to signed URLs the form can preview.
   */
  async fetchPaymentInfo(_userId) {
    const { data: authData } = await supabase.auth.getUser();
    const me = authData?.user;
    if (!me) return null;

    const { data: row, error } = await supabase
      .from("author_kyc")
      .select(
        "user_id, full_name, date_of_birth, id_document_url, selfie_url, payment_qr_url, signature_url, payment_method, phone, email, address, status, rejection_reason, submitted_at",
      )
      .eq("user_id", me.id)
      .maybeSingle();

    if (error) {
      console.error("[user-documents] fetch error:", error.message);
      throw error;
    }
    if (!row) return null;

    // Sign attachment URLs in parallel so the form can render them.
    const [validIdSigned, qrSigned, sigSigned] = await Promise.all([
      signFor1h(row.id_document_url),
      signFor1h(row.payment_qr_url),
      signFor1h(row.signature_url),
    ]);

    // Adapt to the mobile form's legacy field names.
    return {
      name: row.full_name || "",
      phone: row.phone || "",
      email: row.email || "",
      address: row.address || "",
      payment_method: row.payment_method || null,
      date_of_birth: row.date_of_birth || null,
      valid_id: validIdSigned,
      qr_code: qrSigned,
      signature: sigSigned,
      status: row.status || null,
      rejection_reason: row.rejection_reason || null,
    };
  },
};

export default UserDocumentsService;
