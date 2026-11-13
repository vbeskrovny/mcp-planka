/** Label colors accepted by Planka v2 (server/api/models/Label.js). */
export const LABEL_COLORS = [
  "muddy-grey", "autumn-leafs", "morning-sky", "antique-blue", "egg-yellow", "desert-sand", "dark-granite",
  "fresh-salad", "lagoon-blue", "midnight-blue", "light-orange", "pumpkin-orange", "light-concrete", "sunny-grass",
  "navy-blue", "lilac-eyes", "apricot-red", "orange-peel", "silver-glint", "bright-moss", "deep-ocean", "summer-sky",
  "berry-red", "light-cocoa", "grey-stone", "tank-green", "coral-green", "sugar-plum", "pink-tulip", "shady-rust",
  "wet-rock", "wet-moss", "turquoise-sea", "lavender-fields", "piggy-red", "light-mud", "gun-metal", "modern-green",
  "french-coast", "sweet-lilac", "red-burgundy", "pirate-gold",
] as const;

/** Card types (server/api/models/Card.js). */
export const CARD_TYPES = ["project", "story"] as const;

/** List types usable on a kanban board (List.KANBAN_TYPES). "closed" lists mark their cards as closed. */
export const KANBAN_LIST_TYPES = ["active", "closed"] as const;
