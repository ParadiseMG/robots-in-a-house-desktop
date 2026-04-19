import { NextResponse } from "next/server";
import { execSync } from "child_process";

const REPO = process.cwd();

export async function GET() {
  try {
    // Count commits ahead of remote
    let unpushed = 0;
    try {
      const out = execSync("git rev-list --count @{u}..HEAD", {
        cwd: REPO,
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
      unpushed = parseInt(out, 10) || 0;
    } catch {
      // No upstream configured or other error — assume 0
    }

    // Check for uncommitted changes
    const dirty = execSync("git status --porcelain", {
      cwd: REPO,
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    const uncommitted = dirty ? dirty.split("\n").length : 0;

    return NextResponse.json({ unpushed, uncommitted });
  } catch (err) {
    return NextResponse.json(
      { error: "git check failed", unpushed: 0, uncommitted: 0 },
      { status: 500 },
    );
  }
}
