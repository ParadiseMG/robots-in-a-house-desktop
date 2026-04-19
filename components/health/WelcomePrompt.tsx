"use client";

import { useState } from "react";

type Props = {
  headAgentName: string | null;
  headAgentId: string | null;
  officeSlug: string;
  onTryIt: (agentId: string, officeSlug: string, prompt: string) => void;
};

const STARTER_PROMPTS = [
  {
    label: "Say hello",
    prompt: "Hey! I just set up this workspace. Introduce yourself — who are you and what can you do?",
  },
  {
    label: "Check your tools",
    prompt: "Can you list what tools you have access to and give me a quick demo of one?",
  },
  {
    label: "Explore the codebase",
    prompt: "Take a look around this project and give me a 3-sentence summary of what it is and how it's structured.",
  },
];

export default function WelcomePrompt({ headAgentName, headAgentId, officeSlug, onTryIt }: Props) {
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || !headAgentId) return null;

  // Check if user has already tried it
  if (typeof window !== "undefined" && localStorage.getItem("ri-tried-first-prompt")) return null;

  return (
    <div className="pointer-events-auto absolute bottom-20 left-1/2 z-30 -translate-x-1/2">
      <div className="rounded-xl border border-white/10 bg-gray-900/95 px-5 py-4 shadow-2xl backdrop-blur-sm max-w-md">
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="text-xs font-bold text-white/80">Try talking to {headAgentName ?? "your agent"}</div>
            <div className="text-[10px] text-white/30 mt-0.5">Pick a starter or type your own in the prompt bar</div>
          </div>
          <button
            onClick={() => {
              setDismissed(true);
              localStorage.setItem("ri-tried-first-prompt", "1");
            }}
            className="text-[10px] text-white/20 hover:text-white/50 transition-colors ml-4"
          >
            dismiss
          </button>
        </div>
        <div className="flex flex-col gap-1.5">
          {STARTER_PROMPTS.map((sp) => (
            <button
              key={sp.label}
              onClick={() => {
                localStorage.setItem("ri-tried-first-prompt", "1");
                onTryIt(headAgentId, officeSlug, sp.prompt);
                setDismissed(true);
              }}
              className="group flex items-center gap-2.5 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2 text-left transition-all hover:border-white/15 hover:bg-white/[0.05]"
            >
              <span className="text-[10px] text-blue-400/60 group-hover:text-blue-400 transition-colors">&#9654;</span>
              <div className="flex-1 min-w-0">
                <div className="text-[11px] font-bold text-white/60 group-hover:text-white/80 transition-colors">
                  {sp.label}
                </div>
                <div className="text-[10px] text-white/25 group-hover:text-white/40 transition-colors truncate">
                  {sp.prompt}
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
