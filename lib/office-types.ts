export type AgentVisual = {
  // Path relative to public/sprites/characters/
  // Premade characters are full 4-direction animated sheets — simplest path
  premade: string;
  // Optional overlay layer for custom accessory (path relative to public/sprites/)
  accessory?: string;
};

export type ThemeConfig = {
  floor: string;
  floorAlt: string;
  wall: string;
  deskTop: string;
  deskSide: string;
  accent: string;
  highlight: string;
  bg: string;
  // PixiJS ColorMatrixFilter params applied to world container.
  // Omit to leave untinted. Don't Call uses this for the 70s warm tone.
  paletteFilter?: {
    hue?: number;         // -180..180 degrees
    saturation?: number;  // 0..2
    brightness?: number;  // 0..2
    contrast?: number;    // 0..2
    tint?: string;        // hex color to blend toward
    tintStrength?: number; // 0..1
  };
  // Interior tileset reference for floor/walls
  interior?: {
    tilesheet: string;              // path relative to public/sprites/interiors/
    tileSize: 16 | 32 | 48;
    floorTileIndex: [number, number]; // [col, row] on tilesheet
    wallTileIndex?: [number, number];
  };
  // Visible desk furniture: colored chair behind agent + monitor in front.
  deskStyle?: {
    /** Tilesheet path relative to /public/sprites/interiors/ */
    tilesheet: string;
    /** Chair tile [col, row] — top-left of a 2x2 tile block */
    chair: number[];
    /** Monitor tile [col, row] — top-left of a 2x1 tile block */
    monitor: number[];
    /** "tile" = use tilesheet chair, "towel" = draw a pixel-art beach towel */
    chairType?: "tile" | "towel";
    /** Towel stripe color (hex string like "#f59e0b") — used when chairType is "towel" */
    towelColor?: string;
  };
  // Premade room: render pre-composed layer PNGs instead of per-tile floor.
  // Takes precedence over `interior` when both are set.
  premadeRoom?: {
    /** Paths relative to public/sprites/interiors/premade_rooms/, in z-order (layer1 = floor, layer2 = furniture, etc.) */
    layers: string[];
    /** Source PNG width in pixels (e.g. 304 for Japanese lounge) */
    pixelWidth: number;
    /** Source PNG height in pixels (e.g. 214 for Japanese lounge) */
    pixelHeight: number;
    /** Tile size the room was authored at (always 16 for LimeZu Modern Interiors) */
    sourceTileSize: number;
    /**
     * Layer split index: layers BEFORE this index render below characters;
     * layers AT or AFTER render above characters (use for hanging lights, front rails, etc.).
     * If omitted, all layers render below characters.
     */
    characterDepthIndex?: number;
  };
};

export type RoomConfig = {
  id: string;
  name: string;
  gridX: number;
  gridY: number;
  w: number;
  h: number;
  warRoom?: { gridX: number; gridY: number };  // cell to render the meeting-table click target
};
export type DeskConfig = { id: string; roomId: string; gridX: number; gridY: number; facing: "N" | "E" | "S" | "W" };
export type AgentConfig = {
  id: string;
  deskId: string;
  name: string;
  role: string;
  spritePack: string;   // kept for back-compat
  visual: AgentVisual;  // NEW — LimeZu premade character visual identity
  isReal: boolean;
  cwd?: string;
  allowedTools?: string[];
  model?: string;        // Claude model id, e.g. "claude-opus-4-6"; omit for SDK default (Sonnet)
  isHead?: boolean;      // Director — brand head, gets create_agent tool + Build Department UI. One per office.
  isDeptHead?: boolean;  // Department Head — leads a function (Finance, Marketing, Engineering, etc.). Typically Opus.
};

/**
 * Visual indicator shown above an agent's sprite.
 * - awaiting_input: agent called request_input and is blocked on a human reply
 * - done_unacked:   latest run finished and the user hasn't opened the inspector yet
 */
export type IndicatorKind = "awaiting_input" | "done_unacked" | "error";

export type OfficeConfig = {
  slug: string;
  name: string;
  theme: ThemeConfig;
  tile: { w: number; h: number };
  grid: { cols: number; rows: number };
  rooms: RoomConfig[];
  desks: DeskConfig[];
  agents: AgentConfig[];
};

export type StationBackground = {
  kind: "starfield";
  seed: number;
  density: number;
};

export type StationModule = {
  office: string;
  offsetX: number;
  offsetY: number;
  accent: string;
};

export type StationConfig = {
  slug: string;
  name: string;
  modules: StationModule[];
  background: StationBackground;
};
