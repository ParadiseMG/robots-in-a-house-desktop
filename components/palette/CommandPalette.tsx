"use client";

import { Command } from "cmdk";
import { useEffect, useState } from "react";
import type { AgentConfig } from "@/lib/office-types";

type OfficeEntry = { slug: string; name: string; agents: AgentConfig[] };

type Props = {
  slug: string;
  allOffices: OfficeEntry[];
  onSwitchOffice: (slug: string) => void;
  onFocusAgent: (deskId: string) => void;
};

export default function CommandPalette({
  slug,
  allOffices,
  onSwitchOffice,
  onFocusAgent,
}: Props) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  if (!open) return null;

  const otherOffices = allOffices.filter((o) => o.slug !== slug);
  const currentOffice = allOffices.find((o) => o.slug === slug);
  const agents = currentOffice?.agents ?? [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-32"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-[480px] max-w-[90vw] overflow-hidden rounded-lg border border-white/15 bg-zinc-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <Command label="Command palette" className="flex flex-col">
          <Command.Input
            autoFocus
            placeholder="Type a command or agent name…"
            className="w-full border-b border-white/10 bg-transparent px-4 py-3 text-sm text-white placeholder:text-white/30 focus:outline-none"
          />
          <Command.List className="max-h-80 overflow-y-auto p-2">
            <Command.Empty className="px-3 py-6 text-center text-xs text-white/40">
              no match.
            </Command.Empty>

            <Command.Group
              heading="offices"
              className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-white/40"
            >
              {otherOffices.map((o) => (
                <Command.Item
                  key={o.slug}
                  value={`switch office ${o.slug} ${o.name}`}
                  onSelect={() => {
                    onSwitchOffice(o.slug);
                    setOpen(false);
                  }}
                  className="flex cursor-pointer items-center gap-2 rounded px-3 py-2 text-sm text-white/80 data-[selected=true]:bg-white/10 data-[selected=true]:text-white"
                >
                  switch → {o.name}
                </Command.Item>
              ))}
            </Command.Group>

            <Command.Group
              heading="agents"
              className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-white/40"
            >
              {agents.map((a) => (
                <Command.Item
                  key={a.id}
                  value={`focus ${a.name} ${a.role} ${a.id}`}
                  onSelect={() => {
                    onFocusAgent(a.deskId);
                    setOpen(false);
                  }}
                  className="flex cursor-pointer items-center justify-between gap-2 rounded px-3 py-2 text-sm text-white/80 data-[selected=true]:bg-white/10 data-[selected=true]:text-white"
                >
                  <span>
                    <span className="text-white">{a.name}</span>
                    <span className="ml-2 text-xs text-white/40">
                      {a.role}
                    </span>
                  </span>
                  <span
                    className={
                      a.isReal
                        ? "rounded bg-emerald-400/20 px-1.5 py-0.5 font-mono text-[10px] uppercase text-emerald-300"
                        : "rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px] uppercase text-white/50"
                    }
                  >
                    {a.isReal ? "real" : "sim"}
                  </span>
                </Command.Item>
              ))}
            </Command.Group>
          </Command.List>
          <div className="border-t border-white/10 px-3 py-1.5 font-mono text-[10px] text-white/30">
            ↑↓ navigate · ↵ select · esc close · {slug}
          </div>
        </Command>
      </div>
    </div>
  );
}
