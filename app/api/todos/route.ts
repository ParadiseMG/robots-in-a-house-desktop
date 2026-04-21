import { NextRequest, NextResponse } from "next/server";
import { listTodos, createTodo, updateTodo, deleteTodo } from "@/server/db";

export async function GET(req: NextRequest) {
  const office = req.nextUrl.searchParams.get("office");
  if (!office) return NextResponse.json({ error: "office required" }, { status: 400 });
  const todos = listTodos(office);
  return NextResponse.json({ todos });
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as { office: string; text: string };
  if (!body.office || !body.text?.trim()) {
    return NextResponse.json({ error: "office and text required" }, { status: 400 });
  }
  const todo = createTodo(body.office, body.text.trim());
  return NextResponse.json({ todo }, { status: 201 });
}

export async function PATCH(req: NextRequest) {
  const body = (await req.json()) as {
    id: string;
    text?: string;
    done?: boolean;
    sort_order?: number;
  };
  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const ok = updateTodo(body.id, {
    text: body.text,
    done: body.done,
    sort_order: body.sort_order,
  });
  if (!ok) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const ok = deleteTodo(id);
  if (!ok) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
