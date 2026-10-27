// The component library (design/redesign.pen, N·C Components). Page chrome lives in ../chrome.
export { Button, ButtonLink, IconButton, buttonClassName, iconButtonClassName } from "./button";
export type { ButtonLinkProps, ButtonProps, ButtonSize, ButtonVariant, IconButtonProps } from "./button";
export { Card, CardTitle, cardClassName } from "./card";
export type { CardPadding, CardProps, CardTitleProps } from "./card";
export { ChartCard, ChartTable, Legend } from "./chart-card";
export type { ChartCardProps, ChartTableColumn, ChartTableProps, ChartView, LegendItem, SeriesTone } from "./chart-card";
export { Chip, ChipLink, chipClassName } from "./chip";
export type { ChipLinkProps, ChipProps, ChipVariant } from "./chip";
export { absoluteUrl, copyText } from "./clipboard";
export {
  CONFIDENCE_EXPLAINER,
  CONFIDENCE_LABEL,
  ConfidenceChip,
  ConfidencePopoverBody,
  loweredByText,
} from "./confidence";
export type { ConfidenceChipProps, ConfidenceLevel, ConfidencePopoverBodyProps } from "./confidence";
export { cx } from "./cx";
export { DrawerShell, trapTarget } from "./drawer-shell";
export type { DrawerShellProps } from "./drawer-shell";
export { Checkbox, Input, Select } from "./fields";
export type { CheckboxProps, InputProps, SelectProps } from "./fields";
export { ICON_NAMES, Icon, isIconName, Spinner } from "./icons";
export type { IconName, IconProps } from "./icons";
export { InlineState } from "./inline-state";
export type { InlineStateProps, InlineStateTone } from "./inline-state";
export { KeyNumber } from "./key-number";
export type { KeyNumberProps, KeyNumberSide } from "./key-number";
export { Monogram, monogramInitials, monogramPalette } from "./monogram";
export type { MonogramPalette, MonogramProps, MonogramSize } from "./monogram";
export { Popover } from "./popover";
export type { PopoverProps, PopoverTriggerProps } from "./popover";
export { focusOnClose, nextAfter, panelTabMove } from "./popover-focus";
export type { PopoverCloseReason, PopoverFocusTarget } from "./popover-focus";
export { placePopover } from "./popover-position";
export type { AnchorRect, PanelSize, PopoverPlacement, PopoverPosition } from "./popover-position";
export { Segmented, segmentedKeyMove, segmentedPanelId, segmentedTabId } from "./segmented";
export type { SegmentedOption, SegmentedProps } from "./segmented";
export { Hatch, Skeleton } from "./skeleton";
export type { HatchProps } from "./skeleton";
export { TAG_PRESETS, Tag } from "./tag";
export type { TagPreset, TagProps, TagTone } from "./tag";
export { TOAST_MS, Toast, useToast } from "./toast";
export type { ToastProps } from "./toast";
export { TOPICS, TOPIC_KEYS, TopicTag, TopicTile, topicForPillar } from "./topic";
export type { Topic, TopicKey, TopicTagProps, TopicTileProps, TopicTileSize } from "./topic";

// Keyboard helpers: whether a key press lands in a text field (the map's mode keys skip those).
export { isTextField } from "./shortcut";
export type { ShortcutFocusTarget, ShortcutKeyEvent } from "./shortcut";
