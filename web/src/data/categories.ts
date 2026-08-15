export type SearchCategory = {
  label: string;
  query: string;
  color: string;
  assetPath: string;
};

export const categories = [
  {
    label: "Action",
    query: "action",
    color: "#F05B4A",
    assetPath: "/images/action-logo.png",
  },
  {
    label: "Interviews",
    query: "interview",
    color: "#3D66D5",
    assetPath: "/images/interviews-logo.png",
  },
  {
    label: "Music",
    query: "music",
    color: "#D94D8E",
    assetPath: "/images/music-logo.png",
  },
  {
    label: "Gaming",
    query: "gaming",
    color: "#6E44C7",
    assetPath: "/images/gaming-logo.png",
  },
  {
    label: "Comedy",
    query: "comedy",
    color: "#D88927",
    assetPath: "/images/comedy-logo.png",
  },
  {
    label: "Tech",
    query: "technology",
    color: "#178A7E",
    assetPath: "/images/tech-logo.png",
  },
] as const satisfies readonly SearchCategory[];

export const brandTokens = {
  primary: "#FA50B5",
  vivid: "#FF33B7",
  avatar: "#FF4FA7",
  soft: "#FF8FD7",
  deep: "#CC4C99",
  deepAlt: "#D6368B",
  tint: "#FFF0F8",
  tintSoft: "#FFF4FB",
  tagTint: "#FFE4F4",
  live: "#E91E63",
  canvas: "#F5F7FB",
  surface: "#FFFFFF",
  ink: "#121A28",
  inkSecondary: "#1A2332",
  muted: "#667085",
  border: "#D5DDE8",
  borderSubtle: "#E5EAF2",
  media: "#111111",
  mediaBlack: "#000000",
} as const;
