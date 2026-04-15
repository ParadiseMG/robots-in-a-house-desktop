"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  type Dispatch,
} from "react";

export type TabBadge = "!" | "✓" | null;

export type DockTab = {
  id: string; // unique tab id — agentId for 1:1, "war-room:{slug}" for war-room
  agentId: string | null; // null for war-room tabs
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
  | { type: "OPEN_WAR_ROOM"; officeSlug: string; label: string }
  | { type: "CLOSE"; id: string }
  | { type: "FOCUS"; id: string }
  | { type: "PIN"; id: string }
  | { type: "SET_BADGE"; id: string; badge: TabBadge }
  | { type: "SET_MEETING_ID"; id: string; meetingId: string }
  | { type: "LOAD_PERSISTED"; state: State };

const STORAGE_KEY = "ri-dock-tabs";

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "OPEN_OR_FOCUS": {
      const exists = state.tabs.find((t) => t.id === action.tab.id);
      if (exists) {
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
      const id = `war-room:${action.officeSlug}`;
      const exists = state.tabs.find((t) => t.id === id);
      if (exists) {
        return { ...state, focusedId: id };
      }
      const newTab: DockTab = {
        id,
        agentId: null,
        officeSlug: action.officeSlug,
        kind: "war-room",
        pinned: false,
        label: action.label,
        badge: null,
        meetingId: null,
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
    case "LOAD_PERSISTED":
      return action.state;
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
  openWarRoom: (officeSlug: string, label: string) => void;
  close: (id: string) => void;
  focus: (id: string) => void;
};

export const DockTabsContext = createContext<DockTabsContextValue | null>(null);

export function useDockTabsState(): [State, Dispatch<Action>] {
  const [state, dispatch] = useReducer(reducer, initialState);

  // Hydrate from localStorage once
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as State;
      // Clear badges on restore (stale)
      parsed.tabs = parsed.tabs.map((t) => ({ ...t, badge: null }));
      dispatch({ type: "LOAD_PERSISTED", state: parsed });
    } catch {
      // ignore parse errors
    }
  }, []);

  // Persist on change (debounced by browser idle)
  useEffect(() => {
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
  const openWarRoom = (officeSlug: string, label: string) =>
    dispatch({ type: "OPEN_WAR_ROOM", officeSlug, label });
  const close = (id: string) => dispatch({ type: "CLOSE", id });
  const focus = (id: string) => dispatch({ type: "FOCUS", id });
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
  };
}
