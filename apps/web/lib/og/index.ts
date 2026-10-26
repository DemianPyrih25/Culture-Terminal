// The share card of a curated showcase (P1 #4, SPEC §8.6, D31): pure card data, its drawing and the
// permalink head's tags, safe anywhere. The fonts are read on the server (./fonts, server-only).
export {
  buildOgCard,
  hasOgCard,
  keySlotWidth,
  questionText,
  KEY_COMPARATOR_TYPE,
  KEY_LABEL_TYPE,
  OG_HONESTY,
  QUESTION_MAX,
  type OgCard,
  type OgCardInput,
  type OgKeyFigure,
  type OgPanel,
  type OgQuestion,
} from "./card";
export { OgCardImage } from "./card-image";
export { fitWidth, textWidth, type CardFace, type CardType } from "./measure";
export { ogCardMetadata, ogCardPath, showsOgCard, type OgBrief } from "./meta";
export { miniViz, MINI_ROWS, type MiniLegend, type MiniRow, type MiniTone, type MiniViz } from "./mini-viz";
export { CARD_CODE_POINTS, cardLabel, cardText, ellipsis, inCardCharset, truncate } from "./text";
export { labelTracking, OG_COLOR, OG_FONT, OG_FRAME, OG_SIZE } from "./tokens";
