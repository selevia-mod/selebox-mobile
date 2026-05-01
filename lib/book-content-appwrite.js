const looksLikeHtml = (value = "") => /<\/?[a-z][\s\S]*>/i.test(value);
const escapeHtml = (value = "") => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const splitBookContentIntoParagraphs = (value = "") => String(value).replace(/\r\n?/g, "\n").split("\n");

export const normalizeBookContentToHtml = (value = "") => {
  if (!value) return "";
  if (looksLikeHtml(value)) return value;

  const paragraphs = splitBookContentIntoParagraphs(escapeHtml(value));
  if (paragraphs.length === 0) return "";

  return paragraphs
    .map((paragraph) => {
      const trimmedParagraph = paragraph.trim();
      return trimmedParagraph ? `<p>${trimmedParagraph}</p>` : "<p><br/></p>";
    })
    .join("");
};
