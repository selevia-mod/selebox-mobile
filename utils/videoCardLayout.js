import { PixelRatio } from "react-native";

const CARD_IMAGE_META_GAP = 8; // space-y-2 between thumbnail and meta row
const CARD_BOTTOM_MARGIN = 16; // mb-4 on the card container
const TEXT_STACK_GAP = 2; // space-y-0.5 between title and meta lines
const SECTION_TITLE_PADDING_Y = 12; // py-3 on section title row
const SECTION_TITLE_FONT_SIZE = 18; // text-lg

export const getSectionTitleHeight = () => {
  const fontScale = PixelRatio.getFontScale?.() ?? 1;
  const scaledFontSize = Math.round(SECTION_TITLE_FONT_SIZE * fontScale);
  const lineHeight = Math.round(scaledFontSize * 1.2);
  return lineHeight + SECTION_TITLE_PADDING_Y * 2;
};

export const getVideoCardLayout = ({ cardWidth, aspectRatio = 0.59, avatarSize = 40, fontSize = 14, titleLines = 2, metaLines = 2 } = {}) => {
  const fontScale = PixelRatio.getFontScale?.() ?? 1;
  const scaledFontSize = Math.round(fontSize * fontScale);
  const titleLineHeight = Math.round(scaledFontSize * 1.35);
  const metaFontSize = Math.max(12, Math.round(scaledFontSize * 0.9));
  const metaLineHeight = Math.round(metaFontSize * 1.35);
  const textBlockHeight = titleLineHeight * titleLines + metaLineHeight * metaLines + TEXT_STACK_GAP;
  const rowHeight = Math.max(avatarSize, textBlockHeight);
  const imageHeight = Math.round(cardWidth * aspectRatio);
  const cardHeight = imageHeight + CARD_IMAGE_META_GAP + rowHeight + CARD_BOTTOM_MARGIN;

  return {
    imageHeight,
    cardHeight,
    rowHeight,
    scaledFontSize,
    metaFontSize,
    titleLineHeight,
    metaLineHeight,
  };
};
