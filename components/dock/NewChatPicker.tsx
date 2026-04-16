"use client";

import { useDockTabs } from "@/hooks/useDockTabs";

type Agent = {
  id: string;
  name: string;
  role: string;
  deskId: string;
  isReal: boolean;
  officeSlug: string;
};

type Props = {
  agents: Agent[];
  onClose: () => void;
  onConveneWarRoom?: (officeSlug: string) => void;
  offices?: Array<{ slug: string; name: string; accent: string }>;
};

export default function NewChatPicker({ agents, onClose, onConveneWarRoom, offices }: Props) {
  const { openOrFocus } = useDockTabs();

  const grouped = agents.reduce<Record<string, Agent[]>>((acc, a) => {
    acc[a.officeSlug] = acc[a.officeSlug] ?? [];
    acc[a.officeSlug].push(a);
    return acc;
  }, {});

  const openAgent = (agent: Agent) => {
    openOrFocus({
      id: agent.id,
      agentId: agent.id,
      deskId: agent.deskId,
      officeSlug: agent.officeSlug,
      kind: "1:1",
      label: agent.name,
    });
    onClose();
  };

  const callAll = () => {
    for (const agent of agents) {
      openOrFocus({
        id: agent.id,
        agentId: agent.id,
        deskId: agent.deskId,
        officeSlug: agent.officeSlug,
        kind: "1:1",
        label: agent.name,
      });
    }
    onClose();
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-white/50">
          open a conversation
        </span>
        <button
          type="button"
          onClick={onClose}
          className="font-mono text-[10px] text-white/40 hover:text-white"
        >
          ✕
        </button>
      </div>

      <div className="border-b border-white/10 px-2 py-1.5">
        <button
          type="button"
          onClick={callAll}
          className="w-full rounded border border-white/20 bg-white/5 px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-white/60 transition hover:border-white/40 hover:bg-white/10 hover:text-white"
        >
          call all
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-3">
        {Object.entries(grouped).map(([slug, groupAgents]) => {
          const office = offices?.find((o) => o.slug === slug);
          return (
            <div key={slug}>
              <div className="mb-1 flex items-center justify-between">
                <span className="font-mono text-[10px] uppercase tracking-wider text-white/40">
                  {office?.name ?? slug}
                </span>
                {onConveneWarRoom && (
                  <button
                    type="button"
                    onClick={() => {
                      onConveneWarRoom(slug);
                      onClose();
                    }}
                    className="border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider transition hover:brightness-125"
                    style={{
                      borderColor: (office?.accent ?? "#ffffff") + "88",
                      color: office?.accent ?? "#ffffff",
                    }}
                  >
                    war room
                  </button>
                )}
              </div>
              <div className="space-y-0.5">
                {groupAgents.map((agent) => (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={() => openAgent(agent)}
                    className="flex w-full items-center gap-2 rounded border border-white/10 bg-black/40 px-2 py-1.5 text-left transition-colors hover:border-white/30 hover:bg-black/60"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-white">{agent.name}</div>
                      <div className="truncate text-[10px] text-white/50">{agent.role}</div>
                    </div>
                    <div className="flex shrink-0 gap-1 font-mono text-[9px] uppercase tracking-wider">
                      {agent.isReal ? (
                        <span className="rounded bg-emerald-400/20 px-1 py-0.5 text-emerald-300">real</span>
                      ) : (
                        <span className="rounded bg-white/10 px-1 py-0.5 text-white/50">sim</span>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
