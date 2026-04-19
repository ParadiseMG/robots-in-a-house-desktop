import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export const dynamic = "force-dynamic";

type MemoryFile = {
  name: string;
  path: string;
  content: string;
  source: "global" | "project";
  project?: string;
};

type MemoryProject = {
  slug: string;
  label: string;
  files: MemoryFile[];
};

/**
 * GET /api/claude-memory
 *
 * Scans ~/.claude/ for existing Claude Code memory files.
 * Returns global CLAUDE.md + per-project memory files.
 */
export async function GET() {
  const claudeDir = path.join(os.homedir(), ".claude");
  const result: {
    found: boolean;
    global: MemoryFile | null;
    projects: MemoryProject[];
  } = { found: false, global: null, projects: [] };

  // Check if ~/.claude exists
  try {
    await fs.access(claudeDir);
  } catch {
    return NextResponse.json(result);
  }

  // Read global CLAUDE.md
  const globalPath = path.join(claudeDir, "CLAUDE.md");
  try {
    const content = await fs.readFile(globalPath, "utf-8");
    if (content.trim()) {
      result.global = {
        name: "CLAUDE.md",
        path: globalPath,
        content: content.trim(),
        source: "global",
      };
      result.found = true;
    }
  } catch {
    // no global file
  }

  // Scan projects
  const projectsDir = path.join(claudeDir, "projects");
  try {
    const projectDirs = await fs.readdir(projectsDir);
    for (const dir of projectDirs) {
      // Skip agent workspace project dirs (they're internal to robots-in-a-house)
      if (dir.includes("agent-workspaces")) continue;

      const memoryDir = path.join(projectsDir, dir, "memory");
      try {
        const files = await fs.readdir(memoryDir);
        const mdFiles = files.filter((f) => f.endsWith(".md"));
        if (mdFiles.length === 0) continue;

        // Convert dir slug to a readable label
        const label = dir
          .replace(/^-Users-[^-]+-/, "")
          .replace(/-/g, " ")
          .replace(/^\s+/, "")
          .trim() || dir;

        const project: MemoryProject = {
          slug: dir,
          label,
          files: [],
        };

        for (const file of mdFiles) {
          try {
            const filePath = path.join(memoryDir, file);
            const content = await fs.readFile(filePath, "utf-8");
            if (content.trim()) {
              project.files.push({
                name: file,
                path: filePath,
                content: content.trim(),
                source: "project",
                project: label,
              });
            }
          } catch {
            // skip unreadable files
          }
        }

        if (project.files.length > 0) {
          result.projects.push(project);
          result.found = true;
        }
      } catch {
        // no memory dir for this project
      }
    }
  } catch {
    // no projects dir
  }

  return NextResponse.json(result);
}
