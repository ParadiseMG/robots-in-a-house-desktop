import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import type { OfficeConfig } from "@/lib/office-types";
import { CONFIG_DIR, WORKSPACES_DIR } from "@/lib/data-paths";

export const dynamic = "force-dynamic";

/** Write a file only if it doesn't already exist. */
async function writeIfMissing(filePath: string, content: string) {
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, content, "utf-8");
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { slug?: string; config?: OfficeConfig; importedMemory?: string };
    const { slug, config, importedMemory } = body;
    if (!slug || !config) {
      return NextResponse.json({ error: "missing slug or config" }, { status: 400 });
    }
    const safe = slug.replace(/[^a-zA-Z0-9_-]/g, "-");
    const filename = `${safe}.office.json`;
    const outPath = path.join(CONFIG_DIR, filename);
    await fs.writeFile(outPath, JSON.stringify(config, null, 2));

    // Create agent workspace directories with CLAUDE.md + MEMORY.md templates
    for (const agent of config.agents) {
      if (!agent.isReal) continue;
      const workspaceDir = path.join(
        WORKSPACES_DIR,
        safe,
        agent.id,
      );
      await fs.mkdir(workspaceDir, { recursive: true });

      const claudeMd = `# ${agent.name} — ${agent.role}

@AGENTS.md

## Your role
${agent.role} in the ${config.name} office.

## Key rules
- Read MEMORY.md at the start of every session for prior context.
- Before a reset or when told "break time", update MEMORY.md with what you learned, what's in progress, and any gotchas.
- Keep MEMORY.md concise — facts and open threads, not transcripts.
- Close every task with a 1-3 sentence summary.

## Memory
At session start, read \`./MEMORY.md\` if it exists.
On "break time" or session end, update \`./MEMORY.md\` before reset.

## Never
- Never say "I'll remember" without writing to MEMORY.md first.
- Never take irreversible actions without confirmation.
`;

      // If this is the head agent and there's imported memory, seed their MEMORY.md with it
      const hasImportedMemory = agent.isHead && importedMemory;
      const memoryMd = hasImportedMemory
        ? `# ${agent.name} — Memory\n\n${importedMemory}\n`
        : `# ${agent.name} — Memory\n\n_No prior sessions yet._\n`;

      await writeIfMissing(path.join(workspaceDir, "CLAUDE.md"), claudeMd);
      await writeIfMissing(path.join(workspaceDir, "MEMORY.md"), memoryMd);
    }

    return NextResponse.json({ filename, path: `config/${filename}` });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
