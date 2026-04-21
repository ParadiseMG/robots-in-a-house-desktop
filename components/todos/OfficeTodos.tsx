"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Todo = {
  id: string;
  office_slug: string;
  text: string;
  done: number;
  sort_order: number;
  created_at: number;
  done_at: number | null;
};

type Props = {
  officeSlug: string;
  accent?: string;
};

export default function OfficeTodos({ officeSlug, accent = "#5aa0ff" }: Props) {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [newText, setNewText] = useState("");
  const [editId, setEditId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const editRef = useRef<HTMLInputElement>(null);

  const fetchTodos = useCallback(() => {
    fetch(`/api/todos?office=${encodeURIComponent(officeSlug)}`)
      .then((r) => r.json())
      .then((d: { todos: Todo[] }) => setTodos(d.todos))
      .catch(() => {});
  }, [officeSlug]);

  useEffect(() => {
    fetchTodos();
  }, [fetchTodos]);

  useEffect(() => {
    if (editId && editRef.current) editRef.current.focus();
  }, [editId]);

  const addTodo = async () => {
    const text = newText.trim();
    if (!text) return;
    setNewText("");
    const res = await fetch("/api/todos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ office: officeSlug, text }),
    });
    if (res.ok) {
      const { todo } = (await res.json()) as { todo: Todo };
      setTodos((prev) => [...prev, todo]);
    }
  };

  const toggleTodo = async (todo: Todo) => {
    const done = !todo.done;
    // Optimistic update
    setTodos((prev) =>
      prev.map((t) =>
        t.id === todo.id ? { ...t, done: done ? 1 : 0, done_at: done ? Date.now() : null } : t,
      ),
    );
    await fetch("/api/todos", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: todo.id, done }),
    });
    fetchTodos(); // re-sort from server
  };

  const removeTodo = async (id: string) => {
    setTodos((prev) => prev.filter((t) => t.id !== id));
    await fetch(`/api/todos?id=${encodeURIComponent(id)}`, { method: "DELETE" });
  };

  const saveEdit = async (id: string) => {
    const text = editText.trim();
    if (!text) return;
    setEditId(null);
    setTodos((prev) => prev.map((t) => (t.id === id ? { ...t, text } : t)));
    await fetch("/api/todos", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, text }),
    });
  };

  const incomplete = todos.filter((t) => !t.done);
  const complete = todos.filter((t) => t.done);
  const count = incomplete.length;

  return (
    <div className="w-full select-none rounded-lg border border-white/10 bg-black/70 backdrop-blur-sm">
      {/* Header */}
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-left"
      >
        <span className="font-mono text-[10px] uppercase tracking-wider text-white/50">
          to-do
        </span>
        <span className="flex items-center gap-1.5">
          {count > 0 && (
            <span
              className="inline-flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 font-mono text-[10px] font-bold text-black"
              style={{ backgroundColor: accent }}
            >
              {count}
            </span>
          )}
          <span className="text-[10px] text-white/30">{collapsed ? "+" : "-"}</span>
        </span>
      </button>

      {!collapsed && (
        <div className="border-t border-white/5 px-2 pb-2">
          {/* Add input */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void addTodo();
            }}
            className="flex items-center gap-1 py-1.5"
          >
            <input
              ref={inputRef}
              type="text"
              value={newText}
              onChange={(e) => setNewText(e.target.value)}
              placeholder="add item..."
              className="min-w-0 flex-1 bg-transparent px-1 py-0.5 font-mono text-xs text-white/80 placeholder:text-white/20 focus:outline-none"
            />
            {newText.trim() && (
              <button
                type="submit"
                className="rounded px-1.5 py-0.5 font-mono text-[10px] text-white/40 transition hover:bg-white/10 hover:text-white/80"
              >
                add
              </button>
            )}
          </form>

          {/* Incomplete items */}
          {incomplete.length === 0 && complete.length === 0 && (
            <div className="px-1 py-2 text-center font-mono text-[10px] text-white/20">
              no items yet
            </div>
          )}
          <div className="space-y-0.5">
            {incomplete.map((todo) => (
              <div
                key={todo.id}
                className="group flex items-start gap-1.5 rounded px-1 py-0.5 transition hover:bg-white/5"
              >
                <button
                  onClick={() => void toggleTodo(todo)}
                  className="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border border-white/20 transition hover:border-white/40"
                />
                {editId === todo.id ? (
                  <input
                    ref={editRef}
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    onBlur={() => void saveEdit(todo.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void saveEdit(todo.id);
                      if (e.key === "Escape") setEditId(null);
                    }}
                    className="min-w-0 flex-1 bg-transparent font-mono text-xs text-white/80 focus:outline-none"
                  />
                ) : (
                  <span
                    className="flex-1 cursor-text font-mono text-xs text-white/70"
                    onClick={() => {
                      setEditId(todo.id);
                      setEditText(todo.text);
                    }}
                  >
                    {todo.text}
                  </span>
                )}
                <button
                  onClick={() => void removeTodo(todo.id)}
                  className="shrink-0 px-0.5 font-mono text-[10px] text-white/0 transition group-hover:text-white/30 hover:!text-white/60"
                >
                  x
                </button>
              </div>
            ))}
          </div>

          {/* Completed items */}
          {complete.length > 0 && (
            <div className="mt-1.5 space-y-0.5 border-t border-white/5 pt-1.5">
              {complete.map((todo) => (
                <div
                  key={todo.id}
                  className="group flex items-start gap-1.5 rounded px-1 py-0.5 transition hover:bg-white/5"
                >
                  <button
                    onClick={() => void toggleTodo(todo)}
                    className="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border transition"
                    style={{ borderColor: accent + "66", backgroundColor: accent + "22" }}
                  >
                    <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                      <path d="M1.5 4L3 5.5L6.5 2" stroke={accent} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                  <span className="flex-1 font-mono text-xs text-white/30 line-through">
                    {todo.text}
                  </span>
                  <button
                    onClick={() => void removeTodo(todo.id)}
                    className="shrink-0 px-0.5 font-mono text-[10px] text-white/0 transition group-hover:text-white/30 hover:!text-white/60"
                  >
                    x
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
