"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useRef,
  type Dispatch,
} from "react";

export type TabBadge = "!" | "✓" | null;

export type DockTab = {
  id: string; // unique tab id — agentId for 1:1, "war-room:{slug}" for war-room
  agentId: string | null; // null for war-room tabs
  deskId: string | null; // null for war-room tabs
  officeSlug: string;
  kind: "1:1" | "war-room";
  pinned: boolean;
  label: string;
  badge: TabBadge;
  /** war-room only — set after convene */
  meetingId?: string | null;
};

type State = {
  tabs: DockTab[];
  focusedId: string | null;
};

type Action =
  | { type: "OPEN_OR_FOCUS"; tab: Omit<DockTab, "badge" | "pinned"> }
  | { type: "OPEN_WAR_ROOM"; officeSlug: string; label: string; meetingId?: string }
  | { type: "CLOSE"; id: string }
  | { type: "FOCUS"; id: string }
  | { type: "PIN"; id: string }
  | { type: "SET_BADGE"; id: string; badge: TabBadge }
  | { type: "SET_MEETING_ID"; id: string; meetingId: string }
  | { type: "REORDER"; fromId: string; toId: string }
  | { type: "MOVE_TO_END"; id: string }
  | { type: "LOAD_PERSISTED"; state: State };

const STORAGE_KEY = "ri-dock-tabs";

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "OPEN_OR_FOCUS": {
      const exists = state.tabs.find((t) => t.id === action.tab.id);
      if (exists) {
        // Update mutable props (officeSlug, deskId, label) — they may have
        // changed since the tab was persisted (e.g. agent moved offices).
        const needsUpdate =
          exists.officeSlug !== action.tab.officeSlug ||
          exists.deskId !== action.tab.deskId ||
          exists.label !== action.tab.label;
        if (needsUpdate) {
          return {
            tabs: state.tabs.map((t) =>
              t.id === exists.id
                ? { ...t, officeSlug: action.tab.officeSlug, deskId: action.tab.deskId ?? t.deskId, label: action.tab.label }
                : t,
            ),
            focusedId: exists.id,
          };
        }
        return { ...state, focusedId: exists.id };
      }
      const newTab: DockTab = {
        ...action.tab,
        badge: null,
        pinned: false,
      };
      return { tabs: [...state.tabs, newTab], focusedId: newTab.id };
    }
    case "OPEN_WAR_ROOM": {
      // If a meetingId is provided, key by meeting so each war room gets its own tab
      const id = action.meetingId
        ? `war-room:${action.meetingId}`
        : `war-room:${action.officeSlug}`;
      const exists = state.tabs.find((t) => t.id === id);
      if (exists) {
        return { ...state, focusedId: id };
      }
      // Also check if there's already a tab for this meeting under the old slug-based key
      if (action.meetingId) {
        const byMeeting = state.tabs.find(
          (t) => t.kind === "war-room" && t.meetingId === action.meetingId,
        );
        if (byMeeting) {
          return { ...state, focusedId: byMeeting.id };
        }
      }
      const newTab: DockTab = {
        id,
        agentId: null,
        deskId: null,
        officeSlug: action.officeSlug,
        kind: "war-room",
        pinned: false,
        label: action.label,
        badge: null,
        meetingId: action.meetingId ?? null,
      };
      return { tabs: [...state.tabs, newTab], focusedId: id };
    }
    case "CLOSE": {
      const remaining = state.tabs.filter((t) => t.id !== action.id);
      let focusedId = state.focusedId;
      if (focusedId === action.id) {
        const idx = state.tabs.findIndex((t) => t.id === action.id);
        focusedId =
          remaining[Math.max(0, idx - 1)]?.id ?? remaining[0]?.id ?? null;
      }
      return { tabs: remaining, focusedId };
    }
    case "FOCUS":
      return { ...state, focusedId: action.id };
    case "PIN": {
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.id === action.id ? { ...t, pinned: !t.pinned } : t,
        ),
      };
    }
    case "SET_BADGE": {
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.id === action.id ? { ...t, badge: action.badge } : t,
        ),
      };
    }
    case "SET_MEETING_ID": {
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.id === action.id ? { ...t, meetingId: action.meetingId } : t,
        ),
      };
    }
    case "REORDER": {
      const from = state.tabs.findIndex((t) => t.id === action.fromId);
      const to = state.tabs.findIndex((t) => t.id === action.toId);
      if (from === -1 || to === -1 || from === to) return state;
      const tabs = [...state.tabs];
      const [moved] = tabs.splice(from, 1);
      tabs.splice(to, 0, moved);
      return { ...state, tabs };
    }
    case "MOVE_TO_END": {
      const from = state.tabs.findIndex((t) => t.id === action.id);
      if (from === -1) return state;
      const tabs = [...state.tabs];
      const [moved] = tabs.splice(from, 1);
      tabs.push(moved);
      return { ...state, tabs };
    }
    case "LOAD_PERSISTED": {
      // Deduplicate by id (localStorage can accumulate stale dupes)
      const seen = new Set<string>();
      const tabs = action.state.tabs.filter((t) => {
        if (seen.has(t.id)) return false;
        seen.add(t.id);
        return true;
      });
      return { ...action.state, tabs };
    }
    default:
      return state;
  }
}

const initialState: State = { tabs: [], focusedId: null };

export type DockTabsContextValue = {
  tabs: DockTab[];
  focusedId: string | null;
  focusedTab: DockTab | null;
  dispatch: Dispatch<Action>;
  openOrFocus: (tab: Omit<DockTab, "badge" | "pinned">) => void;
  openWarRoom: (officeSlug: string, label: string, meetingId?: string) => void;
  close: (id: string) => void;
  focus: (id: string) => void;
  reorder: (fromId: string, toId: string) => void;
  moveToEnd: (id: string) => void;
};

export const DockTabsContext = createContext<DockTabsContextValue | null>(null);

export function useDockTabsState(): [State, Dispatch<Action>] {
  const [state, dispatch] = useReducer(reducer, initialState);
  const hydrated = useRef(false);
  const pendingHydrate = useRef(false);

  // Hydrate from localStorage once
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as State;
        parsed.tabs = parsed.tabs.map((t) => ({ ...t, badge: null }));
        pendingHydrate.current = true;
        dispatch({ type: "LOAD_PERSISTED", state: parsed });
      } else {
        hydrated.current = true;
      }
    } catch {
      hydrated.current = true;
    }
  }, []);

  // Persist on change — skip until LOAD_PERSISTED has been processed
  useEffect(() => {
    if (pendingHydrate.current) {
      // This render is the result of LOAD_PERSISTED — data already in localStorage
      pendingHydrate.current = false;
      hydrated.current = true;
      return;
    }
    if (!hydrated.current) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // ignore
    }
  }, [state]);

  return [state, dispatch];
}

export function useDockTabs(): DockTabsContextValue {
  const ctx = useContext(DockTabsContext);
  if (!ctx) throw new Error("useDockTabs must be used inside DockTabsProvider");
  return ctx;
}

/** Build context value from state+dispatch — call this in the provider component */
export function buildDockTabsValue(
  state: State,
  dispatch: Dispatch<Action>,
): DockTabsContextValue {
  const openOrFocus = (tab: Omit<DockTab, "badge" | "pinned">) =>
    dispatch({ type: "OPEN_OR_FOCUS", tab });
  const openWarRoom = (officeSlug: string, label: string, meetingId?: string) =>
    dispatch({ type: "OPEN_WAR_ROOM", officeSlug, label, meetingId });
  const close = (id: string) => dispatch({ type: "CLOSE", id });
  const focus = (id: string) => dispatch({ type: "FOCUS", id });
  const reorder = (fromId: string, toId: string) => dispatch({ type: "REORDER", fromId, toId });
  const moveToEnd = (id: string) => dispatch({ type: "MOVE_TO_END", id });
  const focusedTab = state.tabs.find((t) => t.id === state.focusedId) ?? null;
  return {
    tabs: state.tabs,
    focusedId: state.focusedId,
    focusedTab,
    dispatch,
    openOrFocus,
    openWarRoom,
    close,
    focus,
    reorder,
    moveToEnd,
  };
}
