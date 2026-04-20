import fs from "node:fs/promises";
import path from "node:path";
import type { AgentConfig, DeskConfig, OfficeConfig } from "./office-types";
import { isValidOfficeSlug as checkSlug, listOfficeSlugs } from "./config-loader";
import { CONFIG_DIR, WORKSPACES_DIR } from "./data-paths";

export type OfficeSlug = string;

export class AgentBuilderError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "AgentBuilderError";
  }
}

export function isValidOfficeSlug(s: unknown): s is string {
  return typeof s === "string" && checkSlug(s);
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

function configPath(slug: OfficeSlug): string {
  return path.join(CONFIG_DIR, `${slug}.office.json`);
}

async function readOffice(slug: OfficeSlug): Promise<OfficeConfig> {
  const raw = await fs.readFile(configPath(slug), "utf-8");
  return JSON.parse(raw) as OfficeConfig;
}

async function writeOffice(slug: OfficeSlug, office: OfficeConfig): Promise<void> {
  await fs.writeFile(
    configPath(slug),
    JSON.stringify(office, null, 2) + "\n",
    "utf-8",
  );
}

async function listPremadeSprites(): Promise<string[]> {
  const dir = path.join(process.cwd(), "public", "sprites", "characters");
  const entries = await fs.readdir(dir);
  return entries.filter((f) => /^premade_\d+\.png$/.test(f));
}

/**
 * Pick a sprite. Prefer premades not currently used in ANY office.
 * If all are used (only 11 premades exist), fall back to least-used, then random.
 */
async function pickSprite(): Promise<string> {
  const available = await listPremadeSprites();
  if (available.length === 0) {
    throw new AgentBuilderError(500, "no premade sprites found on disk");
  }

  const usage = new Map<string, number>();
  for (const s of available) usage.set(s, 0);
  for (const slug of listOfficeSlugs()) {
    const office = await readOffice(slug);
    for (const a of office.agents) {
      const p = a.visual?.premade;
      if (p && usage.has(p)) usage.set(p, (usage.get(p) ?? 0) + 1);
    }
  }
  const sorted = [...usage.entries()].sort((a, b) => a[1] - b[1]);
  const minUse = sorted[0][1];
  const candidates = sorted.filter(([, n]) => n === minUse).map(([s]) => s);
  return candidates[Math.floor(Math.random() * candidates.length)];
}

/**
 * Pick a free grid cell near the head's desk, spiraling outward.
 * Returns null if the grid is full (no free non-occupied cell).
 */
function pickDeskCell(
  office: OfficeConfig,
  anchorX: number,
  anchorY: number,
): { gridX: number; gridY: number } | null {
  const { cols, rows } = office.grid;
  const taken = new Set<string>();
  for (const d of office.desks) taken.add(`${d.gridX},${d.gridY}`);

  // Bounded spiral: ring radius 1..max, for each ring walk the perimeter.
  const maxR = Math.max(cols, rows);
  for (let r = 1; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        const x = anchorX + dx;
        const y = anchorY + dy;
        if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
        if (taken.has(`${x},${y}`)) continue;
        return { gridX: x, gridY: y };
      }
    }
  }
  return null;
}

export type CreateAgentOpts = {
  officeSlug: OfficeSlug;
  name: string;
  role: string;
  sprite?: string;
  model?: string;
  gridX?: number;
  gridY?: number;
};

export type CreateAgentResult = {
  agent: AgentConfig;
  desk: DeskConfig;
  officeSlug: OfficeSlug;
};

const DEFAULT_TOOLS = ["Read", "Write", "Edit", "Grep", "Glob", "Bash", "WebSearch", "WebFetch"];

/**
 * Add a new real agent + desk to an office config and create its workspace dir.
 * Throws AgentBuilderError with a status code on validation failure.
 */
export async function createAgent(
  opts: CreateAgentOpts,
): Promise<CreateAgentResult> {
  if (!isValidOfficeSlug(opts.officeSlug)) {
    throw new AgentBuilderError(400, `invalid officeSlug: ${opts.officeSlug}`);
  }
  const name = (opts.name ?? "").trim();
  const role = (opts.role ?? "").trim();
  if (!name) throw new AgentBuilderError(400, "name is required");
  if (!role) throw new AgentBuilderError(400, "role is required");

  const id = slugify(name);
  if (!id) throw new AgentBuilderError(400, "name must contain letters or digits");

  const office = await readOffice(opts.officeSlug);

  if (office.agents.some((a) => a.id === id)) {
    throw new AgentBuilderError(409, `agent id "${id}" already exists`);
  }
  if (office.desks.some((d) => d.id === `desk-${id}`)) {
    throw new AgentBuilderError(409, `desk id "desk-${id}" already exists`);
  }

  // Find the head's desk as anchor; fall back to grid center.
  const head = office.agents.find((a) => a.isHead);
  const headDesk = head ? office.desks.find((d) => d.id === head.deskId) : null;
  const anchorX = headDesk?.gridX ?? Math.floor(office.grid.cols / 2);
  const anchorY = headDesk?.gridY ?? Math.floor(office.grid.rows / 2);

  let gridX: number;
  let gridY: number;
  if (typeof opts.gridX === "number" && typeof opts.gridY === "number") {
    if (
      opts.gridX < 0 ||
      opts.gridX >= office.grid.cols ||
      opts.gridY < 0 ||
      opts.gridY >= office.grid.rows
    ) {
      throw new AgentBuilderError(400, "gridX/gridY out of bounds");
    }
    if (office.desks.some((d) => d.gridX === opts.gridX && d.gridY === opts.gridY)) {
      throw new AgentBuilderError(409, "cell occupied");
    }
    gridX = opts.gridX;
    gridY = opts.gridY;
  } else {
    const picked = pickDeskCell(office, anchorX, anchorY);
    if (!picked) throw new AgentBuilderError(409, "no free desk cell in grid");
    gridX = picked.gridX;
    gridY = picked.gridY;
  }

  const roomId = headDesk?.roomId ?? office.rooms[0]?.id;
  if (!roomId) throw new AgentBuilderError(500, "office has no rooms");

  let sprite = opts.sprite;
  if (sprite) {
    const available = await listPremadeSprites();
    if (!available.includes(sprite)) {
      throw new AgentBuilderError(400, `sprite "${sprite}" not found on disk`);
    }
  } else {
    sprite = await pickSprite();
  }

  const desk: DeskConfig = {
    id: `desk-${id}`,
    roomId,
    gridX,
    gridY,
    facing: "S",
  };

  const agent: AgentConfig = {
    id,
    deskId: desk.id,
    name,
    role,
    spritePack: "limezu/office/auto",
    visual: { premade: sprite },
    isReal: true,
    cwd: `agent-workspaces/${opts.officeSlug}/${id}`,
    allowedTools: [...DEFAULT_TOOLS],
    ...(opts.model ? { model: opts.model } : {}),
  };

  office.desks.push(desk);
  office.agents.push(agent);

  await writeOffice(opts.officeSlug, office);

  const workspaceDir = path.join(
    WORKSPACES_DIR,
    opts.officeSlug,
    id,
  );
  await fs.mkdir(workspaceDir, { recursive: true });

  // Generate CLAUDE.md brief with memory contract
  const claudeMd = `# ${name} — ${role}

@AGENTS.md

## Your role
${role} in the ${opts.officeSlug} office.

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

  const memoryMd = `# ${name} — Memory

_No prior sessions yet._
`;

  // Write files only if they don't already exist (don't overwrite manual edits)
  const claudePath = path.join(workspaceDir, "CLAUDE.md");
  const memoryPath = path.join(workspaceDir, "MEMORY.md");

  try {
    await fs.access(claudePath);
  } catch {
    await fs.writeFile(claudePath, claudeMd, "utf-8");
  }

  try {
    await fs.access(memoryPath);
  } catch {
    await fs.writeFile(memoryPath, memoryMd, "utf-8");
  }

  return { agent, desk, officeSlug: opts.officeSlug };
}
